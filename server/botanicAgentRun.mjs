import { randomUUID } from 'node:crypto'

const intents = new Set([
  'initial_generation',
  'continue_generation', 'replace_scene', 'replace_person', 'replace_product',
  'change_pose', 'change_style', 'batch_variation', 'redo_from_root',
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

function text(value, name, maximumLength = 6000) {
  if (typeof value !== 'string' || !value.trim()) throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', `${name}不能为空。`)
  if (value.length > maximumLength) throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', `${name}过长。`)
  return value.trim()
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
      ...(call.error ? { error: text(call.error, `第 ${index + 1} 个工具错误`, 1000) } : {}),
    }
  })
}

function validateSettings(rawSettings) {
  if (!rawSettings || typeof rawSettings !== 'object' || Array.isArray(rawSettings)) {
    throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', 'Agent 生成参数无效。')
  }
  return {
    model: text(rawSettings.model, '生成模型', 160),
    aspectRatio: text(rawSettings.aspectRatio, '画面比例', 32),
    resolution: text(rawSettings.resolution, '输出规格', 32),
    ...(rawSettings.duration === undefined ? {} : { duration: Number(rawSettings.duration) }),
  }
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
    return result
  })
}

export function validateAgentRunCreation(body) {
  if (!body || typeof body !== 'object') throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', 'Agent Run 不能为空。')
  if (containsMediaPayload(body)) throw new BotanicAgentRunError(400, 'AGENT_RUN_MEDIA_FORBIDDEN', 'Agent Run 不能包含图片或媒体数据。')
  const projectId = text(body.projectId, '项目', 160)
  const rawPlan = body.plan
  if (!rawPlan || typeof rawPlan !== 'object') throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', 'Agent 计划不能为空。')
  if (!intents.has(rawPlan.intent)) throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', 'Agent 计划类型不支持。')
  const output = rawPlan.output
  if (!output || !['single', 'batch_by_asset'].includes(output.mode)) throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', 'Agent 输出方式无效。')
  const count = Number(output.count)
  const candidatesPerItem = Number(output.candidatesPerItem)
  if (!Number.isInteger(count) || count < 1 || count > 20 || !Number.isInteger(candidatesPerItem) || candidatesPerItem < 1 || candidatesPerItem > 8) {
    throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', 'Agent 输出数量无效。')
  }
  if (!Array.isArray(body.branches) || !body.branches.length || body.branches.length > 20) {
    throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', 'Agent Run 需包含 1–20 个分支。')
  }
  const branches = body.branches.map((branch, index) => ({
    id: text(branch?.id, `第 ${index + 1} 个分支标识`, 160),
    label: text(branch?.label ?? `分支 ${index + 1}`, `第 ${index + 1} 个分支名称`, 160),
    ...(branch?.assetId ? { assetId: text(branch.assetId, `第 ${index + 1} 个分支素材`, 160) } : {}),
  }))
  if (new Set(branches.map((branch) => branch.id)).size !== branches.length) {
    throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', 'Agent 分支标识重复。')
  }
  const toolCalls = validateToolCalls(rawPlan.toolCalls)
  const contextSnapshot = validateContextSnapshot(rawPlan.contextSnapshot)
  const isInitialGeneration = rawPlan.intent === 'initial_generation'
  const selectedResultNodeId = rawPlan.selectedResultNodeId === undefined
    ? undefined
    : text(rawPlan.selectedResultNodeId, '父结果节点', 160)
  if (!isInitialGeneration && !selectedResultNodeId) {
    throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', '父结果节点不能为空。')
  }
  if (isInitialGeneration && !contextSnapshot?.some((item) => (
    (item.kind === '素材' || item.kind === '结果') && item.mediaKind === 'image'
  ))) {
    throw new BotanicAgentRunError(400, 'INVALID_AGENT_RUN', 'Agent 首次生成需要至少一个图片素材或图片结果。')
  }
  return {
    projectId,
    plan: {
      ...(rawPlan.plannerModel ? { plannerModel: text(rawPlan.plannerModel, 'Agent 模型', 160) } : {}),
      intent: rawPlan.intent,
      instruction: text(rawPlan.instruction, 'Agent 指令'),
      summary: text(rawPlan.summary, 'Agent 计划摘要', 1000),
      ...(selectedResultNodeId ? { selectedResultNodeId } : {}),
      prompt: text(rawPlan.prompt, 'Agent 生图提示词'),
      settings: validateSettings(rawPlan.settings),
      constraints: validateConstraints(rawPlan.constraints, { allowEmpty: isInitialGeneration }),
      output: { mode: output.mode, count, candidatesPerItem },
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

export function publicAgentRun(run) {
  if (!run) return undefined
  const { ownerId: _ownerId, ...publicRun } = run
  return structuredClone(publicRun)
}
