import type { Edge } from '@xyflow/react'
import type { AssetNodeData, CanvasNode, GenerateNodeData, TextNodeData } from './canvas'

export type WorkflowTemplateSummary = {
  nodeCount: number
  edgeCount: number
  promptCount: number
  privateAssetCount: number
  imageWorkflowCount: number
  videoWorkflowCount: number
  settings: string[]
  canSave: boolean
}

/** 模板只保存可编辑输入与生成配置；结果、任务状态和历史不属于模板。 */
export function summarizeWorkflowTemplate(nodes: CanvasNode[], edges: Edge[], shared = false): WorkflowTemplateSummary {
  const editableNodes = nodes.filter((node) => node.type === 'asset' || node.type === 'text' || node.type === 'generate')
  const privateAssetNodeIds = new Set(editableNodes.flatMap((node) => node.type === 'asset'
    && (node.data as AssetNodeData).source !== 'brand' ? [node.id] : []))
  const savedNodes = shared ? editableNodes.filter((node) => !privateAssetNodeIds.has(node.id)) : editableNodes
  const savedNodeIds = new Set(savedNodes.map((node) => node.id))
  const savedEdges = edges.filter((edge) => savedNodeIds.has(edge.source) && savedNodeIds.has(edge.target))
  const generateNodes = savedNodes.filter((node) => node.type === 'generate')
  const promptCount = savedNodes.filter((node) => node.type === 'text' && Boolean((node.data as TextNodeData).content.trim())).length
    + generateNodes.filter((node) => Boolean((node.data as GenerateNodeData).prompt.trim())).length
  const settings = [...new Set(generateNodes.map((node) => {
    const value = (node.data as GenerateNodeData).settings
    return `${value.model} · ${value.aspectRatio} · ${value.resolution}${value.duration ? ` · ${value.duration}秒` : ''}`
  }))]
  return {
    nodeCount: savedNodes.length,
    edgeCount: savedEdges.length,
    promptCount,
    privateAssetCount: privateAssetNodeIds.size,
    imageWorkflowCount: generateNodes.filter((node) => (node.data as GenerateNodeData).settings.duration === undefined).length,
    videoWorkflowCount: generateNodes.filter((node) => (node.data as GenerateNodeData).settings.duration !== undefined).length,
    settings,
    canSave: savedNodes.length > 0,
  }
}
