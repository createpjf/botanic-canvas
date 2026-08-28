import { Queue, Worker } from 'bullmq'
import {
  attachAgentTraceContext,
  withExtractedAgentTraceContext,
} from './agentTraceContext.mjs'

const queueName = 'botanic-generation'
const defaultJobOptions = {
  removeOnComplete: { age: 60 * 60 * 24, count: 1000 },
  removeOnFail: { age: 60 * 60 * 24 * 7, count: 5000 },
}

export function createGenerationQueue(redisUrl, { QueueImpl = Queue } = {}) {
  if (!redisUrl) return undefined
  const queue = new QueueImpl(queueName, { connection: { url: redisUrl }, defaultJobOptions })
  return {
    async enqueue(jobId) {
      // 数据库短暂不可用时，Worker 可能先把 BullMQ 任务标记失败而业务任务仍是 queued。
      // 恢复后需移除该陈旧队列项，才能按原 jobId 重新投递。
      const existing = await queue.getJob(jobId)
      if (existing) {
        const state = await existing.getState()
        if (state === 'failed' || state === 'completed') await existing.remove()
        else return
      }
      await queue.add('generate', attachAgentTraceContext({ jobId }), { jobId })
    },
    async cancel(jobId) {
      const job = await queue.getJob(jobId)
      if (job) await job.remove().catch(() => undefined)
    },
    // 仅用于 Worker 重启后的 stale-running 恢复。
    async reclaimStaleActive(jobId) {
      const job = await queue.getJob(jobId)
      if (!job) {
        await queue.add('generate', attachAgentTraceContext({ jobId }), { jobId })
        return true
      }
      const state = await job.getState()
      if (!['active', 'failed', 'completed'].includes(state)) return false
      // `queue.clean(..., 'active')` 只保证清掉全队列最老的未锁任务，不保证是
      // jobId 指向的目标；limit=1 反而可能误删另一台实例正在恢复的 Job。
      // Job.remove() 以 Redis key 精确定位，仍持有 Worker lock 时 BullMQ 会拒绝，
      // 此时让原 Worker / BullMQ stalled 检测继续负责，绝不制造重复投递。
      try {
        await job.remove()
      } catch {
        return false
      }
      await queue.add('generate', attachAgentTraceContext({ jobId }), { jobId })
      return true
    },
    async close() {
      await queue.close()
    },
  }
}

export function createGenerationWorker({ redisUrl, concurrency, processJob, WorkerImpl = Worker }) {
  if (!redisUrl) throw new Error('REDIS_URL 未配置，无法启动生成 Worker。')
  return new WorkerImpl(queueName, async (job) => withExtractedAgentTraceContext(
    job.data,
    (data) => processJob(data.jobId),
  ), {
    connection: { url: redisUrl, maxRetriesPerRequest: null },
    concurrency: Math.max(1, concurrency || 1),
    maxStalledCount: 1,
  })
}
