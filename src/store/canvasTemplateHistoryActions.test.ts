import assert from 'node:assert/strict'
import test from 'node:test'
import type { AssetRecord, CanvasSnapshot } from '../domain/canvas.ts'
import { cloneTemplateSnapshot, projectAssetsForTemplate } from './canvasTemplateHistoryModel.ts'

const snapshot: CanvasSnapshot = {
    name: '商品模板',
    nodes: [
      { id: 'asset-node', type: 'asset', position: { x: 0, y: 0 }, data: { kind: 'asset', assetId: 'asset-kept', name: '商品', image: '/asset.webp', role: '商品', source: 'upload' } },
      { id: 'prompt-node', type: 'prompt', position: { x: 300, y: 0 }, data: { kind: 'prompt', label: '描述', content: '自然光' } },
    ],
    edges: [{ id: 'edge-old', source: 'asset-node', target: 'prompt-node' }],
    viewport: { x: 12, y: 8, zoom: 0.8 },
}

const assets: AssetRecord[] = [
      { id: 'asset-kept', name: '保留', image: '/asset.webp', tags: ['商品'], source: 'upload', role: '商品', createdAt: 1 },
      { id: 'asset-unused', name: '不保留', image: '/unused.webp', tags: [], source: 'upload', role: '灵感', createdAt: 2 },
]

test('项目模板命令克隆图谱，只携带模板实际引用的项目素材', () => {
  const cloned = cloneTemplateSnapshot(snapshot, 'template', 42)
  const projectAssets = projectAssetsForTemplate(assets, cloned.nodes, false)

  assert.equal(cloned.nodes.length, 2)
  assert.notEqual(cloned.nodes[0].id, 'asset-node')
  assert.equal(cloned.edges[0].source, cloned.nodes[0].id)
  assert.equal(cloned.edges[0].target, cloned.nodes[1].id)
  assert.deepEqual(projectAssets.map((asset) => asset.id), ['asset-kept'])
})

test('共享模板实例不携带原项目私有素材', () => {
  const cloned = cloneTemplateSnapshot(snapshot, 'shared-template', 42)
  assert.deepEqual(projectAssetsForTemplate(assets, cloned.nodes, true), [])
})
