import assert from 'node:assert/strict'
import test from 'node:test'
import type { CanvasDocument } from './canvas.ts'
import { canvasJsonEqual, createCanvasDocumentPatch } from './canvasDocumentPatch.ts'

const original = {
  id: 'project', name: '原项目', updatedAt: 1,
  nodes: [{ id: 'original', type: 'text', position: { x: 0, y: 0 }, data: { label: '原图', content: '保留' } }],
  edges: [], productionWorkflows: [], productionWorkflowRuns: [],
} as unknown as CanvasDocument

test('节点本机测量和选中不产生 HTTP PATCH，真实尺寸仍提交', () => {
  const measured = {...original.nodes[0], measured:{width:240,height:100}, selected:true, dragging:false}
  assert.deepEqual(createCanvasDocumentPatch(original, {...original,nodes:[measured]}), {})
  const resized = {...measured,width:300,height:120}
  assert.deepEqual(createCanvasDocumentPatch(original, {...original,nodes:[resized]}).nodes?.upsert, [{...original.nodes[0],width:300,height:120}])
})

test('只发送真实修改；V2 图谱和工作流集合不进入文档 PATCH', () => {
  const next = { ...original, name: '新标题', updatedAt: 2, nodes: [], productionWorkflows: [{ id: 'workflow' }] } as CanvasDocument
  assert.deepEqual(createCanvasDocumentPatch(original, next), { fields: { name: '新标题', updatedAt: 2 }, nodes: { remove: ['original'] } })
  assert.deepEqual(createCanvasDocumentPatch(original, next, false), { fields: { name: '新标题', updatedAt: 2 } })
  assert.deepEqual(createCanvasDocumentPatch(original, { ...next, name: original.name }, false), {})
})

test('JSON 对象键序可忽略，数组顺序、删除和真实内容变化不可忽略', () => {
  assert.equal(canvasJsonEqual({ a: 1, b: undefined }, { a: 1 }), true)
  assert.equal(canvasJsonEqual([{ a: 1, b: 2 }], [{ b: 2, a: 1 }]), true)
  assert.equal(canvasJsonEqual([1, 2], [2, 1]), false)
  assert.equal(canvasJsonEqual({ a: 1 }, {}), false)
  const changed = { ...original.nodes[0], data: { ...original.nodes[0].data, content: '真实编辑' } }
  assert.deepEqual(createCanvasDocumentPatch(original, { ...original, nodes: [changed] }).nodes, { upsert: [changed] })
})
