import { AgentToolRuntimeError, runAgentToolLoop } from './agentToolRuntime.mjs'
import { createBotanicAgentPlanningToolRegistry } from './botanicAgentTools.mjs'
import { readBotanicAgentInstructions } from './agentInstructions.mjs'
import {
  botanicCreativeBriefFieldIds,
  BotanicCreativeBriefValidationError,
  validateBotanicCreativeBrief,
} from './botanicCreativeBrief.mjs'

const INTENTS = new Set([
  'continue_generation', 'replace_scene', 'replace_person', 'replace_product',
  'change_pose', 'change_style', 'batch_variation', 'redo_from_root',
])
const DIMENSIONS = new Set([
  'person', 'garment', 'product', 'scene', 'style', 'pose',
  'composition', 'lighting', 'aspect_ratio', 'copy_space',
])
const MODES = new Set(['preserve', 'vary'])
const ASPECT_RATIOS = ['1:1', '16:9', '4:3', '3:4', '4:5', '9:16']
const RESOLUTIONS = ['1K', '2K']
const CLARIFICATION_FIELDS = new Set(botanicCreativeBriefFieldIds)
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
    return [cleanKey, requiredText(item, `${name}值`, cleanKey === 'custom_direction' ? 500 : 160)]
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
    return result
  })
}

export function validateBotanicAgentPlanInput(raw) {
  const input = structuredObject(raw, 'Agent 计划请求')
  const projectId = requiredText(input.projectId, '项目', 160)
  const plannerModel = optionalText(input.plannerModel, 'Agent 模型', 160)
  const instruction = requiredText(input.instruction, '修改要求', 4000)
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
    if (generationOverrides.model !== undefined) {
      const allowedModels = new Set((generationModels ?? []).map((model) => model.id))
      if (generationOverrides.model !== settings.model && !allowedModels.has(generationOverrides.model)) invalidRequest('覆盖模型不在可用目录中。')
    }
  }
  const effectiveSettings = { ...settings, ...generationOverrides }
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

  return {
    projectId,
    ...(plannerModel ? { plannerModel } : {}),
    instruction,
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
  return {
    intent,
    instruction: input.instruction,
    summary,
    ...(input.creativeBrief ? { creativeBrief: structuredClone(input.creativeBrief) } : {}),
    selectedResultNodeId: input.selectedResult.nodeId,
    constraints,
    prompt,
    settings: input.settings,
    output: batchCount
      ? { mode: 'batch_by_asset', count: batchCount, candidatesPerItem: 1 }
      : { mode: 'single', count: 1, candidatesPerItem: 1 },
    ...(input.contextSnapshot?.length ? { contextSnapshot: input.contextSnapshot } : {}),
    ...(selectedAssetGroup ? { assetGroupId: selectedAssetGroup.id } : {}),
  }
}

function clarificationOptions(fieldId, input) {
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
    const control = id === 'custom_direction' ? 'text' : 'single_choice'
    if (control !== 'text' && !options.length) return []
    const labels = {
      model: '生成模型', delivery_preset: '用途与画面比例', aspect_ratio: '图片比例', resolution: '分辨率',
      prompt_direction: 'Prompt 优化方向', preservation_priority: '保持重点', custom_direction: '自定义优化方向',
    }
    const brief = input.creativeBrief
    const defaultValue = id === 'model'
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
      ...(control === 'text' ? { placeholder: '请描述希望强化的画面方向' } : {}),
      options,
    }]
  }).slice(0, 3)
  if (!fields.length) throw new BotanicAgentPlannerError(502, 'INVALID_PROVIDER_RESPONSE', '生图 Agent 没有返回可用的确认选项。')
  return {
    id: `clarification-${toolCallId}`,
    question,
    ...(providerText(raw?.helper, 240) ? { helper: providerText(raw.helper, 240) } : {}),
    originalInstruction: input.instruction,
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
  })
  try {
    const result = await runAgentToolLoop({
      registry,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(plannerModelInput(input)) },
      ],
      toolChoice: 'auto',
      maximumSteps: 4,
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
        clarification: output.clarification,
        plannerModel: config.model,
        toolCalls: result.toolCalls,
        ...(result.reasoning?.length ? { reasoning: result.reasoning } : {}),
      }
    }
    const plan = normalizeProviderPlan(output, input)
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
