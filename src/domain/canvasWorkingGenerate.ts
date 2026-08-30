import type { Edge } from '@xyflow/react'
import type { CanvasNode, GenerateNodeData, ResultNodeData } from './canvas.ts'

/** 从某素材/结果连出的全部 generate id（按 id 新→旧）。 */
export function listGeneratesFromInput(mediaId: string, nodes: CanvasNode[], edges: Edge[]) {
  const generateIds = new Set(nodes.filter((node) => node.type === 'generate').map((node) => node.id))
  return edges
    .filter((edge) => edge.source === mediaId && generateIds.has(edge.target))
    .map((edge) => edge.target)
    .sort((left, right) => right.localeCompare(left))
}

/** generate 是否连着可展示的 asset / 已有图的 result。 */
export function generateHasVisualInput(generateId: string, nodes: CanvasNode[], edges: Edge[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  return edges.some((edge) => {
    if (edge.target !== generateId) return false
    const source = byId.get(edge.source)
    if (!source) return false
    if (source.type === 'asset') return true
    if (source.type === 'result') return Boolean((source.data as ResultNodeData).image)
    return false
  })
}

/** 只认该媒体自己的 generate：standalone / 别人的 primary 只是上下文，不算自己的 composer。 */
function isOwnedWorkingGenerate(mediaId: string, generateId: string, nodes: CanvasNode[]) {
  const node = nodes.find((item) => item.id === generateId && item.type === 'generate')
  if (!node) return false
  const data = node.data as GenerateNodeData
  if (data.standalone === true) return false
  return !data.primaryInputId || data.primaryInputId === mediaId
}

function agentGenerateIds(nodes: CanvasNode[]) {
  return new Set(nodes
    .filter((node) => node.type === 'generate'
      && (node.data as GenerateNodeData).standalone !== true
      && Boolean((node.data as GenerateNodeData).agentRun))
    .map((node) => node.id))
}

/** Agent 的 prompt / generate 是持久化血缘，不应在普通画布中占据一个用户节点。 */
export function hiddenAgentExecutionNodeIds(nodes: CanvasNode[], edges: Edge[]) {
  const generateIds = agentGenerateIds(nodes)
  const promptIds = nodes
    .filter((node) => node.type === 'text')
    .filter((node) => {
      const outgoing = edges.filter((edge) => edge.source === node.id)
      return outgoing.length === 1 && generateIds.has(outgoing[0].target)
    })
    .map((node) => node.id)
  return new Set([...generateIds, ...promptIds])
}

/** 优先「尚无成功输出」的最新 generate，否则最新 generate。 */
export function pickWorkingGenerateId(mediaId: string, nodes: CanvasNode[], edges: Edge[]) {
  const generates = listGeneratesFromInput(mediaId, nodes, edges).filter((id) => isOwnedWorkingGenerate(mediaId, id, nodes))
  if (!generates.length) return null
  const hasSucceededOutput = (generateId: string) => edges.some((edge) => {
    if (edge.source !== generateId) return false
    const target = nodes.find((node) => node.id === edge.target && node.type === 'result')
    if (!target) return false
    const result = target.data as ResultNodeData
    return Boolean(result.image) && result.status === 'ready'
  })
  return generates.find((id) => !hasSucceededOutput(id)) ?? generates[0]
}

/** 画布上应隐藏的 generate（视觉参考或 Agent 执行节点，composer 挂在媒体下）。 */
export function hiddenGenerateIds(nodes: CanvasNode[], edges: Edge[]) {
  const agentIds = agentGenerateIds(nodes)
  return new Set(
    nodes
      .filter((node) => (
        node.type === 'generate'
        && (node.data as GenerateNodeData).standalone !== true
        && (generateHasVisualInput(node.id, nodes, edges) || agentIds.has(node.id))
      ))
      .map((node) => node.id),
  )
}

/** 用户把已有 generate 第一次连上视觉参考时钉在画布上，避免被当成媒体下的隐藏 composer。 */
export function markStandaloneGeneratesOnManualConnect(nodes: CanvasNode[], previousEdges: Edge[], nextEdges: Edge[]) {
  return nodes.map((node) => {
    if (node.type !== 'generate') return node
    const data = node.data as GenerateNodeData
    if (data.standalone) return node
    if (generateHasVisualInput(node.id, nodes, previousEdges)) return node
    if (!generateHasVisualInput(node.id, nodes, nextEdges)) return node
    return { ...node, data: { ...data, standalone: true } }
  }) as CanvasNode[]
}

/** composer 挂在哪张媒体上：优先 primary，否则 working generate 的归属媒体。 */
export function displayGenerateOwnerId(generateId: string, nodes: CanvasNode[], edges: Edge[]) {
  const generate = nodes.find((node) => node.id === generateId && node.type === 'generate')
  const primaryId = generate ? (generate.data as GenerateNodeData).primaryInputId : undefined
  if (primaryId && nodes.some((node) => node.id === primaryId && (node.type === 'asset' || node.type === 'result'))) {
    return primaryId
  }
  return nodes.find((node) => (
    (node.type === 'asset' || node.type === 'result')
    && pickWorkingGenerateId(node.id, nodes, edges) === generateId
  ))?.id ?? null
}

/** 参考边画到归属媒体；generate 自己的输出边仍隐藏。 */
export function displayEdgeEnds(edge: Edge, nodes: CanvasNode[], edges: Edge[], hiddenIds: ReadonlySet<string>) {
  if (hiddenIds.has(edge.source)) return { source: edge.source, target: edge.target, hidden: true }
  if (!hiddenIds.has(edge.target)) return { source: edge.source, target: edge.target, hidden: false }
  const target = displayGenerateOwnerId(edge.target, nodes, edges) ?? edge.target
  return { source: edge.source, target, hidden: edge.source === target }
}
