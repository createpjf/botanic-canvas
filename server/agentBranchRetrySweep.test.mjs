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
