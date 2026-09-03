import type { BotanicCanvasActionPreview, BotanicCanvasActionPreviewNode } from './agentActionPreview'

export type CanvasPreviewGraphPoint = { id: string; label: string; type: string; x: number; y: number; state: 'context' | 'created' | 'before' | 'after' | 'removed' }
export type CanvasPreviewGraphLine = { id: string; from: CanvasPreviewGraphPoint; to: CanvasPreviewGraphPoint; kind: 'connection' | 'movement' }
export type CanvasPreviewGraph = { width: 320; height: 168; points: CanvasPreviewGraphPoint[]; lines: CanvasPreviewGraphLine[] }
const WIDTH = 320, HEIGHT = 168, PADDING = 22
function positioned(node: BotanicCanvasActionPreviewNode | undefined) {
  return node?.position && Number.isFinite(node.position.x) && Number.isFinite(node.position.y)
}
export function projectFrozenCanvasPreview(preview: BotanicCanvasActionPreview): CanvasPreviewGraph | null {
  const raw: Array<CanvasPreviewGraphPoint & { rawX: number; rawY: number }> = []
  const add = (node: BotanicCanvasActionPreviewNode, state: CanvasPreviewGraphPoint['state'], suffix = '') => {
    if (!positioned(node)) return
    raw.push({ id: node.id + suffix, label: node.label, type: node.type, state, x: 0, y: 0, rawX: node.position!.x, rawY: node.position!.y })
  }
  for (const node of preview.context ?? []) add(node, 'context')
  for (const node of preview.created) add(node, 'created')
  for (const change of preview.updated) { add(change.before, 'before', ':before'); add(change.after, 'after') }
  for (const node of preview.removed) add(node, 'removed')
  if (!raw.length) return null
  const minX = Math.min(...raw.map((point) => point.rawX)), maxX = Math.max(...raw.map((point) => point.rawX))
  const minY = Math.min(...raw.map((point) => point.rawY)), maxY = Math.max(...raw.map((point) => point.rawY))
  const spanX = Math.max(1, maxX - minX), spanY = Math.max(1, maxY - minY)
  const scale = Math.min((WIDTH - PADDING * 2) / spanX, (HEIGHT - PADDING * 2) / spanY)
  const points = raw.map(({ rawX, rawY, ...point }) => ({ ...point, x: PADDING + (rawX - minX) * scale, y: PADDING + (rawY - minY) * scale }))
  const current = new Map(points.filter((point) => point.state !== 'before').map((point) => [point.id, point]))
  const lines: CanvasPreviewGraphLine[] = []
  for (const edge of preview.connections) { const from = current.get(edge.sourceNodeId), to = current.get(edge.targetNodeId); if (from && to) lines.push({ id: edge.id, from, to, kind: 'connection' }) }
  for (const change of preview.updated) { const from = points.find((point) => point.id === change.before.id + ':before'), to = current.get(change.after.id); if (from && to && (from.x !== to.x || from.y !== to.y)) lines.push({ id: 'move:' + change.after.id, from, to, kind: 'movement' }) }
  return { width: WIDTH, height: HEIGHT, points, lines }
}
