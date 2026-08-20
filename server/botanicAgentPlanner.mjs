import { AgentToolRuntimeError, runAgentToolLoop } from './agentToolRuntime.mjs'
import { createBotanicAgentPlanningToolRegistry } from './botanicAgentTools.mjs'
import { readBotanicAgentInstructions } from './agentInstructions.mjs'
import {
  botanicCreativeBriefFieldIds,
  BotanicCreativeBriefValidationError,
  validateBotanicCreativeBrief,
} from './botanicCreativeBrief.mjs'
import {
  applyBotanicAgentVariationToPlan,
  botanicAgentLooksLikePlannerNarration,
  botanicAgentVariationClarificationFieldIds,
  mergeVariationClarification,
} from './botanicAgentVariations.mjs'
import {
  inferAspectRatioFromPixels,
  modelSupportsCustomSize,
  normalizeCustomGenerationSize,
} from './generationOutputSize.mjs'

const INTENTS = new Set([
  'continue_generation', 'replace_scene', 'replace_person', 'replace_product',
  'change_pose', 'change_style', 'batch_variation', 'redo_from_root', 'region_edit',
])
const DIMENSIONS = new Set([
  'person', 'garment', 'product', 'scene', 'style', 'pose',
  'composition', 'lighting', 'aspect_ratio', 'copy_space',
])
const MODES = new Set(['preserve', 'vary'])
const ASPECT_RATIOS = ['1:1', '16:9', '4:3', '3:4', '4:5', '9:16']
const RESOLUTIONS = ['1K', '2K']
const CLARIFICATION_FIELDS = new Set([...botanicCreativeBriefFieldIds, ...botanicAgentVariationClarificationFieldIds])
const DELIVERY_OPTIONS = [
  { value: 'taobao', label: '淘宝 / 天猫', description: '1:1 · 800×800' },
  { value: 'xiaohongshu', label: '小红书', description: '3:4 · 1242×1660' },
  { value: 'douyin', label: '抖音', description: '9:16 · 1080×1920' },
  { value: 'custom', label: '自定义比例' },
]
const PROMPT_DIRECTION_OPTIONS = [
  { value: 'faithful', label: '保真自然', description: '优先保持主体与原始特征' },
  { value: 'commercial', label: '商业广告', description: '强化商品表达与转化' },
  { value: 'editorial', label: '杂志氛围', description: '强化构图、光线与质感' },
  { value: 'social', label: '社媒种草', description: '自然、生活化、适合分享' },
  { value: 'custom', label: '自定义方向' },
]
const PRESERVATION_OPTIONS = [
  { value: 'identity', label: '人物身份与五官' },
  { value: 'product', label: '商品主体与结构' },
  { value: 'garment', label: '服装款式与材质' },
  { value: 'balanced', label: '整体平衡' },
]
const MEMORY_KINDS = new Set(['rule', 'approved', 'avoid'])
const CONTEXT_KINDS = new Set(['素材', '结果', '文字', '节点'])
const MEDIA_KINDS = new Set(['image', 'video'])
const GROUP_DIMENSIONS = new Map([
  ['场景', 'scene'], ['模特', 'person'], ['商品', 'product'], ['调性', 'style'],
])
const NODE_TITLE_LIMIT = 8
/** 单次（非素材组批量）生成的张数上限，与 BOTANIC_AGENT_MAX_SINGLE_OUTPUT 对齐。 */
const MAX_SINGLE_OUTPUT = 8
const VARY_TITLE = Object.freeze({
  person: '换人物', garment: '换服装', product: '换商品', scene: '换场景', style: '换风格',
  pose: '换动作', composition: '调构图', lighting: '调光线', aspect_ratio: '改比例', copy_space: '调留白',
})
const VARY_SHORT_TITLE = Object.freeze({
  person: '换人', garment: '换装', product: '换品', scene: '换景', style: '换风',
  pose: '换姿', composition: '构图', lighting: '调光', aspect_ratio: '比例', copy_space: '留白',
})
const DEFAULT_AGENT_MODELS = ['deepseek-v4-pro', 'deepseek-v4-flash', 'kimi-k3']

export class BotanicAgentPlannerError extends Error {
  constructor(statusCode, code, message) {
    super(message)
    this.name = 'BotanicAgentPlannerError'
    this.statusCode = statusCode
    this.code = code
  }
}

function invalidRequest(message) {
  throw new BotanicAgentPlannerError(400, 'INVALID_REQUEST', message)
}

function requiredText(value, name, maximumLength) {
  if (typeof value !== 'string' || !value.trim()) invalidRequest(`${name}不能为空。`)
  const text = value.trim()
  if (text.length > maximumLength) invalidRequest(`${name}过长。`)
  return text
}

function optionalText(value, name, maximumLength) {
  if (value === undefined) return undefined
  return requiredText(value, name, maximumLength)
}

function hasMediaPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.keys(value).some((key) => {
    const normalized = key.toLowerCase().replace(/[-_]/g, '')
    return ['image', 'dataurl', 'imageurl', 'imagedata', 'base64', 'buffer', 'blob', 'file', 'bytes', 'src', 'url', 'mediaid'].includes(normalized)
  })
}

function structuredObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidRequest(`${name}无效。`)
  if (hasMediaPayload(value)) invalidRequest('Agent 计划不接收图片数据。')
  return value
}

function boundedRecord(value, name, maximumEntries = 8) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidRequest(`${name}无效。`)
  const entries = Object.entries(value)
  if (entries.length > maximumEntries) invalidRequest(`${name}过多。`)
  return Object.fromEntries(entries.map(([key, item]) => {
    const cleanKey = requiredText(key, `${name}字段`, 40)
    if (!CLARIFICATION_FIELDS.has(cleanKey)) invalidRequest(`${name}字段不支持。`)
    return [cleanKey, requiredText(item, `${name}值`, cleanKey === 'custom_direction' || cleanKey === 'variation_values' ? 500 : 160)]
  }))
}

function validateGenerationModels(value) {
  if (!Array.isArray(value) || value.length > 30) invalidRequest('可用生成模型无效。')
  return value.map((rawModel, index) => {
    const model = structuredObject(rawModel, `第 ${index + 1} 个生成模型`)
    const result = {
      id: requiredText(model.id, `第 ${index + 1} 个生成模型 ID`, 160),
      label: requiredText(model.label, `第 ${index + 1} 个生成模型名称`, 160),
    }
    if (model.provider !== undefined) result.provider = requiredText(model.provider, '模型厂商', 40)
    if (model.mediaKind !== undefined) result.mediaKind = requiredText(model.mediaKind, '模型类型', 40)
    if (model.aspectRatios !== undefined) {
      if (!Array.isArray(model.aspectRatios) || model.aspectRatios.some((ratio) => !ASPECT_RATIOS.includes(ratio))) invalidRequest('模型比例目录无效。')
      result.aspectRatios = [...new Set(model.aspectRatios)]
    }
    if (model.resolutions !== undefined) {
      if (!Array.isArray(model.resolutions) || model.resolutions.some((resolution) => !RESOLUTIONS.includes(resolution))) invalidRequest('模型分辨率目录无效。')
      result.resolutions = [...new Set(model.resolutions)]
    }
    if (model.supportsCustomSize !== undefined) {
      if (typeof model.supportsCustomSize !== 'boolean') invalidRequest('模型自定义尺寸标记无效。')
      result.supportsCustomSize = model.supportsCustomSize
    }
    return result
  })
}

function optionalCustomSize(raw, model) {
  const hasWidth = raw.outputWidth !== undefined
  const hasHeight = raw.outputHeight !== undefined
  if (!hasWidth && !hasHeight) return {}
  if (!hasWidth || !hasHeight) invalidRequest('自定义宽高必须同时提供。')
  if (!modelSupportsCustomSize(model)) invalidRequest('当前模型不支持自定义像素。')
  const normalized = normalizeCustomGenerationSize(Number(raw.outputWidth), Number(raw.outputHeight))
  if (!normalized.ok) invalidRequest(normalized.message)
  return { outputWidth: normalized.width, outputHeight: normalized.height }
}

export function validateBotanicAgentPlanInput(raw) {
  const input = structuredObject(raw, 'Agent 计划请求')
  const projectId = requiredText(input.projectId, '项目', 160)
  const plannerModel = optionalText(input.plannerModel, 'Agent 模型', 160)
  const instruction = requiredText(input.instruction, '修改要求', 4000)
  // 用户原话：综合 Prompt 链路里 instruction 是模型写的画面描述，变体轴只允许从原话解析。
  const sourceInstruction = optionalText(input.sourceInstruction, '用户原话', 4000)
  const requestedIntent = optionalText(input.requestedIntent, '操作类型', 80)
  if (requestedIntent && !INTENTS.has(requestedIntent)) invalidRequest('操作类型不支持。')

  const selected = structuredObject(input.selectedResult, '当前结果')
  const selectedResult = {
    nodeId: requiredText(selected.nodeId, '结果节点', 160),
    label: requiredText(selected.label, '结果名称', 160),
  }
  const settingsValue = structuredObject(input.settings, '生成参数')
  const settings = {
    model: requiredText(settingsValue.model, '模型', 160),
    aspectRatio: requiredText(settingsValue.aspectRatio, '比例', 32),
    resolution: requiredText(settingsValue.resolution, '分辨率', 32),
    ...optionalCustomSize(settingsValue, { id: requiredText(settingsValue.model, '模型', 160) }),
  }
  if (settings.outputWidth && settings.outputHeight) {
    settings.aspectRatio = inferAspectRatioFromPixels(settings.outputWidth, settings.outputHeight)
  }

  let generationModels
  if (input.generationModels !== undefined) generationModels = validateGenerationModels(input.generationModels)
  let generationOverrides
  if (input.generationOverrides !== undefined) {
    const overrides = structuredObject(input.generationOverrides, '生成参数覆盖')
    generationOverrides = {}
    if (overrides.model !== undefined) generationOverrides.model = requiredText(overrides.model, '覆盖模型', 160)
    if (overrides.aspectRatio !== undefined) {
      generationOverrides.aspectRatio = requiredText(overrides.aspectRatio, '覆盖比例', 32)
      if (!ASPECT_RATIOS.includes(generationOverrides.aspectRatio)) invalidRequest('覆盖比例不支持。')
    }
    if (overrides.resolution !== undefined) {
      generationOverrides.resolution = requiredText(overrides.resolution, '覆盖分辨率', 32)
      if (!RESOLUTIONS.includes(generationOverrides.resolution)) invalidRequest('覆盖分辨率不支持。')
    }
    Object.assign(generationOverrides, optionalCustomSize(overrides, { id: overrides.model ?? settings.model }))
    if (generationOverrides.outputWidth && generationOverrides.outputHeight) {
      generationOverrides.aspectRatio = inferAspectRatioFromPixels(
        generationOverrides.outputWidth,
        generationOverrides.outputHeight,
      )
    }
    if (generationOverrides.model !== undefined) {
      const allowedModels = new Set((generationModels ?? []).map((model) => model.id))
      if (generationOverrides.model !== settings.model && !allowedModels.has(generationOverrides.model)) invalidRequest('覆盖模型不在可用目录中。')
    }
  }
  const effectiveSettings = { ...settings, ...generationOverrides }
  if (!modelSupportsCustomSize(effectiveSettings.model)) {
    delete effectiveSettings.outputWidth
    delete effectiveSettings.outputHeight
  }
  if (generationModels?.length) {
    const selectedModel = generationModels.find((model) => model.id === effectiveSettings.model)
    if (!selectedModel) invalidRequest('当前模型不在可用目录中。')
    if (selectedModel.aspectRatios?.length && !selectedModel.aspectRatios.includes(effectiveSettings.aspectRatio)) {
      invalidRequest('当前比例不受所选模型支持。')
    }
    if (selectedModel.resolutions?.length && !selectedModel.resolutions.includes(effectiveSettings.resolution)) {
      invalidRequest('当前分辨率不受所选模型支持。')
    }
  }
  const clarificationAnswers = input.clarificationAnswers === undefined
    ? undefined
    : boundedRecord(input.clarificationAnswers, '参数确认答案')
  let creativeBrief
  if (input.creativeBrief !== undefined) {
    try {
      creativeBrief = validateBotanicCreativeBrief(input.creativeBrief)
    } catch (caught) {
      if (caught instanceof BotanicCreativeBriefValidationError) invalidRequest(caught.message)
      throw caught
    }
    if (creativeBrief.mode !== 'generation') invalidRequest('生图计划只接受生成模式 Creative Brief。')
    if (creativeBrief.output.model && creativeBrief.output.model !== effectiveSettings.model) invalidRequest('Creative Brief 模型与生成参数冲突。')
    if (creativeBrief.output.aspectRatio && creativeBrief.output.aspectRatio !== effectiveSettings.aspectRatio) invalidRequest('Creative Brief 比例与生成参数冲突。')
    if (creativeBrief.output.resolution && creativeBrief.output.resolution !== effectiveSettings.resolution) invalidRequest('Creative Brief 分辨率与生成参数冲突。')
  }
  const mountedSkillIds = input.mountedSkillIds === undefined
    ? undefined
    : (() => {
      if (!Array.isArray(input.mountedSkillIds) || input.mountedSkillIds.length > 16) invalidRequest('已挂载 Skill 无效。')
      return [...new Set(input.mountedSkillIds.map((id, index) => requiredText(id, `第 ${index + 1} 个已挂载 Skill`, 160)))]
    })()

  if (!Array.isArray(input.references) || input.references.length > 16) invalidRequest('参考信息无效。')
  const references = input.references.map((rawReference, index) => {
    const reference = structuredObject(rawReference, `第 ${index + 1} 条参考`)
    if (typeof reference.primary !== 'boolean') invalidRequest(`第 ${index + 1} 条主参考标记无效。`)
    return {
      id: requiredText(reference.id, `第 ${index + 1} 条参考 ID`, 160),
      name: requiredText(reference.name, `第 ${index + 1} 条参考名称`, 160),
      role: requiredText(reference.role, `第 ${index + 1} 条参考角色`, 80),
      primary: reference.primary,
    }
  })

  let assetGroup
  const validateAssetGroup = (rawGroup, name) => {
    const group = structuredObject(rawGroup, name)
    if (!Number.isInteger(group.assetCount) || group.assetCount < 1 || group.assetCount > 100) invalidRequest(`${name}数量无效。`)
    return {
      id: requiredText(group.id, `${name} ID`, 160),
      name: requiredText(group.name, `${name}名称`, 160),
      role: requiredText(group.role, `${name}角色`, 80),
      assetCount: group.assetCount,
    }
  }
  if (input.assetGroup !== undefined) {
    assetGroup = validateAssetGroup(input.assetGroup, '素材组')
  }
  if (input.assetGroups !== undefined && (!Array.isArray(input.assetGroups) || input.assetGroups.length > 50)) invalidRequest('可用素材组无效。')
  const assetGroups = Array.isArray(input.assetGroups)
    ? input.assetGroups.map((group, index) => validateAssetGroup(group, `第 ${index + 1} 个可用素材组`))
    : undefined

  if (input.projectMemory !== undefined && (!Array.isArray(input.projectMemory) || input.projectMemory.length > 30)) {
    invalidRequest('项目记忆无效。')
  }
  const projectMemory = Array.isArray(input.projectMemory)
    ? input.projectMemory.map((rawMemory, index) => {
      const memory = structuredObject(rawMemory, `第 ${index + 1} 条项目记忆`)
      const kind = requiredText(memory.kind, `第 ${index + 1} 条项目记忆类型`, 32)
      if (!MEMORY_KINDS.has(kind)) invalidRequest('项目记忆类型无效。')
      return {
        id: requiredText(memory.id, `第 ${index + 1} 条项目记忆 ID`, 160),
        kind,
        content: requiredText(memory.content, `第 ${index + 1} 条项目记忆内容`, 1000),
      }
    })
    : undefined

  const contextSnapshot = input.contextSnapshot === undefined
    ? undefined
    : (() => {
      if (!Array.isArray(input.contextSnapshot) || input.contextSnapshot.length > 16) invalidRequest('上下文快照无效。')
      const seen = new Set()
      return input.contextSnapshot.map((rawItem, index) => {
        const item = structuredObject(rawItem, `第 ${index + 1} 个上下文`)
        const nodeId = requiredText(item.nodeId, `第 ${index + 1} 个上下文节点`, 160)
        if (seen.has(nodeId)) invalidRequest('上下文快照包含重复节点。')
        seen.add(nodeId)
        const kind = requiredText(item.kind, `第 ${index + 1} 个上下文类型`, 16)
        if (!CONTEXT_KINDS.has(kind)) invalidRequest('上下文类型无效。')
        const result = {
          nodeId,
          label: requiredText(item.label, `第 ${index + 1} 个上下文名称`, 160),
          kind,
        }
        if (item.mediaKind !== undefined) {
          const mediaKind = requiredText(item.mediaKind, `第 ${index + 1} 个媒体类型`, 16)
          if (!MEDIA_KINDS.has(mediaKind)) invalidRequest('媒体类型无效。')
          result.mediaKind = mediaKind
        }
        if (item.role !== undefined) result.role = requiredText(item.role, `第 ${index + 1} 个上下文角色`, 80)
        // 文字节点的正文是用户写下的创作说明，规划时作为补充描述使用。
        if (item.note !== undefined) result.note = requiredText(item.note, `第 ${index + 1} 个上下文补充描述`, 500)
        return result
      })
    })()

  const parentPrompt = optionalText(input.parentPrompt, '父图提示词', 6000)

  // 本轮请求的张数。素材组批量由素材数决定，这里只约束单次生成要出几张。
  let outputCount
  if (input.outputCount !== undefined) {
    const parsed = Number(input.outputCount)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_SINGLE_OUTPUT) invalidRequest('生成张数无效。')
    outputCount = parsed
  }

  return {
    projectId,
    ...(plannerModel ? { plannerModel } : {}),
    instruction,
    ...(sourceInstruction ? { sourceInstruction } : {}),
    ...(requestedIntent ? { requestedIntent } : {}),
    selectedResult,
    settings: effectiveSettings,
    references,
    ...(assetGroup ? { assetGroup } : {}),
    ...(assetGroups ? { assetGroups } : {}),
    ...(projectMemory?.length ? { projectMemory } : {}),
    ...(generationModels ? { generationModels } : {}),
    ...(generationOverrides ? { generationOverrides } : {}),
    ...(clarificationAnswers ? { clarificationAnswers } : {}),
    ...(creativeBrief ? { creativeBrief } : {}),
    ...(mountedSkillIds?.length ? { mountedSkillIds } : {}),
    ...(contextSnapshot?.length ? { contextSnapshot } : {}),
    ...(parentPrompt ? { parentPrompt } : {}),
    ...(outputCount ? { outputCount } : {}),
  }
}

export function botanicAgentProviderConfig(runtimeConfig, requestedModel) {
  const baseUrl = typeof runtimeConfig?.flockApiBaseUrl === 'string'
    ? runtimeConfig.flockApiBaseUrl.trim().replace(/\/+$/, '')
    : 'https://api.flock.io/v1'
  const apiKey = typeof runtimeConfig?.flockApiKey === 'string' ? runtimeConfig.flockApiKey.trim() : ''
  const defaultModel = typeof runtimeConfig?.flockTextModel === 'string' ? runtimeConfig.flockTextModel.trim() : ''
  const allowedModels = Array.isArray(runtimeConfig?.flockAgentModels)
    ? [...new Set(runtimeConfig.flockAgentModels.filter((model) => typeof model === 'string').map((model) => model.trim()).filter(Boolean))]
    : [...new Set([defaultModel, ...DEFAULT_AGENT_MODELS].filter(Boolean))]
  if (requestedModel && !allowedModels.includes(requestedModel)) invalidRequest('Agent 模型不在可用目录中。')
  const model = requestedModel || defaultModel || allowedModels[0] || ''
  if (!apiKey || !model) {
    throw new BotanicAgentPlannerError(503, 'PROVIDER_NOT_CONFIGURED', '生图 Agent 规划服务尚未配置。')
  }
  return {
    baseUrl,
    apiKey,
    model,
    timeoutMs: Number.isFinite(Number(runtimeConfig?.agentPlannerTimeoutMs))
      ? Math.min(60_000, Math.max(1_000, Number(runtimeConfig.agentPlannerTimeoutMs)))
      : 30_000,
  }
}

export function botanicAgentProviderResponseError(status) {
  if (status === 401 || status === 403) return new BotanicAgentPlannerError(502, 'PROVIDER_AUTH_FAILED', '生图 Agent 规划服务鉴权失败。')
  if (status === 429) return new BotanicAgentPlannerError(429, 'PROVIDER_RATE_LIMITED', '生图 Agent 当前繁忙，请稍后重试。')
  if (status >= 500) return new BotanicAgentPlannerError(502, 'PROVIDER_UNAVAILABLE', '生图 Agent 暂时不可用，请稍后重试。')
  return new BotanicAgentPlannerError(422, 'PROVIDER_REJECTED', '生图 Agent 无法处理本次要求。')
}

export function botanicAgentProviderTemperature(model) {
  return model === 'kimi-k3' ? 1 : 0.1
}

function parseProviderJson(content) {
  if (typeof content !== 'string' || !content.trim()) return undefined
  const text = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function providerText(value, maximumLength) {
  return typeof value === 'string' && value.trim() && value.trim().length <= maximumLength ? value.trim() : undefined
}

function clipNodeTitle(value) {
  if (typeof value !== 'string') return ''
  return Array.from(value.replace(/[\s·.,，。:：；;、\-_/\\]+/gu, '')).slice(0, NODE_TITLE_LIMIT).join('')
}

/** 创作简报附录是给规划器的上下文，不是画面描述；与客户端 compileBriefPrompt 的格式对应。 */
function stripCreativeBriefNotes(text) {
  return text.replace(/\n{2,}创作简报：[\s\S]*$/u, '').trim()
}

export function visualGenerationPrompt(prompt, fallback = '') {
  const text = typeof prompt === 'string' ? stripCreativeBriefNotes(prompt.trim()) : ''
  const blocks = text.split(/\n{2,}/u).map((block) => block.trim()).filter(Boolean)
  const visual = blocks.filter((block) => !botanicAgentLooksLikePlannerNarration(block)).join('\n\n').trim()
  if (visual && !botanicAgentLooksLikePlannerNarration(visual)) return visual
  const fallbackText = typeof fallback === 'string' ? stripCreativeBriefNotes(fallback.trim()) : ''
  if (fallbackText && !botanicAgentLooksLikePlannerNarration(fallbackText)) return fallbackText
  return visual || fallbackText || text
}

function summarizeNodeTitle(intent, constraints, preferred) {
  const named = clipNodeTitle(preferred)
  if (named) return named
  const vary = constraints.filter((item) => item.mode === 'vary')
  if (vary.length === 1) return clipNodeTitle(VARY_TITLE[vary[0].dimension] ?? '新版本')
  if (vary.length > 1) return clipNodeTitle(vary.map((item) => VARY_SHORT_TITLE[item.dimension] ?? '').join('')) || '新版本'
  return clipNodeTitle(intent === 'replace_scene' ? '替换场景' : intent === 'change_pose' ? '调整动作' : '新版本') || '新版本'
}

function normalizeProviderPlan(raw, input) {
  const providerIntent = providerText(raw?.intent, 80)
  const intent = input.requestedIntent ?? providerIntent
  const prompt = providerText(raw?.prompt, 6000)
  const summary = providerText(raw?.summary, 240)
  if (!intent || !INTENTS.has(intent) || !prompt || !summary || !Array.isArray(raw?.constraints)) {
    throw new BotanicAgentPlannerError(502, 'INVALID_PROVIDER_RESPONSE', '生图 Agent 没有返回可执行计划。')
  }
  const requestedGroupId = providerText(raw?.assetGroupId, 160)
  const assetGroup = input.assetGroup
    ?? input.assetGroups?.find((group) => group.id === requestedGroupId)
  const groupDimension = assetGroup ? GROUP_DIMENSIONS.get(assetGroup.role) : undefined
  const seen = new Set()
  const constraints = []
  for (const item of raw.constraints) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    if (!DIMENSIONS.has(item.dimension) || !MODES.has(item.mode) || seen.has(item.dimension)) continue
    seen.add(item.dimension)
    constraints.push({
      dimension: item.dimension,
      mode: item.mode,
      ...(item.mode === 'vary' && groupDimension === item.dimension ? { sourceAssetGroupId: assetGroup.id } : {}),
    })
  }
  if (!constraints.length || !constraints.some((item) => item.mode === 'vary')) {
    throw new BotanicAgentPlannerError(502, 'INVALID_PROVIDER_RESPONSE', '生图 Agent 没有返回可执行计划。')
  }
  const selectedAssetGroup = assetGroup && constraints.some((item) => item.sourceAssetGroupId === assetGroup.id)
    ? assetGroup
    : undefined
  const batchCount = selectedAssetGroup?.assetCount ?? 0
  // 计划里的提示词只能是画面描述。模型和用户本轮都只给了规划旁白时，宁可让这轮失败重来，
  // 也不能把「结论 / 依据 / 待确认」这类说明文当成提示词提交给生图 Provider。
  const visualPrompt = visualGenerationPrompt(prompt, input.instruction)
  if (!visualPrompt) {
    throw new BotanicAgentPlannerError(
      422,
      'PROMPT_NOT_VISUAL',
      '这轮只拿到规划说明，没有可执行的画面描述。请直接说明画面要改成什么样。',
    )
  }
  const plan = {
    intent,
    instruction: input.instruction,
    summary,
    title: summarizeNodeTitle(intent, constraints, raw?.title),
    ...(input.creativeBrief ? { creativeBrief: structuredClone(input.creativeBrief) } : {}),
    selectedResultNodeId: input.selectedResult.nodeId,
    constraints,
    prompt: visualPrompt,
    settings: input.settings,
    output: batchCount
      ? { mode: 'batch_by_asset', count: batchCount, candidatesPerItem: 1 }
      : { mode: 'single', count: input.outputCount ?? 1, candidatesPerItem: 1 },
    ...(input.contextSnapshot?.length ? { contextSnapshot: input.contextSnapshot } : {}),
    ...(selectedAssetGroup ? { assetGroupId: selectedAssetGroup.id } : {}),
  }
  const applied = applyBotanicAgentVariationToPlan(plan, {
    // 变体轴只从用户原话解析；综合 Prompt 里的「两张」等字样会把模型 prose 挖成伪变体。
    instruction: input.sourceInstruction || input.instruction,
    requestedIntent: input.requestedIntent,
    clarificationAnswers: input.clarificationAnswers,
    brief: input.creativeBrief,
    assetGroup: selectedAssetGroup ?? input.assetGroup,
    fallbackPrompt: input.parentPrompt,
  })
  if (applied.kind === 'clarification') return { kind: 'clarification', clarification: applied.clarification }
  return applied.plan
}

function clarificationOptions(fieldId, input) {
  if (fieldId === 'variation_values') return []
  if (fieldId === 'variation_combine') {
    return [
      { value: 'first', label: '只拆一条轴', description: '默认不把多轴相乘' },
      { value: 'combine', label: '组合出图', description: '先写明张数，最多 20 张' },
    ]
  }
  if (fieldId === 'delivery_preset') return DELIVERY_OPTIONS
  if (fieldId === 'prompt_direction') return PROMPT_DIRECTION_OPTIONS
  if (fieldId === 'preservation_priority') return PRESERVATION_OPTIONS
  if (fieldId === 'custom_direction') return []
  if (fieldId === 'model') {
    const models = input.generationModels?.length
      ? input.generationModels
      : [{ id: input.settings.model, label: input.settings.model }]
    return models.map((model) => ({
      value: model.id,
      label: model.label,
      ...(model.mediaKind ? { description: model.mediaKind === 'video' ? '视频生成' : '图片生成' } : {}),
    }))
  }
  if (fieldId === 'aspect_ratio') {
    const model = input.generationModels?.find((item) => item.id === input.settings.model)
    const values = model?.aspectRatios?.length ? model.aspectRatios : ASPECT_RATIOS
    return values.map((value) => ({ value, label: value, description: value === input.settings.aspectRatio ? '沿用当前比例' : undefined })).filter((item) => item.description || item.value)
  }
  const model = input.generationModels?.find((item) => item.id === input.settings.model)
  const values = model?.resolutions?.length ? model.resolutions : RESOLUTIONS
  return values.map((value) => ({ value, label: value, description: value === input.settings.resolution ? '沿用当前分辨率' : undefined }))
}

function normalizeProviderClarification(raw, input, toolCallId) {
  const question = providerText(raw?.question, 240)
  if (!question || !Array.isArray(raw?.fields)) {
    throw new BotanicAgentPlannerError(502, 'INVALID_PROVIDER_RESPONSE', '生图 Agent 没有返回有效的确认问题。')
  }
  const seen = new Set()
  const fields = raw.fields.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const id = providerText(item.id, 40)
    if (!id || !CLARIFICATION_FIELDS.has(id) || seen.has(id)) return []
    seen.add(id)
    const options = clarificationOptions(id, input)
    const control = id === 'custom_direction' || id === 'variation_values' ? 'text' : 'single_choice'
    if (control !== 'text' && !options.length) return []
    const labels = {
      model: '生成模型', delivery_preset: '用途与画面比例', aspect_ratio: '图片比例', resolution: '分辨率',
      prompt_direction: 'Prompt 优化方向', preservation_priority: '保持重点', custom_direction: '自定义优化方向',
      variation_values: '变体取值', variation_combine: '是否组合',
    }
    const brief = input.creativeBrief
    const defaultValue = id === 'variation_combine'
      ? 'first'
      : id === 'variation_values'
        ? undefined
      : id === 'model'
      ? input.settings.model
      : id === 'aspect_ratio'
        ? input.settings.aspectRatio
        : id === 'resolution'
          ? input.settings.resolution
          : id === 'delivery_preset'
            ? brief?.output?.deliveryPreset
            : id === 'prompt_direction'
              ? brief?.creative?.promptDirection
              : id === 'preservation_priority'
                ? brief?.creative?.preservationPriority
                : brief?.creative?.customDirection
    return [{
      id,
      label: providerText(item.label, 80) ?? labels[id],
      required: true,
      control,
      ...(defaultValue ? { defaultValue } : {}),
      ...(control === 'text' ? {
        placeholder: id === 'variation_values' ? '例如：白皙、自然、小麦、深棕' : '请描述希望强化的画面方向',
      } : {}),
      options,
    }]
  }).slice(0, 3)
  if (!fields.length) throw new BotanicAgentPlannerError(502, 'INVALID_PROVIDER_RESPONSE', '生图 Agent 没有返回可用的确认选项。')
  return {
    id: `clarification-${toolCallId}`,
    question,
    ...(providerText(raw?.helper, 240) ? { helper: providerText(raw.helper, 240) } : {}),
    // 追问卡带回的原话用于下一轮重放：必须是用户的话，不能把模型 prose 当成用户指令。
    originalInstruction: input.sourceInstruction || input.instruction,
    ...(input.creativeBrief ? { brief: structuredClone(input.creativeBrief) } : {}),
    fields,
  }
}

async function plannerInstructions() {
  try {
    return await readBotanicAgentInstructions('generation')
  } catch {
    throw new BotanicAgentPlannerError(503, 'SKILLS_NOT_CONFIGURED', '生图 Agent 规则尚未配置完成。')
  }
}

function plannerModelInput(input) {
  const { projectSkills, ...safeInput } = input
  const mountedSkillIds = new Set(input.mountedSkillIds ?? [])
  return {
    ...safeInput,
    ...(Array.isArray(projectSkills) && projectSkills.length
      ? { availableSkills: projectSkills.map((skill) => ({ id: skill.id, name: skill.name })) }
      : {}),
    ...(mountedSkillIds.size && Array.isArray(projectSkills)
      ? { mountedSkills: projectSkills.filter((skill) => mountedSkillIds.has(skill.id)).map((skill) => ({ id: skill.id, name: skill.name })) }
      : {}),
  }
}

export async function planBotanicGeneration(input, runtimeConfig, options = {}) {
  const config = botanicAgentProviderConfig(runtimeConfig, input?.plannerModel)
  const system = await plannerInstructions()
  if (options.signal?.aborted) throw new BotanicAgentPlannerError(499, 'REQUEST_CANCELLED', '生图 Agent 请求已取消。')
  const timeoutSignal = AbortSignal.timeout(config.timeoutMs)
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal
  const fetchImpl = options.fetchImpl ?? fetch
  const proposedActions = []
  const webResearch = {
    apiKey: runtimeConfig?.webSearch?.apiKey,
    searchUrl: runtimeConfig?.webSearch?.searchUrl,
    extractUrl: runtimeConfig?.webSearch?.extractUrl,
    fetchImpl: options.webFetchImpl ?? fetch,
    allowLocal: Boolean(runtimeConfig?.webSearch?.allowLocal),
    consumeQuota: options.consumeWebResearchQuota,
  }
  const registry = createBotanicAgentPlanningToolRegistry({
    input,
    finalizePlan: (raw) => normalizeProviderPlan(raw, input),
    finalizeClarification: (raw, context) => ({
      kind: 'clarification',
      clarification: normalizeProviderClarification(raw, input, context?.toolCallId ?? 'unknown'),
    }),
    onProposeAction: (proposal) => {
      if (!proposedActions.some((item) => item.id === proposal.id)) proposedActions.push(proposal)
    },
    webResearch,
  })
  const hasWebTools = Boolean(registry.get('web_search') || registry.get('web_fetch'))
  try {
    const result = await runAgentToolLoop({
      registry,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(plannerModelInput(input)) },
      ],
      toolChoice: 'auto',
      maximumSteps: hasWebTools ? 8 : 4,
      allowRawReasoning: Boolean(runtimeConfig?.agentRawReasoning),
      callModel: async ({ messages, tools, tool_choice }) => {
        const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'x-litellm-api-key': config.apiKey,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: config.model,
            messages,
            tools,
            tool_choice,
            max_tokens: 3000,
            temperature: botanicAgentProviderTemperature(config.model),
            stream: false,
          }),
          signal,
        })
        const body = await response.json().catch(() => null)
        if (!response.ok) throw botanicAgentProviderResponseError(response.status)
        return body
      },
    })
    const output = typeof result.output === 'string'
      ? parseProviderJson(result.output)
      : result.output
    if (output?.kind === 'clarification' && output.clarification) {
      return {
        kind: 'clarification',
        clarification: mergeVariationClarification(output.clarification, {
          ...input,
          instruction: input.sourceInstruction || input.instruction,
        }),
        plannerModel: config.model,
        toolCalls: result.toolCalls,
        ...(result.reasoning?.length ? { reasoning: result.reasoning } : {}),
      }
    }
    const plan = normalizeProviderPlan(output, input)
    if (plan?.kind === 'clarification') {
      return {
        kind: 'clarification',
        clarification: plan.clarification,
        plannerModel: config.model,
        toolCalls: result.toolCalls,
        ...(result.reasoning?.length ? { reasoning: result.reasoning } : {}),
      }
    }
    return {
      ...plan,
      plannerModel: config.model,
      ...(proposedActions.length ? { actions: proposedActions } : {}),
      toolCalls: result.toolCalls,
      ...(result.reasoning?.length ? { reasoning: result.reasoning } : {}),
    }
  } catch (caught) {
    if (caught instanceof BotanicAgentPlannerError) throw caught
    if (timeoutSignal.aborted) throw new BotanicAgentPlannerError(504, 'PROVIDER_TIMEOUT', '生图 Agent 规划超时，请重试。')
    if (options.signal?.aborted) throw new BotanicAgentPlannerError(499, 'REQUEST_CANCELLED', '生图 Agent 请求已取消。')
    if (caught instanceof AgentToolRuntimeError) {
      throw new BotanicAgentPlannerError(502, 'INVALID_PROVIDER_RESPONSE', '生图 Agent 返回了不允许的工具调用。')
    }
    throw new BotanicAgentPlannerError(502, 'PROVIDER_UNAVAILABLE', '生图 Agent 暂时不可用，请稍后重试。')
  }
}
