import assert from 'node:assert/strict'
import test from 'node:test'
import { applyCanvasActionSet, prepareCanvasActionSetProposal } from './canvasAgentActionSet.mjs'
import { queryCanvasForAgent } from './canvasAgentQuery.mjs'

const models = []
function document() {
  return { id: 'frame-project', updatedAt: 1, nodes: [
    { id: 'text-1', type: 'text', position: { x: 20, y: 30 }, data: { kind: 'text', label: '文案', content: '春季上新' } },
  ], edges: [], generationJobs: [] }
}

test('Frame 原子创建并组织成员，删除后成员与绝对坐标保留', () => {
  const base = document()
  const proposal = prepareCanvasActionSetProposal(base, { operations: [
    { kind: 'create_frame', temporaryId: 'review-lane', position: { x: 0, y: 0 }, label: '审阅阶段', stage: 'review', width: 900, height: 520 },
    { kind: 'organize_nodes', placements: [{ nodeId: 'text-1', position: { x: 80, y: 120 }, frameId: 'review-lane' }] },
  ] }, models, 'frame-create')
  const applied = applyCanvasActionSet(base, { actionId: 'frame-create', ...proposal.arguments }, models, 10)
  const frameId = applied.createdNodeIds[0]
  assert.equal(applied.document.nodes.find((node) => node.id === 'text-1').data.frameId, frameId)
  assert.deepEqual(applied.document.nodes.find((node) => node.id === 'text-1').position, { x: 80, y: 120 })
  const query = queryCanvasForAgent(applied.document, { types: ['frame'], stages: ['review'] })
  assert.deepEqual(query.nodes[0].bounds, { x: 0, y: 0, width: 900, height: 520 })

  const remove = prepareCanvasActionSetProposal(applied.document, { operations: [{ kind: 'delete_nodes', nodeIds: [frameId] }] }, models, 'frame-remove')
  assert.deepEqual(remove.preview.summary, { created: 0, updated: 1, removed: 1, connected: 0 })
  const removed = applyCanvasActionSet(applied.document, { actionId: 'frame-remove', ...remove.arguments }, models, 20)
  const member = removed.document.nodes.find((node) => node.id === 'text-1')
  assert.ok(member)
  assert.equal(member.data.frameId, undefined)
  assert.deepEqual(member.position, { x: 80, y: 120 })
})

test('Frame 不能加入另一个 Frame', () => {
  const base = { ...document(), nodes: [
    ...document().nodes,
    { id: 'frame-a', type: 'frame', position: { x: 0, y: 0 }, data: { kind: 'frame', label: 'A', stage: 'custom', width: 400, height: 300 } },
    { id: 'frame-b', type: 'frame', position: { x: 500, y: 0 }, data: { kind: 'frame', label: 'B', stage: 'custom', width: 400, height: 300 } },
  ] }
  assert.throws(() => prepareCanvasActionSetProposal(base, { operations: [
    { kind: 'organize_nodes', placements: [{ nodeId: 'frame-a', position: { x: 40, y: 40 }, frameId: 'frame-b' }] },
  ] }, models, 'frame-nesting'), (error) => error.code === 'CANVAS_FRAME_NESTING_NOT_ALLOWED')
})
