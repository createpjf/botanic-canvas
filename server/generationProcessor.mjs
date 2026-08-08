import { GenerationError, persistedGenerationJob, resolveGenerationInputMedia, validateGenerationInput } from './generationProvider.mjs'
import { generationTimeoutForModel } from './generationModels.mjs'
import { providerForModel } from './generationModels.mjs'
import { generateMedia } from './generationService.mjs'
import { publicAgentRun } from './botanicAgentRun.mjs'
import { reconcileAgentGenerationJobToProject } from './botanicAgentExecution.mjs'
import { compatibleFallbackModel, ProviderCircuitBreaker } from './generationGovernance.mjs'

export function createGenerationProcessor({
  productStore,
  mediaService,
  config,
  publishAgentRunUpdated,
  observeAgentRun = () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  providerCircuitBreaker = new ProviderCircuitBreaker({
    failureThreshold: config.providerFailureThreshold,
    cooldownMs: config.providerCircuitCooldownMs,
  }),
  generate = generateMedia,
}) {
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
      if (!reconciled.changed) return true
      try {
        await productStore.writeProject(job.ownerId, reconciled.document, project.revision, project.graphRevision)
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
        const errorMessage = caught instanceof Error ? caught.message : String(caught)
        const pending = {
          ...job,
          projectWritebackPending: true,
          projectWritebackAttempts: (job.projectWritebackAttempts ?? 0) + 1,
          projectWritebackError: errorMessage,
          projectWritebackUpdatedAt: Date.now(),
          updatedAt: Date.now(),
        }
        try {
          await productStore.putGenerationJob(pending.ownerId, persistedGenerationJob(pending))
        } catch (persistError) {
          console.error(`[generation] project writeback marker deferred: ${persistError instanceof Error ? persistError.message : String(persistError)}`)
        }
      }
      return false
    }
  }

  async function clearProjectWriteback(job) {
    if (!job.projectWritebackPending) return job
    const cleared = {
      ...job,
      projectWritebackPending: undefined,
      projectWritebackAttempts: undefined,
      projectWritebackError: undefined,
      projectWritebackUpdatedAt: undefined,
      updatedAt: Date.now(),
    }
    await productStore.putGenerationJob(cleared.ownerId, persistedGenerationJob(cleared))
    return cleared
  }

  async function publishRun(job) {
    if (!job.agentRun || !publishAgentRunUpdated) return
    try {
      const run = await productStore.readAgentRunForWorker(job.agentRun.runId)
      if (run) await publishAgentRunUpdated({ projectId: run.projectId, run: publicAgentRun(run) })
    } catch (caught) {
      console.error(`[agent-run] progress publish deferred: ${caught instanceof Error ? caught.message : String(caught)}`)
    }
  }

  async function refreshGenerationArtifacts(job) {
    try {
      await productStore.refreshGenerationArtifacts(job.ownerId, job.id)
    } catch (caught) {
      // Artifact Index 是可重建的历史目录；索引补偿失败不能把已经成功的
      // Provider 任务和画布回填伪装成失败，后续恢复流程仍可再次补齐。
      console.error(`[artifact-index] generation refresh deferred: ${caught instanceof Error ? caught.message : String(caught)}`)
    }
  }

  return async function processGenerationJob(jobId) {
    const stored = await productStore.readGenerationJobForWorker(jobId)
    if (!stored) return
    // 终态任务只在画布回写待处理时重新入队；不会再次调用真实 Provider。
    if (stored.projectWritebackPending) {
      const recovered = await writeJobToProjectSafely(stored)
      if (recovered) {
        await clearProjectWriteback(stored)
        if (stored.status === 'succeeded') await refreshGenerationArtifacts(stored)
      }
      await publishRun(recovered ? { ...stored, projectWritebackPending: undefined } : stored)
      return
    }
    if (['cancelled', 'succeeded', 'failed'].includes(stored.status)) return
    console.info(`[generation] ${jobId} started`)
    const initialVariants = Array.from({ length: stored.batchCount }, (_, index) => {
      const previous = stored.variants?.find((variant) => variant.index === index)
      return previous ?? { index, status: 'queued' }
    })
    const running = { ...stored, status: 'running', error: undefined, variants: initialVariants, updatedAt: Date.now() }
    await productStore.putGenerationJob(running.ownerId, persistedGenerationJob(running))
    await writeJobToProjectSafely(running)
    await publishRun(running)
    observeRun(running, { type: 'worker_started', status: 'running', queueDurationMs: Math.max(0, running.updatedAt - running.createdAt) })
    let variantWrite = Promise.resolve()
    try {
      const maximumTaskDurationMs = generationTimeoutForModel(config.modelOptions ?? [], running.settings?.model, {
        imageTimeoutMs: config.generationTimeoutMs ?? 5 * 60_000,
        videoTimeoutMs: config.videoGenerationTimeoutMs ?? 20 * 60_000,
      })
      const remainingTaskDurationMs = maximumTaskDurationMs - (Date.now() - running.createdAt)
      if (remainingTaskDurationMs <= 0) {
        throw new GenerationError(504, 'PROVIDER_TIMEOUT', '生成任务超过模型等待时限，已停止，请稍后重试。')
      }
      const validatedInput = validateGenerationInput(running.rawInput, {
        models: config.modelOptions?.length ? config.modelOptions : config.models,
        maximumBatchCount: config.maximumBatchCount,
        maximumReferenceBytes: config.maximumReferenceBytes,
      })
      const input = await resolveGenerationInputMedia(validatedInput, (mediaId) => mediaService.readGenerationInput(running.ownerId, mediaId, running.projectId))
      console.info(`[generation] ${jobId} references ready`)
      const remainingGenerationMs = maximumTaskDurationMs - (Date.now() - running.createdAt)
      if (remainingGenerationMs <= 0) {
        throw new GenerationError(504, 'PROVIDER_TIMEOUT', '生成任务超过模型等待时限，已停止，请稍后重试。')
      }
      const controller = new AbortController()
      // 从任务创建开始计时，而非从 Worker 取到任务后重新计时，排队不会无限延长用户等待。
      const timeoutMs = Math.max(1, remainingGenerationMs)
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
      // Provider 回调可能由多个子任务同时触发，串行化状态写入避免最后完成的
      // 子任务覆盖其他子任务的进度。图片请求本身仍保持受控并发。
      const onVariant = (update) => {
        variantWrite = variantWrite.then(async () => {
          const latest = await productStore.readGenerationJobForWorker(jobId)
          if (!latest || latest.status === 'cancelled') return
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
          await productStore.putGenerationJob(next.ownerId, persistedGenerationJob(next))
          await publishRun(next)
        })
        return variantWrite
      }
      let result
      try {
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
          await productStore.putGenerationJob(running.ownerId, persistedGenerationJob({
            ...latestJob,
            effectiveModel,
            usage: latestJob.usage ? {
              ...latestJob.usage,
              model: effectiveModel,
              provider: effectiveProvider,
            } : latestJob.usage,
            providerAttempts: [...(latestJob.providerAttempts ?? []), attempt],
            updatedAt: Date.now(),
          }))
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
        const providerDecision = await providerCircuitBreaker.canRequest(provider)
        if (!providerDecision.allowed) {
          const alternate = fallback()
          if (!alternate) throw new GenerationError(503, 'PROVIDER_CIRCUIT_OPEN', '当前生成服务暂不可用，且没有语义兼容的备用模型，请稍后重试。')
          const fallbackInput = { ...input, settings: { ...input.settings, model: alternate.id } }
          result = await runProvider(fallbackInput, alternate.id, alternate.provider)
        } else {
          try {
            result = await runProvider(input, input.settings.model, provider)
          } catch (caught) {
            const latestJob = await productStore.readGenerationJobForWorker(jobId)
            const hasOutput = latestJob?.variants?.some((variant) => variant.status === 'succeeded')
            const alternate = hasOutput ? undefined : fallback()
            const transientFailure = ['PROVIDER_TIMEOUT', 'PROVIDER_UNAVAILABLE', 'GENERATION_FAILED', 'REQUEST_TIMEOUT'].includes(caught?.code)
            if (!transientFailure || hasOutput) throw caught
            if (!alternate) {
              // 没有语义兼容的备用模型时保留 Provider 原始错误；否则会把
              // 超时/限流/上游错误误报成“规格不兼容”，用户无法选择正确恢复动作。
              throw caught
            }
            const fallbackInput = { ...input, settings: { ...input.settings, model: alternate.id } }
            result = await runProvider(fallbackInput, alternate.id, alternate.provider)
          }
        }
        await variantWrite
      } catch (caught) {
        if (controller.signal.aborted) throw new GenerationError(504, 'PROVIDER_TIMEOUT', '生成服务响应超时，任务已停止，请稍后重试。')
        throw caught
      } finally {
        clearTimeout(timeoutId)
      }
      console.info(`[generation] ${jobId} provider completed (${result.outputs.length} output(s))`)
      const latest = await productStore.readGenerationJobForWorker(jobId)
      if (!latest || latest.status === 'cancelled' || latest.status === 'failed') return
      const completed = {
        ...latest,
        status: 'succeeded',
        outputs: result.outputs,
        variants: (latest.variants?.length ? latest.variants : running.variants),
        missingOutputCount: result.missingOutputCount,
        partialError: result.partialError,
        error: undefined,
        updatedAt: Date.now(),
      }
      await productStore.putGenerationJob(completed.ownerId, persistedGenerationJob(completed))
      const writebackSucceeded = await writeJobToProjectSafely(completed, { markPending: true })
      if (writebackSucceeded) await refreshGenerationArtifacts(completed)
      await publishRun(writebackSucceeded ? completed : { ...completed, projectWritebackPending: true })
      observeRun(completed, {
        type: 'worker_completed', status: 'succeeded', outputCount: completed.outputs.length,
        durationMs: Math.max(0, completed.updatedAt - completed.createdAt), projectWritebackPending: !writebackSucceeded,
      })
    } catch (caught) {
      const latest = await productStore.readGenerationJobForWorker(jobId)
      if (!latest || latest.status === 'cancelled') return
      const failure = caught instanceof GenerationError
        ? caught
        : new GenerationError(502, 'GENERATION_FAILED', '真实生图任务失败，请稍后重试。')
      const detail = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught)
      console.error(`[generation] ${jobId} failed (${failure.code}): ${detail}`)
      await variantWrite
      const failed = { ...latest, status: 'failed', error: failure.message, variants: latest.variants ?? running.variants, updatedAt: Date.now() }
      await productStore.putGenerationJob(failed.ownerId, persistedGenerationJob(failed))
      const writebackSucceeded = await writeJobToProjectSafely(failed, { markPending: true })
      await publishRun(writebackSucceeded ? failed : { ...failed, projectWritebackPending: true })
      observeRun(failed, {
        type: 'worker_failed', status: 'failed', code: failure.code,
        durationMs: Math.max(0, failed.updatedAt - failed.createdAt), projectWritebackPending: !writebackSucceeded,
      })
    }
  }
}
