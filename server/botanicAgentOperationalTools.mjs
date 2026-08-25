// @ts-check
import { AgentToolRuntimeError, agentToolObject as toolObject, agentToolText as toolText } from './agentToolRuntime.mjs'
import { projectPermissionDecision } from './authorization.mjs'

/**
 * 运维只读工具：让 Agent 用**真实实体状态**回答「任务为什么失败、上次结果在哪、
 * 这批评审到哪了」，而不是从对话文案里猜（Epic 4）。
 *
 * 三条边界：
 * 1. **只返回结构化状态，不拼文案。** 拼好的句子会让模型复述而不是判断。
 * 2. **不返回私有媒体地址或对象存储凭据。** Artifact 的 `url` 是受控媒体地址，
 *    工具结果会进模型上下文，因此一律剔除，只给标识与元数据。
 * 3. **按项目角色暴露。** 没有注入读取器就不暴露对应工具 —— 模型看不到的工具不会
 *    被它声称能用。
 */

/** 每个工具需要哪个读取器；缺读取器就不暴露该工具。 */
const OPERATIONAL_READERS = Object.freeze({
  agent_run_read: 'readRun',
  generation_job_read: 'readJob',
  artifact_search: 'searchArtifacts',
  review_read: 'readReviews',
  workflow_run_read: 'readWorkflowRun',
  delivery_read: 'readDeliveries',
})

export const OPERATIONAL_READ_TOOLS = Object.freeze(Object.keys(OPERATIONAL_READERS))

const SOURCE_LABELS = new Map([
  ['agent_run_read', 'Agent 任务状态'],
  ['generation_job_read', '生成任务状态'],
  ['artifact_search', '历史结果'],
  ['review_read', '结果评审'],
  ['workflow_run_read', '工作流运行'],
  ['delivery_read', '投放交付'],
])

export function botanicAgentOperationalSourceLabels(toolCalls) {
  return [...new Set((toolCalls ?? []).map((call) => SOURCE_LABELS.get(call.name)).filter(Boolean))]
}

/**
 * 断言读取器存在。`createBotanicAgentOperationalToolDefinitions` 已按读取器过滤掉
 * 不可用的工具，因此这里只是把该保证告诉类型系统，运行时不会命中。
 */
function required(reader) {
  if (typeof reader !== 'function') throw new AgentToolRuntimeError('TOOL_NOT_AVAILABLE', '该运维工具在当前上下文不可用。', 409)
  return reader
}

function optionalText(value, label, maximum = 240) {
  return value === undefined || value === null || value === '' ? '' : toolText(value, label, maximum)
}

/** 分支状态摘要：只给状态与计数，不给 Prompt 或媒体。 */
function branchSummary(branch) {
  return {
    id: branch?.id,
    label: branch?.label,
    status: branch?.status,
    attempt: Number(branch?.attempt ?? 0),
    outputCount: Number(branch?.outputCount ?? 0),
    jobCount: (branch?.jobIds ?? []).length,
    ...(branch?.activeJobId ? { activeJobId: branch.activeJobId } : {}),
    ...(branch?.error ? { error: String(branch.error).slice(0, 300) } : {}),
  }
}

/** 任务状态摘要。失败原因给错误码与消息，不给 Provider 原始回包。 */
function jobSummary(job) {
  return {
    id: job?.id,
    status: job?.status,
    kind: job?.kind,
    model: job?.settings?.model,
    effectiveModel: job?.effectiveModel,
    provider: job?.provider,
    batchCount: Number(job?.batchCount ?? 0),
    outputCount: (job?.outputs ?? []).length,
    missingOutputCount: Number(job?.missingOutputCount ?? 0),
    createdAt: job?.createdAt,
    updatedAt: job?.updatedAt,
    ...(job?.error ? { error: String(job.error).slice(0, 300) } : {}),
    ...(job?.partialError ? { partialError: String(job.partialError).slice(0, 300) } : {}),
    // 取消回执说明费用是否可能已产生；这是「任务为什么停了」最直接的答案。
    ...(job?.cancel ? { cancel: { reason: job.cancel.reason, billing: job.cancel.billing, code: job.cancel.code } } : {}),
    ...(job?.planFingerprint ? { planFingerprint: job.planFingerprint } : {}),
    ...(job?.branchFingerprint ? { branchFingerprint: job.branchFingerprint } : {}),
    // 每次尝试用了哪个 Provider/模型：回答「为什么换模型了」。
    providerAttempts: (job?.providerAttempts ?? []).map((attempt) => ({
      provider: attempt?.provider, model: attempt?.model, startedAt: attempt?.startedAt,
    })),
    ...(job?.agentRun ? { agentRun: job.agentRun } : {}),
  }
}

/** Artifact 摘要。**剔除 url**：受控媒体地址不进模型上下文。 */
function artifactSummary(artifact) {
  const metadata = artifact?.metadata ?? {}
  return {
    id: artifact?.id,
    kind: artifact?.kind,
    label: artifact?.label,
    placement: artifact?.placement,
    createdAt: artifact?.createdAt,
    origin: artifact?.origin,
    provenance: {
      actionId: artifact?.provenance?.actionId,
      toolName: artifact?.provenance?.toolName,
      ...(artifact?.provenance?.runId ? { runId: artifact.provenance.runId } : {}),
    },
    status: metadata.status,
    ...(metadata.jobId ? { jobId: metadata.jobId } : {}),
    ...(metadata.branchId ? { branchId: metadata.branchId } : {}),
    ...(metadata.planFingerprint ? { planFingerprint: metadata.planFingerprint } : {}),
    ...(metadata.branchFingerprint ? { branchFingerprint: metadata.branchFingerprint } : {}),
    dismissed: Boolean(metadata.dismissed),
    savedToLibrary: Boolean(metadata.savedToLibrary),
  }
}

/** 评审任务摘要。覆盖策略与被跳过数必须出现，否则截断看起来像全评过了。 */
function reviewSummary(task) {
  return {
    id: task?.id,
    runId: task?.runId,
    status: task?.status,
    attempt: Number(task?.attempt ?? 0),
    qualityPolicyFingerprint: task?.qualityPolicyFingerprint,
    ...(task?.planFingerprint ? { planFingerprint: task.planFingerprint } : {}),
    coverage: {
      strategy: task?.coverage?.strategy,
      totalCandidates: Number(task?.coverage?.totalCandidates ?? 0),
      reviewedCandidates: Number(task?.coverage?.reviewedCandidates ?? 0),
      skippedCandidates: Number(task?.coverage?.skippedCandidates ?? 0),
    },
    ...(task?.error ? { error: task.error } : {}),
    results: (task?.results ?? []).map((result) => ({
      artifactId: result?.artifactId,
      verdict: result?.verdict,
      candidateStatus: result?.candidateStatus,
      criteria: (result?.criteria ?? []).map((item) => ({
        id: item?.id, layer: item?.layer, verdict: item?.verdict, evidence: item?.evidence,
      })),
    })),
    decisions: (task?.decisions ?? []).map((decision) => ({
      artifactId: decision?.artifactId, decision: decision?.decision, decidedAt: decision?.decidedAt,
    })),
  }
}

function workflowRunSummary(run) {
  return {
    id: run?.id,
    workflowId: run?.workflowId,
    workflowVersion: run?.workflowVersion,
    status: run?.status,
    items: (run?.items ?? []).map((item) => ({
      id: item?.id,
      status: item?.status,
      ...(item?.jobId ? { jobId: item.jobId } : {}),
      ...(item?.error ? { error: { code: item.error.code, message: String(item.error.message ?? '').slice(0, 300) } } : {}),
      artifactCount: (item?.artifactIds ?? []).length,
    })),
  }
}

function deliverySummary(delivery) {
  return {
    id: delivery?.id,
    name: delivery?.name,
    channel: delivery?.channel,
    status: delivery?.status,
    itemCount: (delivery?.items ?? []).length,
    createdAt: delivery?.createdAt,
    updatedAt: delivery?.updatedAt,
  }
}

/**
 * 构建只读运维工具。
 *
 * @param {{
 *   readRun?: (runId: string) => Promise<any>,
 *   readJob?: (jobId: string) => Promise<any>,
 *   searchArtifacts?: (input: { query: string, kind: string, limit: number }) => Promise<any[]>,
 *   readReviews?: (runId: string) => Promise<any[]>,
 *   readWorkflowRun?: (runId: string) => Promise<any>,
 *   readDeliveries?: () => Promise<any[]>,
 * }} [operations]
 */
export function createBotanicAgentOperationalToolDefinitions(operations = {}) {
  const has = (name) => typeof operations?.[OPERATIONAL_READERS[name]] === 'function'
  const definitions = [
    {
      name: 'agent_run_read',
      label: '读取 Agent 任务状态',
      description: '按 Run 标识读取任务与各分支的真实执行状态、重试次数与失败原因。回答任务进度或失败原因时必须先调用它，不要从对话内容推断。',
      risk: 'read',
      parameters: { type: 'object', additionalProperties: false, properties: { runId: { type: 'string', maxLength: 160 } }, required: ['runId'] },
      validate: (raw) => ({ runId: toolText(toolObject(raw, 'Agent 任务读取').runId, 'Run 标识', 160) }),
      execute: async ({ runId }) => {
        const run = await required(operations.readRun)(runId)
        if (!run) return { found: false, runId }
        return {
          found: true,
          run: {
            id: run.id,
            status: run.status,
            createdAt: run.createdAt,
            updatedAt: run.updatedAt,
            completedBranchCount: Number(run.completedBranchCount ?? 0),
            failedBranchCount: Number(run.failedBranchCount ?? 0),
            ...(run.turnId ? { turnId: run.turnId } : {}),
            ...(run.lineage ? { lineage: run.lineage } : {}),
            ...(run.compiledPlan?.planFingerprint ? { planFingerprint: run.compiledPlan.planFingerprint } : {}),
            compiledPlanProvenance: run.compiledPlanProvenance,
            branches: (run.branches ?? []).map(branchSummary),
          },
        }
      },
    },
    {
      name: 'generation_job_read',
      label: '读取生成任务状态',
      description: '按任务标识读取生成任务的状态、错误码、已产出数量与 Provider 尝试记录。不返回图片或媒体地址。',
      risk: 'read',
      parameters: { type: 'object', additionalProperties: false, properties: { jobId: { type: 'string', maxLength: 240 } }, required: ['jobId'] },
      validate: (raw) => ({ jobId: toolText(toolObject(raw, '生成任务读取').jobId, '任务标识', 240) }),
      execute: async ({ jobId }) => {
        const job = await required(operations.readJob)(jobId)
        return job ? { found: true, job: jobSummary(job) } : { found: false, jobId }
      },
    },
    {
      name: 'artifact_search',
      label: '检索历史结果',
      description: '按关键词或类型检索本项目已产出的结果条目，返回标识与状态元数据；不返回图片地址。用户问「上次那张在哪」时用它。',
      risk: 'read',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          query: { type: 'string', maxLength: 120 },
          kind: { type: 'string', maxLength: 24 },
          limit: { type: 'number' },
        },
      },
      validate: (raw) => {
        const value = toolObject(raw, '历史结果检索')
        const limit = Number(value.limit)
        return {
          query: optionalText(value.query, '检索词', 120),
          kind: optionalText(value.kind, '结果类型', 24),
          limit: Number.isFinite(limit) ? Math.max(1, Math.min(limit, 50)) : 20,
        }
      },
      execute: async (input) => {
        const artifacts = (await required(operations.searchArtifacts)(input)) ?? []
        return { total: artifacts.length, artifacts: artifacts.map(artifactSummary) }
      },
    },
    {
      name: 'review_read',
      label: '读取结果评审',
      description: '按 Run 标识读取评审任务：覆盖了几个候选、跳过了几个、逐候选的判据结论与人工决定。',
      risk: 'read',
      parameters: { type: 'object', additionalProperties: false, properties: { runId: { type: 'string', maxLength: 160 } }, required: ['runId'] },
      validate: (raw) => ({ runId: toolText(toolObject(raw, '评审读取').runId, 'Run 标识', 160) }),
      execute: async ({ runId }) => {
        const tasks = (await required(operations.readReviews)(runId)) ?? []
        return { total: tasks.length, tasks: tasks.map(reviewSummary) }
      },
    },
    {
      name: 'workflow_run_read',
      label: '读取工作流运行',
      description: '按运行标识读取生产工作流的批量运行状态与每一项的成败。',
      risk: 'read',
      parameters: { type: 'object', additionalProperties: false, properties: { runId: { type: 'string', maxLength: 160 } }, required: ['runId'] },
      validate: (raw) => ({ runId: toolText(toolObject(raw, '工作流运行读取').runId, '运行标识', 160) }),
      execute: async ({ runId }) => {
        const run = await required(operations.readWorkflowRun)(runId)
        return run ? { found: true, run: workflowRunSummary(run) } : { found: false, runId }
      },
    },
    {
      name: 'delivery_read',
      label: '读取投放交付',
      description: '读取本项目的投放交付清单与状态；不返回导出文件或媒体地址。',
      risk: 'read',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      validate: () => ({}),
      execute: async () => {
        const deliveries = (await required(operations.readDeliveries)()) ?? []
        return { total: deliveries.length, deliveries: deliveries.map(deliverySummary) }
      },
    },
  ]
  return definitions.filter((definition) => has(definition.name))
}

/**
 * 每个写工具需要的项目权限与执行器。
 *
 * Viewer 只有 `read`，因此这里六个工具对它一个都不暴露 —— 不是「点了会失败」，
 * 而是**根本看不到**：模型看不到的工具不会被它拿去向用户承诺。
 */
const OPERATIONAL_ACTIONS = Object.freeze({
  agent_branch_retry: { permission: 'create-generation', executor: 'retryBranch', risk: 'costly' },
  agent_run_cancel: { permission: 'create-generation', executor: 'cancelRun', risk: 'write' },
  artifact_promote: { permission: 'edit', executor: 'promoteArtifact', risk: 'write' },
  review_decide: { permission: 'edit', executor: 'decideReview', risk: 'write' },
  workflow_publish: { permission: 'modify-workflow', executor: 'publishWorkflow', risk: 'write' },
  workflow_run_retry_failed: { permission: 'modify-workflow', executor: 'retryWorkflowFailed', risk: 'costly' },
})

export const OPERATIONAL_ACTION_TOOLS = Object.freeze(Object.keys(OPERATIONAL_ACTIONS))

/** 某个角色能看到哪些写工具。权限矩阵是唯一来源，这里不另立一套。 */
export function operationalActionToolsForRole(role) {
  return OPERATIONAL_ACTION_TOOLS.filter((name) => (
    projectPermissionDecision(role, OPERATIONAL_ACTIONS[name].permission) === 'allow'
  ))
}

/**
 * 构建运维写工具。全部 `requiresConfirmation`：它们会花钱、改变可交付状态或发布流程，
 * 必须走既有的确认闸门与短期审批 Token，不能因为「Agent 说要做」就执行。
 *
 * @param {{ role?: string } & Record<string, any>} [input]
 */
export function createBotanicAgentOperationalActionDefinitions({ role, ...executors } = {}) {
  const allowed = new Set(operationalActionToolsForRole(role))
  const definitions = [
    {
      name: 'agent_branch_retry',
      label: '重试失败分支',
      description: '重跑一个失败的 Agent 分支。同一分支的同一次尝试复用同一个任务，不会重复扣费。',
      risk: 'costly', requiresConfirmation: true, terminal: true,
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { runId: { type: 'string', maxLength: 160 }, branchId: { type: 'string', maxLength: 160 } },
        required: ['runId', 'branchId'],
      },
      validate: (raw) => {
        const value = toolObject(raw, '分支重试')
        return {
          runId: toolText(value.runId, 'Run 标识', 160),
          branchId: toolText(value.branchId, '分支标识', 160),
        }
      },
      execute: (args, context) => executors.retryBranch(args, context),
    },
    {
      name: 'agent_run_cancel',
      label: '取消 Agent 任务',
      description: '停止一个仍在执行的 Agent 任务。已派发给生成服务的部分可能已经产生费用。',
      risk: 'write', requiresConfirmation: true, terminal: true,
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { runId: { type: 'string', maxLength: 160 } }, required: ['runId'],
      },
      validate: (raw) => ({ runId: toolText(toolObject(raw, '任务取消').runId, 'Run 标识', 160) }),
      execute: (args, context) => executors.cancelRun(args, context),
    },
    {
      name: 'artifact_promote',
      label: '把结果存入素材库',
      description: '把一个已产出的结果存入项目素材库，供后续生成复用。不覆盖原结果。',
      risk: 'write', requiresConfirmation: true, terminal: true,
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { artifactId: { type: 'string', maxLength: 240 }, name: { type: 'string', maxLength: 80 } },
        required: ['artifactId'],
      },
      validate: (raw) => {
        const value = toolObject(raw, '结果入库')
        return {
          artifactId: toolText(value.artifactId, 'Artifact 标识', 240),
          name: optionalText(value.name, '素材名称', 80),
        }
      },
      execute: (args, context) => executors.promoteArtifact(args, context),
    },
    {
      name: 'review_decide',
      label: '提交评审决定',
      description: '对一个已评审的候选提交接受、拒绝或请求重试。三者都不覆盖原结果。',
      risk: 'write', requiresConfirmation: true, terminal: true,
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          taskId: { type: 'string', maxLength: 160 },
          artifactId: { type: 'string', maxLength: 240 },
          decision: { type: 'string', enum: ['accepted', 'rejected', 'retry_requested'] },
          note: { type: 'string', maxLength: 500 },
        },
        required: ['taskId', 'artifactId', 'decision'],
      },
      validate: (raw) => {
        const value = toolObject(raw, '评审决定')
        const decision = toolText(value.decision, '评审决定', 32)
        if (!['accepted', 'rejected', 'retry_requested'].includes(decision)) {
          throw new AgentToolRuntimeError('INVALID_TOOL_ARGUMENTS', '评审决定必须是接受、拒绝或请求重试。', 400)
        }
        return {
          taskId: toolText(value.taskId, '评审任务标识', 160),
          artifactId: toolText(value.artifactId, 'Artifact 标识', 240),
          decision,
          note: optionalText(value.note, '决定说明', 500),
        }
      },
      execute: (args, context) => executors.decideReview(args, context),
    },
    {
      name: 'workflow_publish',
      label: '发布生产工作流',
      description: '把一个明确指定的生成节点发布为可复用的生产工作流版本。来源由服务端按权威画布校验。',
      risk: 'write', requiresConfirmation: true, terminal: true,
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          name: { type: 'string', maxLength: 120 },
          sourceCanvasNodeId: { type: 'string', maxLength: 160 },
        },
        required: ['name', 'sourceCanvasNodeId'],
      },
      validate: (raw) => {
        const value = toolObject(raw, '工作流发布')
        return {
          name: toolText(value.name, '工作流名称', 120),
          sourceCanvasNodeId: toolText(value.sourceCanvasNodeId, '来源画布节点', 160),
        }
      },
      execute: (args, context) => executors.publishWorkflow(args, context),
    },
    {
      name: 'workflow_run_retry_failed',
      label: '重试工作流失败项',
      description: '重跑一次工作流运行里所有失败的项。已成功的项不会重复生成。',
      risk: 'costly', requiresConfirmation: true, terminal: true,
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { runId: { type: 'string', maxLength: 160 } }, required: ['runId'],
      },
      validate: (raw) => ({ runId: toolText(toolObject(raw, '工作流重试').runId, '运行标识', 160) }),
      execute: (args, context) => executors.retryWorkflowFailed(args, context),
    },
  ]
  return definitions.filter((definition) => (
    allowed.has(definition.name)
    && typeof executors[OPERATIONAL_ACTIONS[definition.name].executor] === 'function'
  ))
}
