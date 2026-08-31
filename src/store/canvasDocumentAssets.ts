import type { Edge } from '@xyflow/react'
import { removeAssetFromGroups } from '../domain/assetGroups.ts'
import {
  cloneGenerationRecipe,
  cloneGenerationSettings,
  normalizeGenerateNodeInputs,
} from '../domain/generationRecipe.ts'
import type {
  AssetNodeData,
  AssetRecord,
  CanvasDocument,
  CanvasNode,
  CanvasSnapshot,
  GenerateNodeData,
  PromptNodeData,
  ReferenceGroupNodeData,
  ResultNodeData,
} from '../domain/canvas.ts'

export function cloneNodes(nodes: CanvasNode[]) {
  return nodes.map((node) => {
    const data = node.type === 'result'
      ? {
          ...node.data,
          generationSettings: (node.data as ResultNodeData).generationSettings
            ? cloneGenerationSettings((node.data as ResultNodeData).generationSettings!)
            : undefined,
          generationRecipe: (node.data as ResultNodeData).generationRecipe
            ? cloneGenerationRecipe((node.data as ResultNodeData).generationRecipe!)
            : undefined,
          rootRecipe: (node.data as ResultNodeData).rootRecipe
            ? cloneGenerationRecipe((node.data as ResultNodeData).rootRecipe!)
            : undefined,
        }
      : node.type === 'prompt'
        ? { ...node.data, settings: cloneGenerationSettings((node.data as PromptNodeData).settings) }
        : node.type === 'reference'
          ? { ...node.data, recipe: cloneGenerationRecipe((node.data as ReferenceGroupNodeData).recipe) }
          : node.type === 'generate'
            ? {
                ...node.data,
                settings: cloneGenerationSettings((node.data as GenerateNodeData).settings),
                inputOrder: (node.data as GenerateNodeData).inputOrder ? [...(node.data as GenerateNodeData).inputOrder!] : undefined,
              }
            : { ...node.data }
    return { ...node, position: { ...node.position }, data }
  }) as CanvasNode[]
}

export function cloneEdges(edges: Edge[]) {
  return edges.map((edge) => ({ ...edge, style: edge.style ? { ...edge.style } : undefined }))
}

export function normalizeSystemOutputEdges(nodes: CanvasNode[], edges: Edge[]): Edge[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  return edges.map((edge) => {
    const source = nodeById.get(edge.source)
    const target = nodeById.get(edge.target)
    if (source?.type !== 'generate' || target?.type !== 'result') return edge
    return {
      ...edge,
      sourceHandle: 'output',
      targetHandle: 'input',
      data: { ...(edge.data ?? {}), system: true, role: 'output' },
      reconnectable: false,
    }
  })
}

export function snapshot(document: CanvasDocument, name = document.name): CanvasSnapshot {
  return {
    name,
    nodes: cloneNodes(document.nodes),
    edges: cloneEdges(document.edges),
    viewport: { ...document.viewport },
  }
}

export function snapshotThumbnail(nodes: CanvasNode[], fallback: string) {
  const result = [...nodes].reverse().find((node) => node.type === 'result')
  return result ? (result.data as ResultNodeData).image ?? fallback : fallback
}

export function availableAssets(document: CanvasDocument, globalAssets: AssetRecord[]) {
  const ids = new Set<string>()
  return [...globalAssets, ...document.assets].filter((asset) => {
    if (ids.has(asset.id)) return false
    ids.add(asset.id)
    return true
  })
}

export function findAvailableAsset(document: CanvasDocument, globalAssets: AssetRecord[], assetId: string) {
  return availableAssets(document, globalAssets).find((asset) => asset.id === assetId)
}

export function hydrateAssetNodeImages(nodes: CanvasNode[], document: CanvasDocument, globalAssets: AssetRecord[]) {
  return nodes.map((node) => {
    if (node.type !== 'asset') return node
    const asset = findAvailableAsset(document, globalAssets, (node.data as AssetNodeData).assetId)
    return asset && (node.data as AssetNodeData).image !== asset.image
      ? { ...node, data: { ...node.data, image: asset.image } }
      : node
  }) as CanvasNode[]
}

export function withoutReference(recipe: import('../domain/canvas.ts').GenerationRecipe, assetId: string) {
  const references = recipe.references.filter((reference) => reference.assetId !== assetId)
  const primary = references.find((reference) => reference.nodeId === recipe.primaryReferenceNodeId && reference.role === '商品')
    ?? references.find((reference) => reference.role === '商品' && reference.primary)
    ?? references.find((reference) => reference.role === '商品')
  return {
    ...cloneGenerationRecipe(recipe),
    primaryReferenceNodeId: primary?.nodeId,
    references: references.map((reference, index) => ({
      ...reference,
      primary: reference.nodeId === primary?.nodeId,
      priority: index + 1,
    })),
  }
}

function scrubDeletedAssetFromNodes(nodes: CanvasNode[], assetId: string): CanvasNode[] {
  return nodes.map((node) => {
    if (node.type === 'result') {
      const result = node.data as ResultNodeData
      return {
        ...node,
        data: {
          ...result,
          generationRecipe: result.generationRecipe ? withoutReference(result.generationRecipe, assetId) : undefined,
          rootRecipe: result.rootRecipe ? withoutReference(result.rootRecipe, assetId) : undefined,
        },
      }
    }
    if (node.type === 'reference') {
      const reference = node.data as ReferenceGroupNodeData
      return { ...node, data: { ...reference, recipe: withoutReference(reference.recipe, assetId) } }
    }
    return node
  }) as CanvasNode[]
}

function withoutAsset(snapshotValue: CanvasSnapshot, assetId: string): CanvasSnapshot {
  const nodes = snapshotValue.nodes.filter((node) => node.type !== 'asset' || (node.data as AssetNodeData).assetId !== assetId)
  const nodeIds = new Set(nodes.map((node) => node.id))
  return {
    ...snapshotValue,
    nodes,
    edges: snapshotValue.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)),
  }
}

function scrubDeletedAssetFromSnapshot(snapshotValue: CanvasSnapshot, assetId: string): CanvasSnapshot {
  const withoutNode = withoutAsset(snapshotValue, assetId)
  return { ...withoutNode, nodes: scrubDeletedAssetFromNodes(withoutNode.nodes, assetId) }
}

/** 撤销素材及其后续可复用引用；保留视觉结果和不可变历史条目。 */
export function scrubAssetFromDocument(document: CanvasDocument, assetId: string): CanvasDocument {
  const remainingNodes = document.nodes.filter((node) => node.type !== 'asset' || (node.data as AssetNodeData).assetId !== assetId)
  const scrubbedNodes = scrubDeletedAssetFromNodes(remainingNodes, assetId)
  const nodeIds = new Set(scrubbedNodes.map((node) => node.id))
  const edges = document.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
  const nodes = normalizeGenerateNodeInputs(scrubbedNodes, edges)
  return {
    ...document,
    assets: document.assets.filter((item) => item.id !== assetId),
    assetGroups: removeAssetFromGroups(document.assetGroups, assetId),
    nodes,
    edges,
    templates: document.templates.map((template) => ({
      ...template,
      snapshot: scrubDeletedAssetFromSnapshot(template.snapshot, assetId),
    })),
    history: document.history.map((entry) => ({
      ...entry,
      generationRecipe: entry.generationRecipe ? withoutReference(entry.generationRecipe, assetId) : undefined,
      rootRecipe: entry.rootRecipe ? withoutReference(entry.rootRecipe, assetId) : undefined,
      snapshot: scrubDeletedAssetFromSnapshot(entry.snapshot, assetId),
    })),
  }
}

export function workflowTemplateSnapshotFromSnapshot(snapshotValue: CanvasSnapshot, name: string): CanvasSnapshot {
  const nodes = cloneNodes(snapshotValue.nodes)
    .filter((node) => node.type === 'asset' || node.type === 'text' || node.type === 'generate')
    .map((node) => {
      if (node.type !== 'generate') return node
      const data = node.data as GenerateNodeData
      return {
        ...node,
        selected: false,
        data: { ...data, status: undefined, jobId: undefined, generationKind: undefined, error: undefined },
      }
    }) as CanvasNode[]
  const nodeIds = new Set(nodes.map((node) => node.id))
  return {
    name,
    nodes,
    edges: cloneEdges(snapshotValue.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))),
    viewport: { ...snapshotValue.viewport },
  }
}

export function workflowTemplateSnapshot(document: CanvasDocument, name: string) {
  return workflowTemplateSnapshotFromSnapshot(snapshot(document, name), name)
}

/** 共享模板只能引用工作区品牌素材，不能携带项目上传或生成资产。 */
export function sharedWorkflowTemplateSnapshot(document: CanvasDocument, name: string) {
  const base = workflowTemplateSnapshot(document, name)
  const privateAssetNodeIds = new Set(base.nodes.flatMap((node) => {
    if (node.type !== 'asset') return []
    return (node.data as AssetNodeData).source === 'brand' ? [] : [node.id]
  }))
  const nodes = base.nodes
    .filter((node) => !privateAssetNodeIds.has(node.id))
    .map((node) => {
      if (node.type !== 'generate') return node
      const data = node.data as GenerateNodeData
      return {
        ...node,
        data: {
          ...data,
          inputOrder: data.inputOrder?.filter((nodeId) => !privateAssetNodeIds.has(nodeId)),
          primaryInputId: data.primaryInputId && !privateAssetNodeIds.has(data.primaryInputId) ? data.primaryInputId : undefined,
        },
      }
    }) as CanvasNode[]
  const nodeIds = new Set(nodes.map((node) => node.id))
  return {
    snapshot: { ...base, nodes, edges: cloneEdges(base.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))) },
    omittedPrivateAssetCount: privateAssetNodeIds.size,
  }
}
