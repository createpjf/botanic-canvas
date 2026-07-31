import { GenerationError, generateImages, persistedGenerationJob, resolveGenerationInputMedia, validateGenerationInput } from './generationProvider.mjs'

export function createGenerationProcessor({ productStore, mediaService, config }) {
  return async function processGenerationJob(jobId) {
    const stored = await productStore.readGenerationJobForWorker(jobId)
    if (!stored || ['cancelled', 'succeeded', 'failed'].includes(stored.status)) return
    console.info(`[generation] ${jobId} started`)
    const running = { ...stored, status: 'running', error: undefined, updatedAt: Date.now() }
    await productStore.putGenerationJob(running.ownerId, persistedGenerationJob(running))
    try {
      const maximumTaskDurationMs = Math.min(5 * 60_000, Math.max(10_000, config.generationTimeoutMs ?? 5 * 60_000))
      const remainingTaskDurationMs = maximumTaskDurationMs - (Date.now() - running.createdAt)
      if (remainingTaskDurationMs <= 0) {
        throw new GenerationError(504, 'PROVIDER_TIMEOUT', '生成任务超过 5 分钟，已停止，请稍后重试。')
      }
      const validatedInput = validateGenerationInput(running.rawInput, {
        models: config.models,
        maximumBatchCount: config.maximumBatchCount,
        maximumReferenceBytes: config.maximumReferenceBytes,
      })
      const input = await resolveGenerationInputMedia(validatedInput, (mediaId) => mediaService.readGenerationInput(running.ownerId, mediaId, running.projectId))
      console.info(`[generation] ${jobId} references ready`)
      const remainingGenerationMs = maximumTaskDurationMs - (Date.now() - running.createdAt)
      if (remainingGenerationMs <= 0) {
        throw new GenerationError(504, 'PROVIDER_TIMEOUT', '生成任务超过 5 分钟，已停止，请稍后重试。')
      }
      const controller = new AbortController()
      // 从任务创建开始计时，而非从 Worker 取到任务后重新计时，排队不会无限延长用户等待。
      const timeoutMs = Math.max(1, remainingGenerationMs)
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
      let result
      try {
        console.info(`[generation] ${jobId} requesting provider`)
        result = await generateImages(input, {
          apiBaseUrl: config.apiBaseUrl,
          apiKey: config.apiKey,
          jobId,
          signal: controller.signal,
          persistImage: (image) => mediaService.persistProviderImage({ ownerId: running.ownerId, projectId: running.projectId, image }),
        })
      } catch (caught) {
        if (controller.signal.aborted) throw new GenerationError(504, 'PROVIDER_TIMEOUT', '图像服务响应超时，任务已停止，请稍后重试。')
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
    }
  }
}
