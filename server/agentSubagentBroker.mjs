// @ts-check
import { AgentSubtaskError, validateSubtaskOutputShape } from './agentSubtask.mjs'

const TERMINAL_ACTIVATION_STATUSES = new Set(['completed', 'failed', 'cancelled'])

function activationRecord(value) {
  return value?.activation && typeof value.activation === 'object' ? value.activation : value
}

function subagentFailure(code, message, statusCode = 409, cause) {
  const error = new AgentSubtaskError(code, message, statusCode)
  if (cause !== undefined) error.cause = cause
  return error
}

function assistantJson(messages, resultMessageId) {
  const message = (messages ?? []).find((entry) => (
    entry?.id === resultMessageId && entry?.role === 'assistant'
  ))
  if (!message || typeof message.content !== 'string' || !message.content.trim()) {
    throw subagentFailure(
      'SUBTASK_DURABLE_RESULT_MISSING',
      'Durable Subagent 已完成，但未找到对应的结果消息。',
      502,
    )
  }
  try {
    const value = JSON.parse(message.content.trim())
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('结果不是对象。')
    return value
  } catch (caught) {
    throw subagentFailure(
      'SUBTASK_OUTPUT_INVALID',
      'Durable Subagent 的结果消息不是合法 JSON 对象。',
      422,
      caught,
    )
  }
}

function abortError(signal) {
  const detail = signal?.reason instanceof Error ? signal.reason.message : '根 Agent 已停止该子任务。'
  return subagentFailure('SUBTASK_PARENT_CANCELLED', detail, 499, signal?.reason)
}

function waitUntilNextPoll(sleep, interval, signal) {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      signal?.removeEventListener?.('abort', onAbort)
      callback(value)
    }
    const onAbort = () => finish(resolve)
    signal?.addEventListener?.('abort', onAbort, { once: true })
    Promise.resolve().then(() => sleep(interval)).then(
      () => finish(resolve),
      (caught) => finish(reject, caught),
    )
  })
}

/**
 * 把主 Planner 的 legacy `runSubagent({ subtask, signal })` seam 接到持久化
 * Subagent Runtime V2。稳定 Subtask ID 同时作为 start/cancel 的幂等来源；恢复时
 * service.startFromRuntime 会重放同一 Activation，不会再次调用 Provider。
 *
 * @param {{
 *   service?: {
 *     startFromRuntime?: (input: any, rootExecution: any) => Promise<any>,
 *     read?: (userId: string, subagentId: string, options?: any) => Promise<any>,
 *     cancel?: (input: any) => Promise<any>,
 *   },
 *   pollIntervalMs?: number,
 *   sleep?: (milliseconds: number) => Promise<any>,
 * }} [input]
 */
export function createDurableAgentSubagentRunner({
  service,
  pollIntervalMs = 100,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const startFromRuntime = service?.startFromRuntime
  const read = service?.read
  const requestCancellation = service?.cancel
  if (typeof startFromRuntime !== 'function'
    || typeof read !== 'function'
    || typeof requestCancellation !== 'function') {
    throw new TypeError('Durable Subagent Broker 缺少 Runtime Service 契约。')
  }
  if (typeof sleep !== 'function') throw new TypeError('Durable Subagent Broker 缺少等待函数。')
  const interval = Math.max(1, Math.min(Number(pollIntervalMs) || 100, 5_000))

  return async function runDurableSubagent(runInput) {
    const { subtask, signal, context } = runInput ?? {}
    if (!subtask?.id || !subtask?.ownerId || !subtask?.projectId || !subtask?.parentTurnId) {
      throw new TypeError('Durable Subagent Broker 缺少受治理的 Subtask 身份。')
    }
    if (signal?.aborted) throw abortError(signal)
    const rootExecution = context?.rootExecution
    if (!Number.isInteger(rootExecution?.executionGeneration)
      || rootExecution.executionGeneration < 1
      || typeof rootExecution?.leaseToken !== 'string'
      || !rootExecution.leaseToken.trim()) {
      throw subagentFailure(
        'SUBTASK_ROOT_EXECUTION_FENCE_MISSING',
        'Durable Subagent 缺少当前根 Turn 的执行权证明。',
        409,
      )
    }

    const started = await startFromRuntime({
      userId: subtask.ownerId,
      projectId: subtask.projectId,
      rootTurnId: subtask.parentTurnId,
      idempotencyKey: subtask.id,
      role: subtask.role,
      content: JSON.stringify(subtask.input),
    }, {
      executionGeneration: rootExecution.executionGeneration,
      leaseToken: rootExecution.leaseToken,
    })
    const initialActivation = activationRecord(started?.activation)
    const subagentId = started?.subagent?.id ?? initialActivation?.subagentId
    if (!subagentId || !initialActivation?.id || !Number.isInteger(initialActivation.sequence)) {
      throw subagentFailure(
        'SUBTASK_DURABLE_START_INVALID',
        'Durable Subagent 未返回可观察的 Activation 身份。',
        502,
      )
    }

    let cancellation
    const cancel = () => {
      if (!cancellation) {
        cancellation = requestCancellation({
          userId: subtask.ownerId,
          projectId: subtask.projectId,
          subagentId,
          idempotencyKey: `subagent-cancel:${subtask.id}`,
          reason: '根 Agent 已停止该子任务。',
        })
      }
      return cancellation
    }

    for (;;) {
      if (signal?.aborted) {
        try {
          await cancel()
        } catch (caught) {
          throw subagentFailure(
            'SUBTASK_CANCEL_PROPAGATION_FAILED',
            '根 Agent 已停止，但 Durable Subagent 取消尚未确认。',
            503,
            caught,
          )
        }
        throw abortError(signal)
      }

      const state = await read(subtask.ownerId, subagentId, {
        afterSequence: Math.max(0, initialActivation.sequence - 1),
        limit: 1,
      })
      if (!state?.subagent) {
        throw subagentFailure('SUBTASK_DURABLE_NOT_FOUND', 'Durable Subagent 在执行期间丢失。', 502)
      }
      const activation = (state.activations ?? [])
        .map(activationRecord)
        .find((entry) => entry?.id === initialActivation.id)
      if (!activation) {
        throw subagentFailure('SUBTASK_DURABLE_ACTIVATION_MISSING', 'Durable Subagent Activation 不可读取。', 502)
      }
      if (activation.status === 'completed') {
        const rawOutput = assistantJson(state.messages, activation.resultMessageId)
        return validateSubtaskOutputShape(subtask.outputSchema, rawOutput)
      }
      if (activation.status === 'failed') {
        const message = (state.messages ?? []).find((entry) => entry?.id === activation.resultMessageId)
        throw subagentFailure(
          'SUBTASK_DURABLE_FAILED',
          typeof message?.content === 'string' && message.content.trim()
            ? message.content.trim().slice(0, 500)
            : 'Durable Subagent 执行失败。',
          502,
        )
      }
      if (activation.status === 'cancelled') {
        throw subagentFailure('SUBTASK_PARENT_CANCELLED', 'Durable Subagent 已取消。', 499)
      }
      if (TERMINAL_ACTIVATION_STATUSES.has(activation.status)) {
        throw subagentFailure('SUBTASK_DURABLE_TERMINAL_INVALID', 'Durable Subagent 返回了未知终态。', 502)
      }
      await waitUntilNextPoll(sleep, interval, signal)
    }
  }
}
