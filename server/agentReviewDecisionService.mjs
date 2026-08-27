// @ts-check
import {
  agentRunSubmissionBinding,
  createPersistentAgentRun,
  createReviewRetryAgentRunInput,
  validateAgentRunCreation,
} from './botanicAgentRun.mjs'
import { agentReviewResultId, createAgentHumanDecision } from './agentReviewTask.mjs'
import { agentReviewRetryRunId } from './agentReviewRetryMaterialization.mjs'
import { createIdempotencyRequestBinding, matchingIdempotencyRequestBinding } from './idempotencyRequestBinding.mjs'
import { generationArtifactId } from './productionWorkflow.mjs'

export class AgentReviewDecisionServiceError extends Error {
  constructor(statusCode, code, message) {
    super(message)
    this.name = 'AgentReviewDecisionServiceError'
    this.statusCode = statusCode
    this.code = code
  }
}

function requiredText(value, label, maximum = 200) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentReviewDecisionServiceError(400, 'INVALID_AGENT_REVIEW', `${label}不能为空。`)
  }
  if (value.length > maximum) {
    throw new AgentReviewDecisionServiceError(400, 'INVALID_AGENT_REVIEW', `${label}过长。`)
  }
  return value.trim()
}

function invalidRetryCommit() {
  throw new AgentReviewDecisionServiceError(
    409,
    'AGENT_REVIEW_RETRY_COMMIT_INVALID',
    '评审决定未与对应的重试 Run 一起原子提交。',
  )
}

function matchingCommittedDecision(stored, requested) {
  return Boolean(
    stored?.id === requested?.id
    && stored?.taskId === requested?.taskId
    && stored?.projectId === requested?.projectId
    && stored?.artifactId === requested?.artifactId
    && stored?.decision === requested?.decision
    && stored?.candidateStatus === requested?.candidateStatus
    && stored?.decidedBy === requested?.decidedBy
    && stored?.commandId === requested?.commandId
    && stored?.idempotencyKey === requested?.idempotencyKey
    && stored?.note === requested?.note,
  )
}

function committedOutcome(decision, retryRunCandidates, requestedDecisions) {
  if (decision?.kind === 'committed' || decision?.kind === 'replay') {
    const retryRuns = Array.isArray(decision.retryRuns) ? decision.retryRuns : []
    if (retryRuns.length !== retryRunCandidates.length) invalidRetryCommit()
    const runsById = new Map(retryRuns.map((run) => [run?.id, run]))
    if (runsById.size !== retryRuns.length) invalidRetryCommit()
    for (const candidate of retryRunCandidates) {
      const stored = runsById.get(candidate.run.id)
      if (!stored
        || stored.projectId !== candidate.run.projectId
        || stored.lineage?.relation !== 'review_retry'
        || stored.lineage?.reviewTaskId !== candidate.run.lineage?.reviewTaskId
        || stored.lineage?.sourceArtifactId !== candidate.run.lineage?.sourceArtifactId
        || !matchingIdempotencyRequestBinding(
          stored.idempotencyBinding,
          candidate.run.idempotencyBinding,
        )) invalidRetryCommit()
    }
    const storedDecisionsById = new Map((decision.task?.decisions ?? []).map((entry) => [entry?.id, entry]))
    const committedDecisions = requestedDecisions.map((requested) => storedDecisionsById.get(requested.id))
    if (committedDecisions.some((stored, index) => !matchingCommittedDecision(stored, requestedDecisions[index]))) {
      invalidRetryCommit()
    }
    return {
      task: decision.task,
      decisions: committedDecisions,
      retryRuns,
    }
  }
  if (decision?.kind === 'missing') {
    throw new AgentReviewDecisionServiceError(404, 'AGENT_REVIEW_TASK_NOT_FOUND', '未找到该评审任务。')
  }
  if (decision?.kind === 'not_ready') {
    throw new AgentReviewDecisionServiceError(409, 'AGENT_REVIEW_NOT_READY', '评审任务尚未完成，不能提交人工决定。')
  }
  if (decision?.kind === 'legacy_unknown') {
    throw new AgentReviewDecisionServiceError(
      409,
      'AGENT_REVIEW_RETRY_OUTCOME_UNKNOWN',
      '历史重试决定缺少原子物化记录；系统不会自动补建可能重复计费的 Run。',
    )
  }
  throw new AgentReviewDecisionServiceError(409, 'AGENT_REVIEW_DECISION_CONFLICT', '评审任务已变化，人工决定未写入。')
}

function authoritativeResult(task, artifactId) {
  if (!(task.coverage?.artifactIds ?? []).includes(artifactId)) {
    throw new AgentReviewDecisionServiceError(
      409,
      'AGENT_REVIEW_ARTIFACT_NOT_COVERED',
      '决定的候选不在本次评审覆盖范围内。',
    )
  }
  const results = (task.results ?? []).filter((result) => (
    result?.taskId === task.id
    && result?.projectId === task.projectId
    && result?.artifactId === artifactId
  ))
  const result = results.length === 1 ? results[0] : undefined
  if (!result || result.id !== agentReviewResultId(task.id, artifactId)) {
    throw new AgentReviewDecisionServiceError(
      409,
      'AGENT_REVIEW_RESULT_IDENTITY_INVALID',
      '评审结果身份不完整，不能提交人工决定。',
    )
  }
  return result
}

async function readRetrySource(productStore, task) {
  if (typeof productStore.readAgentRunForWorker !== 'function'
    || typeof productStore.readGenerationJobForWorker !== 'function') {
    throw new TypeError('评审决定服务缺少权威 Run/Job 读取 Interface。')
  }
  const sourceRun = await productStore.readAgentRunForWorker(task.runId)
  if (!sourceRun
    || sourceRun.id !== task.runId
    || sourceRun.projectId !== task.projectId
    || !['completed', 'partial'].includes(sourceRun.status)) {
    throw new AgentReviewDecisionServiceError(
      409,
      'AGENT_REVIEW_RETRY_SOURCE_INVALID',
      '评审来源 Run 不存在或不可重试。',
    )
  }

  const jobIds = [...new Set((sourceRun.branches ?? []).flatMap((branch) => (
    [...(branch.jobIds ?? []), branch.activeJobId].filter(Boolean)
  )))]
  const jobs = await Promise.all(jobIds.map((jobId) => productStore.readGenerationJobForWorker(jobId)))
  return { sourceRun, jobs: jobs.filter(Boolean) }
}

async function retrySourceForResult(sourceSnapshot, task, result) {
  const { sourceRun, jobs } = await sourceSnapshot
  const matches = []
  for (const job of jobs) {
    if (job.projectId !== task.projectId
      || job.ownerId !== sourceRun.ownerId
      || job.status !== 'succeeded'
      || job.agentRun?.runId !== sourceRun.id) continue
    const branch = sourceRun.branches?.find((candidate) => (
      candidate.id === job.agentRun?.branchId
      && ([...(candidate.jobIds ?? []), candidate.activeJobId].includes(job.id))
    ))
    if (!branch) continue
    for (const output of job.outputs ?? []) {
      const outputId = typeof output?.id === 'string' ? output.id.trim() : ''
      if (!outputId || outputId !== output.id || outputId.length > 240) continue
      if (generationArtifactId(job.id, outputId) === result.artifactId) {
        matches.push({ sourceRun, branch, job, output })
      }
    }
  }
  if (matches.length !== 1) {
    throw new AgentReviewDecisionServiceError(
      409,
      'AGENT_REVIEW_RETRY_OUTPUT_INVALID',
      '评审 Artifact 无法唯一对应源 Run 的持久化输出。',
    )
  }
  return matches[0]
}

async function retryRunCandidate(sourceSnapshot, task, result, actorId) {
  const { sourceRun, branch, job, output } = await retrySourceForResult(sourceSnapshot, task, result)
  const materializedAt = Number(result.createdAt)
  if (!Number.isFinite(materializedAt) || materializedAt <= 0) {
    throw new AgentReviewDecisionServiceError(
      409,
      'AGENT_REVIEW_RESULT_IDENTITY_INVALID',
      '评审结果缺少稳定创建时间，不能安全物化重试。',
    )
  }
  const canonicalInput = validateAgentRunCreation(createReviewRetryAgentRunInput(sourceRun, /** @type {any} */ ({
    branchId: branch.id,
    reviewTaskId: task.id,
    artifactId: result.artifactId,
    now: materializedAt,
  })))
  const run = createPersistentAgentRun(canonicalInput, /** @type {any} */ ({
    id: agentReviewRetryRunId(task.id, result.id),
    ownerId: actorId,
    now: materializedAt,
    idempotencyBinding: agentRunSubmissionBinding(canonicalInput),
  }))
  return {
    reviewResultId: result.id,
    artifactId: result.artifactId,
    sourceRunId: sourceRun.id,
    sourceBranchId: branch.id,
    sourceJobId: job.id,
    sourceOutputId: output.id,
    idempotencyBinding: createIdempotencyRequestBinding({
      scope: 'agent-review.retry',
      projectId: task.projectId,
      request: {
        taskId: task.id,
        reviewResultId: result.id,
        artifactId: result.artifactId,
        sourceRunId: sourceRun.id,
        sourceBranchId: branch.id,
        sourceJobId: job.id,
        sourceOutputId: output.id,
      },
    }),
    run,
  }
}

/**
 * HTTP 与 Tool 共用的人工评审决定服务。决定与由 `retry_requested` 物化出的 queued Run
 * 必须交给 ProductStore 在同一事务中提交；本模块不调用 Provider，也不自行写第二次。
 *
 * @param {{ productStore: any, now?: () => number }} input
 */
export function createAgentReviewDecisionService({ productStore, now = () => Date.now() }) {
  if (!productStore || typeof productStore.readAgentReviewTask !== 'function'
    || typeof productStore.commitAgentReviewHumanDecisions !== 'function') {
    throw new TypeError('评审决定服务缺少 ProductStore 原子提交 Interface。')
  }

  /**
   * @param {{
   *   actorId: string, expectedProjectId: string, taskId: string,
   *   entries: Array<{ artifactId: string, decision: string, note?: string }>,
   *   idempotencyKey: string,
   * }} command
   */
  return async function commitAgentReviewDecision(command) {
    const actorId = requiredText(command?.actorId, '决定者', 160)
    const projectId = requiredText(command?.expectedProjectId, '项目标识', 160)
    const taskId = requiredText(command?.taskId, '评审任务标识', 160)
    const idempotencyKey = requiredText(command?.idempotencyKey, '决定幂等键', 200)
    const entries = Array.isArray(command?.entries) ? command.entries : []
    if (!entries.length || entries.length > 60) {
      throw new AgentReviewDecisionServiceError(400, 'INVALID_AGENT_REVIEW', '评审决定数量无效。')
    }

    const task = await productStore.readAgentReviewTask(actorId, taskId)
    if (!task) {
      throw new AgentReviewDecisionServiceError(404, 'AGENT_REVIEW_TASK_NOT_FOUND', '未找到该评审任务。')
    }
    if (task.projectId !== projectId) {
      throw new AgentReviewDecisionServiceError(409, 'AGENT_REVIEW_PROJECT_MISMATCH', '评审任务不属于当前项目。')
    }

    const resultsByArtifact = new Map(entries.map((entry) => {
      const artifactId = requiredText(entry?.artifactId, 'Artifact 标识', 240)
      return [artifactId, authoritativeResult(task, artifactId)]
    }))
    const decidedAt = now()
    const decisions = entries.map((entry) => createAgentHumanDecision({
      taskId: task.id,
      projectId: task.projectId,
      artifactId: entry?.artifactId,
      decision: entry?.decision,
      note: entry?.note,
      decidedBy: actorId,
      commandId: entries.length > 1 ? idempotencyKey : undefined,
      idempotencyKey,
      now: decidedAt,
    }))
    const retries = decisions.filter((decision) => decision.decision === 'retry_requested')
    const sourceSnapshot = retries.length ? readRetrySource(productStore, task) : undefined
    const retryRunCandidates = await Promise.all(retries
      .map((decision) => retryRunCandidate(
        sourceSnapshot,
        task,
        resultsByArtifact.get(decision.artifactId),
        actorId,
      )))
    let outcome
    try {
      outcome = await productStore.commitAgentReviewHumanDecisions(actorId, {
        id: task.id,
        projectId: task.projectId,
        decisions,
        retryRunCandidates,
      })
    } catch (caught) {
      const failure = /** @type {any} */ (caught)
      if (failure?.code !== 'PROJECT_WRITE_FORBIDDEN') throw caught
      throw new AgentReviewDecisionServiceError(
        403,
        'PROJECT_WRITE_FORBIDDEN',
        failure.message || '当前项目角色没有提交评审决定的权限。',
      )
    }
    return committedOutcome(outcome, retryRunCandidates, decisions)
  }
}
