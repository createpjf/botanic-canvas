import assert from 'node:assert/strict'
import test from 'node:test'
import type { Edge } from '@xyflow/react'
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
    edges: [],
  })

  assert.equal(updates.length, 1)
  assert.ok(updates[0].byteLength < 2_000)
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
