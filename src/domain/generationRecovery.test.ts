import assert from 'node:assert/strict'
import test from 'node:test'
import type { CanvasNode, GenerationJob } from './canvas.ts'
import { findUnknownSubmissionAnchor, matchUnresolvedGenerationTaskJobs } from './generationRecovery.ts'

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

function recoveryResultNode(id: string, data: Record<string, unknown>): CanvasNode {
  return { id, type: 'result', position: { x: 0, y: 0 }, data: { kind: 'result', ...data } } as CanvasNode
}

function succeededJob(id: string, kind: 'generation' | 'refinement', createdAt: number): GenerationJob {
  return {
    id, kind, status: 'succeeded', batchCount: 1, createdAt, updatedAt: createdAt + 10,
    outputs: [{ id: `${id}-out`, image: `media://${id}.webp`, mediaKind: 'image' }],
  } as GenerationJob
}

test('已在画布落图的任务不再作为兜底候选，避免错配后被对账覆写历史节点', () => {
  // 「篡改历史」回归：上游 job-1 已落图，新占位节点若被错配上 job-1，
  // 后续对账会按「任务号 + 候选号」命中旧结果节点，并用占位节点的参数快照覆写它。
  const nodes = [
    recoveryResultNode('r1', {
      outputOf: 'g1', image: 'media://calbee.webp', jobId: 'job-1', candidateId: 'job-1-out',
      taskGroupId: 'r1', generationKind: 'refinement', submittedAt: 1_000,
    }),
    recoveryResultNode('pending', {
      outputOf: 'g2', taskGroupId: 'pending', generationKind: 'refinement', submittedAt: 1_050,
      status: 'generating', taskStatus: 'submission_unknown',
    }),
  ]
  const matches = matchUnresolvedGenerationTaskJobs({ nodes, jobs: [succeededJob('job-1', 'refinement', 1_000)] })
  assert.equal(matches.size, 0)
})

test('已带任务号的占位节点身份明确，不参与时间就近匹配', () => {
  const nodes = [
    recoveryResultNode('pending-known', {
      outputOf: 'g2', jobId: 'job-2', taskGroupId: 'pending-known', generationKind: 'refinement', submittedAt: 2_000,
    }),
  ]
  const matches = matchUnresolvedGenerationTaskJobs({ nodes, jobs: [succeededJob('job-9', 'refinement', 2_010)] })
  assert.equal(matches.size, 0)
})

test('无任务号的占位节点按 kind 与提交时间就近匹配未投影任务，并尊重保留任务号', () => {
  const nodes = [
    recoveryResultNode('pending-a', { outputOf: 'g1', taskGroupId: 'pending-a', generationKind: 'generation', submittedAt: 1_000 }),
    recoveryResultNode('pending-b', { outputOf: 'g2', taskGroupId: 'pending-b', generationKind: 'generation', submittedAt: 5_000 }),
  ]
  const jobs = [
    succeededJob('job-near-a', 'generation', 1_020),
    succeededJob('job-near-b', 'generation', 5_030),
    succeededJob('job-reserved', 'generation', 990),
    succeededJob('job-wrong-kind', 'refinement', 1_000),
  ]
  const matches = matchUnresolvedGenerationTaskJobs({ nodes, jobs, reservedJobIds: ['job-reserved'] })
  assert.equal(matches.get('pending-a')?.id, 'job-near-a')
  assert.equal(matches.get('pending-b')?.id, 'job-near-b')
  assert.equal(matches.size, 2)
})
