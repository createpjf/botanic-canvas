import { randomUUID } from 'node:crypto'
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

function validateLineage(rawLineage) {
  if (rawLineage === undefined) return undefined
  if (!rawLineage || typeof rawLineage !== 'object' || rawLineage.relation !== 'fork') {
    throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', 'Agent Run 血缘关系无效。')
  }
  return {
    relation: 'fork',
    parentRunId: text(rawLineage.parentRunId, '父 Agent Run', 160),
    ...(rawLineage.parentBranchId ? { parentBranchId: text(rawLineage.parentBranchId, '父 Agent 分支', 160) } : {}),
    ...(rawLineage.rootRunId ? { rootRunId: text(rawLineage.rootRunId, '根 Agent Run', 160) } : {}),
    ...(rawLineage.createdAt === undefined ? {} : { createdAt: Number(rawLineage.createdAt) || Date.now() }),
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

export function createPersistentAgentRun(input, { id = `agent_run_${randomUUID()}`, ownerId, now = Date.now() } = {}) {
  if (!ownerId) throw new TypeError('Agent Run 缺少所有者。')
  return progress({
    id,
    ownerId,
    projectId: input.projectId,
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
  const branches = run.branches.map((branch, index) => index !== branchIndex ? branch : {
    ...branch,
    status: job.status,
    activeJobId: job.id,
    jobIds: [...new Set([...(branch.jobIds ?? []), job.id])],
    outputCount: Array.isArray(job.outputs) ? job.outputs.length : branch.outputCount ?? 0,
    ...(job.error ? { error: job.error } : { error: undefined }),
    updatedAt: now,
  })
  return progress({ ...run, branches, updatedAt: now })
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
