// @ts-check
import { createHash, randomUUID } from 'node:crypto'
import { isBrandConcession } from './brandKit.mjs'

/**
 * 评审任务实体（ADR 0006）。
 *
 * 三类状态相互独立：`executionStatus`（Run/Job 的执行终态）、`reviewStatus`（这里）、
 * `candidateStatus`（单个候选）。压进一个字段会让一次评审模型超时看起来像生成失败，
 * 因此本模块**从不**触碰 Run 或 Job 的状态。
 */

/** 评审任务状态。`failed` 必须是可诊断、可重试的失败，不是静默空结果。 */
export const REVIEW_TASK_STATUSES = Object.freeze(['queued', 'running', 'completed', 'failed'])

/** 候选状态。与执行状态、评审任务状态互不替代。 */
export const CANDIDATE_STATUSES = Object.freeze([
  'pending_review',
  'pending_human',
  'accepted',
  'rejected',
  'superseded',
  'promoted',
])

/** 人工决定。三者都不覆盖原 Artifact。 */
export const HUMAN_DECISIONS = Object.freeze(['accepted', 'rejected', 'retry_requested'])

/**
 * 覆盖策略。允许分层抽样，但策略必须随任务持久化且对用户可见 —— **不允许静默截断**。
 *
 * - `all`：每个候选都评。
 * - `per_branch_first`：每个分支只评第一张（历史行为，保留为显式可选项而不是隐式默认）。
 * - `capped`：全局上限，超出的候选数必须出现在读模型里。
 */
export const REVIEW_COVERAGE_STRATEGIES = Object.freeze(['all', 'per_branch_first', 'capped'])

const taskStatusSet = new Set(REVIEW_TASK_STATUSES)
const decisionSet = new Set(HUMAN_DECISIONS)
const strategySet = new Set(REVIEW_COVERAGE_STRATEGIES)

export class AgentReviewError extends Error {
  constructor(statusCode, code, message) {
    super(message)
    this.name = 'AgentReviewError'
    this.statusCode = statusCode
    this.code = code
  }
}

function requireText(value, label, maximum = 240) {
  if (typeof value !== 'string' || !value.trim()) throw new AgentReviewError(400, 'INVALID_AGENT_REVIEW', `${label}不能为空。`)
  if (value.length > maximum) throw new AgentReviewError(400, 'INVALID_AGENT_REVIEW', `${label}过长。`)
  return value.trim()
}

/** 任务标识由 (runId, qualityPolicyFingerprint) 决定：同一 Run 同一策略只有一个任务。 */
export function reviewTaskIdFor(runId, fingerprint) {
  const digest = createHash('sha256').update(`${runId}:${fingerprint ?? ''}`).digest('base64url')
  return `review_task_${digest.slice(0, 32)}`
}

/**
 * 选出要评审的候选，并把策略与被跳过的数量一起记下来。
 *
 * @param {{ candidates?: Array<{ artifactId: string, branchId?: string }>, strategy?: string, limit?: number }} [input]
 */
export function planReviewCoverage({ candidates = [], strategy = 'all', limit } = {}) {
  if (!strategySet.has(strategy)) throw new AgentReviewError(400, 'INVALID_AGENT_REVIEW', `未声明的评审覆盖策略：${strategy}`)
  const all = candidates.filter((candidate) => typeof candidate?.artifactId === 'string' && candidate.artifactId)
  let selected = all
  if (strategy === 'per_branch_first') {
    const seen = new Set()
    selected = all.filter((candidate) => {
      const key = candidate.branchId ?? candidate.artifactId
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }
  if (strategy === 'capped') {
    const cap = Math.max(1, Number(limit) || 1)
    selected = all.slice(0, cap)
  }
  return {
    strategy,
    ...(strategy === 'capped' ? { limit: Math.max(1, Number(limit) || 1) } : {}),
    totalCandidates: all.length,
    reviewedCandidates: selected.length,
    // 被跳过的数量必须出现在读模型里，否则截断看起来像「全评过了」。
    skippedCandidates: all.length - selected.length,
    artifactIds: selected.map((candidate) => candidate.artifactId),
  }
}

/**
 * 创建评审任务。
 *
 * rubric 来自 `CompiledCreativePlan.qualityPolicy` 并记录其 fingerprint —— Review
 * 不得自带硬编码 rubric，否则「结果符合用户确认的约束」无法被证明。
 */
/**
 * @param {{
 *   runId: string, projectId: string, ownerId: string, qualityPolicy: any,
 *   planFingerprint?: string, coverage?: any, now?: number,
 * }} input
 */
export function createAgentReviewTask({
  runId, projectId, ownerId, qualityPolicy, planFingerprint, coverage, now = Date.now(),
}) {
  const run = requireText(runId, 'Agent Run 标识', 160)
  const project = requireText(projectId, '项目标识', 160)
  if (!ownerId) throw new AgentReviewError(400, 'INVALID_AGENT_REVIEW', '评审任务缺少所有者。')
  if (!qualityPolicy || !Array.isArray(qualityPolicy.requiredCriteria) || !qualityPolicy.requiredCriteria.length) {
    throw new AgentReviewError(409, 'AGENT_REVIEW_POLICY_MISSING', '评审判据必须来自计划快照的质量策略。')
  }
  // 品牌判据必须进指纹（Epic 9.1）。任务标识由 (runId, qualityPolicyFingerprint) 决定，
  // 品牌规则改了却不改指纹，重新评审会命中旧任务直接返回 —— 用户以为「按新品牌规则
  // 复核过了」，实际拿到的是旧规则下的结论。
  //
  // 但**没有品牌判据时这个键必须整个缺席**，不能写成空数组：写空数组会改变所有存量
  // 策略的指纹，于是每个已评审完的 Run 都会算出一个新任务标识、再评审一次，
  // 白付一遍视觉模型的钱。
  const brandCriteria = [...(qualityPolicy.brandCriteria ?? [])]
    .map((item) => ({ id: item.id, statement: item.statement, enforcement: item.enforcement }))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
  // 自定义判据同理：判据标识已带 Skill 版本，Skill 改了版本就换标识、指纹随之改变，
  // 因此重新评审不会命中旧任务。同样只在存在时才加键，避免改变存量策略的指纹。
  const evaluatorSkills = [...(qualityPolicy.evaluatorSkills ?? [])]
    .map((item) => ({ id: item.id, contentHash: item.contentHash }))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
  const qualityPolicyFingerprint = createHash('sha256')
    .update(JSON.stringify({
      version: qualityPolicy.version ?? 1,
      requiredCriteria: [...qualityPolicy.requiredCriteria].sort(),
      humanDecisionRequired: qualityPolicy.humanDecisionRequired !== false,
      ...(brandCriteria.length ? { brandCriteria } : {}),
      ...(evaluatorSkills.length ? { evaluatorSkills } : {}),
    }))
    .digest('base64url')
  return {
    id: reviewTaskIdFor(run, qualityPolicyFingerprint),
    projectId: project,
    ownerId,
    runId: run,
    status: 'queued',
    attempt: 0,
    qualityPolicy: structuredClone(qualityPolicy),
    qualityPolicyFingerprint,
    ...(planFingerprint ? { planFingerprint } : {}),
    coverage: structuredClone(coverage ?? planReviewCoverage({ candidates: [] })),
    createdAt: now,
    updatedAt: now,
  }
}

export function agentReviewResultId(taskId, artifactId) {
  const digest = createHash('sha256').update(`${taskId}:${artifactId}`).digest('base64url')
  return `review_result_${digest.slice(0, 32)}`
}

/**
 * 单个候选的评审结论。
 *
 * 只保存业务引用与安全摘要：不得保存 Prompt、媒体字节、私有媒体地址或 Provider 回包。
 *
 * @param {{
 *   taskId: string, projectId: string, artifactId: string,
 *   branchFingerprint?: string, qualityPolicyFingerprint?: string,
 *   criteria?: Array<{
 *     id?: string, layer?: string, verdict?: string, evidence?: string,
 *     brandRuleId?: string, brandFacet?: string, brandLayer?: string, enforcement?: string,
 *   }>,
 *   verdict?: string, revisionProposal?: any, now?: number,
 * }} input
 */
export function createAgentReviewResult({
  taskId, projectId, artifactId, branchFingerprint, qualityPolicyFingerprint,
  criteria = [], verdict, revisionProposal, now = Date.now(),
}) {
  const task = requireText(taskId, '评审任务标识', 160)
  const artifact = requireText(artifactId, 'Artifact 标识', 240)
  // 上限要容得下通用判据 + 逐条品牌规则（Epic 9.1）。原来的 24 是按只有通用判据定的，
  // 品牌规则一多就会静默截断 —— 被截掉的判据看起来像「没这条要求」，而不是「没评」。
  const safeCriteria = criteria.slice(0, 120).map((item) => ({
    id: requireText(item?.id, '评审判据标识', 120),
    layer: item?.layer === 'model' || item?.layer === 'human' ? item.layer : 'deterministic',
    verdict: item?.verdict === 'pass' || item?.verdict === 'fail' ? item.verdict : 'unverifiable',
    ...(item?.evidence ? { evidence: String(item.evidence).slice(0, 400) } : {}),
    // 品牌判据的溯源字段必须留下：只有判据名的话，用户看到 fail 也不知道违反了
    // 哪条品牌规则、来自哪一层（验收要求「QA 逐条关联品牌规则」）。
    ...(item?.brandRuleId ? { brandRuleId: String(item.brandRuleId).slice(0, 160) } : {}),
    ...(item?.brandFacet ? { brandFacet: String(item.brandFacet).slice(0, 40) } : {}),
    ...(item?.brandLayer ? { brandLayer: String(item.brandLayer).slice(0, 40) } : {}),
    ...(item?.enforcement === 'should' || item?.enforcement === 'must' ? { enforcement: item.enforcement } : {}),
  }))
  // 「尽量」不满足是让步，不是不合格；判定口径与品牌 QA 摘要共用同一实现。
  const resolved = verdict ?? (safeCriteria.some((item) => item.verdict === 'fail' && !isBrandConcession(item))
    ? 'fail'
    : safeCriteria.some((item) => item.verdict === 'unverifiable') ? 'unverifiable' : 'pass')
  return {
    id: agentReviewResultId(task, artifact),
    taskId: task,
    projectId: requireText(projectId, '项目标识', 160),
    artifactId: artifact,
    ...(branchFingerprint ? { branchFingerprint } : {}),
    ...(qualityPolicyFingerprint ? { qualityPolicyFingerprint } : {}),
    criteria: safeCriteria,
    verdict: resolved,
    // 无论自动结论是 pass 还是 fail，候选都停在「待人工」：自动评审不得把结果标记为
    // 品牌批准，也不得替用户否掉一张他可能仍愿意采用的图。
    candidateStatus: 'pending_human',
    ...(revisionProposal ? { revisionProposal: structuredClone(revisionProposal) } : {}),
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * 任务是否可以收为 `completed`。
 *
 * 只有覆盖范围内的**每个** Artifact 都产出了 ReviewResult 才算完成 —— 缺一个就意味着
 * 有候选永远等不到结论，而任务却宣称评完了。
 */
export function agentReviewTaskCompletion(task, results = []) {
  const expected = new Set(task?.coverage?.artifactIds ?? [])
  const done = new Set(results.filter((item) => item?.taskId === task?.id).map((item) => item.artifactId))
  const missing = [...expected].filter((artifactId) => !done.has(artifactId))
  return { complete: missing.length === 0, missing }
}

/**
 * 结算任务状态。失败必须带可诊断的原因，不接受空错误。
 *
 * @param {any} task
 * @param {{ status?: string, error?: { code?: string, message?: string }, now?: number }} [input]
 */
export function settleAgentReviewTask(task, { status, error, now = Date.now() } = {}) {
  if (typeof status !== 'string' || !taskStatusSet.has(status)) {
    throw new AgentReviewError(400, 'INVALID_AGENT_REVIEW', `未声明的评审任务状态：${status}`)
  }
  if (status === 'failed' && !error?.code) {
    throw new AgentReviewError(400, 'INVALID_AGENT_REVIEW', '评审失败必须给出可诊断的错误码。')
  }
  const failure = status === 'failed' && error?.code
    ? { error: { code: error.code, message: String(error.message ?? '').slice(0, 500) } }
    : { error: undefined }
  return {
    ...task,
    status,
    ...(status === 'running' ? { attempt: Number(task?.attempt ?? 0) + 1 } : {}),
    ...failure,
    updatedAt: now,
  }
}

/**
 * 人工决定：以 `(artifactId, idempotencyKey)` 幂等。
 *
 * 批量接受/拒绝可以共享 `commandId`，但**必须逐候选落库** —— 给多个 Artifact 共用
 * 一个模糊状态会让「哪一张被接受了」无法回答。
 *
 * @param {{
 *   taskId: string, projectId: string, artifactId: string, decision: string,
 *   note?: string, decidedBy: string, commandId?: string, idempotencyKey: string, now?: number,
 * }} input
 */
export function createAgentHumanDecision({
  taskId, projectId, artifactId, decision, note, decidedBy, commandId, idempotencyKey, now = Date.now(),
}) {
  if (!decisionSet.has(decision)) throw new AgentReviewError(400, 'INVALID_AGENT_REVIEW', `未声明的人工决定：${decision}`)
  const key = requireText(idempotencyKey, '决定幂等键', 200)
  const artifact = requireText(artifactId, 'Artifact 标识', 240)
  const digest = createHash('sha256').update(`${artifact}:${key}`).digest('base64url')
  return {
    id: `review_decision_${digest.slice(0, 32)}`,
    taskId: requireText(taskId, '评审任务标识', 160),
    projectId: requireText(projectId, '项目标识', 160),
    artifactId: artifact,
    decision,
    candidateStatus: decision === 'accepted' ? 'accepted' : decision === 'rejected' ? 'rejected' : 'pending_review',
    ...(note ? { note: String(note).slice(0, 500) } : {}),
    decidedBy: requireText(decidedBy, '决定者', 160),
    ...(commandId ? { commandId: requireText(commandId, '批量决定标识', 200) } : {}),
    idempotencyKey: key,
    decidedAt: now,
  }
}

/**
 * 被拒绝的候选可以产出记忆建议，但**不自动激活**：它只是 `proposed`，
 * 需要人工确认才成为品牌事实（ADR 0006 与 Memory 治理同一条边界）。
 */
export function memoryProposalFromRejection(decision, { kind = 'avoid' } = {}) {
  if (decision?.decision !== 'rejected' || !decision.note) return undefined
  return {
    id: `agent-memory-${randomUUID()}`,
    kind,
    content: String(decision.note).slice(0, 1000),
    sourceNodeIds: [],
    source: 'review',
    status: 'proposed',
    evidence: [{ kind: 'review', ref: decision.id }],
  }
}

/**
 * 评审任务读模型。
 *
 * `ownerId` 不外发；覆盖策略与被跳过的候选数必须出现在读模型里 —— 静默截断会让
 * 「评了 2 张」看起来像「全评过了」（ADR 0006）。
 */
export function publicAgentReviewTask(task) {
  if (!task) return undefined
  const { ownerId: _ownerId, ...rest } = task
  return {
    ...structuredClone(rest),
    results: (task.results ?? []).map((result) => structuredClone(result)),
    decisions: (task.decisions ?? []).map((decision) => structuredClone(decision)),
  }
}
