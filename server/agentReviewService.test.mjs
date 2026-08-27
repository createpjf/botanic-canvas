import assert from 'node:assert/strict'
import test from 'node:test'
import {
  agentReviewExecutionClaimDecision,
  agentReviewPreparedCheckpoint,
  committedAgentReviewExecution,
} from './agentReviewExecution.mjs'
import { buildReviewTaskForRun } from './agentReviewRunner.mjs'
import { createAgentReviewService } from './agentReviewService.mjs'

const qualityPolicy = {
  version: 1,
  requiredCriteria: ['identity'],
  humanDecisionRequired: true,
}

function fixture({ outputCount = 1 } = {}) {
  const run = {
    id: 'run-1',
    projectId: 'project-1',
    ownerId: 'user-1',
    status: 'completed',
    branches: [{ id: 'branch-1', jobIds: ['job-1'], activeJobId: 'job-1' }],
    compiledPlan: {
      version: 2,
      planFingerprint: 'plan-fingerprint',
      branches: [{ branchId: 'branch-1', branchFingerprint: 'branch-fingerprint', qualityPolicy }],
    },
  }
  const jobs = [{
    id: 'job-1',
    status: 'succeeded',
    settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
    branchFingerprint: 'branch-fingerprint',
    agentRun: { runId: run.id, branchId: 'branch-1' },
    outputs: Array.from({ length: outputCount }, (_, index) => ({
      id: `output-${index + 1}`,
      spec: { mimeType: 'image/png', byteSize: 2_048, width: 1_024, height: 1_024 },
    })),
  }]
  return { run, jobs, built: buildReviewTaskForRun({ run, jobs, now: 1_000 }) }
}

function intervalHarness() {
  let callback
  let cleared = false
  return {
    setIntervalFn(next) {
      callback = next
      return { unref() {} }
    },
    clearIntervalFn() { cleared = true },
    async tick() {
      assert.equal(typeof callback, 'function', 'heartbeat interval 尚未安装')
      await callback()
    },
    get cleared() { return cleared },
  }
}

function fakeStore({ run, jobs, task }) {
  let storedTask = structuredClone(task)
  return {
    task: () => structuredClone(storedTask),
    async readAgentReviewTask(_userId, taskId) {
      return storedTask.id === taskId ? structuredClone(storedTask) : undefined
    },
    async readAgentRun(_userId, runId) {
      return run.id === runId ? structuredClone(run) : undefined
    },
    async readGenerationJob(_userId, jobId) {
      return structuredClone(jobs.find((job) => job.id === jobId))
    },
    async claimAgentReviewExecution(_userId, command) {
      const decision = agentReviewExecutionClaimDecision(storedTask, command)
      if (decision.changed) storedTask = structuredClone(decision.task)
      return structuredClone(decision)
    },
    async commitAgentReviewExecution(_userId, command) {
      const decision = committedAgentReviewExecution(storedTask, command)
      if (decision.changed) storedTask = structuredClone(decision.task)
      return structuredClone(decision)
    },
  }
}

test('Review Service：先 durable prepared，再调用模型并逐候选 fenced commit；并发 Worker 只有一个执行者', async () => {
  const { run, jobs, built } = fixture()
  const store = fakeStore({ run, jobs, task: built.task })
  let releaseModel
  let modelStarted
  const started = new Promise((resolve) => { modelStarted = resolve })
  const gate = new Promise((resolve) => { releaseModel = resolve })
  let visualCalls = 0
  const reviewCandidate = async ({ candidate }) => {
    visualCalls += 1
    const durable = store.task()
    assert.equal(durable.execution.checkpoint.phase, 'prepared')
    assert.equal(durable.execution.checkpoint.artifactId, candidate.artifactId)
    modelStarted()
    await gate
    return { criteria: [{ id: 'identity', layer: 'model', verdict: 'pass', evidence: '主体一致' }] }
  }
  const serviceA = createAgentReviewService({ productStore: store, reviewCandidate, now: () => 2_000 })
  const serviceB = createAgentReviewService({ productStore: store, reviewCandidate, now: () => 2_001 })

  const winner = serviceA.executeReviewTask('user-1', built.task.id)
  await started
  const loser = await serviceB.executeReviewTask('user-1', built.task.id)
  assert.equal(loser.status, 'running')
  assert.equal(visualCalls, 1)

  releaseModel()
  const completed = await winner
  assert.equal(completed.status, 'completed')
  assert.equal(visualCalls, 1)
  assert.equal(store.task().results.length, 1)
  assert.equal(store.task().execution.checkpoint, undefined)
})

test('Review Service：恢复到过期 prepared 时标记 outcome unknown，禁止再次视觉调用', async () => {
  const { run, jobs, built } = fixture()
  const claimed = agentReviewExecutionClaimDecision(built.task, {
    id: built.task.id,
    projectId: built.task.projectId,
    leaseToken: 'dead-worker',
    leaseDurationMs: 30_000,
    observedAt: 2_000,
  }).task
  const prepared = committedAgentReviewExecution(claimed, {
    id: claimed.id,
    projectId: claimed.projectId,
    leaseToken: 'dead-worker',
    executionGeneration: 1,
    status: 'running',
    checkpoint: agentReviewPreparedCheckpoint({ artifactId: built.task.coverage.artifactIds[0], preparedAt: 2_100 }),
    observedAt: 2_100,
  }).task
  const store = fakeStore({ run, jobs, task: prepared })
  let visualCalls = 0
  const service = createAgentReviewService({
    productStore: store,
    reviewCandidate: async () => {
      visualCalls += 1
      return { criteria: [] }
    },
    now: () => 32_101,
  })

  const recovered = await service.executeReviewTask('user-1', built.task.id)
  assert.equal(recovered.status, 'failed')
  assert.equal(recovered.error.code, 'AGENT_REVIEW_OUTCOME_UNKNOWN')
  assert.equal(visualCalls, 0)
})

test('Review Service：长视觉调用期间 heartbeat 跨过原租约，其他 Worker 仍不能接管', async () => {
  const { run, jobs, built } = fixture()
  const store = fakeStore({ run, jobs, task: built.task })
  const intervals = intervalHarness()
  let currentNow = 2_000
  let releaseModel
  let modelStarted
  const started = new Promise((resolve) => { modelStarted = resolve })
  const gate = new Promise((resolve) => { releaseModel = resolve })
  let visualCalls = 0
  const reviewCandidate = async () => {
    visualCalls += 1
    modelStarted()
    await gate
    return { criteria: [{ id: 'identity', layer: 'model', verdict: 'pass' }] }
  }
  const winnerService = createAgentReviewService({
    productStore: store,
    reviewCandidate,
    leaseMs: 30_000,
    heartbeatMs: 10_000,
    setIntervalFn: intervals.setIntervalFn,
    clearIntervalFn: intervals.clearIntervalFn,
    now: () => currentNow,
  })
  const winner = winnerService.executeReviewTask('user-1', built.task.id)
  await started
  const originalExpiry = store.task().execution.leaseExpiresAt

  currentNow = 20_000
  await intervals.tick()
  assert.ok(store.task().execution.leaseExpiresAt > originalExpiry)

  currentNow = 32_100
  const contender = createAgentReviewService({ productStore: store, reviewCandidate, now: () => currentNow })
  const observed = await contender.executeReviewTask('user-1', built.task.id)
  assert.equal(observed.status, 'running')
  assert.equal(visualCalls, 1)

  releaseModel()
  assert.equal((await winner).status, 'completed')
  assert.equal(intervals.cleared, true)
})

test('Review Service：heartbeat 失去 fence 会 abort 当前执行并阻止后续候选外呼', async () => {
  const { run, jobs, built } = fixture({ outputCount: 2 })
  const store = fakeStore({ run, jobs, task: built.task })
  const intervals = intervalHarness()
  let currentNow = 2_000
  let modelStarted
  const started = new Promise((resolve) => { modelStarted = resolve })
  let visualCalls = 0
  const reviewCandidate = async ({ signal }) => {
    visualCalls += 1
    modelStarted()
    return new Promise((resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  }
  const winnerService = createAgentReviewService({
    productStore: store,
    reviewCandidate,
    leaseMs: 30_000,
    heartbeatMs: 10_000,
    setIntervalFn: intervals.setIntervalFn,
    clearIntervalFn: intervals.clearIntervalFn,
    now: () => currentNow,
  })
  const winner = winnerService.executeReviewTask('user-1', built.task.id)
  await started

  // 模拟 Worker 心跳停顿到租约过期：恢复者看到 unresolved prepared 后 fail closed。
  currentNow = 32_100
  const recovery = createAgentReviewService({ productStore: store, reviewCandidate, now: () => currentNow })
  const recovered = await recovery.executeReviewTask('user-1', built.task.id)
  assert.equal(recovered.error.code, 'AGENT_REVIEW_OUTCOME_UNKNOWN')

  await intervals.tick()
  await assert.rejects(winner, (caught) => caught?.code === 'AGENT_REVIEW_EXECUTION_STALE')
  assert.equal(visualCalls, 1)
  assert.equal(store.task().results.length, 0)
  assert.equal(intervals.cleared, true)
})

test('Review Service：terminal commit 前先停止并排空 heartbeat', async () => {
  const { run, jobs, built } = fixture()
  const base = fakeStore({ run, jobs, task: built.task })
  const intervals = intervalHarness()
  const store = {
    ...base,
    async commitAgentReviewExecution(userId, command) {
      if (command.status === 'completed') {
        assert.equal(intervals.cleared, true, 'terminal commit 前必须先 clear heartbeat interval')
      }
      return base.commitAgentReviewExecution(userId, command)
    },
  }
  const service = createAgentReviewService({
    productStore: store,
    reviewCandidate: async () => ({ criteria: [{ id: 'identity', layer: 'model', verdict: 'pass' }] }),
    setIntervalFn: intervals.setIntervalFn,
    clearIntervalFn: intervals.clearIntervalFn,
    now: () => 2_000,
  })

  assert.equal((await service.executeReviewTask('user-1', built.task.id)).status, 'completed')
  assert.equal(intervals.cleared, true)
})

function reviewSweepStore({ tasks, list }) {
  const visited = []
  return {
    visited,
    async listPendingAgentReviewTasks(input) { return list(input) },
    async readAgentReviewTask(_userId, taskId) {
      visited.push(taskId)
      if (taskId === 'task-1') throw new Error('poison review')
      return structuredClone(tasks.find((task) => task.id === taskId))
    },
    async claimAgentReviewExecution(_userId, command) {
      const task = tasks.find((item) => item.id === command.id)
      return { kind: 'replay', task: { ...structuredClone(task), status: 'completed' } }
    },
    async commitAgentReviewExecution() { throw new Error('不应 commit') },
  }
}

test('Review sweep 跨轮越过 poison 前缀访问后页，并在尾页后 wrap', async () => {
  const tasks = Array.from({ length: 5 }, (_, index) => ({
    id: `task-${index + 1}`,
    ownerId: 'user-1',
    projectId: 'project-1',
    runId: `run-${index + 1}`,
    status: 'queued',
    updatedAt: (index + 1) * 10,
  }))
  const listedAfter = []
  const store = reviewSweepStore({
    tasks,
    list: ({ after, limit }) => {
      listedAfter.push(after ? structuredClone(after) : null)
      return tasks
        .filter((task) => !after || task.updatedAt > after.updatedAt
          || (task.updatedAt === after.updatedAt && task.id.localeCompare(after.id) > 0))
        .slice(0, limit)
        .map((task) => structuredClone(task))
    },
  })
  const service = createAgentReviewService({ productStore: store })

  await service.sweepPendingReviewTasks({ limit: 2 })
  await service.sweepPendingReviewTasks({ limit: 2 })
  await service.sweepPendingReviewTasks({ limit: 2 })
  await service.sweepPendingReviewTasks({ limit: 2 })

  assert.deepEqual(listedAfter, [
    null,
    { updatedAt: 20, id: 'task-2' },
    { updatedAt: 40, id: 'task-4' },
    null,
  ])
  assert.deepEqual(store.visited.slice(0, 5), ['task-1', 'task-2', 'task-3', 'task-4', 'task-5'])
})

test('Review sweep 遇到重复满页游标停滞时，下轮会 wrap', async () => {
  const tasks = [
    { id: 'task-a', ownerId: 'user-1', projectId: 'project-1', runId: 'run-a', status: 'queued', updatedAt: 10 },
    { id: 'task-b', ownerId: 'user-1', projectId: 'project-1', runId: 'run-b', status: 'queued', updatedAt: 20 },
  ]
  const listedAfter = []
  const store = reviewSweepStore({
    tasks,
    list: ({ after }) => {
      listedAfter.push(after ? structuredClone(after) : null)
      return tasks.map((task) => structuredClone(task))
    },
  })
  const service = createAgentReviewService({ productStore: store })

  await service.sweepPendingReviewTasks({ limit: 2 })
  await service.sweepPendingReviewTasks({ limit: 2 })
  await service.sweepPendingReviewTasks({ limit: 2 })
  assert.deepEqual(listedAfter, [null, { updatedAt: 20, id: 'task-b' }, null])
})
