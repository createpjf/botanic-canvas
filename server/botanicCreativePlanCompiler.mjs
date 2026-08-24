import { createHash } from 'node:crypto'

const dimensions = new Set([
  'person', 'garment', 'product', 'scene', 'style', 'pose',
  'composition', 'lighting', 'aspect_ratio', 'copy_space',
])
const modes = new Set(['preserve', 'vary'])
const criteria = Object.freeze({
  person: 'identity',
  garment: 'garment_material',
  product: 'product_structure',
  scene: 'composition',
  style: 'brand_style',
  pose: 'composition',
  composition: 'composition',
  lighting: 'lighting',
  aspect_ratio: 'delivery_spec',
  copy_space: 'delivery_spec',
})

export class CreativePlanCompileError extends Error {
  constructor(code, message, statusCode = 409) {
    super(message)
    this.name = 'CreativePlanCompileError'
    this.code = code
    this.statusCode = statusCode
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
  }
  return value
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('base64url')
}

function text(value, name, maximum = 6000) {
  if (typeof value !== 'string' || !value.trim()) throw new CreativePlanCompileError('PLAN_FIELD_MISSING', `${name}不能为空。`, 400)
  const result = value.trim()
  if (result.length > maximum) throw new CreativePlanCompileError('PLAN_FIELD_TOO_LONG', `${name}过长。`, 400)
  return result
}

function normalizeConstraints(raw) {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > dimensions.size) {
    throw new CreativePlanCompileError('PLAN_CONSTRAINTS_INVALID', 'Agent 创作约束无效。', 400)
  }
  const seen = new Set()
  return raw.map((constraint, index) => {
    if (!dimensions.has(constraint?.dimension) || !modes.has(constraint?.mode)) {
      throw new CreativePlanCompileError('PLAN_CONSTRAINT_INVALID', `第 ${index + 1} 条创作约束无效。`, 400)
    }
    if (seen.has(constraint.dimension)) {
      throw new CreativePlanCompileError('PLAN_CONSTRAINT_CONFLICT', `创作维度「${constraint.dimension}」重复声明。`, 409)
    }
    seen.add(constraint.dimension)
    return {
      dimension: constraint.dimension,
      mode: constraint.mode,
      ...(constraint.sourceAssetGroupId ? { sourceAssetGroupId: text(constraint.sourceAssetGroupId, '素材组', 160) } : {}),
    }
  })
}

function normalizeBindings(bindings, name) {
  if (bindings === undefined) return []
  if (!Array.isArray(bindings) || bindings.length > 32) {
    throw new CreativePlanCompileError('PLAN_BINDINGS_INVALID', `${name}绑定无效。`, 400)
  }
  return bindings.map((binding, index) => {
    const id = text(binding?.id ?? binding?.skillId ?? binding?.memoryId, `${name}第 ${index + 1} 项标识`, 160)
    const version = binding?.version === undefined ? undefined : Number(binding.version)
    if (version !== undefined && (!Number.isInteger(version) || version < 1)) {
      throw new CreativePlanCompileError('PLAN_BINDING_VERSION_INVALID', `${name}版本无效。`, 400)
    }
    return {
      id,
      ...(version === undefined ? {} : { version }),
      ...(binding?.contentHash ? { contentHash: text(binding.contentHash, `${name}内容摘要`, 200) } : {}),
      ...(binding?.selectionReason ? { selectionReason: text(binding.selectionReason, `${name}使用原因`, 240) } : {}),
    }
  })
}

function branchDelta(branch) {
  const values = Array.isArray(branch?.variation?.values) ? branch.variation.values : []
  if (typeof branch?.variation?.promptDelta === 'string' && branch.variation.promptDelta.trim()) return [branch.variation.promptDelta.trim()]
  return [...new Set(values.map((item) => typeof item?.valueLabel === 'string' && item.valueLabel.trim()
    ? `${item.axisLabel ?? item.key ?? '变化'}调整为${item.valueLabel.trim()}。`
    : '').filter(Boolean))]
}

function directionLine(brief) {
  const direction = brief?.creative?.promptDirection
  const priority = brief?.creative?.preservationPriority
  const custom = brief?.creative?.customDirection
  const lines = []
  if (direction) lines.push(`创作方向：${direction}。`)
  if (priority) lines.push(`优先保持：${priority}。`)
  if (custom) lines.push(`补充方向：${String(custom).trim().slice(0, 500)}。`)
  return lines
}

function constraintLine(constraint) {
  return `${constraint.mode === 'preserve' ? '必须保持' : '允许变化'}：${constraint.dimension}${constraint.sourceAssetGroupId ? `（素材组 ${constraint.sourceAssetGroupId}）` : ''}。`
}

export function buildCreativeConstraintPrompt({ prompt, constraints = [], branch, creativeBrief, locale = 'zh-CN' }) {
  const base = text(prompt, 'Agent 生图提示词')
  const normalized = normalizeConstraints(constraints)
  const deltas = branchDelta(branch).filter((delta) => !base.includes(delta))
  const direction = directionLine(creativeBrief)
  const contractLines = locale === 'en'
    ? [...normalized.map((item) => `${item.mode === 'preserve' ? 'Must preserve' : 'May vary'}: ${item.dimension}.`), ...direction.map((item) => item.replace(/^创作方向：/u, 'Creative direction: ').replace(/^优先保持：/u, 'Preservation priority: ').replace(/^补充方向：/u, 'Additional direction: ')), ...deltas.map((item) => `Branch change: ${item}`)]
    : [...normalized.map(constraintLine), ...direction, ...deltas.map((item) => `本分支变化：${item}`)]
  const prefix = contractLines.length
    ? (locale === 'en' ? ['Creative execution contract:', ...contractLines] : ['执行契约：', ...contractLines])
    : []
  const meaningful = prefix.filter(Boolean)
  return meaningful.length ? `${meaningful.join('\n')}\n\n${base}` : base
}

function qualityPolicy(constraints, settings) {
  const requiredCriteria = new Set(['identity', 'product_structure', 'composition', 'lighting', 'brand_style'])
  for (const constraint of constraints) {
    if (criteria[constraint.dimension]) requiredCriteria.add(criteria[constraint.dimension])
  }
  if (settings?.aspectRatio) requiredCriteria.add('delivery_spec')
  return {
    version: 1,
    requiredCriteria: [...requiredCriteria],
    humanDecisionRequired: true,
  }
}

function modelSupportsSettings(model, settings) {
  if (!model || !settings) return
  if (Array.isArray(model.aspectRatios) && model.aspectRatios.length && !model.aspectRatios.includes(settings.aspectRatio)) {
    throw new CreativePlanCompileError('MODEL_ASPECT_RATIO_UNSUPPORTED', `模型「${model.id}」不支持比例 ${settings.aspectRatio}。`, 409)
  }
  if (Array.isArray(model.resolutions) && model.resolutions.length && !model.resolutions.includes(settings.resolution)) {
    throw new CreativePlanCompileError('MODEL_RESOLUTION_UNSUPPORTED', `模型「${model.id}」不支持分辨率 ${settings.resolution}。`, 409)
  }
}

function safeReferenceIds(recipe) {
  return (recipe?.references ?? []).map((reference) => ({
    nodeId: reference.nodeId,
    assetId: reference.assetId,
    name: reference.name,
    role: reference.role,
    primary: Boolean(reference.primary),
    priority: reference.priority,
  }))
}

/**
 * 纯计划编译 Module。它不读取网络、不调用 Provider，也不生成 Job；确认后的执行层
 * 只需把它返回的不可变快照写入 Run/GenerationRecipe，即可在恢复时重放同一语义。
 */
export function compileCreativePlan({
  plan,
  baseRecipe,
  branch,
  models = [],
  memoryBindings,
  skillBindings,
  locale = 'zh-CN',
} = {}) {
  if (!plan || typeof plan !== 'object') throw new CreativePlanCompileError('PLAN_MISSING', 'Agent 计划不能为空。', 400)
  if (!baseRecipe || typeof baseRecipe !== 'object') throw new CreativePlanCompileError('RECIPE_MISSING', '生成配方不能为空。', 409)
  const prompt = text(plan.prompt ?? baseRecipe.prompt, 'Agent 生图提示词')
  const constraints = normalizeConstraints(plan.constraints)
  const settings = { ...baseRecipe.settings, ...plan.settings }
  const selectedModel = models.find((model) => model?.id === settings.model)
  if (models.length && !selectedModel) throw new CreativePlanCompileError('MODEL_NOT_CONFIGURED', `模型「${settings.model ?? ''}」未配置。`, 409)
  modelSupportsSettings(selectedModel, settings)
  const normalizedMemoryBindings = normalizeBindings(memoryBindings, '项目记忆')
  const normalizedSkillBindings = normalizeBindings(skillBindings, 'Skill')
  const sourceFingerprint = hash({
    plan: {
      intent: plan.intent,
      instruction: plan.instruction,
      summary: plan.summary,
      prompt,
      settings,
      constraints,
      output: plan.output,
      variation: plan.variation,
      creativeBrief: plan.creativeBrief,
    },
    branch: branch ? {
      id: branch.id,
      label: branch.label,
      assetId: branch.assetId,
      variation: branch.variation,
      item: branch.item ? { title: branch.item.title, prompt: branch.item.prompt, mediaKind: branch.item.mediaKind, count: branch.item.count, duration: branch.item.duration } : undefined,
    } : undefined,
    recipe: { references: safeReferenceIds(baseRecipe), batchCount: baseRecipe.batchCount },
    memoryBindings: normalizedMemoryBindings,
    skillBindings: normalizedSkillBindings,
  })
  const compiledPrompt = buildCreativeConstraintPrompt({
    prompt,
    constraints,
    branch,
    creativeBrief: plan.creativeBrief,
    locale,
  })
  if (compiledPrompt.length > 6000) throw new CreativePlanCompileError('COMPILED_PROMPT_TOO_LONG', '编译后的执行提示词过长，请减少约束或补充描述。', 409)
  const lockedDimensions = constraints.filter((item) => item.mode === 'preserve').map((item) => item.dimension)
  const variedDimensions = constraints.filter((item) => item.mode === 'vary').map((item) => item.dimension)
  const quality = qualityPolicy(constraints, settings)
  const compiled = {
    version: 2,
    taskIntent: plan.intent ?? 'continue_generation',
    sourceFingerprint,
    lockedDimensions,
    variedDimensions,
    constraints,
    qualityPolicy: quality,
    memoryBindings: normalizedMemoryBindings,
    skillBindings: normalizedSkillBindings,
    branchId: branch?.id,
    branchLabel: branch?.label,
    prompt: compiledPrompt,
    settings,
    references: safeReferenceIds(baseRecipe),
  }
  return {
    compiled,
    recipe: {
      ...structuredClone(baseRecipe),
      prompt: compiledPrompt,
      promptForDisplay: baseRecipe.prompt,
      settings,
      constraints,
      creativeIntent: compiled.taskIntent,
      qualityPolicy: quality,
      sourcePlanFingerprint: sourceFingerprint,
      ...(normalizedMemoryBindings.length ? { memoryBindings: normalizedMemoryBindings } : {}),
      ...(normalizedSkillBindings.length ? { skillBindings: normalizedSkillBindings } : {}),
    },
  }
}

export function compileAgentBranchRecipe(input) {
  return compileCreativePlan(input).recipe
}

export function creativePlanFingerprint(input) {
  return compileCreativePlan(input).compiled.sourceFingerprint
}
