import { createHash, randomUUID } from 'node:crypto'
import { GenerationError, persistedGenerationJob, resolveGenerationInputMedia, validateGenerationInput } from './generationProvider.mjs'
import { assertAgentReferenceBindings } from './agentTargetBinding.mjs'
import { generationTimeoutForModel } from './generationModels.mjs'
import { providerForModel } from './generationModels.mjs'
import { generateMedia } from './generationService.mjs'
import { publicAgentRun } from './botanicAgentRun.mjs'
import { reconcileAgentGenerationJobToProject } from './botanicAgentExecution.mjs'
import { compatibleFallbackModel, ProviderCircuitBreaker } from './generationGovernance.mjs'
import { cancelGenerationJob } from './generationCancellation.mjs'
import { matchingIdempotencyRequestBinding } from './idempotencyRequestBinding.mjs'
import { acquireGenerationProviderAdmission } from './generationProviderAdmission.mjs'
import { compareAndSetGenerationJob } from './generationJobCas.mjs'

export function createGenerationProcessor({
  productStore,
  mediaService,
  config,
  publishAgentRunUpdated,
  publishProjectUpdated,
  observeAgentRun = () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  providerCircuitBreaker = new ProviderCircuitBreaker({
    failureThreshold: config.providerFailureThreshold,
    cooldownMs: config.providerCircuitCooldownMs,
  }),
  generate = generateMedia,
  // 本进程正在执行的任务的中止句柄。跨实例取消信号抵达后据此就地 abort。
  cancelRegistry,
  // 评审是派生工作，只在 Run 到终态时请求一次；缺注入时不评审，也不影响生成。
  ensureReviewTask,
  enqueueDerivedTask,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  leaseTokenFactory = randomUUID,
  acquireProviderAdmission = acquireGenerationProviderAdmission,
}) {
  function resolvedInputProvenance(provenance, input) {
    if (!provenance) return provenance
    const withHash = (entry, resolved) => ({
      ...entry,
      ...(resolved?.buffer?.length
        ? { mediaSha256: createHash('sha256').update(resolved.buffer).digest('hex') }
        : {}),
    })
    return {
      references: (provenance.references ?? []).map((entry, index) => withHash(entry, input.references[index])),
      ...(provenance.parent ? { parent: withHash(provenance.parent, input.parent) } : {}),
    }
  }

  async function recordLateOutputs(job, outputs, reason, executionFence) {
    if (!Array.isArray(outputs) || !outputs.length) return job
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const latest = await productStore.readGenerationJobForWorker(job.id)
      if (!latest || !['cancelled', 'failed'].includes(latest.status)
        || Number(latest.execution?.generation) !== Number(executionFence?.generation)) return latest
      const byId = new Map((latest.lateOutputs ?? []).map((output) => [output.id, output]))
      for (const output of outputs) {
        if (!output?.id || !output?.image) continue
        byId.set(output.id, {
          ...output,
          reason,
          executionGeneration: Number(executionFence.generation),
          recordedAt: Date.now(),
        })
      }
      const decision = await compareAndSetGenerationJob(productStore, latest.ownerId, latest, {
        ...latest,
        lateOutputs: [...byId.values()],
        updatedAt: Date.now(),
      }, { updateAgentRun: false })
      if (decision?.changed) return decision.job
    }
    return productStore.readGenerationJobForWorker(job.id)
  }

  class GenerationJobExecutionLost extends Error {
    constructor(job) {
      super(`Generation Job ${job?.id ?? ''} 的执行租约已失效。`)
      this.name = 'GenerationJobExecutionLost'
      this.code = 'GENERATION_JOB_LEASE_STALE'
      this.job = job
    }
  }

  function executionCommand(job, options = {}, fence = job?.execution) {
    if (!fence?.leaseToken || !Number.isInteger(Number(fence.generation))) {
      throw new GenerationJobExecutionLost(job)
    }
    return {
      id: job.id,
      projectId: job.projectId,
      leaseToken: fence.leaseToken,
      executionGeneration: Number(fence.generation),
      status: job.status,
      job: persistedGenerationJob(job),
      updateAgentRun: options.updateAgentRun !== false,
      recordAudit: options.recordAudit !== false,
    }
  }

  async function commitExecutionJob(job, options = {}, fence = job?.execution) {
    if (typeof productStore.commitGenerationJobExecution !== 'function') {
      throw new TypeError('ProductStore 缺少 Generation Job fenced commit 能力。')
    }
    const decision = await productStore.commitGenerationJobExecution(job.ownerId, executionCommand(job, options, fence))
    if (!decision?.changed || decision.kind !== 'committed') {
      throw new GenerationJobExecutionLost(decision?.job ?? job)
    }
    return decision.job
  }

  async function heartbeatExecution(job, fence = job?.execution) {
    if (!fence?.leaseToken || !Number.isInteger(Number(fence.generation))) {
      throw new GenerationJobExecutionLost(job)
    }
    let decision = await productStore.commitGenerationJobExecution(job.ownerId, {
      id: job.id,
      projectId: job.projectId,
      leaseToken: fence.leaseToken,
      executionGeneration: Number(fence.generation),
      status: job.status === 'cancelled' ? 'cancelled' : 'running',
      ...(job.status === 'cancelled' && job.cancel?.signalId
        ? { signalId: job.cancel.signalId }
        : {}),
      updateAgentRun: false,
      recordAudit: false,
    })
    // 取消可能恰好落在 running heartbeat 的锁内。第一次返回只提供 durable
    // signal，不能续租；原 Worker 随即用同一 immutable fence + signal 再提交。
    if (decision?.kind === 'cancellation_required'
      && decision.job?.cancel?.signalRequired === true
      && decision.job.cancel.signalId) {
      decision = await productStore.commitGenerationJobExecution(job.ownerId, {
        id: job.id,
        projectId: job.projectId,
        leaseToken: fence.leaseToken,
        executionGeneration: Number(fence.generation),
        status: 'cancelled',
        signalId: decision.job.cancel.signalId,
        updateAgentRun: false,
        recordAudit: false,
      })
    }
    if (!decision?.changed
      || !['committed', 'cancellation_heartbeat'].includes(decision.kind)) {
      throw new GenerationJobExecutionLost(decision?.job ?? job)
    }
    return decision.job
  }

  async function acknowledgeWorkerExit(jobId, fence) {
    if (typeof productStore.acknowledgeGenerationJobCancellation !== 'function') return
    try {
      const latest = await productStore.readGenerationJobForWorker(jobId)
      if (latest?.status !== 'cancelled'
        || latest.cancel?.signalRequired !== true
        || typeof latest.cancel?.signalId !== 'string'
        || Number(latest.cancel?.signalAcknowledgedAt) > 0
        || Number(latest.execution?.generation) !== Number(fence?.generation)) return
      await productStore.acknowledgeGenerationJobCancellation(latest.ownerId, {
        id: latest.id,
        projectId: latest.projectId,
        signalId: latest.cancel.signalId,
        executionGeneration: Number(fence.generation),
        leaseToken: fence.leaseToken,
        releaseBasis: 'worker_exit',
      })
    } catch (caught) {
      // Job 已经是 cancelled；ack 是可恢复的释放证明。失败时保留 pending，Turn
      // sweep 会按同一 signalId 重发，绝不能让 BullMQ 因 ack 旁路故障重跑 Provider。
      console.error(`[generation] cancellation acknowledgement deferred for ${jobId}: ${caught instanceof Error ? caught.message : String(caught)}`)
    }
  }
  const observeRun = (job, event) => {
    if (!job.agentRun) return
    try {
      observeAgentRun({
        ...event,
        projectId: job.projectId,
        runId: job.agentRun.runId,
        branchId: job.agentRun.branchId,
        jobId: job.id,
      })
    } catch { /* 可观测性不得改变任务状态。 */ }
  }
  async function writeJobToProject(job) {
    const maxAttempts = 5
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const project = await productStore.readProject(job.ownerId, job.projectId)
      if (!project) return true
      const reconciled = reconcileAgentGenerationJobToProject(project.document, job)
      if (job.agentRun && job.status === 'succeeded' && job.outputs?.length && reconciled.complete === false) {
        throw new Error('Agent 结果尚未完成画布投影。')
      }
      if (!reconciled.changed) return true
      try {
        const saved = await productStore.writeProject(job.ownerId, reconciled.document, project.revision, project.graphRevision)
        await publishProjectUpdate(job, saved ?? {
          document: reconciled.document,
          revision: project.revision,
          graphRevision: project.graphRevision,
        })
        return true
      } catch (caught) {
        if (caught?.code !== 'PROJECT_CONFLICT' && caught?.code !== 'CANVAS_GRAPH_CONFLICT') throw caught
        if (attempt + 1 < maxAttempts) await sleep(Math.min(2_000, 100 * (2 ** attempt)))
      }
    }
    throw new Error('Agent 结果回写连续发生画布冲突。')
  }

  async function writeJobToProjectSafely(job, { markPending = false } = {}) {
    try {
      await writeJobToProject(job)
      return true
    } catch (caught) {
      console.error(`[generation] project writeback deferred: ${caught instanceof Error ? caught.message : String(caught)}`)
      if (markPending) {
        await markProjectWritebackPending(job, caught instanceof Error ? caught.message : String(caught))
      }
      return false
    }
  }

  async function markProjectWritebackPending(job, errorMessage) {
    const pending = {
      ...job,
      projectWritebackPending: true,
      projectWritebackAttempts: (job.projectWritebackAttempts ?? 0) + 1,
      projectWritebackError: errorMessage,
      projectWritebackUpdatedAt: Date.now(),
      updatedAt: Date.now(),
    }
    try {
      // 画布或 Artifact 尚未回写时不能把 Agent Run 推进到终态；否则前端会在产出落盘前
      // 收到 completed/failed，并过早执行一次恢复。
      if (pending.execution) {
        return await commitExecutionJob(pending, { updateAgentRun: false, recordAudit: false })
      }
      // 部署前已进入终态的 legacy Job 没有 execution；只允许它补偿画布写回，
      // 新执行路径一律经过 generation + leaseToken fence。
      await productStore.putGenerationJob(pending.ownerId, persistedGenerationJob(pending), { updateAgentRun: false, recordAudit: false })
    } catch (persistError) {
      console.error(`[generation] project writeback marker deferred: ${persistError instanceof Error ? persistError.message : String(persistError)}`)
    }
    return pending
  }

  async function clearProjectWriteback(job) {
    if (!job.projectWritebackPending) return job
    // 先让 Run 观察到仍带 pending 的终态，再单独清补偿标记。Supabase 的 Job RPC
    // 与 Run 投影不在同一事务；若进程在二者之间退出，pending 仍会把任务捞回恢复器。
    let projected = job
    if (job.execution) {
      projected = await commitExecutionJob(
        { ...job, updatedAt: Date.now() },
        { updateAgentRun: true },
        job.execution,
      )
    } else {
      projected = await productStore.putGenerationJob(
        job.ownerId,
        persistedGenerationJob({ ...job, updatedAt: Date.now() }),
        { updateAgentRun: true },
      ) ?? job
    }
    const cleared = {
      ...projected,
      projectWritebackPending: undefined,
      projectWritebackAttempts: undefined,
      projectWritebackError: undefined,
      projectWritebackUpdatedAt: undefined,
      updatedAt: Date.now(),
    }
    if (cleared.execution) {
      return commitExecutionJob(
        cleared,
        { updateAgentRun: false, recordAudit: false },
        projected.execution,
      )
    }
    return await productStore.putGenerationJob(
      cleared.ownerId,
      persistedGenerationJob(cleared),
      { updateAgentRun: false, recordAudit: false },
    ) ?? cleared
  }

  async function finalizeProjectWriteback(job) {
    try {
      return { job: await clearProjectWriteback(job), ready: true }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      console.error(`[generation] Agent Run projection deferred: ${message}`)
      return { job: await markProjectWritebackPending(job, message), ready: false }
    }
  }

  async function publishRun(job) {
    if (!job.agentRun || !publishAgentRunUpdated) return
    try {
      const run = await productStore.readAgentRunForWorker(job.agentRun.runId)
      if (!run) return
      await publishAgentRunUpdated({ projectId: run.projectId, run: publicAgentRun(run) })
      await requestReviewForTerminalRun(run)
    } catch (caught) {
      console.error(`[agent-run] progress publish deferred: ${caught instanceof Error ? caught.message : String(caught)}`)
    }
  }

  /**
   * Run 一到执行终态就请求评审（ADR 0006）。
   *
   * 评审是派生工作：入队失败只记日志，不能影响这次生成的落库结果，Run 的执行终态
   * 也不等待评审完成。真正漏掉的任务由 `review.run` 周期清扫兜底。
   */
  async function requestReviewForTerminalRun(run) {
    if (!enqueueDerivedTask || !['completed', 'partial'].includes(run.status)) return
    try {
      const task = await ensureReviewTask?.(run.ownerId, run.id)
      if (task) await enqueueDerivedTask('review.run', task.id, { taskId: task.id, ownerId: run.ownerId })
    } catch (caught) {
      console.error(`[agent-review] enqueue deferred: ${caught instanceof Error ? caught.message : String(caught)}`)
    }
  }

  async function publishProjectUpdate(job, saved) {
    if (!publishProjectUpdated || !saved?.document?.id) return
    try {
      await publishProjectUpdated({
        projectId: saved.document.id,
        actorId: job.ownerId,
        revision: saved.revision,
        graphRevision: saved.graphRevision,
        updatedAt: saved.document.updatedAt,
        graph: { nodes: saved.document.nodes ?? [], edges: saved.document.edges ?? [] },
      })
    } catch (caught) {
      // 项目已写入；实时通知只是可恢复旁路，客户端会在事件重连或聚焦时重新读取。
      console.error(`[realtime] generation project update deferred: ${caught instanceof Error ? caught.message : String(caught)}`)
    }
  }

  async function refreshGenerationArtifacts(job) {
    if (typeof productStore.refreshGenerationArtifacts !== 'function') return false
    try {
      const refreshed = await productStore.refreshGenerationArtifacts(job.ownerId, job.id)
      if (refreshed === false) return false
      return typeof refreshed === 'object' && refreshed?.status
        ? refreshed.status === 'passed'
        : true
    } catch (caught) {
      // Artifact Index 是可重建的历史目录；索引补偿失败时保留恢复标记，
      // 不能让 Agent Run 在历史目录尚未可读时提前进入 completed。
      console.error(`[artifact-index] generation refresh deferred: ${caught instanceof Error ? caught.message : String(caught)}`)
      return false
    }
  }

  /**
   * Generation Job 入队与 Worker 取任务之间可能跨进程崩溃。因此不能只信任
   * 提交层的事前检查；对 Agent Run 关联任务，Worker 自己在接单和 Provider
   * 调用前各复读一次 durable Turn / Run fence。
   */
  async function delegationBlock(job) {
    if (!job.agentRun) return undefined
    if (typeof productStore.readAgentRunForWorker !== 'function') {
      throw new TypeError('Agent Generation Worker 缺少 Run 权威读取能力。')
    }
    const run = await productStore.readAgentRunForWorker(job.agentRun.runId)
    if (!run || run.projectId !== job.projectId || run.ownerId !== job.ownerId) {
      return { code: 'AGENT_RUN_NOT_FOUND', message: '关联 Agent Run 不存在或已越界。' }
    }
    if (run.status === 'cancelled' || run.status === 'failed') {
      return { code: 'AGENT_RUN_DELEGATION_CANCELLED', message: 'Agent Run 已终止。' }
    }
    const branch = run.branches?.find((candidate) => candidate.id === job.agentRun.branchId)
    if (!branch || branch.activeJobId !== job.id) {
      return { code: 'AGENT_BRANCH_EXECUTION_STALE', message: '该任务已不是 Agent 分支的活动执行实例。' }
    }
    if (Number.isInteger(job.agentRun.attempt)) {
      if (Number(branch.attempt) !== job.agentRun.attempt) {
        return { code: 'AGENT_BRANCH_EXECUTION_STALE', message: '该任务的 Agent 分支执行世代已失效。' }
      }
      if (job.agentRun.attempt > 0 && (!branch.retryClaim
        || branch.retryClaim.jobId !== job.id
        || branch.retryClaim.sourceAttempt !== job.agentRun.attempt - 1
        || !matchingIdempotencyRequestBinding(
          branch.retryClaim.idempotencyBinding,
          job.idempotencyBinding,
        ))) {
        return { code: 'AGENT_BRANCH_EXECUTION_STALE', message: '该重试任务缺少权威执行身份。' }
      }
    }
    if (!run.turnId) return undefined
    if (typeof productStore.readAgentTurn !== 'function') {
      throw new TypeError('Agent Generation Worker 缺少 Turn 权威读取能力。')
    }
    const turn = await productStore.readAgentTurn(job.ownerId, run.turnId)
    if (!turn || turn.projectId !== job.projectId || turn.status !== 'completed') {
      return {
        code: ['cancelling', 'cancelled'].includes(turn?.status)
          ? 'AGENT_TURN_DELEGATION_CANCELLED'
          : 'AGENT_TURN_DELEGATION_NOT_READY',
        message: '关联 Agent Turn 未处于可执行终态。',
      }
    }
    return undefined
  }

  async function stopFencedDelegation(job) {
    const block = await delegationBlock(job)
    if (!block) return false
    const latest = await productStore.readGenerationJobForWorker(job.id)
    if (!latest || ['cancelled', 'succeeded', 'failed'].includes(latest.status)) return true
    const cancelled = await cancelGenerationJob({
      productStore,
      modelOptions: config.modelOptions ?? [],
      ownerId: latest.ownerId,
      job: latest,
      reason: 'agent-run',
      requestedBy: latest.ownerId,
    })
    await writeJobToProjectSafely(cancelled.job)
    await publishRun(cancelled.job)
    observeRun(cancelled.job, { type: 'worker_delegation_fenced', status: 'cancelled', code: block.code })
    return true
  }

  return async function processGenerationJob(jobId) {
    const stored = await productStore.readGenerationJobForWorker(jobId)
    if (!stored) return
    // 终态任务只在画布回写待处理时重新入队；不会再次调用真实 Provider。
    if (stored.projectWritebackPending) {
      let recoveryJob = stored
      if (stored.execution) {
        const recoveryFence = Object.freeze({
          leaseToken: stored.execution.leaseToken,
          generation: Number(stored.execution.generation),
        })
        try {
          // 恢复 Worker 也必须先证明这仍是自己观察到的终态 generation，才能把
          // 旧输出投影到 Canvas/Artifact。显式 retry 清掉 lease 后，迟到恢复在此止步。
          recoveryJob = await commitExecutionJob(
            stored,
            { updateAgentRun: false, recordAudit: false },
            recoveryFence,
          )
        } catch (caught) {
          if (caught instanceof GenerationJobExecutionLost) return
          throw caught
        }
      }
      const recovered = await writeJobToProjectSafely(recoveryJob)
      if (!recovered) {
        await publishRun(recoveryJob)
        return
      }
      // 失败任务也可能已产生部分输出；它们同样属于历史 Artifact 血缘，恢复时
      // 必须先补齐索引，才能清 pending 并把关联 Run 推进到 failed。
      if (recoveryJob.outputs?.length) {
        const artifactReady = await refreshGenerationArtifacts(recoveryJob)
        if (recoveryJob.agentRun && !artifactReady) {
          const pending = await markProjectWritebackPending(recoveryJob, 'Artifact Index 尚未完成回写。')
          await publishRun(pending)
          return
        }
      }
      const finalized = await finalizeProjectWriteback(recoveryJob)
      await publishRun(finalized.job)
      return
    }
    if (['cancelled', 'succeeded', 'failed'].includes(stored.status)) return
    // 恢复队列可能拿到「Job 已落库，提交进程在后置 fence 前崩溃」的孤儿。
    // 先收口 durable 状态，绝不让它因 Worker 恢复而穿透到 Provider。
    if (await stopFencedDelegation(stored)) return
    if (typeof productStore.claimGenerationJobExecution !== 'function') {
      throw new TypeError('ProductStore 缺少 Generation Job 原子 claim 能力。')
    }
    const leaseDurationMs = Math.max(30_000, Math.min(
      Number(config.generationExecutionLeaseMs) || 120_000,
      900_000,
    ))
    const claim = await productStore.claimGenerationJobExecution(jobId, {
      leaseToken: leaseTokenFactory(),
      leaseDurationMs,
      allowTakeover: true,
    })
    if (claim?.kind !== 'claimed' || claim.changed !== true) return
    // 权限来自 claim 返回的不可变 fence。后续 read 只提供数据基线；若把 latest.execution
    // 当权限，旧 Worker 会在 takeover 后“捡到”新 token 并污染新执行者。
    const executionFence = Object.freeze({
      leaseToken: claim.job.execution?.leaseToken,
      generation: Number(claim.job.execution?.generation),
    })
    console.info(`[generation] ${jobId} started`)
    const controller = new AbortController()
    if (cancelRegistry && !cancelRegistry.register(jobId, controller)) {
      // DB 已把过期 lease 接管给当前 generation，但旧 Provider 可能仍忽略 AbortSignal
      // 并占着本实例句柄。先中止旧执行；当前 generation 不与它并跑，也不伪造终态
      // 或 worker-exit ack，保留 running lease 供到期后的 recovery 安全接管。
      cancelRegistry.abort(jobId)
      return
    }
    const initialVariants = Array.from({ length: claim.job.batchCount }, (_, index) => {
      const previous = claim.job.variants?.find((variant) => variant.index === index)
      return previous ?? { index, status: 'queued' }
    })
    let running
    try {
      running = await commitExecutionJob({
        ...claim.job,
        status: 'running',
        error: undefined,
        variants: initialVariants,
        updatedAt: Date.now(),
      }, {}, executionFence)
    } catch (caught) {
      cancelRegistry?.release(jobId, controller)
      await acknowledgeWorkerExit(jobId, executionFence)
      if (caught instanceof GenerationJobExecutionLost) return
      throw caught
    }
    await writeJobToProjectSafely(running)
    await publishRun(running)
    observeRun(running, { type: 'worker_started', status: 'running', queueDurationMs: Math.max(0, running.updatedAt - running.createdAt) })
    let leaseLost = false
    let heartbeatWrite = Promise.resolve()
    const maintainLease = () => {
      heartbeatWrite = heartbeatWrite.then(async () => {
        if (leaseLost) return
        const renewed = await heartbeatExecution(running, executionFence)
        if (renewed.status === 'cancelled' && renewed.cancel?.signalRequired === true) {
          running = renewed
          controller.abort()
          return
        }
        if (renewed.status !== 'running') throw new GenerationJobExecutionLost(renewed)
        running = renewed
      }).catch((caught) => {
        leaseLost = true
        controller.abort()
        observeRun(running, { type: 'worker_lease_lost', status: 'cancelled', code: caught?.code ?? 'GENERATION_JOB_LEASE_STALE' })
      })
      return heartbeatWrite
    }
    const heartbeatMs = Math.max(1_000, Math.min(
      Number(config.generationExecutionHeartbeatMs) || Math.floor(leaseDurationMs / 3),
      Math.max(1_000, Math.floor(leaseDurationMs / 2)),
    ))
    const heartbeatId = setIntervalFn(() => { void maintainLease() }, heartbeatMs)
    let variantWrite = Promise.resolve()
    let releaseProviderAdmission = () => undefined
    let admittedProvider
    let timeoutId
    let timedOut = false
    try {
      const maximumTaskDurationMs = generationTimeoutForModel(config.modelOptions ?? [], running.settings?.model, {
        imageTimeoutMs: config.generationTimeoutMs ?? 5 * 60_000,
        videoTimeoutMs: config.videoGenerationTimeoutMs ?? 20 * 60_000,
      })
      const remainingTaskDurationMs = maximumTaskDurationMs - (Date.now() - running.createdAt)
      if (remainingTaskDurationMs <= 0) {
        throw new GenerationError(504, 'PROVIDER_TIMEOUT', '生成任务超过模型等待时限，已停止，请稍后重试。')
      }
      timeoutId = setTimeout(() => { timedOut = true; controller.abort() }, remainingTaskDurationMs)
      const catalog = config.modelOptions ?? []
      const primaryProvider = providerForModel(catalog, running.settings?.model)?.provider ?? running.provider ?? 'unknown'
      const switchProviderAdmission = async (provider) => {
        // 一旦物化阶段取得 Flock 高内存许可，本任务就持有到最外层 finally。
        // Flock 失败后切到其他 Provider 时 input Buffer 仍存活，提前释放会让随后
        // 多个 Flock 任务再次物化，重新放大到 workerConcurrency × 48MB。
        if (admittedProvider === 'flock' || provider !== 'flock') return
        releaseProviderAdmission = await acquireProviderAdmission({
          providers: [provider],
          signal: controller.signal,
        })
        admittedProvider = provider
      }
      const materializeInput = async () => {
        const validatedInput = validateGenerationInput(running.rawInput, {
          models: config.modelOptions?.length ? config.modelOptions : config.models,
          maximumBatchCount: config.maximumBatchCount,
          maximumReferenceBytes: config.maximumReferenceBytes,
        })
        return resolveGenerationInputMedia(validatedInput, async (mediaId) => {
          if (controller.signal.aborted) throw controller.signal.reason ?? new Error('Generation input aborted')
          try {
            return await mediaService.readGenerationInput(running.ownerId, mediaId, running.projectId, {
              signal: controller.signal,
            })
          } catch (caught) {
            if (caught?.code === 'MEDIA_VALIDATION_FAILED') {
              throw new GenerationError(413, 'REFERENCE_TOO_LARGE', caught.message)
            }
            throw caught
          }
        })
      }
      // Flock 许可先于 validate：内联 dataUrl 会在校验阶段解码成 Buffer，mediaId
      // 则在 resolve 阶段读取。只为本次实际 Provider 取锁，不能因全局 fallback 配置
      // 把无关 OpenAI / MiniMax 任务也串行化。
      try {
        await switchProviderAdmission(primaryProvider)
      } catch (caught) {
        if (timedOut) throw new GenerationError(504, 'PROVIDER_TIMEOUT', '生成任务超过模型等待时限，已停止，请稍后重试。')
        if (controller.signal.aborted) return
        throw caught
      }
      let input = await materializeInput()
      const expectedReferenceBindings = running.referenceBindings ?? running.rawInput?.recipe?.referenceBindings
      if (running.agentRun && Array.isArray(expectedReferenceBindings)) {
        try {
          await assertAgentReferenceBindings(expectedReferenceBindings, input.references)
        } catch (caught) {
          throw new GenerationError(
            caught?.statusCode ?? 409,
            caught?.code ?? 'AGENT_PLAN_REFERENCE_DRIFT',
            caught?.message ?? '确认时使用的参考素材内容已发生变化，请重新确认这次生成。',
          )
        }
      }
      const materializedProvenance = resolvedInputProvenance(running.inputProvenance, input)
      if (materializedProvenance) {
        running = await commitExecutionJob({
          ...running,
          inputProvenance: materializedProvenance,
          updatedAt: Date.now(),
        }, { updateAgentRun: false, recordAudit: false }, executionFence)
      }
      console.info(`[generation] ${jobId} references ready`)
      const remainingGenerationMs = maximumTaskDurationMs - (Date.now() - running.createdAt)
      if (remainingGenerationMs <= 0) {
        throw new GenerationError(504, 'PROVIDER_TIMEOUT', '生成任务超过模型等待时限，已停止，请稍后重试。')
      }
      // 从任务创建开始计时，而非从 Worker 取到任务后重新计时，排队不会无限延长用户等待。
      // 记下是哪一种 abort。取消与超时都会 abort 同一个控制器，但结果完全不同：
      // 超时是失败，取消不是 —— 把取消报成超时会让用户看到错误的原因，而且会用
      // 失败状态覆盖取消入口已经写下的 cancelled。
      // Provider 回调可能由多个子任务同时触发，串行化状态写入避免最后完成的
      // 子任务覆盖其他子任务的进度。图片请求本身仍保持受控并发。
      const onVariant = (update) => {
        variantWrite = variantWrite.then(async () => {
          const latest = await productStore.readGenerationJobForWorker(jobId)
          // timeout/cancel/CAS 已经作出的任何终态承诺都不可被迟到的 Provider
          // variant 回调继续修改；部分输出只在当前 execution 仍 running 时归并。
          if (!latest || latest.status !== 'running') return
          const variants = Array.from({ length: latest.batchCount }, (_, index) => {
            const previous = latest.variants?.find((variant) => variant.index === index)
            return previous ?? { index, status: 'queued' }
          })
          const current = variants[update.index] ?? { index: update.index, status: 'queued' }
          variants[update.index] = {
            ...current,
            status: update.status,
            ...(update.status === 'running' && !current.startedAt ? { startedAt: Date.now() } : {}),
            ...(update.status === 'succeeded' ? { output: update.output, error: undefined, completedAt: Date.now() } : {}),
            ...(update.status === 'failed' ? { error: update.error, completedAt: Date.now() } : {}),
          }
          const outputs = variants
            .filter((variant) => variant.status === 'succeeded' && variant.output)
            .sort((left, right) => left.index - right.index)
            .map((variant) => variant.output)
          const next = {
            ...latest,
            variants,
            outputs,
            outputCount: outputs.length,
            missingOutputCount: Math.max(0, latest.batchCount - outputs.length),
            updatedAt: Date.now(),
          }
          try {
            const committed = await commitExecutionJob(next, {}, executionFence)
            await publishRun(committed)
          } catch (caught) {
            if (caught instanceof GenerationJobExecutionLost) {
              leaseLost = true
              controller.abort()
              return
            }
            throw caught
          }
        })
        return variantWrite
      }
      let result
      try {
        // 注册本地 abort 句柄后再复读一次。检查之后到达的取消，要么在这里
        // durable 收口，要么由随后的跨进程 cancel signal 中止 Provider。
        if (await stopFencedDelegation(running)) return
        await maintainLease()
        if (leaseLost) return
        console.info(`[generation] ${jobId} requesting provider`)
        const model = providerForModel(config.modelOptions ?? [], input.settings.model)
        const provider = model?.provider ?? running.provider ?? 'unknown'
        const runProvider = async (effectiveInput, effectiveModel, effectiveProvider) => {
          const latestJob = await productStore.readGenerationJobForWorker(jobId)
          const attempt = {
            provider: effectiveProvider,
            model: effectiveModel,
            startedAt: Date.now(),
          }
          const attempted = await commitExecutionJob({
            ...latestJob,
            effectiveModel,
            usage: latestJob.usage ? {
              ...latestJob.usage,
              model: effectiveModel,
              provider: effectiveProvider,
            } : latestJob.usage,
            providerAttempts: [...(latestJob.providerAttempts ?? []), attempt],
            updatedAt: Date.now(),
          }, {}, executionFence)
          running = attempted
          if (leaseLost || controller.signal.aborted) throw new GenerationJobExecutionLost(attempted)
          // Provider attempt 记录本身也是一次 await；在它与上一轮 delegation check 之间，
          // 另一重试可能已原子切换 Branch active identity。花钱前最后复读一次 Run。
          if (await stopFencedDelegation(attempted)) throw new GenerationJobExecutionLost(attempted)
          try {
            const generated = await generate(effectiveInput, {
              config,
              jobId,
              signal: controller.signal,
              persistImage: (image) => mediaService.persistProviderImage({ ownerId: running.ownerId, projectId: running.projectId, image }),
              persistMedia: (media) => mediaService.persistProviderMedia({ ownerId: running.ownerId, projectId: running.projectId, media }),
              onVariant,
              completedVariants: running.variants,
            })
            await providerCircuitBreaker.recordSuccess(effectiveProvider)
            return generated
          } catch (caught) {
            await providerCircuitBreaker.recordFailure(effectiveProvider, caught)
            throw caught
          }
        }
        const fallback = () => compatibleFallbackModel({
          catalog: config.modelOptions ?? [],
          input,
          candidateIds: config.providerFallbackModelIds ?? [],
        })
        const prepareFallbackInput = async (alternate) => {
          if (alternate.provider === 'flock' && admittedProvider !== 'flock') {
            // 主 Provider 失败后才决定切到 Flock。先放掉旧 Buffer 引用，再排队取得
            // 许可并重新物化，避免多个 fallback 任务各持 48MB 输入等待同一把锁。
            input = undefined
            await switchProviderAdmission('flock')
            if (controller.signal.aborted) throw new GenerationJobExecutionLost(running)
            input = await materializeInput()
            console.info(`[generation] ${jobId} references ready for flock fallback`)
          } else {
            await switchProviderAdmission(alternate.provider)
          }
          return { ...input, settings: { ...input.settings, model: alternate.id } }
        }
        const providerDecision = await providerCircuitBreaker.canRequest(provider)
        if (!providerDecision.allowed) {
          const alternate = fallback()
          if (!alternate) throw new GenerationError(503, 'PROVIDER_CIRCUIT_OPEN', '当前生成服务暂不可用，且没有语义兼容的备用模型，请稍后重试。')
          const fallbackInput = await prepareFallbackInput(alternate)
          result = await runProvider(fallbackInput, alternate.id, alternate.provider)
        } else {
          try {
            result = await runProvider(input, input.settings.model, provider)
          } catch (caught) {
            const latestJob = await productStore.readGenerationJobForWorker(jobId)
            const hasOutput = latestJob?.variants?.some((variant) => variant.status === 'succeeded')
            const alternate = hasOutput ? undefined : fallback()
            const transientFailure = ['PROVIDER_TIMEOUT', 'PROVIDER_UNAVAILABLE', 'GENERATION_FAILED', 'REQUEST_TIMEOUT', 'EMPTY_PROVIDER_RESPONSE'].includes(caught?.code)
            if (!transientFailure || hasOutput) throw caught
            if (!alternate) {
              // 没有语义兼容的备用模型时保留 Provider 原始错误；否则会把
              // 超时/限流/上游错误误报成“规格不兼容”，用户无法选择正确恢复动作。
              throw caught
            }
            const fallbackInput = await prepareFallbackInput(alternate)
            result = await runProvider(fallbackInput, alternate.id, alternate.provider)
          }
        }
        await variantWrite
      } catch (caught) {
        if (caught instanceof GenerationJobExecutionLost || leaseLost) return
        if (timedOut) throw new GenerationError(504, 'PROVIDER_TIMEOUT', '生成服务响应超时，任务已停止，请稍后重试。')
        if (controller.signal.aborted) {
          // 用户取消：状态已由取消入口写成 cancelled，这里直接收工。抛错会把它
          // 覆盖成失败，用户看到的就不是自己发起的取消了。
          console.info(`[generation] ${jobId} aborted by cancel`)
          return
        }
        throw caught
      } finally {
        if (timeoutId) clearTimeout(timeoutId)
      }
      await maintainLease()
      if (leaseLost) {
        const latest = await productStore.readGenerationJobForWorker(jobId)
        if (latest && ['cancelled', 'failed', 'succeeded'].includes(latest.status)) {
          if (['cancelled', 'failed'].includes(latest.status)) {
            await recordLateOutputs(latest, result?.outputs, 'execution_lease_lost', executionFence)
          }
          observeRun(latest, {
            type: 'worker_discarded_late_result', status: latest.status,
            outputCount: result?.outputs?.length ?? 0,
            durationMs: Math.max(0, Date.now() - (latest.createdAt ?? running.createdAt)),
          })
          console.warn(
            `[generation] ${jobId} 结果迟到被丢弃：任务已是 ${latest.status}，`
            + `但 Provider 成功返回了 ${result?.outputs?.length ?? 0} 个输出（已产生费用）。`,
          )
        }
        return
      }
      console.info(`[generation] ${jobId} provider completed (${result.outputs.length} output(s))`)
      // cancel signal 是可恢复旁路，不是状态权威。Redis 暂时失败或 Job→Run 投影
      // 恰好在跨库窗口中断时，Provider 可能没有及时 abort；结果落库前必须再读
      // durable Turn / Run fence，否则迟到成功会把已 cancelled Run 反向复活。
      if (await stopFencedDelegation(running)) {
        const fenced = await productStore.readGenerationJobForWorker(jobId)
        await recordLateOutputs(fenced ?? running, result.outputs, 'delegation_fenced', executionFence)
        observeRun(running, {
          type: 'worker_discarded_fenced_result', status: 'cancelled', outputCount: result.outputs.length,
          durationMs: Math.max(0, Date.now() - running.createdAt),
        })
        console.warn(`[generation] ${jobId} 结果因 durable delegation fence 被丢弃（已产生费用）。`)
        return
      }
      clearIntervalFn(heartbeatId)
      await heartbeatWrite
      if (leaseLost) return
      const latest = await productStore.readGenerationJobForWorker(jobId)
      if (!latest || latest.status === 'cancelled' || latest.status === 'failed') {
        // 结果**迟到**了：任务已经被取消或被超时扫描判失败，而 Provider 这边刚成功。
        //
        // 仍然不改写终态 —— 取消与超时都是对用户做过的承诺，事后翻案会让「我点了取消」
        // 变成一件不确定的事。但**必须留下记录**：这里丢掉的是一张已经付过费的图，
        // 静默 return 之后没有任何地方能看出它存在过，运维也无从判断超时阈值是不是设短了。
        const quarantined = latest
          ? await recordLateOutputs(latest, result.outputs, 'terminal_state_prevailed', executionFence)
          : latest
        observeRun(quarantined ?? latest ?? running, {
          type: 'worker_discarded_late_result',
          status: latest?.status ?? 'missing',
          outputCount: result.outputs.length,
          durationMs: Math.max(0, Date.now() - (latest?.createdAt ?? running.createdAt)),
        })
        console.warn(
          `[generation] ${jobId} 结果迟到被丢弃：任务已是 ${latest?.status ?? '不存在'}，`
          + `但 Provider 成功返回了 ${result.outputs.length} 个输出（已产生费用）。`,
        )
        return
      }
      let completed = await commitExecutionJob({
        ...latest,
        status: 'succeeded',
        outputs: result.outputs,
        variants: (latest.variants?.length ? latest.variants : running.variants),
        missingOutputCount: result.missingOutputCount,
        partialError: result.partialError,
        error: undefined,
        errorCode: undefined,
        providerResponseSummary: undefined,
        // 终态先带补偿标记落库：进程若在 Canvas / Artifact 写回之间崩溃，
        // 恢复任务只做 writeback，不会再次调用 Provider。
        projectWritebackPending: true,
        updatedAt: Date.now(),
      }, { updateAgentRun: false, recordAudit: false }, executionFence)
      // 先持久化任务产出但暂不推进 Run；只有画布与 Artifact 都写好后，
      // 才发布可观察的 Agent Run 终态。
      const writebackSucceeded = await writeJobToProjectSafely(completed, { markPending: true })
      let terminalReady = writebackSucceeded
      let finalJob = completed
      if (terminalReady) {
        const artifactReady = await refreshGenerationArtifacts(completed)
        if (completed.agentRun && !artifactReady) {
          finalJob = await markProjectWritebackPending(completed, 'Artifact Index 尚未完成回写。')
          terminalReady = false
        }
      }
      if (terminalReady) {
        const finalized = await finalizeProjectWriteback(completed)
        completed = finalized.job
        finalJob = completed
        terminalReady = finalized.ready
      }
      await publishRun(finalJob)
      observeRun(completed, {
        type: 'worker_completed', status: 'succeeded', outputCount: completed.outputs.length,
        durationMs: Math.max(0, completed.updatedAt - completed.createdAt), projectWritebackPending: !terminalReady,
      })
    } catch (caught) {
      clearIntervalFn(heartbeatId)
      await heartbeatWrite
      if (caught instanceof GenerationJobExecutionLost || leaseLost) return
      // Provider 可以在不 await 最后一次 onVariant 的情况下抛错。先排空串行写入，
      // 再读取权威快照，否则失败终态会用旧 outputs 覆盖刚落库的部分成功结果。
      await variantWrite
      if (leaseLost) return
      const latest = await productStore.readGenerationJobForWorker(jobId)
      if (!latest || latest.status === 'cancelled') return
      const failure = timedOut
        ? new GenerationError(504, 'PROVIDER_TIMEOUT', '生成服务响应超时，任务已停止，请稍后重试。')
        : caught instanceof GenerationError
          ? caught
          : new GenerationError(502, 'GENERATION_FAILED', '生成任务失败，请稍后重试。')
      const detail = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught)
      const upstream = failure.upstreamMessage ? ` 上游原文：${failure.upstreamMessage}` : ''
      console.error(`[generation] ${jobId} failed (${failure.code}): ${detail}${upstream}`)
      // 错误码随任务落库：失败消息是给人看的，服务端的重试策略要按码分类
      // （瞬时故障可自动重试，其余停下等用户）。只存消息的话策略永远判不出来。
      let failed = await commitExecutionJob({
        ...latest,
        status: 'failed',
        error: failure.message,
        errorCode: failure.code,
        providerResponseSummary: failure.providerResponseSummary,
        variants: latest.variants ?? running.variants,
        projectWritebackPending: true,
        updatedAt: Date.now(),
      }, { updateAgentRun: false, recordAudit: false }, executionFence)
      const writebackSucceeded = await writeJobToProjectSafely(failed, { markPending: true })
      let terminalReady = writebackSucceeded
      if (terminalReady && failed.outputs?.length) {
        const artifactReady = await refreshGenerationArtifacts(failed)
        if (failed.agentRun && !artifactReady) {
          failed = await markProjectWritebackPending(failed, 'Artifact Index 尚未完成回写。')
          terminalReady = false
        }
      }
      if (terminalReady) {
        const finalized = await finalizeProjectWriteback(failed)
        failed = finalized.job
        terminalReady = finalized.ready
      }
      await publishRun(failed)
      observeRun(failed, {
        type: 'worker_failed', status: 'failed', code: failure.code,
        durationMs: Math.max(0, failed.updatedAt - failed.createdAt), projectWritebackPending: !terminalReady,
      })
    } finally {
      clearIntervalFn(heartbeatId)
      if (timeoutId) clearTimeout(timeoutId)
      await heartbeatWrite
      releaseProviderAdmission()
      cancelRegistry?.release(jobId, controller)
      await acknowledgeWorkerExit(jobId, executionFence)
    }
  }
}
