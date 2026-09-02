// @ts-check

function runnableIdentity(entry) {
  const subagentId = typeof entry?.subagent?.id === 'string' ? entry.subagent.id.trim() : ''
  const activationId = typeof entry?.activation?.id === 'string' ? entry.activation.id.trim() : ''
  if (!subagentId || !activationId) return undefined
  return { subagentId, activationId }
}

function runnableCursor(entry) {
  const id = typeof entry?.subagent?.id === 'string' ? entry.subagent.id.trim() : ''
  const updatedAt = Number(entry?.subagent?.updatedAt)
  if (!id || !Number.isSafeInteger(updatedAt) || updatedAt < 0) return undefined
  return { updatedAt, id }
}

function cursorKey(cursor) {
  return cursor ? `${cursor.updatedAt}:${cursor.id}` : 'start'
}

const observableErrorCode = /^[A-Z][A-Z0-9_]{1,79}$/

function safeObservedErrorCode(caught) {
  const code = caught && typeof caught === 'object' && 'code' in caught
    ? caught.code
    : undefined
  return typeof code === 'string' && observableErrorCode.test(code)
    ? code
    : 'AGENT_SUBAGENT_QUEUE_FAILED'
}

/**
 * 从数据库权威状态重建遗漏的队列唤醒。它不修改 descriptor/activation，也不判断
 * takeover；真正的 FIFO、lease 与 cancel-generation 判定全部留给 claim。
 *
 * @param {{
 *   productStore?: any,
 *   enqueue?: (identity: { subagentId: string, activationId: string }) => Promise<boolean | void>,
 *   limit?: number,
 *   maxPages?: number,
 *   now?: () => number,
 *   observe?: (event: any) => void,
 * }} [input]
 */
export function createAgentSubagentRecovery({
  productStore,
  enqueue,
  limit = 100,
  maxPages = 20,
  now = () => Date.now(),
  observe,
} = {}) {
  if (typeof productStore?.listRunnableAgentSubagents !== 'function') {
    throw new TypeError('Subagent 恢复缺少 ProductStore 查询能力。')
  }
  if (typeof enqueue !== 'function') throw new TypeError('Subagent 恢复缺少队列投递能力。')
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 200))
  const boundedMaxPages = Math.max(1, Math.min(Number(maxPages) || 20, 100))
  const report = (event) => {
    try { observe?.(event) } catch { /* 观测不得改变恢复结果。 */ }
  }
  // 单轮有页数上限；跨轮保留 keyset cursor，避免队列积压大于上限时尾部永久饥饿。
  // 抵达尾页或游标异常后回绕，确保 cursor 之前的新记录最终也会被扫描。
  let sweepAfter = null

  return async function recoverRunnableAgentSubagents() {
    const sweepNow = now()
    const summary = { scanned: 0, enqueued: 0, deduplicated: 0, invalid: 0, failed: 0 }
    let after = sweepAfter
    const seenCursors = new Set([cursorKey(after)])

    for (let pageIndex = 0; pageIndex < boundedMaxPages; pageIndex += 1) {
      const runnable = await productStore.listRunnableAgentSubagents({
        now: sweepNow,
        after,
        limit: boundedLimit,
      }) ?? []
      summary.scanned += runnable.length

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
            code: safeObservedErrorCode(caught),
          })
        }
      }

      if (runnable.length < boundedLimit) {
        sweepAfter = null
        break
      }
      const nextAfter = runnableCursor(runnable.at(-1))
      const nextCursorKey = cursorKey(nextAfter)
      if (!nextAfter || seenCursors.has(nextCursorKey)) {
        report({ event: 'agent.subagent.recovery.cursor_stalled' })
        sweepAfter = null
        break
      }
      seenCursors.add(nextCursorKey)
      after = nextAfter
      sweepAfter = nextAfter
    }
    return summary
  }
}
