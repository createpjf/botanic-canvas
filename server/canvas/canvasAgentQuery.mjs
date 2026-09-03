// @ts-check

import { canvasAgentEntityHash } from './canvasAgentEntityHash.mjs'

const NODE_TYPES = new Set(['asset', 'prompt', 'reference', 'result', 'text', 'generate', 'frame'])
const FRAME_STAGES = new Set(['brief', 'references', 'generation', 'review', 'approved', 'delivery', 'archive', 'custom'])
const DIRECTIONS = new Set(['incoming', 'outgoing', 'either'])
const MAX_NODE_LIMIT = 50
const MAX_EDGE_LIMIT = 100
const MAX_TEXT_LENGTH = 1_000

export class CanvasAgentQueryError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'CanvasAgentQueryError'
    this.code = code
  }
}

function text(value, label, maxLength = 160) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    throw new CanvasAgentQueryError('CANVAS_QUERY_INVALID', `${label}无效。`)
  }
  return value.trim()
}

function textList(value, label, allowed) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 50) throw new CanvasAgentQueryError('CANVAS_QUERY_INVALID', `${label}无效。`)
  const result = [...new Set(value.map((entry) => text(entry, label)).filter(Boolean))]
  if (allowed && result.some((entry) => !allowed.has(entry))) {
    throw new CanvasAgentQueryError('CANVAS_QUERY_INVALID', `${label}包含不支持的值。`)
  }
  return result
}

function normalizeRole(value) {
  return String(value ?? '').trim().toLocaleLowerCase('zh-CN')
}

function nodeLabel(node) {
  return node?.data?.label ?? node?.data?.name ?? ''
}

function nodeStatus(node) {
  return node?.data?.taskStatus ?? node?.data?.status ?? (node?.type === 'generate' ? 'idle' : undefined)
}

function edgeRole(edge, nodeById) {
  return edge?.data?.role ?? nodeById.get(edge?.source)?.data?.role
}

function isReferenceEdge(edge, nodeById) {
  const source = nodeById.get(edge?.source)
  const target = nodeById.get(edge?.target)
  return target?.type === 'generate'
    && ['asset', 'reference', 'result'].includes(source?.type)
    && edge?.data?.system !== true
}

function hasMatchingRelation(node, edges, nodeById, relation) {
  if (!relation) return true
  return edges.some((edge) => {
    const incoming = edge.target === node.id
    const outgoing = edge.source === node.id
    if (relation.direction === 'incoming' && !incoming) return false
    if (relation.direction === 'outgoing' && !outgoing) return false
    if (relation.direction === 'either' && !incoming && !outgoing) return false
    if (relation.role && normalizeRole(edgeRole(edge, nodeById)) !== normalizeRole(relation.role)) return false
    if (relation.nodeId && edge[incoming ? 'source' : 'target'] !== relation.nodeId) return false
    return true
  })
}

function publicConstraints(value) {
  const dimensions = new Set(['person', 'garment', 'product', 'scene', 'style', 'pose', 'composition', 'lighting', 'aspect_ratio', 'copy_space'])
  return Array.isArray(value) ? value.filter((item) => dimensions.has(item?.dimension) && ['preserve', 'change'].includes(item?.mode))
    .slice(0, 10).map((item) => ({ dimension: item.dimension, mode: item.mode })) : []
}

function publicNode(node) {
  const data = node?.data ?? {}
  const constraints = publicConstraints(data.constraints)
  return {
    id: node.id,
    type: node.type,
    position: { x: Number(node.position?.x) || 0, y: Number(node.position?.y) || 0 },
    ...(nodeLabel(node) ? { label: String(nodeLabel(node)).slice(0, 160) } : {}),
    ...(nodeStatus(node) ? { status: nodeStatus(node) } : {}),
    ...(typeof data.frameId === 'string' ? { frameId: data.frameId } : {}),
    ...(node.type === 'frame' ? { stage: data.stage, bounds: { x: Number(node.position?.x) || 0, y: Number(node.position?.y) || 0, width: Number(data.width) || 0, height: Number(data.height) || 0 } } : {}),
    ...(['text', 'prompt'].includes(node.type) && typeof data.content === 'string'
      ? { content: data.content.slice(0, MAX_TEXT_LENGTH) } : {}),
    ...(node.type === 'generate' ? {
      settings: {
        model: data.settings?.model,
        aspectRatio: data.settings?.aspectRatio,
        resolution: data.settings?.resolution,
      },
      batchCount: Number(data.batchCount) || 1,
      ...(constraints.length ? { constraints } : {}),
    } : {}),
    authority: {
      ...(data.assetId ? { assetId: data.assetId } : {}),
      ...(data.jobId ? { jobId: data.jobId } : {}),
      ...(data.candidateId ? { candidateId: data.candidateId } : {}),
      ...(data.versionId ? { versionId: data.versionId } : {}),
      ...(data.outputOf ? { outputOf: data.outputOf } : {}),
      ...(data.agentRun?.runId ? { runId: data.agentRun.runId } : {}),
      ...(data.agentRun?.branchId ? { branchId: data.agentRun.branchId } : {}),
    },
  }
}

function publicEdge(edge, nodeById) {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
    ...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {}),
    ...(edgeRole(edge, nodeById) ? { role: edgeRole(edge, nodeById) } : {}),
    system: edge?.data?.system === true,
  }
}

/** @param {any} raw */
export function normalizeCanvasAgentQuery(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new CanvasAgentQueryError('CANVAS_QUERY_INVALID', '画布查询无效。')
  const relationRaw = raw.relation
  let relation
  if (relationRaw !== undefined) {
    if (!relationRaw || typeof relationRaw !== 'object' || Array.isArray(relationRaw)) throw new CanvasAgentQueryError('CANVAS_QUERY_INVALID', '关系过滤无效。')
    const direction = text(relationRaw.direction, '关系方向') ?? 'either'
    if (!DIRECTIONS.has(direction)) throw new CanvasAgentQueryError('CANVAS_QUERY_INVALID', '关系方向无效。')
    relation = { direction, role: text(relationRaw.role, '关系角色', 80), nodeId: text(relationRaw.nodeId, '关系节点') }
  }
  const requestedLimit = Number(raw.limit)
  return {
    nodeIds: textList(raw.nodeIds, '节点标识'),
    types: textList(raw.types, '节点类型', NODE_TYPES),
    statuses: textList(raw.statuses, '节点状态'),
    stages: textList(raw.stages, 'Frame 阶段', FRAME_STAGES),
    label: text(raw.label, '节点标签', 120),
    jobId: text(raw.jobId, '任务标识'),
    runId: text(raw.runId, 'Run 标识'),
    artifactId: text(raw.artifactId, 'Artifact 标识', 240),
    missingIncomingReferenceRole: text(raw.missingIncomingReferenceRole, '缺失参考角色', 80),
    afterId: text(raw.afterId, '节点分页游标'),
    edgeAfterId: text(raw.edgeAfterId, '连线分页游标'),
    limit: Number.isFinite(requestedLimit) ? Math.max(1, Math.min(Math.floor(requestedLimit), MAX_NODE_LIMIT)) : 20,
    ...(relation ? { relation } : {}),
  }
}

/**
 * 对当前权威 CanvasDocument 做有界查询；输出永不包含媒体地址或完整内部节点。
 * @param {any} document
 * @param {any} raw
 */
export function queryCanvasForAgent(document, raw = {}) {
  if (!document || !Array.isArray(document.nodes) || !Array.isArray(document.edges)) {
    throw new CanvasAgentQueryError('CANVAS_QUERY_DOCUMENT_INVALID', '项目画布不可读取。')
  }
  const query = normalizeCanvasAgentQuery(raw)
  const nodeById = new Map(document.nodes.filter((node) => node?.id).map((node) => [node.id, node]))
  const nodeIds = new Set(query.nodeIds)
  const types = new Set(query.types)
  const statuses = new Set(query.statuses)
  const stages = new Set(query.stages)
  const needle = query.label?.toLocaleLowerCase('zh-CN')
  const missingRole = normalizeRole(query.missingIncomingReferenceRole)
  const artifactParts = query.artifactId?.startsWith('generation:') ? query.artifactId.split(':') : []
  const matching = document.nodes.filter((node) => {
    if (!node?.id || !NODE_TYPES.has(node.type)) return false
    if (nodeIds.size && !nodeIds.has(node.id)) return false
    if (types.size && !types.has(node.type)) return false
    if (statuses.size && !statuses.has(String(nodeStatus(node) ?? ''))) return false
    if (stages.size && (node.type !== 'frame' || !stages.has(node.data?.stage))) return false
    if (needle && !String(nodeLabel(node)).toLocaleLowerCase('zh-CN').includes(needle)) return false
    if (query.jobId && node.data?.jobId !== query.jobId) return false
    if (query.runId && node.data?.agentRun?.runId !== query.runId) return false
    if (query.artifactId && !(node.data?.jobId === artifactParts[1] && node.data?.candidateId === artifactParts.slice(2).join(':'))) return false
    if (!hasMatchingRelation(node, document.edges, nodeById, query.relation)) return false
    if (missingRole && document.edges.some((edge) => edge.target === node.id && isReferenceEdge(edge, nodeById)
      && normalizeRole(edgeRole(edge, nodeById)) === missingRole)) return false
    return true
  }).sort((left, right) => left.id.localeCompare(right.id))
  const afterIndex = query.afterId ? matching.findIndex((node) => node.id === query.afterId) : -1
  if (query.afterId && afterIndex < 0) throw new CanvasAgentQueryError('CANVAS_QUERY_CURSOR_INVALID', '画布查询游标不属于当前结果集。')
  const selected = matching.slice(afterIndex + 1, afterIndex + 1 + query.limit)
  const selectedIds = new Set(selected.map((node) => node.id))
  const relatedEdges = document.edges
    .filter((edge) => selectedIds.has(edge.source) || selectedIds.has(edge.target))
    .sort((left, right) => left.id.localeCompare(right.id))
  const edgeStart = query.edgeAfterId ? relatedEdges.findIndex((edge) => edge.id === query.edgeAfterId) + 1 : 0
  if (query.edgeAfterId && edgeStart === 0) throw new CanvasAgentQueryError('CANVAS_QUERY_CURSOR_INVALID', '连线查询游标不属于当前结果集。')
  const selectedEdges = relatedEdges.slice(edgeStart, edgeStart + MAX_EDGE_LIMIT)
  const edgesTruncated = edgeStart + selectedEdges.length < relatedEdges.length
  const hasMore = afterIndex + 1 + selected.length < matching.length
  return {
    nodes: selected.map((node) => ({ ...publicNode(node), entityHash: canvasAgentEntityHash(document, node.id) })),
    edges: selectedEdges.map((edge) => publicEdge(edge, nodeById)),
    page: {
      returned: selected.length,
      hasMore,
      ...(hasMore ? { afterId: selected.at(-1)?.id } : {}),
      edgesTruncated,
      ...(edgesTruncated ? { edgeAfterId: selectedEdges.at(-1)?.id } : {}),
    },
  }
}
