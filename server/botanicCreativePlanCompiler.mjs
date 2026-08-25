import { canonicalHash } from './canonicalHash.mjs'
import { brandConstraintLines, brandKitFingerprint, brandReviewCriteria } from './brandKit.mjs'

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

const hash = canonicalHash

/** 计划指纹。哈希实现见 `canonicalHash.mjs`；这里只是计划语义下的具名入口。 */
export function creativePlanHash(value) {
  return canonicalHash(value)
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

export function buildCreativeConstraintPrompt({ prompt, constraints = [], branch, creativeBrief, brandKit, locale = 'zh-CN' }) {
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
  // 品牌规则排在执行契约**之前**：它跨所有 Run 成立，是这一次创作的外层边界，
  // 而执行契约只描述本次要保持/变化什么。顺序颠倒会让模型把品牌规则读成本次的
  // 临时要求，从而在与本次约束冲突时优先放弃品牌。
  const meaningful = [...brandConstraintLines(brandKit, locale), ...prefix].filter(Boolean)
  return meaningful.length ? `${meaningful.join('\n')}\n\n${base}` : base
}

function qualityPolicy(constraints, settings, brandKit) {
  const requiredCriteria = new Set(['identity', 'product_structure', 'composition', 'lighting', 'brand_style'])
  for (const constraint of constraints) {
    if (criteria[constraint.dimension]) requiredCriteria.add(criteria[constraint.dimension])
  }
  if (settings?.aspectRatio) requiredCriteria.add('delivery_spec')
  // 品牌判据逐条列出（Epic 9.1）。此前 `brand_style` 是一道**没有答案的必答题**：
  // 它从上线起就在必查判据里，但评审层拿不到任何一条真实品牌规则，只能凭空作答。
  const brandCriteria = brandReviewCriteria(brandKit)
  return {
    version: 1,
    requiredCriteria: [...requiredCriteria],
    ...(brandCriteria.length ? { brandCriteria } : {}),
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
  brandKit,
  locale = 'zh-CN',
  planFingerprint: providedPlanFingerprint,
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
  // 品牌规则进指纹：换一套品牌规则重跑，语义上就不是同一次执行了。不进指纹的话
  // 「结果与当时确认的计划一致」会在品牌改动后继续成立，而画面其实已经按新规则生成。
  const resolvedBrandFingerprint = brandKit?.rules?.length ? brandKitFingerprint(brandKit.rules) : undefined
  // 两级指纹。分支级由 plan 级与分支身份派生，于是任一分支都能归回同一次确认
  // （ADR 0005）。早期只有一个把分支混进哈希的指纹，分支之间互不相关，无法回答
  // 「这两张图是不是同一次确认出来的」。
  //
  // plan 级指纹**只能由调用方给**：这个函数一次只编译一支，看不到同一次确认的其他
  // 分支，自己算出来的「plan 级」仍会随本支的参考与 Prompt 变化。整次确认的指纹由
  // `compileRunCreativePlan` 统一计算并传进来；不传时退化为「按本支输入算」，仅供
  // 单支编译与 V1 兼容路径使用。
  const planFingerprint = providedPlanFingerprint ?? hash({
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
    recipe: { references: safeReferenceIds(baseRecipe), batchCount: baseRecipe.batchCount },
    memoryBindings: normalizedMemoryBindings,
    skillBindings: normalizedSkillBindings,
    brandKit: resolvedBrandFingerprint,
  })
  const branchIdentity = branch ? {
    id: branch.id,
    label: branch.label,
    assetId: branch.assetId,
    variation: branch.variation,
    item: branch.item ? { title: branch.item.title, prompt: branch.item.prompt, mediaKind: branch.item.mediaKind, count: branch.item.count, duration: branch.item.duration } : undefined,
  } : undefined
  const branchFingerprint = hash({ planFingerprint, branch: branchIdentity })
  // 兼容名：既有配方与 Job 用 sourceFingerprint/sourcePlanFingerprint 指向「这一支的指纹」。
  const sourceFingerprint = branchFingerprint
  const compiledPrompt = buildCreativeConstraintPrompt({
    prompt,
    constraints,
    branch,
    creativeBrief: plan.creativeBrief,
    brandKit,
    locale,
  })
  if (compiledPrompt.length > 6000) throw new CreativePlanCompileError('COMPILED_PROMPT_TOO_LONG', '编译后的执行提示词过长，请减少约束或补充描述。', 409)
  const lockedDimensions = constraints.filter((item) => item.mode === 'preserve').map((item) => item.dimension)
  const variedDimensions = constraints.filter((item) => item.mode === 'vary').map((item) => item.dimension)
  const quality = qualityPolicy(constraints, settings, brandKit)
  const compiled = {
    version: 2,
    taskIntent: plan.intent ?? 'continue_generation',
    planFingerprint,
    branchFingerprint,
    sourceFingerprint,
    ...(resolvedBrandFingerprint ? { brandKitFingerprint: resolvedBrandFingerprint, brandId: brandKit.brandId } : {}),
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
      planFingerprint,
      branchFingerprint,
      ...(resolvedBrandFingerprint ? { brandKitFingerprint: resolvedBrandFingerprint, brandId: brandKit.brandId } : {}),
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

/** 这一次用户确认的 plan 级指纹；同一次确认的所有分支共享它。 */
export function compiledPlanFingerprint(input) {
  return compileCreativePlan(input).compiled.planFingerprint
}
