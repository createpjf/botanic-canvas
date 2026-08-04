import type { Edge } from '@xyflow/react'
import type { CanvasGenerationTaskStatus } from './canvas'

export type CanvasZoomMode = 'detail' | 'compact' | 'overview'

type GenerationTaskResultLabelInput = {
  generationKind?: 'generation' | 'refinement'
  status: CanvasGenerationTaskStatus
  previousTaskStatus?: CanvasGenerationTaskStatus
  error?: string
  currentLabel?: string
}

export function generationTaskResultLabel(input: GenerationTaskResultLabelInput) {
  const prefix = input.generationKind === 'refinement' ? '精修' : '首图'
  if (input.status === 'succeeded') return `${prefix}候选 · 等待选择`
  if (input.status === 'submission_unknown') return `${prefix}候选 · 等待确认`
  if (input.status !== 'failed') return input.currentLabel ?? `${prefix}候选`

  const error = input.error?.trim() ?? ''
  if (/请先登录|登录状态.*失效|重新登录/.test(error)) {
    return `${prefix}候选 · 登录已失效`
  }
  if (input.previousTaskStatus === 'uploading' && /(提交|等待).*(超时|超过.*分钟|停止等待)/.test(error)) {
    return `${prefix}候选 · 提交超时`
  }
  return input.currentLabel ?? `${prefix}候选`
}

export function generationTaskFeedback(status?: CanvasGenerationTaskStatus) {
  if (status === 'submission_unknown') {
    return {
      title: '正在恢复任务',
      detail: '请勿重复提交，联网后自动确认',
      recoverable: true,
    }
  }
  if (status === 'uploading') {
    return { title: '准备生成', detail: '正在锁定参考', recoverable: false }
  }
  if (status === 'queued') {
    return { title: '正在生成', detail: '已进入队列', recoverable: false }
  }
  return { title: '正在生成', detail: '可继续编辑画布', recoverable: false }
}

export function generationTaskErrorMessage(error?: string) {
  const message = error?.trim()
  if (!message) return undefined
  if (/^(failed to fetch|fetch failed|networkerror when attempting to fetch resource\.?)$/i.test(message)) {
    return '生成服务连接中断，请重试。'
  }
  return message
}

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
