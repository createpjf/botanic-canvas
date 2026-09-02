import { GenerationError, generateImages } from './generationProvider.mjs'
import { providerForModel } from './generationModels.mjs'
import { composeOverlayImages, jobRequestsPixelOverlay } from '../media/imageOverlay.mjs'
import { generateMiniMaxImages, generateMiniMaxVideos } from '../providers/minimaxGenerationProvider.mjs'
import { generateFlockImages } from '../providers/flockGenerationProvider.mjs'

function configuredModel(config, modelId) {
  const declared = providerForModel(config.modelOptions ?? [], modelId)
  if (declared) return declared
  // 兼容已有测试与旧本地配置；历史 OPENAI_IMAGE_MODELS 仍走原供应商。
  if ((config.models ?? []).includes(modelId)) {
    return { id: modelId, provider: 'openai', mediaKind: 'image' }
  }
  return undefined
}

/** Worker 只调用这一入口；模型选择不能绕过 Provider 与媒体契约。 */
export async function generateMedia(job, {
  config,
  signal,
  jobId,
  persistImage,
  persistMedia,
  onVariant,
  completedVariants,
}) {
  if (jobRequestsPixelOverlay(job)) {
    return composeOverlayImages(job, { persistImage, jobId, onVariant, completedVariants })
  }
  const model = configuredModel(config, job.settings.model)
  if (!model) throw new GenerationError(400, 'INVALID_REQUEST', '生成模型未配置或不可用。')
  if (model.provider === 'openai') {
    return generateImages(job, {
      apiBaseUrl: config.apiBaseUrl,
      apiKey: config.apiKey,
      signal,
      persistImage,
      jobId,
      variantConcurrency: config.generationVariantConcurrency,
      onVariant,
      completedVariants,
    })
  }
  if (model.provider === 'minimax' && model.mediaKind === 'video') {
    return generateMiniMaxVideos(job, {
      apiBaseUrl: config.miniMaxApiBaseUrl,
      apiKey: config.miniMaxApiKey,
      signal,
      persistMedia,
      jobId,
      onVariant,
      completedVariants,
    })
  }
  if (model.provider === 'minimax') {
    return generateMiniMaxImages(job, {
      apiBaseUrl: config.miniMaxApiBaseUrl,
      apiKey: config.miniMaxApiKey,
      signal,
      persistMedia,
      jobId,
      onVariant,
      completedVariants,
    })
  }
  if (model.provider === 'flock') {
    return generateFlockImages(job, {
      apiBaseUrl: config.flockApiBaseUrl,
      apiKey: config.flockApiKey,
      signal,
      persistMedia,
      persistImage,
      jobId,
      onVariant,
      completedVariants,
    })
  }
  throw new GenerationError(400, 'INVALID_REQUEST', '生成模型对应的供应商不受支持。')
}
