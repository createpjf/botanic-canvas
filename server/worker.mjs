import { createGenerationProcessor } from './generationProcessor.mjs'
import { createGenerationQueue, createGenerationWorker } from './generationQueue.mjs'
import { createProductRuntime, loadLocalEnv, runtimeConfig } from './runtime.mjs'
import { createAgentRunEventPublisher, createAgentRunEventSubscriber } from './agentRunEventBus.mjs'
import { writeAgentRunOperationalEvent } from './agentRunObservability.mjs'
import { createProviderHealthMonitor } from './providerHealthMonitor.mjs'
import { createDerivedTaskQueue, createDerivedTaskWorker } from './derivedTaskQueue.mjs'
import { createAgentTurnSweep } from './agentTurnSweep.mjs'
import { createAgentTurnResumer } from './agentTurnResume.mjs'
import { createBotanicAgentTurnRuntime } from './botanicAgentTurnRuntime.mjs'
import { createLocalCancelRegistry } from './localCancelRegistry.mjs'

loadLocalEnv()
const config = runtimeConfig()
if (!config.production) console.warn('Botanic Worker 正在以本地配置运行；生产环境必须使用 PostgreSQL、Redis 与对象存储。')
const runtime = await createProductRuntime(config)
if (!config.redisUrl) throw new Error('REDIS_URL 未配置，Worker 拒绝启动。')
const queue = createGenerationQueue(config.redisUrl)
const agentRunEvents = createAgentRunEventPublisher(config.redisUrl)
const providerHealth = createProviderHealthMonitor({
  redisUrl: config.redisUrl,
  failureThreshold: config.providerFailureThreshold,
  cooldownMs: config.providerCircuitCooldownMs,
  onFallback: (caught) => console.error(`[provider-health] Redis unavailable: ${caught instanceof Error ? caught.message : String(caught)}`),
})
// Worker 与 API 是两个进程：API 写下 cancelled 时本进程不会知道，只能等 Provider
// 跑完再丢弃结果。订阅取消频道后就地 abort，Provider 调用真正停下、槽位立刻释放。
const jobCancelRegistry = createLocalCancelRegistry()
const cancelSubscriber = await createAgentRunEventSubscriber(config.redisUrl, () => {}, {
  onCancel: (event) => {
    if (event.scope !== 'job') return
    if (jobCancelRegistry.abort(event.id)) console.log(JSON.stringify({ event: 'generation.cancel.aborted', jobId: event.id }))
  },
})
const worker = createGenerationWorker({
  redisUrl: config.redisUrl,
  concurrency: config.workerConcurrency,
  processJob: createGenerationProcessor({
    ...runtime,
    config,
    cancelRegistry: jobCancelRegistry,
    publishAgentRunUpdated: agentRunEvents.publish,
    publishProjectUpdated: agentRunEvents.publishProjectUpdated,
    observeAgentRun: writeAgentRunOperationalEvent,
    providerCircuitBreaker: providerHealth,
  }),
})

worker.on('failed', (job, caught) => console.error(`[generation] BullMQ job ${job?.id ?? 'unknown'} failed: ${caught.message}`))
worker.on('error', (caught) => console.error(`[generation] BullMQ worker error: ${caught.message}`))
console.log(`Botanic generation worker started (concurrency ${config.workerConcurrency})`)

// 派生任务与生成任务分队列：一类任务堆积不应拖垮另一类。当前只有孤儿 Turn 回收，
// 新种类要和它的消费者一起加（见 derivedTaskQueue 的种类词表）。
const derivedQueue = createDerivedTaskQueue(config.redisUrl)
const sweepStaleAgentTurns = createAgentTurnSweep({
  productStore: runtime.productStore,
  observe: (event) => console.log(JSON.stringify(event)),
  // 不传 toolRisk：工具事件自带该次调用实际适用的 risk，比按名字事后查更准，
  // 也不必在 Worker 里构造需要运行时依赖的工具注册表。早于该字段落地的历史事件
  // 因此判为未知能力 → 不可重放，这是安全的默认。
  resumeTurn: createAgentTurnResumer({
    productStore: runtime.productStore,
    config,
    mediaService: runtime.mediaService,
    turnRuntime: createBotanicAgentTurnRuntime({ productStore: runtime.productStore }),
    observe: (event) => console.log(JSON.stringify(event)),
  }),
})
const derivedWorker = createDerivedTaskWorker({
  redisUrl: config.redisUrl,
  concurrency: 1,
  handlers: { 'turn.reclaim': () => sweepStaleAgentTurns() },
})
derivedWorker.on('failed', (job, caught) => console.error(`[derived] ${job?.name ?? 'unknown'} failed: ${caught.message}`))
derivedWorker.on('error', (caught) => console.error(`[derived] worker error: ${caught.message}`))
// 注册幂等：BullMQ 按 repeat key 去重，多实例重复注册不会产生多份定时任务。
await derivedQueue?.scheduleSweep('turn.reclaim', 60_000).catch((caught) => {
  console.error(`[derived] 清扫注册失败: ${caught instanceof Error ? caught.message : String(caught)}`)
})
console.log('Botanic derived-task worker started (turn.reclaim sweep every 60s)')

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
  await cancelSubscriber?.close()
  await derivedWorker.close(true)
  await derivedQueue?.close()
  // 供应商或对象流异常时，默认 close 会一直等待 active job，导致部署后旧容器
  // 仍持有 Redis lock、新 Worker 无法接手。强制关闭后 BullMQ 会将该 job 作为
  // stalled 回收，配合 90 秒 stale-running 恢复逻辑重新执行。
  await worker.close(true)
  await queue.close()
  await agentRunEvents.close()
  await providerHealth.close()
  await runtime.mediaService.close()
  await runtime.productStore.close?.()
}
process.once('SIGTERM', () => void shutdown().then(() => process.exit(0)))
process.once('SIGINT', () => void shutdown().then(() => process.exit(0)))
