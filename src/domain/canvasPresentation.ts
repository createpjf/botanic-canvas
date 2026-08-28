import type { Edge } from '@xyflow/react'
import { botanicAgentNodeTitleLimit, clipBotanicAgentNodeTitle } from './agent.ts'
import type { CanvasGenerationTaskStatus } from './canvas'
import type { ProductLocale } from '../i18n/core'

export type CanvasZoomMode = 'detail' | 'compact' | 'overview'

type GenerationTaskResultLabelInput = {
  generationKind?: 'generation' | 'refinement'
  status: CanvasGenerationTaskStatus
  previousTaskStatus?: CanvasGenerationTaskStatus
  error?: string
  currentLabel?: string
}

/** 旧结果节点名「首图候选 / 精修候选」只改展示与打开时迁移，不碰幂等键。 */
export function displayGenerationResultLabel(value: string) {
  const match = value.match(/^(首图|精修)候选(?: · (.+))?$/)
  if (!match) return value
  return match[2] ? `${match[1]} · ${match[2]}` : match[1]
}

export function generationTaskResultLabel(input: GenerationTaskResultLabelInput) {
  const prefix = input.generationKind === 'refinement' ? '精修' : '首图'
  if (input.status === 'succeeded') return input.currentLabel?.trim() || `${prefix} · 等待选择`
  if (input.status === 'submission_unknown') return `${prefix} · 等待确认`
  if (input.status !== 'failed') return input.currentLabel ?? prefix

  const error = input.error?.trim() ?? ''
  if (/请先登录|登录状态.*失效|重新登录/.test(error)) {
    return `${prefix} · 登录已失效`
  }
  if (input.previousTaskStatus === 'uploading' && /(提交|等待).*(超时|超过.*分钟|停止等待)/.test(error)) {
    return `${prefix} · 提交超时`
  }
  return input.currentLabel ?? prefix
}

const genericGenerateLabels = new Set(['图像生成', '视频生成', '定向精修', 'Agent 生成'])

/** 新图节点名只保留短标题，不用 Prompt 原文。 */
export function generationResultNodeLabel(input: {
  kind: 'generation' | 'refinement'
  title?: string
  generateLabel?: string
  parentLabel?: string
  variant?: number
  batchCount?: number
  prompt?: string
}) {
  const preferred = clipBotanicAgentNodeTitle(input.title ?? '')
    || (!genericGenerateLabels.has((input.generateLabel ?? '').trim())
      ? clipBotanicAgentNodeTitle(input.generateLabel ?? '')
      : '')
    || (input.kind === 'refinement' ? clipBotanicAgentNodeTitle(input.parentLabel ?? '') : '')
    || (input.kind === 'refinement' ? '新版本' : '创意图')
  const variant = input.variant ?? 0
  const batchCount = input.batchCount ?? 1
  if (batchCount <= 1 && variant === 0) return preferred
  const suffix = String(variant + 1)
  const room = Math.max(1, botanicAgentNodeTitleLimit - suffix.length)
  return `${Array.from(preferred).slice(0, room).join('')}${suffix}`
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

/**
 * 服务端错误码 → 双语文案，只收「这条分支引入、且已确认会透传给用户」的错误码。
 *
 * `IMAGE_TOO_LARGE_PIXELS` 是目前唯一一个（`git log -p` 追溯过 `PROVIDER_REJECTED`
 * ——它是这条分支之前就有的码，分支内只改了文案，不算新引入）。不要为每个
 * job.error 都加一条：未登记的错误码继续走下面「服务端原始文案直传」的旧路径，
 * 这是有意的兜底范围控制，不是遗漏。
 *
 * 像素上限报错的服务端原文带具体像素数（如「超过 4096x4096」），这里换成不带
 * 数字的静态双语文案——判断力取舍：数字对中文用户本来能看到，换成静态文案后
 * 中文侧也损失了这点精确度，但两语言各自维护一条动态插值文案超出了本次范围。
 */
const GENERATION_JOB_ERROR_MESSAGES: Partial<Record<string, Record<ProductLocale, string>>> = {
  IMAGE_TOO_LARGE_PIXELS: {
    'zh-CN': '图片像素过大，请压缩后重试。',
    en: 'The image resolution is too large. Resize it and try again.',
  },
}

/** 已登记错误码的双语文案；未登记返回 undefined，调用方应退回旧的直传逻辑。 */
export function generationJobErrorCopy(errorCode: string | undefined, locale: ProductLocale) {
  if (!errorCode) return undefined
  return GENERATION_JOB_ERROR_MESSAGES[errorCode]?.[locale]
}

export function generationTaskErrorMessage(error?: string, errorCode?: string, locale: ProductLocale = 'zh-CN') {
  const known = generationJobErrorCopy(errorCode, locale)
  if (known) return known
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
  hasOutput?: boolean
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
    if (!member.groupId || member.hasOutput === false) continue
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
