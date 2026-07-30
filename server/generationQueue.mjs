import { Queue, Worker } from 'bullmq'

const queueName = 'botanic-generation'
const defaultJobOptions = {
  removeOnComplete: { age: 60 * 60 * 24, count: 1000 },
  removeOnFail: { age: 60 * 60 * 24 * 7, count: 5000 },
}

export function createGenerationQueue(redisUrl) {
  if (!redisUrl) return undefined
  const queue = new Queue(queueName, { connection: { url: redisUrl }, defaultJobOptions })
  return {
    async enqueue(jobId) {
      await queue.add('generate', { jobId }, { jobId })
    },
    async cancel(jobId) {
      const job = await queue.getJob(jobId)
      if (job) await job.remove().catch(() => undefined)
    },
    async close() {
      await queue.close()
    },
  }
}

export function createGenerationWorker({ redisUrl, concurrency, processJob }) {
  if (!redisUrl) throw new Error('REDIS_URL 未配置，无法启动生成 Worker。')
  return new Worker(queueName, async (job) => processJob(job.data.jobId), {
    connection: { url: redisUrl, maxRetriesPerRequest: null },
    concurrency: Math.max(1, concurrency || 1),
    maxStalledCount: 1,
  })
}
