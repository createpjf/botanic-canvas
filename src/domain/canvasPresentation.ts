import type { Edge } from '@xyflow/react'

export type CanvasZoomMode = 'detail' | 'compact' | 'overview'

export function canvasZoomMode(zoom: number): CanvasZoomMode {
  if (zoom < 0.36) return 'overview'
  if (zoom < 0.62) return 'compact'
  return 'detail'
}

export function traceCanvasLineage(selectedNodeIds: string[], edges: Edge[]) {
  const selected = [...new Set(selectedNodeIds.filter(Boolean))]
  if (!selected.length) return { nodeIds: new Set<string>(), edgeIds: new Set<string>() }

  const nodeIds = new Set(selected)
  const edgeIds = new Set<string>()
  const incoming = new Map<string, Edge[]>()
  const outgoing = new Map<string, Edge[]>()

  for (const edge of edges) {
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge])
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge])
  }

  const walk = (direction: 'upstream' | 'downstream') => {
    const queue = [...selected]
    const visited = new Set(selected)
    while (queue.length) {
      const nodeId = queue.shift()!
      const adjacent = direction === 'upstream' ? incoming.get(nodeId) : outgoing.get(nodeId)
      for (const edge of adjacent ?? []) {
        edgeIds.add(edge.id)
        const nextNodeId = direction === 'upstream' ? edge.source : edge.target
        nodeIds.add(nextNodeId)
        if (visited.has(nextNodeId)) continue
        visited.add(nextNodeId)
        queue.push(nextNodeId)
      }
    }
  }

  walk('upstream')
  walk('downstream')
  return { nodeIds, edgeIds }
}

export type ResultGroupMember = {
  id: string
  groupId?: string
  selected?: boolean
  active?: boolean
  hasDownstream?: boolean
  variant?: number
}

export type ResultGroupPresentation = {
  groupId: string
  activeId: string
  index: number
  total: number
  expanded: boolean
  representative: boolean
  promoted: boolean
  hidden: boolean
}

export function planResultGroupPresentation(
  members: ResultGroupMember[],
  expandedGroupIds: ReadonlySet<string>,
) {
  const groups = new Map<string, ResultGroupMember[]>()
  for (const member of members) {
    if (!member.groupId) continue
    groups.set(member.groupId, [...(groups.get(member.groupId) ?? []), member])
  }

  const presentation = new Map<string, ResultGroupPresentation>()
  for (const [groupId, groupMembers] of groups) {
    if (groupMembers.length < 2) continue
    const ordered = [...groupMembers].sort((left, right) => {
      const variantDifference = (left.variant ?? Number.MAX_SAFE_INTEGER) - (right.variant ?? Number.MAX_SAFE_INTEGER)
      return variantDifference || left.id.localeCompare(right.id)
    })
    const foldable = ordered.filter((member) => !member.hasDownstream)
    if (!foldable.length) continue
    // 只有未形成下游分支的候选进入结果组；第一张始终作为稳定画布锚点。
    const representativeId = foldable[0].id
    const activeId = foldable.find((member) => member.active)?.id
      ?? foldable.find((member) => member.selected)?.id
      ?? representativeId
    const activeIndex = ordered.findIndex((member) => member.id === activeId)
    const expanded = expandedGroupIds.has(groupId)
    ordered.forEach((member, index) => presentation.set(member.id, {
      groupId,
      activeId,
      index: member.id === representativeId ? activeIndex + 1 : index + 1,
      total: ordered.length,
      expanded,
      representative: member.id === representativeId,
      promoted: Boolean(member.hasDownstream),
      // 展开仅在锚点内部显示卡片，不把散落的原始候选重新放回画布。
      hidden: !member.hasDownstream && member.id !== representativeId,
    }))
  }
  return presentation
}
