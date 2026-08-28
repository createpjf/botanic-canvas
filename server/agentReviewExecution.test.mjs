import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AGENT_REVIEW_OUTCOME_UNKNOWN,
  agentReviewCancellationFinalizeDecision,
  agentReviewCancellationRequestDecision,
  agentReviewExecutionClaimDecision,
  agentReviewHumanDecisionCommitDecision,
  agentReviewPreparedCheckpoint,
  committedAgentReviewExecution,
} from './agentReviewExecution.mjs'

const queuedTask = {
  id: 'review-task-1',
  projectId: 'project-1',
  ownerId: 'user-1',
  runId: 'run-1',
  status: 'queued',
  attempt: 0,
  coverage: { artifactIds: ['artifact-1', 'artifact-2'] },
  results: [],
  createdAt: 1_000,
  updatedAt: 1_000,
}

test('Agent Review 原子 claim：并发 Worker 只有一个租约胜者', () => {
  const first = agentReviewExecutionClaimDecision(queuedTask, {
    id: queuedTask.id,
    projectId: queuedTask.projectId,
    leaseToken: 'lease-a',
    leaseDurationMs: 30_000,
    observedAt: 2_000,
  })
  assert.equal(first.kind, 'claimed')
  assert.equal(first.task.status, 'running')
  assert.equal(first.task.attempt, 1)
  assert.equal(first.task.execution.generation, 1)

  const loser = agentReviewExecutionClaimDecision(first.task, {
    id: queuedTask.id,
    projectId: queuedTask.projectId,
    leaseToken: 'lease-b',
    leaseDurationMs: 30_000,
    observedAt: 2_001,
    allowTakeover: true,
  })
  assert.equal(loser.kind, 'in_progress')
  assert.equal(loser.changed, false)
  assert.equal(loser.task.execution.leaseToken, 'lease-a')
})

test('Agent Review prepared 与逐候选结果都受 generation fence 保护', () => {
  const claimed = agentReviewExecutionClaimDecision(queuedTask, {
    id: queuedTask.id,
    projectId: queuedTask.projectId,
    leaseToken: 'lease-a',
    leaseDurationMs: 30_000,
    observedAt: 2_000,
  }).task
  const checkpoint = agentReviewPreparedCheckpoint({ artifactId: 'artifact-1', preparedAt: 2_100 })
  const prepared = committedAgentReviewExecution(claimed, {
    id: claimed.id,
    projectId: claimed.projectId,
    leaseToken: 'lease-a',
    executionGeneration: 1,
    status: 'running',
    checkpoint,
    observedAt: 2_100,
  })
  assert.equal(prepared.kind, 'committed')
  assert.deepEqual(prepared.task.execution.checkpoint, checkpoint)

  const result = {
    id: 'review-result-1',
    taskId: claimed.id,
    projectId: claimed.projectId,
    artifactId: 'artifact-1',
    verdict: 'pass',
  }
  const committed = committedAgentReviewExecution(prepared.task, {
    id: claimed.id,
    projectId: claimed.projectId,
    leaseToken: 'lease-a',
    executionGeneration: 1,
    status: 'running',
    result,
    checkpoint: null,
    observedAt: 2_200,
  })
  assert.equal(committed.kind, 'committed')
  assert.equal(committed.task.execution.checkpoint, undefined)
  assert.deepEqual(committed.task.results, [result])

  const stale = committedAgentReviewExecution(committed.task, {
    id: claimed.id,
    projectId: claimed.projectId,
    leaseToken: 'lease-old',
    executionGeneration: 0,
    status: 'running',
    result: { ...result, artifactId: 'artifact-2' },
    checkpoint: null,
    observedAt: 2_300,
  })
  assert.equal(stale.kind, 'stale')
  assert.deepEqual(stale.task.results, [result])
})

test('候选结果必须和已 durable 的同 Artifact prepared 在一个 CAS 内提交', () => {
  const claimed = agentReviewExecutionClaimDecision(queuedTask, {
    id: queuedTask.id,
    projectId: queuedTask.projectId,
    leaseToken: 'lease-a',
    observedAt: 2_000,
  }).task
  const result = {
    id: 'review-result-1',
    taskId: claimed.id,
    projectId: claimed.projectId,
    artifactId: 'artifact-1',
    verdict: 'pass',
  }

  const bypassedPrepare = committedAgentReviewExecution(claimed, {
    id: claimed.id,
    projectId: claimed.projectId,
    leaseToken: 'lease-a',
    executionGeneration: 1,
    status: 'running',
    result,
    checkpoint: null,
    observedAt: 2_100,
  })
  assert.equal(bypassedPrepare.kind, 'conflict')
  assert.deepEqual(bypassedPrepare.task.results, [])

  const preparedOther = committedAgentReviewExecution(claimed, {
    id: claimed.id,
    projectId: claimed.projectId,
    leaseToken: 'lease-a',
    executionGeneration: 1,
    status: 'running',
    checkpoint: agentReviewPreparedCheckpoint({ artifactId: 'artifact-2', preparedAt: 2_100 }),
    observedAt: 2_100,
  }).task
  const wrongArtifact = committedAgentReviewExecution(preparedOther, {
    id: claimed.id,
    projectId: claimed.projectId,
    leaseToken: 'lease-a',
    executionGeneration: 1,
    status: 'running',
    result,
    checkpoint: null,
    observedAt: 2_200,
  })
  assert.equal(wrongArtifact.kind, 'conflict')
  assert.equal(wrongArtifact.task.execution.checkpoint.artifactId, 'artifact-2')
})

test('prepared checkpoint 只接受稳定 Artifact 身份，不接受 URL、媒体路径或控制字符', () => {
  assert.equal(
    agentReviewPreparedCheckpoint({ artifactId: 'generation:job-123:output_1', preparedAt: 2_000 }).artifactId,
    'generation:job-123:output_1',
  )
  for (const artifactId of [
    'https://private.example/image.png',
    '/api/media/secret',
    'data:image/png;base64,AAAA',
    'generation/job/output',
    'generation:job:\noutput',
  ]) {
    assert.throws(
      () => agentReviewPreparedCheckpoint({ artifactId, preparedAt: 2_000 }),
      /checkpoint 无效/,
      artifactId,
    )
  }
})

test('prepared 只能绑定任务 coverage 内的 Artifact，损坏 checkpoint 也不得被接管重跑', () => {
  const claimed = agentReviewExecutionClaimDecision(queuedTask, {
    id: queuedTask.id,
    projectId: queuedTask.projectId,
    leaseToken: 'lease-old',
    leaseDurationMs: 30_000,
    observedAt: 2_000,
  }).task
  const unrelated = committedAgentReviewExecution(claimed, {
    id: claimed.id,
    projectId: claimed.projectId,
    leaseToken: 'lease-old',
    executionGeneration: 1,
    status: 'running',
    checkpoint: agentReviewPreparedCheckpoint({ artifactId: 'artifact-outside-coverage', preparedAt: 2_100 }),
    observedAt: 2_100,
  })
  assert.equal(unrelated.kind, 'conflict')

  const corrupted = {
    ...claimed,
    execution: {
      ...claimed.execution,
      checkpoint: { version: 1, phase: 'prepared', artifactId: '/api/media/private', preparedAt: 2_100 },
    },
  }
  const recovery = agentReviewExecutionClaimDecision(corrupted, {
    id: claimed.id,
    projectId: claimed.projectId,
    leaseToken: 'lease-new',
    observedAt: 32_001,
    allowTakeover: true,
  })
  assert.equal(recovery.kind, 'outcome_unknown')
  assert.equal(recovery.task.status, 'failed')
})

test('结果 commit 响应丢失后，同值不同键序的重试保持幂等', () => {
  const claimed = agentReviewExecutionClaimDecision(queuedTask, {
    id: queuedTask.id,
    projectId: queuedTask.projectId,
    leaseToken: 'lease-a',
    observedAt: 2_000,
  }).task
  const prepared = committedAgentReviewExecution(claimed, {
    id: claimed.id,
    projectId: claimed.projectId,
    leaseToken: 'lease-a',
    executionGeneration: 1,
    status: 'running',
    checkpoint: agentReviewPreparedCheckpoint({ artifactId: 'artifact-1', preparedAt: 2_100 }),
    observedAt: 2_100,
  }).task
  const result = {
    id: 'review-result-1', taskId: claimed.id, projectId: claimed.projectId,
    artifactId: 'artifact-1', criteria: [{ id: 'identity', verdict: 'pass' }], verdict: 'pass',
  }
  const first = committedAgentReviewExecution(prepared, {
    id: claimed.id, projectId: claimed.projectId, leaseToken: 'lease-a', executionGeneration: 1,
    status: 'running', result, checkpoint: null, observedAt: 2_200,
  }).task
  const reordered = {
    verdict: 'pass', criteria: [{ verdict: 'pass', id: 'identity' }], artifactId: 'artifact-1',
    projectId: claimed.projectId, taskId: claimed.id, id: 'review-result-1',
  }
  const replay = committedAgentReviewExecution(first, {
    id: claimed.id, projectId: claimed.projectId, leaseToken: 'lease-a', executionGeneration: 1,
    status: 'running', result: reordered, checkpoint: null, observedAt: 2_300,
  })
  assert.notEqual(replay.kind, 'conflict')
  assert.equal(replay.task.results.length, 1)
})

test('过期 prepared 且没有结果时收为 outcome unknown，绝不自动接管重评', () => {
  const claimed = agentReviewExecutionClaimDecision(queuedTask, {
    id: queuedTask.id,
    projectId: queuedTask.projectId,
    leaseToken: 'lease-old',
    leaseDurationMs: 30_000,
    observedAt: 2_000,
  }).task
  const prepared = committedAgentReviewExecution(claimed, {
    id: claimed.id,
    projectId: claimed.projectId,
    leaseToken: 'lease-old',
    executionGeneration: 1,
    status: 'running',
    checkpoint: agentReviewPreparedCheckpoint({ artifactId: 'artifact-1', preparedAt: 2_100 }),
    observedAt: 2_100,
  }).task

  const recovered = agentReviewExecutionClaimDecision(prepared, {
    id: prepared.id,
    projectId: prepared.projectId,
    leaseToken: 'lease-new',
    leaseDurationMs: 30_000,
    observedAt: 32_101,
    allowTakeover: true,
  })
  assert.equal(recovered.kind, 'outcome_unknown')
  assert.equal(recovered.changed, true)
  assert.equal(recovered.task.status, 'failed')
  assert.equal(recovered.task.error.code, AGENT_REVIEW_OUTCOME_UNKNOWN)
  assert.equal(recovered.task.execution.generation, 1)
  assert.equal(recovered.task.execution.leaseToken, 'lease-old')
  assert.equal(recovered.task.execution.checkpoint.artifactId, 'artifact-1')

  const retry = agentReviewExecutionClaimDecision(recovered.task, {
    id: recovered.task.id,
    projectId: recovered.task.projectId,
    leaseToken: 'lease-third',
    observedAt: 90_000,
    allowTakeover: true,
  })
  assert.equal(retry.kind, 'outcome_unknown')
  assert.equal(retry.changed, false)
  assert.equal(retry.task.status, 'failed')
})

test('人工决定只从 completed 自动结果派生候选投影，同 identity 重放保留首次时间', () => {
  const completed = {
    ...queuedTask,
    status: 'completed',
    executionVersion: 1,
    execution: { generation: 1, leaseToken: 'lease-a', settledAt: 3_000 },
    results: [{
      id: 'result-1', taskId: queuedTask.id, projectId: queuedTask.projectId,
      artifactId: 'artifact-1', verdict: 'pass', candidateStatus: 'pending_human', updatedAt: 2_500,
    }],
  }
  const decision = {
    id: 'decision-1', taskId: queuedTask.id, projectId: queuedTask.projectId,
    artifactId: 'artifact-1', decision: 'accepted', candidateStatus: 'accepted',
    decidedBy: 'user-1', idempotencyKey: 'accept-1', note: '可交付', decidedAt: 4_000,
  }
  const first = agentReviewHumanDecisionCommitDecision(completed, {
    id: completed.id, projectId: completed.projectId, actorId: 'user-1',
    decisions: [decision], observedAt: 4_100,
  })
  assert.equal(first.kind, 'committed')
  assert.equal(first.task.decisions[0].decidedAt, 4_100)
  assert.equal(first.task.decisions[0].decisionRevision, 1)
  assert.equal(first.task.results[0].candidateStatus, 'accepted')
  assert.equal(first.task.results[0].humanDecisionId, 'decision-1')
  assert.equal(first.task.results[0].verdict, 'pass')
  assert.deepEqual(first.task.execution, completed.execution)

  const replay = agentReviewHumanDecisionCommitDecision(first.task, {
    id: completed.id, projectId: completed.projectId, actorId: 'user-1',
    decisions: [{ ...decision, decidedAt: 9_999 }], observedAt: 10_000,
  })
  assert.equal(replay.kind, 'replay')
  assert.equal(replay.changed, false)
  assert.equal(replay.task.decisions[0].decidedAt, 4_100)
})

test('同 decision identity 改语义 fail-closed，running/prepared 不接受人工决定', () => {
  const baseResult = {
    id: 'result-1', taskId: queuedTask.id, projectId: queuedTask.projectId,
    artifactId: 'artifact-1', verdict: 'pass', candidateStatus: 'pending_human',
  }
  const decision = {
    id: 'decision-1', taskId: queuedTask.id, projectId: queuedTask.projectId,
    artifactId: 'artifact-1', decision: 'accepted', candidateStatus: 'accepted',
    decidedBy: 'user-1', idempotencyKey: 'accept-1', note: '可交付', decidedAt: 4_000,
  }
  const completed = {
    ...queuedTask, status: 'completed', results: [baseResult], decisions: [decision],
  }
  for (const changed of [
    { decision: 'rejected', candidateStatus: 'rejected' },
    { artifactId: 'artifact-2' },
    { note: '换一条说明' },
    { decidedBy: 'user-2' },
  ]) {
    assert.equal(agentReviewHumanDecisionCommitDecision(completed, {
      id: completed.id, projectId: completed.projectId, actorId: changed.decidedBy ?? 'user-1',
      decisions: [{ ...decision, ...changed, decidedAt: 9_000 }], observedAt: 9_100,
    }).kind, 'conflict')
  }

  const prepared = {
    ...queuedTask,
    status: 'running',
    executionVersion: 1,
    execution: {
      generation: 1, leaseToken: 'lease-a', leaseExpiresAt: 99_000,
      checkpoint: agentReviewPreparedCheckpoint({ artifactId: 'artifact-1', preparedAt: 3_000 }),
    },
  }
  assert.equal(agentReviewHumanDecisionCommitDecision(prepared, {
    id: prepared.id, projectId: prepared.projectId, actorId: 'user-1',
    decisions: [decision], observedAt: 4_100,
  }).kind, 'not_ready')
  assert.deepEqual(prepared.results, [])
})

test('人工决定顺序以锁内权威 revision 为准，不信任锁前 decidedAt', () => {
  const completed = {
    ...queuedTask,
    status: 'completed',
    results: [{
      id: 'result-1', taskId: queuedTask.id, projectId: queuedTask.projectId,
      artifactId: 'artifact-1', verdict: 'pass', candidateStatus: 'pending_human',
    }],
  }
  const input = (id, decision, candidateStatus, decidedAt) => ({
    id, taskId: queuedTask.id, projectId: queuedTask.projectId, artifactId: 'artifact-1',
    decision, candidateStatus, decidedBy: 'user-1', idempotencyKey: id, decidedAt,
  })
  const first = agentReviewHumanDecisionCommitDecision(completed, {
    id: completed.id, projectId: completed.projectId, actorId: 'user-1', observedAt: 5_000,
    decisions: [input('decision-later-client-clock', 'rejected', 'rejected', 999_999)],
  }).task
  const second = agentReviewHumanDecisionCommitDecision(first, {
    id: completed.id, projectId: completed.projectId, actorId: 'user-1', observedAt: 5_000,
    decisions: [input('decision-earlier-client-clock', 'accepted', 'accepted', 1)],
  }).task

  assert.deepEqual(second.decisions.map((item) => item.decisionRevision), [1, 2])
  assert.deepEqual(second.decisions.map((item) => item.decidedAt), [5_000, 5_001])
  assert.equal(second.results[0].candidateStatus, 'accepted')
  assert.equal(second.results[0].humanDecisionId, 'decision-earlier-client-clock')
})

test('queued Review 取消可直接证明未执行，且幂等键不能改绑', () => {
  const command = {
    id: queuedTask.id,
    projectId: queuedTask.projectId,
    idempotencyKey: 'cancel-review-1',
    signalId: 'review-cancel:task-1:0',
    requestedBy: 'user-1',
    reason: '不再需要评审',
    observedAt: 2_000,
  }
  const cancelled = agentReviewCancellationRequestDecision(queuedTask, command)
  assert.equal(cancelled.kind, 'cancelled')
  assert.equal(cancelled.task.status, 'cancelled')
  assert.equal(cancelled.task.cancel.signalRequired, false)
  assert.equal(cancelled.task.cancel.workerReleased, true)
  assert.equal(cancelled.task.cancel.releaseBasis, 'not_started')

  const replay = agentReviewCancellationRequestDecision(cancelled.task, {
    ...command,
    observedAt: 9_000,
  })
  assert.equal(replay.kind, 'replay')
  assert.equal(replay.changed, false)
  assert.equal(replay.task.cancel.requestedAt, 2_000)

  const rebound = agentReviewCancellationRequestDecision(cancelled.task, {
    ...command,
    idempotencyKey: 'cancel-review-other',
  })
  assert.equal(rebound.kind, 'conflict')
  assert.equal(agentReviewExecutionClaimDecision(cancelled.task, {
    id: queuedTask.id,
    projectId: queuedTask.projectId,
    leaseToken: 'lease-after-cancel',
  }).kind, 'cancelled')
})

test('running Review 先进入 cancelling，旧 Worker 不能用 heartbeat 或结果穿透 fence', () => {
  const running = agentReviewExecutionClaimDecision(queuedTask, {
    id: queuedTask.id,
    projectId: queuedTask.projectId,
    leaseToken: 'lease-running',
    leaseDurationMs: 30_000,
    observedAt: 2_000,
  }).task
  const cancelling = agentReviewCancellationRequestDecision(running, {
    id: running.id,
    projectId: running.projectId,
    idempotencyKey: 'cancel-running',
    signalId: 'review-cancel:task-1:1',
    requestedBy: 'user-1',
    observedAt: 3_000,
  })
  assert.equal(cancelling.kind, 'cancelling')
  assert.equal(cancelling.task.status, 'cancelling')
  assert.equal(cancelling.task.cancel.executionGeneration, 1)
  assert.equal(cancelling.task.cancel.workerReleased, false)
  assert.equal(agentReviewExecutionClaimDecision(cancelling.task, {
    id: running.id,
    projectId: running.projectId,
    leaseToken: 'lease-takeover',
    observedAt: 40_000,
    allowTakeover: true,
  }).kind, 'cancelling')

  const heartbeat = committedAgentReviewExecution(cancelling.task, {
    id: running.id,
    projectId: running.projectId,
    leaseToken: 'lease-running',
    executionGeneration: 1,
    status: 'running',
    observedAt: 3_100,
  })
  assert.equal(heartbeat.kind, 'stale')
  assert.equal(heartbeat.task.status, 'cancelling')
})

test('running Review 只有匹配 lease 的 worker_exit 能完成取消', () => {
  const running = agentReviewExecutionClaimDecision(queuedTask, {
    id: queuedTask.id,
    projectId: queuedTask.projectId,
    leaseToken: 'lease-running',
    leaseDurationMs: 30_000,
    observedAt: 2_000,
  }).task
  const cancelling = agentReviewCancellationRequestDecision(running, {
    id: running.id,
    projectId: running.projectId,
    idempotencyKey: 'cancel-running',
    signalId: 'review-cancel:task-1:1',
    requestedBy: 'user-1',
    observedAt: 3_000,
  }).task
  const base = {
    id: running.id,
    projectId: running.projectId,
    signalId: 'review-cancel:task-1:1',
    executionGeneration: 1,
    observedAt: 3_100,
  }
  assert.equal(agentReviewCancellationFinalizeDecision(cancelling, {
    ...base,
    proof: { kind: 'worker_exit', leaseToken: 'wrong-lease' },
  }).kind, 'stale')
  assert.equal(agentReviewCancellationFinalizeDecision(cancelling, {
    ...base,
    executionGeneration: 2,
    proof: { kind: 'worker_exit', leaseToken: 'lease-running' },
  }).kind, 'stale')

  const finalized = agentReviewCancellationFinalizeDecision(cancelling, {
    ...base,
    proof: { kind: 'worker_exit', leaseToken: 'lease-running', observedAt: 3_200 },
  })
  assert.equal(finalized.kind, 'cancelled')
  assert.equal(finalized.task.status, 'cancelled')
  assert.equal(finalized.task.cancel.workerReleased, true)
  assert.equal(finalized.task.cancel.releaseBasis, 'worker_exit')
  assert.equal(finalized.task.cancel.signalAcknowledgedAt, 3_200)
  assert.equal(finalized.task.execution.settledAt, 3_200)

  const replay = agentReviewCancellationFinalizeDecision(finalized.task, {
    ...base,
    proof: { kind: 'worker_exit', leaseToken: 'lease-running' },
  })
  assert.equal(replay.kind, 'replay')
  assert.equal(replay.changed, false)
})

test('Worker 崩溃只能在原 generation 租约过期后替代证明取消', () => {
  const running = agentReviewExecutionClaimDecision(queuedTask, {
    id: queuedTask.id,
    projectId: queuedTask.projectId,
    leaseToken: 'lease-crashed',
    leaseDurationMs: 30_000,
    observedAt: 2_000,
  }).task
  const cancelling = agentReviewCancellationRequestDecision(running, {
    id: running.id,
    projectId: running.projectId,
    idempotencyKey: 'cancel-crashed',
    signalId: 'review-cancel:task-1:1',
    requestedBy: 'user-1',
    observedAt: 3_000,
  }).task
  const command = {
    id: running.id,
    projectId: running.projectId,
    signalId: 'review-cancel:task-1:1',
    executionGeneration: 1,
    proof: { kind: 'lease_expired' },
  }
  const early = agentReviewCancellationFinalizeDecision(cancelling, {
    ...command,
    observedAt: 31_999,
  })
  assert.equal(early.kind, 'pending')
  assert.equal(early.task.status, 'cancelling')

  const expired = agentReviewCancellationFinalizeDecision(cancelling, {
    ...command,
    observedAt: 32_000,
  })
  assert.equal(expired.kind, 'cancelled')
  assert.equal(expired.task.cancel.releaseBasis, 'lease_expired')
})
