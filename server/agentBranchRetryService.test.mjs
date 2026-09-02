import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentBranchRetryService } from './agentBranchRetryService.mjs'
import { agentBranchRetryClaimDecision } from './agentBranchRetryClaim.mjs'
import { generationJobIdForIdempotency } from './generation/generationIdempotency.mjs'
import { createIdempotencyRequestBinding } from './idempotencyRequestBinding.mjs'

test('分支重试幂等键命中另一项目或分支的 Job 时 fail closed', async () => {
  const now = Date.now()
  const run = {
    id: 'run-binding', ownerId: 'user-1', projectId: 'project-binding', status: 'failed',
    plan: { summary: '绑定检查' }, createdAt: now, updatedAt: now,
    branches: [{
      id: 'branch-a', status: 'failed', attempt: 0, activeJobId: 'job-old',
      jobIds: ['job-old'], outputCount: 0, updatedAt: now,
    }],
  }
  const previousJob = {
    id: 'job-old', ownerId: 'user-1', projectId: run.projectId, status: 'failed', kind: 'generation',
    createdAt: now - 1_000, updatedAt: now - 500, batchCount: 1,
    settings: { model: 'gpt-image-2' }, rawInput: { projectId: run.projectId }, outputs: [],
    agentRun: { runId: run.id, branchId: 'branch-a' },
  }
  const key = 'retry-binding-conflict'
  const conflictingJob = {
    ...previousJob,
    id: generationJobIdForIdempotency('user-1', key),
    projectId: 'project-other',
    rawInput: { projectId: 'project-other' },
    agentRun: { runId: 'run-other', branchId: 'branch-other' },
  }
  const retry = createAgentBranchRetryService({
    productStore: {
      readAgentRun: async () => structuredClone(run),
      readGenerationJob: async (_userId, jobId) => structuredClone(
        jobId === previousJob.id ? previousJob : conflictingJob,
      ),
    },
    config: { security: { generationOutputsPerDay: 100 } },
    enqueue: async () => { throw new Error('冲突请求不得入队') },
    securityControls: { reserveMany: async () => ({ allowed: true }) },
  })

  const result = await retry({ userId: 'user-1', runId: run.id, branchId: 'branch-a', idempotencyKey: key })

  assert.deepEqual(
    { kind: result.kind, status: result.status, code: result.code },
    { kind: 'error', status: 409, code: 'IDEMPOTENCY_KEY_CONFLICT' },
  )
})

test('分支新 Job 重试不继承上一任务的 execution token', async () => {
  const now = Date.now()
  const run = {
    id: 'run-retry-fence',
    ownerId: 'user-1',
    projectId: 'project-retry-fence',
    status: 'failed',
    plan: { summary: '重试围栏' },
    branches: [{
      id: 'branch-a', status: 'failed', attempt: 0,
      activeJobId: 'job-old', jobIds: ['job-old'], outputCount: 0, updatedAt: now,
    }],
    createdAt: now,
    updatedAt: now,
  }
  const previousJob = {
    id: 'job-old', ownerId: 'user-1', projectId: run.projectId,
    status: 'failed', kind: 'generation', refinementMode: 'faithful',
    createdAt: now - 1_000, updatedAt: now - 500, batchCount: 1,
    settings: { model: 'gpt-image-2' }, rawInput: { projectId: run.projectId },
    outputs: [], error: 'provider failed',
    executionVersion: 7,
    execution: {
      generation: 7,
      leaseToken: 'old-private-lease',
      leaseDurationMs: 30_000,
      leaseExpiresAt: now - 500,
      settledAt: now - 500,
    },
    agentRun: { runId: run.id, branchId: 'branch-a' },
  }
  let currentRun = structuredClone(run)
  let insertedJob
  const retry = createAgentBranchRetryService({
    productStore: {
      async readAgentRun() { return structuredClone(currentRun) },
      async readGenerationJob(_userId, jobId) {
        return jobId === previousJob.id ? structuredClone(previousJob) : undefined
      },
      async readProject() { return undefined },
      async claimAgentBranchRetry(_userId, command) {
        const decision = agentBranchRetryClaimDecision(currentRun, command)
        if (decision.changed) currentRun = structuredClone(decision.run)
        insertedJob = structuredClone(command.job)
        return structuredClone({ ...decision, job: insertedJob })
      },
      async putAgentRun(_userId, next) { currentRun = structuredClone(next); return structuredClone(next) },
      async putGenerationJob(_userId, job) { insertedJob = structuredClone(job); return structuredClone(job) },
    },
    config: { security: { generationOutputsPerDay: 100 } },
    enqueue: async () => {},
    securityControls: { reserveMany: async () => ({ allowed: true, reused: false }) },
    publishProjectUpdated: async () => {},
    publishAgentRunUpdated: async () => {},
    agentRunGeneration: { persistJobState: async () => {} },
  })

  const result = await retry({
    userId: 'user-1', runId: run.id, branchId: 'branch-a', idempotencyKey: 'retry-fence-key',
  })

  assert.equal(result.kind, 'queued')
  assert.notEqual(insertedJob.id, previousJob.id)
  assert.equal(insertedJob.execution, undefined)
  assert.equal(insertedJob.executionVersion, undefined)
})

test('并发分支重试已先 claim 时复用权威 running，不因重复 enqueue 失败终结 Worker', async () => {
  const now = Date.now()
  const run = {
    id: 'run-retry-put-race', ownerId: 'user-1', projectId: 'project-retry-put-race', status: 'failed',
    plan: { summary: '并发重试' }, createdAt: now, updatedAt: now,
    branches: [{
      id: 'branch-a', status: 'failed', attempt: 0, activeJobId: 'job-old',
      jobIds: ['job-old'], outputCount: 0, updatedAt: now,
    }],
  }
  const previousJob = {
    id: 'job-old', ownerId: 'user-1', projectId: run.projectId, status: 'failed', kind: 'generation',
    createdAt: now - 1_000, updatedAt: now - 500, batchCount: 1,
    settings: { model: 'gpt-image-2' }, rawInput: { projectId: run.projectId }, outputs: [],
    agentRun: { runId: run.id, branchId: 'branch-a' },
  }
  let currentRun = structuredClone(run)
  let enqueueCalls = 0
  let storedRunning
  const retry = createAgentBranchRetryService({
    productStore: {
      async readAgentRun() { return structuredClone(currentRun) },
      async readGenerationJob(_userId, jobId) { return jobId === previousJob.id ? structuredClone(previousJob) : undefined },
      async readProject() { return undefined },
      async claimAgentBranchRetry(_userId, command) {
        const decision = agentBranchRetryClaimDecision(currentRun, command)
        if (decision.changed) currentRun = structuredClone(decision.run)
        storedRunning = {
          ...structuredClone(command.job), status: 'running', executionVersion: 1,
          execution: { generation: 1, leaseToken: 'lease-concurrent-retry' },
        }
        return structuredClone({ ...decision, job: storedRunning })
      },
      async putAgentRun(_userId, next) { currentRun = structuredClone(next); return structuredClone(next) },
      async putGenerationJob(_userId, job) {
        storedRunning = {
          ...structuredClone(job), status: 'running', executionVersion: 1,
          execution: { generation: 1, leaseToken: 'lease-concurrent-retry' },
        }
        return structuredClone(storedRunning)
      },
    },
    config: { security: { generationOutputsPerDay: 100 } },
    enqueue: async () => { enqueueCalls += 1; throw new Error('重复 enqueue 不应发生') },
    securityControls: { reserveMany: async () => ({ allowed: true, reused: false }) },
    publishProjectUpdated: async () => {},
    publishAgentRunUpdated: async () => {},
    agentRunGeneration: { persistJobState: async () => {} },
  })

  const result = await retry({
    userId: 'user-1', runId: run.id, branchId: 'branch-a', idempotencyKey: 'retry-put-race-key',
  })

  assert.equal(result.kind, 'queued')
  assert.equal(result.job.status, 'running')
  assert.equal(result.job.id, storedRunning.id)
  assert.equal(enqueueCalls, 0)
})

test('同一分支重试幂等键并发到达只实际预留一次日输出额度', async () => {
  const now = Date.now()
  const run = {
    id: 'run-retry-concurrent', ownerId: 'user-1', projectId: 'project-retry-concurrent', status: 'failed',
    plan: { summary: '并发重试' }, createdAt: now, updatedAt: now,
    branches: [{
      id: 'branch-a', status: 'failed', attempt: 0, activeJobId: 'job-old',
      jobIds: ['job-old'], outputCount: 0, updatedAt: now,
    }],
  }
  const previousJob = {
    id: 'job-old', ownerId: 'user-1', projectId: run.projectId, status: 'failed', kind: 'generation',
    createdAt: now - 1_000, updatedAt: now - 500, batchCount: 1,
    settings: { model: 'gpt-image-2' }, rawInput: { projectId: run.projectId }, outputs: [],
    agentRun: { runId: run.id, branchId: 'branch-a' },
  }
  let currentRun = structuredClone(run)
  const jobs = new Map([[previousJob.id, previousJob]])
  let newJobReads = 0
  let releaseConcurrentReads
  const concurrentReads = new Promise((resolve) => { releaseConcurrentReads = resolve })
  const reservationIds = new Set()
  const reservationAttempts = []
  let chargedOutputs = 0
  const retry = createAgentBranchRetryService({
    productStore: {
      async readAgentRun() { return structuredClone(currentRun) },
      async readGenerationJob(_userId, jobId) {
        if (jobId === previousJob.id) return structuredClone(previousJob)
        newJobReads += 1
        if (newJobReads === 2) releaseConcurrentReads()
        await concurrentReads
        return jobs.has(jobId) ? structuredClone(jobs.get(jobId)) : undefined
      },
      async readProject() { return undefined },
      async claimAgentBranchRetry(_userId, command) {
        const decision = agentBranchRetryClaimDecision(currentRun, command)
        if (decision.changed) currentRun = structuredClone(decision.run)
        if (['claimed', 'replay'].includes(decision.kind) && !jobs.has(command.jobId)) {
          jobs.set(command.jobId, structuredClone(command.job))
        }
        return structuredClone({ ...decision, job: jobs.get(command.jobId) })
      },
      async putAgentRun(_userId, next) { currentRun = structuredClone(next); return structuredClone(next) },
      async putGenerationJob(_userId, job) {
        if (!jobs.has(job.id)) jobs.set(job.id, structuredClone(job))
        return structuredClone(jobs.get(job.id))
      },
    },
    config: { security: { generationOutputsPerDay: 100 } },
    enqueue: async () => {},
    securityControls: {
      async reserveMany(input) {
        reservationAttempts.push(input)
        if (reservationIds.has(input.reservationId)) return { allowed: true, reused: true }
        reservationIds.add(input.reservationId)
        chargedOutputs += input.entries[0].cost
        return { allowed: true, reused: false }
      },
    },
    publishProjectUpdated: async () => {},
    publishAgentRunUpdated: async () => {},
    agentRunGeneration: { persistJobState: async () => {} },
  })

  const [first, second] = await Promise.all([
    retry({ userId: 'user-1', runId: run.id, branchId: 'branch-a', idempotencyKey: 'retry-concurrent-key' }),
    retry({ userId: 'user-1', runId: run.id, branchId: 'branch-a', idempotencyKey: 'retry-concurrent-key' }),
  ])

  assert.equal(first.kind, 'queued')
  assert.equal(second.kind, 'queued')
  assert.equal(first.job.id, second.job.id)
  assert.equal(reservationAttempts.length, 2)
  assert.equal(new Set(reservationAttempts.map((item) => item.reservationId)).size, 1)
  assert.equal(chargedOutputs, 1)
})

test('同一 source attempt 的不同幂等键并发重试只能一个 CAS 胜出并创建 Job', async () => {
  const now = Date.now()
  const run = {
    id: 'run-retry-different-keys', ownerId: 'user-1', projectId: 'project-retry-different-keys', status: 'failed',
    plan: { summary: '不同 key 竞态' }, createdAt: now, updatedAt: now,
    branches: [{
      id: 'branch-a', status: 'failed', attempt: 0, activeJobId: 'job-old',
      jobIds: ['job-old'], outputCount: 0, updatedAt: now,
    }],
  }
  const previousJob = {
    id: 'job-old', ownerId: 'user-1', projectId: run.projectId, status: 'failed', kind: 'generation',
    createdAt: now - 1_000, updatedAt: now - 500, batchCount: 1,
    settings: { model: 'gpt-image-2' }, rawInput: { projectId: run.projectId }, outputs: [],
    agentRun: { runId: run.id, branchId: 'branch-a', attempt: 0 },
  }
  let currentRun = structuredClone(run)
  const jobs = new Map([[previousJob.id, structuredClone(previousJob)]])
  const enqueued = []
  const reservationIds = []
  const retry = createAgentBranchRetryService({
    productStore: {
      async readAgentRun() { return structuredClone(currentRun) },
      async readGenerationJob(_userId, jobId) { return structuredClone(jobs.get(jobId)) },
      async readProject() { return undefined },
      async claimAgentBranchRetry(_userId, command) {
        const branch = currentRun.branches.find((item) => item.id === command.branchId)
        if (branch?.attempt !== command.expectedAttempt
          || branch?.activeJobId !== command.expectedActiveJobId
          || !['failed', 'cancelled'].includes(branch.status)) {
          return { kind: 'conflict', changed: false, run: structuredClone(currentRun) }
        }
        branch.status = 'queued'
        branch.attempt += 1
        branch.activeJobId = command.jobId
        branch.jobIds.push(command.jobId)
        branch.retryClaim = {
          sourceAttempt: command.expectedAttempt,
          sourceJobId: command.expectedActiveJobId,
          jobId: command.jobId,
          idempotencyBinding: structuredClone(command.idempotencyBinding),
        }
        currentRun.status = 'queued'
        jobs.set(command.jobId, structuredClone(command.job))
        return {
          kind: 'claimed', changed: true, run: structuredClone(currentRun),
          job: structuredClone(command.job),
        }
      },
      async putAgentRun() { throw new Error('分支重试必须使用原子 CAS，不能退回 whole Run put') },
      async putGenerationJob(_userId, job) {
        if (!jobs.has(job.id)) jobs.set(job.id, structuredClone(job))
        return structuredClone(jobs.get(job.id))
      },
    },
    config: { security: { generationOutputsPerDay: 100 } },
    enqueue: async (jobId) => { enqueued.push(jobId) },
    securityControls: {
      async reserveMany(input) {
        reservationIds.push(input.reservationId)
        return { allowed: true, reused: reservationIds.length > 1 }
      },
    },
    publishProjectUpdated: async () => {},
    publishAgentRunUpdated: async () => {},
    agentRunGeneration: { persistJobState: async () => {} },
  })

  const results = await Promise.all([
    retry({ userId: 'user-1', runId: run.id, branchId: 'branch-a', idempotencyKey: 'retry-key-a' }),
    retry({ userId: 'user-1', runId: run.id, branchId: 'branch-a', idempotencyKey: 'retry-key-b' }),
  ])

  assert.deepEqual(results.map((result) => result.kind).sort(), ['error', 'queued'])
  assert.equal(results.find((result) => result.kind === 'error')?.code, 'AGENT_BRANCH_RETRY_CONFLICT')
  assert.equal([...jobs.keys()].filter((id) => id !== previousJob.id).length, 1)
  assert.equal(enqueued.length, 1)
  assert.equal(new Set(reservationIds).size, 1, '不同 key 也必须按 source attempt 共用一次额度预留')
})

test('Branch claim 前被普通 generation 抢占同 Job ID 时原子拒绝且 Run 不指向 foreign Job', async () => {
  const now = Date.now()
  const run = {
    id: 'run-cross-endpoint-race', ownerId: 'user-1', projectId: 'project-cross-endpoint-race', status: 'failed',
    plan: { summary: '跨入口竞态' }, createdAt: now, updatedAt: now,
    branches: [{
      id: 'branch-a', status: 'failed', attempt: 0, activeJobId: 'job-source',
      jobIds: ['job-source'], outputCount: 0, updatedAt: now,
    }],
  }
  const source = {
    id: 'job-source', ownerId: 'user-1', projectId: run.projectId, status: 'failed', kind: 'generation',
    createdAt: now - 1_000, updatedAt: now - 500, batchCount: 1,
    settings: { model: 'gpt-image-2' }, rawInput: { projectId: run.projectId }, outputs: [],
    agentRun: { runId: run.id, branchId: 'branch-a', attempt: 0 },
  }
  let currentRun = structuredClone(run)
  let claimCommand
  let enqueueCalls = 0
  const retry = createAgentBranchRetryService({
    productStore: {
      async readAgentRun() { return structuredClone(currentRun) },
      async readGenerationJob(_userId, jobId) { return jobId === source.id ? structuredClone(source) : undefined },
      async claimAgentBranchRetry(_userId, command) {
        claimCommand = structuredClone(command)
        const foreignJob = {
          ...command.job,
          agentRun: undefined,
          idempotencyBinding: createIdempotencyRequestBinding({
            scope: 'generation.submit', projectId: run.projectId, request: { prompt: 'foreign' },
          }),
        }
        return { kind: 'job_conflict', changed: false, run: structuredClone(currentRun), job: foreignJob }
      },
      async putGenerationJob() { throw new Error('Job identity 必须由原子 claim 一并保留') },
    },
    config: { security: { generationOutputsPerDay: 100 } },
    enqueue: async () => { enqueueCalls += 1 },
    securityControls: { reserveMany: async () => ({ allowed: true }) },
    publishProjectUpdated: async () => {},
    publishAgentRunUpdated: async () => {},
    agentRunGeneration: { persistJobState: async () => {} },
  })

  const result = await retry({
    userId: 'user-1', runId: run.id, branchId: 'branch-a', idempotencyKey: 'shared-cross-endpoint-key',
  })

  assert.equal(result.kind, 'error')
  assert.equal(result.code, 'AGENT_BRANCH_RETRY_CONFLICT')
  assert.equal(claimCommand.job.id, claimCommand.jobId)
  assert.equal(claimCommand.job.agentRun.attempt, 1)
  assert.equal(currentRun.status, 'failed')
  assert.equal(currentRun.branches[0].activeJobId, 'job-source')
  assert.equal(enqueueCalls, 0)
})

test('原子 claim 已落 Run+Job 但 enqueue 回执丢失时，同 key 重放会补入队而不再扣费', async () => {
  const now = Date.now()
  const userId = 'user-1'
  const projectId = 'project-retry-enqueue-recovery'
  const runId = 'run-retry-enqueue-recovery'
  const branchId = 'branch-a'
  const key = 'retry-enqueue-recovery-key'
  const jobId = generationJobIdForIdempotency(userId, key)
  const idempotencyBinding = createIdempotencyRequestBinding({
    scope: 'agent-branch.retry', projectId,
    request: { runId, branchId, sourceAttempt: 0, sourceJobId: 'job-source' },
  })
  const run = {
    id: runId, ownerId: userId, projectId, status: 'queued', plan: { summary: '恢复入队' },
    createdAt: now - 1_000, updatedAt: now,
    branches: [{
      id: branchId, status: 'queued', attempt: 1, activeJobId: jobId,
      jobIds: ['job-source', jobId], outputCount: 0, updatedAt: now,
      retryClaim: { sourceAttempt: 0, sourceJobId: 'job-source', jobId, claimedAt: now, idempotencyBinding },
    }],
  }
  const job = {
    id: jobId, ownerId: userId, projectId, status: 'queued', kind: 'generation',
    createdAt: now, updatedAt: now, batchCount: 1, settings: { model: 'gpt-image-2' },
    rawInput: { projectId }, outputs: [], idempotencyKey: key, idempotencyBinding,
    agentRun: { runId, branchId, attempt: 1 },
  }
  let enqueueCalls = 0
  let reservationCalls = 0
  const retry = createAgentBranchRetryService({
    productStore: {
      async readAgentRun() { return structuredClone(run) },
      async readGenerationJob(_userId, requestedId) { return requestedId === jobId ? structuredClone(job) : undefined },
    },
    config: { security: { generationOutputsPerDay: 100 } },
    enqueue: async (requestedId) => { assert.equal(requestedId, jobId); enqueueCalls += 1 },
    securityControls: { reserveMany: async () => { reservationCalls += 1; return { allowed: true } } },
    publishAgentRunUpdated: async () => {},
  })

  const result = await retry({ userId, runId, branchId, idempotencyKey: key })

  assert.equal(result.kind, 'queued')
  assert.equal(enqueueCalls, 1)
  assert.equal(reservationCalls, 0)
})
