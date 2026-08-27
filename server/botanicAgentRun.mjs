import { randomUUID } from 'node:crypto'
import { createIdempotencyRequestBinding } from './idempotencyRequestBinding.mjs'
import { agentRunCompiledPlanProvenance } from './creativePlanResolver.mjs'
import { inferAspectRatioFromPixels, normalizeCustomGenerationSize } from './generationOutputSize.mjs'
import { normalizeRegionRect } from './regionMaskPng.mjs'

const intents = new Set([
  'initial_generation',
  'continue_generation', 'replace_scene', 'replace_person', 'replace_product',
  'change_pose', 'change_style', 'batch_variation', 'redo_from_root', 'region_edit',
])
const branchStatuses = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled'])
const toolRisks = new Set(['read', 'write', 'costly', 'external'])
const toolStatuses = new Set(['pending', 'running', 'awaiting_confirmation', 'succeeded', 'failed'])
const contextKinds = new Set(['素材', '结果', '文字', '节点'])
const mediaKinds = new Set(['image', 'video'])
const creativeDimensions = new Set([
  'person', 'garment', 'product', 'scene', 'style', 'pose',
  'composition', 'lighting', 'aspect_ratio', 'copy_space',
])
const constraintModes = new Set(['preserve', 'vary'])

export class BotanicAgentRunError extends Error {
  constructor(statusCode, code, message) {
    super(message)
    this.statusCode = statusCode
    this.code = code
  }
}

function text(value, name, maximumLength = 6000, options = {}) {
  if (typeof value !== 'string' || !value.trim()) throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', `${name}不能为空。`)
  const normalized = value.trim()
  const length = options.countCodePoints ? Array.from(normalized).length : normalized.length
  if (length > maximumLength) throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', `${name}过长。`)
  return normalized
}

function containsMediaPayload(value) {
  if (!value || typeof value !== 'object') return false
  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.toLowerCase()
    if (['image', 'dataurl', 'mediaid', 'url', 'buffer', 'bytes'].includes(normalized)) return true
    if (containsMediaPayload(entry)) return true
  }
  return false
}

function validateToolCalls(rawToolCalls) {
  if (rawToolCalls === undefined) return undefined
  if (!Array.isArray(rawToolCalls) || rawToolCalls.length > 16) {
    throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', 'Agent 工具调用记录无效。')
  }
  return rawToolCalls.map((call, index) => {
    const name = text(call?.name, `第 ${index + 1} 个工具名称`, 96)
    if (!/^[a-z][a-z0-9_]{1,95}$/.test(name)) {
      throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', 'Agent 工具名称无效。')
    }
    if (!toolRisks.has(call?.risk)) {
      throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', 'Agent 工具调用风险无效。')
    }
    if (!toolStatuses.has(call?.status)) {
      throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', 'Agent 工具调用状态无效。')
    }
    if (typeof call?.requiresConfirmation !== 'boolean') {
      throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', 'Agent 工具确认状态无效。')
    }
    return {
      id: text(call.id, `第 ${index + 1} 个工具调用标识`, 160),
      name,
      label: text(call.label, `第 ${index + 1} 个工具名称`, 160),
      risk: call.risk,
      status: call.status,
      requiresConfirmation: call.requiresConfirmation,
      // 模型自述的一句话调用目的：可展示的摘要级说明，不是隐藏思维链。
      ...(call.summary ? { summary: text(call.summary, `第 ${index + 1} 个工具调用说明`, 160) } : {}),
      ...(call.error ? { error: text(call.error, `第 ${index + 1} 个工具错误`, 1000) } : {}),
    }
  })
}

function validateVariationValue(raw, name) {
  return {
    label: text(raw?.label, `${name}名称`, 8, { countCodePoints: true }),
    promptDelta: text(raw?.promptDelta, `${name}增量`, 500),
  }
}

function validateVariationSpec(raw) {
  if (raw === undefined) return undefined
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.axes) || !raw.axes.length || raw.axes.length > 4) {
    throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', 'Agent 变体轴无效。')
  }
  return {
    combine: Boolean(raw.combine),
    axes: raw.axes.map((axis, index) => {
      const key = text(axis?.key, `第 ${index + 1} 条变体轴`, 40)
      const label = text(axis?.label, `第 ${index + 1} 条变体轴名称`, 16, { countCodePoints: true })
      if (!Array.isArray(axis?.values) || axis.values.length < 2 || axis.values.length > 8) {
        throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', `第 ${index + 1} 条变体轴取值无效。`)
      }
      return {
        key,
        label,
        values: axis.values.map((value, valueIndex) => validateVariationValue(value, `第 ${index + 1} 条变体轴第 ${valueIndex + 1} 个取值`)),
      }
    }),
  }
}

function validateBranchVariation(raw, name) {
  if (raw === undefined) return undefined
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', `${name}变体无效。`)
  }
  return {
    label: text(raw.label, `${name}变体名称`, 8, { countCodePoints: true }),
    promptDelta: text(raw.promptDelta, `${name}变体增量`, 500),
    values: Array.isArray(raw.values)
      ? raw.values.slice(0, 4).map((item, index) => ({
        key: text(item?.key, `${name}变体第 ${index + 1} 个维度`, 40),
        axisLabel: text(item?.axisLabel, `${name}变体第 ${index + 1} 个维度名`, 16, { countCodePoints: true }),
        valueLabel: text(item?.valueLabel, `${name}变体第 ${index + 1} 个取值`, 8, { countCodePoints: true }),
      }))
      : [],
  }
}

function validateSettings(rawSettings) {
  if (!rawSettings || typeof rawSettings !== 'object' || Array.isArray(rawSettings)) {
    throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', 'Agent 生成参数无效。')
  }
  const settings = {
    model: text(rawSettings.model, '生成模型', 160),
    aspectRatio: text(rawSettings.aspectRatio, '画面比例', 32),
    resolution: text(rawSettings.resolution, '输出规格', 32),
    ...(rawSettings.duration === undefined ? {} : { duration: Number(rawSettings.duration) }),
  }
  if (rawSettings.outputWidth !== undefined || rawSettings.outputHeight !== undefined) {
    const normalized = normalizeCustomGenerationSize(Number(rawSettings.outputWidth), Number(rawSettings.outputHeight))
    if (!normalized.ok) {
      throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', normalized.message)
    }
    settings.outputWidth = normalized.width
    settings.outputHeight = normalized.height
    settings.aspectRatio = inferAspectRatioFromPixels(normalized.width, normalized.height)
  }
  return settings
}

function validateConstraints(rawConstraints, { allowEmpty = false } = {}) {
  if (
    !Array.isArray(rawConstraints)
    || (!allowEmpty && !rawConstraints.length)
    || rawConstraints.length > creativeDimensions.size
  ) {
    throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', 'Agent 创作约束无效。')
  }
  return rawConstraints.map((constraint, index) => {
    if (!creativeDimensions.has(constraint?.dimension) || !constraintModes.has(constraint?.mode)) {
      throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', `第 ${index + 1} 条 Agent 创作约束无效。`)
    }
    return {
      dimension: constraint.dimension,
      mode: constraint.mode,
      ...(constraint.sourceAssetGroupId ? { sourceAssetGroupId: text(constraint.sourceAssetGroupId, '素材组', 160) } : {}),
    }
  })
}

function validateBindings(rawBindings, label) {
  if (rawBindings === undefined) return undefined
  if (!Array.isArray(rawBindings) || rawBindings.length > 32) throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', `${label}绑定无效。`)
  return rawBindings.map((binding, index) => {
    const result = { id: text(binding?.id, `${label}第 ${index + 1} 项标识`, 160) }
    if (binding?.version !== undefined) {
      const version = Number(binding.version)
      if (!Number.isInteger(version) || version < 1) throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', `${label}版本无效。`)
      result.version = version
    }
    if (binding?.contentHash) result.contentHash = text(binding.contentHash, `${label}内容摘要`, 200)
    if (binding?.selectionReason) result.selectionReason = text(binding.selectionReason, `${label}使用原因`, 240)
    return result
  })
}

/**
 * Run 之间的血缘关系。
 *
 * - `fork`：带明确变化的再创作，Prompt 会被改写。
 * - `review_retry`：评审后「请求重试」，**同一份计划重跑**，不改写 Prompt；
 *   必须能追回原 Run、原评审任务与被重试的那个 Artifact（ADR 0006）。
 */
export const AGENT_RUN_LINEAGE_RELATIONS = Object.freeze(['fork', 'review_retry'])
const lineageRelations = new Set(AGENT_RUN_LINEAGE_RELATIONS)

function validateLineage(rawLineage) {
  if (rawLineage === undefined) return undefined
  if (!rawLineage || typeof rawLineage !== 'object' || !lineageRelations.has(rawLineage.relation)) {
    throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', 'Agent Run 血缘关系无效。')
  }
  return {
    relation: rawLineage.relation,
    parentRunId: text(rawLineage.parentRunId, '父 Agent Run', 160),
    ...(rawLineage.parentBranchId ? { parentBranchId: text(rawLineage.parentBranchId, '父 Agent 分支', 160) } : {}),
    ...(rawLineage.rootRunId ? { rootRunId: text(rawLineage.rootRunId, '根 Agent Run', 160) } : {}),
    ...(rawLineage.reviewTaskId ? { reviewTaskId: text(rawLineage.reviewTaskId, '评审任务', 160) } : {}),
    ...(rawLineage.sourceArtifactId ? { sourceArtifactId: text(rawLineage.sourceArtifactId, '被重试的 Artifact', 240) } : {}),
    ...(rawLineage.createdAt === undefined ? {} : { createdAt: Number(rawLineage.createdAt) || Date.now() }),
  }
}

/**
 * 评审「请求重试」产生的 Run 输入：**同一份计划重跑**。
 *
 * 不复用 fork：fork 的语义是「带一句明确变化再做一次」，会改写 Prompt；重试要的是
 * 按用户原本确认的计划重来一次，改写 Prompt 会让重试结果无法与原结果对照。
 */
export function createReviewRetryAgentRunInput(sourceRun, { branchId, reviewTaskId, artifactId, now = Date.now() } = {}) {
  if (!sourceRun?.plan) throw new BotanicAgentRunError(409, 'AGENT_RUN_NOT_RETRYABLE', '源 Agent Run 缺少可重跑的计划。')
  const sourceBranch = sourceRun.branches?.find((branch) => branch.id === branchId)
    ?? sourceRun.branches?.find((branch) => branch.status === 'succeeded')
    ?? sourceRun.branches?.[0]
  if (!sourceBranch) throw new BotanicAgentRunError(409, 'AGENT_RUN_NOT_RETRYABLE', '源 Agent Run 没有可重跑的分支。')
  const plan = structuredClone(sourceRun.plan)
  return {
    projectId: sourceRun.projectId,
    lineage: {
      relation: 'review_retry',
      parentRunId: sourceRun.id,
      parentBranchId: sourceBranch.id,
      rootRunId: sourceRun.lineage?.rootRunId ?? sourceRun.id,
      ...(reviewTaskId ? { reviewTaskId } : {}),
      ...(artifactId ? { sourceArtifactId: artifactId } : {}),
      createdAt: now,
    },
    plan: {
      ...plan,
      // 重试只跑这一支，不重复展开整批。
      output: { mode: 'single', count: 1, candidatesPerItem: 1 },
      actions: undefined,
      toolCalls: undefined,
    },
    branches: [{
      id: `retry-${sourceBranch.id}-${String(artifactId ?? '').slice(-12).replace(/[^A-Za-z0-9_-]/g, '') || 'candidate'}`,
      label: sourceBranch.label ?? '重试',
      ...(sourceBranch.assetId ? { assetId: sourceBranch.assetId } : {}),
      ...(sourceBranch.variation ? { variation: structuredClone(sourceBranch.variation) } : {}),
      ...(sourceBranch.item ? { item: structuredClone(sourceBranch.item) } : {}),
    }],
  }
}

function validateContextSnapshot(rawSnapshot) {
  if (rawSnapshot === undefined) return undefined
  if (!Array.isArray(rawSnapshot) || rawSnapshot.length > 16) {
    throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', 'Agent 上下文快照无效。')
  }
  const seen = new Set()
  return rawSnapshot.map((item, index) => {
    const nodeId = text(item?.nodeId, `第 ${index + 1} 个上下文节点`, 160)
    if (seen.has(nodeId)) throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', 'Agent 上下文快照包含重复节点。')
    seen.add(nodeId)
    const kind = text(item?.kind, `第 ${index + 1} 个上下文类型`, 16)
    if (!contextKinds.has(kind)) throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', 'Agent 上下文类型无效。')
    const result = { nodeId, label: text(item?.label, `第 ${index + 1} 个上下文名称`, 160), kind }
    if (item?.mediaKind !== undefined) {
      const mediaKind = text(item.mediaKind, `第 ${index + 1} 个媒体类型`, 16)
      if (!mediaKinds.has(mediaKind)) throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', 'Agent 媒体类型无效。')
      result.mediaKind = mediaKind
    }
    if (item?.role !== undefined) result.role = text(item.role, `第 ${index + 1} 个上下文角色`, 80)
    if (item?.note !== undefined) result.note = text(item.note, `第 ${index + 1} 个上下文补充描述`, 500)
    return result
  })
}

/** 成套方案条目：分支自带媒体类型与定稿 Prompt；归一化语义与 src/domain/agentCreativeComposition.ts 一致。 */
function validateCompositionItem(raw, subject) {
  if (!raw || typeof raw !== 'object') throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', `${subject}条目无效。`)
  const mediaKind = raw.mediaKind === 'video' ? 'video' : 'image'
  const parsedCount = Number(raw.count)
  const parsedDuration = Number(raw.duration)
  const index = Number(raw.index)
  return {
    index: Number.isInteger(index) && index >= 1 ? index : 1,
    title: text(raw.title ?? `${subject}条目`, `${subject}标题`, 80),
    ...(raw.purpose ? { purpose: text(raw.purpose, `${subject}用途`, 200) } : {}),
    mediaKind,
    prompt: text(raw.prompt, `${subject}Prompt`, 6000),
    count: mediaKind === 'video'
      ? 1
      : Number.isFinite(parsedCount) ? Math.min(4, Math.max(1, Math.floor(parsedCount))) : 1,
    ...(mediaKind === 'video' && Number.isInteger(parsedDuration) && parsedDuration > 0 && parsedDuration <= 60
      ? { duration: parsedDuration }
      : {}),
  }
}

function validateComposition(raw) {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || !Array.isArray(raw.items)) {
    throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', 'Agent 成套方案无效。')
  }
  const items = raw.items.slice(0, 8).map((item, index) => ({
    ...validateCompositionItem(item, `方案第 ${index + 1} 个`),
    index: index + 1,
  }))
  if (items.length < 2) throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', 'Agent 成套方案至少要有 2 个条目。')
  return { theme: text(raw.theme, '方案主题', 200), items }
}

/** 局部重绘选区是纯数据矩形（归一化 0–1）；位图蒙版由执行层生成，不进 Run。 */
function validateRegion(raw) {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || !raw.rect || typeof raw.rect !== 'object') {
    throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', 'Agent 局部重绘选区无效。')
  }
  const rect = normalizeRegionRect(raw.rect)
  if (!rect) throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', 'Agent 局部重绘选区无效或过小。')
  return {
    rect,
    ...(raw.description ? { description: text(raw.description, '选区描述', 160) } : {}),
  }
}

export function validateAgentRunCreation(body) {
  if (!body || typeof body !== 'object') throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', 'Agent Run 不能为空。')
  if (containsMediaPayload(body)) throw new BotanicAgentRunError(400, 'AGENT_RUN_MEDIA_FORBIDDEN', 'Agent Run 不能包含图片或媒体数据。')
  const projectId = text(body.projectId, '项目', 160)
  const rawPlan = body.plan
  if (!rawPlan || typeof rawPlan !== 'object') throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', 'Agent 计划不能为空。')
  if (!intents.has(rawPlan.intent)) throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', 'Agent 计划类型不支持。')
  const output = rawPlan.output
  if (!output || !['single', 'batch_by_asset', 'batch_by_variation'].includes(output.mode)) throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', 'Agent 输出方式无效。')
  const count = Number(output.count)
  const candidatesPerItem = Number(output.candidatesPerItem)
  if (!Number.isInteger(count) || count < 1 || count > 20 || !Number.isInteger(candidatesPerItem) || candidatesPerItem < 1 || candidatesPerItem > 8) {
    throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', 'Agent 输出数量无效。')
  }
  if (!Array.isArray(body.branches) || !body.branches.length || body.branches.length > 20) {
    throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', 'Agent Run 需包含 1–20 个分支。')
  }
  const branches = body.branches.map((branch, index) => {
    const variation = validateBranchVariation(branch?.variation, `第 ${index + 1} 个分支`)
    return {
      id: text(branch?.id, `第 ${index + 1} 个分支标识`, 160),
      label: text(branch?.label ?? `分支 ${index + 1}`, `第 ${index + 1} 个分支名称`, 160),
      ...(branch?.assetId ? { assetId: text(branch.assetId, `第 ${index + 1} 个分支素材`, 160) } : {}),
      ...(variation ? { variation } : {}),
      ...(branch?.item !== undefined
        ? { item: validateCompositionItem(branch.item, `第 ${index + 1} 个分支`) }
        : {}),
    }
  })
  if (new Set(branches.map((branch) => branch.id)).size !== branches.length) {
    throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', 'Agent 分支标识重复。')
  }
  const toolCalls = validateToolCalls(rawPlan.toolCalls)
  const contextSnapshot = validateContextSnapshot(rawPlan.contextSnapshot)
  const isInitialGeneration = rawPlan.intent === 'initial_generation'
  const settings = validateSettings(rawPlan.settings)
  const selectedResultNodeId = rawPlan.selectedResultNodeId === undefined
    ? undefined
    : text(rawPlan.selectedResultNodeId, '父结果节点', 160)
  if (!isInitialGeneration && !selectedResultNodeId) {
    throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', '父结果节点不能为空。')
  }
  if (isInitialGeneration && settings.duration !== undefined && !contextSnapshot?.some((item) => (
    (item.kind === '素材' || item.kind === '结果') && item.mediaKind === 'image'
  ))) {
    throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', '视频首次生成需要至少一个图片素材或图片结果作为首帧。')
  }
  const variation = validateVariationSpec(rawPlan.variation)
  if (output.mode === 'batch_by_variation' && !variation) {
    throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', '按变体批量时必须包含已确认的变体轴。')
  }
  const region = validateRegion(rawPlan.region)
  if (rawPlan.intent === 'region_edit' && !region) {
    throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', '局部重绘计划必须携带有效选区。')
  }
  const composition = validateComposition(rawPlan.composition)
  const memoryBindings = validateBindings(rawPlan.memoryBindings, '项目记忆')
  const skillBindings = validateBindings(rawPlan.skillBindings, 'Skill')
  const lineage = validateLineage(body.lineage)
  // 确认这次 Run 的 Turn。方向是 Run → Turn：Turn 记录在 execute() 里被整条覆盖写，
  // 反向写 linkedRunIds 会被那次覆盖清掉，因此权威边只放在 Run 上，Turn 侧读时派生。
  const turnId = body.turnId === undefined ? undefined : text(body.turnId, '确认来源 Turn', 160)
  return {
    projectId,
    ...(turnId ? { turnId } : {}),
    ...(lineage ? { lineage } : {}),
    plan: {
      ...(rawPlan.plannerModel ? { plannerModel: text(rawPlan.plannerModel, 'Agent 模型', 160) } : {}),
      intent: rawPlan.intent,
      instruction: text(rawPlan.instruction, 'Agent 指令'),
      summary: text(rawPlan.summary, 'Agent 计划摘要', 1000),
      ...(rawPlan.title ? { title: text(rawPlan.title, 'Agent 新图名', 8, { countCodePoints: true }) } : {}),
      ...(selectedResultNodeId ? { selectedResultNodeId } : {}),
      prompt: text(rawPlan.prompt, 'Agent 生图提示词'),
      settings,
      constraints: validateConstraints(rawPlan.constraints, { allowEmpty: isInitialGeneration }),
      output: { mode: output.mode, count, candidatesPerItem },
      ...(variation ? { variation } : {}),
      ...(region ? { region } : {}),
      ...(composition ? { composition } : {}),
      ...(memoryBindings?.length ? { memoryBindings } : {}),
      ...(skillBindings?.length ? { skillBindings } : {}),
      ...(contextSnapshot?.length ? { contextSnapshot } : {}),
      ...(rawPlan.assetGroupId ? { assetGroupId: text(rawPlan.assetGroupId, '素材组', 160) } : {}),
      ...(toolCalls ? { toolCalls } : {}),
    },
    branches,
  }
}

export const agentRunSubmissionScope = 'agent-run.create'

/** @param {any} input */
export function agentRunSubmissionBinding(input) {
  return createIdempotencyRequestBinding({
    scope: agentRunSubmissionScope,
    projectId: input.projectId,
    request: {
      projectId: input.projectId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.lineage ? { lineage: input.lineage } : {}),
      plan: input.plan,
      branches: input.branches,
    },
  })
}

/**
 * Legacy Run 没有 binding，但 Run 主体本身已完整保留首次确认的 immutable input。
 * 只从这些字段派生；status/attempt/jobIds 等执行态绝不能进入请求摘要。
 * @param {any} run
 */
export function storedAgentRunSubmissionBinding(run) {
  if (run?.idempotencyBinding) return run.idempotencyBinding
  if (!run?.projectId || !run?.plan || !Array.isArray(run?.branches)) return undefined
  return agentRunSubmissionBinding({
    projectId: run.projectId,
    ...(run.turnId ? { turnId: run.turnId } : {}),
    ...(run.lineage ? { lineage: run.lineage } : {}),
    plan: run.plan,
    branches: run.branches.map((branch) => ({
      id: branch.id,
      label: branch.label,
      ...(branch.assetId ? { assetId: branch.assetId } : {}),
      ...(branch.variation ? { variation: branch.variation } : {}),
      ...(branch.item !== undefined ? { item: branch.item } : {}),
    })),
  })
}

function progress(run) {
  const completedBranchCount = run.branches.filter((branch) => branch.status === 'succeeded').length
  const failedBranchCount = run.branches.filter((branch) => branch.status === 'failed' || branch.status === 'cancelled').length
  let status = 'queued'
  if (run.branches.some((branch) => branch.status === 'running')) status = 'running'
  else if (run.branches.some((branch) => branch.status === 'queued')) status = 'queued'
  else if (completedBranchCount === run.branches.length) status = 'completed'
  else if (completedBranchCount) status = 'partial'
  else if (run.branches.every((branch) => branch.status === 'cancelled')) status = 'cancelled'
  else status = 'failed'
  return { ...run, status, completedBranchCount, failedBranchCount }
}

export function createPersistentAgentRun(input, {
  id = `agent_run_${randomUUID()}`,
  ownerId,
  now = Date.now(),
  idempotencyBinding,
} = {}) {
  if (!ownerId) throw new TypeError('Agent Run 缺少所有者。')
  return progress({
    id,
    ownerId,
    projectId: input.projectId,
    ...(idempotencyBinding ? { idempotencyBinding: structuredClone(idempotencyBinding) } : {}),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.lineage ? { lineage: structuredClone(input.lineage) } : {}),
    status: 'queued',
    plan: structuredClone(input.plan),
    branches: input.branches.map((branch) => ({
      ...branch,
      status: 'queued',
      attempt: 0,
      jobIds: [],
      outputCount: 0,
      updatedAt: now,
    })),
    createdAt: now,
    updatedAt: now,
  })
}

export function applyGenerationJobToAgentRun(run, job) {
  if (!job?.agentRun || job.agentRun.runId !== run.id) return run
  const branchIndex = run.branches.findIndex((branch) => branch.id === job.agentRun.branchId)
  if (branchIndex < 0 || !branchStatuses.has(job.status)) return run
  const now = Number(job.updatedAt) || Date.now()
  const currentBranch = run.branches[branchIndex]
  // activeJobId 是分支当前 execution identity。新 retry 已切换 identity 后，旧 Job
  // 即便 terminal 投影更晚到达，也只能留在 jobIds 历史，不能夺回活动分支。
  if (currentBranch.activeJobId && currentBranch.activeJobId !== job.id) return run
  const currentUpdatedAt = Number(currentBranch.updatedAt) || 0
  if (currentUpdatedAt > now
    || (currentUpdatedAt === now
      && ['succeeded', 'failed', 'cancelled'].includes(currentBranch.status)
      && ['queued', 'running'].includes(job.status))) {
    return run
  }
  const projectedOutputCount = Array.isArray(job.outputs) ? job.outputs.length : currentBranch.outputCount ?? 0
  if (currentUpdatedAt === now
    && currentBranch.activeJobId === job.id
    && currentBranch.status === job.status
    && (currentBranch.outputCount ?? 0) === projectedOutputCount
    && (currentBranch.error ?? undefined) === (job.error ?? undefined)) return run
  const branches = run.branches.map((branch, index) => index !== branchIndex ? branch : {
    ...branch,
    status: job.status,
    activeJobId: job.id,
    jobIds: [...new Set([...(branch.jobIds ?? []), job.id])],
    outputCount: projectedOutputCount,
    ...(job.error ? { error: job.error } : { error: undefined }),
    updatedAt: now,
  })
  return progress({ ...run, branches, updatedAt: now })
}

/**
 * 普通整 Run 写入的分支级合并。
 *
 * 一个调用方可能只更新 A 分支，却携带读取时的旧 B 快照；仅按 Run.updatedAt LWW
 * 会把 B 的并发 terminal Generation 投影覆盖掉。attempt 先确定 retry 世代，同世代
 * 再按分支 updatedAt/terminal 优先合并，最后统一重算 Run 进度。
 */
export function mergeAgentRunForWrite(existing, incoming) {
  if (!existing || existing.id !== incoming?.id) return incoming
  let candidateRun = incoming
  if (existing.idempotencyBinding) {
    candidateRun = structuredClone(incoming)
    for (const field of [
      'id', 'ownerId', 'projectId', 'createdAt', 'turnId', 'lineage', 'plan', 'idempotencyBinding',
    ]) {
      if (Object.hasOwn(existing, field)) candidateRun[field] = structuredClone(existing[field])
      else delete candidateRun[field]
    }
    const incomingBranches = new Map((incoming.branches ?? []).map((branch) => [branch.id, branch]))
    candidateRun.branches = (existing.branches ?? []).map((stored) => {
      const candidate = structuredClone(incomingBranches.get(stored.id) ?? stored)
      for (const field of ['id', 'label', 'assetId', 'variation', 'item']) {
        if (Object.hasOwn(stored, field)) candidate[field] = structuredClone(stored[field])
        else delete candidate[field]
      }
      return candidate
    })
  }
  if (!(existing.branches?.length) && !(candidateRun.branches?.length)) {
    // awaiting_confirmation 等尚未展开分支的 Run 仍由实体 LWW 管理；空集合不能按
    // “全部分支成功”误算成 completed。
    return {
      ...existing,
      ...candidateRun,
      updatedAt: Math.max(Number(existing.updatedAt) || 0, Number(candidateRun.updatedAt) || 0),
    }
  }
  const existingBranches = new Map((existing.branches ?? []).map((branch) => [branch.id, branch]))
  const seen = new Set()
  const branches = (candidateRun.branches ?? []).map((candidate) => {
    seen.add(candidate.id)
    const stored = existingBranches.get(candidate.id)
    if (!stored) return candidate
    const storedAttempt = Number(stored.attempt) || 0
    const candidateAttempt = Number(candidate.attempt) || 0
    if (storedAttempt > candidateAttempt) return stored
    if (candidateAttempt > storedAttempt) return candidate
    if (stored.activeJobId && stored.activeJobId !== candidate.activeJobId) {
      // 同一 attempt 出现两个 identity 是冲突快照；保留行锁内权威分支，避免旧整行写
      // 凭更大的 Run.updatedAt 偷换或清空 execution identity。
      return stored
    }
    const storedUpdatedAt = Number(stored.updatedAt) || 0
    const candidateUpdatedAt = Number(candidate.updatedAt) || 0
    if (storedUpdatedAt > candidateUpdatedAt) return stored
    if (candidateUpdatedAt > storedUpdatedAt) return candidate
    if (['succeeded', 'failed', 'cancelled'].includes(stored.status)
      && ['queued', 'running'].includes(candidate.status)) return stored
    return candidate
  })
  for (const stored of existing.branches ?? []) {
    if (!seen.has(stored.id)) branches.push(stored)
  }
  const updatedAt = Math.max(
    Number(existing.updatedAt) || 0,
    Number(candidateRun.updatedAt) || 0,
    ...branches.map((branch) => Number(branch.updatedAt) || 0),
  )
  return progress({ ...existing, ...candidateRun, branches, updatedAt })
}

export function prepareAgentBranchRetry(run, branchId, { jobId, now = Date.now() }) {
  const target = run.branches.find((branch) => branch.id === branchId)
  if (!target) throw new BotanicAgentRunError(404, 'AGENT_BRANCH_NOT_FOUND', '未找到 Agent 分支。')
  if (!['failed', 'cancelled'].includes(target.status)) {
    throw new BotanicAgentRunError(409, 'AGENT_BRANCH_NOT_RETRYABLE', '只有失败或取消的分支可以重试。')
  }
  const branches = run.branches.map((branch) => branch.id !== branchId ? branch : {
    ...branch,
    status: 'queued',
    attempt: (branch.attempt ?? 0) + 1,
    activeJobId: jobId,
    jobIds: [...new Set([...(branch.jobIds ?? []), jobId])],
    outputCount: 0,
    error: undefined,
    updatedAt: now,
  })
  return progress({ ...run, branches, updatedAt: now })
}

export function cancelPersistentAgentRun(run, { now = Date.now() } = {}) {
  const hasActiveBranch = run.branches.some((branch) => branch.status === 'queued' || branch.status === 'running')
  if (!hasActiveBranch) return run
  const branches = run.branches.map((branch) => (
    branch.status === 'queued' || branch.status === 'running'
      ? { ...branch, status: 'cancelled', error: undefined, updatedAt: now }
      : branch
  ))
  return progress({ ...run, branches, updatedAt: now })
}

/**
 * 用户已确认，但在任何 Generation Job 建立前发生可确定的业务失败时，
 * 将空排队 Run 收口为可见的 failed。已绑定 Job 的 Run 由 Job 状态机推进，
 * 网络等未知错误也不调用此函数，以便后续幂等确认。
 */
export function failUnsubmittedPersistentAgentRun(run, error, { now = Date.now() } = {}) {
  if (!run || run.status !== 'queued' || run.branches.some((branch) => branch.activeJobId || branch.jobIds?.length)) {
    return run
  }
  const message = typeof error === 'string' && error.trim() ? error.trim() : 'Agent 任务未能提交。'
  return progress({
    ...run,
    branches: run.branches.map((branch) => ({
      ...branch,
      status: 'failed',
      error: message,
      updatedAt: now,
    })),
    updatedAt: now,
  })
}

/**
 * Run 读模型。`compiledPlanProvenance` 是读时判定：历史 Run 只有计划草案，标记为
 * legacy 而不是伪造一份完整快照 —— 伪造出来的快照会声称「这就是当时确认的内容」，
 * 但它不是（ADR 0005 不变量五）。
 */
export function publicAgentRun(run) {
  if (!run) return undefined
  const { ownerId: _ownerId, ...publicRun } = run
  return {
    ...structuredClone(publicRun),
    compiledPlanProvenance: agentRunCompiledPlanProvenance(run),
  }
}
