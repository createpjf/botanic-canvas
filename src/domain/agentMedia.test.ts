import assert from 'node:assert/strict'
import test from 'node:test'
import { collectAgentMediaSources, collectAgentVisionMediaSources, prepareAgentMediaSources, replaceMediaSources, resolveAgentResultImage } from './agentMedia.ts'
import type { CanvasDocument, ResultNodeData } from './canvas.ts'

function documentFixture(): CanvasDocument {
  return {
    schemaVersion: 25,
    id: 'project-1',
    name: '测试项目',
    nodes: [{
      id: 'result-1',
      type: 'result',
      position: { x: 0, y: 0 },
      data: {
        kind: 'result',
        status: 'ready',
        image: '/assets/result.webp',
        rootRecipe: {
          prompt: '测试',
          batchCount: 1,
          settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' },
          references: [{ nodeId: 'asset-node-1', assetId: 'asset-1', name: '模特', image: '/assets/model.webp', role: '模特', primary: true, priority: 1 }],
        },
      },
    }],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    assets: [{ id: 'scene-1', name: '场景', role: '场景', image: '/api/media/media_scene', source: 'upload', tags: [] }],
    assetGroups: [{ id: 'scene-group', name: '场景组', role: '场景', assetIds: ['scene-1'] }],
    templates: [], history: [], deliveries: [], generationJobs: [], batchVariationRuns: [],
    agentRuns: [], agentSessions: [], agentMemory: [], updatedAt: 1,
  }
}

test('Agent 执行前找出结果图、原始参考与批量素材', () => {
  assert.deepEqual(collectAgentMediaSources(documentFixture(), 'result-1', 'scene-group'), [
    '/assets/result.webp',
    '/assets/model.webp',
    '/api/media/media_scene',
  ])
})

test('节点缩略图缺失时只恢复原 Job 的确切输出，不借用旁图或已移除结果', () => {
  const document = documentFixture()
  const data = document.nodes[0].data as ResultNodeData
  data.image = ''
  data.jobId = 'job-original'
  data.candidateId = 'output-original'
  document.generationJobs = [{
    id: 'job-original', resultNodeId: 'result-1', status: 'succeeded', kind: 'initial',
    createdAt: 1, updatedAt: 2, batchCount: 2, outputCount: 2, provider: 'mock', model: 'gpt-image-2',
    outputs: [{ id: 'side-image', image: '/api/media/media_side' }, { id: 'output-original', image: '/api/media/media_original' }],
  }]
  assert.equal(resolveAgentResultImage(document, 'result-1'), '/api/media/media_original')
  assert.equal(collectAgentMediaSources(document, 'result-1')[0], '/api/media/media_original')
  assert.deepEqual(collectAgentVisionMediaSources(document, ['result-1']), ['/api/media/media_original'])
  document.generationJobs[0].dismissedOutputIds = ['output-original']
  assert.equal(resolveAgentResultImage(document, 'result-1'), undefined)
  document.generationJobs[0].dismissedOutputIds = []
  data.candidateId = undefined
  assert.equal(resolveAgentResultImage(document, 'result-1'), undefined, '多图缺候选身份不能猜第一张')
  document.generationJobs[0].outputs = [{ id: 'output-original', image: '/api/media/media_original' }]
  assert.equal(resolveAgentResultImage(document, 'result-1'), '/api/media/media_original')
  data.jobId = 'missing-job'
  assert.equal(resolveAgentResultImage(document, 'result-1'), undefined, '已有 jobId 不能退回别的任务')
  document.nodes = []
  assert.equal(resolveAgentResultImage(document, 'result-1'), undefined, '历史 Job 不复活已删节点')
})

test('看图只收集当前引用的图片节点，跳过视频', () => {
  const document = documentFixture()
  document.nodes.push(
    {
      id: 'asset-ref',
      type: 'asset',
      position: { x: 0, y: 0 },
      data: { kind: 'asset', assetId: 'asset-ref', name: '参考', role: '场景', image: 'data:image/png;base64,QUJD', mediaKind: 'image' },
    },
    {
      id: 'asset-video',
      type: 'asset',
      position: { x: 0, y: 0 },
      data: { kind: 'asset', assetId: 'asset-video', name: '视频', role: '场景', image: '/api/media/media_video', mediaKind: 'video' },
    },
  )
  assert.deepEqual(collectAgentVisionMediaSources(document, ['asset-ref', 'asset-video', 'result-1', 'missing']), [
    '/assets/result.webp',
    'data:image/png;base64,QUJD',
  ])
})

test('只把未受控图片存入媒体库并返回替换表', async () => {
  const persisted: string[] = []
  const replacements = await prepareAgentMediaSources([
    '/assets/result.webp',
    '/api/media/media_existing',
    '/assets/result.webp',
  ], async (source) => {
    persisted.push(source)
    return '/api/media/media_result'
  })

  assert.deepEqual(persisted, ['/assets/result.webp'])
  assert.deepEqual(replacements, { '/assets/result.webp': '/api/media/media_result' })
})

test('视觉素材入库失败时向上抛错，不能让 Agent 在缺图时继续', async () => {
  await assert.rejects(
    prepareAgentMediaSources(['/assets/result.webp'], async () => { throw new Error('上传失败') }),
    /上传失败/,
  )
})

test('媒体替换会同步更新节点、配方和素材记录', () => {
  const next = replaceMediaSources(documentFixture(), {
    '/assets/result.webp': '/api/media/media_result',
    '/assets/model.webp': '/api/media/media_model',
  })
  const node = next.nodes[0]
  assert.equal(node.type === 'result' ? node.data.image : undefined, '/api/media/media_result')
  assert.equal(node.type === 'result' ? node.data.rootRecipe?.references[0].image : undefined, '/api/media/media_model')
})
