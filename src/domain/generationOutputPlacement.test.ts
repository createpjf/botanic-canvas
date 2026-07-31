import assert from 'node:assert/strict'
import test from 'node:test'
import { planGenerationOutputPlacement } from './generationOutputPlacement.ts'

test('已有候选标识但图片为空时复用原结果节点', () => {
  const placements = planGenerationOutputPlacement({
    jobId: 'job-a',
    outputIds: ['output-1'],
    resultNodes: [{
      id: 'result-a',
      jobId: 'job-a',
      candidateId: 'output-1',
      hasImage: false,
    }],
    reusableTaskNodeIds: [],
  })

  assert.deepEqual(placements, [{
    outputId: 'output-1',
    nodeId: 'result-a',
    action: 'replace',
  }])
})

test('保留已完成候选，并依次复用普通占位节点后再创建新节点', () => {
  const placements = planGenerationOutputPlacement({
    jobId: 'job-b',
    outputIds: ['output-1', 'output-2', 'output-3'],
    resultNodes: [{
      id: 'result-complete',
      jobId: 'job-b',
      candidateId: 'output-1',
      hasImage: true,
    }],
    reusableTaskNodeIds: ['result-placeholder'],
  })

  assert.deepEqual(placements, [
    { outputId: 'output-1', nodeId: 'result-complete', action: 'keep' },
    { outputId: 'output-2', nodeId: 'result-placeholder', action: 'replace' },
    { outputId: 'output-3', action: 'create' },
  ])
})
