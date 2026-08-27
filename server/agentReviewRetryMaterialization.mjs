// @ts-check
import { createHash } from 'node:crypto'
import { agentReviewHumanDecisionCommitDecision } from './agentReviewExecution.mjs'
import { storedAgentRunSubmissionBinding } from './botanicAgentRun.mjs'
import { createIdempotencyRequestBinding, matchingIdempotencyRequestBinding } from './idempotencyRequestBinding.mjs'
import { generationArtifactId } from './productionWorkflow.mjs'

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function unchanged(kind, task) {
  return { kind, changed: false, task: clone(task), retryRuns: [], runsToInsert: [] }
}

export function agentReviewRetryRunId(taskId, reviewResultId) {
  const digest = createHash('sha256').update(`${taskId}:${reviewResultId}`).digest('base64url')
  return `agent_run_review_retry_${digest.slice(0, 32)}`
}

function derivedRunBinding(run) {
  const immutable = clone(run)
  if (immutable) delete immutable.idempotencyBinding
  return storedAgentRunSubmissionBinding(immutable)
}

function matchingRunReplay(existing, candidate) {
  return Boolean(
    existing?.id === candidate?.id
    && existing?.projectId === candidate?.projectId
    && typeof existing?.ownerId === 'string' && existing.ownerId
    && matchingIdempotencyRequestBinding(existing.idempotencyBinding, candidate.idempotencyBinding)
    && matchingIdempotencyRequestBinding(existing.idempotencyBinding, derivedRunBinding(existing))
    && existing.lineage?.relation === candidate.lineage?.relation
    && existing.lineage?.parentRunId === candidate.lineage?.parentRunId
    && existing.lineage?.parentBranchId === candidate.lineage?.parentBranchId
    && existing.lineage?.reviewTaskId === candidate.lineage?.reviewTaskId
    && existing.lineage?.sourceArtifactId === candidate.lineage?.sourceArtifactId,
  )
}

function firstRetryDecision(task, artifactId) {
  return (task?.decisions ?? [])
    .filter((decision) => decision?.artifactId === artifactId && decision?.decision === 'retry_requested')
    .sort((left, right) => (
      (Number(left?.decisionRevision) || Number.MAX_SAFE_INTEGER)
      - (Number(right?.decisionRevision) || Number.MAX_SAFE_INTEGER)
      || (Number(left?.decidedAt) || 0) - (Number(right?.decidedAt) || 0)
    ))[0]
}

function matchingMaterialization(materialization, candidate, run, task) {
  const firstDecision = firstRetryDecision(task, candidate.artifactId)
  return Boolean(
    materialization
    && matchingIdempotencyRequestBinding(materialization.requestBinding, candidate.idempotencyBinding)
    && materialization.runId === candidate.run.id
    && materialization.runOwnerId === run.ownerId
    && firstDecision
    && materialization.requestedBy === firstDecision.decidedBy
    && materialization.createdAt === firstDecision.decidedAt,
  )
}

function expectedMaterializationBinding(task, candidate) {
  return createIdempotencyRequestBinding({
    scope: 'agent-review.retry',
    projectId: task.projectId,
    request: {
      taskId: task.id,
      reviewResultId: candidate.reviewResultId,
      artifactId: candidate.artifactId,
      sourceRunId: candidate.sourceRunId,
      sourceBranchId: candidate.sourceBranchId,
      sourceJobId: candidate.sourceJobId,
      sourceOutputId: candidate.sourceOutputId,
    },
  })
}

function validQueuedCandidate(task, actorId, decision, candidate) {
  const result = (task.results ?? []).find((entry) => (
    entry?.id === candidate?.reviewResultId
    && entry?.artifactId === candidate?.artifactId
    && entry?.taskId === task.id
    && entry?.projectId === task.projectId
  ))
  const run = candidate?.run
  return Boolean(
    result
    && decision?.decision === 'retry_requested'
    && decision?.artifactId === result.artifactId
    && candidate.sourceRunId === task.runId
    && typeof candidate.sourceBranchId === 'string' && candidate.sourceBranchId
    && typeof candidate.sourceJobId === 'string' && candidate.sourceJobId
    && typeof candidate.sourceOutputId === 'string' && candidate.sourceOutputId
    && generationArtifactId(candidate.sourceJobId, candidate.sourceOutputId) === result.artifactId
    && matchingIdempotencyRequestBinding(candidate.idempotencyBinding, candidate.idempotencyBinding)
    && matchingIdempotencyRequestBinding(candidate.idempotencyBinding, expectedMaterializationBinding(task, candidate))
    && candidate.idempotencyBinding.scope === 'agent-review.retry'
    && candidate.idempotencyBinding.projectId === task.projectId
    && run?.projectId === task.projectId
    && run?.id === agentReviewRetryRunId(task.id, result.id)
    && run?.ownerId === actorId
    && run?.status === 'queued'
    && run?.plan?.output?.mode === 'single'
    && Number(run?.plan?.output?.count) === 1
    && Number(run?.plan?.output?.candidatesPerItem) === 1
    && run?.createdAt === result.createdAt
    && run?.updatedAt === result.createdAt
    && run?.lineage?.createdAt === result.createdAt
    && run?.execution === undefined
    && run?.executionVersion === undefined
    && run?.jobId === undefined
    && run?.jobIds === undefined
    && Number(run?.completedBranchCount) === 0
    && Number(run?.failedBranchCount) === 0
    && matchingIdempotencyRequestBinding(run.idempotencyBinding, run.idempotencyBinding)
    && matchingIdempotencyRequestBinding(run.idempotencyBinding, derivedRunBinding(run))
    && run.lineage?.relation === 'review_retry'
    && run.lineage?.parentRunId === task.runId
    && run.lineage?.parentBranchId === candidate.sourceBranchId
    && run.lineage?.reviewTaskId === task.id
    && run.lineage?.sourceArtifactId === result.artifactId
    && Array.isArray(run.branches) && run.branches.length === 1
    && run.branches.every((branch) => (
      branch?.status === 'queued'
      && Number(branch?.attempt) === 0
      && Array.isArray(branch?.jobIds) && branch.jobIds.length === 0
      && !branch.activeJobId
      && branch.retryClaim === undefined
      && Number(branch.outputCount) === 0
      && branch.error === undefined
      && branch.updatedAt === result.createdAt
    )),
  )
}

/**
 * HumanDecision 与 retry Run 的纯领域事务判定。Adapter 在同一锁/事务内读取 Task 与
 * 已有 Runs，调用本函数，再一次性持久化 `task + runsToInsert`。
 *
 * @param {any} existingTask
 * @param {any} command
 * @param {Map<string, any>} existingRunsById
 */
export function agentReviewRetryMaterializationDecision(existingTask, command, existingRunsById) {
  const decision = agentReviewHumanDecisionCommitDecision(existingTask, command)
  if (!['committed', 'replay'].includes(decision.kind)) {
    return { ...decision, retryRuns: [], runsToInsert: [] }
  }
  const retries = (command?.decisions ?? []).filter((entry) => entry?.decision === 'retry_requested')
  const candidates = Array.isArray(command?.retryRunCandidates) ? command.retryRunCandidates : []
  if (!retries.length && !candidates.length) {
    return { ...decision, retryRuns: [], runsToInsert: [] }
  }
  const at = Number(command?.observedAt)
  if (!Number.isFinite(at) || at <= 0
    || retries.length !== candidates.length
    || new Set(candidates.map((candidate) => candidate?.reviewResultId)).size !== candidates.length
    || new Set(candidates.map((candidate) => candidate?.run?.id)).size !== candidates.length) {
    return unchanged('conflict', existingTask)
  }
  const legacyUnknown = retries.some((requested) => {
    const result = (existingTask.results ?? []).find((entry) => entry?.artifactId === requested.artifactId)
    const hadRetryDecision = (existingTask.decisions ?? []).some((entry) => (
      entry?.artifactId === requested.artifactId && entry?.decision === 'retry_requested'
    ))
    return hadRetryDecision && !result?.retryMaterialization
  })
  if (legacyUnknown) return unchanged('legacy_unknown', existingTask)
  const decisionByArtifact = new Map(retries.map((entry) => [entry.artifactId, entry]))
  if (candidates.some((candidate) => !validQueuedCandidate(
    existingTask,
    command.actorId,
    decisionByArtifact.get(candidate?.artifactId),
    candidate,
  ))) return unchanged('conflict', existingTask)

  const runsToInsert = []
  const retryRuns = []
  const materializationByResult = new Map()
  for (const candidate of candidates) {
    const existingRun = existingRunsById?.get(candidate.run.id)
    const previousResult = (existingTask.results ?? []).find((result) => result?.id === candidate.reviewResultId)
    const previousMaterialization = previousResult?.retryMaterialization
    let run
    if (existingRun) {
      if (!matchingRunReplay(existingRun, candidate.run)) return unchanged('conflict', existingTask)
      run = clone(existingRun)
    } else {
      if (previousMaterialization) return unchanged('conflict', existingTask)
      run = clone(candidate.run)
      runsToInsert.push(run)
    }
    retryRuns.push(run)
    if (previousMaterialization) {
      if (!matchingMaterialization(previousMaterialization, candidate, run, existingTask)) {
        return unchanged('conflict', existingTask)
      }
      materializationByResult.set(candidate.reviewResultId, clone(previousMaterialization))
    } else {
      const firstDecision = firstRetryDecision(decision.task, candidate.artifactId)
      if (!firstDecision) return unchanged('conflict', existingTask)
      materializationByResult.set(candidate.reviewResultId, {
        requestBinding: clone(candidate.idempotencyBinding),
        runId: run.id,
        runOwnerId: run.ownerId,
        requestedBy: firstDecision.decidedBy,
        createdAt: firstDecision.decidedAt,
      })
    }
  }
  const task = {
    ...decision.task,
    results: (decision.task.results ?? []).map((result) => {
      const materialization = materializationByResult.get(result?.id)
      return materialization ? { ...result, retryMaterialization: materialization } : result
    }),
  }
  return {
    ...decision,
    changed: decision.changed,
    task,
    retryRuns,
    runsToInsert,
  }
}
