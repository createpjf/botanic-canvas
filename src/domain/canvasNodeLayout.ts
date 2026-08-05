import type { Edge, XYPosition } from '@xyflow/react'
import type { AssetNodeData, CanvasNode, GenerateNodeData, ResultNodeData } from './canvas.ts'

export function canvasNodeBounds(node: CanvasNode) {
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
  if (node.type === 'generate') return { width: 360, height: 276 }
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

/**
 * 按生成血缘整理画布：一个首图任务和从任意候选图延展出的精修分支共享同一条泳道。
 * 未连接节点统一放到任务泳道之后，避免被误读为生成输入。
 */
export function layoutCanvasNodes(nodes: CanvasNode[], edges: Edge[]): CanvasNode[] {
  const cloned = nodes.map((node) => ({
    ...node,
    position: { ...node.position },
    data: { ...node.data },
  })) as CanvasNode[]
  const nodeById = new Map(cloned.map((node) => [node.id, node]))
  const generateNodes = cloned.filter((node) => node.type === 'generate').sort(canvasNodeSort)
  const positions = new Map<string, XYPosition>()
  const inputGap = 68
  const laneGap = 240
  const columnGap = 172

  const uniqueIds = (ids: string[]) => [...new Set(ids)].filter((id) => nodeById.has(id))
  const sortIds = (ids: string[]) => uniqueIds(ids)
    .map((id) => nodeById.get(id)!)
    .sort(canvasNodeSort)
    .map((node) => node.id)

  const resultOutputOf = new Map<string, string>()
  for (const result of cloned.filter((node) => node.type === 'result')) {
    const outputOf = (result.data as ResultNodeData).outputOf
    if (outputOf && nodeById.get(outputOf)?.type === 'generate') resultOutputOf.set(result.id, outputOf)
  }
  for (const edge of edges) {
    if (nodeById.get(edge.source)?.type === 'generate' && nodeById.get(edge.target)?.type === 'result') {
      resultOutputOf.set(edge.target, edge.source)
    }
  }

  const inputIdsByGenerate = new Map<string, string[]>()
  for (const generate of generateNodes) {
    const ordered = (generate.data as GenerateNodeData).inputOrder ?? []
    const connected = edges.filter((edge) => edge.target === generate.id).map((edge) => edge.source)
    inputIdsByGenerate.set(generate.id, uniqueIds([...ordered, ...connected]))
  }

  const parentResultByGenerate = new Map<string, string>()
  for (const generate of generateNodes) {
    const resultInput = inputIdsByGenerate.get(generate.id)?.find((id) => nodeById.get(id)?.type === 'result')
    if (resultInput) parentResultByGenerate.set(generate.id, resultInput)
  }

  const rootByGenerate = new Map<string, string>()
  const resolvingRoots = new Set<string>()
  const rootOfGenerate = (generateId: string): string => {
    const cached = rootByGenerate.get(generateId)
    if (cached) return cached
    if (resolvingRoots.has(generateId)) return generateId
    resolvingRoots.add(generateId)
    const parentResultId = parentResultByGenerate.get(generateId)
    const parentGenerateId = parentResultId ? resultOutputOf.get(parentResultId) : undefined
    const root = parentGenerateId && parentGenerateId !== generateId ? rootOfGenerate(parentGenerateId) : generateId
    resolvingRoots.delete(generateId)
    rootByGenerate.set(generateId, root)
    return root
  }
  generateNodes.forEach((node) => rootOfGenerate(node.id))

  const rankByGenerate = new Map<string, number>()
  const resolvingRanks = new Set<string>()
  const rankOfGenerate = (generateId: string): number => {
    const cached = rankByGenerate.get(generateId)
    if (typeof cached === 'number') return cached
    if (resolvingRanks.has(generateId)) return 1
    resolvingRanks.add(generateId)
    const parentResultId = parentResultByGenerate.get(generateId)
    const parentGenerateId = parentResultId ? resultOutputOf.get(parentResultId) : undefined
    const rank = parentGenerateId && parentGenerateId !== generateId ? rankOfGenerate(parentGenerateId) + 2 : 1
    resolvingRanks.delete(generateId)
    rankByGenerate.set(generateId, rank)
    return rank
  }
  generateNodes.forEach((node) => rankOfGenerate(node.id))

  const targetGeneratesByInput = new Map<string, string[]>()
  inputIdsByGenerate.forEach((inputIds, generateId) => {
    inputIds.forEach((inputId) => {
      targetGeneratesByInput.set(inputId, [...(targetGeneratesByInput.get(inputId) ?? []), generateId])
    })
  })

  const rootNodes = new Map<string, string[]>()
  const ranks = new Map<string, number>()
  const assignToRoot = (nodeId: string, rootId: string, rank: number) => {
    rootNodes.set(rootId, [...(rootNodes.get(rootId) ?? []), nodeId])
    ranks.set(nodeId, rank)
  }

  for (const generate of generateNodes) assignToRoot(generate.id, rootOfGenerate(generate.id), rankOfGenerate(generate.id))
  for (const [resultId, generateId] of resultOutputOf) assignToRoot(resultId, rootOfGenerate(generateId), rankOfGenerate(generateId) + 1)

  const leftovers: string[] = []
  for (const node of cloned) {
    if (ranks.has(node.id)) continue
    const targets = (targetGeneratesByInput.get(node.id) ?? []).slice().sort((left, right) => {
      const rankDifference = rankOfGenerate(left) - rankOfGenerate(right)
      if (rankDifference) return rankDifference
      return canvasNodeSort(nodeById.get(left)!, nodeById.get(right)!)
    })
    if (!targets.length) {
      leftovers.push(node.id)
      continue
    }
    const owner = targets[0]
    assignToRoot(node.id, rootOfGenerate(owner), Math.max(0, rankOfGenerate(owner) - 1))
  }

  const rootIds = [...rootNodes.keys()].sort((left, right) => canvasNodeSort(nodeById.get(left)!, nodeById.get(right)!))
  const columnWidths = new Map<number, number>()
  ranks.forEach((rank, nodeId) => {
    const width = canvasNodeBounds(nodeById.get(nodeId)!).width
    columnWidths.set(rank, Math.max(columnWidths.get(rank) ?? 0, width))
  })
  const maxRank = Math.max(0, ...columnWidths.keys())
  const columnX = new Map<number, number>()
  let nextColumnX = 96
  for (let rank = 0; rank <= maxRank; rank += 1) {
    columnX.set(rank, nextColumnX)
    nextColumnX += (columnWidths.get(rank) ?? 0) + columnGap
  }

  let laneTop = 96
  for (const rootId of rootIds) {
    const nodeIds = uniqueIds(rootNodes.get(rootId) ?? [])
    const nodeIdsByRank = new Map<number, string[]>()
    nodeIds.forEach((nodeId) => {
      const rank = ranks.get(nodeId) ?? 0
      nodeIdsByRank.set(rank, [...(nodeIdsByRank.get(rank) ?? []), nodeId])
    })

    const columnHeights = new Map<number, number>()
    nodeIdsByRank.forEach((ids, rank) => {
      const sorted = sortIds(ids)
      nodeIdsByRank.set(rank, sorted)
      const height = sorted.reduce((total, nodeId) => total + canvasNodeBounds(nodeById.get(nodeId)!).height, 0)
        + Math.max(0, sorted.length - 1) * inputGap
      columnHeights.set(rank, height)
    })
    const laneHeight = Math.max(260, ...columnHeights.values())

    nodeIdsByRank.forEach((ids, rank) => {
      let y = laneTop + (laneHeight - (columnHeights.get(rank) ?? 0)) / 2
      ids.forEach((nodeId) => {
        positions.set(nodeId, { x: columnX.get(rank) ?? 96, y })
        y += canvasNodeBounds(nodeById.get(nodeId)!).height + inputGap
      })
    })
    laneTop += laneHeight + laneGap
  }

  let leftoverY = laneTop + 36
  sortIds(leftovers).forEach((nodeId) => {
    positions.set(nodeId, { x: 96, y: leftoverY })
    leftoverY += canvasNodeBounds(nodeById.get(nodeId)!).height + inputGap
  })

  return cloned.map((node) => ({ ...node, position: positions.get(node.id) ?? { ...node.position } })) as CanvasNode[]
}
