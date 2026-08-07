import { createGenerationProcessor } from './generationProcessor.mjs'
import { createGenerationQueue, createGenerationWorker } from './generationQueue.mjs'
import { createProductRuntime, loadLocalEnv, runtimeConfig } from './runtime.mjs'
import { createAgentRunEventPublisher } from './agentRunEventBus.mjs'
import { writeAgentRunOperationalEvent } from './agentRunObservability.mjs'

loadLocalEnv()
const config = runtimeConfig()
if (!config.production) console.warn('Botanic Worker 正在以本地配置运行；生产环境必须使用 PostgreSQL、Redis 与对象存储。')
const runtime = await createProductRuntime(config)
if (!config.redisUrl) throw new Error('REDIS_URL 未配置，Worker 拒绝启动。')
const queue = createGenerationQueue(config.redisUrl)
const agentRunEvents = createAgentRunEventPublisher(config.redisUrl)
const worker = createGenerationWorker({
  redisUrl: config.redisUrl,
  concurrency: config.workerConcurrency,
  processJob: createGenerationProcessor({
    ...runtime,
    config,
    publishAgentRunUpdated: agentRunEvents.publish,
    observeAgentRun: writeAgentRunOperationalEvent,
  }),
})

worker.on('failed', (job, caught) => console.error(`[generation] BullMQ job ${job?.id ?? 'unknown'} failed: ${caught.message}`))
worker.on('error', (caught) => console.error(`[generation] BullMQ worker error: ${caught.message}`))
console.log(`Botanic generation worker started (concurrency ${config.workerConcurrency})`)

async function recoverQueuedJobs() {
  try {
    for (const queued of await runtime.productStore.recoverGenerationJobs()) await queue.enqueue(queued.id)
  } catch (caught) {
    // Worker 后续会周期性重试；短暂的恢复查询失败不能造成进程反复重启或遗留队列任务。
    console.error(`[generation] worker recovery deferred: ${caught instanceof Error ? caught.message : String(caught)}`)
  }
}
// 恢复查询或 Redis 重投递不能阻塞 Worker 自身启动，否则新任务也无法被消费。
void recoverQueuedJobs()
const recoveryTimer = setInterval(() => void recoverQueuedJobs(), 30_000)
recoveryTimer.unref()

async function reclaimInterruptedJobs() {
  // 等待旧 Worker 的 Redis lock 到期，避免与尚在关闭中的实例并发处理同一任务。
  await new Promise((resolve) => setTimeout(resolve, 35_000))
  try {
    const stale = await runtime.productStore.recoverStaleGenerationJobs?.()
    for (const job of stale ?? []) {
      if (await queue.reclaimStaleActive(job.id)) console.warn(`[generation] ${job.id} reclaimed after interrupted worker`)
    }
  } catch (caught) {
    console.error(`[generation] stale recovery deferred: ${caught instanceof Error ? caught.message : String(caught)}`)
  }
}
void reclaimInterruptedJobs()

async function shutdown() {
  clearInterval(recoveryTimer)
  // 供应商或对象流异常时，默认 close 会一直等待 active job，导致部署后旧容器
  // 仍持有 Redis lock、新 Worker 无法接手。强制关闭后 BullMQ 会将该 job 作为
  // stalled 回收，配合 90 秒 stale-running 恢复逻辑重新执行。
  await worker.close(true)
  await queue.close()
  await agentRunEvents.close()
  await runtime.mediaService.close()
  await runtime.productStore.close?.()
}
process.once('SIGTERM', () => void shutdown().then(() => process.exit(0)))
process.once('SIGINT', () => void shutdown().then(() => process.exit(0)))
