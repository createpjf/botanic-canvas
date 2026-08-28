// @ts-check
import { canonicalHash } from './canonicalHash.mjs'

const TERMINAL_TURN_STATUSES = new Set(['completed', 'failed', 'cancelled'])

function deterministicSignalId(subagentId, idempotencyKey) {
  return `agent_subagent_cancel_${canonicalHash({ subagentId, idempotencyKey }).slice(0, 32)}`
}

/**
 * Subagent 取消编排：descriptor fence 先落库，再逐个取消 activation Turn，最后由
 * Adapter 原子投影剩余 Result Messages 并收口 FIFO。重复执行完全幂等，供 API、
 * Worker exit 与 recovery sweep 共用。
 *
 * @param {{
 *   productStore?: any,
 *   turnRuntime?: any,
 *   publishCancel?: (event: any) => Promise<any>,
 *   observe?: (event: any) => void,
 * }} [input]
 */
export function createAgentSubagentCancellation({ productStore, turnRuntime, publishCancel, observe } = {}) {
  if (typeof productStore?.requestAgentSubagentCancellation !== 'function'
    || typeof productStore?.finalizeAgentSubagentCancellation !== 'function'
    || typeof productStore?.listAgentSubagentActivationsForWorker !== 'function') {
    throw new TypeError('Subagent 取消缺少 ProductStore 原子契约。')
  }
  if (typeof turnRuntime?.cancel !== 'function' || typeof turnRuntime?.finalizeCancellation !== 'function') {
    throw new TypeError('Subagent 取消缺少 Turn Runtime。')
  }
  const report = (event) => {
    try { observe?.(event) } catch { /* 观测不得改变取消结果。 */ }
  }

  async function rawDescriptor(subagentId, fallback) {
    return await productStore.readAgentSubagentForWorker?.(subagentId) ?? fallback
  }

  async function converge(source) {
    const descriptor = await rawDescriptor(source?.id, source)
    if (!descriptor) return { kind: 'missing', changed: false }
    if (descriptor.status === 'cancelled') return { kind: 'replay', changed: false, subagent: descriptor }
    if (descriptor.status !== 'cancelling' || !descriptor.cancellation?.signalId) {
      return { kind: 'not_cancelling', changed: false, subagent: descriptor }
    }
    const entries = await productStore.listAgentSubagentActivationsForWorker(descriptor.id, {
      afterSequence: descriptor.settledThroughSequence,
      limit: Math.max(1, Math.min(Number(descriptor.budget?.maxActivations) || 8, 8)),
    }) ?? []

    for (const entry of entries) {
      const turn = entry?.turn
      if (!turn || TERMINAL_TURN_STATUSES.has(turn.status)) continue
      await turnRuntime.cancel({
        userId: descriptor.ownerId,
        projectId: descriptor.projectId,
        turnId: turn.id,
        reason: descriptor.cancellation.reason ?? '用户取消了 Subagent。',
      })
      await publishCancel?.({
        scope: 'turn',
        id: turn.id,
        projectId: descriptor.projectId,
        requestedAt: descriptor.cancellation.requestedAt,
      })
      // queued Turn 可立即结束；running Turn 要等执行者 worker_exit ack。提前尝试是
      // 幂等的，not_ready 会由执行者 finally 或下一轮 recovery 再收口。
      await turnRuntime.finalizeCancellation({
        userId: descriptor.ownerId,
        projectId: descriptor.projectId,
        turnId: turn.id,
        reason: descriptor.cancellation.reason ?? '用户取消了 Subagent。',
      })
    }

    const finalized = await productStore.finalizeAgentSubagentCancellation(descriptor.ownerId, {
      subagentId: descriptor.id,
      projectId: descriptor.projectId,
      signalId: descriptor.cancellation.signalId,
      cancelGeneration: descriptor.cancelGeneration,
    })
    report({
      event: 'agent.subagent.cancel.converged',
      subagentId: descriptor.id,
      status: finalized?.subagent?.status ?? descriptor.status,
      outcome: finalized?.kind,
    })
    return finalized
  }

  /** @param {{ userId?: string, subagentId?: string, projectId?: string, idempotencyKey?: string, reason?: string }} [input] */
  async function request(input = {}) {
    const {
      userId,
      subagentId,
      projectId,
      idempotencyKey,
      reason = '用户取消了 Subagent。',
    } = input
    if (![userId, subagentId, projectId, idempotencyKey].every((value) => typeof value === 'string' && value.trim())) {
      throw new TypeError('Subagent 取消缺少幂等身份。')
    }
    const signalId = deterministicSignalId(subagentId, idempotencyKey)
    const requested = await productStore.requestAgentSubagentCancellation(userId, {
      subagentId,
      projectId,
      signalId,
      reason,
    })
    if (!requested?.subagent) return requested
    // Store 可在「所有 activation 已 settle」时同一原子写直接完成取消；这是真实的
    // 首次结果，不应再经 converge 降成 replay/changed=false。
    if (requested.subagent.status === 'cancelled') return requested
    if (requested.kind === 'conflict' || requested.kind === 'stale') return requested
    return converge(await rawDescriptor(subagentId, requested.subagent))
  }

  return { request, converge }
}
