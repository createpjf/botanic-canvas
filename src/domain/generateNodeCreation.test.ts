import assert from 'node:assert/strict'
import test from 'node:test'
import type { CanvasNode, GenerationSettings } from './canvas.ts'
import { findOpenGeneratePosition, planGenerateNodeCreation } from './generateNodeCreation.ts'

const settings: GenerationSettings = {
  model: 'MiniMax-Hailuo-2.3',
  aspectRatio: '3:4',
  resolution: '2K',
  duration: 5,
}

const assetNode: CanvasNode = {
  id: 'asset-santal',
  type: 'asset',
  position: { x: 0, y: 0 },
  data: {
    kind: 'asset',
    assetId: 'santal',
    name: 'Santal 01 香薰',
    image: '/api/media/santal',
    role: '商品',
    primary: true,
    referenceEnabled: true,
  },
}

function generateNode(id: string, label: string): CanvasNode {
  return {
    id,
    type: 'generate',
    position: { x: 500, y: 100 },
    data: {
      kind: 'generate',
      label,
      prompt: '',
      batchCount: 1,
      settings: { ...settings, duration: undefined },
    },
  }
}

test('从已选素材创建视频节点时原子建立输入连线并按来源命名', () => {
  const result = planGenerateNodeCreation({
    nodes: [assetNode],
    nodeId: 'generate-video-1',
    position: { x: 420, y: 180 },
    mediaKind: 'video',
    settings,
    inputNodeIds: [assetNode.id],
  })

  assert.equal(result.node.data.label, 'Santal 01 香薰 · 视频 01')
  assert.deepEqual(result.node.data.inputOrder, ['asset-santal'])
  assert.equal(result.node.data.primaryInputId, 'asset-santal')
  assert.deepEqual(result.edges.map((edge) => ({
    source: edge.source,
    sourceHandle: edge.sourceHandle,
    target: edge.target,
    targetHandle: edge.targetHandle,
  })), [{
    source: 'asset-santal',
    sourceHandle: 'asset-output',
    target: 'generate-video-1',
    targetHandle: 'input',
  }])
})

test('从已选文本创建图片节点时使用文本端口并递增同来源序号', () => {
  const textNode: CanvasNode = {
    id: 'text-brief',
    type: 'text',
    position: { x: 0, y: 0 },
    data: { kind: 'text', label: '视觉描述', content: '自然光产品肖像' },
  }
  const existingGenerate: CanvasNode = {
    id: 'generate-image-1',
    type: 'generate',
    position: { x: 320, y: 0 },
    data: {
      kind: 'generate',
      label: '视觉描述 · 图像 01',
      prompt: '',
      batchCount: 1,
      settings: { ...settings, model: 'gpt-image-2', duration: undefined },
    },
  }

  const result = planGenerateNodeCreation({
    nodes: [textNode, existingGenerate],
    nodeId: 'generate-image-2',
    position: { x: 640, y: 0 },
    mediaKind: 'image',
    settings: { ...settings, model: 'gpt-image-2', duration: undefined },
    inputNodeIds: [textNode.id],
  })

  assert.equal(result.node.data.label, '视觉描述 · 图像 02')
  assert.equal(result.edges[0]?.sourceHandle, 'output')
  assert.equal(result.edges[0]?.targetHandle, 'input')
})

test('新生成节点持有独立 settings 快照，不与调用方共享引用', () => {
  const input: GenerationSettings = { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' }
  const result = planGenerateNodeCreation({
    nodes: [],
    nodeId: 'generate-clone-1',
    position: { x: 0, y: 0 },
    mediaKind: 'image',
    settings: input,
  })

  assert.notEqual(result.node.data.settings, input)
  input.aspectRatio = '16:9'
  assert.equal(result.node.data.settings.aspectRatio, '3:4')
})

test('局部布局只为新分支寻找空位，不移动已有节点', () => {
  const existing = [
    generateNode('generate-1', '已有分支 · 图像 01'),
    { ...generateNode('generate-2', '已有分支 · 图像 02'), position: { x: 500, y: 338 } },
  ]
  const originalPositions = existing.map((node) => ({ ...node.position }))

  assert.deepEqual(findOpenGeneratePosition(existing, { x: 500, y: 100 }), { x: 500, y: 576 })
  assert.deepEqual(existing.map((node) => node.position), originalPositions)
})
