import assert from 'node:assert/strict'
import test from 'node:test'
import { reconcileGenerationResults, retargetGenerationJobForRetry } from './generationResultReconciliation.mjs'

test('单分支重试把原失败占位节点切换到新 Job，不创建平行任务节点', () => {
  const document = {
    nodes: [
      { id: 'generate-a', type: 'generate', data: { jobId: 'job-old', status: 'failed', error: '失败' } },
      { id: 'result-a', type: 'result', data: { outputOf: 'generate-a', jobId: 'job-old', status: 'failed', taskStatus: 'failed', error: '失败' } },
    ],
    generationJobs: [{ id: 'job-old', status: 'failed' }],
  }
  const next = retargetGenerationJobForRetry(document, 'job-old', 'job-new', 100)
  assert.equal(next.changed, true)
  assert.equal(next.document.nodes[0].data.jobId, 'job-new')
  assert.equal(next.document.nodes[1].data.status, 'generating')
  assert.equal(next.document.generationJobs[0].id, 'job-new')
  const reconciled = reconcileGenerationResults(next.document, [{
    id: 'job-new', status: 'succeeded', kind: 'generation', batchCount: 1, createdAt: 100, updatedAt: 120,
    settings: { model: 'gpt-image-2' }, outputs: [{ id: 'output-new', image: '/api/media/new' }],
  }])
  assert.equal(reconciled.changed, true)
  assert.equal(reconciled.document.nodes[1].data.image, '/api/media/new')
})

test('历史成功任务会把空结果节点回填为独立图片节点', () => {
  const document = {
    id: 'project-a', nodes: [
      { id: 'generate-a', type: 'generate', position: { x: 0, y: 0 }, data: { jobId: 'job-a', generationKind: 'refinement' } },
      { id: 'result-a', type: 'result', position: { x: 400, y: 0 }, data: { outputOf: 'generate-a', taskGroupId: 'result-a', taskStatus: 'succeeded', status: 'ready', generationKind: 'refinement' } },
    ], edges: [], generationJobs: [], updatedAt: 1,
  }
  const { document: reconciled, changed } = reconcileGenerationResults(document, [{
    id: 'job-a', status: 'succeeded', kind: 'refinement', batchCount: 2, createdAt: 1, updatedAt: 2,
    settings: { model: 'gpt-image-2' }, outputs: [
      { id: 'output-1', image: '/api/media/one' }, { id: 'output-2', image: '/api/media/two' },
    ],
  }])

  assert.equal(changed, true)
  assert.equal(reconciled.nodes.filter((node) => node.type === 'result').length, 2)
  assert.deepEqual(reconciled.nodes.filter((node) => node.type === 'result').map((node) => node.data.image), ['/api/media/one', '/api/media/two'])
})

test('误标为无结果失败的历史节点仍可由权威任务结果纠正', () => {
  const document = {
    id: 'project-b', nodes: [
      { id: 'generate-b', type: 'generate', position: { x: 0, y: 0 }, data: { jobId: 'job-b', generationKind: 'generation' } },
      { id: 'result-b', type: 'result', position: { x: 400, y: 0 }, data: { outputOf: 'generate-b', taskGroupId: 'result-b', taskStatus: 'failed', status: 'failed', error: '图像服务没有返回结果，请重试。', generationKind: 'generation' } },
    ], edges: [], generationJobs: [], updatedAt: 1,
  }
  const { document: reconciled, changed } = reconcileGenerationResults(document, [{
    id: 'job-b', status: 'succeeded', kind: 'generation', batchCount: 1, createdAt: 1, updatedAt: 2,
    settings: { model: 'gpt-image-2' }, outputs: [{ id: 'output-b', image: '/api/media/b' }],
  }])

  assert.equal(changed, true)
  assert.equal(reconciled.nodes[1].data.image, '/api/media/b')
  assert.equal(reconciled.nodes[1].data.taskStatus, 'succeeded')
})

test('已有候选标识但图片为空时在原节点回填，不创建重复节点', () => {
  const document = {
    id: 'project-c', nodes: [
      { id: 'generate-c', type: 'generate', position: { x: 0, y: 0 }, data: { jobId: 'job-c', generationKind: 'refinement' } },
      {
        id: 'result-c',
        type: 'result',
        position: { x: 400, y: 0 },
        data: {
          outputOf: 'generate-c',
          taskGroupId: 'result-c',
          taskStatus: 'succeeded',
          status: 'ready',
          generationKind: 'refinement',
          jobId: 'job-c',
          candidateId: 'output-c',
        },
      },
    ], edges: [], generationJobs: [], updatedAt: 1,
  }
  const { document: reconciled, changed } = reconcileGenerationResults(document, [{
    id: 'job-c', status: 'succeeded', kind: 'refinement', batchCount: 1, createdAt: 1, updatedAt: 2,
    settings: { model: 'gpt-image-2' }, outputs: [{ id: 'output-c', image: '/api/media/c' }],
  }])

  assert.equal(changed, true)
  assert.equal(reconciled.nodes.length, 2)
  assert.equal(reconciled.nodes[1].id, 'result-c')
  assert.equal(reconciled.nodes[1].data.image, '/api/media/c')
})

test('浏览器断开后完成的 H3 任务会回填视频节点并保留供应商类型', () => {
  const document = {
    id: 'project-video', nodes: [
      { id: 'generate-video', type: 'generate', position: { x: 0, y: 0 }, data: { jobId: 'job-video', generationKind: 'generation' } },
      {
        id: 'result-video',
        type: 'result',
        position: { x: 400, y: 0 },
        data: {
          outputOf: 'generate-video',
          taskGroupId: 'result-video',
          taskStatus: 'failed',
          status: 'failed',
          error: '生成服务没有返回结果，请重试。',
          generationKind: 'generation',
        },
      },
    ], edges: [], generationJobs: [], updatedAt: 1,
  }
  const { document: reconciled, changed } = reconcileGenerationResults(document, [{
    id: 'job-video',
    status: 'succeeded',
    kind: 'generation',
    provider: 'minimax-video',
    batchCount: 1,
    createdAt: 1,
    updatedAt: 2,
    settings: { model: 'MiniMax-H3' },
    outputs: [{ id: 'video-output', image: '/api/media/video', mediaKind: 'video' }],
  }])

  assert.equal(changed, true)
  assert.equal(reconciled.nodes[1].data.image, '/api/media/video')
  assert.equal(reconciled.nodes[1].data.mediaKind, 'video')
  assert.equal(reconciled.generationJobs[0].provider, 'minimax-video')
})
