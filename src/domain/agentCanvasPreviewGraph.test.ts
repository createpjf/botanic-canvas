import assert from 'node:assert/strict'
import test from 'node:test'
import { projectFrozenCanvasPreview } from './agentCanvasPreviewGraph.ts'

const summary = { created: 1, updated: 1, removed: 0, connected: 1 }
test('冻结 Preview 确定性投影连接与移动轨迹', () => {
  const preview = {
    context: [{ id: 'asset', type: 'asset', label: '商品', position: { x: 0, y: 0 } }],
    created: [{ id: 'generate', type: 'generate', label: '生成', position: { x: 600, y: 100 } }],
    updated: [{ before: { id: 'text', type: 'text', label: '文案', position: { x: 20, y: 300 } }, after: { id: 'text', type: 'text', label: '文案', position: { x: 400, y: 300 } } }],
    removed: [], connections: [{ id: 'edge', sourceNodeId: 'asset', targetNodeId: 'generate', role: 'reference' }], summary,
  }
  const first = projectFrozenCanvasPreview(preview)
  assert.deepEqual(projectFrozenCanvasPreview(preview), first)
  assert.deepEqual(first?.lines.map((line) => [line.id, line.kind]), [['edge', 'connection'], ['move:text', 'movement']])
  assert.ok(first?.points.every((point) => point.x >= 22 && point.x <= 298 && point.y >= 22 && point.y <= 146))
})

test('冻结 Preview 没有有效坐标时只保留语义列表', () => {
  assert.equal(projectFrozenCanvasPreview({ context: [], created: [], updated: [], removed: [], connections: [], summary: { created: 0, updated: 0, removed: 0, connected: 0 } }), null)
})
