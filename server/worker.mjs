import { createGenerationProcessor } from './generationProcessor.mjs'
import { createGenerationQueue, createGenerationWorker } from './generationQueue.mjs'
import { createProductRuntime, loadLocalEnv, runtimeConfig } from './runtime.mjs'

loadLocalEnv()
const config = runtimeConfig()
if (!config.production) console.warn('Botanic Worker 正在以本地配置运行；生产环境必须使用 PostgreSQL、Redis 与对象存储。')
const runtime = await createProductRuntime(config)
if (!config.redisUrl) throw new Error('REDIS_URL 未配置，Worker 拒绝启动。')
const queue = createGenerationQueue(config.redisUrl)
for (const queued of await runtime.productStore.recoverGenerationJobs()) await queue.enqueue(queued.id)
const worker = createGenerationWorker({
  redisUrl: config.redisUrl,
  concurrency: config.workerConcurrency,
  processJob: createGenerationProcessor({ ...runtime, config }),
})

worker.on('failed', (job, caught) => console.error(`[generation] BullMQ job ${job?.id ?? 'unknown'} failed: ${caught.message}`))
console.log(`Botanic generation worker started (concurrency ${config.workerConcurrency})`)

async function shutdown() {
  await worker.close()
  await queue.close()
  await runtime.mediaService.close()
  await runtime.productStore.close?.()
}
process.once('SIGTERM', () => void shutdown().then(() => process.exit(0)))
process.once('SIGINT', () => void shutdown().then(() => process.exit(0)))
