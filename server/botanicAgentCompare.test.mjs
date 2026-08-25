import assert from 'node:assert/strict'
import test from 'node:test'
import { compareBotanicAgentRunBranches } from './botanicAgentCompare.mjs'

test('比较读模型按分支汇总 Job、结果与评审摘要', () => {
  const value = compareBotanicAgentRunBranches({
    run: { id: 'run-a', projectId: 'project-a', status: 'partial', branches: [
      { id: 'a', label: '海边', status: 'succeeded', attempt: 1, outputCount: 1 },
      { id: 'b', label: '森林', status: 'failed', attempt: 1, outputCount: 0 },
    ] },
    jobs: [{ agentRun: { branchId: 'a' }, outputs: [{ nodeId: 'node-a' }] }],
    reviews: [{ bestNodeId: 'node-a', items: [{ nodeId: 'node-a', verdict: 'pass', note: '稳定' }] }],
  })
  assert.equal(value.branches[0].outputCount, 1)
  assert.deepEqual(value.branches[0].review, { verdict: 'pass', note: '稳定' })
  assert.equal(value.branches[1].status, 'failed')
  assert.equal(value.recommendedBranchId, 'a')
})
