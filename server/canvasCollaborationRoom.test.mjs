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

test('房间重建时以物化图谱覆盖过期的 Yjs 增量', () => {
  const room = createCanvasCollaborationRoom({
    state: {
      graph: {
        nodes: [
          { id: 'node-a', type: 'text', position: { x: 400, y: 20 }, data: { kind: 'text', label: 'new', content: 'new' } },
        ],
        edges: [],
      },
      graphRevision: 3,
      updates: [encodedNodeUpdate('node-a', 120)],
    },
    append: async () => ({ graphRevision: 3, updatedAt: 300, updateCount: 1 }),
    compact: async () => undefined,
  })

  const recovered = new Y.Doc()
  Y.applyUpdate(recovered, Buffer.from(room.stateUpdate(), 'base64'))
  assert.equal(recovered.getMap('nodes').get('node-a').value.position.x, 400)
  room.destroy()
})

test('相同 HTTP 图谱且没有待校准 Yjs 历史时不重复压缩快照', async () => {
  const graph = {
    nodes: [{ id: 'node-a', type: 'text', position: { x: 400, y: 20 }, data: { kind: 'text', label: 'A', content: 'A' } }],
    edges: [],
  }
  let compactCount = 0
  const room = createCanvasCollaborationRoom({
    state: { graph, graphRevision: 3, updates: [] },
    append: async () => ({ graphRevision: 3, updatedAt: 300, updateCount: 0 }),
    compact: async () => { compactCount += 1 },
  })

  const result = await room.replaceBaseGraph(graph, 'editor-1')
  assert.equal(result.changed, false)
  assert.equal(compactCount, 0)
  await room.destroy()
})

test('物化图谱与旧 Yjs 历史不一致时即使图谱未变也执行一次校准', async () => {
  const graph = {
    nodes: [{ id: 'node-a', type: 'text', position: { x: 400, y: 20 }, data: { kind: 'text', label: 'A', content: 'A' } }],
    edges: [],
  }
  let compactCount = 0
  const room = createCanvasCollaborationRoom({
    state: { graph, graphRevision: 3, updates: [encodedNodeUpdate('node-a', 120)] },
    append: async () => ({ graphRevision: 3, updatedAt: 300, updateCount: 1 }),
    compact: async () => { compactCount += 1 },
  })

  const result = await room.replaceBaseGraph(graph, 'editor-1')
  assert.equal(result.changed, false)
  assert.equal(compactCount, 1)
  await room.replaceBaseGraph(graph, 'editor-1')
  assert.equal(compactCount, 1)
  await room.destroy()
})

test('跨实例已持久化增量只更新内存房间，不会重复追加或压缩', async () => {
  let appendCount = 0
  let compactCount = 0
  const room = createCanvasCollaborationRoom({
    state: { graph: { nodes: [], edges: [] }, graphRevision: 1, updates: [] },
    append: async () => {
      appendCount += 1
      return { graphRevision: 2, updatedAt: 200, updateCount: 1 }
    },
    compact: async () => { compactCount += 1 },
  })

  const update = encodedNodeUpdate('node-remote', 240)
  const first = await room.applyPersistedUpdate(update)
  const duplicate = await room.applyPersistedUpdate(update)

  assert.equal(first.applied, true)
  assert.equal(duplicate.applied, false)
  assert.equal(room.graph().nodes[0].id, 'node-remote')
  assert.equal(appendCount, 0)
  assert.equal(compactCount, 0)
  await room.destroy()
})

test('跨实例增量乱序到达时由 Yjs 补偿依赖并保留全部更新', async () => {
  const source = new Y.Doc()
  let vector = Y.encodeStateVector(source)
  source.getMap('nodes').set('node-first', {
    order: 0,
    value: { id: 'node-first', type: 'text', position: { x: 80, y: 20 }, data: { kind: 'text', label: 'first', content: 'first' } },
  })
  const first = Buffer.from(Y.encodeStateAsUpdate(source, vector)).toString('base64')
  vector = Y.encodeStateVector(source)
  source.getMap('nodes').set('node-second', {
    order: 1,
    value: { id: 'node-second', type: 'text', position: { x: 240, y: 20 }, data: { kind: 'text', label: 'second', content: 'second' } },
  })
  const second = Buffer.from(Y.encodeStateAsUpdate(source, vector)).toString('base64')
  const room = createCanvasCollaborationRoom({
    state: { graph: { nodes: [], edges: [] }, graphRevision: 1, updates: [] },
    append: async () => { throw new Error('远端增量不得再次持久化') },
    compact: async () => { throw new Error('远端增量不得再次压缩') },
  })

  await room.applyPersistedUpdate(second)
  await room.applyPersistedUpdate(first)

  assert.deepEqual(room.graph().nodes.map((node) => node.id), ['node-first', 'node-second'])
  await room.destroy()
})
