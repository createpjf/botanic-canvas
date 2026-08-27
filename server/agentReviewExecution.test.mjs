import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AGENT_REVIEW_OUTCOME_UNKNOWN,
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
