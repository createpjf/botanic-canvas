import assert from 'node:assert/strict'
import test from 'node:test'
import { collectAgentMediaSources, prepareAgentMediaSources, replaceMediaSources } from './agentMedia.ts'
import type { CanvasDocument } from './canvas.ts'

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

test('媒体替换会同步更新节点、配方和素材记录', () => {
  const next = replaceMediaSources(documentFixture(), {
    '/assets/result.webp': '/api/media/media_result',
    '/assets/model.webp': '/api/media/media_model',
  })
  const node = next.nodes[0]
  assert.equal(node.type === 'result' ? node.data.image : undefined, '/api/media/media_result')
  assert.equal(node.type === 'result' ? node.data.rootRecipe?.references[0].image : undefined, '/api/media/media_model')
})
