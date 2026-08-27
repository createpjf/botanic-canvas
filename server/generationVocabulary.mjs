// @ts-check

/** 画布与 Agent 共用的比例 / 分辨率词表。客户端镜像在 src/domain/canvas.ts。 */
export const GENERATION_ASPECT_RATIOS = Object.freeze([
  '1:1', '16:9', '4:3', '3:4', '4:5', '9:16', '3:2', '2:3', '5:4', '21:9',
])
export const GENERATION_RESOLUTIONS = Object.freeze(['1K', '2K', '4K'])
export const EVERYDAY_GENERATION_RESOLUTIONS = Object.freeze(['1K', '2K'])
export const NANO_BANANA_MODEL_ID = 'gemini-3.1-pro-preview'
export const DEFAULT_FLOCK_IMAGE_MODELS = Object.freeze([NANO_BANANA_MODEL_ID])
export const NANO_BANANA_ASPECT_RATIOS = GENERATION_ASPECT_RATIOS
export const NANO_BANANA_RESOLUTIONS = GENERATION_RESOLUTIONS

export function maximumReferencesForModel(model) {
  const value = Number(model?.maximumReferences)
  return Number.isInteger(value) && value > 0 ? value : 8
}

export function defaultImageGenerationModel(catalog, mediaKind = 'image') {
  const models = Array.isArray(catalog) ? catalog : []
  const matching = models.filter((model) => (model?.mediaKind ?? 'image') === mediaKind)
  if (mediaKind === 'image') {
    const flock = matching.find((model) => model?.provider === 'flock')
    if (flock) return flock
  }
  return matching[0]
}
