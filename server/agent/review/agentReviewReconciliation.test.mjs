import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AGENT_REVIEW_OUTCOME_UNKNOWN,
  agentReviewExecutionClaimDecision,
  agentReviewPreparedCheckpoint,
  committedAgentReviewExecution,
} from './agentReviewExecution.mjs'
import {
  AGENT_REVIEW_RETRY_RISK_CODE,
  agentReviewOutcomeReconciliationDecision,
} from './agentReviewReconciliation.mjs'

const baseTask = {
  id: 'review-task-1',
  projectId: 'project-1',
  ownerId: 'user-1',
  runId: 'run-1',
  status: 'queued',
  attempt: 0,
  qualityPolicyFingerprint: 'policy-1',
  coverage: { artifactIds: ['artifact-1', 'artifact-2'] },
  results: [],
  createdAt: 1_000,
  updatedAt: 1_000,
}

function resultFor(artifactId) {
  return {
    id: `result-${artifactId}`,
    taskId: baseTask.id,
    projectId: baseTask.projectId,
    artifactId,
    criteria: [{ id: 'format', layer: 'deterministic', verdict: 'pass' }],
    verdict: 'pass',
    candidateStatus: 'pending_human',
    createdAt: 2_000,
    updatedAt: 2_000,
  }
}

function outcomeUnknownTask({
  artifactId = 'artifact-2',
  coverage = ['artifact-1', 'artifact-2'],
  results = [resultFor('artifact-1')],
  reconciliation,
} = {}) {
  return {
    ...baseTask,
    status: 'failed',
    coverage: { artifactIds: coverage },
    results,
    executionVersion: 1,
    execution: {
      generation: 1,
      leaseToken: 'lease-old',
      leaseDurationMs: 30_000,
      leaseExpiresAt: 32_000,
      claimedAt: 2_000,
      lastHeartbeatAt: 2_000,
      settledAt: 32_001,
      checkpoint: agentReviewPreparedCheckpoint({ artifactId, preparedAt: 2_100 }),
    },
    error: {
      code: AGENT_REVIEW_OUTCOME_UNKNOWN,
      message: 'Provider 结果未知。',
    },
    ...(reconciliation ? { reconciliation } : {}),
    updatedAt: 32_001,
  }
}

test('continue_unverifiable 不调用 Provider，写入 truthful human_resolution 后完成覆盖', () => {
  const unknown = outcomeUnknownTask()
  const resolved = agentReviewOutcomeReconciliationDecision(unknown, {
    id: unknown.id,
    projectId: unknown.projectId,
    idempotencyKey: 'resolve-continue-1',
    action: 'continue_unverifiable',
    actorId: 'user-1',
    observedAt: 40_000,
  })

  assert.equal(resolved.kind, 'resolved')
  assert.equal(resolved.task.status, 'completed')
  assert.equal(resolved.task.error, undefined)
  assert.equal(resolved.task.execution.checkpoint, undefined)
  assert.deepEqual(resolved.task.results[0], unknown.results[0], '先前结果必须原样保留')
  const humanResult = resolved.task.results[1]
  assert.equal(humanResult.artifactId, 'artifact-2')
  assert.equal(humanResult.verdict, 'unverifiable')
  assert.equal(humanResult.candidateStatus, 'pending_human')
  assert.equal(humanResult.source, 'human_resolution')
  assert.deepEqual(humanResult.resolution, {
    kind: 'human_resolution',
    action: 'continue_unverifiable',
    reasonCode: AGENT_REVIEW_OUTCOME_UNKNOWN,
    resolvedBy: 'user-1',
    resolvedAt: 40_000,
  })
  assert.deepEqual(humanResult.criteria, [{
    id: 'provider_outcome',
    layer: 'human',
    verdict: 'unverifiable',
    evidence: 'Provider 调用结果未知；人工选择不重复调用，并保留为无法验证。',
  }])
  assert.deepEqual(resolved.task.reconciliation.resolutions[0].prior.results, [{
    id: 'result-artifact-1',
    artifactId: 'artifact-1',
    verdict: 'pass',
  }])
})

test('continue_unverifiable 只替代未知候选，剩余覆盖仍走 queued 恢复', () => {
  const unknown = outcomeUnknownTask({
    artifactId: 'artifact-2',
    coverage: ['artifact-1', 'artifact-2', 'artifact-3'],
  })
  const resolved = agentReviewOutcomeReconciliationDecision(unknown, {
    id: unknown.id,
    projectId: unknown.projectId,
    idempotencyKey: 'resolve-continue-partial',
    action: 'continue_unverifiable',
    actorId: 'user-1',
    observedAt: 40_000,
  })
  assert.equal(resolved.kind, 'resolved')
  assert.equal(resolved.task.status, 'queued')
  assert.deepEqual(resolved.task.results.map((item) => item.artifactId), ['artifact-1', 'artifact-2'])

  const nextClaim = agentReviewExecutionClaimDecision(resolved.task, {
    id: unknown.id,
    projectId: unknown.projectId,
    leaseToken: 'lease-next',
    observedAt: 41_000,
  })
  assert.equal(nextClaim.kind, 'claimed')
  assert.equal(nextClaim.task.execution.generation, 2)
  assert.equal(nextClaim.task.results.length, 2)
})

test('retry_once 保留先前结果并明确记录重复 Provider 调用风险', () => {
  const unknown = outcomeUnknownTask()
  const resolved = agentReviewOutcomeReconciliationDecision(unknown, {
    id: unknown.id,
    projectId: unknown.projectId,
    idempotencyKey: 'resolve-retry-1',
    action: 'retry_once',
    actorId: 'user-1',
    observedAt: 40_000,
  })
  assert.equal(resolved.kind, 'resolved')
  assert.equal(resolved.task.status, 'queued')
  assert.equal(resolved.task.error, undefined)
  assert.deepEqual(resolved.task.results, unknown.results)
  assert.equal(resolved.task.execution.checkpoint, undefined)
  assert.equal(resolved.task.reconciliation.retryCount, 1)
  assert.deepEqual(resolved.task.reconciliation.resolutions[0].risk, {
    code: AGENT_REVIEW_RETRY_RISK_CODE,
    acknowledged: true,
    message: '此前 Provider 是否执行成功未知；再次调用可能产生重复评审或重复计费。',
  })

  const nextClaim = agentReviewExecutionClaimDecision(resolved.task, {
    id: resolved.task.id,
    projectId: resolved.task.projectId,
    leaseToken: 'lease-retry',
    observedAt: 41_000,
  })
  assert.equal(nextClaim.kind, 'claimed')
  assert.equal(nextClaim.task.execution.generation, 2)
})

test('retry_once 最多一次；再次 outcome_unknown 后只能继续为 unverifiable', () => {
  const unknown = outcomeUnknownTask()
  const retried = agentReviewOutcomeReconciliationDecision(unknown, {
    id: unknown.id,
    projectId: unknown.projectId,
    idempotencyKey: 'resolve-retry-1',
    action: 'retry_once',
    actorId: 'user-1',
    observedAt: 40_000,
  }).task
  const claimed = agentReviewExecutionClaimDecision(retried, {
    id: retried.id,
    projectId: retried.projectId,
    leaseToken: 'lease-retry',
    leaseDurationMs: 30_000,
    observedAt: 41_000,
  }).task
  const prepared = committedAgentReviewExecution(claimed, {
    id: claimed.id,
    projectId: claimed.projectId,
    leaseToken: 'lease-retry',
    executionGeneration: 2,
    status: 'running',
    checkpoint: agentReviewPreparedCheckpoint({ artifactId: 'artifact-2', preparedAt: 41_100 }),
    observedAt: 41_100,
  }).task
  const unknownAgain = agentReviewExecutionClaimDecision(prepared, {
    id: prepared.id,
    projectId: prepared.projectId,
    leaseToken: 'lease-third',
    allowTakeover: true,
    observedAt: 71_101,
  }).task
  assert.equal(unknownAgain.status, 'failed')
  assert.equal(unknownAgain.error.code, AGENT_REVIEW_OUTCOME_UNKNOWN)
  assert.equal(unknownAgain.reconciliation.retryCount, 1)

  const secondRetry = agentReviewOutcomeReconciliationDecision(unknownAgain, {
    id: unknownAgain.id,
    projectId: unknownAgain.projectId,
    idempotencyKey: 'resolve-retry-2',
    action: 'retry_once',
    actorId: 'user-1',
    observedAt: 80_000,
  })
  assert.equal(secondRetry.kind, 'retry_limit')
  assert.equal(secondRetry.changed, false)

  const continued = agentReviewOutcomeReconciliationDecision(unknownAgain, {
    id: unknownAgain.id,
    projectId: unknownAgain.projectId,
    idempotencyKey: 'resolve-continue-after-retry',
    action: 'continue_unverifiable',
    actorId: 'user-1',
    observedAt: 80_001,
  })
  assert.equal(continued.kind, 'resolved')
  assert.equal(continued.task.status, 'completed')
  assert.equal(continued.task.reconciliation.retryCount, 1)
  assert.deepEqual(
    continued.task.reconciliation.resolutions.map((item) => item.action),
    ['retry_once', 'continue_unverifiable'],
  )
})

test('对账幂等键一次绑定；响应丢失后即使任务已完成仍重放同一结果', () => {
  const unknown = outcomeUnknownTask()
  const command = {
    id: unknown.id,
    projectId: unknown.projectId,
    idempotencyKey: 'resolve-stable',
    action: 'continue_unverifiable',
    actorId: 'user-1',
    observedAt: 40_000,
  }
  const resolved = agentReviewOutcomeReconciliationDecision(unknown, command)
  const replay = agentReviewOutcomeReconciliationDecision(resolved.task, {
    ...command,
    observedAt: 90_000,
  })
  assert.equal(replay.kind, 'replay')
  assert.equal(replay.changed, false)
  assert.equal(replay.task.reconciliation.resolutions[0].resolvedAt, 40_000)

  const rebound = agentReviewOutcomeReconciliationDecision(resolved.task, {
    ...command,
    action: 'retry_once',
  })
  assert.equal(rebound.kind, 'conflict')
})

test('非法状态、损坏历史与不可定位 checkpoint 全部 fail closed', () => {
  const completed = { ...baseTask, status: 'completed' }
  assert.equal(agentReviewOutcomeReconciliationDecision(completed, {
    id: completed.id,
    projectId: completed.projectId,
    idempotencyKey: 'resolve-invalid-state',
    action: 'retry_once',
    actorId: 'user-1',
  }).kind, 'not_reconcilable')

  const damagedHistory = outcomeUnknownTask({
    reconciliation: { version: 1, retryCount: 0, resolutions: [{ action: 'retry_once' }] },
  })
  assert.equal(agentReviewOutcomeReconciliationDecision(damagedHistory, {
    id: damagedHistory.id,
    projectId: damagedHistory.projectId,
    idempotencyKey: 'resolve-damaged',
    action: 'retry_once',
    actorId: 'user-1',
  }).kind, 'conflict')

  const damagedCheckpoint = outcomeUnknownTask()
  damagedCheckpoint.execution.checkpoint.artifactId = '/api/media/private'
  const before = structuredClone(damagedCheckpoint)
  const unresolved = agentReviewOutcomeReconciliationDecision(damagedCheckpoint, {
    id: damagedCheckpoint.id,
    projectId: damagedCheckpoint.projectId,
    idempotencyKey: 'resolve-no-artifact',
    action: 'continue_unverifiable',
    actorId: 'user-1',
  })
  assert.equal(unresolved.kind, 'conflict')
  assert.equal(unresolved.changed, false)
  assert.deepEqual(unresolved.task, before)
})
