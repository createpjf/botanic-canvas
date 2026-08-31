import jpeg from 'jpeg-js'
import { GenerationError, generateImages } from './generationProvider.mjs'
import { providerInputImages } from './generationComposition.mjs'
import { providerForModel } from './generationModels.mjs'
import { gptImage2CustomSizeLimits } from './generationOutputSize.mjs'
import { composeOverlayImages, decodeRgbaImage, encodeRgbaPng, jobRequestsPixelOverlay, resizeRgbaImage } from './imageOverlay.mjs'
import { imagePixelSize } from './mediaFormats.mjs'
import { generateMiniMaxImages, generateMiniMaxVideos } from './minimaxGenerationProvider.mjs'
import { generateFlockImages } from './flockGenerationProvider.mjs'

const jpegIccProfileMarker = Buffer.from('ICC_PROFILE')

function normalizeGptInputImage(image) {
  const size = imagePixelSize(image?.buffer)
  if (!size) return image
  const pixels = size.width * size.height
  const hasJpegIccProfile = image.mimeType === 'image/jpeg' && image.buffer.includes(jpegIccProfileMarker)
  if (pixels <= gptImage2CustomSizeLimits.maxPixels
    && Math.max(size.width, size.height) <= gptImage2CustomSizeLimits.maxEdge
    && !hasJpegIccProfile) return image
  if (image.mimeType !== 'image/jpeg' && image.mimeType !== 'image/png') {
    throw new GenerationError(422, 'INVALID_REFERENCE', 'GPT 参考图无法自动压缩，请转换为标准 JPEG 或 PNG 后重试。')
  }
  const scale = Math.min(
    1,
    gptImage2CustomSizeLimits.maxEdge / Math.max(size.width, size.height),
    Math.sqrt(gptImage2CustomSizeLimits.maxPixels / pixels),
  )
  const width = Math.max(1, Math.floor(size.width * scale))
  const height = Math.max(1, Math.floor(size.height * scale))
  try {
    const resized = resizeRgbaImage(decodeRgbaImage(image.buffer, image.mimeType), width, height)
    return {
      ...image,
      buffer: image.mimeType === 'image/jpeg'
        ? jpeg.encode({ width, height, data: resized.rgba }, 90).data
        : encodeRgbaPng(resized),
    }
  } catch {
    throw new GenerationError(422, 'INVALID_REFERENCE', 'GPT 参考图无法自动压缩，请转换为标准 JPEG 或 PNG 后重试。')
  }
}

function normalizeGptInputJob(job) {
  if (!String(job.settings?.model ?? '').startsWith('gpt-image-2')) return job
  const originalBase = providerInputImages(job)[0]
  const normalized = {
    ...job,
    ...(job.parent ? { parent: normalizeGptInputImage(job.parent) } : {}),
    ...(Array.isArray(job.references) ? { references: job.references.map(normalizeGptInputImage) } : {}),
  }
  const normalizedBase = providerInputImages(normalized)[0]
  const originalSize = imagePixelSize(originalBase?.buffer)
  const normalizedSize = imagePixelSize(normalizedBase?.buffer)
  if (!job.mask?.buffer || !originalSize || !normalizedSize
    || (originalSize.width === normalizedSize.width && originalSize.height === normalizedSize.height)) return normalized
  try {
    const mask = resizeRgbaImage(decodeRgbaImage(job.mask.buffer, job.mask.mimeType), normalizedSize.width, normalizedSize.height)
    return { ...normalized, mask: { ...job.mask, mimeType: 'image/png', buffer: encodeRgbaPng(mask) } }
  } catch {
    throw new GenerationError(422, 'INVALID_MASK', '局部重绘蒙版无法匹配压缩后的参考图，请重新框选后重试。')
  }
}

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
    return generateImages(normalizeGptInputJob(job), {
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
