// @ts-check
import { createHash } from 'node:crypto'
import { memoryBindingSnapshot } from './botanicAgentMemory.mjs'

/**
 * 操作者与时间注入。运行时由 `requiredText` 校验 `actorId` 必填，这里声明为可选
 * 只为让 `= {}` 默认值能通过类型断言 —— TS 无法从 `= {}` 推出未带默认值的属性。
 * @typedef {{ actorId?: string, now?: number }} WorkflowActorOptions
 */

const workflowRunTerminalStatuses = new Set(['succeeded', 'partially_failed', 'failed', 'cancelled'])
const workflowItemTerminalStatuses = new Set(['succeeded', 'failed', 'cancelled'])

function clone(value) {
  return structuredClone(value)
}

function workflowItemIdempotencyKey(runId, itemId) {
  const digest = createHash('sha256').update(`${runId}:${itemId}`).digest('base64url')
  return `workflow_${digest}`
}

function requiredText(value, label, maximum = 2_000) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空。`)
  if (value.length > maximum) throw new Error(`${label}过长。`)
  return value.trim()
}

/**
 * 从来源解析出这次发布要固定的执行契约（Epic 7）。
 *
 * 版本必须固定 Compiled Plan 指纹、Skill / Memory 绑定与质量策略：新版本不改变历史
 * 或进行中的 Run，靠的就是「运行读版本里这份快照」而不是「运行时再去问当前状态」。
 * 取不到就不写，缺字段在读取时表现为「这个版本没固定它」，而不是伪造一份。
 */
export function resolveWorkflowExecutionContract(source, document) {
  const nodes = Array.isArray(document?.nodes) ? document.nodes : []
  const resultNodes = (source?.resultNodeIds ?? [])
    .map((nodeId) => nodes.find((entry) => entry?.id === nodeId))
    .filter(Boolean)
  const sourceNode = nodes.find((entry) => entry?.id === source?.canvasNodeId)
  // 结果节点的配方是执行时真正用过的那一份；生成节点上的是草稿。
  const recipe = resultNodes.map((node) => node?.data?.generationRecipe).find(Boolean)
    ?? sourceNode?.data?.generationRecipe
  const run = (Array.isArray(document?.agentRuns) ? document.agentRuns : [])
    .find((entry) => entry?.id === source?.runId)
  return {
    ...(recipe?.planFingerprint ? { planFingerprint: recipe.planFingerprint } : {}),
    ...(recipe?.branchFingerprint ?? recipe?.sourcePlanFingerprint
      ? { branchFingerprint: recipe.branchFingerprint ?? recipe.sourcePlanFingerprint }
      : {}),
    ...(recipe?.qualityPolicy ? { qualityPolicy: clone(recipe.qualityPolicy) } : {}),
    ...(recipe?.skillBindings?.length ? { skillBindings: clone(recipe.skillBindings) } : {}),
    ...(recipe?.memoryBindings?.length
      ? { memoryBindings: clone(recipe.memoryBindings) }
      : run?.plan?.memoryBindings?.length ? { memoryBindings: clone(run.plan.memoryBindings) } : {}),
  }
}

/**
 * 工作流版本里的品牌规则由**服务端**从权威文档派生，不采信客户端提交的那一份。
 *
 * 这里是「项目内只允许一条 Memory 读取路径」的落点之一（ADR 0006）：客户端草稿
 * 曾直接 `agentMemory.map(item => item.content)`，把未确认的记忆写进了不可变定义，
 * 而且只存内容不存版本 —— 版本无法解释自己用了哪条规则的哪个版本。
 *
 * 规则内容与绑定分开存：内容供 Prompt 构造（Epic 7 消费），绑定用于解释与追溯。
 */
export function resolveWorkflowBrandRules(document) {
  const bindings = memoryBindingSnapshot(document?.agentMemory ?? [], { limit: 30 })
  const byId = new Map((document?.agentMemory ?? []).map((item) => [item?.id, item]))
  return {
    brandRules: bindings.map((binding) => byId.get(binding.id)?.content).filter((content) => typeof content === 'string' && content.trim()),
    brandRuleBindings: bindings,
  }
}

function normalizeDefinition(value) {
  const definition = clone(value ?? {})
  definition.prompt = requiredText(definition.prompt, '工作流 Prompt', 12_000)
  definition.model = requiredText(definition.model, '工作流模型', 160)
  definition.settings = clone(definition.settings ?? {})
  definition.output = clone(definition.output ?? {})
  definition.brandRules = Array.isArray(definition.brandRules)
    ? definition.brandRules.map((rule) => requiredText(rule, '品牌规则', 1_000))
    : []
  definition.planFingerprint = definition.planFingerprint ? requiredText(definition.planFingerprint, '计划指纹', 200) : undefined
  definition.branchFingerprint = definition.branchFingerprint ? requiredText(definition.branchFingerprint, '分支指纹', 200) : undefined
  definition.brandRuleBindings = Array.isArray(definition.brandRuleBindings)
    ? definition.brandRuleBindings.map((binding) => ({
      id: requiredText(binding?.id, '品牌规则标识', 160),
      ...(Number.isInteger(binding?.version) ? { version: binding.version } : {}),
      ...(binding?.contentHash ? { contentHash: requiredText(binding.contentHash, '品牌规则内容摘要', 200) } : {}),
      ...(binding?.selectionReason ? { selectionReason: requiredText(binding.selectionReason, '品牌规则使用原因', 240) } : {}),
    }))
    : []
  definition.assetGroupIds = Array.isArray(definition.assetGroupIds)
    ? [...new Set(definition.assetGroupIds.map((id) => requiredText(id, '素材组', 160)))]
    : []
  definition.confirmationPolicy = definition.confirmationPolicy ?? 'before-submit'
  // 质量门默认开启：一批要交付出去的图，默认应当有人过目。显式写 false 才关闭。
  definition.output = {
    ...definition.output,
    reviewRequired: definition.output?.reviewRequired !== false,
  }
  return definition
}

export class ProductionWorkflowSourceError extends Error {
  constructor(code, message, statusCode = 409) {
    super(message)
    this.name = 'ProductionWorkflowSourceError'
    this.code = code
    this.statusCode = statusCode
  }
}

/** Artifact 标识格式的唯一实现；工作流对账与来源解析共用，避免两处各拼一份。 */
export function generationArtifactId(jobId, outputId) {
  return `generation:${jobId}:${outputId}`
}

/**
 * 来源字段的文本校验。必须抛具名来源错误而不是通用 Error，否则路由无法区分
 * 「请求形状不对」（400）和「服务端异常」（500），畸形来源会被误报成 500。
 */
function sourceText(value, label, maximum = 160) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProductionWorkflowSourceError('WORKFLOW_SOURCE_INVALID', `${label}不能为空。`, 400)
  }
  if (value.length > maximum) {
    throw new ProductionWorkflowSourceError('WORKFLOW_SOURCE_INVALID', `${label}过长。`, 400)
  }
  return value.trim()
}

/**
 * 校验并解析显式发布来源。来源实体必须都属于当前项目文档：画布节点存在且是生成节点，
 * Agent Run 已进入终态，分支归属该 Run，结果节点归属同一 Run/分支并带稳定任务与候选标识。
 * 服务端不猜来源 —— 任何一项不成立都明确拒绝，而不是退到别的节点或静默丢弃。
 */
export function resolveProductionWorkflowSource(source, document) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new ProductionWorkflowSourceError('WORKFLOW_SOURCE_REQUIRED', '发布生产工作流必须显式指定来源。', 400)
  }
  const canvasNodeId = sourceText(source.canvasNodeId, '来源画布节点')
  const nodes = Array.isArray(document?.nodes) ? document.nodes : []
  const node = nodes.find((entry) => entry?.id === canvasNodeId)
  if (!node) throw new ProductionWorkflowSourceError('WORKFLOW_SOURCE_NODE_NOT_FOUND', '来源画布节点不存在或已被删除，请重新选择。')
  if (node.type !== 'generate') throw new ProductionWorkflowSourceError('WORKFLOW_SOURCE_NODE_INVALID', '来源画布节点不是生成节点。')

  const runId = source.runId === undefined ? undefined : sourceText(source.runId, '来源 Agent Run')
  const branchId = source.branchId === undefined ? undefined : sourceText(source.branchId, '来源 Agent 分支')
  if (branchId && !runId) throw new ProductionWorkflowSourceError('WORKFLOW_SOURCE_BRANCH_WITHOUT_RUN', '来源分支必须同时指定所属 Agent Run。')
  let run
  if (runId) {
    const runs = Array.isArray(document?.agentRuns) ? document.agentRuns : []
    run = runs.find((entry) => entry?.id === runId)
    if (!run) throw new ProductionWorkflowSourceError('WORKFLOW_SOURCE_RUN_NOT_FOUND', '来源 Agent Run 不存在或不属于当前项目，请重新选择。')
    if (!['completed', 'partial'].includes(run.status)) {
      throw new ProductionWorkflowSourceError('WORKFLOW_SOURCE_RUN_NOT_TERMINAL', '来源 Agent Run 尚未完成，不能发布为生产工作流。')
    }
    // 分支集合可能因历史快照而缺省；有记录时必须匹配，避免跨分支误发布。
    const branches = Array.isArray(run.branches) ? run.branches : []
    if (branchId && branches.length && !branches.some((entry) => entry?.id === branchId)) {
      throw new ProductionWorkflowSourceError('WORKFLOW_SOURCE_BRANCH_NOT_FOUND', '来源分支不属于该 Agent Run，请重新选择。')
    }
  }

  const resultNodeIds = Array.isArray(source.resultNodeIds) ? source.resultNodeIds : []
  if (resultNodeIds.length > 64) throw new ProductionWorkflowSourceError('WORKFLOW_SOURCE_RESULTS_INVALID', '来源结果过多。', 400)
  const seen = new Set()
  const artifactIds = resultNodeIds.map((value, index) => {
    const resultNodeId = sourceText(value, `第 ${index + 1} 个来源结果`)
    if (seen.has(resultNodeId)) throw new ProductionWorkflowSourceError('WORKFLOW_SOURCE_RESULTS_INVALID', '来源结果重复。', 400)
    seen.add(resultNodeId)
    const resultNode = nodes.find((entry) => entry?.id === resultNodeId)
    if (!resultNode || resultNode.type !== 'result') {
      throw new ProductionWorkflowSourceError('WORKFLOW_SOURCE_RESULT_NOT_FOUND', '来源结果不存在或已被删除，请重新选择。')
    }
    const data = resultNode.data ?? {}
    if (runId && (data.agentRun?.runId !== runId || (branchId && data.agentRun?.branchId !== branchId))) {
      throw new ProductionWorkflowSourceError('WORKFLOW_SOURCE_RESULT_MISMATCH', '来源结果不属于所选 Agent Run 或分支。')
    }
    if (!data.jobId || !data.candidateId) {
      throw new ProductionWorkflowSourceError('WORKFLOW_SOURCE_RESULT_UNRESOLVED', '来源结果缺少稳定任务标识，请等待生成完成后再发布。')
    }
    return generationArtifactId(data.jobId, data.candidateId)
  })

  return {
    canvasNodeId,
    ...(runId ? { runId } : {}),
    ...(branchId ? { branchId } : {}),
    resultNodeIds: [...seen],
    artifactIds,
  }
}

/** 缺少来源快照的历史版本按 `legacy_unverified` 读取；不伪造来源，也不静默再发布。 */
export function productionWorkflowVersionProvenance(version) {
  if (version?.provenance === 'verified' || version?.provenance === 'legacy_unverified') return version.provenance
  return version?.source ? 'verified' : 'legacy_unverified'
}

function stableMediaId(value) {
  if (typeof value !== 'string') return undefined
  if (/^media_[A-Za-z0-9_-]+$/.test(value)) return value
  const match = value.match(/^\/api\/media\/([^/?#]+)$/)
  return match ? decodeURIComponent(match[1]) : undefined
}

/**
 * 工作流版本只保存素材/节点身份；运行时再从项目权威文档解析稳定媒体标识。
 * 这避免把 data URL、临时 Object URL 或私有对象存储地址固化进工作流。
 */
export function resolveProductionWorkflowRecipe(definition, document) {
  const recipe = clone(definition?.recipe ?? {})
  const references = Array.isArray(recipe.references) ? recipe.references : []
  const assets = Array.isArray(document?.assets) ? document.assets : []
  const nodes = Array.isArray(document?.nodes) ? document.nodes : []
  recipe.references = references.map((value, index) => {
    const reference = clone(value ?? {})
    const asset = assets.find((entry) => entry.id === reference.assetId)
    const node = nodes.find((entry) => entry.id === reference.nodeId)
    const mediaId = stableMediaId(reference.mediaId)
      ?? stableMediaId(asset?.image)
      ?? stableMediaId(node?.data?.image)
    if (!mediaId) {
      throw new Error(`生产工作流引用「${reference.name ?? `素材 ${index + 1}`}」缺少稳定媒体，请重新入库后再运行。`)
    }
    return {
      nodeId: reference.nodeId,
      assetId: reference.assetId,
      name: reference.name ?? asset?.name ?? node?.data?.name ?? `素材 ${index + 1}`,
      role: reference.role ?? asset?.role ?? node?.data?.role ?? '参考',
      primary: Boolean(reference.primary),
      priority: Number.isFinite(Number(reference.priority)) ? Number(reference.priority) : index + 1,
      mediaKind: reference.mediaKind ?? asset?.mediaKind ?? node?.data?.mediaKind ?? 'image',
      ...(reference.inputRole ? { inputRole: reference.inputRole } : {}),
      mediaId,
    }
  })
  return recipe
}

function runStatus(items, fallback = 'running') {
  if (items.some((item) => item.status === 'running' || item.status === 'queued')) return fallback
  const succeeded = items.filter((item) => item.status === 'succeeded').length
  const failed = items.filter((item) => item.status === 'failed').length
  if (succeeded === items.length) return 'succeeded'
  if (failed === items.length) return 'failed'
  if (succeeded > 0 && failed > 0) return 'partially_failed'
  return fallback
}

function reviewRequired(run) {
  return run?.definition?.output?.reviewRequired === true
}

/**
 * 生产工作流定义采用只追加版本。运行只保存版本号与版本快照引用，发布新版本
 * 不会改变正在执行或历史运行的 Prompt、模型、品牌规则和确认策略。
 *
 * `source` 必填并已由 `resolveProductionWorkflowSource` 按项目权威文档校验；
 * 版本条目固定该来源身份，因此历史版本始终能回答"从哪个结果发布而来"。
 */
export function createProductionWorkflowVersion(input, { actorId, now = Date.now() } = /** @type {WorkflowActorOptions} */ ({})) {
  const id = requiredText(input?.id, '工作流标识', 160)
  const projectId = requiredText(input?.projectId, '项目标识', 160)
  const name = requiredText(input?.name, '工作流名称', 120)
  if (!input?.source || typeof input.source !== 'object') {
    throw new ProductionWorkflowSourceError('WORKFLOW_SOURCE_REQUIRED', '发布生产工作流必须显式指定来源。', 400)
  }
  const previous = input.previous ? clone(input.previous) : undefined
  if (previous && (previous.id !== id || previous.projectId !== projectId)) throw new Error('工作流版本归属不一致。')
  const version = Number(previous?.currentVersion ?? 0) + 1
  const entry = {
    version,
    definition: normalizeDefinition(input.definition),
    createdAt: now,
    createdBy: requiredText(actorId, '操作者', 160),
    source: clone(input.source),
    provenance: 'verified',
  }
  return {
    id,
    projectId,
    name,
    currentVersion: version,
    versions: [...(previous?.versions ?? []), entry],
    createdAt: previous?.createdAt ?? now,
    createdBy: previous?.createdBy ?? entry.createdBy,
    updatedAt: now,
    updatedBy: entry.createdBy,
  }
}

export function productionWorkflowVersion(workflow, version = workflow?.currentVersion) {
  return workflow?.versions?.find((entry) => entry.version === Number(version))
}

/**
 * 批量输入字段词表（Epic 7）。
 *
 * 声明式而不是自由 map：批量项要能按 SKU/渠道/语言重跑与对账，字段名一旦各写各的，
 * 「重试这 2 个失败项」就无从定位是哪两个。未声明的键仍可放进 `variables` 供 Prompt
 * 插值，但不参与身份。
 */
export const WORKFLOW_INPUT_FIELDS = Object.freeze(['sku', 'channel', 'language', 'aspectRatio', 'copy', 'assetGroupId'])

/** 参与项标识的字段，按此顺序取第一个非空值。 */
const identityFields = ['sku', 'channel', 'language']

function safeIdentitySegment(value) {
  return String(value ?? '').trim().replace(/[^A-Za-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 48)
}

/**
 * 规格化一个批量输入项。
 *
 * 项标识优先来自业务身份（SKU → 渠道 → 语言），而不是 `item-${index}` —— 位置标识
 * 在重排或补项之后会指向另一行，重试就会打到错误的项上。
 *
 * @param {any} raw
 * @param {{ index: number, taken?: Set<string> }} context
 */
export function normalizeWorkflowItemInput(raw, { index, taken = new Set() } = /** @type {any} */ ({})) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const declared = {}
  for (const field of WORKFLOW_INPUT_FIELDS) {
    if (value[field] === undefined || value[field] === null || value[field] === '') continue
    declared[field] = requiredText(value[field], `批量输入「${field}」`, 400)
  }
  const rawVariables = value.variables && typeof value.variables === 'object' && !Array.isArray(value.variables)
    ? value.variables
    : {}
  const variables = {}
  for (const [key, entry] of Object.entries(rawVariables).slice(0, 40)) {
    if (entry === undefined || entry === null || entry === '') continue
    variables[requiredText(key, '批量变量名', 60)] = requiredText(entry, `批量变量「${key}」`, 1_000)
  }
  // 声明字段同时进插值上下文：Prompt 里写 {{sku}} 应当直接可用，不必让用户重复填一遍。
  for (const [field, entry] of Object.entries(declared)) if (variables[field] === undefined) variables[field] = entry
  const explicit = value.id === undefined || value.id === null || value.id === ''
    ? undefined
    : requiredText(value.id, '运行项标识', 160)
  const identity = identityFields.map((field) => safeIdentitySegment(declared[field])).filter(Boolean).join('_')
  let id = explicit ?? (identity || `item-${index + 1}`)
  if (taken.has(id)) {
    // 同一 SKU 在同一批里出现两次是输入错误，不是可以静默去重的情况。
    throw new Error(`工作流运行项标识重复：${id}`)
  }
  taken.add(id)
  return {
    id,
    ...declared,
    ...(Object.keys(variables).length ? { variables } : {}),
    ...(value.rawInput !== undefined ? { rawInput: clone(value.rawInput) } : {}),
    ...(value.recipe !== undefined ? { recipe: clone(value.recipe) } : {}),
    ...(value.sourceVersionId ? { sourceVersionId: requiredText(value.sourceVersionId, '来源版本', 160) } : {}),
  }
}

export function createProductionWorkflowRun(input, { actorId, now = Date.now() } = /** @type {WorkflowActorOptions} */ ({})) {
  const workflow = clone(input?.workflow)
  const version = productionWorkflowVersion(workflow, input?.workflowVersion)
  if (!version) throw new Error('工作流版本不存在。')
  const id = requiredText(input?.id, '运行标识', 160)
  const itemInputs = Array.isArray(input?.itemInputs) ? input.itemInputs : []
  if (!itemInputs.length) throw new Error('工作流运行至少需要一个输入项。')
  const ids = new Set()
  const items = itemInputs.map((item, index) => {
    const normalized = normalizeWorkflowItemInput(item, { index, taken: ids })
    return {
      id: normalized.id,
      index,
      input: normalized,
      status: 'queued',
      attempt: 1,
      idempotencyKey: workflowItemIdempotencyKey(id, normalized.id),
      updatedAt: now,
    }
  })
  return {
    id,
    workflowId: workflow.id,
    workflowVersion: version.version,
    projectId: workflow.projectId,
    definition: clone(version.definition),
    status: 'queued',
    qualityGate: {
      required: version.definition.output?.reviewRequired === true,
      status: version.definition.output?.reviewRequired === true ? 'pending' : 'not_required',
    },
    items,
    createdAt: now,
    createdBy: requiredText(actorId, '操作者', 160),
    updatedAt: now,
  }
}

export function transitionProductionWorkflowRun(value, action, { now = Date.now(), actorId } = /** @type {WorkflowActorOptions} */ ({})) {
  const run = clone(value)
  if (workflowRunTerminalStatuses.has(run.status)) throw new Error('工作流运行已进入终态。')
  if (action === 'start' && run.status !== 'queued') throw new Error('只有排队中的工作流可以启动。')
  if (action === 'pause' && run.status !== 'running') throw new Error('只有执行中的工作流可以暂停。')
  if (action === 'resume' && run.status !== 'paused') throw new Error('只有暂停的工作流可以恢复。')
  if (['approve-review', 'reject-review'].includes(action) && run.status !== 'awaiting_review') {
    throw new Error('只有等待质量评审的工作流可以提交评审决策。')
  }
  if (!['start', 'pause', 'resume', 'cancel', 'approve-review', 'reject-review'].includes(action)) throw new Error('工作流运行操作不支持。')
  if (action === 'approve-review' || action === 'reject-review') {
    run.qualityGate = {
      ...(run.qualityGate ?? { required: true }),
      status: action === 'approve-review' ? 'accepted' : 'rejected',
      decidedAt: now,
      decidedBy: actorId ?? run.createdBy,
    }
    run.status = action === 'approve-review' ? 'succeeded' : 'failed'
    run.completedAt = now
    run.updatedAt = now
    return run
  }
  if (action === 'cancel') {
    run.status = 'cancelled'
    run.items = run.items.map((item) => workflowItemTerminalStatuses.has(item.status)
      ? item
      : { ...item, status: 'cancelled', updatedAt: now })
    run.completedAt = now
  } else {
    run.status = action === 'pause' ? 'paused' : 'running'
    if (action === 'start') run.startedAt = run.startedAt ?? now
  }
  run.updatedAt = now
  return run
}

export function applyWorkflowItemResult(value, itemId, result, { now = Date.now() } = {}) {
  const run = clone(value)
  const itemIndex = run.items.findIndex((item) => item.id === itemId)
  if (itemIndex < 0) throw new Error('工作流运行项不存在。')
  if (!['running', 'succeeded', 'failed', 'cancelled'].includes(result?.status)) throw new Error('工作流运行项状态无效。')
  const nextItem = {
    ...run.items[itemIndex],
    ...clone(result),
    updatedAt: now,
  }
  if (workflowItemTerminalStatuses.has(nextItem.status)) nextItem.completedAt = now
  run.items[itemIndex] = nextItem
  run.status = runStatus(run.items, run.status === 'queued' ? 'running' : run.status)
  if (run.status === 'succeeded' && reviewRequired(run)) {
    run.status = 'awaiting_review'
    run.qualityGate = { ...(run.qualityGate ?? { required: true }), required: true, status: 'pending' }
  }
  run.updatedAt = now
  if (workflowRunTerminalStatuses.has(run.status)) run.completedAt = now
  return run
}

export function retryFailedWorkflowItems(value, { now = Date.now() } = {}) {
  const run = clone(value)
  const failedItems = run.items.filter((item) => item.status === 'failed')
  if (!failedItems.length) throw new Error('没有可重试的失败项。')
  run.items = run.items.map((item) => item.status !== 'failed' ? item : {
    ...item,
    status: 'queued',
    attempt: Number(item.attempt ?? 1) + 1,
    error: undefined,
    completedAt: undefined,
    updatedAt: now,
  })
  run.status = 'running'
  run.completedAt = undefined
  run.updatedAt = now
  return run
}

export function productionWorkflowLineage(input) {
  return {
    workflowId: input.workflowId,
    workflowVersion: input.workflowVersion,
    workflowRunId: input.runId,
    workflowItemId: input.itemId,
    generationJobId: input.jobId,
    artifactId: input.artifactId,
    canvasNodeId: input.canvasNodeId,
    sourceVersionId: input.sourceVersionId,
  }
}

/**
 * 把版本固定下来的品牌规则并进这一项的执行 Prompt（Epic 7）。
 *
 * 在此之前 `brandRules` 是**写而不读**的：发布时从权威文档派生并落库，却从不进入
 * 任何一次生成 —— 用户以为「这条流程会遵守品牌规则」，实际不会。
 *
 * 两条边界：
 * - 规则以**执行契约前缀**的形式附加，而不是拼进用户的画面描述。混进描述里模型会
 *   把「不要用饱和背景」当成画面元素去画。
 * - 规则来自版本快照而不是当前项目记忆：历史版本重跑时必须按**当时**的规则执行，
 *   否则「新版本不改变进行中的运行」就不成立。
 */
export function withWorkflowBrandRules(prompt, definition, { locale = 'zh-CN' } = {}) {
  const base = typeof prompt === 'string' ? prompt.trim() : ''
  const rules = (Array.isArray(definition?.brandRules) ? definition.brandRules : [])
    .map((rule) => (typeof rule === 'string' ? rule.trim() : ''))
    .filter(Boolean)
    .slice(0, 20)
  if (!rules.length) return base
  const header = locale === 'en' ? 'Brand rules that must hold:' : '必须遵守的品牌规则：'
  const lines = rules.map((rule) => (locale === 'en' ? `- ${rule}` : `- ${rule}`))
  return `${[header, ...lines].join('\n')}\n\n${base}`
}
