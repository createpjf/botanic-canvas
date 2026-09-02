import assert from 'node:assert/strict'
import test from 'node:test'
import { agentRunNeedsSubmissionRecovery, createAgentRunSubmissionSweep } from './agentRunSubmissionSweep.mjs'

function run(id, overrides = {}) {
  return {
    id, ownerId: 'user-a', projectId: 'project-a', status: 'queued',
    branches: [{ id: 'branch-a', status: 'queued', jobIds: [] }],
    ...overrides,
  }
}

test('Run 提交恢复只选尚未落 Job 的 queued 分支', () => {
  assert.equal(agentRunNeedsSubmissionRecovery(run('missing-job')), true)
  assert.equal(agentRunNeedsSubmissionRecovery(run('active', {
    branches: [{ id: 'branch-a', status: 'queued', activeJobId: 'job-a', jobIds: ['job-a'] }],
  })), false)
  assert.equal(agentRunNeedsSubmissionRecovery(run('completed', { status: 'completed' })), false)
  assert.equal(agentRunNeedsSubmissionRecovery(run('partial', {
    branches: [
      { id: 'branch-a', status: 'queued', activeJobId: 'job-a', jobIds: ['job-a'] },
      { id: 'branch-b', status: 'queued', jobIds: [] },
    ],
  })), true)
})

test('Run 恢复稳定分页，不被前页已有 Job 的 Run 饥饿', async () => {
  const all = [
    run('run-a', { branches: [{ id: 'a', status: 'queued', activeJobId: 'job-a', jobIds: ['job-a'] }] }),
    run('run-b', { branches: [{ id: 'b', status: 'queued', activeJobId: 'job-b', jobIds: ['job-b'] }] }),
    run('run-c', { turnId: 'turn-c' }),
  ]
  const submitted = []
  const cursors = []
  const sweep = createAgentRunSubmissionSweep({
    productStore: {
      async listQueuedAgentRunsForRecovery({ afterId, limit }) {
        cursors.push(afterId)
        return all.filter((item) => !afterId || item.id > afterId).slice(0, limit)
      },
      async readAgentTurn() { return { id: 'turn-c', projectId: 'project-a', status: 'completed' } },
    },
    submitGeneration: async (_userId, _projectId, runId) => { submitted.push(runId) },
    pageSize: 2,
  })

  const summary = await sweep()

  assert.deepEqual(cursors, [undefined, 'run-b'])
  assert.deepEqual(submitted, ['run-c'])
  assert.deepEqual(summary, { scanned: 3, candidates: 1, submitted: 1, cancelled: 0, skipped: 2, failed: 0 })
})

test('Turn 已取消时恢复器只收口 Run，绝不补提交 Job', async () => {
  const submitted = []
  const cancelled = []
  const sweep = createAgentRunSubmissionSweep({
    productStore: {
      async listQueuedAgentRunsForRecovery({ afterId }) { return afterId ? [] : [run('run-cancel', { turnId: 'turn-cancel' })] },
      async readAgentTurn() { return { id: 'turn-cancel', projectId: 'project-a', status: 'cancelled' } },
    },
    submitGeneration: async (...args) => { submitted.push(args) },
    cancelAgentRun: async (input) => { cancelled.push(input) },
  })

  const summary = await sweep()

  assert.equal(submitted.length, 0)
  assert.deepEqual(cancelled.map((item) => item.runId), ['run-cancel'])
  assert.equal(summary.cancelled, 1)
})

test('单个 Run 恢复失败不阻塞同页其他 Run', async () => {
  const submitted = []
  const sweep = createAgentRunSubmissionSweep({
    productStore: {
      async listQueuedAgentRunsForRecovery({ afterId }) { return afterId ? [] : [run('run-a'), run('run-b')] },
      async readAgentTurn() { throw new Error('无 turnId 不应读取') },
    },
    submitGeneration: async (_userId, _projectId, runId) => {
      if (runId === 'run-a') throw Object.assign(new Error('短暂失败'), { code: 'QUEUE_UNAVAILABLE' })
      submitted.push(runId)
    },
  })

  const summary = await sweep()

  assert.deepEqual(submitted, ['run-b'])
  assert.equal(summary.failed, 1)
  assert.equal(summary.submitted, 1)
})

test('单轮页数预算耗尽后从游标续扫，不被固定前缀 poison rows 永久饿死', async () => {
  const all = [
    run('run-a', { branches: [{ id: 'a', status: 'queued', activeJobId: 'job-a', jobIds: ['job-a'] }] }),
    run('run-b', { branches: [{ id: 'b', status: 'queued', activeJobId: 'job-b', jobIds: ['job-b'] }] }),
    run('run-c'),
  ]
  const submitted = []
  const cursors = []
  const sweep = createAgentRunSubmissionSweep({
    productStore: {
      async listQueuedAgentRunsForRecovery({ afterId, limit }) {
        cursors.push(afterId)
        return all.filter((item) => !afterId || item.id > afterId).slice(0, limit)
      },
      async readAgentTurn() { throw new Error('无 turnId 不应读取') },
    },
    submitGeneration: async (_userId, _projectId, runId) => { submitted.push(runId) },
    pageSize: 2,
    maximumPages: 1,
  })

  await sweep()
  await sweep()

  assert.deepEqual(cursors, [undefined, 'run-b'])
  assert.deepEqual(submitted, ['run-c'])
})
