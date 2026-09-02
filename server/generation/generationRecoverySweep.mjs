// @ts-check
import { boundedSweepPageSize, nextUpdatedAtIdSweepCursor } from '../updatedAtIdSweepCursor.mjs'

/**
 * Generation Job 恢复清扫的深模块。
 *
 * Store 只负责按 `(updatedAt,id)` 提供稳定 keyset 页；本模块拥有跨 sweep cursor、
 * 单轮页预算、尾部 wrap 与逐 Job 入队隔离。Worker 后续只需把真实 queue.enqueue
 * 注入，不再自行写一套可能饥饿的恢复循环。
 *
 * @param {{
 *   productStore: any,
 *   enqueue: (jobId: string) => Promise<any>,
 *   maxPages?: number,
 *   observe?: (event: any) => void,
 * }} input
 */
export function createGenerationRecoverySweep({
  productStore,
  enqueue,
  maxPages = 4,
  observe = () => {},
}) {
  if (typeof productStore?.listRecoverableGenerationJobs !== 'function') {
    throw new TypeError('Generation Recovery Sweep 缺少稳定分页 Store Interface。')
  }
  if (typeof enqueue !== 'function') throw new TypeError('Generation Recovery Sweep 缺少 enqueue。')
  const pageBudget = Math.max(1, Math.min(Number(maxPages) || 4, 20))
  let after = null

  /** @param {{ limit?: number }} [input] */
  return async function sweepRecoverableGenerationJobs({ limit = 25 } = {}) {
    const pageLimit = boundedSweepPageSize(limit)
    let pages = 0
    let scanned = 0
    let enqueued = 0
    let failed = 0

    while (pages < pageBudget) {
      const requestedAfter = after
      const page = (await productStore.listRecoverableGenerationJobs({
        after: requestedAfter,
        limit: pageLimit,
      })) ?? []
      pages += 1
      scanned += page.length

      const progression = nextUpdatedAtIdSweepCursor({
        after: requestedAfter,
        page,
        limit: pageLimit,
      })
      after = progression.after
      if (progression.stalled) {
        observe({ event: 'generation.recovery.cursor_stalled', after: requestedAfter })
        // 重复/坏页不能再次 enqueue，也不能继续消耗页预算形成热循环。
        break
      }

      for (const job of page) {
        const jobId = typeof job?.id === 'string' ? job.id.trim() : ''
        if (!jobId) {
          failed += 1
          observe({ event: 'generation.recovery.enqueue.failed', jobId: undefined, message: '恢复项缺少 Job 标识。' })
          continue
        }
        try {
          await enqueue(jobId)
          enqueued += 1
        } catch (caught) {
          failed += 1
          observe({
            event: 'generation.recovery.enqueue.failed',
            jobId,
            message: caught instanceof Error ? caught.message : String(caught),
          })
        }
      }

      if (progression.wrapped) break
    }

    return { pages, scanned, enqueued, failed }
  }
}
