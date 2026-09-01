// @ts-check
import { randomUUID } from 'node:crypto'

const TERMINAL_TURN_STATUSES = new Set(['completed', 'failed', 'cancelled'])

function activationRecord(entry) {
  return entry?.activation && typeof entry.activation === 'object' ? entry.activation : entry
}

function activationTurn(entry) {
  return entry?.turn && typeof entry.turn === 'object' ? entry.turn : undefined
}

function boundedContent(value) {
  const content = typeof value === 'string' ? value : JSON.stringify(value ?? {})
  return content.slice(0, 4_000)
}

function turnInputContent(turn, activation) {
  const request = turn?.request
  const input = request?.runtimeOperation === 'subagent' ? request.input : request
  return input?.inputMessage?.content
    ?? input?.message?.content
    ?? activation?.input?.content
    ?? activation?.input
    ?? ''
}

function turnOutputContent(turn) {
  const result = turn?.result
  if (!result) return undefined
  return result?.runtimeOperation === 'subagent' && Object.hasOwn(result, 'output')
    ? boundedContent(result.output)
    : boundedContent(result)
}

/**
 * Follow-up 可以在上一 activation 完成前入队，因此 Message.updatedAt 不是对话顺序。
 * 这里只按持久化 activation.sequence 交错 user input 与已 settle assistant result。
 */
export function buildAgentSubagentTranscript(entries, currentSequence) {
  const transcript = []
  const ordered = (entries ?? [])
    .map((entry) => ({ entry, activation: activationRecord(entry), turn: activationTurn(entry) }))
    .filter(({ activation }) => Number.isInteger(activation?.sequence) && activation.sequence <= currentSequence)
    .sort((left, right) => left.activation.sequence - right.activation.sequence)

  for (const { activation, turn } of ordered) {
    transcript.push({ role: 'user', content: boundedContent(turnInputContent(turn, activation)) })
    if (activation.sequence >= currentSequence) continue
    const output = turnOutputContent(turn)
    if (output !== undefined) transcript.push({ role: 'assistant', content: output })
  }
  return transcript.slice(-16)
}

function runnerEnvelope(value) {
  // descriptor 模式返回轨迹 envelope；legacy runner 仍直接返回 Schema output。
  if (value && typeof value === 'object' && Object.hasOwn(value, 'output')
    && Array.isArray(value.toolCalls)) return value
  return { kind: 'subagent_runner_result', output: value }
}

/**
 * 专用 Worker Processor。Descriptor claim 决定 FIFO/dispatch lease，现有 Turn Runtime
 * 决定 Provider 执行、Checkpoint、心跳和终态；两层 fence 均成功后才 settle activation。
 *
 * @param {{
 *   productStore?: any,
 *   turnRuntime?: any,
 *   runSubagent?: (input: any) => Promise<any>,
 *   buildRegistry?: (input: any) => Promise<any> | any,
 *   enqueue?: (identity: { subagentId: string, activationId: string }) => Promise<any>,
 *   convergeCancellation?: (descriptor: any) => Promise<any>,
 *   leaseTokenFactory?: () => string,
 *   observe?: (event: any) => void,
 * }} [input]
 */
export function createAgentSubagentProcessor({
  productStore,
  turnRuntime,
  runSubagent,
  buildRegistry,
  enqueue,
  convergeCancellation,
  leaseTokenFactory = () => `agent_subagent_lease_${randomUUID()}`,
  observe,
} = {}) {
  if (typeof productStore?.claimAgentSubagentActivation !== 'function'
    || typeof productStore?.settleAgentSubagentActivation !== 'function') {
    throw new TypeError('Subagent Processor 缺少 ProductStore 原子契约。')
  }
  if (typeof turnRuntime?.execute !== 'function') throw new TypeError('Subagent Processor 缺少 Turn Runtime。')
  if (typeof runSubagent !== 'function') throw new TypeError('Subagent Processor 缺少执行器。')
  const report = (event) => {
    try { observe?.(event) } catch { /* 观测不得影响权威执行。 */ }
  }

  async function listActivationEntries(subagentId, maximum) {
    if (typeof productStore.listAgentSubagentActivationsForWorker !== 'function') return []
    return await productStore.listAgentSubagentActivationsForWorker(subagentId, {
      afterSequence: 0,
      limit: Math.max(1, Math.min(Number(maximum) || 8, 8)),
    }) ?? []
  }

  async function finalizeCancellation(descriptor) {
    if (descriptor?.status !== 'cancelling'
      || typeof productStore.finalizeAgentSubagentCancellation !== 'function'
      || !descriptor?.cancellation?.signalId) return undefined
    return productStore.finalizeAgentSubagentCancellation(descriptor.ownerId, {
      subagentId: descriptor.id,
      projectId: descriptor.projectId,
      signalId: descriptor.cancellation.signalId,
      cancelGeneration: descriptor.cancelGeneration,
    })
  }

  async function handoffNext(settlement, descriptor, entries) {
    if (typeof enqueue !== 'function') return false
    const settledDescriptor = settlement?.subagent ?? descriptor
    if (settledDescriptor?.status !== 'active'
      || settledDescriptor.settledThroughSequence >= settledDescriptor.lastEnqueuedSequence) return false
    const nextSequence = settledDescriptor.settledThroughSequence + 1
    const nextEntry = settlement?.nextActivation
      ?? entries.map(activationRecord).find((activation) => activation?.sequence === nextSequence)
      ?? activationRecord((await listActivationEntries(settledDescriptor.id, settledDescriptor.budget?.maxActivations))
        .find((entry) => activationRecord(entry)?.sequence === nextSequence))
    const next = activationRecord(nextEntry)
    if (!next?.id) return false
    await enqueue({ subagentId: settledDescriptor.id, activationId: next.id })
    return true
  }

  return async function processAgentSubagentActivation(input) {
    const subagentId = typeof input?.subagentId === 'string' ? input.subagentId.trim() : ''
    const activationId = typeof input?.activationId === 'string' ? input.activationId.trim() : ''
    if (!subagentId || !activationId) throw new TypeError('Subagent Processor 缺少激活身份。')
    const leaseToken = leaseTokenFactory()
    const claim = await productStore.claimAgentSubagentActivation({
      subagentId,
      activationId,
      leaseToken,
      // dispatch lease 覆盖 activation 最大运行时间，崩溃后仍能在有限时间内接管。
      leaseDurationMs: 150_000,
      allowTakeover: true,
    })
    if (claim?.kind === 'cancelling') {
      const converged = typeof convergeCancellation === 'function'
        ? await convergeCancellation(claim.subagent)
        : { kind: 'cancelling', changed: false, subagent: claim.subagent }
      report({ event: 'agent.subagent.activation.cancel-recovered', subagentId, activationId, outcome: converged?.kind })
      return converged
    }
    if (claim?.kind !== 'claimed' && claim?.kind !== 'replay') {
      report({ event: 'agent.subagent.activation.skipped', subagentId, activationId, reason: claim?.kind ?? 'missing' })
      return { kind: claim?.kind ?? 'missing', changed: false }
    }
    const descriptor = claim.subagent
    const activation = claim.activation
    const sourceTurn = claim.turn
    if (!descriptor || !activation || !sourceTurn) {
      throw Object.assign(new Error('Subagent claim 缺少权威实体。'), { code: 'AGENT_SUBAGENT_CLAIM_INVALID' })
    }
    const executionGeneration = descriptor.dispatch?.generation
    const cancelGeneration = activation.cancelGeneration
    const entries = await listActivationEntries(subagentId, descriptor.budget?.maxActivations)
    const messages = buildAgentSubagentTranscript(entries.length ? entries : [{ activation, turn: sourceTurn }], activation.sequence)
    const registry = typeof buildRegistry === 'function'
      ? await buildRegistry({ descriptor, activation, turn: sourceTurn })
      : undefined
    let executionError

    try {
      await turnRuntime.execute({
        userId: descriptor.ownerId,
        projectId: descriptor.projectId,
        sessionId: descriptor.sessionId,
        id: sourceTurn.id,
        idempotencyKey: sourceTurn.idempotencyKey,
        request: sourceTurn.request,
        allowTakeover: true,
        resolve: async (runtimeOptions) => {
          const runnerResult = runnerEnvelope(await runSubagent({
            descriptor,
            activation,
            messages,
            registry,
            signal: runtimeOptions.signal,
            onEvent: runtimeOptions.onEvent,
            resumeCheckpoint: runtimeOptions.resumeCheckpoint,
            saveCheckpoint: runtimeOptions.saveCheckpoint,
            recoverToolCall: runtimeOptions.recoverToolCall,
            recoverJournalResult: runtimeOptions.recoverJournalResult,
            context: {
              ownerId: descriptor.ownerId,
              projectId: descriptor.projectId,
              sessionId: descriptor.sessionId,
            },
          }))
          return {
            kind: 'subagent_result',
            runtimeOperation: 'subagent',
            subagentId,
            activationSequence: activation.sequence,
            outputKind: descriptor.outputKind,
            output: runnerResult.output,
            ...(Array.isArray(runnerResult.toolCalls) ? { toolCalls: runnerResult.toolCalls } : {}),
            ...(Array.isArray(runnerResult.entityReferences)
              ? { entityReferences: runnerResult.entityReferences }
              : {}),
          }
        },
      })
    } catch (caught) {
      executionError = caught
    }

    let authoritativeTurn = await productStore.readAgentTurn(descriptor.ownerId, sourceTurn.id)
    if (authoritativeTurn?.status === 'cancelling' && typeof turnRuntime.finalizeCancellation === 'function') {
      await turnRuntime.finalizeCancellation({
        userId: descriptor.ownerId,
        projectId: descriptor.projectId,
        turnId: sourceTurn.id,
        reason: descriptor.cancellation?.reason ?? 'Subagent 已取消。',
      })
      authoritativeTurn = await productStore.readAgentTurn(descriptor.ownerId, sourceTurn.id)
    }

    if (!TERMINAL_TURN_STATUSES.has(authoritativeTurn?.status)) {
      if (executionError) throw executionError
      report({ event: 'agent.subagent.activation.deferred', subagentId, activationId, status: authoritativeTurn?.status })
      return { kind: 'in_progress', changed: false, turn: authoritativeTurn }
    }

    const settlement = await productStore.settleAgentSubagentActivation({
      subagentId,
      activationId,
      leaseToken,
      executionGeneration,
      cancelGeneration,
    })
    const latestDescriptor = settlement?.subagent
      ?? await productStore.readAgentSubagentForWorker?.(subagentId)
      ?? descriptor
    if (latestDescriptor?.status === 'cancelling' && typeof convergeCancellation === 'function') {
      await convergeCancellation(latestDescriptor)
    } else {
      await finalizeCancellation(latestDescriptor)
    }
    const handedOff = await handoffNext(settlement, latestDescriptor, entries)
    report({
      event: 'agent.subagent.activation.settled',
      subagentId,
      activationId,
      turnStatus: authoritativeTurn.status,
      settlement: settlement?.kind,
      handedOff,
    })
    // failed 是 activation 的真实业务终态；已 durable settle 后不再让 BullMQ 重试。
    return {
      kind: settlement?.kind ?? 'settled',
      changed: settlement?.changed !== false,
      turnStatus: authoritativeTurn.status,
      handedOff,
    }
  }
}
