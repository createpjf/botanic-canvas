import assert from 'node:assert/strict'
import test from 'node:test'
import type { CanvasDocument, GenerationRecipe } from '../domain/canvas.ts'
import { hydrateAssetNodeImages, scrubAssetFromDocument, sharedWorkflowTemplateSnapshot, workflowTemplateSnapshot } from './canvasDocumentAssets.ts'

const recipe: GenerationRecipe = {
  prompt: '测试',
  batchCount: 1,
  settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
  primaryReferenceNodeId: 'asset-node',
  references: [{ nodeId: 'asset-node', assetId: 'asset-a', name: '商品', image: '/a.webp', role: '商品', source: 'upload', primary: true, priority: 1 }],
}

function document(): CanvasDocument {
  const nodes: CanvasDocument['nodes'] = [
    { id: 'asset-node', type: 'asset', position: { x: 0, y: 0 }, data: { kind: 'asset', assetId: 'asset-a', name: '商品', image: '/a.webp', role: '商品', source: 'upload' } },
    { id: 'generate-node', type: 'generate', position: { x: 300, y: 0 }, data: { kind: 'generate', label: '生成', prompt: '', batchCount: 1, settings: recipe.settings, inputOrder: ['asset-node'], primaryInputId: 'asset-node' } },
    { id: 'result-node', type: 'result', position: { x: 700, y: 0 }, data: { kind: 'result', label: '结果', status: 'ready', image: '/result.webp', generationRecipe: recipe } },
  ]
  return {
    id: 'project-a', name: '项目', schemaVersion: 25, nodes,
    edges: [{ id: 'asset-generate', source: 'asset-node', target: 'generate-node' }],
    viewport: { x: 0, y: 0, zoom: 1 },
    assets: [{ id: 'asset-a', name: '商品', image: '/a.webp', role: '商品', source: 'upload', tags: [] }],
    assetGroups: [{ id: 'group-a', name: '商品', role: '商品', assetIds: ['asset-a'] }],
    templates: [],
    history: [{ id: 'history-a', name: '历史', image: '/result.webp', createdAt: 1, snapshot: { name: '历史', nodes, edges: [], viewport: { x: 0, y: 0, zoom: 1 } }, generationRecipe: recipe }],
    deliveries: [], generationJobs: [], batchVariationRuns: [], agentSessions: [], agentMemory: [], agentRuns: [], updatedAt: 1,
  }
}

test('撤销素材会清理后续引用但保留历史条目和视觉结果', () => {
  const scrubbed = scrubAssetFromDocument(document(), 'asset-a')

  assert.equal(scrubbed.assets.length, 0)
  assert.equal(scrubbed.nodes.some((node) => node.id === 'asset-node'), false)
  assert.equal(scrubbed.nodes.some((node) => node.id === 'result-node'), true)
  assert.equal(scrubbed.history.length, 1)
  assert.equal(scrubbed.history[0].generationRecipe?.references.length, 0)
})

test('媒体占位节点从权威项目素材元数据恢复图片', () => {
  const current = document()
  const placeholder = current.nodes.map((node) => node.id === 'asset-node'
    ? { ...node, data: { ...node.data, image: undefined } }
    : node) as CanvasDocument['nodes']
  const hydrated = hydrateAssetNodeImages(placeholder, current, [])

  assert.equal(hydrated.find((node) => node.id === 'asset-node')?.data.image, '/a.webp')
})

test('共享工作流模板排除项目私有素材及其连线', () => {
  const result = sharedWorkflowTemplateSnapshot(document(), '共享模板')

  assert.equal(result.omittedPrivateAssetCount, 1)
  assert.equal(result.snapshot.nodes.some((node) => node.id === 'asset-node'), false)
  assert.equal(result.snapshot.edges.some((edge) => edge.source === 'asset-node'), false)
})

test('工作流模板只保留稳定输入和生成模型元数据', () => {
  const template = workflowTemplateSnapshot(document(), '模板 01')
  const generate = template.nodes.find((node) => node.type === 'generate')

  assert.deepEqual(template.nodes.map((node) => node.type), ['asset', 'generate'])
  assert.equal(generate?.data.kind, 'generate')
  assert.equal(generate?.data.settings.model, 'gpt-image-2')
  assert.equal(generate?.data.status, undefined)
  assert.equal(generate?.data.jobId, undefined)
})
