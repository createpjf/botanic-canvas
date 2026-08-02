import { GenerationError, persistedGenerationJob, resolveGenerationInputMedia, validateGenerationInput } from './generationProvider.mjs'
import { generationTimeoutForModel } from './generationModels.mjs'
import { generateMedia } from './generationService.mjs'
import { publicAgentRun } from './botanicAgentRun.mjs'
import { reconcileAgentGenerationJobToProject } from './botanicAgentExecution.mjs'

export function createGenerationProcessor({ productStore, mediaService, config, publishAgentRunUpdated }) {
  async function writeJobToProject(job) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const project = await productStore.readProject(job.ownerId, job.projectId)
      if (!project) return
      const reconciled = reconcileAgentGenerationJobToProject(project.document, job)
      if (!reconciled.changed) return
      try {
        await productStore.writeProject(job.ownerId, reconciled.document, project.revision, project.graphRevision)
        return
      } catch (caught) {
        if (caught?.code !== 'PROJECT_CONFLICT' && caught?.code !== 'CANVAS_GRAPH_CONFLICT') throw caught
      }
    }
    throw new Error('Agent 结果回写连续发生画布冲突。')
  }

  async function writeJobToProjectSafely(job) {
    if (!job.agentRun) return
    try {
      await writeJobToProject(job)
    } catch (caught) {
      console.error(`[agent-run] project writeback deferred: ${caught instanceof Error ? caught.message : String(caught)}`)
    }
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
    if (!stored || ['cancelled', 'succeeded', 'failed'].includes(stored.status)) return
    console.info(`[generation] ${jobId} started`)
    const running = { ...stored, status: 'running', error: undefined, updatedAt: Date.now() }
    await productStore.putGenerationJob(running.ownerId, persistedGenerationJob(running))
    await writeJobToProjectSafely(running)
    await publishRun(running)
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
      let result
      try {
        console.info(`[generation] ${jobId} requesting provider`)
        result = await generateMedia(input, {
          config,
          jobId,
          signal: controller.signal,
          persistImage: (image) => mediaService.persistProviderImage({ ownerId: running.ownerId, projectId: running.projectId, image }),
          persistMedia: (media) => mediaService.persistProviderMedia({ ownerId: running.ownerId, projectId: running.projectId, media }),
        })
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
        missingOutputCount: result.missingOutputCount,
        partialError: result.partialError,
        error: undefined,
        updatedAt: Date.now(),
      }
      await productStore.putGenerationJob(completed.ownerId, persistedGenerationJob(completed))
      await writeJobToProjectSafely(completed)
      await publishRun(completed)
    } catch (caught) {
      const latest = await productStore.readGenerationJobForWorker(jobId)
      if (!latest || latest.status === 'cancelled') return
      const failure = caught instanceof GenerationError
        ? caught
        : new GenerationError(502, 'GENERATION_FAILED', '真实生图任务失败，请稍后重试。')
      const detail = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught)
      console.error(`[generation] ${jobId} failed (${failure.code}): ${detail}`)
      const failed = { ...latest, status: 'failed', error: failure.message, updatedAt: Date.now() }
      await productStore.putGenerationJob(failed.ownerId, persistedGenerationJob(failed))
      await writeJobToProjectSafely(failed)
      await publishRun(failed)
    }
  }
}
