// @ts-check
import { prepareAgentBranchRetry } from './botanicAgentRun.mjs'
import { matchingIdempotencyRequestBinding } from './idempotencyRequestBinding.mjs'

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function validCommand(command) {
  return typeof command?.runId === 'string' && command.runId.trim()
    && typeof command?.projectId === 'string' && command.projectId.trim()
    && typeof command?.branchId === 'string' && command.branchId.trim()
    && Number.isInteger(command?.expectedAttempt) && command.expectedAttempt >= 0
    && typeof command?.expectedActiveJobId === 'string' && command.expectedActiveJobId.trim()
    && typeof command?.jobId === 'string' && command.jobId.trim()
    && command.idempotencyBinding?.scope === 'agent-branch.retry'
    && command.idempotencyBinding?.projectId === command.projectId
    && matchingIdempotencyRequestBinding(command.idempotencyBinding, command.idempotencyBinding)
}

/**
 * Adapter 必须在 Agent Run 行锁内调用。source attempt + active Job 是 compare 部分，
 * 新 Job identity 是 swap 部分；retryClaim 让响应丢失/claim 后崩溃可安全重放。
 */
export function agentBranchRetryClaimDecision(existing, command) {
  if (!existing) return { kind: 'missing', changed: false, run: undefined }
  const stored = clone(existing)
  if (!validCommand(command)
    || stored.id !== command.runId
    || stored.projectId !== command.projectId) {
    return { kind: 'conflict', changed: false, run: stored }
  }
  const branch = stored.branches?.find((candidate) => candidate.id === command.branchId)
  if (!branch) return { kind: 'conflict', changed: false, run: stored }

  const replay = branch.activeJobId === command.jobId
    && Number(branch.attempt) === command.expectedAttempt + 1
    && branch.retryClaim?.sourceAttempt === command.expectedAttempt
    && branch.retryClaim?.sourceJobId === command.expectedActiveJobId
    && branch.retryClaim?.jobId === command.jobId
    && matchingIdempotencyRequestBinding(
      branch.retryClaim?.idempotencyBinding,
      command.idempotencyBinding,
    )
  if (replay) return { kind: 'replay', changed: false, run: stored }

  if (Number(branch.attempt) !== command.expectedAttempt
    || branch.activeJobId !== command.expectedActiveJobId
    || !['failed', 'cancelled'].includes(branch.status)) {
    return { kind: 'conflict', changed: false, run: stored }
  }

  const observedAt = Number(command.observedAt) || Date.now()
  const claimed = prepareAgentBranchRetry(stored, command.branchId, {
    jobId: command.jobId,
    now: observedAt,
  })
  const claimedBranch = claimed.branches.find((candidate) => candidate.id === command.branchId)
  claimedBranch.retryClaim = {
    sourceAttempt: command.expectedAttempt,
    sourceJobId: command.expectedActiveJobId,
    jobId: command.jobId,
    claimedAt: observedAt,
    idempotencyBinding: clone(command.idempotencyBinding),
  }
  return { kind: 'claimed', changed: true, run: claimed }
}

/**
 * Run CAS 与同一 Job identity 必须在一个事务内决定。否则 Run 先指向 jobId 后，
 * 另一 endpoint 可抢先用同 id 写入不同请求，留下永远指向 foreign Job 的分支。
 */
export function agentBranchRetryJobDecision(existing, command, input = {}) {
  const candidate = clone(command?.job)
  const ownerId = input.ownerId
  const observedAt = Number(input.observedAt) || Date.now()
  const valid = candidate
    && candidate.id === command?.jobId
    && candidate.projectId === command?.projectId
    && candidate.status === 'queued'
    && candidate.agentRun?.runId === command?.runId
    && candidate.agentRun?.branchId === command?.branchId
    && candidate.agentRun?.attempt === command?.expectedAttempt + 1
    && matchingIdempotencyRequestBinding(candidate.idempotencyBinding, command?.idempotencyBinding)
    && candidate.rawInput && typeof candidate.rawInput === 'object'
  if (!valid) return { kind: 'conflict', changed: false, job: clone(existing) }
  if (existing) {
    const compatible = existing.id === command.jobId
      && existing.ownerId === ownerId
      && existing.projectId === command.projectId
      && existing.agentRun?.runId === command.runId
      && existing.agentRun?.branchId === command.branchId
      && existing.agentRun?.attempt === command.expectedAttempt + 1
      && matchingIdempotencyRequestBinding(existing.idempotencyBinding, command.idempotencyBinding)
    return compatible
      ? { kind: 'compatible', changed: false, job: clone(existing) }
      : { kind: 'conflict', changed: false, job: clone(existing) }
  }
  const job = {
    ...candidate,
    ownerId,
    status: 'queued',
    createdAt: observedAt,
    updatedAt: observedAt,
    outputs: [],
  }
  delete job.execution
  delete job.executionVersion
  delete job.cancel
  delete job.error
  delete job.errorCode
  delete job.partialError
  delete job.projectWritebackPending
  return { kind: 'inserted', changed: true, job }
}
