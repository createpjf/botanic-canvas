import { createGenerationProcessor } from './generationProcessor.mjs'
import { createGenerationQueue, createGenerationWorker } from './generationQueue.mjs'
import { createProductRuntime, loadLocalEnv, runtimeConfig } from './runtime.mjs'
import { createAgentRunEventPublisher, createAgentRunEventSubscriber } from './agentRunEventBus.mjs'
import { writeAgentRunOperationalEvent } from './agentRunObservability.mjs'
import { createProviderHealthMonitor } from './providerHealthMonitor.mjs'
import { createDerivedTaskQueue, createDerivedTaskWorker } from './derivedTaskQueue.mjs'
import { createAgentTurnSweep } from './agentTurnSweep.mjs'
import { createAgentReviewService } from './agentReviewService.mjs'
import { createAgentReviewVisionJudge } from './agentReviewVision.mjs'
import { resolveBotanicAgentImageDataUrl } from './botanicAgentVision.mjs'
import { createProductionWorkflowSweep } from './productionWorkflowAdvance.mjs'
import { createAgentBranchRetrySweep } from './agentBranchRetrySweep.mjs'
import { createAgentBranchRetryService } from './agentBranchRetryService.mjs'
import { createAgentRunGenerationService } from './agentRunGenerationService.mjs'
import { createSecurityControls } from './securityControls.mjs'
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
    if (!jobCancelRegistry.abort(event.id)) return
    // 记下「用户点取消」到「本地 abort 生效」的间隔：这是取消延迟唯一可观测的口径。
    // 跨进程时间差包含机器间时钟偏移，只用于看分位数趋势，不用于精确归因。
    const latencyMs = typeof event.requestedAt === 'number' ? Date.now() - event.requestedAt : undefined
    console.log(JSON.stringify({ event: 'generation.cancel.aborted', jobId: event.id, latencyMs }))
  },
})
// 派生任务与生成任务分队列：一类任务堆积不应拖垮另一类。
const derivedQueue = createDerivedTaskQueue(config.redisUrl)
// 评审在 Worker 侧执行，不依赖浏览器打开。视觉层的判据全部来自计划快照的质量策略；
// 没配置视觉模型时 judge 为 undefined，语义判据照实记为无法验证而不是默认通过。
const reviewVisionJudge = createAgentReviewVisionJudge({
  runtimeConfig: config,
  resolveMedia: (image) => resolveBotanicAgentImageDataUrl(image, (mediaId) => (
    runtime.mediaService?.enabled ? runtime.mediaService.read(mediaId) : undefined
  )),
})
const reviewService = createAgentReviewService({
  productStore: runtime.productStore,
  reviewCandidate: reviewVisionJudge,
  observe: (event) => console.log(JSON.stringify(event)),
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
    ensureReviewTask: (ownerId, runId) => reviewService.ensureReviewTaskForRun(ownerId, runId),
    enqueueDerivedTask: (kind, dedupeId, payload) => derivedQueue?.enqueue(kind, dedupeId, payload),
  }),
})

worker.on('failed', (job, caught) => console.error(`[generation] BullMQ job ${job?.id ?? 'unknown'} failed: ${caught.message}`))
worker.on('error', (caught) => console.error(`[generation] BullMQ worker error: ${caught.message}`))
console.log(`Botanic generation worker started (concurrency ${config.workerConcurrency})`)

// 新种类要和它的消费者一起加（见 derivedTaskQueue 的种类词表）。
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
// 工作流推进同样在 Worker 侧：此前只有「有人打开页面」才会对账批量运行的真实状态。
const sweepProductionWorkflows = createProductionWorkflowSweep({
  productStore: runtime.productStore,
  observe: (event) => console.log(JSON.stringify(event)),
})
// 失败分支自动重试：策略在服务端，因此关掉浏览器后仍会按策略重试一次；
// 不可重试错误、高成本重试与预算不足都会停下等用户，并把原因记进日志。
const securityControls = createSecurityControls({
  redisUrl: config.redisUrl,
  onFallback: (caught) => console.error(`[security] Redis unavailable: ${caught instanceof Error ? caught.message : String(caught)}`),
})
const agentRunGeneration = createAgentRunGenerationService({
  config,
  productStore: runtime.productStore,
  securityControls,
  enqueue: (jobId) => queue.enqueue(jobId),
  publishProjectUpdated: agentRunEvents.publishProjectUpdated,
  publishAgentRunUpdated: agentRunEvents.publish,
})
const sweepFailedBranches = createAgentBranchRetrySweep({
  productStore: runtime.productStore,
  retryAgentBranch: createAgentBranchRetryService({
    productStore: runtime.productStore,
    config,
    enqueue: (jobId) => queue.enqueue(jobId),
    securityControls,
    publishProjectUpdated: agentRunEvents.publishProjectUpdated,
    publishAgentRunUpdated: agentRunEvents.publish,
    agentRunGeneration,
    observeRun: writeAgentRunOperationalEvent,
  }),
  observe: (event) => console.log(JSON.stringify(event)),
})
const derivedWorker = createDerivedTaskWorker({
  redisUrl: config.redisUrl,
  concurrency: 1,
  handlers: {
    'turn.reclaim': () => sweepStaleAgentTurns(),
    'review.run': async (payload) => (payload?.sweep
      ? reviewService.sweepPendingReviewTasks()
      : reviewService.executeReviewTask(payload.ownerId, payload.taskId)),
    'workflow.advance': () => sweepProductionWorkflows(),
    'branch.retry': () => sweepFailedBranches(),
  },
})
derivedWorker.on('failed', (job, caught) => console.error(`[derived] ${job?.name ?? 'unknown'} failed: ${caught.message}`))
derivedWorker.on('error', (caught) => console.error(`[derived] worker error: ${caught.message}`))
// 注册幂等：BullMQ 按 repeat key 去重，多实例重复注册不会产生多份定时任务。
for (const [kind, everyMs] of [['turn.reclaim', 60_000], ['review.run', 120_000], ['workflow.advance', 45_000], ['branch.retry', 90_000]]) {
  await derivedQueue?.scheduleSweep(kind, everyMs).catch((caught) => {
    console.error(`[derived] ${kind} 清扫注册失败: ${caught instanceof Error ? caught.message : String(caught)}`)
  })
}
console.log('Botanic derived-task worker started (turn.reclaim 60s, review.run 120s, workflow.advance 45s, branch.retry 90s)')

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
