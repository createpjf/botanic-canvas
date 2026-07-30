import { GenerationError, generateImages, persistedGenerationJob, validateGenerationInput } from './generationProvider.mjs'

export function createGenerationProcessor({ productStore, mediaService, config }) {
  return async function processGenerationJob(jobId) {
    const stored = await productStore.readGenerationJobForWorker(jobId)
    if (!stored || ['cancelled', 'succeeded', 'failed'].includes(stored.status)) return
    const running = { ...stored, status: 'running', error: undefined, updatedAt: Date.now() }
    await productStore.putGenerationJob(running.ownerId, persistedGenerationJob(running))
    try {
      const input = validateGenerationInput(running.rawInput, {
        models: config.models,
        maximumBatchCount: config.maximumBatchCount,
        maximumReferenceBytes: config.maximumReferenceBytes,
      })
      const outputs = await generateImages(input, {
        apiBaseUrl: config.apiBaseUrl,
        apiKey: config.apiKey,
        persistImage: (image) => mediaService.persistProviderImage({ ownerId: running.ownerId, projectId: running.projectId, image }),
      })
      const latest = await productStore.readGenerationJobForWorker(jobId)
      if (!latest || latest.status === 'cancelled') return
      const completed = { ...latest, status: 'succeeded', outputs, error: undefined, updatedAt: Date.now() }
      await productStore.putGenerationJob(completed.ownerId, persistedGenerationJob(completed))
    } catch (caught) {
      const latest = await productStore.readGenerationJobForWorker(jobId)
      if (!latest || latest.status === 'cancelled') return
      if (!(caught instanceof GenerationError)) {
        const detail = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught)
        console.error(`[generation] ${jobId} failed: ${detail}`)
      }
      const failure = caught instanceof GenerationError
        ? caught
        : new GenerationError(502, 'GENERATION_FAILED', '真实生图任务失败，请稍后重试。')
      const failed = { ...latest, status: 'failed', error: failure.message, updatedAt: Date.now() }
      await productStore.putGenerationJob(failed.ownerId, persistedGenerationJob(failed))
    }
  }
}
