import assert from 'node:assert/strict'
import test from 'node:test'
import * as Y from 'yjs'
import { createCanvasCollaborationRoom } from './canvasCollaborationRoom.mjs'

function encodedNodeUpdate(id, x) {
  const document = new Y.Doc()
  document.getMap('nodes').set(id, {
    order: 0,
    value: { id, type: 'text', position: { x, y: 20 }, data: { kind: 'text', label: id, content: id } },
  })
  return Buffer.from(Y.encodeStateAsUpdate(document)).toString('base64')
}

test('Yjs 房间持久化增量，重建后可恢复图谱和 CRDT 状态', async () => {
  const persisted = {
    graph: { nodes: [], edges: [] },
    graphRevision: 1,
    updates: [],
  }
  const append = async ({ update, graph }) => {
    persisted.updates.push(update)
    persisted.graph = structuredClone(graph)
    persisted.graphRevision += 1
    return { graphRevision: persisted.graphRevision, updateCount: persisted.updates.length }
  }
  const compact = async ({ snapshot, graph }) => {
    persisted.snapshot = snapshot
    persisted.updates = []
    persisted.graph = structuredClone(graph)
  }

  const room = createCanvasCollaborationRoom({ state: persisted, append, compact, compactEvery: 2 })
  const first = await room.applyUpdate(encodedNodeUpdate('node-a', 120))
  assert.equal(first.applied, true)
  assert.equal(first.graph.nodes[0].position.x, 120)
  await room.applyUpdate(encodedNodeUpdate('node-b', 280))
  assert.ok(persisted.snapshot)
  assert.deepEqual(persisted.updates, [])

  const recovered = createCanvasCollaborationRoom({ state: persisted, append, compact, compactEvery: 2 })
  assert.deepEqual(recovered.graph().nodes.map((node) => node.id), ['node-a', 'node-b'])
  const recoveredDocument = new Y.Doc()
  Y.applyUpdate(recoveredDocument, Buffer.from(recovered.stateUpdate(), 'base64'))
  assert.deepEqual([...recoveredDocument.getMap('nodes').keys()].sort(), ['node-a', 'node-b'])
  room.destroy()
  recovered.destroy()
})

test('HTTP 权威图谱替换会同步 Yjs 快照，旧增量不会在重连后回放', async () => {
  const persisted = {
    graph: { nodes: [], edges: [] },
    graphRevision: 1,
    updates: [],
  }
  const append = async ({ update, graph }) => {
    persisted.updates.push(update)
    persisted.graph = structuredClone(graph)
    persisted.graphRevision += 1
    return { graphRevision: persisted.graphRevision, updateCount: persisted.updates.length }
  }
  const compact = async ({ snapshot, graph }) => {
    persisted.snapshot = snapshot
    persisted.updates = []
    persisted.graph = structuredClone(graph)
  }
  const room = createCanvasCollaborationRoom({ state: persisted, append, compact })
  await room.applyUpdate(encodedNodeUpdate('node-a', 120), 'editor-1')
  await room.replaceBaseGraph({
    nodes: [
      { id: 'node-a', type: 'text', position: { x: 400, y: 20 }, data: { kind: 'text', label: 'A', content: 'A' } },
      { id: 'node-b', type: 'result', position: { x: 640, y: 20 }, data: { kind: 'result', label: 'B', image: 'data:image/png;base64,secret' } },
    ],
    edges: [],
  }, 'editor-1')

  assert.ok(persisted.snapshot)
  assert.deepEqual(persisted.updates, [])
  assert.equal(persisted.graph.nodes[0].position.x, 400)

  const recovered = createCanvasCollaborationRoom({ state: persisted, append, compact })
  const recoveredDocument = new Y.Doc()
  Y.applyUpdate(recoveredDocument, Buffer.from(recovered.stateUpdate(), 'base64'))
  const nodeA = recoveredDocument.getMap('nodes').get('node-a')
  const nodeB = recoveredDocument.getMap('nodes').get('node-b')
  assert.equal(nodeA.value.position.x, 400)
  assert.equal(nodeB.value.data.image, undefined)
  room.destroy()
  recovered.destroy()
})
