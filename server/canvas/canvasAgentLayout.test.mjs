import assert from 'node:assert/strict'
import test from 'node:test'
import { layoutCanvasAgentNodes } from './canvasAgentLayout.mjs'

function node(id, type, x, y) {
  return { id, type, position: { x, y }, data: type === 'text' ? { kind: 'text', label: id, content: id } : { kind: 'generate', label: id, settings: {} } }
}
function positions(placements) { return Object.fromEntries(placements.map((item) => [item.nodeId, item.position])) }

test('声明式 row/grid/workflow 布局按稳定顺序生成不重叠绝对坐标', () => {
  const document = {
    nodes: [node('a', 'text', 20, 10), node('b', 'generate', 0, 30), node('c', 'text', 10, 50)],
    edges: [{ id: 'a-b', source: 'a', target: 'b' }, { id: 'b-c', source: 'b', target: 'c' }],
  }
  const row = positions(layoutCanvasAgentNodes(document, { nodeIds: ['a', 'b', 'c'], mode: 'row', anchor: { x: 100, y: 80 }, gap: 40 }))
  assert.deepEqual(row, { a: { x: 100, y: 80 }, b: { x: 376, y: 80 }, c: { x: 776, y: 80 } })
  const grid = positions(layoutCanvasAgentNodes(document, { nodeIds: ['a', 'b', 'c'], mode: 'grid', anchor: { x: 0, y: 0 }, gap: 20, columns: 2 }))
  assert.deepEqual(grid, { a: { x: 0, y: 0 }, b: { x: 256, y: 0 }, c: { x: 0, y: 178 } })
  const workflow = positions(layoutCanvasAgentNodes(document, { nodeIds: ['a', 'b', 'c'], mode: 'workflow', anchor: { x: 10, y: 20 }, gap: 30 }))
  assert.ok(workflow.a.x < workflow.b.x && workflow.b.x < workflow.c.x)
  assert.deepEqual(layoutCanvasAgentNodes(document, { nodeIds: ['a', 'b', 'c'], mode: 'workflow', anchor: { x: 10, y: 20 }, gap: 30 }), layoutCanvasAgentNodes(document, { nodeIds: ['a', 'b', 'c'], mode: 'workflow', anchor: { x: 10, y: 20 }, gap: 30 }))
  const selected = { ...document, nodes: document.nodes.map((item) => item.id === 'b' ? { ...item, selected: true } : item) }
  assert.deepEqual(layoutCanvasAgentNodes(selected, { nodeIds: ['a', 'b', 'c'], mode: 'column', anchor: { x: 0, y: 0 } }), layoutCanvasAgentNodes(document, { nodeIds: ['a', 'b', 'c'], mode: 'column', anchor: { x: 0, y: 0 } }))
})

test('声明式布局拒绝重复节点与不足三个节点的分布请求', () => {
  const document = { nodes: [node('a', 'text', 0, 0), node('b', 'text', 10, 10)], edges: [] }
  assert.throws(() => layoutCanvasAgentNodes(document, { nodeIds: ['a', 'a'], mode: 'row' }), (error) => error.code === 'CANVAS_LAYOUT_INVALID')
  assert.throws(() => layoutCanvasAgentNodes(document, { nodeIds: ['a', 'b'], mode: 'distribute_horizontal' }), (error) => error.code === 'CANVAS_LAYOUT_INVALID')
})
