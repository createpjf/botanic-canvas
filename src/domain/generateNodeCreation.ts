import type { Edge, XYPosition } from '@xyflow/react'
import { canvasNodeBounds, findOpenCanvasPosition } from './canvasNodeLayout.ts'
import { cloneGenerationSettings } from './generationRecipe.ts'
import type {
  AssetNodeData,
  CanvasNode,
  GenerateNodeData,
  GenerationSettings,
  ResultNodeData,
  TextNodeData,
} from './canvas'

export type GenerateMediaKind = 'image' | 'video'

type PlanGenerateNodeCreationInput = {
  nodes: CanvasNode[]
  nodeId: string
  position: XYPosition
  mediaKind: GenerateMediaKind
  settings: GenerationSettings
  inputNodeIds?: string[]
  /** 用户从工具栏/空白画布钉上的节点传 true；选中媒体时自动挂上的 working composer 不要传。 */
  standalone?: boolean
}

export function findOpenGeneratePosition(nodes: CanvasNode[], preferred: XYPosition): XYPosition {
  const size = canvasNodeBounds({
    id: 'placement-generate',
    type: 'generate',
    position: preferred,
    data: { kind: 'generate', label: '', prompt: '', batchCount: 1, settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' } },
  } as CanvasNode)
  return findOpenCanvasPosition(nodes, preferred, size)
}

function isGenerateInput(node: CanvasNode | undefined): node is CanvasNode {
  if (!node || (node.type !== 'asset' && node.type !== 'text' && node.type !== 'result')) return false
  return node.type !== 'result' || Boolean((node.data as ResultNodeData).image)
}

function inputDisplayName(node: CanvasNode) {
  if (node.type === 'asset') return (node.data as AssetNodeData).name
  if (node.type === 'text') return (node.data as TextNodeData).label
  return (node.data as ResultNodeData).label ?? '输出图片'
}

function escapedRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function nextGenerateLabel(nodes: CanvasNode[], inputs: CanvasNode[], mediaKind: GenerateMediaKind) {
  const typeName = mediaKind === 'video' ? '视频' : '图像'
  const primarySource = inputs.find((node) => node.type === 'asset' || node.type === 'result') ?? inputs[0]
  const sourceName = primarySource ? inputDisplayName(primarySource).trim() : ''
  const sourceSuffix = inputs.length > 1 ? ` +${inputs.length - 1}` : ''
  const base = sourceName ? `${sourceName}${sourceSuffix} · ${typeName}` : `${typeName}生成`
  const sequencePattern = new RegExp(`^${escapedRegExp(base)} (\\d{2,})$`)
  const maximumSequence = nodes.reduce((maximum, node) => {
    if (node.type !== 'generate') return maximum
    const match = (node.data as GenerateNodeData).label.match(sequencePattern)
    return match ? Math.max(maximum, Number(match[1])) : maximum
  }, 0)
  return `${base} ${String(maximumSequence + 1).padStart(2, '0')}`
}

export function planGenerateNodeCreation(input: PlanGenerateNodeCreationInput): {
  node: CanvasNode & { data: GenerateNodeData }
  edges: Edge[]
} {
  const nodeById = new Map(input.nodes.map((node) => [node.id, node]))
  const seenInputIds = new Set<string>()
  const inputs = (input.inputNodeIds ?? []).flatMap((nodeId) => {
    if (seenInputIds.has(nodeId)) return []
    seenInputIds.add(nodeId)
    const node = nodeById.get(nodeId)
    return isGenerateInput(node) ? [node] : []
  })
  const inputOrder = inputs.map((node) => node.id)
  const primaryAsset = inputs.find((node) => node.type === 'asset')
  const node: CanvasNode & { data: GenerateNodeData } = {
    id: input.nodeId,
    type: 'generate',
    position: input.position,
    draggable: true,
    selected: true,
    data: {
      kind: 'generate',
      label: nextGenerateLabel(input.nodes, inputs, input.mediaKind),
      prompt: '',
      batchCount: 1,
      // 新节点必须持有独立的 settings 快照；与调用方共享引用会让后续参数修改波及来源对象。
      settings: cloneGenerationSettings(input.settings),
      ...(inputOrder.length ? { inputOrder } : {}),
      ...(primaryAsset ? { primaryInputId: primaryAsset.id } : {}),
      ...(input.standalone === true ? { standalone: true } : {}),
    },
  }
  const edges = inputs.map((source, index): Edge => ({
    id: `generate-input-${input.nodeId}-${source.id}-${index + 1}`,
    source: source.id,
    sourceHandle: source.type === 'asset' ? 'asset-output' : 'output',
    target: input.nodeId,
    targetHandle: 'input',
    type: 'default',
    reconnectable: true,
    style: source.type === 'result'
      ? { stroke: '#7e9785', strokeWidth: 1.25, strokeDasharray: '4 3' }
      : { stroke: '#4f805b', strokeWidth: 1.6 },
  }))

  return { node, edges }
}
