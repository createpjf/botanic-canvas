import { GenerationError, persistedGenerationJob, resolveGenerationInputMedia, validateGenerationInput } from './generationProvider.mjs'
import { generationTimeoutForModel } from './generationModels.mjs'
import { generateMedia } from './generationService.mjs'
import { publicAgentRun } from './botanicAgentRun.mjs'
import { reconcileAgentGenerationJobToProject } from './botanicAgentExecution.mjs'

export function createGenerationProcessor({ productStore, mediaService, config, publishAgentRunUpdated, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
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

  return async function processGenerationJob(jobId) {
    const stored = await productStore.readGenerationJobForWorker(jobId)
    if (!stored) return
    // 终态任务只在画布回写待处理时重新入队；不会再次调用真实 Provider。
    if (stored.projectWritebackPending) {
      const recovered = await writeJobToProjectSafely(stored)
      if (recovered) await clearProjectWriteback(stored)
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
        result = await generateMedia(input, {
          config,
          jobId,
          signal: controller.signal,
          persistImage: (image) => mediaService.persistProviderImage({ ownerId: running.ownerId, projectId: running.projectId, image }),
          persistMedia: (media) => mediaService.persistProviderMedia({ ownerId: running.ownerId, projectId: running.projectId, media }),
          onVariant,
          completedVariants: running.variants,
        })
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
      await publishRun(writebackSucceeded ? completed : { ...completed, projectWritebackPending: true })
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
    }
  }
}
