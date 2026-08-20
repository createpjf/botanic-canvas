import type { GenerationAspectRatio, GenerationModelOption, GenerationResolution, GenerationSettings } from './canvas'

/** gpt-image-2 官方自定义尺寸窗：边长为 16 的倍数，长短边比不超过 3:1。 */
export const gptImage2CustomSizeLimits = {
  minPixels: 655_360,
  maxPixels: 8_294_400,
  maxEdge: 3840,
  minEdge: 16,
  multiple: 16,
  maxRatio: 3,
} as const

const catalogSizes: Record<GenerationResolution, Partial<Record<GenerationAspectRatio, string>>> = {
  '1K': {
    '1:1': '1024x1024',
    '16:9': '1536x864',
    '4:3': '1536x1152',
    '3:4': '960x1280',
    '4:5': '1024x1280',
    '9:16': '720x1280',
  },
  '2K': {
    '1:1': '2048x2048',
    '16:9': '2048x1152',
    '4:3': '2048x1536',
    '3:4': '1536x2048',
    '4:5': '1600x2000',
    '9:16': '1152x2048',
  },
}

const catalogAspectRatios: GenerationAspectRatio[] = ['1:1', '16:9', '4:3', '3:4', '4:5', '9:16']

export type GenerationSizeOverride = Partial<Pick<GenerationSettings, 'model' | 'aspectRatio' | 'resolution' | 'outputWidth' | 'outputHeight'>>

export type CustomGenerationSizeResult =
  | { ok: true; width: number; height: number; size: string; snapped: boolean }
  | { ok: false; message: string }

export const gptImage2CatalogAspectRatios: GenerationAspectRatio[] = ['1:1', '16:9', '4:3', '3:4', '4:5', '9:16']
export const gptImage1CatalogAspectRatios: GenerationAspectRatio[] = ['1:1', '3:4', '4:5', '9:16']

export function modelSupportsCustomSize(model: Pick<GenerationModelOption, 'id' | 'supportsCustomSize'> | string | undefined) {
  if (!model) return false
  if (typeof model === 'string') return model === 'gpt-image-2' || model.startsWith('gpt-image-2')
  if (model.supportsCustomSize === true) return true
  if (model.supportsCustomSize === false) return false
  return model.id === 'gpt-image-2' || model.id.startsWith('gpt-image-2')
}

export function catalogAspectRatiosForModel(model: Pick<GenerationModelOption, 'id' | 'supportsCustomSize' | 'aspectRatios'> | string | undefined): GenerationAspectRatio[] {
  if (typeof model === 'object' && model?.aspectRatios?.length) return [...model.aspectRatios]
  return modelSupportsCustomSize(model) ? [...gptImage2CatalogAspectRatios] : [...gptImage1CatalogAspectRatios]
}

export function customGenerationSizeFields(settings: Partial<GenerationSettings> | undefined): { outputWidth: number; outputHeight: number } | undefined {
  const width = settings?.outputWidth
  const height = settings?.outputHeight
  if (typeof width !== 'number' || typeof height !== 'number' || !Number.isInteger(width) || !Number.isInteger(height)) {
    return undefined
  }
  const normalized = normalizeCustomGenerationSize(width, height)
  if (!normalized.ok) return undefined
  return { outputWidth: normalized.width, outputHeight: normalized.height }
}

export function withoutCustomGenerationSize(settings: GenerationSettings): GenerationSettings {
  const { outputWidth: _width, outputHeight: _height, ...rest } = settings
  return rest
}

export function applyCustomGenerationSize(settings: GenerationSettings, width: number, height: number): CustomGenerationSizeResult & { settings?: GenerationSettings } {
  const normalized = normalizeCustomGenerationSize(width, height)
  if (!normalized.ok) return normalized
  return {
    ...normalized,
    settings: {
      ...settings,
      aspectRatio: inferAspectRatioFromPixels(normalized.width, normalized.height),
      outputWidth: normalized.width,
      outputHeight: normalized.height,
    },
  }
}

export function parseCustomGenerationSize(raw: string): { width: number; height: number } | undefined {
  const match = raw.trim().match(/(\d{3,4})\s*[x×*]\s*(\d{3,4})/u)
  if (!match) return undefined
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isInteger(width) || !Number.isInteger(height)) return undefined
  return { width, height }
}

function snapEdge(value: number) {
  const snapped = Math.round(value / gptImage2CustomSizeLimits.multiple) * gptImage2CustomSizeLimits.multiple
  return Math.min(gptImage2CustomSizeLimits.maxEdge, Math.max(gptImage2CustomSizeLimits.minEdge, snapped))
}

/** 校验文案是中文稳定值；展示层按界面语言翻译，不改校验结果。 */
export function localizeCustomGenerationSizeMessage(message: string, locale: 'zh-CN' | 'en' = 'zh-CN') {
  if (locale !== 'en') return message
  if (message.includes('整数')) return 'Width and height must be whole pixels.'
  if (message.includes('3:1')) return 'The long edge cannot be more than 3× the short edge.'
  if (message.includes('总像素')) return 'Custom pixel count is outside the allowed range.'
  if (message.includes('边长')) return `Each side must be between ${gptImage2CustomSizeLimits.minEdge} and ${gptImage2CustomSizeLimits.maxEdge} pixels.`
  return 'Custom width and height are invalid.'
}

export function normalizeCustomGenerationSize(width: number, height: number): CustomGenerationSizeResult {
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    return { ok: false, message: '自定义宽高必须是整数像素。' }
  }
  const nextWidth = snapEdge(width)
  const nextHeight = snapEdge(height)
  const snapped = nextWidth !== width || nextHeight !== height
  const longEdge = Math.max(nextWidth, nextHeight)
  const shortEdge = Math.min(nextWidth, nextHeight)
  if (shortEdge < gptImage2CustomSizeLimits.minEdge || longEdge > gptImage2CustomSizeLimits.maxEdge) {
    return { ok: false, message: `自定义边长需在 ${gptImage2CustomSizeLimits.minEdge}–${gptImage2CustomSizeLimits.maxEdge} 像素之间。` }
  }
  if (longEdge / shortEdge > gptImage2CustomSizeLimits.maxRatio) {
    return { ok: false, message: '自定义长短边比不能超过 3:1。' }
  }
  const pixels = nextWidth * nextHeight
  if (pixels < gptImage2CustomSizeLimits.minPixels || pixels > gptImage2CustomSizeLimits.maxPixels) {
    return { ok: false, message: '自定义总像素超出 gpt-image-2 允许范围。' }
  }
  return { ok: true, width: nextWidth, height: nextHeight, size: `${nextWidth}x${nextHeight}`, snapped }
}

export function catalogGenerationSize(aspectRatio: GenerationAspectRatio, resolution: GenerationResolution) {
  return catalogSizes[resolution]?.[aspectRatio]
}

function ratioValue(aspectRatio: GenerationAspectRatio) {
  const [width, height] = aspectRatio.split(':').map(Number)
  return width / height
}

export function inferAspectRatioFromPixels(width: number, height: number): GenerationAspectRatio {
  const actual = width / height
  return catalogAspectRatios.reduce((best, ratio) => {
    const bestDelta = Math.abs(ratioValue(best) - actual)
    const nextDelta = Math.abs(ratioValue(ratio) - actual)
    return nextDelta < bestDelta ? ratio : best
  }, '1:1' as GenerationAspectRatio)
}

export function generationSettingsSizeLabel(settings: Pick<GenerationSettings, 'aspectRatio' | 'resolution' | 'outputWidth' | 'outputHeight'>) {
  if (Number.isInteger(settings.outputWidth) && Number.isInteger(settings.outputHeight)) {
    return `${settings.outputWidth}×${settings.outputHeight}`
  }
  return `${settings.aspectRatio} · ${settings.resolution}`
}

export function resolveGenerationOutputSize(settings: Pick<GenerationSettings, 'aspectRatio' | 'resolution' | 'outputWidth' | 'outputHeight'>) {
  if (Number.isInteger(settings.outputWidth) && Number.isInteger(settings.outputHeight)) {
    const normalized = normalizeCustomGenerationSize(Number(settings.outputWidth), Number(settings.outputHeight))
    if (!normalized.ok) throw new Error(normalized.message)
    return normalized.size
  }
  const mapped = catalogGenerationSize(settings.aspectRatio, settings.resolution)
  if (!mapped) throw new Error('当前比例与清晰度没有对应的输出尺寸。')
  return mapped
}
