// @ts-check
import { Queue, Worker } from 'bullmq'

const queueName = 'botanic-derived'
const defaultJobOptions = {
  removeOnComplete: { age: 60 * 60 * 24, count: 1000 },
  removeOnFail: { age: 60 * 60 * 24 * 7, count: 5000 },
}

/**
 * 派生任务种类。派生任务是「业务结果的衍生工作」：它们不拥有业务权威，失败也不得
 * 回滚已持久化的业务实体，因此与生成队列分开，避免一类任务的堆积拖垮另一类。
 *
 * 种类必须声明；查询未声明的种类会抛错而不是静默入队一个永远没人消费的任务。
 * 新种类要和它的消费者一起加 —— 没有消费者的种类只是猜测。
 */
export const DERIVED_TASK_KINDS = Object.freeze([
  // 回收超过租约未推进的非终态 Turn（ADR 0004）。
  'turn.reclaim',
  // 对已到执行终态的 Run 做结果评审（ADR 0006）。评审是派生工作：它不拥有业务权威，
  // 失败不得回滚已成功的 Run 或 Job。
  'review.run',
])

const kindSet = new Set(DERIVED_TASK_KINDS)

function assertKind(kind) {
  if (!kindSet.has(kind)) throw new TypeError(`未声明的派生任务种类：${kind}`)
}

/**
 * 复合标识用 `__` 而不是 `:` 分隔：BullMQ 明确拒绝含 `:` 的自定义 jobId
 * （Custom Id cannot contain :），因此实体标识本身也不得包含冒号。
 */
const compositeId = (...parts) => parts.join('__')

/**
 * 周期性清扫任务的重复键。BullMQ 按该键去重，因此多个 API 实例重复注册
 * 不会产生多份定时任务。
 */
export function derivedSweepKey(kind) {
  assertKind(kind)
  return compositeId('sweep', kind)
}

/**
 * @param {string | undefined} redisUrl
 */
export function createDerivedTaskQueue(redisUrl) {
  if (!redisUrl) return undefined
  const queue = new Queue(queueName, { connection: { url: redisUrl }, defaultJobOptions })
  return {
    /**
     * 入队一个针对具体实体的派生任务。`dedupeId` 参与 BullMQ jobId，因此同一实体
     * 的重复请求不会产生第二个任务 —— 派生任务重复执行的代价可能是重复评审或
     * 重复外部动作。
     */
    async enqueue(kind, dedupeId, payload = {}) {
      assertKind(kind)
      const jobId = compositeId(kind, dedupeId)
      const existing = await queue.getJob(jobId)
      if (existing) {
        const state = await existing.getState()
        // 与生成队列同构：陈旧的终态项要先移除才能按原 ID 重投。
        if (state === 'failed' || state === 'completed') await existing.remove()
        else return false
      }
      await queue.add(kind, { kind, ...payload }, { jobId })
      return true
    },
    /** 注册周期性清扫。重复调用幂等，由 BullMQ 按 repeat key 去重。 */
    async scheduleSweep(kind, everyMs) {
      assertKind(kind)
      await queue.add(kind, { kind, sweep: true }, {
        repeat: { every: Math.max(10_000, Number(everyMs) || 60_000), key: derivedSweepKey(kind) },
        jobId: derivedSweepKey(kind),
      })
    },
    async close() {
      await queue.close()
    },
  }
}

/**
 * @param {{ redisUrl?: string, concurrency?: number, handlers: Record<string, (payload: any) => Promise<unknown>> }} input
 */
export function createDerivedTaskWorker({ redisUrl, concurrency, handlers }) {
  if (!redisUrl) throw new Error('REDIS_URL 未配置，无法启动派生任务 Worker。')
  for (const kind of Object.keys(handlers ?? {})) assertKind(kind)
  return new Worker(queueName, async (job) => {
    const handler = handlers?.[job.data?.kind]
    // 没有处理器的种类直接跳过而不是抛错：一次滚动发布中新旧 Worker 并存时，
    // 旧 Worker 会看到还不认识的种类，抛错只会把它标记失败并触发无意义重试。
    if (!handler) return { skipped: true, kind: job.data?.kind }
    return handler(job.data)
  }, {
    connection: { url: redisUrl, maxRetriesPerRequest: null },
    concurrency: Math.max(1, concurrency || 1),
    maxStalledCount: 1,
  })
}
