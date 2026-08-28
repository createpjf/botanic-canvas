import assert from 'node:assert/strict'
import test from 'node:test'
import { automaticRetryIdempotencyKey, createAgentBranchRetrySweep } from './agentBranchRetrySweep.mjs'

function harness({ runs, jobs, retryResult = { kind: 'queued', job: { id: 'job-new' } } } = {}) {
  const events = []
  const retried = []
  const sweep = createAgentBranchRetrySweep({
    productStore: {
      listRunsWithFailedBranches: async () => runs.map((run) => ({ runId: run.id, ownerId: run.ownerId })),
      readAgentRunForWorker: async (runId) => runs.find((run) => run.id === runId),
      readGenerationJobForWorker: async (jobId) => jobs[jobId],
    },
    retryAgentBranch: async (input) => { retried.push(input); return retryResult },
    observe: (event) => events.push(event),
    now: () => 1_000_000,
  })
  return { sweep, events, retried }
}

const failedRun = {
  id: 'run-1', ownerId: 'user-1', status: 'partial',
  branches: [
    { id: 'transient', status: 'failed', attempt: 0, activeJobId: 'job-transient' },
    { id: 'permanent', status: 'failed', attempt: 0, activeJobId: 'job-permanent' },
    { id: 'ok', status: 'succeeded', activeJobId: 'job-ok' },
  ],
}
const jobs = {
  'job-transient': { id: 'job-transient', batchCount: 2, errorCode: 'PROVIDER_TIMEOUT', rawInput: {}, updatedAt: 0 },
  'job-permanent': { id: 'job-permanent', batchCount: 2, errorCode: 'INVALID_REQUEST', rawInput: {}, updatedAt: 0 },
  'job-ok': { id: 'job-ok', status: 'succeeded' },
}

test('只重试策略允许的分支，其余停下并记录原因', async () => {
  const { sweep, events, retried } = harness({ runs: [failedRun], jobs })
  const result = await sweep()

  assert.deepEqual(retried.map((entry) => entry.branchId), ['transient'])
  assert.equal(result.retried, 1)
  assert.equal(result.held, 1)
  // 「为什么它没自动重试」必须能回答。
  const heldEvent = events.find((event) => event.event === 'agent.branch.retry.held')
  assert.equal(heldEvent.branchId, 'permanent')
  assert.equal(heldEvent.reason, 'error_not_retryable')
})

test('自动重试的幂等键由 Run/分支/尝试次数派生，重复清扫不会重复提交', async () => {
  // 多个 Worker 实例同时扫到同一分支时，它们算出同一个键 → 同一个 Job。
  const first = automaticRetryIdempotencyKey('run-1', 'branch-a', 0)
  assert.equal(first, automaticRetryIdempotencyKey('run-1', 'branch-a', 0))
  assert.notEqual(first, automaticRetryIdempotencyKey('run-1', 'branch-a', 1))
  assert.notEqual(first, automaticRetryIdempotencyKey('run-2', 'branch-a', 0))

  const { sweep, retried } = harness({ runs: [failedRun], jobs })
  await sweep()
  assert.equal(retried[0].idempotencyKey, automaticRetryIdempotencyKey('run-1', 'transient', 0))
})

test('重试服务报错时记录并继续，不中断整批清扫', async () => {
  const { sweep, events } = harness({
    runs: [failedRun], jobs,
    retryResult: { kind: 'error', status: 503, code: 'QUEUE_UNAVAILABLE', message: '队列不可用' },
  })
  const result = await sweep()
  assert.equal(result.retried, 0)
  assert.ok(events.some((event) => event.event === 'agent.branch.retry.failed' && event.code === 'QUEUE_UNAVAILABLE'))
})

test('复用既有任务时不计入新提交', async () => {
  const { sweep, events } = harness({ runs: [failedRun], jobs, retryResult: { kind: 'reused', job: { id: 'job-existing' } } })
  const result = await sweep()
  assert.equal(result.retried, 0)
  assert.ok(events.some((event) => event.event === 'agent.branch.retry.automatic' && event.reused === true))
})

test('没有失败分支的部署不做任何事', async () => {
  const { sweep, retried } = harness({ runs: [], jobs: {} })
  assert.deepEqual(await sweep(), { scanned: 0, retried: 0, held: 0 })
  assert.deepEqual(retried, [])
})

test('同一分支同一 held 原因只记一次', async () => {
  const { createAgentBranchRetrySweep } = await import('./agentBranchRetrySweep.mjs')
  const run = {
    id: 'run-1',
    ownerId: 'user-1',
    branches: [{ id: 'branch-1', status: 'failed', attempt: 0, activeJobId: 'job-1' }],
  }
  // errorCode 不在可重试白名单里 → 原因恒为 error_not_retryable，永远不会变。
  const job = { id: 'job-1', rawInput: {}, errorCode: 'PROVIDER_REJECTED', batchCount: 1, updatedAt: 0 }
  const events = []
  const sweep = createAgentBranchRetrySweep({
    productStore: {
      listRunsWithFailedBranches: async () => [{ runId: run.id, ownerId: run.ownerId }],
      readAgentRunForWorker: async () => run,
      readGenerationJobForWorker: async () => job,
      readGenerationJob: async () => undefined,
    },
    retryAgentBranch: async () => ({ kind: 'ok' }),
    observe: (event) => events.push(event),
    now: () => 10 * 60_000,
  })

  await sweep()
  await sweep()
  await sweep()

  const held = events.filter((event) => event.event === 'agent.branch.retry.held')
  assert.equal(held.length, 1, '同一原因连刷三轮只应记一条')
  assert.equal(held[0].reason, 'error_not_retryable')
})

test('held 原因变化时记新的一条', async () => {
  const { createAgentBranchRetrySweep } = await import('./agentBranchRetrySweep.mjs')
  const run = {
    id: 'run-2',
    ownerId: 'user-1',
    branches: [{ id: 'branch-2', status: 'failed', attempt: 0, activeJobId: 'job-2' }],
  }
  let job
  const events = []
  const sweep = createAgentBranchRetrySweep({
    productStore: {
      listRunsWithFailedBranches: async () => [{ runId: run.id, ownerId: run.ownerId }],
      readAgentRunForWorker: async () => run,
      readGenerationJobForWorker: async () => job,
      readGenerationJob: async () => undefined,
    },
    retryAgentBranch: async () => ({ kind: 'ok' }),
    observe: (event) => events.push(event),
    now: () => 10 * 60_000,
  })

  job = undefined                                   // → job_missing
  await sweep()
  job = { id: 'job-2', rawInput: {}, errorCode: 'PROVIDER_REJECTED', batchCount: 1, updatedAt: 0 }
  await sweep()                                     // → error_not_retryable
  await sweep()                                     // 同上，不再记

  const reasons = events.filter((event) => event.event === 'agent.branch.retry.held').map((event) => event.reason)
  assert.deepEqual(reasons, ['job_missing', 'error_not_retryable'])
})

test('分支在清扫之外被手动重试后，同一 held 原因要在新尝试上重新记一条', async () => {
  // dedup 键只带 runId:branchId 会在这里漏记：手动重试把 attempt 从 0 推到 1，
  // 分支带着同一个不可重试错误再次失败，如果键不跟着 attempt 变，第二次会被
  // 误判成「原因没变」而静默丢掉——运维看到的是清扫又停了一次却没有日志。
  const { createAgentBranchRetrySweep } = await import('./agentBranchRetrySweep.mjs')
  let run = {
    id: 'run-3',
    ownerId: 'user-1',
    branches: [{ id: 'branch-3', status: 'failed', attempt: 0, activeJobId: 'job-3a' }],
  }
  const job = { rawInput: {}, errorCode: 'PROVIDER_REJECTED', batchCount: 1, updatedAt: 0 }
  const jobsById = { 'job-3a': { id: 'job-3a', ...job }, 'job-3b': { id: 'job-3b', ...job } }
  const events = []
  const sweep = createAgentBranchRetrySweep({
    productStore: {
      listRunsWithFailedBranches: async () => [{ runId: run.id, ownerId: run.ownerId }],
      readAgentRunForWorker: async () => run,
      readGenerationJobForWorker: async (jobId) => jobsById[jobId],
      readGenerationJob: async () => undefined,
    },
    retryAgentBranch: async () => ({ kind: 'ok' }),
    observe: (event) => events.push(event),
    now: () => 10 * 60_000,
    // 把尝试次数上限抬高，让 attempt 1 仍然走到「错误码不可重试」判定而不是
    // 「尝试次数耗尽」——这样才能验证同一个 held 原因在新 attempt 上会重新记录。
    policy: { maximumAutomaticAttempts: 5 },
  })

  await sweep()                                     // attempt 0 → error_not_retryable，记一条
  await sweep()                                     // 同一 attempt，不再记

  // 分支在清扫之外被手动重试：attempt 前进，指向新的 activeJobId。
  run = { ...run, branches: [{ id: 'branch-3', status: 'failed', attempt: 1, activeJobId: 'job-3b' }] }
  await sweep()                                     // attempt 1，同样的原因，必须重新记一条
  await sweep()                                     // 同一 attempt 又不再记

  const reasons = events
    .filter((event) => event.event === 'agent.branch.retry.held')
    .map((event) => event.reason)
  assert.deepEqual(reasons, ['error_not_retryable', 'error_not_retryable'])
})

test('跨 sweep keyset 会越过 poison 前缀访问后页，并在尾页后 wrap', async () => {
  const runs = Array.from({ length: 5 }, (_, index) => ({
    id: `run-${index + 1}`,
    ownerId: 'user-1',
    projectId: 'project-1',
    updatedAt: (index + 1) * 10,
    status: 'partial',
    branches: [],
  }))
  const listedAfter = []
  const visited = []
  const sweep = createAgentBranchRetrySweep({
    productStore: {
      listRunsWithFailedBranches: async ({ after, limit }) => {
        listedAfter.push(after ? structuredClone(after) : null)
        return runs
          .filter((run) => !after || run.updatedAt > after.updatedAt
            || (run.updatedAt === after.updatedAt && run.id.localeCompare(after.id) > 0))
          .slice(0, limit)
          .map((run) => ({
            runId: run.id, ownerId: run.ownerId, projectId: run.projectId, updatedAt: run.updatedAt,
          }))
      },
      readAgentRunForWorker: async (runId) => {
        visited.push(runId)
        if (runId === 'run-1') throw new Error('poison run')
        return runs.find((run) => run.id === runId)
      },
    },
    retryAgentBranch: async () => ({ kind: 'reused' }),
  })

  await sweep({ limit: 2 })
  await sweep({ limit: 2 })
  await sweep({ limit: 2 })
  await sweep({ limit: 2 })

  assert.deepEqual(listedAfter, [
    null,
    { updatedAt: 20, id: 'run-2' },
    { updatedAt: 40, id: 'run-4' },
    null,
  ])
  assert.deepEqual(visited.slice(0, 5), ['run-1', 'run-2', 'run-3', 'run-4', 'run-5'])
})

test('Adapter 返回同一满页导致游标停滞时，下轮会 fail-safe wrap', async () => {
  const page = [
    { runId: 'run-a', ownerId: 'user-1', projectId: 'project-1', updatedAt: 10 },
    { runId: 'run-b', ownerId: 'user-1', projectId: 'project-1', updatedAt: 20 },
  ]
  const listedAfter = []
  const sweep = createAgentBranchRetrySweep({
    productStore: {
      listRunsWithFailedBranches: async ({ after }) => {
        listedAfter.push(after ? structuredClone(after) : null)
        return page
      },
      readAgentRunForWorker: async (runId) => ({
        id: runId, ownerId: 'user-1', projectId: 'project-1', branches: [],
      }),
    },
    retryAgentBranch: async () => ({ kind: 'reused' }),
  })

  await sweep({ limit: 2 })
  await sweep({ limit: 2 })
  await sweep({ limit: 2 })
  assert.deepEqual(listedAfter, [null, { updatedAt: 20, id: 'run-b' }, null])
})
