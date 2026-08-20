import type {
  GenerationAspectRatio,
  GenerationModelOption,
  GenerationResolution,
  GenerationSettings,
} from './canvas.ts'
import { customGenerationSizeFields } from './generationOutputSize.ts'

export type BotanicCreativeBriefMode = 'generation' | 'prompt'
export type BotanicCreativeBriefSource = 'user' | 'canvas' | 'memory' | 'skill' | 'inferred' | 'default'
export type BotanicDeliveryPreset = 'taobao' | 'xiaohongshu' | 'douyin' | 'custom'
export type BotanicPromptDirection = 'faithful' | 'commercial' | 'editorial' | 'social' | 'custom'
export type BotanicPreservationPriority = 'identity' | 'product' | 'garment' | 'balanced'

export type BotanicCreativeBriefFieldId =
  | 'model'
  | 'delivery_preset'
  | 'aspect_ratio'
  | 'resolution'
  | 'prompt_direction'
  | 'preservation_priority'
  | 'custom_direction'

export type BotanicAgentClarificationFieldId =
  | BotanicCreativeBriefFieldId
  | 'variation_values'
  | 'variation_combine'

export type BotanicAgentClarificationOption = {
  value: string
  label: string
  description?: string
}

export type BotanicAgentClarificationField = {
  id: BotanicAgentClarificationFieldId
  label: string
  required: boolean
  control?: 'single_choice' | 'text'
  defaultValue?: string
  placeholder?: string
  options: BotanicAgentClarificationOption[]
}

export type BotanicCreativeBrief = {
  version: 1
  mode: BotanicCreativeBriefMode
  originalInstruction: string
  output: {
    model?: string
    deliveryPreset?: BotanicDeliveryPreset
    aspectRatio?: GenerationAspectRatio
    resolution?: GenerationResolution
  }
  creative: {
    promptDirection?: BotanicPromptDirection
    preservationPriority?: BotanicPreservationPriority
    customDirection?: string
  }
  /**
   * 用户已确认的批量变体轴与取值。确认一次即长期有效：后续轮次据此直接展开分支，
   * 不再重复追问同一个维度。取值由变体模块解析后写入，这里只做承载。
   */
  variation?: {
    axisKey?: string
    values: string[]
  }
  provenance: Partial<Record<BotanicCreativeBriefFieldId, BotanicCreativeBriefSource>>
}

export type BotanicAgentClarification = {
  id: string
  question: string
  helper?: string
  originalInstruction: string
  sourcePromptMessageId?: string
  brief?: BotanicCreativeBrief
  fields: BotanicAgentClarificationField[]
}

type BriefGenerationModel = Pick<GenerationModelOption, 'id' | 'label' | 'mediaKind'> & {
  aspectRatios?: readonly GenerationAspectRatio[]
  resolutions?: readonly GenerationResolution[]
}

export type AdvanceBotanicCreativeBriefInput = {
  mode: BotanicCreativeBriefMode
  executionMode?: 'manual' | 'auto'
  instruction: string
  generationModels?: readonly BriefGenerationModel[]
  inheritedSettings?: Partial<Pick<GenerationSettings, 'model' | 'aspectRatio' | 'resolution' | 'outputWidth' | 'outputHeight'>>
  requestedSettings?: Partial<Pick<GenerationSettings, 'model' | 'aspectRatio' | 'resolution' | 'outputWidth' | 'outputHeight'>>
  previousBrief?: BotanicCreativeBrief
  answers?: Record<string, string>
  clarificationId?: string
}

export type BotanicCreativeBriefTurn =
  | { kind: 'ask'; brief: BotanicCreativeBrief; clarification: BotanicAgentClarification }
  | {
      kind: 'ready'
      brief: BotanicCreativeBrief
      settings: Partial<Pick<GenerationSettings, 'model' | 'aspectRatio' | 'resolution' | 'outputWidth' | 'outputHeight'>>
      prompt: string
    }
  | { kind: 'failed'; brief: BotanicCreativeBrief; code: string; message: string }

const deliveryOptions: BotanicAgentClarificationOption[] = [
  { value: 'taobao', label: '淘宝 / 天猫', description: '1:1 · 800×800' },
  { value: 'xiaohongshu', label: '小红书', description: '3:4 · 1242×1660' },
  { value: 'douyin', label: '抖音', description: '9:16 · 1080×1920' },
  { value: 'custom', label: '自定义比例' },
]

const promptDirectionOptions: BotanicAgentClarificationOption[] = [
  { value: 'faithful', label: '保真自然', description: '优先保持主体与原始特征' },
  { value: 'commercial', label: '商业广告', description: '强化商品表达与转化' },
  { value: 'editorial', label: '杂志氛围', description: '强化构图、光线与质感' },
  { value: 'social', label: '社媒种草', description: '更自然、生活化、适合分享' },
  { value: 'custom', label: '自定义方向' },
]

const deliveryRatios: Record<Exclude<BotanicDeliveryPreset, 'custom'>, GenerationAspectRatio> = {
  taobao: '1:1',
  xiaohongshu: '3:4',
  douyin: '9:16',
}

const deliveryLabels: Record<BotanicDeliveryPreset, string> = {
  taobao: '淘宝 / 天猫',
  xiaohongshu: '小红书',
  douyin: '抖音',
  custom: '自定义比例',
}

const promptDirectionLabels: Record<BotanicPromptDirection, string> = {
  faithful: '保真自然',
  commercial: '商业广告',
  editorial: '杂志氛围',
  social: '社媒种草',
  custom: '自定义方向',
}

const deliveryPresetValues = new Set<BotanicDeliveryPreset>(['taobao', 'xiaohongshu', 'douyin', 'custom'])
const promptDirectionValues = new Set<BotanicPromptDirection>(['faithful', 'commercial', 'editorial', 'social', 'custom'])
const preservationPriorityValues = new Set<BotanicPreservationPriority>(['identity', 'product', 'garment', 'balanced'])

const preservationLabels: Record<BotanicPreservationPriority, string> = {
  identity: '人物身份与五官',
  product: '商品主体与结构',
  garment: '服装款式与材质',
  balanced: '整体平衡',
}

function createBrief(input: AdvanceBotanicCreativeBriefInput): BotanicCreativeBrief {
  const inherited = input.inheritedSettings ?? {}
  const requested = input.requestedSettings ?? {}
  const model = requested.model ?? inherited.model
    ?? input.generationModels?.find((item) => item.mediaKind !== 'video')?.id
  const selectedModel = input.generationModels?.find((item) => item.id === model)
  const aspectRatio = requested.aspectRatio
    ?? (inherited.aspectRatio && supportsValue(selectedModel?.aspectRatios, inherited.aspectRatio)
      ? inherited.aspectRatio
      : undefined)
  const resolution = requested.resolution
    ?? (inherited.resolution && supportsValue(selectedModel?.resolutions, inherited.resolution)
      ? inherited.resolution
      : undefined)
  const brief: BotanicCreativeBrief = {
    version: 1,
    mode: input.mode,
    originalInstruction: input.instruction.trim(),
    output: {
      ...(model ? { model } : {}),
      ...(aspectRatio ? { aspectRatio } : {}),
      ...(resolution ? { resolution } : {}),
    },
    creative: {},
    provenance: {
      ...(model ? { model: requested.model ? 'user' : inherited.model ? 'canvas' : 'default' } : {}),
      ...(aspectRatio
        ? { aspect_ratio: requested.aspectRatio ? 'user' : 'canvas' }
        : {}),
      ...(resolution
        ? { resolution: requested.resolution ? 'user' : 'canvas' }
        : {}),
    },
  }
  inferInstruction(brief)
  return brief
}

function supportsValue<T extends string>(values: readonly T[] | undefined, value: string) {
  return !values?.length || values.some((item) => item === value)
}

function inferInstruction(brief: BotanicCreativeBrief) {
  const instruction = brief.originalInstruction
  const preset = /小红书/iu.test(instruction)
    ? 'xiaohongshu'
    : /淘宝|天猫/iu.test(instruction)
      ? 'taobao'
      : /抖音/iu.test(instruction)
        ? 'douyin'
        : undefined
  if (preset && !brief.output.deliveryPreset) {
    brief.output.deliveryPreset = preset
    brief.output.aspectRatio = deliveryRatios[preset]
    brief.provenance.delivery_preset = 'user'
    brief.provenance.aspect_ratio = 'inferred'
  }

  if (!brief.creative.promptDirection) {
    const direction: BotanicPromptDirection | undefined = /杂志|大片|editorial/iu.test(instruction)
      ? 'editorial'
      : /电商|广告|商业|转化|卖点/iu.test(instruction)
        ? 'commercial'
        : /社媒|种草|生活化|小红书|抖音/iu.test(instruction)
          ? 'social'
          : /保持|保留|不变|锁定|还原|一致|保真/iu.test(instruction)
            ? 'faithful'
            : undefined
    if (direction) {
      brief.creative.promptDirection = direction
      brief.provenance.prompt_direction = 'inferred'
    }
  }

  if (!brief.creative.preservationPriority) {
    const hasPreserveLanguage = /保持|保留|不变|锁定|还原|一致/iu.test(instruction)
    const priority: BotanicPreservationPriority | undefined = hasPreserveLanguage && /人物|模特|五官|脸|身份/iu.test(instruction)
      ? 'identity'
      : hasPreserveLanguage && /商品|产品|包装|瓶身/iu.test(instruction)
        ? 'product'
        : hasPreserveLanguage && /服装|衣服|款式|面料|材质/iu.test(instruction)
          ? 'garment'
          : undefined
    if (priority) {
      brief.creative.preservationPriority = priority
      brief.provenance.preservation_priority = 'inferred'
    }
  }
}

function mergeAnswers(
  brief: BotanicCreativeBrief,
  answers: Record<string, string> | undefined,
  models: readonly BriefGenerationModel[] | undefined,
) {
  if (!answers) return brief
  const next = structuredClone(brief)
  const answer = (id: BotanicAgentClarificationFieldId) => answers[id]?.trim()
  const modelId = answer('model')
  if (modelId) {
    next.output.model = modelId
    next.provenance.model = 'user'
  }
  const model = models?.find((item) => item.id === next.output.model)
  if (next.output.aspectRatio && !supportsValue(model?.aspectRatios, next.output.aspectRatio)) {
    delete next.output.aspectRatio
    delete next.provenance.aspect_ratio
  }
  if (next.output.resolution && !supportsValue(model?.resolutions, next.output.resolution)) {
    delete next.output.resolution
    delete next.provenance.resolution
  }
  const preset = answer('delivery_preset') as BotanicDeliveryPreset | undefined
  if (preset && deliveryPresetValues.has(preset)) {
    next.output.deliveryPreset = preset
    next.provenance.delivery_preset = 'user'
    if (preset !== 'custom') {
      next.output.aspectRatio = deliveryRatios[preset]
      next.provenance.aspect_ratio = 'inferred'
    }
  }
  const aspectRatio = answer('aspect_ratio') as GenerationAspectRatio | undefined
  if (aspectRatio && (!model?.aspectRatios?.length || model.aspectRatios.includes(aspectRatio))) {
    next.output.aspectRatio = aspectRatio
    next.provenance.aspect_ratio = 'user'
  }
  const resolution = answer('resolution') as GenerationResolution | undefined
  if (resolution && (!model?.resolutions?.length || model.resolutions.includes(resolution))) {
    next.output.resolution = resolution
    next.provenance.resolution = 'user'
  }
  const promptDirection = answer('prompt_direction') as BotanicPromptDirection | undefined
  if (promptDirection && promptDirectionValues.has(promptDirection)) {
    next.creative.promptDirection = promptDirection
    next.provenance.prompt_direction = 'user'
  }
  const preservationPriority = answer('preservation_priority') as BotanicPreservationPriority | undefined
  if (preservationPriority && preservationPriorityValues.has(preservationPriority)) {
    next.creative.preservationPriority = preservationPriority
    next.provenance.preservation_priority = 'user'
  }
  const customDirection = answer('custom_direction')
  if (customDirection) {
    next.creative.customDirection = customDirection.slice(0, 500)
    next.provenance.custom_direction = 'user'
  }
  return next
}

function compileBriefPrompt(brief: BotanicCreativeBrief) {
  const details: string[] = []
  if (brief.output.deliveryPreset) {
    details.push(`交付用途：${deliveryLabels[brief.output.deliveryPreset]}${brief.output.aspectRatio ? `，画面比例 ${brief.output.aspectRatio}` : ''}`)
  }
  if (brief.creative.promptDirection) {
    const direction = brief.creative.promptDirection === 'custom' && brief.creative.customDirection
      ? brief.creative.customDirection
      : promptDirectionLabels[brief.creative.promptDirection]
    details.push(`Prompt 优化方向：${direction}`)
  }
  if (brief.creative.preservationPriority) details.push(`保持重点：${preservationLabels[brief.creative.preservationPriority]}`)
  return details.length ? `${brief.originalInstruction}\n\n创作简报：\n- ${details.join('\n- ')}` : brief.originalInstruction
}

function completeAutomaticBrief(brief: BotanicCreativeBrief, model: BriefGenerationModel | undefined) {
  if (!brief.output.aspectRatio && brief.output.deliveryPreset !== 'custom') {
    const ratio = model?.aspectRatios?.[0]
    if (ratio) {
      brief.output.aspectRatio = ratio
      brief.provenance.aspect_ratio = 'default'
    }
  }
  if (!brief.output.resolution) {
    const resolution = model?.resolutions?.includes('2K') ? '2K' : model?.resolutions?.[0]
    if (resolution) {
      brief.output.resolution = resolution
      brief.provenance.resolution = 'default'
    }
  }
  if (!brief.creative.promptDirection) {
    brief.creative.promptDirection = 'faithful'
    brief.provenance.prompt_direction = 'default'
  }
}

export function advanceBotanicCreativeBrief(input: AdvanceBotanicCreativeBriefInput): BotanicCreativeBriefTurn {
  const current = input.previousBrief ? structuredClone(input.previousBrief) : createBrief(input)
  if (input.mode === 'generation') {
    const models = input.generationModels ?? []
    if (!models.length) {
      return { kind: 'failed', brief: current, code: 'NO_IMAGE_MODEL', message: '当前没有可用的图片模型，请先检查模型配置。' }
    }
    const selectedModelId = input.answers?.model?.trim() || current.output.model
    const selectedModel = models.find((item) => item.id === selectedModelId)
    if (!selectedModel) {
      return { kind: 'failed', brief: current, code: 'MODEL_UNAVAILABLE', message: '所选图片模型当前不可用，请重新选择。' }
    }
    const requestedAspectRatio = input.answers?.aspect_ratio?.trim() || input.requestedSettings?.aspectRatio
    if (requestedAspectRatio && !supportsValue(selectedModel.aspectRatios, requestedAspectRatio)) {
      return { kind: 'failed', brief: current, code: 'ASPECT_RATIO_UNSUPPORTED', message: '所选模型不支持这个画面比例，请重新选择。' }
    }
    const requestedResolution = input.answers?.resolution?.trim() || input.requestedSettings?.resolution
    if (requestedResolution && !supportsValue(selectedModel.resolutions, requestedResolution)) {
      return { kind: 'failed', brief: current, code: 'RESOLUTION_UNSUPPORTED', message: '所选模型不支持这个分辨率，请重新选择。' }
    }
    const requestedPreset = input.answers?.delivery_preset?.trim() as BotanicDeliveryPreset | undefined
    if (requestedPreset && !deliveryPresetValues.has(requestedPreset)) {
      return { kind: 'failed', brief: current, code: 'DELIVERY_PRESET_UNSUPPORTED', message: '这个交付用途当前不受支持，请重新选择。' }
    }
    if (requestedPreset && requestedPreset !== 'custom' && !supportsValue(selectedModel.aspectRatios, deliveryRatios[requestedPreset])) {
      return { kind: 'failed', brief: current, code: 'DELIVERY_PRESET_UNSUPPORTED', message: '所选模型不支持这个交付用途所需的画面比例。' }
    }
  }
  const brief = mergeAnswers(current, input.answers, input.generationModels)
  const model = input.generationModels?.find((item) => item.id === brief.output.model)
  if (input.executionMode === 'auto') completeAutomaticBrief(brief, model)
  const resolutions = model?.resolutions?.length ? [...model.resolutions] : ['1K', '2K'] as GenerationResolution[]
  const fields: BotanicAgentClarificationField[] = []
  if (input.mode === 'generation' && !brief.output.aspectRatio) {
    if (brief.output.deliveryPreset === 'custom') {
      const aspectRatios = model?.aspectRatios?.length ? [...model.aspectRatios] : ['1:1', '16:9', '4:3', '3:4', '4:5', '9:16'] as GenerationAspectRatio[]
      fields.push({
        id: 'aspect_ratio',
        label: '图片比例',
        required: true,
        control: 'single_choice',
        defaultValue: aspectRatios[0],
        options: aspectRatios.map((value) => ({ value, label: value })),
      })
    } else {
      const availableDeliveryOptions = deliveryOptions.filter((option) => option.value === 'custom'
        || !model?.aspectRatios?.length
        || model.aspectRatios.includes(deliveryRatios[option.value as Exclude<BotanicDeliveryPreset, 'custom'>]))
      fields.push({
        id: 'delivery_preset',
        label: '用途与画面比例',
        required: true,
        control: 'single_choice',
        defaultValue: availableDeliveryOptions.some((option) => option.value === 'xiaohongshu')
          ? 'xiaohongshu'
          : availableDeliveryOptions[0]?.value,
        options: availableDeliveryOptions,
      })
    }
  }
  if (input.mode === 'generation' && !brief.output.resolution) {
    fields.push({
      id: 'resolution',
      label: '清晰度',
      required: true,
      control: 'single_choice',
      defaultValue: resolutions.includes('2K') ? '2K' : resolutions[0],
      options: resolutions.map((value) => ({ value, label: value, description: value === '2K' ? '推荐' : '生成更快' })),
    })
  }
  if (brief.creative.promptDirection === 'custom' && !brief.creative.customDirection) {
    fields.push({
      id: 'custom_direction',
      label: '自定义优化方向',
      required: true,
      control: 'text',
      placeholder: '例如：克制的电影感，保留自然肤质',
      options: [],
    })
  } else if (!brief.creative.promptDirection) {
    fields.push({
      id: 'prompt_direction',
      label: 'Prompt 优化方向',
      required: true,
      control: 'single_choice',
      defaultValue: 'faithful',
      options: promptDirectionOptions,
    })
  }
  if (fields.length) {
    const clarification: BotanicAgentClarification = {
      id: input.clarificationId ?? `clarification-${crypto.randomUUID()}`,
      question: '我先确认几个会明显影响结果的设置。',
      helper: '已知项会直接沿用；确认后先整理 Prompt 与计划，不会立即生成。',
      originalInstruction: brief.originalInstruction,
      brief,
      fields: fields.slice(0, 3),
    }
    return { kind: 'ask', brief, clarification }
  }
  return {
    kind: 'ready',
    brief,
    settings: {
      ...(brief.output.model ? { model: brief.output.model } : {}),
      ...(brief.output.aspectRatio ? { aspectRatio: brief.output.aspectRatio } : {}),
      ...(brief.output.resolution ? { resolution: brief.output.resolution } : {}),
      ...(customGenerationSizeFields(input.requestedSettings) ?? customGenerationSizeFields(input.inheritedSettings) ?? {}),
    },
    prompt: compileBriefPrompt(brief),
  }
}
