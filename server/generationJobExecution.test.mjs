import assert from 'node:assert/strict'
import test from 'node:test'
import {
  acknowledgedGenerationJobCancellation,
  comparedAndSetGenerationJob,
  committedGenerationJobExecution,
  generationJobExecutionClaimDecision,
  generationJobPutDecision,
  requestedGenerationJobCancellation,
} from './generationJobExecution.mjs'

const queuedJob = {
  id: 'job-fence-1',
  ownerId: 'user-1',
  projectId: 'project-1',
  status: 'queued',
  createdAt: 1_000,
  updatedAt: 1_000,
  batchCount: 1,
  outputs: [],
  settings: { model: 'gpt-image-2' },
}

test('Generation Job 原子 claim：并发 Worker 只有一个租约胜者', () => {
  const first = generationJobExecutionClaimDecision(queuedJob, {
    leaseToken: 'lease-a',
    leaseDurationMs: 60_000,
    observedAt: 2_000,
  })
  assert.equal(first.kind, 'claimed')
  assert.equal(first.job.status, 'running')
  assert.equal(first.job.execution.generation, 1)

  const duplicate = generationJobExecutionClaimDecision(first.job, {
    leaseToken: 'lease-b',
    leaseDurationMs: 60_000,
    observedAt: 2_001,
    allowTakeover: true,
  })
  assert.equal(duplicate.kind, 'in_progress')
  assert.equal(duplicate.changed, false)
  assert.equal(duplicate.job.execution.leaseToken, 'lease-a')
})

test('Generation Job 过期接管递增 generation，旧 Worker 的进度与终态都被 fence', () => {
  const first = generationJobExecutionClaimDecision(queuedJob, {
    leaseToken: 'lease-old', leaseDurationMs: 30_000, observedAt: 10_000,
  })
  const takeover = generationJobExecutionClaimDecision(first.job, {
    leaseToken: 'lease-new', leaseDurationMs: 30_000, observedAt: 40_001, allowTakeover: true,
  })
  assert.equal(takeover.kind, 'claimed')
  assert.equal(takeover.job.execution.generation, 2)

  for (const status of ['running', 'succeeded', 'failed']) {
    const stale = committedGenerationJobExecution(takeover.job, {
      id: queuedJob.id,
      projectId: queuedJob.projectId,
      leaseToken: 'lease-old',
      executionGeneration: 1,
      status,
      job: { ...takeover.job, status },
      observedAt: 40_002,
    })
    assert.equal(stale.kind, 'stale', `${status} 写入必须被新 generation 拒绝`)
    assert.equal(stale.changed, false)
  }
})

test('Generation Job heartbeat 续租；同租约终态重试可完成 writeback 投影', () => {
  const claimed = generationJobExecutionClaimDecision(queuedJob, {
    leaseToken: 'lease-a', leaseDurationMs: 30_000, observedAt: 2_000,
  }).job
  const heartbeat = committedGenerationJobExecution(claimed, {
    id: queuedJob.id,
    projectId: queuedJob.projectId,
    leaseToken: 'lease-a',
    executionGeneration: 1,
    status: 'running',
    job: { ...claimed, variants: [{ index: 0, status: 'running' }] },
    observedAt: 3_000,
  })
  assert.equal(heartbeat.kind, 'committed')
  assert.equal(heartbeat.job.execution.leaseExpiresAt, 33_000)
  assert.deepEqual(heartbeat.job.variants, [{ index: 0, status: 'running' }])

  const completed = committedGenerationJobExecution(heartbeat.job, {
    id: queuedJob.id,
    projectId: queuedJob.projectId,
    leaseToken: 'lease-a',
    executionGeneration: 1,
    status: 'succeeded',
    job: { ...heartbeat.job, status: 'succeeded', outputs: [{ id: 'output-1' }], projectWritebackPending: true },
    observedAt: 4_000,
  })
  assert.equal(completed.kind, 'committed')
  assert.equal(completed.job.execution.settledAt, 4_000)

  const finalized = committedGenerationJobExecution(completed.job, {
    id: queuedJob.id,
    projectId: queuedJob.projectId,
    leaseToken: 'lease-a',
    executionGeneration: 1,
    status: 'succeeded',
    job: { ...completed.job, projectWritebackPending: undefined },
    observedAt: 5_000,
  })
  assert.equal(finalized.kind, 'committed')
  assert.equal(finalized.job.projectWritebackPending, undefined)
})

test('Worker commit 与 CAS 不能清除或改写已建立的幂等请求绑定', () => {
  const binding = {
    version: 1, scope: 'generation.submit', projectId: queuedJob.projectId, requestHash: 'request-a',
  }
  const claimed = generationJobExecutionClaimDecision({ ...queuedJob, idempotencyBinding: binding }, {
    leaseToken: 'lease-binding', leaseDurationMs: 30_000, observedAt: 2_000,
  }).job
  const withoutBinding = { ...claimed, status: 'succeeded' }
  delete withoutBinding.idempotencyBinding

  const committed = committedGenerationJobExecution(claimed, {
    id: claimed.id,
    projectId: claimed.projectId,
    leaseToken: claimed.execution.leaseToken,
    executionGeneration: claimed.execution.generation,
    status: 'succeeded',
    job: withoutBinding,
    observedAt: 3_000,
  })

  assert.deepEqual(committed.job.idempotencyBinding, binding)
})

test('Generation Job 原子取消按锁内真实状态计费，并永久压住 stale Worker', () => {
  const running = generationJobExecutionClaimDecision(queuedJob, {
    leaseToken: 'lease-a', leaseDurationMs: 30_000, observedAt: 2_000,
  }).job
  const cancelled = requestedGenerationJobCancellation(running, {
    id: queuedJob.id,
    projectId: queuedJob.projectId,
    requestedAt: 3_000,
    reason: 'user',
    requestedBy: 'user-1',
    outcomes: {
      queued: { billing: 'none', capability: 'local-abort-only', workerReleased: false, code: 'CANCELLED_BEFORE_DISPATCH' },
      running: { billing: 'possible', capability: 'local-abort-only', workerReleased: true, code: 'CANCELLED_RESULT_DISCARDED' },
    },
    observedAt: 3_000,
  })
  assert.equal(cancelled.kind, 'cancelled')
  assert.equal(cancelled.priorStatus, 'running')
  assert.equal(cancelled.job.cancel.code, 'CANCELLED_RESULT_DISCARDED')
  assert.equal(cancelled.job.cancel.workerReleaseExpected, true)
  assert.equal(cancelled.job.cancel.workerReleased, false)
  assert.equal(cancelled.job.cancel.signalRequired, true)
  assert.equal(cancelled.job.cancel.signalId, 'generation-cancel:job-fence-1:1:3000')
  assert.equal(cancelled.job.execution.settledAt, undefined, 'Provider 退出前 execution 不能伪装 settled')

  const cancellationHeartbeat = committedGenerationJobExecution(cancelled.job, {
    id: queuedJob.id,
    projectId: queuedJob.projectId,
    leaseToken: 'lease-a',
    executionGeneration: 1,
    status: 'cancelled',
    signalId: cancelled.job.cancel.signalId,
    observedAt: 3_100,
  })
  assert.equal(cancellationHeartbeat.kind, 'cancellation_heartbeat')
  assert.equal(cancellationHeartbeat.job.status, 'cancelled')
  assert.equal(cancellationHeartbeat.job.execution.lastHeartbeatAt, 3_100)
  assert.equal(cancellationHeartbeat.job.execution.leaseExpiresAt, 33_100)

  for (const command of [
    { leaseToken: 'wrong-lease', executionGeneration: 1, signalId: cancelled.job.cancel.signalId },
    { leaseToken: 'lease-a', executionGeneration: 2, signalId: cancelled.job.cancel.signalId },
    { leaseToken: 'lease-a', executionGeneration: 1, signalId: 'wrong-signal' },
  ]) {
    const staleHeartbeat = committedGenerationJobExecution(cancellationHeartbeat.job, {
      id: queuedJob.id,
      projectId: queuedJob.projectId,
      status: 'cancelled',
      observedAt: 3_200,
      ...command,
    })
    assert.equal(staleHeartbeat.kind, 'stale')
    assert.equal(staleHeartbeat.job.execution.leaseExpiresAt, 33_100)
  }

  const wrongSignal = acknowledgedGenerationJobCancellation(cancelled.job, {
    id: queuedJob.id, projectId: queuedJob.projectId, signalId: 'wrong',
    executionGeneration: 1, leaseToken: 'lease-a', releaseBasis: 'worker_exit', observedAt: 3_100,
  })
  assert.equal(wrongSignal.kind, 'stale')
  const wrongGeneration = acknowledgedGenerationJobCancellation(cancelled.job, {
    id: queuedJob.id,
    projectId: queuedJob.projectId,
    signalId: cancelled.job.cancel.signalId,
    executionGeneration: 2,
    leaseToken: 'lease-a',
    releaseBasis: 'worker_exit',
    observedAt: 3_100,
  })
  assert.equal(wrongGeneration.kind, 'stale')
  const acknowledged = acknowledgedGenerationJobCancellation(cancelled.job, {
    id: queuedJob.id,
    projectId: queuedJob.projectId,
    signalId: cancelled.job.cancel.signalId,
    executionGeneration: 1,
    leaseToken: 'lease-a',
    releaseBasis: 'worker_exit',
    observedAt: 3_200,
  })
  assert.equal(acknowledged.kind, 'acknowledged')
  assert.equal(acknowledged.job.cancel.workerReleased, true)
  assert.equal(acknowledged.job.cancel.signalAcknowledgedAt, 3_200)
  assert.equal(acknowledged.job.cancel.releaseBasis, 'worker_exit')
  assert.equal(acknowledged.job.execution.settledAt, 3_200)

  for (const leaseToken of [undefined, 'wrong-lease']) {
    const staleLease = acknowledgedGenerationJobCancellation(cancelled.job, {
      id: queuedJob.id,
      projectId: queuedJob.projectId,
      signalId: cancelled.job.cancel.signalId,
      executionGeneration: 1,
      ...(leaseToken ? { leaseToken } : {}),
      releaseBasis: 'worker_exit',
      observedAt: 3_200,
    })
    assert.equal(staleLease.kind, 'stale')
  }

  const beforeLeaseExpiry = acknowledgedGenerationJobCancellation(cancellationHeartbeat.job, {
    id: queuedJob.id,
    projectId: queuedJob.projectId,
    signalId: cancelled.job.cancel.signalId,
    executionGeneration: 1,
    releaseBasis: 'lease_expired',
    observedAt: 33_099,
  })
  assert.equal(beforeLeaseExpiry.kind, 'pending')
  const afterLeaseExpiry = acknowledgedGenerationJobCancellation(cancellationHeartbeat.job, {
    id: queuedJob.id,
    projectId: queuedJob.projectId,
    signalId: cancelled.job.cancel.signalId,
    executionGeneration: 1,
    releaseBasis: 'lease_expired',
    observedAt: 33_100,
  })
  assert.equal(afterLeaseExpiry.kind, 'acknowledged')
  assert.equal(afterLeaseExpiry.job.cancel.releaseBasis, 'lease_expired')

  const staleSuccess = committedGenerationJobExecution(cancelled.job, {
    id: queuedJob.id,
    projectId: queuedJob.projectId,
    leaseToken: 'lease-a',
    executionGeneration: 1,
    status: 'succeeded',
    job: { ...cancelled.job, status: 'succeeded', outputs: [{ id: 'late-output' }] },
    observedAt: 4_000,
  })
  assert.equal(staleSuccess.kind, 'stale')
  assert.equal(staleSuccess.job.status, 'cancelled')
  assert.deepEqual(staleSuccess.job.outputs, [])
})

test('普通提交入口的 queued→failed CAS 不可覆盖已经 claim 的 Worker', () => {
  const running = generationJobExecutionClaimDecision(queuedJob, {
    leaseToken: 'lease-worker', leaseDurationMs: 30_000, observedAt: 2_000,
  }).job
  const staleFailure = comparedAndSetGenerationJob(running, {
    id: queuedJob.id,
    projectId: queuedJob.projectId,
    expectedStatus: 'queued',
    expectedExecutionGeneration: null,
    job: { ...queuedJob, status: 'failed', error: 'queue response lost' },
    observedAt: 2_001,
  })
  assert.equal(staleFailure.kind, 'stale')
  assert.equal(staleFailure.job.status, 'running')
  assert.equal(staleFailure.job.execution.leaseToken, 'lease-worker')
})

test('超时与重试 CAS 必须匹配 observed generation/status，输家不覆盖新状态', () => {
  const running = generationJobExecutionClaimDecision(queuedJob, {
    leaseToken: 'lease-worker', leaseDurationMs: 30_000, observedAt: 2_000,
  }).job
  const completed = committedGenerationJobExecution(running, {
    id: queuedJob.id,
    projectId: queuedJob.projectId,
    leaseToken: 'lease-worker',
    executionGeneration: 1,
    status: 'succeeded',
    job: { ...running, status: 'succeeded', outputs: [{ id: 'output-1' }] },
    observedAt: 3_000,
  }).job
  const staleTimeout = comparedAndSetGenerationJob(completed, {
    id: queuedJob.id,
    projectId: queuedJob.projectId,
    expectedStatus: 'running',
    expectedExecutionGeneration: 1,
    job: { ...running, status: 'failed', errorCode: 'PROVIDER_TIMEOUT' },
    observedAt: 3_001,
  })
  assert.equal(staleTimeout.kind, 'stale')
  assert.equal(staleTimeout.job.status, 'succeeded')

  const failedTerminal = { ...completed, status: 'failed', error: 'provider failed' }
  const retried = comparedAndSetGenerationJob(failedTerminal, {
    id: queuedJob.id,
    projectId: queuedJob.projectId,
    expectedStatus: 'failed',
    expectedExecutionGeneration: 1,
    clearExecution: true,
    job: { ...failedTerminal, status: 'queued', outputs: [], error: undefined },
    observedAt: 4_000,
  })
  assert.equal(retried.kind, 'updated')
  assert.equal(retried.job.status, 'queued')
  assert.equal(retried.job.execution, undefined)

  const duplicateRetry = comparedAndSetGenerationJob(retried.job, {
    id: queuedJob.id,
    projectId: queuedJob.projectId,
    expectedStatus: 'failed',
    expectedExecutionGeneration: 1,
    clearExecution: true,
    job: { ...failedTerminal, status: 'queued' },
    observedAt: 4_001,
  })
  assert.equal(duplicateRetry.kind, 'stale')
  assert.equal(duplicateRetry.job.status, 'queued')
})

test('普通 put 不可用无 execution 的 stale 快照覆盖 execution-managed Job', () => {
  const running = generationJobExecutionClaimDecision(queuedJob, {
    leaseToken: 'lease-worker', leaseDurationMs: 30_000, observedAt: 2_000,
  }).job
  const stale = generationJobPutDecision(running, {
    ...queuedJob,
    status: 'failed',
    error: 'stale enqueue failure',
  }, { observedAt: 3_000 })

  assert.equal(stale.kind, 'fenced')
  assert.equal(stale.changed, false)
  assert.equal(stale.job.status, 'running')
  assert.equal(stale.job.execution.leaseToken, 'lease-worker')
})

test('普通 put 新建 Job 不得从调用方伪造 execution fence', () => {
  const inserted = generationJobPutDecision(undefined, {
    ...queuedJob,
    status: 'running',
    executionVersion: 999,
    execution: {
      generation: 999,
      leaseToken: 'forged-lease',
      leaseDurationMs: 900_000,
      leaseExpiresAt: 4_102_444_800_000,
    },
  }, { observedAt: 2_000 })

  assert.equal(inserted.kind, 'inserted')
  assert.equal(inserted.job.execution, undefined)
  assert.equal(inserted.job.executionVersion, undefined)

  const claimed = generationJobExecutionClaimDecision(inserted.job, {
    leaseToken: 'worker-lease',
    leaseDurationMs: 30_000,
    allowTakeover: true,
    observedAt: 2_001,
  })
  assert.equal(claimed.kind, 'claimed')
  assert.equal(claimed.changed, true)
  assert.equal(claimed.job.execution.generation, 1)
})

test('普通 put 更新 legacy Job 也不得伪造 execution 水位或 token', () => {
  const updated = generationJobPutDecision(queuedJob, {
    ...queuedJob,
    executionVersion: 41,
    execution: {
      generation: 41,
      leaseToken: 'forged-update-lease',
      leaseDurationMs: 900_000,
      leaseExpiresAt: 4_102_444_800_000,
    },
  }, { observedAt: 2_000 })

  assert.equal(updated.kind, 'updated')
  assert.equal(updated.job.execution, undefined)
  assert.equal(updated.job.executionVersion, undefined)

  const claimed = generationJobExecutionClaimDecision(updated.job, {
    leaseToken: 'worker-lease', leaseDurationMs: 30_000, observedAt: 2_001,
  })
  assert.equal(claimed.job.execution.generation, 1)
})

test('通用 CAS 只能保留或清理 Store 既有 fence，不能从 command.job 铸造 token', () => {
  const updated = comparedAndSetGenerationJob(queuedJob, {
    id: queuedJob.id,
    projectId: queuedJob.projectId,
    expectedStatus: 'queued',
    expectedExecutionGeneration: null,
    job: {
      ...queuedJob,
      executionVersion: 77,
      execution: { generation: 77, leaseToken: 'forged-cas-lease', leaseExpiresAt: 4_102_444_800_000 },
    },
    observedAt: 2_000,
  })

  assert.equal(updated.kind, 'updated')
  assert.equal(updated.job.execution, undefined)
  assert.equal(updated.job.executionVersion, undefined)
})
