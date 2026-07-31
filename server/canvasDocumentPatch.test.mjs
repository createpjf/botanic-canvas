import assert from 'node:assert/strict'
import test from 'node:test'
import { applyCanvasDocumentPatch } from './canvasDocumentPatch.mjs'

const document = {
  id: 'project-1',
  name: '夏日造型',
  schemaVersion: 1,
  updatedAt: 100,
  nodes: [
    { id: 'text-1', type: 'text', position: { x: 10, y: 20 }, data: { content: '原文' } },
    { id: 'generate-1', type: 'generate', position: { x: 300, y: 20 }, data: { prompt: '原提示词' } },
  ],
  edges: [{ id: 'edge-1', source: 'text-1', target: 'generate-1' }],
  assets: [{ id: 'asset-1', name: '连衣裙' }],
}

test('画布补丁仅替换变更节点，同时保留未变更画布内容', () => {
  const next = applyCanvasDocumentPatch(document, {
    nodes: {
      upsert: [{ id: 'text-1', type: 'text', position: { x: 80, y: 120 }, data: { content: '更新后的文案' } }],
    },
    fields: { updatedAt: 200 },
  })

  assert.deepEqual(next.nodes, [
    { id: 'text-1', type: 'text', position: { x: 80, y: 120 }, data: { content: '更新后的文案' } },
    { id: 'generate-1', type: 'generate', position: { x: 300, y: 20 }, data: { prompt: '原提示词' } },
  ])
  assert.deepEqual(next.edges, document.edges)
  assert.deepEqual(next.assets, document.assets)
})

test('画布补丁可删除边，且不会影响节点', () => {
  const next = applyCanvasDocumentPatch(document, {
    edges: { remove: ['edge-1'] },
  })

  assert.deepEqual(next.edges, [])
  assert.deepEqual(next.nodes, document.nodes)
})
