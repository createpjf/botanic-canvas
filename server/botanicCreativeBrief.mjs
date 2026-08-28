import { GENERATION_ASPECT_RATIOS, GENERATION_RESOLUTIONS } from './generationVocabulary.mjs'

export const botanicCreativeBriefFieldIds = Object.freeze([
  'model',
  'delivery_preset',
  'aspect_ratio',
  'resolution',
  'prompt_direction',
  'preservation_priority',
  'custom_direction',
])

const fieldIds = new Set(botanicCreativeBriefFieldIds)
const modes = new Set(['generation', 'prompt'])
const deliveryPresets = new Set(['taobao', 'xiaohongshu', 'douyin', 'custom'])
const deliveryRatios = new Map([['taobao', '1:1'], ['xiaohongshu', '3:4'], ['douyin', '9:16']])
const aspectRatios = new Set(GENERATION_ASPECT_RATIOS)
const resolutions = new Set(GENERATION_RESOLUTIONS)
const promptDirections = new Set(['faithful', 'commercial', 'editorial', 'social', 'custom'])
const preservationPriorities = new Set(['identity', 'product', 'garment', 'balanced'])
const sources = new Set(['user', 'canvas', 'memory', 'skill', 'inferred', 'default'])
const botanicCreativeBriefVariationValueMax = 8

export class BotanicCreativeBriefValidationError extends TypeError {
  constructor(message) {
    super(message)
    this.name = 'BotanicCreativeBriefValidationError'
  }
}

function invalid(message) {
  throw new BotanicCreativeBriefValidationError(message)
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${name}无效。`)
  return value
}

function optionalText(value, name, maximumLength) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximumLength) invalid(`${name}无效。`)
  return value.trim()
}

function enumValue(value, allowed, name) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !allowed.has(value)) invalid(`${name}不支持。`)
  return value
}

/**
 * Creative Brief 是用户、画布与规则之间的持久化协议。这里只返回白名单字段，
 * 不让媒体地址、任意嵌套对象或提供方私有内容进入 Planner。
 */
export function validateBotanicCreativeBrief(value) {
  const brief = object(value, 'Creative Brief')
  if (brief.version !== 1) invalid('Creative Brief 版本不支持。')
  const mode = enumValue(brief.mode, modes, 'Creative Brief 模式')
  const originalInstruction = optionalText(brief.originalInstruction, 'Creative Brief 原始要求', 4000)
  if (!originalInstruction) invalid('Creative Brief 原始要求无效。')
  const rawOutput = object(brief.output, 'Creative Brief 输出设置')
  const rawCreative = object(brief.creative, 'Creative Brief 创作设置')
  const rawProvenance = object(brief.provenance, 'Creative Brief 来源')

  const output = {}
  const model = optionalText(rawOutput.model, 'Creative Brief 模型', 160)
  const deliveryPreset = enumValue(rawOutput.deliveryPreset, deliveryPresets, '交付用途')
  const aspectRatio = enumValue(rawOutput.aspectRatio, aspectRatios, '画面比例')
  const resolution = enumValue(rawOutput.resolution, resolutions, '分辨率')
  if (model) output.model = model
  if (deliveryPreset) output.deliveryPreset = deliveryPreset
  if (aspectRatio) output.aspectRatio = aspectRatio
  if (resolution) output.resolution = resolution
  const presetRatio = deliveryPreset ? deliveryRatios.get(deliveryPreset) : undefined
  if (presetRatio && aspectRatio && presetRatio !== aspectRatio) invalid('交付用途与画面比例冲突。')

  const creative = {}
  const promptDirection = enumValue(rawCreative.promptDirection, promptDirections, '创作方向')
  const preservationPriority = enumValue(rawCreative.preservationPriority, preservationPriorities, '保持重点')
  const customDirection = optionalText(rawCreative.customDirection, '自定义创作方向', 500)
  if (promptDirection) creative.promptDirection = promptDirection
  if (preservationPriority) creative.preservationPriority = preservationPriority
  if (customDirection) creative.customDirection = customDirection
  if (customDirection && promptDirection !== 'custom') invalid('自定义创作方向与方向类型冲突。')

  // 已确认的变体轴与取值属于长期创作设置，必须原样保留：丢掉它就会在下一轮重复追问同一个维度。
  let variation
  if (brief.variation !== undefined) {
    const rawVariation = object(brief.variation, 'Creative Brief 变体设置')
    if (!Array.isArray(rawVariation.values)) invalid('Creative Brief 变体取值无效。')
    if (rawVariation.values.length > botanicCreativeBriefVariationValueMax) invalid('Creative Brief 变体取值过多。')
    const values = rawVariation.values.map((value) => {
      if (typeof value !== 'string' || !value.trim() || value.trim().length > 40) invalid('Creative Brief 变体取值无效。')
      return value.trim()
    })
    const axisKey = optionalText(rawVariation.axisKey, 'Creative Brief 变体维度', 40)
    variation = { ...(axisKey ? { axisKey } : {}), values }
  }

  const provenance = {}
  const provenanceEntries = Object.entries(rawProvenance)
  if (provenanceEntries.length > botanicCreativeBriefFieldIds.length) invalid('Creative Brief 来源过多。')
  for (const [fieldId, source] of provenanceEntries) {
    if (!fieldIds.has(fieldId) || typeof source !== 'string' || !sources.has(source)) invalid('Creative Brief 来源无效。')
    provenance[fieldId] = source
  }

  return { version: 1, mode, originalInstruction, output, creative, ...(variation ? { variation } : {}), provenance }
}
