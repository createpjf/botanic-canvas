import assert from 'node:assert/strict'
import test from 'node:test'
import { createGenerationProcessor } from './generationProcessor.mjs'
import { acknowledgedGenerationJobCancellation } from './generationJobExecution.mjs'
import { createIdempotencyRequestBinding } from '../idempotencyRequestBinding.mjs'

function queuedJob(id) {
  const createdAt = Date.now()
  return {
    id,
    ownerId: 'user-1',
    projectId: 'project-1',
    status: 'queued',
    kind: 'generation',
    createdAt,
    updatedAt: createdAt,
    batchCount: 1,
    settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
    outputs: [],
    rawInput: {
      projectId: 'project-1',
      kind: 'generation',
      prompt: '生成一张植物图',
      batchCount: 1,
      settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
      recipe: { references: [] },
    },
  }
}

function fencedStore(initialJob, {
  cancelBeforeProvider = false,
  cancelOnFirstCommit = false,
  cancelOnHeartbeat = false,
  failCancellationAck = false,
  allowExpiredTakeover = false,
  order = [],
  takeoverOnRead,
} = {}) {
  let stored = structuredClone(initialJob)
  let generation = Number(stored.execution?.generation) || 0
  let reads = 0
  let heartbeatCommits = 0
  const commitCommands = []
  const cancellationAcks = []
  const cancelStored = (requestedAt = Date.now()) => {
    stored = {
      ...stored,
      status: 'cancelled',
      cancel: {
        requestedAt,
        reason: 'user',
        billing: 'possible',
        capability: 'local-abort-only',
        workerReleaseExpected: true,
        workerReleased: false,
        code: 'CANCELLED_RESULT_DISCARDED',
        signalRequired: true,
        signalId: `generation-cancel:${stored.id}:${stored.execution.generation}:${requestedAt}`,
      },
    }
  }
  return {
    stored: () => structuredClone(stored),
    commitCommands,
    cancellationAcks,
    async readGenerationJobForWorker() {
      reads += 1
      if (reads === takeoverOnRead) {
        generation += 1
        stored = {
          ...stored,
          executionVersion: generation,
          execution: {
            generation, leaseToken: 'lease-new-worker', leaseDurationMs: 30_000,
            leaseExpiresAt: Date.now() + 30_000,
          },
        }
      }
      return structuredClone(stored)
    },
    async readProject() { return undefined },
    async refreshGenerationArtifacts() { return true },
    async claimGenerationJobExecution(jobId, claim) {
      assert.equal(jobId, stored.id)
      const expiredTakeover = allowExpiredTakeover
        && stored.status === 'running'
        && Number(stored.execution?.leaseExpiresAt) <= Date.now()
      if (stored.status !== 'queued' && !expiredTakeover) {
        return { kind: 'in_progress', changed: false, job: structuredClone(stored) }
      }
      generation += 1
      stored = {
        ...stored,
        status: 'running',
        execution: {
          generation,
          leaseToken: claim.leaseToken,
          leaseDurationMs: claim.leaseDurationMs,
          leaseExpiresAt: Date.now() + claim.leaseDurationMs,
          claimedAt: Date.now(),
          lastHeartbeatAt: Date.now(),
        },
      }
      return { kind: 'claimed', changed: true, job: structuredClone(stored) }
    },
    async commitGenerationJobExecution(_ownerId, command) {
      commitCommands.push(structuredClone(command))
      if (cancelOnFirstCommit && commitCommands.length === 1) {
        cancelStored()
        return { kind: 'stale', changed: false, job: structuredClone(stored) }
      }
      if (!command.job) {
        heartbeatCommits += 1
        if (cancelOnHeartbeat && heartbeatCommits > 1 && stored.status !== 'cancelled') {
          cancelStored()
          return { kind: 'cancellation_required', changed: false, job: structuredClone(stored) }
        }
      }
      const sameLease = stored.execution?.generation === command.executionGeneration
        && stored.execution?.leaseToken === command.leaseToken
      if (!sameLease) {
        return { kind: 'stale', changed: false, job: structuredClone(stored) }
      }
      if (stored.status === 'cancelled') {
        if (command.status === 'cancelled'
          && command.signalId === stored.cancel?.signalId
          && stored.cancel?.workerReleased !== true) {
          const at = Math.max(Date.now(), Number(stored.execution.lastHeartbeatAt) + 1)
          stored = {
            ...stored,
            updatedAt: at,
            execution: {
              ...stored.execution,
              lastHeartbeatAt: at,
              leaseExpiresAt: at + stored.execution.leaseDurationMs,
            },
            cancel: { ...stored.cancel, lastHeartbeatAt: at },
          }
          return { kind: 'cancellation_heartbeat', changed: true, job: structuredClone(stored) }
        }
        return { kind: 'cancellation_required', changed: false, job: structuredClone(stored) }
      }
      if (cancelBeforeProvider && command.job?.providerAttempts?.length) {
        stored = { ...stored, status: 'cancelled', cancel: { code: 'CANCELLED_RESULT_DISCARDED' } }
        return { kind: 'stale', changed: false, job: structuredClone(stored) }
      }
      stored = {
        ...(command.job ? structuredClone(command.job) : stored),
        status: command.status,
        ownerId: stored.ownerId,
        projectId: stored.projectId,
        execution: {
          ...stored.execution,
          ...(command.status === 'running'
            ? { lastHeartbeatAt: Date.now(), leaseExpiresAt: Date.now() + stored.execution.leaseDurationMs }
            : { settledAt: Date.now() }),
        },
      }
      return { kind: 'committed', changed: true, job: structuredClone(stored) }
    },
    async acknowledgeGenerationJobCancellation(_ownerId, command) {
      cancellationAcks.push(structuredClone(command))
      order.push('ack')
      if (failCancellationAck) throw new Error('ack unavailable')
      const decision = acknowledgedGenerationJobCancellation(stored, {
        ...command,
        observedAt: Date.now(),
      })
      if (decision.changed) stored = structuredClone(decision.job)
      return structuredClone(decision)
    },
    async cancelGenerationJobExecution(_ownerId, command) {
      if (!['queued', 'running'].includes(stored.status)) return { kind: 'replay', changed: false, job: structuredClone(stored) }
      const outcome = command.outcomes[stored.status]
      stored = { ...stored, status: 'cancelled', cancel: { requestedAt: command.requestedAt, reason: command.reason, ...outcome } }
      return { kind: 'cancelled', changed: true, job: structuredClone(stored) }
    },
    // RED 阶段兼容旧 Processor：它的无条件写正是测试要抓住的缺口。
    async putGenerationJob(_ownerId, job) {
      if (cancelBeforeProvider && job.providerAttempts?.length) {
        stored = { ...stored, status: 'cancelled', cancel: { code: 'CANCELLED_RESULT_DISCARDED' } }
        return structuredClone(stored)
      }
      stored = structuredClone(job)
      return structuredClone(stored)
    },
  }
}

test('取消信号先于本地句柄登记：Worker 不进 Provider，退出并 release 后按 immutable fence ack', async () => {
  const order = []
  const store = fencedStore(queuedJob('job-cancel-before-register'), { cancelOnFirstCommit: true, order })
  let providerCalls = 0
  const handle = {}
  const cancelRegistry = {
    register(_id, incoming) { handle.value = incoming; order.push('register'); return true },
    release(_id, incoming) {
      assert.equal(incoming, handle.value)
      order.push('release')
      return true
    },
  }

  await processor(store, async () => { providerCalls += 1 }, { cancelRegistry })('job-cancel-before-register')

  assert.equal(providerCalls, 0)
  assert.equal(store.stored().cancel.workerReleased, true)
  assert.deepEqual(store.cancellationAcks.map(({ executionGeneration, releaseBasis }) => (
    [executionGeneration, releaseBasis]
  )), [[1, 'worker_exit']])
  assert.deepEqual(order, ['register', 'release', 'ack'])
})

test('heartbeat 发现 durable cancel：先等 Provider 退出并 release，再 ack；ack 故障不重跑 Provider', async () => {
  for (const failCancellationAck of [false, true]) {
    const order = []
    const store = fencedStore(queuedJob(`job-heartbeat-cancel-${failCancellationAck}`), {
      cancelOnHeartbeat: true,
      failCancellationAck,
      order,
    })
    let providerCalls = 0
    let heartbeatCallback
    const handle = {}
    const processJob = processor(store, async (_input, { signal }) => {
      providerCalls += 1
      await new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          order.push('provider-exit')
          resolve()
        }, { once: true })
        queueMicrotask(heartbeatCallback)
      })
      return { outputs: [], missingOutputCount: 1 }
    }, {
      cancelRegistry: {
        register(_id, incoming) { handle.value = incoming; return true },
        release(_id, incoming) {
          assert.equal(incoming, handle.value)
          order.push('release')
          return true
        },
      },
      setIntervalFn(callback) { heartbeatCallback = callback; return 1 },
      clearIntervalFn() {},
    })

    await processJob(store.stored().id)

    assert.equal(providerCalls, 1)
    assert.deepEqual(order, ['provider-exit', 'release', 'ack'])
    assert.equal(store.stored().cancel.workerReleased, !failCancellationAck)
  }
})

test('Provider 忽略 AbortSignal 时 cancelled Worker 持续续租，退出前 lease_expired 不得抢先 ack', async () => {
  const order = []
  const store = fencedStore(queuedJob('job-cancel-heartbeat-ignored-abort'), {
    cancelOnHeartbeat: true,
    order,
  })
  let heartbeatCallback
  let providerStarted
  let releaseProvider
  const started = new Promise((resolve) => { providerStarted = resolve })
  const providerGate = new Promise((resolve) => { releaseProvider = resolve })
  const processJob = processor(store, async () => {
    providerStarted()
    await providerGate // 故意忽略 signal，模拟 Provider 无法及时中止。
    order.push('provider-exit')
    return { outputs: [], missingOutputCount: 1 }
  }, {
    cancelRegistry: {
      register() { return true },
      release() { order.push('release'); return true },
    },
    setIntervalFn(callback) { heartbeatCallback = callback; return 1 },
    clearIntervalFn() {},
  })

  const processing = processJob(store.stored().id)
  await started
  const beforeCancel = store.stored()
  heartbeatCallback()
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  const firstCancellationHeartbeat = store.stored()
  heartbeatCallback()
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  const duringCancel = store.stored()
  const acknowledgementsBeforeExit = store.cancellationAcks.length
  const cancellationHeartbeatCommitted = store.commitCommands.some((command) => (
    command.status === 'cancelled'
      && command.signalId === duringCancel.cancel.signalId
      && command.leaseToken === duringCancel.execution.leaseToken
  ))

  const prematureExpiry = acknowledgedGenerationJobCancellation(duringCancel, {
    id: duringCancel.id,
    projectId: duringCancel.projectId,
    signalId: duringCancel.cancel.signalId,
    executionGeneration: duringCancel.execution.generation,
    releaseBasis: 'lease_expired',
    observedAt: firstCancellationHeartbeat.execution.leaseExpiresAt,
  })

  releaseProvider()
  await processing
  assert.equal(duringCancel.status, 'cancelled')
  assert.equal(duringCancel.cancel.workerReleased, false)
  assert.ok(duringCancel.execution.leaseExpiresAt > beforeCancel.execution.leaseExpiresAt)
  assert.ok(duringCancel.execution.leaseExpiresAt > firstCancellationHeartbeat.execution.leaseExpiresAt)
  assert.equal(acknowledgementsBeforeExit, 0, 'Provider 未退出时不得写 worker_exit ack')
  assert.equal(cancellationHeartbeatCommitted, true)
  assert.equal(prematureExpiry.kind, 'pending')
  assert.deepEqual(order, ['provider-exit', 'release', 'ack'])
  assert.equal(store.stored().cancel.workerReleased, true)
  assert.equal(store.cancellationAcks[0].leaseToken, duringCancel.execution.leaseToken)
})

function processor(productStore, generate, extra = {}) {
  return createGenerationProcessor({
    productStore,
    mediaService: {},
    config: {
      modelOptions: [{ id: 'gpt-image-2', provider: 'openai', mediaKind: 'image', aspectRatios: ['1:1'], resolutions: ['1K'] }],
      maximumBatchCount: 4,
      maximumReferenceBytes: 1024,
      generationExecutionLeaseMs: 30_000,
      generationExecutionHeartbeatMs: 5_000,
    },
    generate,
    ...extra,
  })
}

test('同一 Job 的 at-least-once 并发投递只允许一个 Provider 执行者', async () => {
  const store = fencedStore(queuedJob('job-duplicate-delivery'))
  let providerCalls = 0
  let releaseProvider
  let providerStarted
  const started = new Promise((resolve) => { providerStarted = resolve })
  const providerWait = new Promise((resolve) => { releaseProvider = resolve })
  const processJob = processor(store, async () => {
    providerCalls += 1
    providerStarted()
    await providerWait
    return { outputs: [{ id: 'output-1', image: '/api/media/output-1' }], missingOutputCount: 0 }
  })

  const first = processJob('job-duplicate-delivery')
  await started
  const second = processJob('job-duplicate-delivery')
  await new Promise((resolve) => setImmediate(resolve))
  releaseProvider()
  await Promise.all([first, second])

  assert.equal(providerCalls, 1)
  assert.equal(store.stored().status, 'succeeded')
})

test('过期 lease 接管遇到旧本地句柄时中止旧执行，本轮不进入 Provider', async () => {
  const id = 'job-local-handle-takeover'
  const startedAt = Date.now() - 60_000
  const store = fencedStore({
    ...queuedJob(id),
    status: 'running',
    executionVersion: 1,
    execution: {
      generation: 1,
      leaseToken: 'lease-old-worker',
      leaseDurationMs: 30_000,
      leaseExpiresAt: Date.now() - 1,
      claimedAt: startedAt,
      lastHeartbeatAt: startedAt,
    },
  }, { allowExpiredTakeover: true })
  let providerCalls = 0
  let oldHandleAborts = 0
  const processJob = processor(store, async () => {
    providerCalls += 1
    return { outputs: [{ id: 'must-not-exist' }], missingOutputCount: 0 }
  }, {
    leaseTokenFactory: () => 'lease-takeover-worker',
    cancelRegistry: {
      register() { return false },
      abort(jobId) {
        assert.equal(jobId, id)
        oldHandleAborts += 1
        return true
      },
      release() { assert.fail('未登记的新句柄不得释放旧句柄') },
    },
  })

  await processJob(id)

  const stored = store.stored()
  assert.equal(providerCalls, 0)
  assert.equal(oldHandleAborts, 1)
  assert.equal(stored.status, 'running')
  assert.equal(stored.execution.generation, 2)
  assert.equal(stored.execution.leaseToken, 'lease-takeover-worker')
  assert.equal(store.commitCommands.length, 0, '冲突的新 generation 不得误写失败或取消终态')
  assert.equal(store.cancellationAcks.length, 0, '冲突的新 generation 不得确认旧 generation 的取消')
})

test('取消在 Provider 前赢得 Store CAS 后，stale Worker 不得调用 Provider 或复活 Job', async () => {
  const store = fencedStore(queuedJob('job-cancel-toctou'), { cancelBeforeProvider: true })
  let providerCalls = 0
  const processJob = processor(store, async () => {
    providerCalls += 1
    return { outputs: [{ id: 'late-output' }], missingOutputCount: 0 }
  })

  await processJob('job-cancel-toctou')

  assert.equal(providerCalls, 0)
  assert.equal(store.stored().status, 'cancelled')
  assert.deepEqual(store.stored().outputs, [])
})

test('Branch retry 孤儿 Job 不是 Run 的 active execution identity 时不得调用 Provider', async () => {
  const job = {
    ...queuedJob('job-orphan-retry'),
    agentRun: { runId: 'run-retry-fence', branchId: 'branch-a', attempt: 1 },
  }
  const store = fencedStore(job)
  store.readAgentRunForWorker = async () => ({
    id: 'run-retry-fence', ownerId: job.ownerId, projectId: job.projectId, status: 'queued',
    branches: [{
      id: 'branch-a', status: 'queued', attempt: 1, activeJobId: 'job-winning-retry',
      jobIds: ['job-source', 'job-winning-retry'],
    }],
  })
  let providerCalls = 0

  await processor(store, async () => {
    providerCalls += 1
    return { outputs: [{ id: 'must-not-exist' }], missingOutputCount: 0 }
  })(job.id)

  assert.equal(providerCalls, 0)
  assert.equal(store.stored().status, 'cancelled')
  assert.deepEqual(store.stored().outputs, [])
})

test('Branch retry Worker 同时核对 attempt 与 retry request binding，任一漂移都 fail closed', async () => {
  const projectId = 'project-1'
  const binding = (sourceJobId) => createIdempotencyRequestBinding({
    scope: 'agent-branch.retry', projectId,
    request: { runId: 'run-retry-fence', branchId: 'branch-a', sourceAttempt: 0, sourceJobId },
  })
  for (const scenario of ['attempt', 'binding']) {
    const job = {
      ...queuedJob(`job-retry-${scenario}`),
      idempotencyBinding: binding('job-source'),
      agentRun: { runId: 'run-retry-fence', branchId: 'branch-a', attempt: 1 },
    }
    const store = fencedStore(job)
    store.readAgentRunForWorker = async () => ({
      id: 'run-retry-fence', ownerId: job.ownerId, projectId, status: 'queued',
      branches: [{
        id: 'branch-a', status: 'queued',
        attempt: scenario === 'attempt' ? 2 : 1,
        activeJobId: job.id,
        jobIds: ['job-source', job.id],
        retryClaim: {
          sourceAttempt: 0, sourceJobId: 'job-source', jobId: job.id,
          idempotencyBinding: scenario === 'binding' ? binding('foreign-source') : binding('job-source'),
        },
      }],
    })
    let providerCalls = 0

    await processor(store, async () => {
      providerCalls += 1
      return { outputs: [{ id: 'must-not-exist' }], missingOutputCount: 0 }
    })(job.id)

    assert.equal(providerCalls, 0, scenario)
    assert.equal(store.stored().status, 'cancelled', scenario)
  }
})

test('Branch active identity 在 Provider attempt 记录后切换，最后一道 fence 仍阻止付费调用', async () => {
  const projectId = 'project-1'
  const idempotencyBinding = createIdempotencyRequestBinding({
    scope: 'agent-branch.retry', projectId,
    request: { runId: 'run-provider-boundary', branchId: 'branch-a', sourceAttempt: 0, sourceJobId: 'job-source' },
  })
  const job = {
    ...queuedJob('job-provider-boundary'),
    idempotencyBinding,
    agentRun: { runId: 'run-provider-boundary', branchId: 'branch-a', attempt: 1 },
  }
  const store = fencedStore(job)
  let runReads = 0
  store.readAgentRunForWorker = async () => {
    runReads += 1
    return {
      id: 'run-provider-boundary', ownerId: job.ownerId, projectId, status: 'queued',
      branches: [{
        id: 'branch-a', status: 'queued', attempt: 1,
        activeJobId: runReads < 3 ? job.id : 'job-newer-retry',
        retryClaim: {
          sourceAttempt: 0, sourceJobId: 'job-source', jobId: job.id, idempotencyBinding,
        },
      }],
    }
  }
  let providerCalls = 0

  await processor(store, async () => {
    providerCalls += 1
    return { outputs: [{ id: 'must-not-exist' }], missingOutputCount: 0 }
  })(job.id)

  assert.equal(runReads, 3)
  assert.equal(providerCalls, 0)
  assert.equal(store.stored().status, 'cancelled')
})

test('Branch retry 的 activeJobId、attempt 与 request binding 全匹配时允许唯一 Provider 执行', async () => {
  const projectId = 'project-1'
  const idempotencyBinding = createIdempotencyRequestBinding({
    scope: 'agent-branch.retry', projectId,
    request: { runId: 'run-valid-retry', branchId: 'branch-a', sourceAttempt: 0, sourceJobId: 'job-source' },
  })
  const job = {
    ...queuedJob('job-valid-retry'),
    idempotencyBinding,
    agentRun: { runId: 'run-valid-retry', branchId: 'branch-a', attempt: 1 },
  }
  const store = fencedStore(job)
  store.readAgentRunForWorker = async () => ({
    id: 'run-valid-retry', ownerId: job.ownerId, projectId, status: 'queued',
    branches: [{
      id: 'branch-a', status: 'queued', attempt: 1, activeJobId: job.id,
      retryClaim: {
        sourceAttempt: 0, sourceJobId: 'job-source', jobId: job.id, idempotencyBinding,
      },
    }],
  })
  let providerCalls = 0

  await processor(store, async () => {
    providerCalls += 1
    return { outputs: [{ id: 'valid-output' }], missingOutputCount: 0 }
  })(job.id)

  assert.equal(providerCalls, 1)
  assert.equal(store.stored().status, 'succeeded')
})

test('heartbeat 失去 generation lease 时立即 abort Provider，且不写 failed 覆盖新执行者', async () => {
  const store = fencedStore(queuedJob('job-heartbeat-fence'))
  let providerAttemptCommitted = false
  const originalCommit = store.commitGenerationJobExecution.bind(store)
  store.commitGenerationJobExecution = async (ownerId, command) => {
    if (command.job?.providerAttempts?.length) providerAttemptCommitted = true
    if (providerAttemptCommitted && command.status === 'running' && !command.job) {
      return { kind: 'stale', changed: false, job: store.stored() }
    }
    return originalCommit(ownerId, command)
  }
  let observedAbort = false
  let heartbeatCallback
  const processJob = processor(store, async (_input, { signal }) => new Promise((resolve) => {
    signal.addEventListener('abort', () => {
      observedAbort = true
      resolve({ outputs: [{ id: 'must-discard' }], missingOutputCount: 0 })
    }, { once: true })
    queueMicrotask(heartbeatCallback)
  }), {
    setIntervalFn(callback) { heartbeatCallback = callback; return 1 },
    clearIntervalFn() {},
  })

  await processJob('job-heartbeat-fence')

  assert.equal(observedAbort, true)
  assert.notEqual(store.stored().status, 'failed')
  assert.deepEqual(store.stored().outputs, [])
})

test('旧 Worker 读到 takeover 后的新快照也只能提交自己的不可变 fence', async () => {
  // 第 1 次 read 是 Worker 入口；第 2 次正好是 Provider attempt 写前的 latest 基线。
  const store = fencedStore(queuedJob('job-no-lease-theft'), { takeoverOnRead: 2 })
  let providerCalls = 0
  const processJob = processor(store, async () => {
    providerCalls += 1
    return { outputs: [{ id: 'must-not-run' }], missingOutputCount: 0 }
  }, { leaseTokenFactory: () => 'lease-old-worker' })

  await processJob('job-no-lease-theft')

  assert.equal(providerCalls, 0)
  assert.equal(store.stored().execution.leaseToken, 'lease-new-worker')
  assert.equal(store.stored().execution.generation, 2)
  assert.ok(store.commitCommands.length >= 2)
  for (const command of store.commitCommands) {
    assert.equal(command.leaseToken, 'lease-old-worker')
    assert.equal(command.executionGeneration, 1)
  }
})

test('终态 writeback 恢复必须先通过原 execution fence，重试已清 lease 时不写旧画布', async () => {
  const terminal = {
    ...queuedJob('job-terminal-writeback-fence'),
    status: 'failed',
    error: '旧执行失败',
    projectWritebackPending: true,
    executionVersion: 1,
    execution: {
      generation: 1,
      leaseToken: 'lease-old-terminal',
      leaseDurationMs: 30_000,
      leaseExpiresAt: Date.now() - 1,
      settledAt: Date.now() - 1,
    },
  }
  let projectReads = 0
  const commitCommands = []
  const store = {
    async readGenerationJobForWorker() { return structuredClone(terminal) },
    async commitGenerationJobExecution(_ownerId, command) {
      commitCommands.push(structuredClone(command))
      return {
        kind: 'stale',
        changed: false,
        job: { ...terminal, status: 'queued', execution: undefined },
      }
    },
    async readProject() { projectReads += 1; return undefined },
    async refreshGenerationArtifacts() { return true },
  }

  await processor(store, async () => assert.fail('终态恢复不得调用 Provider'))('job-terminal-writeback-fence')

  assert.equal(projectReads, 0)
  assert.equal(commitCommands.length, 1)
  assert.equal(commitCommands[0].leaseToken, 'lease-old-terminal')
  assert.equal(commitCommands[0].executionGeneration, 1)
})
