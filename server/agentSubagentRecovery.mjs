// @ts-check

function runnableIdentity(entry) {
  const subagentId = typeof entry?.subagent?.id === 'string' ? entry.subagent.id.trim() : ''
  const activationId = typeof entry?.activation?.id === 'string' ? entry.activation.id.trim() : ''
  if (!subagentId || !activationId) return undefined
  return { subagentId, activationId }
}

/**
 * 从数据库权威状态重建遗漏的队列唤醒。它不修改 descriptor/activation，也不判断
 * takeover；真正的 FIFO、lease 与 cancel-generation 判定全部留给 claim。
 *
 * @param {{
 *   productStore?: any,
 *   enqueue?: (identity: { subagentId: string, activationId: string }) => Promise<boolean | void>,
 *   limit?: number,
 *   now?: () => number,
 *   observe?: (event: any) => void,
 * }} [input]
 */
export function createAgentSubagentRecovery({
  productStore,
  enqueue,
  limit = 100,
  now = () => Date.now(),
  observe,
} = {}) {
  if (typeof productStore?.listRunnableAgentSubagents !== 'function') {
    throw new TypeError('Subagent 恢复缺少 ProductStore 查询能力。')
  }
  if (typeof enqueue !== 'function') throw new TypeError('Subagent 恢复缺少队列投递能力。')
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 200))
  const report = (event) => {
    try { observe?.(event) } catch { /* 观测不得改变恢复结果。 */ }
  }

  return async function recoverRunnableAgentSubagents() {
    const runnable = await productStore.listRunnableAgentSubagents({
      now: now(),
      limit: boundedLimit,
    }) ?? []
    const summary = { scanned: runnable.length, enqueued: 0, deduplicated: 0, invalid: 0, failed: 0 }

    for (const entry of runnable) {
      const identity = runnableIdentity(entry)
      if (!identity) {
        summary.invalid += 1
        report({ event: 'agent.subagent.recovery.invalid' })
        continue
      }
      try {
        const changed = await enqueue(identity)
        if (changed === false) summary.deduplicated += 1
        else summary.enqueued += 1
        report({
          event: 'agent.subagent.recovery.enqueued',
          ...identity,
          deduplicated: changed === false,
        })
      } catch (caught) {
        summary.failed += 1
        report({
          event: 'agent.subagent.recovery.failed',
          ...identity,
          code: /** @type {any} */ (caught)?.code ?? 'AGENT_SUBAGENT_QUEUE_FAILED',
        })
      }
    }
    return summary
  }
}
