import type { Edge } from '@xyflow/react'
import type { CanvasNode, GenerateNodeData, ResultNodeData } from './canvas.ts'

/** 从某素材/结果连出的全部 generate id（后连上的在前）。id 前缀混用，不能按字母序当新旧。 */
export function listGeneratesFromInput(mediaId: string, nodes: CanvasNode[], edges: Edge[]) {
  const generateIds = new Set(nodes.filter((node) => node.type === 'generate').map((node) => node.id))
  const seen = new Set<string>()
  const ordered: string[] = []
  for (let index = edges.length - 1; index >= 0; index -= 1) {
    const edge = edges[index]
    if (edge.source !== mediaId || !generateIds.has(edge.target) || seen.has(edge.target)) continue
    seen.add(edge.target)
    ordered.push(edge.target)
  }
  return ordered
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

/** 画布上应隐藏的 generate（有视觉参考且不是用户钉在画布上的节点，composer 挂在媒体下）。 */
export function hiddenGenerateIds(nodes: CanvasNode[], edges: Edge[]) {
  return new Set(
    nodes
      .filter((node) => (
        node.type === 'generate'
        && (node.data as GenerateNodeData).standalone !== true
        && generateHasVisualInput(node.id, nodes, edges)
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

/** 参考边和输出边都画到归属媒体，不从隐藏 generate 进出。 */
export function displayEdgeEnds(edge: Edge, nodes: CanvasNode[], edges: Edge[], hiddenIds: ReadonlySet<string>) {
  const source = hiddenIds.has(edge.source)
    ? (displayGenerateOwnerId(edge.source, nodes, edges) ?? edge.source)
    : edge.source
  const target = hiddenIds.has(edge.target)
    ? (displayGenerateOwnerId(edge.target, nodes, edges) ?? edge.target)
    : edge.target
  return { source, target, hidden: source === target || hiddenIds.has(source) || hiddenIds.has(target) }
}
