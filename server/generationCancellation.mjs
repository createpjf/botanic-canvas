// @ts-check

import { generationCancelOutcome } from './generationCancelCapability.mjs'
import { providerForModel } from './generationModels.mjs'
import { persistedGenerationJob } from './generationProvider.mjs'

/**
 * 取消一个生成任务的唯一权威实现。
 *
 * 之前这段逻辑在三处各写了一遍（单任务取消、Agent Run 取消、工作流暂停/取消），
 * 而只有第一处广播了取消事件 —— 也就是说用户停掉一个 Agent Run 或工作流时，
 * Worker 仍会把 Provider 调用跑完才发现结果没人要，槽位一直被占着。Epic 1 能
 * 交付的三件事里有两件（释放 worker 容量、迟到结果不写回）就卡在这个漏广播上。
 *
 * 一次取消由四个动作构成，缺一不可：
 * 1. 按**取消前的状态**判定真实后果（改写状态之后就算不出来了）；
 * 2. 写下状态与取消回执（回执是计费归因唯一的持久记录）；
 * 3. 从队列移除 —— 这是唯一真能省下费用的路径，只对尚未派发的任务有效；
 * 4. 广播给 Worker 进程 —— 它看不到这里写下的 cancelled，只能靠广播就地 abort。
 */

/** 取消来源。取消回执要能回答「谁停的」，所以来源是声明式的，不接受任意字符串。 */
export const GENERATION_CANCEL_REASONS = Object.freeze([
  'user',
  'agent-run',
  'workflow-cancel',
  'workflow-pause',
])

/**
 * @typedef {{
 *   requestedAt: number,
 *   reason: string,
 *   requestedBy?: string,
 *   billing: 'none' | 'possible',
 *   capability: string,
 *   workerReleased: boolean,
 *   code: string,
 * }} GenerationCancelRecord
 */

/**
 * 已记录的取消回执本身就是一份合法的取消判定（字段是其超集）。
 * 重复取消据此返回与第一次相同的答案，而不是无声退化成中性文案。
 */
export function recordedGenerationCancelOutcome(job) {
  const record = /** @type {GenerationCancelRecord | undefined} */ (job?.cancel)
  if (!record) return undefined
  return {
    billing: record.billing,
    capability: record.capability,
    workerReleased: record.workerReleased,
    code: record.code,
  }
}

/**
 * 取消单个生成任务。已终态的任务不再改写，但仍返回可用于文案的判定。
 *
 * @param {{
 *   productStore: any,
 *   redisQueue?: any,
 *   publishCancel?: (event: { scope: string, id: string, projectId?: string, requestedAt?: number }) => Promise<any> | any,
 *   modelOptions?: any[],
 *   ownerId: string,
 *   job: any,
 *   reason: string,
 *   requestedAt?: number,
 *   requestedBy?: string,
 *   afterPersist?: (job: any) => Promise<any> | any,
 * }} input
 * @returns {Promise<{ cancelled: boolean, job: any, outcome: ReturnType<typeof generationCancelOutcome> }>}
 */
export async function cancelGenerationJob({
  productStore,
  redisQueue,
  publishCancel,
  modelOptions = [],
  ownerId,
  job,
  reason,
  requestedAt = Date.now(),
  requestedBy,
  afterPersist,
}) {
  if (!GENERATION_CANCEL_REASONS.includes(reason)) {
    throw new Error(`未声明的取消来源：${reason}`)
  }
  // 判定必须在改写状态之前算：queued 与 running 的计费后果完全不同。
  const outcome = generationCancelOutcome({
    status: job.status,
    provider: providerForModel(modelOptions, job.settings?.model)?.provider,
  })
  if (job.status !== 'queued' && job.status !== 'running') {
    return { cancelled: false, job, outcome: recordedGenerationCancelOutcome(job) ?? outcome }
  }
  /** @type {GenerationCancelRecord} */
  const record = {
    requestedAt,
    reason,
    ...(requestedBy ? { requestedBy } : {}),
    billing: outcome.billing,
    capability: outcome.capability,
    workerReleased: outcome.workerReleased,
    code: outcome.code,
  }
  const cancelled = { ...job, status: 'cancelled', error: undefined, cancel: record, updatedAt: requestedAt }
  await productStore.putGenerationJob(ownerId, persistedGenerationJob(cancelled))
  await afterPersist?.(cancelled)
  // 只对尚未派发的任务有效，也正因如此它是唯一真省钱的路径。
  await redisQueue?.cancel(job.id)
  // Worker 是独立进程：不广播它就会等 Provider 跑完再丢弃结果，槽位白占。
  // 带上请求时刻，Worker 才能报出「点取消 → 本地 abort」的延迟分位数。
  await publishCancel?.({ scope: 'job', id: job.id, projectId: job.projectId, requestedAt })
  return { cancelled: true, job: cancelled, outcome }
}
