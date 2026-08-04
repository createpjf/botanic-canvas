import assert from 'node:assert/strict'
import test from 'node:test'
import type { CanvasNode } from './canvas.ts'
import { findUnknownSubmissionAnchor } from './generationRecovery.ts'

test('刷新后从画布选出最新的提交未知任务与原幂等键', () => {
  const nodes = [
    {
      id: 'generate-old', type: 'generate', position: { x: 0, y: 0 },
      data: { kind: 'generate', label: '旧任务', prompt: '', batchCount: 1, settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' }, submissionKey: 'old-key' },
    },
    {
      id: 'result-old', type: 'result', position: { x: 0, y: 0 },
      data: { kind: 'result', outputOf: 'generate-old', status: 'generating', taskStatus: 'submission_unknown', submittedAt: 10, taskGroupId: 'result-old' },
    },
    {
      id: 'generate-new', type: 'generate', position: { x: 0, y: 0 },
      data: { kind: 'generate', label: '新任务', prompt: '', batchCount: 2, settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' }, submissionKey: 'generate-key' },
    },
    {
      id: 'result-new', type: 'result', position: { x: 0, y: 0 },
      data: { kind: 'result', outputOf: 'generate-new', status: 'generating', taskStatus: 'submission_unknown', submittedAt: 20, taskGroupId: 'result-new', submissionKey: 'result-key' },
    },
    {
      id: 'result-new-2', type: 'result', position: { x: 0, y: 0 },
      data: { kind: 'result', outputOf: 'generate-new', status: 'generating', taskStatus: 'submission_unknown', submittedAt: 20, taskGroupId: 'result-new', submissionKey: 'result-key' },
    },
  ] as CanvasNode[]

  const anchor = findUnknownSubmissionAnchor(nodes)
  assert.equal(anchor?.generateNode.id, 'generate-new')
  assert.equal(anchor?.resultNode.id, 'result-new')
  assert.equal(anchor?.submissionKey, 'result-key')
  assert.deepEqual(anchor?.resultNodeIds, ['result-new', 'result-new-2'])
})

test('缺少恢复键或生成节点时不伪造可恢复任务', () => {
  assert.equal(findUnknownSubmissionAnchor([{
    id: 'result-orphan', type: 'result', position: { x: 0, y: 0 },
    data: { kind: 'result', outputOf: 'missing', status: 'generating', taskStatus: 'submission_unknown', submittedAt: 20 },
  } as CanvasNode]), undefined)
})
