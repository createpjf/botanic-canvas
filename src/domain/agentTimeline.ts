import type { AgentToolCallTrace } from './agent.ts'

export type TimelineStepKind = 'search' | 'read_skill' | 'connect_runtime' | 'read' | 'write' | 'other'

export type TimelineToolPresentation = {
  kind: TimelineStepKind
  title: string
  count?: number
}

export type TimelineBlock =
  | { id: string; type: 'thinking'; status: 'running' | 'done'; startedAt: number; endedAt?: number; text: string }
  | { id: string; type: 'narration'; text: string }
  | { id: string; type: 'step'; status: 'running' | 'succeeded' | 'failed'; kind: TimelineStepKind; title: string; count?: number; sourceToolIds: string[] }
  | { id: string; type: 'raw_group'; summary: string; open: boolean; items: AgentToolCallTrace[] }

export type AgentTimelineState = { blocks: TimelineBlock[] }

export type AgentTimelineEvent =
  | { type: 'reasoning'; step: number; delta: string; receivedAt: number }
  | { type: 'answer'; step: number; delta: string; receivedAt: number }
  | { type: 'tool'; step: number; toolCall: AgentToolCallTrace; presentation?: TimelineToolPresentation; receivedAt: number }
  | { type: 'done'; receivedAt: number }
  | { type: 'error'; message?: string; receivedAt: number }

type TimelineStepBlock = Extract<TimelineBlock, { type: 'step' }>
type TimelineRawGroupBlock = Extract<TimelineBlock, { type: 'raw_group' }>

function timelineRawGroup(blocks: TimelineBlock[]) {
  return blocks.find((block): block is TimelineRawGroupBlock => block.type === 'raw_group')
}

function semanticBlocks(blocks: TimelineBlock[]) {
  return blocks.filter((block) => block.type !== 'raw_group')
}

function knownCount(value: unknown) {
  const count = Number(value)
  return Number.isInteger(count) && count >= 0 ? count : undefined
}

function skillLabel(call: AgentToolCallTrace) {
  const label = call.label.trim()
    .replace(/^(?:读取|检索|搜索|加载|运行|调用)\s*/u, '')
    .replace(/(?:技能指南|指南|skill)$/iu, '')
    .trim()
  return label && !/^已审核$/u.test(label) ? label : ''
}

/** 客户端兜底映射：服务端 presentation 缺失时仍只展示人话，不泄漏函数参数。 */
export function agentTimelineToolPresentation(call: AgentToolCallTrace): TimelineToolPresentation {
  const name = call.name.toLocaleLowerCase()
  const copy = `${call.name} ${call.label} ${call.summary ?? ''}`.toLocaleLowerCase()
  if (name === 'web_search' || name.startsWith('search_') || /(?:网页|网站|互联网|web|website).*(?:搜索|检索|search)/iu.test(copy)) {
    return { kind: 'search', title: '已搜索 1 个网站', count: 1 }
  }
  if (/^(?:skill_read|read_skill)$/u.test(name) || (name.includes('skill') && /(?:read|search|load|mount)/u.test(name)) || /skill\.md|mounted skill|已挂载 skill|技能指南/iu.test(copy)) {
    const label = skillLabel(call)
    return { kind: 'read_skill', title: label ? `读取${label}技能指南` : '读取技能指南' }
  }
  if (/^(?:browser_connect|playwright_connect|cdp_attach)$/u.test(name) || /(?:playwright|browser|cdp).*(?:connect|attach|连接)/iu.test(copy)) {
    return { kind: 'connect_runtime', title: '连接浏览器 runtime' }
  }
  const kind: TimelineStepKind = call.risk === 'write' || call.risk === 'costly'
    ? 'write'
    : call.risk === 'read' ? 'read' : 'other'
  return {
    kind,
    title: call.summary?.trim() ? `${call.label} · ${call.summary.trim()}` : call.label,
  }
}

function stepStatus(status: AgentToolCallTrace['status']): TimelineStepBlock['status'] {
  if (status === 'failed') return 'failed'
  if (status === 'succeeded') return 'succeeded'
  return 'running'
}

function aggregateStatus(toolIds: string[], items: AgentToolCallTrace[]): TimelineStepBlock['status'] {
  const statuses = toolIds.map((id) => items.find((item) => item.id === id)?.status)
  if (statuses.some((status) => status === 'failed')) return 'failed'
  if (statuses.some((status) => status !== 'succeeded')) return 'running'
  return 'succeeded'
}

function searchTitle(status: TimelineStepBlock['status'], count?: number) {
  if (status === 'running') return count !== undefined ? `已搜索 ${count} 个网站，继续搜索中` : '正在搜索网站'
  if (status === 'failed') return count !== undefined ? `已搜索 ${count} 个网站，后续搜索失败` : '搜索网站失败'
  return `已搜索 ${count ?? 1} 个网站`
}

function rawSummary(blocks: TimelineBlock[], items: AgentToolCallTrace[]) {
  const steps = blocks.filter((block): block is TimelineStepBlock => block.type === 'step')
  const parts: string[] = []
  const searchSteps = steps.filter((step) => step.kind === 'search')
  const searched = searchSteps.reduce((total, step) => total + (step.count ?? 0), 0)
  const skillReads = new Set(steps.filter((step) => step.kind === 'read_skill').flatMap((step) => step.sourceToolIds)).size
  const runtimeConnections = new Set(steps.filter((step) => step.kind === 'connect_runtime').flatMap((step) => step.sourceToolIds)).size
  const reads = new Set(steps.filter((step) => step.kind === 'read').flatMap((step) => step.sourceToolIds)).size
  const writes = new Set(steps.filter((step) => step.kind === 'write').flatMap((step) => step.sourceToolIds)).size
  if (searchSteps.length) parts.push(`已搜索 ${searched} 个网站`)
  if (skillReads) parts.push(`读取 ${skillReads} 个技能指南`)
  if (runtimeConnections) parts.push(`连接 ${runtimeConnections} 次浏览器 runtime`)
  if (reads) parts.push(`读取 ${reads} 项内容`)
  if (writes) parts.push(`写入 ${writes} 项内容`)
  return parts.join('，') || `执行 ${items.length} 个工具调用`
}

function withRawGroup(
  blocks: TimelineBlock[],
  items: AgentToolCallTrace[],
  open: boolean,
): TimelineBlock[] {
  return [...semanticBlocks(blocks), {
    id: 'raw-tools',
    type: 'raw_group',
    summary: rawSummary(blocks, items),
    open,
    items,
  }]
}

function upsertRawItem(items: AgentToolCallTrace[], call: AgentToolCallTrace) {
  const index = items.findIndex((item) => item.id === call.id)
  if (index < 0) return [...items, call]
  return items.map((item, itemIndex) => itemIndex === index ? { ...item, ...call } : item)
}

function reduceToolEvent(state: AgentTimelineState, event: Extract<AgentTimelineEvent, { type: 'tool' }>): AgentTimelineState {
  const rawGroup = timelineRawGroup(state.blocks)
  const previousTrace = rawGroup?.items.find((item) => item.id === event.toolCall.id)
  const items = upsertRawItem(rawGroup?.items ?? [], event.toolCall)
  const presentation = event.presentation ?? agentTimelineToolPresentation(event.toolCall)
  const blocks = semanticBlocks(state.blocks)
  const existingIndex = blocks.findIndex((block) => block.type === 'step' && block.sourceToolIds.includes(event.toolCall.id))
  const incomingStatus = stepStatus(event.toolCall.status)
  const incomingCount = knownCount(presentation.count) ?? 1

  if (existingIndex >= 0) {
    const existing = blocks[existingIndex] as TimelineStepBlock
    const becameSucceeded = incomingStatus === 'succeeded' && previousTrace?.status !== 'succeeded'
    const nextCount = existing.kind === 'search'
      ? becameSucceeded
        ? existing.sourceToolIds.length === 1 ? incomingCount : (existing.count ?? 0) + incomingCount
        : existing.count
      : presentation.count ?? existing.count
    const status = aggregateStatus(existing.sourceToolIds, items)
    const next: TimelineStepBlock = {
      ...existing,
      status,
      kind: presentation.kind,
      title: presentation.kind === 'search' ? searchTitle(status, nextCount) : presentation.title,
      ...(nextCount === undefined ? {} : { count: nextCount }),
    }
    blocks[existingIndex] = next
    return { blocks: withRawGroup(blocks, items, rawGroup?.open ?? false) }
  }

  const last = blocks.at(-1)
  if (presentation.kind === 'search' && last?.type === 'step' && last.kind === 'search') {
    const sourceToolIds = [...last.sourceToolIds, event.toolCall.id]
    const nextCount = incomingStatus === 'succeeded' ? (last.count ?? 0) + incomingCount : last.count
    const status = aggregateStatus(sourceToolIds, items)
    blocks[blocks.length - 1] = {
      ...last,
      sourceToolIds,
      status,
      title: searchTitle(status, nextCount),
      ...(nextCount === undefined ? {} : { count: nextCount }),
    }
  } else {
    const count = presentation.kind === 'search' && incomingStatus !== 'succeeded'
      ? undefined
      : knownCount(presentation.count)
    blocks.push({
      id: `step:${event.toolCall.id}`,
      type: 'step',
      status: incomingStatus,
      kind: presentation.kind,
      title: presentation.kind === 'search' ? searchTitle(incomingStatus, count) : presentation.title,
      ...(count === undefined ? {} : { count }),
      sourceToolIds: [event.toolCall.id],
    })
  }
  return { blocks: withRawGroup(blocks, items, rawGroup?.open ?? false) }
}

export function createAgentTimeline(startedAt: number): AgentTimelineState {
  return {
    blocks: [{ id: 'thinking', type: 'thinking', status: 'running', startedAt, text: '' }],
  }
}

export function reduceAgentTimeline(prev: AgentTimelineState, event: AgentTimelineEvent): AgentTimelineState {
  if (event.type === 'reasoning') {
    const existing = prev.blocks.find((block) => block.type === 'thinking')
    if (!existing) {
      return { blocks: [{ id: 'thinking', type: 'thinking', status: 'running', startedAt: event.receivedAt, text: event.delta }, ...prev.blocks] }
    }
    return {
      blocks: prev.blocks.map((block) => block.type === 'thinking'
        ? { ...block, text: `${block.text}${event.delta}` }
        : block),
    }
  }
  if (event.type === 'answer') {
    if (!event.delta) return prev
    const rawGroup = timelineRawGroup(prev.blocks)
    const blocks = semanticBlocks(prev.blocks)
    const last = blocks.at(-1)
    if (last?.type === 'narration') blocks[blocks.length - 1] = { ...last, text: `${last.text}${event.delta}` }
    else blocks.push({ id: `narration:${blocks.filter((block) => block.type === 'narration').length + 1}`, type: 'narration', text: event.delta })
    return rawGroup ? { blocks: withRawGroup(blocks, rawGroup.items, rawGroup.open) } : { blocks }
  }
  if (event.type === 'tool') return reduceToolEvent(prev, event)
  if (event.type === 'done') {
    return {
      blocks: prev.blocks.map((block) => block.type === 'thinking' && block.status === 'running'
        ? { ...block, status: 'done', endedAt: event.receivedAt }
        : block),
    }
  }
  const rawGroup = timelineRawGroup(prev.blocks)
  const blocks = semanticBlocks(prev.blocks).map((block): TimelineBlock => {
    if (block.type === 'thinking' && block.status === 'running') return { ...block, status: 'done', endedAt: event.receivedAt }
    if (block.type === 'step' && block.status === 'running') return { ...block, status: 'failed' }
    return block
  })
  if (!rawGroup) return { blocks }
  const items = rawGroup.items.map((item) => item.status === 'running'
    ? { ...item, status: 'failed' as const, ...(event.message ? { error: event.message } : {}) }
    : item)
  return { blocks: withRawGroup(blocks, items, rawGroup.open) }
}
