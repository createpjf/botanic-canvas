import type { Edge } from '@xyflow/react'
import * as Y from 'yjs'
import type { AssetNodeData, CanvasNode, ResultNodeData } from './canvas.ts'

export type CollaborativeGraph = {
  nodes: CanvasNode[]
  edges: Edge[]
}

type GraphRecord<T> = {
  deleted?: boolean
  order: number
  value?: T
}

type CollaborativeGraphOptions = {
  initialGraph: CollaborativeGraph
  onUpdate: (update: Uint8Array) => void
  onRemoteGraph: (graph: CollaborativeGraph) => void
}

const localOrigin = Symbol('canvas-local')
const remoteOrigin = Symbol('canvas-remote')
const mediaReferenceKeys = new Set(['image', 'maskImage', 'externalImage', 'mediaUrl', 'thumbnailUrl', 'previewUrl'])
const mediaPayloadKeys = new Set(['blob', 'dataUrl', 'base64', 'bytes', 'buffer'])

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function stableMediaReference(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return undefined
  return /^(?:data:|blob:|https?:|\/\/|[a-z][a-z\d+.-]*:)/i.test(value) ? undefined : value
}

function sanitizeCollaborativeValue(value: unknown, key?: string, mediaContext = false, stripExternalReferences = false): unknown {
  if (typeof value === 'string') {
    const normalized = value.trim()
    if (/^(?:data:|blob:)/i.test(normalized) || (stripExternalReferences && /^(?:\/\/|[a-z][a-z\d+.-]*:)/i.test(normalized))) return undefined
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return undefined
  if (mediaReferenceKeys.has(key ?? '') || (mediaContext && key === 'url')) return stableMediaReference(value)
  if (mediaPayloadKeys.has(key ?? '') || (key === 'data' && typeof value === 'string' && /^(?:data:|blob:)/i.test(value))) return undefined
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeCollaborativeValue(item, undefined, mediaContext, stripExternalReferences)).filter((item) => item !== undefined)
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).flatMap(([childKey, childValue]) => {
      const sanitized = sanitizeCollaborativeValue(
        childValue,
        childKey,
        mediaContext || key === 'media' || key === 'mask',
        stripExternalReferences,
      )
      return sanitized === undefined ? [] : [[childKey, sanitized]]
    }))
  }
  return value
}

function collaborativeNode(node: CanvasNode): CanvasNode {
  const normalized = sanitizeCollaborativeValue(node) as CanvasNode
  delete normalized.selected
  if (normalized.type === 'result' && 'selected' in normalized.data) {
    delete normalized.data.selected
  }
  if (normalized.type === 'asset' || normalized.type === 'result') {
    const { image: _mediaReference, ...data } = normalized.data as AssetNodeData | ResultNodeData
    return { ...normalized, data } as CanvasNode
  }
  return normalized
}

function collaborativeEdge(edge: Edge): Edge {
  const normalized = sanitizeCollaborativeValue(edge, undefined, false, true) as Edge
  // 选中是本机私有视图状态，与节点侧同一边界：不进 CRDT 广播，
  // 否则协作者会看到「被别人选中」的连线，且纯选中也会产生增量。
  delete normalized.selected
  return normalized
}

function normalizedGraph(graph: CollaborativeGraph): CollaborativeGraph {
  return {
    nodes: graph.nodes.map(collaborativeNode),
    edges: graph.edges.map(collaborativeEdge),
  }
}

/**
 * 将远端 CRDT 图谱应用到本机画布时，只保留本机私有的选择态与媒体引用。
 * 远端新增的媒体节点即使图片尚未通过权威文档回填，也必须作为占位节点保留，
 * 否则下一次本地 diff 会把它误广播成删除操作。
 */
export function mergeCollaborativeCanvasGraph(
  current: CollaborativeGraph,
  remote: CollaborativeGraph,
): CollaborativeGraph {
  const currentById = new Map(current.nodes.map((node) => [node.id, node]))
  const currentEdgeById = new Map(current.edges.map((edge) => [edge.id, edge]))
  return {
    nodes: remote.nodes.map((node) => {
      const local = currentById.get(node.id)
      const selected = Boolean(local?.selected)
      const localImage = local?.type === 'asset'
        ? (local.data as AssetNodeData).image
        : local?.type === 'result'
          ? (local.data as ResultNodeData).image
          : undefined
      return {
        ...clone(node),
        selected,
        data: node.type === 'result'
          ? { ...clone(node.data), ...(localImage ? { image: localImage } : {}), selected }
          : node.type === 'asset'
            ? { ...clone(node.data), ...(localImage ? { image: localImage } : {}) }
            : clone(node.data),
      } as CanvasNode
    }),
    edges: remote.edges.map((edge) => ({
      ...clone(edge),
      // 广播已剥离 selected，本机选中态只能从本地图谱恢复，与节点侧对称。
      ...(currentEdgeById.get(edge.id)?.selected ? { selected: true } : {}),
    })),
  }
}

function equal(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function updateRecords<T extends { id: string }>(
  records: Y.Map<GraphRecord<T>>,
  current: T[],
  next: T[],
) {
  const currentById = new Map(current.map((item) => [item.id, item]))
  const currentOrderById = new Map(current.map((item, order) => [item.id, order]))
  const nextById = new Map(next.map((item) => [item.id, item]))
  for (const item of current) {
    if (!nextById.has(item.id)) records.set(item.id, { deleted: true, order: -1 })
  }
  next.forEach((item, order) => {
    const previous = currentById.get(item.id)
    if (!previous || !equal(previous, item) || currentOrderById.get(item.id) !== order) {
      records.set(item.id, { order, value: clone(item) })
    }
  })
}

function applyRecords<T extends { id: string }>(
  current: T[],
  records: Y.Map<GraphRecord<T>>,
  changedIds: Set<string>,
) {
  const byId = new Map(current.map((item) => [item.id, item]))
  const orderById = new Map(current.map((item, order) => [item.id, order]))
  for (const id of changedIds) {
    const record = records.get(id)
    if (!record || record.deleted || !record.value) {
      byId.delete(id)
      orderById.delete(id)
      continue
    }
    byId.set(id, clone(record.value))
    orderById.set(id, record.order)
  }
  return [...byId.values()].sort((left, right) => (
    (orderById.get(left.id) ?? Number.MAX_SAFE_INTEGER)
    - (orderById.get(right.id) ?? Number.MAX_SAFE_INTEGER)
    || left.id.localeCompare(right.id)
  ))
}

/**
 * 节点与连线的会话级 CRDT 模块。
 *
 * 只发布当前会话实际发生的图谱增量，不把 HTTP 恢复的整份项目文档写进 Y.Doc。
 * 因此任务、媒体、历史和本机选择态仍由原有权威模块负责。
 */
export function createCollaborativeGraph({
  initialGraph,
  onUpdate,
  onRemoteGraph,
}: CollaborativeGraphOptions) {
  const document = new Y.Doc()
  const nodes = document.getMap<GraphRecord<CanvasNode>>('nodes')
  const edges = document.getMap<GraphRecord<Edge>>('edges')
  let graph = normalizedGraph(initialGraph)
  const changedNodeIds = new Set<string>()
  const changedEdgeIds = new Set<string>()

  nodes.observe((event) => {
    for (const id of event.keysChanged) changedNodeIds.add(id)
  })
  edges.observe((event) => {
    for (const id of event.keysChanged) changedEdgeIds.add(id)
  })
  document.on('update', (update, origin) => {
    if (origin === localOrigin) onUpdate(update)
  })
  document.on('afterTransaction', (transaction) => {
    if (transaction.origin !== remoteOrigin) {
      changedNodeIds.clear()
      changedEdgeIds.clear()
      return
    }
    graph = {
      nodes: applyRecords(graph.nodes, nodes, changedNodeIds),
      edges: applyRecords(graph.edges, edges, changedEdgeIds),
    }
    changedNodeIds.clear()
    changedEdgeIds.clear()
    onRemoteGraph(clone(graph))
  })

  return {
    replaceLocalGraph(nextGraph: CollaborativeGraph) {
      const next = normalizedGraph(nextGraph)
      document.transact(() => {
        updateRecords(nodes, graph.nodes, next.nodes)
        updateRecords(edges, graph.edges, next.edges)
      }, localOrigin)
      graph = next
    },
    applyRemoteUpdate(update: Uint8Array) {
      Y.applyUpdate(document, update, remoteOrigin)
    },
    stateVector() {
      return Y.encodeStateVector(document)
    },
    destroy() {
      document.destroy()
    },
  }
}
