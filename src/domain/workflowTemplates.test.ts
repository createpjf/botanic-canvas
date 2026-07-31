import assert from 'node:assert/strict'
import test from 'node:test'
import type { CanvasNode } from './canvas.ts'
import { summarizeWorkflowTemplate } from './workflowTemplates.ts'

const privateAsset = { id: 'asset', type: 'asset', position: { x: 0, y: 0 }, data: { kind: 'asset', assetId: 'private', role: '商品', name: '私有商品', image: '/item.png', source: 'upload' } } as CanvasNode
const generate = { id: 'generate', type: 'generate', position: { x: 200, y: 0 }, data: { kind: 'generate', label: '图片生成', prompt: '柔和自然光', batchCount: 2, settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' } } } as CanvasNode

test('模板摘要保留 prompt、生成参数、节点和连线', () => {
  const summary = summarizeWorkflowTemplate([privateAsset, generate], [{ id: 'edge', source: 'asset', target: 'generate' }])
  assert.deepEqual(summary, {
    nodeCount: 2,
    edgeCount: 1,
    promptCount: 1,
    privateAssetCount: 1,
    imageWorkflowCount: 1,
    videoWorkflowCount: 0,
    settings: ['gpt-image-2 · 3:4 · 2K'],
    canSave: true,
  })
})

test('共享模板过滤私有素材及其连线，但保留生成设置', () => {
  const summary = summarizeWorkflowTemplate([privateAsset, generate], [{ id: 'edge', source: 'asset', target: 'generate' }], true)
  assert.equal(summary.nodeCount, 1)
  assert.equal(summary.edgeCount, 0)
  assert.equal(summary.privateAssetCount, 1)
  assert.equal(summary.settings[0], 'gpt-image-2 · 3:4 · 2K')
})

test('只有结果节点的画布不能保存为空模板', () => {
  const result = { id: 'result', type: 'result', position: { x: 0, y: 0 }, data: { kind: 'result', status: 'ready', image: '/result.png' } } as CanvasNode
  assert.equal(summarizeWorkflowTemplate([result], []).canSave, false)
})
