import { randomUUID } from 'node:crypto'
import { createGenerationProcessor } from './generationProcessor.mjs'
import { createGenerationQueue, createGenerationWorker } from './generationQueue.mjs'
import { createProductRuntime, loadLocalEnv, runtimeConfig } from './runtime.mjs'
import { createAgentRunEventPublisher, createAgentRunEventSubscriber } from './agentRunEventBus.mjs'
import { createCanvasRealtimeEventPublisher } from './canvas/canvasRealtimeEventBus.mjs'
import { writeAgentRunOperationalEvent } from './agentRunObservability.mjs'
import { createProviderHealthMonitor } from './providerHealthMonitor.mjs'
import { createDerivedTaskQueue, createDerivedTaskWorker } from './derivedTaskQueue.mjs'
import { createAgentTurnSweep } from './agentTurnSweep.mjs'
import { createAgentReviewService, safeAgentReviewWorkerFailure } from './agentReviewService.mjs'
import { installDatabaseResilience } from './databaseResilience.mjs'
import { createEvaluatorSkillRunner } from './agentReviewSkillEvaluator.mjs'
import { createAgentReviewVisionJudge } from './agentReviewVision.mjs'
import { createAgentReviewMediaResolver } from './agentReviewMediaResolver.mjs'
import { createProductionWorkflowSweep } from './productionWorkflowAdvance.mjs'
import { createAgentBranchRetrySweep } from './agentBranchRetrySweep.mjs'
import { createAgentBranchRetryService } from './agentBranchRetryService.mjs'
import { createAgentRunGenerationService } from './agentRunGenerationService.mjs'
import { createSecurityControls } from './securityControls.mjs'
import { createAgentTurnResumer } from './agentTurnResume.mjs'
import { createBotanicAgentTurnRuntime } from './botanicAgentTurnRuntime.mjs'
import { createLocalCancelRegistry } from './localCancelRegistry.mjs'
import { createAgentCancellationService } from './agentCancellationService.mjs'
import { createAgentRunSubmissionSweep } from './agentRunSubmissionSweep.mjs'
import { abortMatchingGenerationJobCancellation } from './generationCancellation.mjs'
import { createGenerationRecoverySweep } from './generationRecoverySweep.mjs'
import { createAgentSubagentQueue, createAgentSubagentWorker } from './agentSubagentQueue.mjs'
import { createAgentSubagentRunner } from './agentSubagentRunner.mjs'
import { createAgentSubagentProjectRegistry } from './agentSubagentRegistry.mjs'
import { createAgentSubagentProcessor } from './agentSubagentProcessor.mjs'
import { createAgentSubagentCancellation } from './agentSubagentCancellation.mjs'
import { createAgentSubagentRecovery } from './agentSubagentRecovery.mjs'
import { createAgentSubagentService } from './agentSubagentService.mjs'
import { createDurableAgentSubagentRunner } from './agentSubagentBroker.mjs'
import { initializeBotanicTelemetry } from './botanicTelemetry.mjs'
import { createAgentContextObserver } from './agentContextObservability.mjs'
import { activeBotanicTraceFields } from './executionTelemetry.mjs'
import { captureException, captureMessage, flushSentry } from './sentry.mjs'

loadLocalEnv()
// 与 API 同一处理：Worker 崩掉的后果更隐蔽 —— 队列还在，任务永远停在 running。
installDatabaseResilience()
const config = runtimeConfig()
const telemetry = initializeBotanicTelemetry(config.telemetry, { logger: console })
const observeAgentContext = createAgentContextObserver()
const observeAgentRun = (event) => {
  const traceFields = activeBotanicTraceFields()
  writeAgentRunOperationalEvent({
    ...event,
    w3cTraceId: traceFields.traceId,
    w3cSpanId: traceFields.spanId,
    traceFlags: traceFields.traceFlags,
  }, console, { semanticLogger: console })
}
if (!config.production) console.warn('Botanic Worker 正在以本地配置运行；生产环境必须使用 PostgreSQL、Redis 与对象存储。')
const runtime = await createProductRuntime(config)
if (!config.redisUrl) throw new Error('REDIS_URL 未配置，Worker 拒绝启动。')
const queue = createGenerationQueue(config.redisUrl)
const subagentQueue = createAgentSubagentQueue(config.redisUrl)
const agentRunEvents = createAgentRunEventPublisher(config.redisUrl)
const canvasRealtimeEvents = createCanvasRealtimeEventPublisher(config.redisUrl, { eventSecret: config.realtimeEventSecret })
const canvasSourceInstanceId = randomUUID()
const reportWorkerOperationalFailure = (caught, tags) => captureException(caught, {
  level: 'warning',
  tags: { component: 'worker', ...tags },
})
async function publishSavedProjectUpdated(saved, actorId, graphCommit) {
  if (graphCommit?.changed && graphCommit.update) {
    try {
      await canvasRealtimeEvents.publishCanvasUpdate({
        eventId: randomUUID(), sourceInstanceId: canvasSourceInstanceId,
        projectId: saved.document.id, update: graphCommit.update,
        mutationId: graphCommit.mutationId, actorId,
        graphRevision: graphCommit.graphRevision, updatedAt: graphCommit.updatedAt,
        ...(graphCommit.duplicate ? { duplicate: true } : {}),
      })
    } catch (caught) {
      reportWorkerOperationalFailure(caught, { subsystem: 'realtime', operation: 'canvas_update' })
      console.error(`[realtime] worker canvas update deferred: ${caught instanceof Error ? caught.message : String(caught)}`)
    }
  }
  try {
    await agentRunEvents.publishProjectUpdated({
      projectId: saved.document.id,
      actorId,
      revision: saved.revision,
      graphRevision: saved.graphRevision,
      updatedAt: saved.document.updatedAt,
      ...(!graphCommit && (saved.syncProtocolEpoch ?? 1) < 2
        ? { graph: { nodes: saved.document.nodes ?? [], edges: saved.document.edges ?? [] } }
        : {}),
    })
  } catch (caught) {
    reportWorkerOperationalFailure(caught, { subsystem: 'realtime', operation: 'project_update' })
    console.error(`[realtime] worker project update deferred: ${caught instanceof Error ? caught.message : String(caught)}`)
  }
}
const providerHealth = createProviderHealthMonitor({
  redisUrl: config.redisUrl,
  failureThreshold: config.providerFailureThreshold,
  cooldownMs: config.providerCircuitCooldownMs,
  onFallback: (caught) => {
    reportWorkerOperationalFailure(caught, { subsystem: 'provider-health', operation: 'redis_fallback' })
    console.error(`[provider-health] Redis unavailable: ${caught instanceof Error ? caught.message : String(caught)}`)
  },
})
// Worker 与 API 是两个进程：API 写下 cancelled 时本进程不会知道，只能等 Provider
// 跑完再丢弃结果。订阅取消频道后就地 abort，Provider 调用真正停下、槽位立刻释放。
const jobCancelRegistry = createLocalCancelRegistry()
const turnCancelRegistry = createLocalCancelRegistry()
let reviewService
const cancelSubscriber = await createAgentRunEventSubscriber(config.redisUrl, () => {}, {
  onCancel: (event) => {
    const logAbort = () => {
      // 记下「用户点取消」到「本地 abort 生效」的间隔：这是取消延迟唯一可观测的口径。
      // 跨进程时间差包含机器间时钟偏移，只用于看分位数趋势，不用于精确归因。
      const latencyMs = typeof event.requestedAt === 'number' ? Date.now() - event.requestedAt : undefined
      console.log(JSON.stringify({
        event: event.scope === 'turn'
          ? 'agent.turn.cancel.aborted'
          : event.scope === 'review' ? 'agent.review.cancel.aborted' : 'generation.cancel.aborted',
        ...(event.scope === 'turn'
          ? { turnId: event.id }
          : event.scope === 'review' ? { reviewTaskId: event.id } : { jobId: event.id }),
        latencyMs,
      }))
    }
    if (event.scope === 'turn') {
      if (turnCancelRegistry.abort(event.id)) logAbort()
      return
    }
    if (event.scope === 'review') {
      if (reviewService?.handleCancellationSignal(event)) logAbort()
      return
    }
    if (event.scope !== 'job') return
    void abortMatchingGenerationJobCancellation({
      productStore: runtime.productStore,
      cancelRegistry: jobCancelRegistry,
      event,
    }).then((aborted) => {
      if (aborted) logAbort()
    }).catch((caught) => {
      reportWorkerOperationalFailure(caught, { subsystem: 'cancellation', operation: 'verify_signal' })
      console.error(`[generation] cancel signal verification deferred: ${caught instanceof Error ? caught.message : String(caught)}`)
    })
  },
})
// 派生任务与生成任务分队列：一类任务堆积不应拖垮另一类。
const derivedQueue = createDerivedTaskQueue(config.redisUrl)
const securityControls = createSecurityControls({
  redisUrl: config.redisUrl,
  onFallback: (caught) => {
    reportWorkerOperationalFailure(caught, { subsystem: 'security', operation: 'redis_fallback' })
    console.error(`[security] Redis unavailable: ${caught instanceof Error ? caught.message : String(caught)}`)
  },
})
const consumeWebResearchQuota = async (userId) => {
  const result = await securityControls.consume({
    scope: 'web-research',
    subject: userId,
    limit: config.security.webResearchPerMinute,
    windowMs: 60_000,
  })
  if (!result.allowed) {
    console.warn(JSON.stringify({
      event: 'security.rate_limited',
      scope: 'web-research',
      retryAfterSeconds: result.retryAfterSeconds,
    }))
  }
  return result
}
// 评审在 Worker 侧执行，不依赖浏览器打开。视觉层的判据全部来自计划快照的质量策略；
// 没配置视觉模型时 judge 为 undefined，语义判据照实记为无法验证而不是默认通过。
const reviewMediaResolver = createAgentReviewMediaResolver(runtime.mediaService)
const reviewVisionJudge = createAgentReviewVisionJudge({
  runtimeConfig: config,
  resolveMedia: reviewMediaResolver,
})
// 项目自定义判据（evaluator Skill）。与内置判据共用同一个视觉模型与取图口径，
// 但 Prompt 与输出形状来自 Skill 自己 —— 复用内置那份会让两类判据互相牵连。
const evaluatorSkillJudge = createEvaluatorSkillRunner({
  runtimeConfig: config,
  resolveMedia: reviewMediaResolver,
})
reviewService = createAgentReviewService({
  productStore: runtime.productStore,
  reviewCandidate: reviewVisionJudge,
  judgeWith: evaluatorSkillJudge,
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
    publishCanvasUpdate: canvasRealtimeEvents.publishCanvasUpdate,
    observeAgentRun,
    providerCircuitBreaker: providerHealth,
    ensureReviewTask: (ownerId, runId) => reviewService.ensureReviewTaskForRun(ownerId, runId),
    enqueueDerivedTask: (kind, dedupeId, payload) => derivedQueue?.enqueue(kind, dedupeId, payload),
    // 业务终态失败在 Worker 内部被捕获落库，不会触发 BullMQ failed 事件；这里显式上报。
    reportWorkerFailure: (failure, context) => captureException(failure, context),
    reportWorkerOutcome: (failure, context) => captureMessage(`generation_provider_${failure.code ?? 'unknown'}`, {
      ...context,
      level: 'warning',
    }),
  }),
})

worker.on('failed', (job, caught) => {
  captureException(caught, { tags: { component: 'generation-worker', job_id: job?.id ?? 'unknown' } })
  console.error(`[generation] BullMQ job ${job?.id ?? 'unknown'} failed: ${caught.message}`)
})
worker.on('error', (caught) => {
  captureException(caught, { tags: { component: 'generation-worker' } })
  console.error(`[generation] BullMQ worker error: ${caught.message}`)
})
console.log(`Botanic generation worker started (concurrency ${config.workerConcurrency})`)

// 新种类要和它的消费者一起加（见 derivedTaskQueue 的种类词表）。
const durableTurnRuntime = createBotanicAgentTurnRuntime({
  productStore: runtime.productStore,
  localCancelRegistry: turnCancelRegistry,
  turnLifetimeMs: config.agentTurnLifetimeMs,
})
let cancelStaleAgentTurn
let durablePlannerSubagentRunner
const resumeSubagentRunner = config.agentSubagentModel && config.flockApiKey
  ? (input) => {
      if (typeof durablePlannerSubagentRunner !== 'function') {
        throw Object.assign(new Error('Durable Subagent 组合尚未就绪。'), {
          code: 'AGENT_SUBAGENT_RUNTIME_UNAVAILABLE',
          statusCode: 503,
        })
      }
      return durablePlannerSubagentRunner(input)
    }
  : undefined
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
    turnRuntime: durableTurnRuntime,
    consumeWebResearchQuota,
    subagentRunner: resumeSubagentRunner,
    observeAgentContext,
    observe: (event) => console.log(JSON.stringify(event)),
  }),
  settleTurn: (turn, error) => durableTurnRuntime.fail({ turn, error }),
  // cancelling 不是可恢复执行。交给深取消编排，统一收口 linked Run / Job。
  cancelTurn: (turn) => cancelStaleAgentTurn(turn),
})
// 工作流推进同样在 Worker 侧：此前只有「有人打开页面」才会对账批量运行的真实状态。
const sweepProductionWorkflows = createProductionWorkflowSweep({
  productStore: runtime.productStore,
  observe: (event) => console.log(JSON.stringify(event)),
})
// 失败分支自动重试：策略在服务端，因此关掉浏览器后仍会按策略重试一次；
// 不可重试错误、高成本重试与预算不足都会停下等用户，并把原因记进日志。
const agentRunGeneration = createAgentRunGenerationService({
  config,
  productStore: runtime.productStore,
  securityControls,
  enqueue: (jobId) => queue.enqueue(jobId),
  publishProjectUpdated: publishSavedProjectUpdated,
  publishAgentRunUpdated: agentRunEvents.publish,
})
const subagentCancellation = createAgentSubagentCancellation({
  productStore: runtime.productStore,
  turnRuntime: durableTurnRuntime,
  publishCancel: agentRunEvents.publishCancel,
  observe: (event) => console.log(JSON.stringify(event)),
})
const agentCancellation = createAgentCancellationService({
  productStore: runtime.productStore,
  cancelTurn: (command) => durableTurnRuntime.cancel(command),
  finalizeTurn: (command) => durableTurnRuntime.finalizeCancellation(command),
  cancelSubagent: (command) => subagentCancellation.request(command),
  redisQueue: queue,
  publishCancel: agentRunEvents.publishCancel,
  modelOptions: config.modelOptions ?? [],
  afterGenerationJobPersist: ({ userId, projectId, job }) => (
    agentRunGeneration.persistJobState(userId, projectId, job)
  ),
})
const subagentRunner = createAgentSubagentRunner({ runtimeConfig: config })
const createWorkerSubagentRegistry = ({ userId, projectId }) => createAgentSubagentProjectRegistry({
  productStore: runtime.productStore,
  config,
  userId,
  projectId,
  consumeWebResearchQuota,
})
const subagentProcessor = subagentRunner
  ? createAgentSubagentProcessor({
      productStore: runtime.productStore,
      turnRuntime: durableTurnRuntime,
      runSubagent: subagentRunner,
      buildRegistry: ({ descriptor }) => createWorkerSubagentRegistry({
        userId: descriptor.ownerId,
        projectId: descriptor.projectId,
      }),
      enqueue: (identity) => subagentQueue.enqueue(identity),
      convergeCancellation: (descriptor) => subagentCancellation.converge(descriptor),
      observe: (event) => console.log(JSON.stringify(event)),
    })
  : undefined
const subagentWorker = subagentProcessor
  ? createAgentSubagentWorker({
      redisUrl: config.redisUrl,
      concurrency: config.agentSubagentConcurrency,
      processActivation: subagentProcessor,
    })
  : undefined
subagentWorker?.on('failed', (job, caught) => {
  captureException(caught, { tags: { component: 'subagent-worker', job_id: job?.id ?? 'unknown' } })
  console.error(`[agent-subagent] BullMQ activation ${job?.id ?? 'unknown'} failed: ${caught.message}`)
})
subagentWorker?.on('error', (caught) => {
  captureException(caught, { tags: { component: 'subagent-worker' } })
  console.error(`[agent-subagent] BullMQ worker error: ${caught.message}`)
})
if (subagentWorker) {
  console.log(`Botanic subagent worker started (concurrency ${config.agentSubagentConcurrency})`)
} else {
  console.log('Botanic subagent worker disabled (AGENT_SUBAGENT_MODEL/FLOCK_API_KEY not configured)')
}
const subagentService = subagentRunner
  ? createAgentSubagentService({
      productStore: runtime.productStore,
      config,
      createRegistry: createWorkerSubagentRegistry,
      dispatchActivation: (identity) => subagentQueue.enqueue(identity),
      cancellation: subagentCancellation,
    })
  : undefined
durablePlannerSubagentRunner = subagentService
  ? createDurableAgentSubagentRunner({ service: subagentService })
  : undefined
// Run 已持久化后、首个 Job 落库前仍有进程崩溃窗口。周期恢复只调用既有幂等提交
// 与深取消服务，不在 Worker 组合根复制 Job 创建或取消规则。
const sweepQueuedAgentRuns = createAgentRunSubmissionSweep({
  productStore: runtime.productStore,
  submitGeneration: (userId, projectId, runId) => (
    agentRunGeneration.submitGeneration(userId, projectId, runId)
  ),
  cancelAgentRun: (input) => agentCancellation.cancelAgentRun(input),
  observe: (event) => console.log(JSON.stringify(event)),
})
cancelStaleAgentTurn = (turn) => agentCancellation.cancelAgentTurn({
  userId: turn.ownerId,
  projectId: turn.projectId,
  turnId: turn.id,
  requestedBy: turn.ownerId,
  reason: 'Agent Turn 取消恢复。',
})
const sweepFailedBranches = createAgentBranchRetrySweep({
  productStore: runtime.productStore,
  retryAgentBranch: createAgentBranchRetryService({
    productStore: runtime.productStore,
    config,
    enqueue: (jobId) => queue.enqueue(jobId),
    securityControls,
    publishProjectUpdated: publishSavedProjectUpdated,
    publishAgentRunUpdated: agentRunEvents.publish,
    agentRunGeneration,
    observeRun: observeAgentRun,
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
    'run.submit': () => sweepQueuedAgentRuns(),
  },
})
derivedWorker.on('failed', (job, caught) => {
  captureException(caught, { tags: { component: 'derived-worker', job_name: job?.name ?? 'unknown' } })
  if (job?.name === 'review.run') {
    const failure = safeAgentReviewWorkerFailure(caught)
    console.error(JSON.stringify({
      event: 'agent.review.worker.failed',
      code: failure.code,
      message: failure.message,
    }))
    return
  }
  console.error(`[derived] ${job?.name ?? 'unknown'} failed: ${caught.message}`)
})
derivedWorker.on('error', (caught) => {
  captureException(caught, { tags: { component: 'derived-worker' } })
  console.error(`[derived] worker error: ${caught.message}`)
})
// 注册幂等：BullMQ 按 repeat key 去重，多实例重复注册不会产生多份定时任务。
for (const [kind, everyMs] of [['turn.reclaim', 60_000], ['review.run', 120_000], ['workflow.advance', 45_000], ['branch.retry', 90_000], ['run.submit', 30_000]]) {
  try {
    await derivedQueue?.scheduleSweep(kind, everyMs)
  } catch (caught) {
    captureException(caught, { tags: { component: 'derived-worker', sweep: kind } })
    await flushSentry()
    console.error(`[derived] ${kind} 清扫注册失败，Worker 退出以便平台重启：${caught instanceof Error ? caught.message : String(caught)}`)
    process.exit(1)
  }
}
console.log('Botanic derived-task worker started (turn.reclaim 60s, review.run 120s, workflow.advance 45s, branch.retry 90s, run.submit 30s)')

const sweepRecoverableGenerationJobs = createGenerationRecoverySweep({
  productStore: runtime.productStore,
  enqueue: (jobId) => queue.enqueue(jobId),
  observe: (event) => console.error(JSON.stringify(event)),
})
async function recoverQueuedJobs() {
  try {
    await sweepRecoverableGenerationJobs()
  } catch (caught) {
    // Worker 后续会周期性重试；短暂的恢复查询失败不能造成进程反复重启或遗留队列任务。
    reportWorkerOperationalFailure(caught, { subsystem: 'generation', operation: 'recovery' })
    console.error(`[generation] worker recovery deferred: ${caught instanceof Error ? caught.message : String(caught)}`)
  }
}
// 恢复查询或 Redis 重投递不能阻塞 Worker 自身启动，否则新任务也无法被消费。
void recoverQueuedJobs()
const recoveryTimer = setInterval(() => void recoverQueuedJobs(), 30_000)
recoveryTimer.unref()

async function reclaimInterruptedJobs() {
  try {
    const staleAfterMs = Math.max(30_000, Number(config.generationExecutionLeaseMs) || 120_000)
    const stale = await runtime.productStore.recoverStaleGenerationJobs?.(staleAfterMs)
    for (const job of stale ?? []) {
      if (await queue.reclaimStaleActive(job.id)) console.warn(`[generation] ${job.id} reclaimed after interrupted worker`)
    }
  } catch (caught) {
    reportWorkerOperationalFailure(caught, { subsystem: 'generation', operation: 'stale_recovery' })
    console.error(`[generation] stale recovery deferred: ${caught instanceof Error ? caught.message : String(caught)}`)
  }
}
// BullMQ lock 精确检查 + DB lease 共同判定；周期执行，覆盖「Worker 启动时租约尚
// 未过期、随后才成为 stalled」的窗口。单次启动清扫会永久漏掉这一类 Job。
void reclaimInterruptedJobs()
const interruptedRecoveryTimer = setInterval(() => void reclaimInterruptedJobs(), 60_000)
interruptedRecoveryTimer.unref()

const recoverAgentSubagents = subagentProcessor
  ? createAgentSubagentRecovery({
      productStore: runtime.productStore,
      enqueue: (identity) => subagentQueue.enqueue(identity),
      observe: (event) => console.error(JSON.stringify(event)),
    })
  : undefined
async function recoverQueuedAgentSubagents() {
  if (!recoverAgentSubagents) return
  try {
    await recoverAgentSubagents()
  } catch (caught) {
    reportWorkerOperationalFailure(caught, { subsystem: 'agent-subagent', operation: 'recovery' })
    console.error(`[agent-subagent] worker recovery deferred: ${caught instanceof Error ? caught.message : String(caught)}`)
  }
}
void recoverQueuedAgentSubagents()
const subagentRecoveryTimer = recoverAgentSubagents
  ? setInterval(() => void recoverQueuedAgentSubagents(), 30_000)
  : undefined
subagentRecoveryTimer?.unref()

async function shutdown() {
  clearInterval(recoveryTimer)
  clearInterval(interruptedRecoveryTimer)
  if (subagentRecoveryTimer) clearInterval(subagentRecoveryTimer)
  await cancelSubscriber?.close()
  await derivedWorker.close(true)
  await derivedQueue?.close()
  // 供应商或对象流异常时，默认 close 会一直等待 active job，导致部署后旧容器
  // 仍持有 Redis lock、新 Worker 无法接手。强制关闭后 BullMQ 会将该 job 作为
  // stalled 回收，配合 90 秒 stale-running 恢复逻辑重新执行。
  await worker.close(true)
  await subagentWorker?.close(true)
  await queue.close()
  await subagentQueue.close()
  await agentRunEvents.close()
  await canvasRealtimeEvents.close()
  await providerHealth.close()
  await runtime.mediaService.close()
  await runtime.productStore.close?.()
  await telemetry.shutdown().catch(() => undefined)
  await flushSentry(2_000).catch(() => undefined)
}
process.once('SIGTERM', () => void shutdown().then(() => process.exit(0)))
process.once('SIGINT', () => void shutdown().then(() => process.exit(0)))
