// @ts-check
import { Queue, Worker } from 'bullmq'
import { canonicalHash } from './canonicalHash.mjs'

const queueName = 'botanic-subagent'
const defaultJobOptions = {
  removeOnComplete: { age: 60 * 60 * 24, count: 2_000 },
  removeOnFail: { age: 60 * 60 * 24 * 7, count: 5_000 },
}

function activationIdentity(input) {
  const subagentId = typeof input?.subagentId === 'string' ? input.subagentId.trim() : ''
  const activationId = typeof input?.activationId === 'string' ? input.activationId.trim() : ''
  if (!subagentId || !activationId) throw new TypeError('Subagent 队列缺少激活身份。')
  return { subagentId, activationId }
}

/** BullMQ 禁止自定义 jobId 含 `:`；哈希也避免把内部实体 ID 暴露到 Redis key。 */
export function agentSubagentQueueJobId(input) {
  const identity = activationIdentity(input)
  return `subagent-${canonicalHash([identity.subagentId, identity.activationId])}`
}

/**
 * 专用队列隔离长时 Subagent 激活，不占用 generation 或 derived-task 的并发槽。
 * 数据库中的 descriptor/activation/Turn 才是权威；BullMQ 只负责唤醒 Worker。
 */
export function createAgentSubagentQueue(redisUrl, { QueueImpl = Queue } = {}) {
  if (!redisUrl) return undefined
  const queue = new QueueImpl(queueName, { connection: { url: redisUrl }, defaultJobOptions })

  return {
    async enqueue(input) {
      const identity = activationIdentity(input)
      const jobId = agentSubagentQueueJobId(identity)
      const existing = await queue.getJob(jobId)
      if (existing) {
        const state = await existing.getState()
        if (state === 'failed' || state === 'completed') await existing.remove()
        else return false
      }
      await queue.add('activate', identity, { jobId })
      return true
    },

    /**
     * 只精确回收目标任务。仍被活跃 Worker 锁住时 remove 会失败，此处安全放弃，
     * 由 BullMQ stalled 检测或下一轮数据库恢复继续处理，避免重复执行。
     */
    async reclaim(input) {
      const identity = activationIdentity(input)
      const jobId = agentSubagentQueueJobId(identity)
      const existing = await queue.getJob(jobId)
      if (!existing) {
        await queue.add('activate', identity, { jobId })
        return true
      }
      const state = await existing.getState()
      if (!['active', 'failed', 'completed'].includes(state)) return false
      try {
        await existing.remove()
      } catch {
        return false
      }
      await queue.add('activate', identity, { jobId })
      return true
    },

    async close() {
      await queue.close()
    },
  }
}

export function createAgentSubagentWorker({
  redisUrl,
  concurrency,
  processActivation,
  WorkerImpl = Worker,
}) {
  if (!redisUrl) throw new Error('REDIS_URL 未配置，无法启动 Subagent Worker。')
  if (typeof processActivation !== 'function') throw new TypeError('Subagent Worker 缺少处理器。')
  return new WorkerImpl(queueName, async (job) => processActivation(activationIdentity(job.data)), {
    connection: { url: redisUrl, maxRetriesPerRequest: null },
    concurrency: Math.max(1, Number(concurrency) || 1),
    maxStalledCount: 1,
  })
}
