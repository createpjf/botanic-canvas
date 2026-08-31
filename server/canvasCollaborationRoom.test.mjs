import assert from 'node:assert/strict'
import test from 'node:test'
import * as Y from 'yjs'
import { createCanvasCollaborationRoom } from './canvasCollaborationRoom.mjs'
import { canvasMutationConflictCode, normalizeCanvasGraphMutation } from './productStoreContract.mjs'

function encodedNodeUpdate(id, x) {
  const document = new Y.Doc()
  document.getMap('nodes').set(id, {
    order: 0,
    value: { id, type: 'text', position: { x, y: 20 }, data: { kind: 'text', label: id, content: id } },
  })
  return Buffer.from(Y.encodeStateAsUpdate(document)).toString('base64')
}

function encodedMediaPlaceholderUpdate(id = 'result-remote') {
  const document = new Y.Doc()
  document.getMap('nodes').set(id, {
    order: 0,
    value: {
      id,
      type: 'result',
      position: { x: 320, y: 20 },
      data: {
        kind: 'result',
        label: '远端候选',
        mediaKind: 'image',
        status: 'generating',
        image: 'data:image/png;base64:top-secret',
        generationRecipe: {
          references: [
            { image: 'data:image/png;base64:deep-secret' },
            { image: '/api/media/stable-reference' },
          ],
          maskImage: 'blob:https://app.example/mask',
          externalImage: 'https://cdn.example.com/external.webp',
        },
      },
    },
  })
  document.getMap('edges').set('edge-media', {
    order: 0,
    value: {
      id: 'edge-media',
      source: id,
      target: id,
      data: {
        payload: 'data:image/png;base64:edge-secret',
        external: 'https://cdn.example.com/edge.png',
        privateMedia: 'media://edge-secret',
        binary: new Uint8Array([1, 2, 3]),
      },
    },
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

test('新媒体节点保留稳定引用，CRDT 与物化图谱都不保存媒体负载', async () => {
  let persistedUpdate
  let persistedGraph
  let graphRevision = 1
  const mutations = new Map()
  const room = createCanvasCollaborationRoom({
    state: { graph: { nodes: [], edges: [] }, graphRevision: 1, updates: [] },
    append: async (payload) => {
      const committed = mutations.get(payload.mutationId)
      if (committed) {
        if (committed.idempotencyUpdate !== (payload.idempotencyUpdate ?? payload.update)) {
          const error = new Error('画布协作提交身份已绑定到其他更新。')
          error.code = 'CANVAS_MUTATION_CONFLICT'
          throw error
        }
        return { ...committed.saved, duplicate: true }
      }
      persistedUpdate = payload.update
      persistedGraph = structuredClone(payload.graph)
      graphRevision += 1
      const saved = { graphRevision, updateCount: 1, duplicate: false }
      mutations.set(payload.mutationId, {
        idempotencyUpdate: payload.idempotencyUpdate ?? payload.update,
        saved: { ...saved, update: payload.update },
      })
      return saved
    },
    compact: async () => undefined,
  })

  const mediaUpdate = encodedMediaPlaceholderUpdate()
  const result = await room.applyUpdate(mediaUpdate, 'editor-1', { mutationId: 'media-placeholder' })
  assert.deepEqual(result.graph.nodes.map((node) => node.id), ['result-remote'])
  assert.deepEqual(result.graph.edges.map((edge) => edge.id), ['edge-media'])
  const document = new Y.Doc()
  Y.applyUpdate(document, Buffer.from(persistedUpdate, 'base64'))
  const serialized = JSON.stringify({
    node: document.getMap('nodes').get('result-remote').value,
    edge: document.getMap('edges').get('edge-media').value,
  })
  assert.equal(serialized.includes('top-secret'), false)
  assert.equal(serialized.includes('deep-secret'), false)
  assert.equal(serialized.includes('blob:https://app.example/mask'), false)
  assert.equal(serialized.includes('https://cdn.example.com/external.webp'), false)
  assert.equal(serialized.includes('edge-secret'), false)
  assert.equal(serialized.includes('https://cdn.example.com/edge.png'), false)
  assert.equal(serialized.includes('/api/media/stable-reference'), true)
  const edgeData = document.getMap('edges').get('edge-media').value.data
  assert.equal(edgeData.payload, undefined)
  assert.equal(edgeData.external, undefined)
  assert.equal(edgeData.privateMedia, undefined)
  assert.equal(edgeData.binary, undefined)
  assert.equal((await room.applyUpdate(mediaUpdate, 'editor-1', { mutationId: 'media-placeholder' })).duplicate, true)

  await room.commitGraphMutation((graph) => ({
    nodes: graph.nodes.map((node) => ({
      ...node,
      data: { ...node.data, image: '/api/media/stable-result', payload: 'data:image/png;base64:server-secret' },
    })),
    edges: graph.edges.map((edge) => ({
      ...edge,
      data: {
        payload: 'data:image/png;base64:server-edge-secret',
        external: 'https://cdn.example.com/server-edge.png',
        privateMedia: 'media://server-edge-secret',
        binary: new Uint8Array([4, 5, 6]),
      },
    })),
  }), 'agent-1', { mutationId: 'server-media' })
  const persistedNode = persistedGraph.nodes.find((node) => node.id === 'result-remote')
  const persistedEdge = persistedGraph.edges.find((edge) => edge.id === 'edge-media')
  assert.equal(persistedNode.data.image, '/api/media/stable-result')
  assert.equal(persistedNode.data.payload, undefined)
  assert.deepEqual(persistedEdge.data, {})
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

test('跨实例 CAS 冲突后重载最新图谱并以同一 mutation 重放', async () => {
  const remoteNode = {
    id: 'node-remote', type: 'text', position: { x: 80, y: 20 },
    data: { kind: 'text', label: 'remote', content: 'remote' },
  }
  let appendCount = 0
  const payloads = []
  const room = createCanvasCollaborationRoom({
    state: { graph: { nodes: [], edges: [] }, graphRevision: 1, updates: [] },
    reload: async () => ({ graph: { nodes: [remoteNode], edges: [] }, graphRevision: 2, updates: [] }),
    append: async (payload) => {
      appendCount += 1
      payloads.push(structuredClone(payload))
      if (appendCount === 1) {
        const error = new Error('stale graph revision')
        error.code = 'CANVAS_GRAPH_CONFLICT'
        throw error
      }
      return { graphRevision: 3, mutationRevision: 3, updatedAt: 300, updateCount: 2, duplicate: false }
    },
    compact: async () => undefined,
  })

  const result = await room.applyUpdate(encodedNodeUpdate('node-local', 240), 'editor-1', { mutationId: 'mutation-local' })

  assert.equal(appendCount, 2)
  assert.equal(payloads[0].expectedGraphRevision, 1)
  assert.equal(payloads[1].expectedGraphRevision, 2)
  assert.equal(payloads[1].mutationId, 'mutation-local')
  assert.deepEqual(result.graph.nodes.map((node) => node.id).sort(), ['node-local', 'node-remote'])
  assert.equal(result.graphRevision, 3)
  await room.destroy()
})

test('服务端 mutation 命中已压缩 duplicate 时不返回未提交候选增量', async () => {
  const durableGraph = {
    nodes: [{
      id: 'node-a', type: 'text', position: { x: 80, y: 20 },
      data: { kind: 'text', label: 'A', content: 'A' },
    }],
    edges: [],
  }
  const room = createCanvasCollaborationRoom({
    state: { graph: durableGraph, graphRevision: 2, updates: [] },
    reload: async () => ({ graph: durableGraph, graphRevision: 2, updates: [] }),
    append: async () => ({ graphRevision: 2, mutationRevision: 2, updateCount: 0, duplicate: true }),
    compact: async () => undefined,
  })

  const result = await room.commitGraphMutation((graph) => ({
    ...graph,
    nodes: [...graph.nodes, {
      id: 'node-b', type: 'text', position: { x: 240, y: 20 },
      data: { kind: 'text', label: 'B', content: 'B' },
    }],
  }), 'editor-1', { mutationId: 'mutation-compacted' })

  assert.equal(result.duplicate, true)
  assert.equal(result.update, undefined)
  assert.deepEqual(result.graph.nodes.map((node) => node.id), ['node-a'])
  await room.destroy()
})

test('持久化与重载同时失败后拒绝继续写，恢复后先重载权威状态', async () => {
  let reloadAvailable = false
  let appendCount = 0
  let durableGraph = { nodes: [], edges: [] }
  const room = createCanvasCollaborationRoom({
    state: { graph: durableGraph, graphRevision: 1, updates: [] },
    reload: async () => {
      if (!reloadAvailable) throw new Error('reload unavailable')
      return { graph: structuredClone(durableGraph), graphRevision: 1, updates: [] }
    },
    append: async (payload) => {
      appendCount += 1
      if (appendCount === 1) throw new Error('storage unavailable')
      durableGraph = structuredClone(payload.graph)
      return { graphRevision: 2, updateCount: 1, duplicate: false }
    },
    compact: async () => undefined,
  })

  await assert.rejects(room.applyUpdate(encodedNodeUpdate('node-rejected', 80), 'editor-1', { mutationId: 'mutation-rejected' }))
  assert.deepEqual(room.graph().nodes, [])
  await assert.rejects(room.applyUpdate(encodedNodeUpdate('node-blocked', 160), 'editor-1', { mutationId: 'mutation-blocked' }))
  assert.equal(appendCount, 1)

  reloadAvailable = true
  const recovered = await room.applyUpdate(encodedNodeUpdate('node-recovered', 240), 'editor-1', { mutationId: 'mutation-recovered' })
  assert.deepEqual(recovered.graph.nodes.map((node) => node.id), ['node-recovered'])
  assert.deepEqual(durableGraph.nodes.map((node) => node.id), ['node-recovered'])
  await room.destroy()
})

test('append 成功但压缩 CAS 冲突时立即重载最新权威图谱', async () => {
  const remoteNode = {
    id: 'node-remote', type: 'text', position: { x: 320, y: 20 },
    data: { kind: 'text', label: 'remote', content: 'remote' },
  }
  let reloadCount = 0
  let durableState = { graph: { nodes: [], edges: [] }, graphRevision: 1, updates: [] }
  const room = createCanvasCollaborationRoom({
    state: durableState,
    reload: async () => {
      reloadCount += 1
      return structuredClone(durableState)
    },
    append: async (payload) => {
      durableState = { graph: structuredClone(payload.graph), graphRevision: 2, updates: [payload.update] }
      return { graphRevision: 2, updateCount: 1, duplicate: false }
    },
    compact: async () => {
      durableState = {
        graph: { nodes: [...durableState.graph.nodes, remoteNode], edges: [] },
        graphRevision: 3,
        updates: durableState.updates,
      }
      const error = new Error('stale compact revision')
      error.code = 'CANVAS_GRAPH_CONFLICT'
      throw error
    },
    compactEvery: 1,
  })

  const result = await room.applyUpdate(encodedNodeUpdate('node-local', 160), 'editor-1', { mutationId: 'mutation-local' })
  assert.equal(reloadCount, 1)
  assert.equal(result.graphRevision, 3)
  assert.deepEqual(result.graph.nodes.map((node) => node.id).sort(), ['node-local', 'node-remote'])
  assert.deepEqual(room.graph().nodes.map((node) => node.id).sort(), ['node-local', 'node-remote'])
  await room.destroy()
})

test('显式权威重载失败后同样阻断房间读写', async () => {
  let appendCount = 0
  const room = createCanvasCollaborationRoom({
    state: { graph: { nodes: [], edges: [] }, graphRevision: 1, updates: [] },
    reload: async () => { throw new Error('reload unavailable') },
    append: async () => {
      appendCount += 1
      return { graphRevision: 2, updateCount: 1, duplicate: false }
    },
    compact: async () => undefined,
  })

  await assert.rejects(room.reloadPersistedState('editor-1'))
  assert.throws(() => room.stateUpdate(), /权威状态暂时无法恢复/)
  await assert.rejects(room.applyUpdate(encodedNodeUpdate('node-blocked', 160), 'editor-1', { mutationId: 'mutation-blocked' }))
  assert.equal(appendCount, 0)
  await room.destroy()
})

test('duplicate 提交重载失败后阻断房间读写', async () => {
  let appendCount = 0
  const room = createCanvasCollaborationRoom({
    state: { graph: { nodes: [], edges: [] }, graphRevision: 1, updates: [] },
    reload: async () => { throw new Error('reload unavailable') },
    append: async () => {
      appendCount += 1
      return { graphRevision: 2, mutationRevision: 2, updateCount: 1, duplicate: true }
    },
    compact: async () => undefined,
  })

  await assert.rejects(room.applyUpdate(encodedNodeUpdate('node-duplicate', 80), 'editor-1', { mutationId: 'mutation-duplicate' }))
  assert.throws(() => room.stateUpdate(), /权威状态暂时无法恢复/)
  await assert.rejects(room.applyUpdate(encodedNodeUpdate('node-blocked', 160), 'editor-1', { mutationId: 'mutation-blocked' }))
  assert.equal(appendCount, 1)
  await room.destroy()
})

test('两个房间并发重放同一服务端 mutation 时命中 durable duplicate', async () => {
  let durable = { graph: { nodes: [], edges: [] }, graphRevision: 1, updates: [] }
  let committed
  const append = async (payload) => {
    const normalized = normalizeCanvasGraphMutation(payload)
    if (committed) {
      if (committed.payloadHash !== normalized.payloadHash) {
        const error = new Error('mutation conflict')
        error.code = canvasMutationConflictCode
        throw error
      }
      return { graphRevision: 2, mutationRevision: 2, updateCount: 1, duplicate: true, update: committed.update }
    }
    committed = normalized
    durable = { graph: structuredClone(normalized.graph), graphRevision: 2, updates: [normalized.update] }
    return { graphRevision: 2, mutationRevision: 2, updateCount: 1, duplicate: false }
  }
  const options = {
    state: durable,
    reload: async () => structuredClone(durable),
    append,
    compact: async () => undefined,
  }
  const firstRoom = createCanvasCollaborationRoom(options)
  const secondRoom = createCanvasCollaborationRoom(options)
  const mutate = (graph) => ({
    ...graph,
    nodes: [...graph.nodes, {
      id: 'node-server', type: 'text', position: { x: 80, y: 20 },
      data: { kind: 'text', label: 'server', content: 'server' },
    }],
  })

  await firstRoom.commitGraphMutation(mutate, 'worker-1', { mutationId: 'server-mutation' })
  const duplicate = await secondRoom.commitGraphMutation(mutate, 'worker-2', { mutationId: 'server-mutation' })

  assert.equal(duplicate.duplicate, true)
  assert.deepEqual(duplicate.graph.nodes.map((node) => node.id), ['node-server'])
  await firstRoom.destroy()
  await secondRoom.destroy()
})
