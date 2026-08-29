import type { Edge, XYPosition } from '@xyflow/react'
import type { AssetNodeData, CanvasNode, ResultNodeData } from './canvas.ts'
import { displayEdgeEnds, displayGenerateOwnerId, hiddenGenerateIds } from './canvasWorkingGenerate.ts'

export function canvasNodeBounds(node: CanvasNode, hiddenIds?: ReadonlySet<string>) {
  if (node.type === 'generate' && hiddenIds?.has(node.id)) return { width: 1, height: 1 }
  const measuredWidth = node.measured?.width
  const measuredHeight = node.measured?.height
  if (measuredWidth && measuredHeight) return { width: measuredWidth, height: measuredHeight }
  if (node.type === 'asset') {
    const asset = node.data as AssetNodeData
    const preview = asset.imageWidth && asset.imageHeight
      ? imagePreviewSize(asset.imageWidth, asset.imageHeight)
      : { width: 255, height: 340 }
    return { width: preview.width, height: preview.height + 28 }
  }
  if (node.type === 'prompt') return { width: 252, height: 126 }
  if (node.type === 'reference') return { width: 252, height: 148 }
  if (node.type === 'text') return { width: 236, height: 158 }
  if (node.type === 'generate') return { width: 176, height: node.selected ? 316 : 148 }
  const settings = (node.data as ResultNodeData).generationSettings
  const height = settings?.aspectRatio === '16:9' ? 169 : settings?.aspectRatio === '4:3' ? 225 : settings?.aspectRatio === '1:1' ? 300 : settings?.aspectRatio === '4:5' ? 375 : settings?.aspectRatio === '9:16' ? 533 : 400
  return { width: 300, height: height + 36 }
}

function imagePreviewSize(imageWidth: number, imageHeight: number) {
  const scale = Math.min(320 / imageWidth, 340 / imageHeight, 1)
  return {
    width: Math.max(1, Math.round(imageWidth * scale)),
    height: Math.max(1, Math.round(imageHeight * scale)),
  }
}

function canvasNodeSort(left: CanvasNode, right: CanvasNode) {
  const typeRank = (node: CanvasNode) => {
    if (node.type === 'asset') return 0
    if (node.type === 'text') return 1
    if (node.type === 'prompt') return 2
    if (node.type === 'reference') return 3
    if (node.type === 'generate') return 4
    return 5
  }
  const leftTypeRank = typeRank(left)
  const rightTypeRank = typeRank(right)
  if (leftTypeRank !== rightTypeRank) return leftTypeRank - rightTypeRank
  if (left.type === 'asset' && right.type === 'asset') {
    const roleRank = { 商品: 0, 场景: 1, 模特: 2, 调性: 3, 首图: 4 } as const
    const roleDifference = roleRank[(left.data as AssetNodeData).role] - roleRank[(right.data as AssetNodeData).role]
    if (roleDifference) return roleDifference
  }
  if (left.position.y !== right.position.y) return left.position.y - right.position.y
  if (left.position.x !== right.position.x) return left.position.x - right.position.x
  return left.id.localeCompare(right.id)
}

function nodeRect(node: CanvasNode, hiddenIds?: ReadonlySet<string>) {
  const bounds = canvasNodeBounds(node, hiddenIds)
  return { x: node.position.x, y: node.position.y, width: bounds.width, height: bounds.height }
}

export function nodeRectsOverlap(left: CanvasNode, right: CanvasNode, hiddenIds?: ReadonlySet<string>, gap = 0) {
  const a = nodeRect(left, hiddenIds)
  const b = nodeRect(right, hiddenIds)
  return a.x < b.x + b.width + gap
    && a.x + a.width + gap > b.x
    && a.y < b.y + b.height + gap
    && a.y + a.height + gap > b.y
}

/** 从首选点向右再向下找空位。hidden generate 不占位。 */
export function findOpenCanvasPosition(
  nodes: CanvasNode[],
  preferred: XYPosition,
  size: { width: number; height: number },
  hiddenIds?: ReadonlySet<string>,
): XYPosition {
  const gap = 48
  const occupied = nodes
    .filter((node) => !(node.type === 'generate' && hiddenIds?.has(node.id)))
    .map((node) => nodeRect(node, hiddenIds))
  const fits = (position: XYPosition) => !occupied.some((rect) => (
    position.x < rect.x + rect.width + gap
    && position.x + size.width + gap > rect.x
    && position.y < rect.y + rect.height + gap
    && position.y + size.height + gap > rect.y
  ))
  if (fits(preferred)) return preferred
  const stepX = size.width + gap
  const stepY = size.height + gap
  // ponytail: 先有界网格就近找空位；搜完落到全体占用底边之下，保证 fits()。更密装箱另做。
  const maxRows = 24
  const maxCols = 16
  for (let row = 0; row < maxRows; row += 1) {
    for (let col = 0; col < maxCols; col += 1) {
      if (row === 0 && col === 0) continue
      const candidate = { x: preferred.x + col * stepX, y: preferred.y + row * stepY }
      if (fits(candidate)) return candidate
    }
  }
  const floorY = occupied.reduce((max, rect) => Math.max(max, rect.y + rect.height), preferred.y) + gap
  return { x: preferred.x, y: floorY }
}

function isVisibleNode(node: CanvasNode, hiddenIds: ReadonlySet<string>) {
  return node.type !== 'generate' || !hiddenIds.has(node.id)
}

function layoutLinks(nodes: CanvasNode[], edges: Edge[], hiddenIds: ReadonlySet<string>) {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const links: Array<{ source: string; target: string }> = []
  const seen = new Set<string>()
  const add = (source?: string | null, target?: string | null) => {
    if (!source || !target || source === target) return
    const from = byId.get(source)
    const to = byId.get(target)
    if (!from || !to || !isVisibleNode(from, hiddenIds) || !isVisibleNode(to, hiddenIds)) return
    const key = `${source}>${target}`
    if (seen.has(key)) return
    seen.add(key)
    links.push({ source, target })
  }
  for (const edge of edges) {
    const ends = displayEdgeEnds(edge, nodes, edges, hiddenIds)
    if (!ends.hidden) add(ends.source, ends.target)
    if (hiddenIds.has(edge.source) && byId.get(edge.target)?.type === 'result') {
      add(displayGenerateOwnerId(edge.source, nodes, edges), edge.target)
    }
  }
  return links
}

function connectedComponents(ids: string[], links: Array<{ source: string; target: string }>) {
  const parent = new Map(ids.map((id) => [id, id]))
  const find = (id: string): string => {
    const current = parent.get(id) ?? id
    if (current === id) return id
    const root = find(current)
    parent.set(id, root)
    return root
  }
  for (const link of links) {
    if (!parent.has(link.source) || !parent.has(link.target)) continue
    parent.set(find(link.source), find(link.target))
  }
  const groups = new Map<string, string[]>()
  for (const id of ids) {
    const root = find(id)
    groups.set(root, [...(groups.get(root) ?? []), id])
  }
  return [...groups.values()]
}

function rankNodes(ids: string[], links: Array<{ source: string; target: string }>) {
  const member = new Set(ids)
  const rank = new Map(ids.map((id) => [id, 0]))
  for (let step = 0; step < ids.length; step += 1) {
    let changed = false
    for (const link of links) {
      if (!member.has(link.source) || !member.has(link.target)) continue
      const next = (rank.get(link.source) ?? 0) + 1
      if (next > (rank.get(link.target) ?? 0)) {
        rank.set(link.target, next)
        changed = true
      }
    }
    if (!changed) break
  }
  return rank
}

/**
 * 按可见图画整理：上下文在左，被引用节点在右。hidden generate 不占泳道。
 * 未连接节点并排收在已连接簇下方，避免叠成一条竖带。
 */
export function layoutCanvasNodes(nodes: CanvasNode[], edges: Edge[]): CanvasNode[] {
  const cloned = nodes.map((node) => ({
    ...node,
    position: { ...node.position },
    data: { ...node.data },
  })) as CanvasNode[]
  const hiddenIds = hiddenGenerateIds(cloned, edges)
  const byId = new Map(cloned.map((node) => [node.id, node]))
  const boundsOf = (nodeId: string) => canvasNodeBounds(byId.get(nodeId)!, hiddenIds)
  const links = layoutLinks(cloned, edges, hiddenIds)
  const visibleIds = cloned.filter((node) => isVisibleNode(node, hiddenIds)).map((node) => node.id)
  const linkedIds = new Set(links.flatMap((link) => [link.source, link.target]))
  const clusters = connectedComponents(visibleIds.filter((id) => linkedIds.has(id)), links)
    .map((ids) => ids.slice().sort((left, right) => canvasNodeSort(byId.get(left)!, byId.get(right)!)))
    .sort((left, right) => canvasNodeSort(byId.get(left[0])!, byId.get(right[0])!))
  const isolated = visibleIds
    .filter((id) => !linkedIds.has(id))
    .sort((left, right) => canvasNodeSort(byId.get(left)!, byId.get(right)!))

  const originX = 96
  const originY = 96
  const rankGap = 96
  const stackGap = 56
  const clusterGap = 112
  const positions = new Map<string, XYPosition>()

  let cursorY = originY
  for (const cluster of clusters) {
    const ranks = rankNodes(cluster, links)
    const idsByRank = new Map<number, string[]>()
    for (const id of cluster) {
      const rank = ranks.get(id) ?? 0
      idsByRank.set(rank, [...(idsByRank.get(rank) ?? []), id])
    }
    const orderedRanks = [...idsByRank.keys()].sort((left, right) => left - right)
    const columnWidth = new Map<number, number>()
    const columnHeight = new Map<number, number>()
    for (const rank of orderedRanks) {
      const ids = (idsByRank.get(rank) ?? []).sort((left, right) => canvasNodeSort(byId.get(left)!, byId.get(right)!))
      idsByRank.set(rank, ids)
      columnWidth.set(rank, Math.max(0, ...ids.map((id) => boundsOf(id).width)))
      columnHeight.set(rank, ids.reduce((total, id) => total + boundsOf(id).height, 0) + Math.max(0, ids.length - 1) * stackGap)
    }
    const clusterHeight = Math.max(0, ...columnHeight.values())
    let columnX = originX
    for (const rank of orderedRanks) {
      let y = cursorY + (clusterHeight - (columnHeight.get(rank) ?? 0)) / 2
      for (const id of idsByRank.get(rank) ?? []) {
        positions.set(id, { x: columnX, y })
        y += boundsOf(id).height + stackGap
      }
      columnX += (columnWidth.get(rank) ?? 0) + rankGap
    }
    cursorY += clusterHeight + clusterGap
  }

  let packX = originX
  let packY = clusters.length ? cursorY : originY
  let rowHeight = 0
  const rowLimit = originX + 980
  for (const id of isolated) {
    const bounds = boundsOf(id)
    if (packX > originX && packX + bounds.width > rowLimit) {
      packX = originX
      packY += rowHeight + stackGap
      rowHeight = 0
    }
    positions.set(id, { x: packX, y: packY })
    packX += bounds.width + rankGap
    rowHeight = Math.max(rowHeight, bounds.height)
  }

  for (const node of cloned) {
    if (positions.has(node.id)) continue
    const ownerId = node.type === 'generate' ? displayGenerateOwnerId(node.id, cloned, edges) : null
    positions.set(node.id, ownerId ? positions.get(ownerId) ?? { x: 0, y: 0 } : { x: 0, y: 0 })
  }

  return cloned.map((node) => ({ ...node, position: positions.get(node.id) ?? { ...node.position } })) as CanvasNode[]
}
