import assert from 'node:assert/strict'
import test from 'node:test'
import type { Edge } from '@xyflow/react'
import type { CanvasNode } from './canvas.ts'
import { layoutCanvasNodes } from './canvasNodeLayout.ts'

function node(id: string, type: CanvasNode['type'], x: number, y: number): CanvasNode {
  const data = type === 'asset'
    ? { kind: 'asset' as const, assetId: id, name: id, role: '商品' as const, source: 'upload' as const, image: '/asset.webp' }
    : type === 'generate'
      ? { kind: 'generate' as const, label: id, prompt: '', batchCount: 1, settings: { model: 'gpt-image-2' as const, aspectRatio: '1:1' as const, resolution: '1K' as const }, inputOrder: ['asset-a'] }
      : { kind: 'result' as const, label: id, status: 'ready' as const, outputOf: 'generate-a', image: '/result.webp', generationSettings: { model: 'gpt-image-2' as const, aspectRatio: '1:1' as const, resolution: '1K' as const } }
  return { id, type, position: { x, y }, data } as CanvasNode
}

test('画布自动布局把输入、生成器和输出按语义顺序放入同一泳道且不修改原节点', () => {
  const nodes = [
    node('result-a', 'result', 900, 900),
    node('asset-a', 'asset', 700, 700),
    node('generate-a', 'generate', 800, 800),
  ]
  const original = structuredClone(nodes)
  const edges: Edge[] = [
    { id: 'asset-generate', source: 'asset-a', target: 'generate-a' },
    { id: 'generate-result', source: 'generate-a', target: 'result-a' },
  ]

  const laidOut = layoutCanvasNodes(nodes, edges)
  const byId = new Map(laidOut.map((item) => [item.id, item]))

  assert.ok(byId.get('asset-a')!.position.x < byId.get('generate-a')!.position.x)
  assert.ok(byId.get('generate-a')!.position.x < byId.get('result-a')!.position.x)
  assert.equal(byId.get('asset-a')!.position.y + 184, byId.get('generate-a')!.position.y + 138)
  assert.equal(byId.get('generate-a')!.position.y + 138, byId.get('result-a')!.position.y + 168)
  assert.deepEqual(nodes, original)
})

test('未连接节点排在任务泳道之后且不会伪装成生成输入', () => {
  const nodes = [
    node('asset-a', 'asset', 0, 0),
    node('generate-a', 'generate', 0, 0),
    node('result-a', 'result', 0, 0),
    node('asset-loose', 'asset', 0, 0),
  ]
  const edges: Edge[] = [
    { id: 'asset-generate', source: 'asset-a', target: 'generate-a' },
    { id: 'generate-result', source: 'generate-a', target: 'result-a' },
  ]

  const laidOut = layoutCanvasNodes(nodes, edges)
  const byId = new Map(laidOut.map((item) => [item.id, item]))

  assert.ok(byId.get('asset-loose')!.position.y > byId.get('asset-a')!.position.y)
  assert.equal(byId.get('asset-loose')!.position.x, byId.get('asset-a')!.position.x)
})
