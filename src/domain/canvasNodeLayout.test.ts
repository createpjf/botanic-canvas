import assert from 'node:assert/strict'
import test from 'node:test'
import type { Edge } from '@xyflow/react'
import type { CanvasNode } from './canvas.ts'
import { findOpenCanvasPosition, layoutCanvasNodes, nodeRectsOverlap } from './canvasNodeLayout.ts'
import { hiddenGenerateIds } from './canvasWorkingGenerate.ts'

function asset(id: string, x = 0, y = 0): CanvasNode {
  return {
    id, type: 'asset', position: { x, y },
    data: { kind: 'asset', assetId: id, name: id, role: '商品', source: 'upload', image: '/asset.webp' },
  } as CanvasNode
}

function generate(id: string, inputOrder: string[], primaryInputId = ''): CanvasNode {
  return {
    id, type: 'generate', position: { x: 0, y: 0 },
    data: {
      kind: 'generate', label: id, prompt: '', batchCount: 1,
      settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
      inputOrder,
      ...(primaryInputId ? { primaryInputId } : {}),
    },
  } as CanvasNode
}

function result(id: string, outputOf: string): CanvasNode {
  return {
    id, type: 'result', position: { x: 0, y: 0 },
    data: {
      kind: 'result', label: id, status: 'ready', outputOf, image: '/result.webp',
      generationSettings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
    },
  } as CanvasNode
}

function byId(nodes: CanvasNode[]) {
  return new Map(nodes.map((node) => [node.id, node]))
}

function assertVisibleNodesDoNotOverlap(nodes: CanvasNode[], edges: Edge[]) {
  const hidden = hiddenGenerateIds(nodes, edges)
  const visible = nodes.filter((node) => node.type !== 'generate' || !hidden.has(node.id))
  for (let i = 0; i < visible.length; i += 1) {
    for (let j = i + 1; j < visible.length; j += 1) {
      assert.equal(
        nodeRectsOverlap(visible[i], visible[j], hidden, 8),
        false,
        `${visible[i].id} 与 ${visible[j].id} 重叠`,
      )
    }
  }
}

test('画布自动布局把输入、生成器和输出按语义顺序放入同一泳道且不修改原节点', () => {
  const nodes = [
    result('result-a', 'generate-a'),
    asset('asset-a', 700, 700),
    generate('generate-a', ['asset-a'], 'asset-a'),
  ]
  const original = structuredClone(nodes)
  const edges: Edge[] = [
    { id: 'asset-generate', source: 'asset-a', target: 'generate-a' },
    { id: 'generate-result', source: 'generate-a', target: 'result-a' },
  ]

  const laidOut = layoutCanvasNodes(nodes, edges)
  const placed = byId(laidOut)

  assert.ok(placed.get('asset-a')!.position.x < placed.get('result-a')!.position.x)
  assert.ok(Math.abs(placed.get('asset-a')!.position.y - placed.get('result-a')!.position.y) < 80)
  assertVisibleNodesDoNotOverlap(laidOut, edges)
  assert.deepEqual(nodes, original)
})

test('未连接节点排在任务泳道之后且不会伪装成生成输入', () => {
  const nodes = [
    asset('asset-a'),
    generate('generate-a', ['asset-a'], 'asset-a'),
    result('result-a', 'generate-a'),
    asset('asset-loose'),
  ]
  const edges: Edge[] = [
    { id: 'asset-generate', source: 'asset-a', target: 'generate-a' },
    { id: 'generate-result', source: 'generate-a', target: 'result-a' },
  ]

  const laidOut = layoutCanvasNodes(nodes, edges)
  const placed = byId(laidOut)

  assert.ok(placed.get('asset-loose')!.position.y > placed.get('asset-a')!.position.y)
  assert.ok(placed.get('asset-loose')!.position.x < placed.get('result-a')!.position.x)
  assertVisibleNodesDoNotOverlap(laidOut, edges)
})

test('相连两张图按左上下文、右引用排在同一行', () => {
  const nodes = [
    asset('asset-context', 0, 0),
    asset('asset-owner', 40, 800),
    generate('generate-owner', ['asset-owner', 'asset-context'], 'asset-owner'),
    generate('generate-context', ['asset-context'], 'asset-context'),
  ]
  const edges: Edge[] = [
    { id: 'e-owner', source: 'asset-owner', target: 'generate-owner' },
    { id: 'e-context', source: 'asset-context', target: 'generate-owner' },
    { id: 'e-self', source: 'asset-context', target: 'generate-context' },
  ]

  const laidOut = layoutCanvasNodes(nodes, edges)
  const placed = byId(laidOut)
  const context = placed.get('asset-context')!
  const owner = placed.get('asset-owner')!

  assert.ok(context.position.x < owner.position.x)
  assert.ok(Math.abs(context.position.y - owner.position.y) < 80)
  assertVisibleNodesDoNotOverlap(laidOut, edges)
})

test('未连接的两张图并排且不重叠', () => {
  const nodes = [
    asset('asset-a', 0, 0),
    asset('asset-b', 10, 10),
    generate('generate-a', ['asset-a'], 'asset-a'),
    generate('generate-b', ['asset-b'], 'asset-b'),
  ]
  const edges: Edge[] = [
    { id: 'a', source: 'asset-a', target: 'generate-a' },
    { id: 'b', source: 'asset-b', target: 'generate-b' },
  ]

  const laidOut = layoutCanvasNodes(nodes, edges)
  const placed = byId(laidOut)

  assert.ok(Math.abs(placed.get('asset-a')!.position.y - placed.get('asset-b')!.position.y) < 80)
  assertVisibleNodesDoNotOverlap(laidOut, edges)
})

test('findOpenCanvasPosition 从首选点让开已有节点', () => {
  const existing = [asset('asset-a', 120, 120)]
  const size = { width: 255, height: 368 }
  const first = findOpenCanvasPosition(existing, { x: 120, y: 120 }, size)
  assert.equal(nodeRectsOverlap(
    { ...existing[0], position: first } as CanvasNode,
    existing[0],
    undefined,
    8,
  ), false)
  assert.ok(first.x > 120 || first.y > 120)

  const second = findOpenCanvasPosition(
    [...existing, { ...asset('asset-b'), position: first }],
    { x: 120, y: 120 },
    size,
  )
  assert.equal(nodeRectsOverlap(
    { ...asset('asset-c'), position: second },
    { ...asset('asset-b'), position: first },
    undefined,
    8,
  ), false)
})
