import assert from 'node:assert/strict'
import test from 'node:test'
import type { Edge } from '@xyflow/react'
import * as Y from 'yjs'
import type { CanvasNode } from './canvas.ts'
import { createCollaborativeGraph, mergeCollaborativeCanvasGraph } from './collaborativeGraph.ts'

function node(id: string, x: number, selected = false): CanvasNode {
  return {
    id,
    type: 'text',
    position: { x, y: 20 },
    selected,
    data: { label: id, content: id },
  }
}

test('云端 JSON 对象键序变化后投影回协作图不产生本地写入', () => {
  const original = node('node-a', 10)
  const updates: Uint8Array[] = []
  const graph = createCollaborativeGraph({ initialGraph: { nodes: [original], edges: [] }, onUpdate: update => updates.push(update), onRemoteGraph: () => undefined })
  updates.length = 0
  graph.replaceLocalGraph({ nodes: [{ ...original, data: { content: 'node-a', label: 'node-a' } }], edges: [] })
  assert.equal(updates.length, 0)
  graph.replaceLocalGraph({ nodes: [{ ...original, data: { content: '实际编辑', label: 'node-a' } }], edges: [] })
  assert.equal(updates.length, 1, '真实内容变化仍然发布')
  graph.destroy()
})

test('协作图谱把节点与连线增量同步给另一位编辑者', () => {
  const initial = { nodes: [node('node-a', 10)], edges: [] as Edge[] }
  let remoteGraph = initial
  let publish = (_update: Uint8Array) => undefined
  const receiver = createCollaborativeGraph({
    initialGraph: initial,
    onUpdate: () => undefined,
    onRemoteGraph: (graph) => { remoteGraph = graph },
  })
  const sender = createCollaborativeGraph({
    initialGraph: initial,
    onUpdate: (update) => publish(update),
    onRemoteGraph: () => undefined,
  })
  publish = (update) => receiver.applyRemoteUpdate(update)

  sender.replaceLocalGraph({
    nodes: [node('node-a', 180), node('node-b', 320)],
    edges: [{ id: 'edge-a-b', source: 'node-a', target: 'node-b' }],
  })

  assert.deepEqual(remoteGraph.nodes.map((item) => [item.id, item.position.x]), [
    ['node-a', 180],
    ['node-b', 320],
  ])
  assert.deepEqual(remoteGraph.edges.map((edge) => edge.id), ['edge-a-b'])
  sender.destroy()
  receiver.destroy()
})

test('真实拖拽帧与 URI 前缀文案编辑并发时两者都保留', () => {
  const initial = { nodes: [node('node-a', 10)], edges: [] as Edge[] }
  const leftUpdates: Uint8Array[] = []
  const rightUpdates: Uint8Array[] = []
  let leftGraph = initial
  let rightGraph = initial
  const left = createCollaborativeGraph({
    initialGraph: initial,
    onUpdate: (update) => leftUpdates.push(update),
    onRemoteGraph: (graph) => { leftGraph = graph },
  })
  const right = createCollaborativeGraph({
    initialGraph: initial,
    onUpdate: (update) => rightUpdates.push(update),
    onRemoteGraph: (graph) => { rightGraph = graph },
  })

  left.replaceLocalGraph({ nodes: [{ ...node('node-a', 240), dragging: true }], edges: [] })
  right.replaceLocalGraph({
    nodes: [{ ...node('node-a', 10), data: { label: 'blob: 是文案', content: 'data: 并发后的文案' } }],
    edges: [],
  })
  const dragUpdate = new Y.Doc()
  Y.applyUpdate(dragUpdate, leftUpdates[0])
  assert.equal(dragUpdate.getMap('node-configs').has('node-a'), false, '拖拽帧不得写配置段')
  right.applyRemoteUpdate(leftUpdates[0])
  left.applyRemoteUpdate(rightUpdates[0])

  assert.equal(leftGraph.nodes[0].position.x, 240)
  assert.equal(leftGraph.nodes[0].data.label, 'blob: 是文案')
  assert.equal(leftGraph.nodes[0].data.content, 'data: 并发后的文案')
  assert.equal(rightGraph.nodes[0].position.x, 240)
  assert.equal(rightGraph.nodes[0].data.label, 'blob: 是文案')
  assert.equal(rightGraph.nodes[0].data.content, 'data: 并发后的文案')
  assert.equal('dragging' in leftGraph.nodes[0], false)
  assert.equal('dragging' in rightGraph.nodes[0], false)
  left.destroy()
  right.destroy()
})

test('远端几何段被清空时保留已有位置，不向画布交付无 position 的节点', () => {
  const original = node('node-position', 1380)
  let visible = { nodes: [original], edges: [] as Edge[] }
  const receiver = createCollaborativeGraph({ initialGraph: visible, onUpdate() {}, onRemoteGraph(graph) { visible = graph } })
  const remote = new Y.Doc()
  remote.getMap('nodes').set(original.id, { order: 0, value: original })
  remote.getMap('node-geometries').set(original.id, { order: 0, value: { position: original.position } })
  receiver.applyRemoteUpdate(Y.encodeStateAsUpdate(remote))
  for (const remove of [false, true]) {
    const vector = receiver.stateVector()
    if (remove) remote.getMap('node-geometries').delete(original.id)
    else remote.getMap('node-geometries').set(original.id, { order: 0, value: {} })
    receiver.applyRemoteUpdate(Y.encodeStateAsUpdate(remote, vector))
    assert.deepEqual(visible.nodes[0].position, original.position)
    assert.deepEqual(visible.nodes[0].data, original.data)
  }
  receiver.destroy()
  remote.destroy()
})

test('选择态属于本机 UI，不进入协作更新', () => {
  const initial = { nodes: [node('node-a', 10)], edges: [] as Edge[] }
  const updates: Uint8Array[] = []
  const collaboration = createCollaborativeGraph({
    initialGraph: initial,
    onUpdate: (update) => updates.push(update),
    onRemoteGraph: () => undefined,
  })

  collaboration.replaceLocalGraph({ nodes: [node('node-a', 10, true)], edges: [] })

  assert.equal(updates.length, 0)
  collaboration.destroy()
})

test('连线选中态同样不进入协作更新，远端合并后本机选中保留', () => {
  const edge: Edge = { id: 'edge-a-b', source: 'node-a', target: 'node-b' }
  const initial = { nodes: [node('node-a', 10), node('node-b', 320)], edges: [edge] }
  const updates: Uint8Array[] = []
  const collaboration = createCollaborativeGraph({
    initialGraph: initial,
    onUpdate: (update) => updates.push(update),
    onRemoteGraph: () => undefined,
  })

  collaboration.replaceLocalGraph({ ...initial, edges: [{ ...edge, selected: true }] })
  assert.equal(updates.length, 0)
  collaboration.destroy()

  const merged = mergeCollaborativeCanvasGraph(
    { ...initial, edges: [{ ...edge, selected: true }] },
    { ...initial, edges: [edge] },
  )
  assert.equal(merged.edges[0].selected, true)
})

test('协作增量不携带图片字节', () => {
  const assetNode = {
    id: 'asset-a',
    type: 'asset',
    position: { x: 10, y: 20 },
    data: {
      kind: 'asset',
      assetId: 'asset-a',
      role: '商品',
      name: '商品图',
      image: `data:image/png;base64,${'a'.repeat(20_000)}`,
      generationRecipe: {
        references: [
          { image: 'data:image/png;base64,deep-secret' },
          { image: '/api/media/stable-reference' },
        ],
        maskImage: 'blob:https://app.example/mask',
        externalImage: 'https://cdn.example.com/external.webp',
      },
    },
  } as CanvasNode
  const updates: Uint8Array[] = []
  const collaboration = createCollaborativeGraph({
    initialGraph: { nodes: [assetNode], edges: [] },
    onUpdate: (update) => updates.push(update),
    onRemoteGraph: () => undefined,
  })

  collaboration.replaceLocalGraph({
    nodes: [{ ...assetNode, position: { x: 100, y: 20 } }],
    edges: [{
      id: 'edge-media',
      source: 'asset-a',
      target: 'asset-a',
      data: {
        payload: 'data:image/png;base64,edge-secret',
        external: 'https://cdn.example.com/edge.png',
        privateMedia: 'media://edge-secret',
        binary: new Uint8Array([1, 2, 3]),
      },
    }],
  })

  assert.equal(updates.length, 1)
  assert.ok(updates[0].byteLength < 2_000)
  const serialized = new TextDecoder().decode(updates[0])
  assert.equal(serialized.includes('deep-secret'), false)
  assert.equal(serialized.includes('blob:https://app.example/mask'), false)
  assert.equal(serialized.includes('https://cdn.example.com/external.webp'), false)
  assert.equal(serialized.includes('edge-secret'), false)
  assert.equal(serialized.includes('https://cdn.example.com/edge.png'), false)
  assert.equal(serialized.includes('/api/media/stable-reference'), false, '纯移动不重复发送未变化的配置')
  const document = new Y.Doc()
  Y.applyUpdate(document, updates[0])
  const edgeData = document.getMap('edges').get('edge-media').value.data
  assert.equal(edgeData.payload, undefined)
  assert.equal(edgeData.external, undefined)
  assert.equal(edgeData.privateMedia, undefined)
  assert.equal(edgeData.binary, undefined)
  collaboration.destroy()
})

test('远端新增媒体节点尚未回填图片时仍保留节点与连线', () => {
  const remoteResult = {
    id: 'result-remote',
    type: 'result',
    position: { x: 320, y: 20 },
    data: { kind: 'result', label: '远端候选', mediaKind: 'image' },
  } as CanvasNode
  const remoteEdge = { id: 'edge-remote', source: 'node-a', target: 'result-remote' }

  const merged = mergeCollaborativeCanvasGraph(
    { nodes: [node('node-a', 10)], edges: [] },
    { nodes: [node('node-a', 10), remoteResult], edges: [remoteEdge] },
  )

  assert.deepEqual(merged.nodes.map((item) => item.id), ['node-a', 'result-remote'])
  assert.deepEqual(merged.edges, [remoteEdge])
})
