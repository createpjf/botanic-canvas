import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateAgentRunFixtures } from './agentQualityEvaluation.mjs'

test('固定评测集计算成功、等待、恢复、重复提交与回填完整性', () => {
  const report = evaluateAgentRunFixtures([
    { id: 'ok', status: 'completed', createdAt: 0, firstProgressAt: 100, updatedAt: 500, recovered: false, logicalSubmissions: 1, createdJobs: 1, expectedOutputs: 2, artifactCount: 2, writebackComplete: true },
    { id: 'recovered', status: 'completed', createdAt: 0, firstProgressAt: 300, updatedAt: 900, recovered: true, logicalSubmissions: 2, createdJobs: 1, expectedOutputs: 1, artifactCount: 1, writebackComplete: true },
    { id: 'failed', status: 'failed', createdAt: 0, firstProgressAt: 200, updatedAt: 600, recovered: false, logicalSubmissions: 1, createdJobs: 2, expectedOutputs: 1, artifactCount: 0, writebackComplete: false },
  ])

  assert.deepEqual(report, {
    sampleCount: 3,
    successRate: 2 / 3,
    medianWaitMs: 200,
    recoveryRate: 1,
    duplicateSubmissionRate: 1 / 4,
    resultWritebackCompleteness: 2 / 3,
  })
})

test('空评测集返回零值且不调用任何 Provider', () => {
  assert.deepEqual(evaluateAgentRunFixtures([]), {
    sampleCount: 0, successRate: 0, medianWaitMs: 0, recoveryRate: 0,
    duplicateSubmissionRate: 0, resultWritebackCompleteness: 0,
  })
})
