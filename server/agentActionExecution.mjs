// @ts-check
import { randomUUID } from 'node:crypto'
import { canonicalHash } from './canonicalHash.mjs'

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_LEASE_MS = 60_000

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function boundedMessage(caught, fallback) {
  return typeof caught?.message === 'string' && caught.message.trim()
    ? caught.message.trim().slice(0, 500)
    : fallback
}

export class AgentActionExecutionError extends Error {
  constructor(code, message, statusCode = 409) {
    super(message)
    this.name = 'AgentActionExecutionError'
    this.code = code
    this.statusCode = statusCode
  }
}

/**
 * 同一个 receiptId 只能表达同一个行动意图。参数键顺序不影响摘要，但用户、项目、
 * 工具和调用标识全部参与，避免把一次确认重放到另一项副作用。
 */
export function agentActionIntentHash(input) {
  const { userId, projectId, name, toolCallId, arguments: argumentsValue } = input ?? {}
  return canonicalHash({
    userId,
    projectId,
    name,
    toolCallId,
    arguments: argumentsValue ?? {},
  })
}

function errorFromReceipt(receipt) {
  if (receipt?.status === 'uncertain') {
    return new AgentActionExecutionError(
      'AGENT_ACTION_OUTCOME_UNKNOWN',
      '上一次行动可能已经生效，但执行回执未能确认。为避免重复副作用，系统不会自动重试。',
      409,
    )
  }
  const code = typeof receipt?.error?.code === 'string' ? receipt.error.code : 'AGENT_ACTION_FAILED'
  const message = typeof receipt?.error?.message === 'string' ? receipt.error.message : 'Agent 行动执行失败。'
  return new AgentActionExecutionError(code, message, Number(receipt?.error?.statusCode) || 409)
}

function claimError(caught) {
  if (caught instanceof AgentActionExecutionError) return caught
  const code = typeof /** @type {any} */ (caught)?.code === 'string'
    ? /** @type {any} */ (caught).code
    : undefined
  if (code === 'PROJECT_WRITE_FORBIDDEN' || code === 'PROJECT_READ_FORBIDDEN') {
    return new AgentActionExecutionError(code, '你没有执行该 Agent 行动的权限。', 403)
  }
  if (code === 'PROJECT_NOT_FOUND') {
    return new AgentActionExecutionError(code, '未找到项目或你没有访问权限。', 404)
  }
  if (code === 'AGENT_ACTION_RECEIPT_INVALID') {
    return new AgentActionExecutionError(code, 'Agent 行动回执格式无效。', 422)
  }
  if (code === 'AGENT_ACTION_RECEIPT_CONFLICT') {
    return new AgentActionExecutionError('AGENT_ACTION_INTENT_CONFLICT', '同一行动提交标识已被其他意图占用。', 409)
  }
  return new AgentActionExecutionError(
    'AGENT_ACTION_CLAIM_FAILED',
    '暂时无法取得 Agent 行动执行权，请稍后重试。',
    503,
  )
}

/**
 * 不可重复 Agent 行动的执行所有权 Module。
 *
 * Interface 只有 `execute(input)`：intent hash、跨实例原子 claim、租约、超时 Abort、
 * 终态回执和重放都隐藏在 Module 内。ProductStore Adapter 负责原子 claim/settle；
 * executor 只在 claim 胜出后获得一次调用机会。
 */
export function createAgentActionExecution(dependencies) {
  const productStore = dependencies?.productStore
  const now = typeof dependencies?.now === 'function' ? dependencies.now : () => Date.now()
  const timeoutMs = dependencies?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const leaseMs = dependencies?.leaseMs ?? DEFAULT_LEASE_MS
  if (typeof productStore?.claimAgentActionReceipt !== 'function'
    || typeof productStore?.settleAgentActionReceipt !== 'function') {
    throw new TypeError('Agent Action Execution 缺少 ProductStore 原子回执 Interface。')
  }
  const boundedTimeoutMs = Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS)
  const boundedLeaseMs = Math.max(boundedTimeoutMs * 2, Number(leaseMs) || DEFAULT_LEASE_MS)
  const active = new Map()

  async function executeOnce(input, intentHash) {
    const {
      userId,
      projectId,
      receiptId,
      toolCallId,
      name,
      arguments: argumentsValue,
      actionBindingHash,
      executor,
      replayPolicy = 'never',
    } = input ?? {}
    if (![userId, projectId, receiptId, toolCallId, name].every((value) => typeof value === 'string' && value.trim())) {
      throw new TypeError('Agent Action Execution 缺少行动身份。')
    }
    if (typeof executor !== 'function') throw new TypeError('Agent Action Execution 缺少 executor。')
    if (!['safe', 'never'].includes(replayPolicy)) throw new TypeError('Agent Action replayPolicy 无效。')
    if (actionBindingHash !== undefined
      && (typeof actionBindingHash !== 'string' || !actionBindingHash.trim())) {
      throw new TypeError('Agent Action Execution actionBindingHash 无效。')
    }

    const startedAt = Number(now()) || Date.now()
    const leaseToken = `agent_action_lease_${randomUUID()}`
    let claim
    try {
      claim = await productStore.claimAgentActionReceipt(userId, {
        id: receiptId,
        projectId,
        toolCallId,
        actionName: name,
        intentHash,
        ...(actionBindingHash ? { actionBindingHash } : {}),
        replayPolicy,
        status: 'running',
        leaseToken,
        leaseDurationMs: boundedLeaseMs,
        leaseExpiresAt: startedAt + boundedLeaseMs,
        createdAt: startedAt,
        updatedAt: startedAt,
      })
    } catch (caught) {
      // claim 尚未发生外部副作用；把 Adapter/迁移故障收敛成稳定业务错误，
      // 避免统一 HTTP 层把它降格成不可诊断的 500。
      throw claimError(caught)
    }

    if (claim?.kind === 'replay') return clone(claim.receipt?.result)
    if (claim?.kind === 'conflict') {
      throw new AgentActionExecutionError(
        'AGENT_ACTION_INTENT_CONFLICT',
        '同一行动提交标识已绑定到不同的工具或参数，请重新发起。',
        409,
      )
    }
    if (claim?.kind === 'in_progress') {
      throw new AgentActionExecutionError('AGENT_ACTION_IN_PROGRESS', '该行动仍在执行，请稍后确认状态。', 409)
    }
    if (claim?.kind === 'uncertain' || claim?.kind === 'failed') throw errorFromReceipt(claim.receipt)
    if (claim?.kind !== 'claimed') {
      throw new AgentActionExecutionError('AGENT_ACTION_CLAIM_FAILED', '无法取得该行动的执行权。', 503)
    }

    const controller = new AbortController()
    let timedOut = false
    let executorCompleted = false
    let timeoutId
    const timeoutError = new AgentActionExecutionError('AGENT_ACTION_TIMEOUT', 'Agent 行动执行超时，请稍后确认状态。', 504)
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true
        controller.abort(timeoutError)
        reject(timeoutError)
      }, boundedTimeoutMs)
    })

    try {
      const result = await Promise.race([
        Promise.resolve().then(() => executor({
          signal: controller.signal,
          receiptId,
          intentHash,
          leaseToken,
        })),
        timeout,
      ])
      executorCompleted = true
      clearTimeout(timeoutId)
      const stored = await productStore.settleAgentActionReceipt(userId, {
        id: receiptId,
        projectId,
        leaseToken,
        status: 'succeeded',
        result: clone(result),
        updatedAt: Number(now()) || Date.now(),
      })
      return clone(stored?.result ?? result)
    } catch (caught) {
      clearTimeout(timeoutId)
      // executor 已返回后，任何异常都发生在完成回执阶段：外部行动已经成功，
      // 不能把 Store 故障误记成可重试的明确失败。
      const outcomeKnown = /** @type {any} */ (caught)?.outcomeKnown === true
      const uncertain = timedOut || executorCompleted || (replayPolicy === 'never' && !outcomeKnown)
      const error = uncertain
        ? {
            code: 'AGENT_ACTION_OUTCOME_UNKNOWN',
            message: '行动可能已经生效，但没有取得确定回执。系统不会自动重试。',
            statusCode: 409,
          }
        : {
            code: typeof /** @type {any} */ (caught)?.code === 'string' ? /** @type {any} */ (caught).code : 'AGENT_ACTION_FAILED',
            message: boundedMessage(caught, 'Agent 行动执行失败。'),
            statusCode: Number(/** @type {any} */ (caught)?.statusCode) || 502,
          }
      try {
        await productStore.settleAgentActionReceipt(userId, {
          id: receiptId,
          projectId,
          leaseToken,
          status: uncertain ? 'uncertain' : 'failed',
          error,
          updatedAt: Number(now()) || Date.now(),
        })
      } catch {
        // 丢失执行租约意味着另一个持有者已经接管；原错误仍返回，但绝不能再执行一次。
      }
      if (uncertain && !timedOut) {
        throw new AgentActionExecutionError(
          'AGENT_ACTION_OUTCOME_UNKNOWN',
          '行动可能已经生效，但没有取得确定回执。系统不会自动重试。',
          409,
        )
      }
      throw caught
    }
  }

  return Object.freeze({
    execute(input) {
      const intentHash = agentActionIntentHash(input)
      const receiptId = input?.receiptId
      const current = active.get(receiptId)
      if (current) {
        if (current.intentHash !== intentHash
          || current.actionBindingHash !== input?.actionBindingHash) {
          return Promise.reject(new AgentActionExecutionError(
            'AGENT_ACTION_INTENT_CONFLICT',
            '同一行动提交标识已绑定到不同的工具或参数，请重新发起。',
            409,
          ))
        }
        return current.promise
      }
      const promise = executeOnce(input, intentHash).finally(() => active.delete(receiptId))
      active.set(receiptId, { intentHash, actionBindingHash: input?.actionBindingHash, promise })
      return promise
    },
  })
}
