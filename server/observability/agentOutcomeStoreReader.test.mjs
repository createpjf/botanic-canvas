import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentOutcomeStoreReadError, readAgentOutcomeSnapshot } from './agentOutcomeStoreReader.mjs'

function page(values, options = {}) {
  const afterId = options.afterId ?? null
  const limit = options.limit ?? 200
  return values.filter((value) => afterId === null || value.id > afterId).slice(0, limit)
}

test('按 Turn 创建时间窗从 Store 读取完整下游事实并现场构建交付清单', async () => {
  const turns = [
    { id: 'turn-old', projectId: 'p', ownerId: 'u', createdAt: 99, updatedAt: 99 },
    { id: 'turn-window', projectId: 'p', ownerId: 'u', createdAt: 100, updatedAt: 200 },
  ]
  const run = { id: 'run-1', projectId: 'p', ownerId: 'u', turnId: 'turn-window', status: 'completed' }
  const job = { id: 'job-1', projectId: 'p', ownerId: 'u', status: 'succeeded', updatedAt: 500, agentRun: { runId: 'run-1' }, outputs: [{ id: 'output-1' }] }
  const review = { id: 'review-1', projectId: 'p', runId: 'run-1', decisions: [{ artifactId: 'generation:job-1:output-1', decision: 'accepted', decidedAt: 600 }] }
  const store = {
    readProject: async () => ({ document: { productionWorkflowRuns: [{
      id: 'workflow-run-1', workflowId: 'workflow-1', workflowVersion: 1, projectId: 'p',
      definition: {}, items: [{ id: 'item-1', jobId: 'job-1', input: {} }],
    }] } }),
    listAgentTurnsForProjectPage: async (_userId, _projectId, options) => page(turns, options),
    listAgentRunsForTurnPage: async (_userId, _projectId, turnId, options) => page(turnId === 'turn-window' ? [run] : [], options),
    listGenerationJobsForAgentRunPage: async (_userId, _projectId, runId, options) => page(runId === 'run-1' ? [job] : [], options),
    listAgentReviewTasksForRunPage: async (_userId, _projectId, runId, options) => page(runId === 'run-1' ? [review] : [], options),
  }
  const snapshot = await readAgentOutcomeSnapshot({ productStore: store, userId: 'u', projectId: 'p', since: 100, until: 200, now: 700 })
  assert.deepEqual(snapshot.turns.map((item) => item.id), ['turn-window'])
  assert.deepEqual(snapshot.runs.map((item) => item.id), ['run-1'])
  assert.deepEqual(snapshot.jobs.map((item) => item.id), ['job-1'])
  assert.deepEqual(snapshot.reviewTasks.map((item) => item.id), ['review-1'])
  assert.equal(snapshot.manifests[0].fileCount, 1)
  assert.equal(snapshot.manifests[0].files[0].artifactId, 'generation:job-1:output-1')
})

test('Store 缺少稳定分页能力时拒绝生成不完整报告', async () => {
  await assert.rejects(
    readAgentOutcomeSnapshot({ productStore: { readProject() {} }, userId: 'u', projectId: 'p' }),
    (error) => error instanceof AgentOutcomeStoreReadError && error.code === 'AGENT_OUTCOME_STORE_CAPABILITY_MISSING',
  )
})
