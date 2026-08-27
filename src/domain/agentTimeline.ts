import type { AgentToolCallTrace, BotanicAgentRun, BotanicAgentRunBranch } from './agent.ts'
import {
  isCollapsedWebSearchToolName,
  isWebSourceToolName,
  mergeTimelineWebSources,
  type TimelineWebSource,
} from './agentTimelineWebSources.ts'

export type { TimelineWebSource } from './agentTimelineWebSources.ts'
export {
  displayWebSourceHostname,
  isCollapsedWebSearchToolName,
  isWebSourceToolName,
  mergeTimelineWebSources,
  timelineWebSourceHref,
} from './agentTimelineWebSources.ts'

export type TimelineStepKind = 'search' | 'fetch' | 'read_skill' | 'connect_runtime' | 'read' | 'write' | 'other'

/** thinking-orbs 的九态；只决定动画，不决定界面文案。 */
export type AgentTimelineOrbState =
  | 'working'
  | 'searching'
  | 'solving'
  | 'listening'
  | 'connecting'
  | 'weaving'
  | 'composing'
  | 'breathing'
  | 'shaping'

export type TimelineToolPresentation = {
  kind: TimelineStepKind
  title: string
  count?: number
  sources?: TimelineWebSource[]
}

export type TimelineBlock =
  | { id: string; type: 'thinking'; status: 'running' | 'done'; startedAt: number; endedAt?: number; text: string }
  | { id: string; type: 'narration'; text: string }
  | {
    id: string; type: 'step'; status: 'running' | 'succeeded' | 'failed'; kind: TimelineStepKind
    title: string; count?: number; sources?: TimelineWebSource[]; sourceToolIds: string[]
    /**
     * 失败原因。**没有它，界面只能显示一个「失败」**，看的人无从判断该改什么。
     * 实测线上就撞上了：两个写类工具调用连续失败，界面上只有两个红叉与
     * 「Writing project data · Failed」，测试的人完全不知道发生了什么。
     * 原始工具调用列表一直带着 `error`，只是这条时间线路径把它丢了。
     */
    error?: string
  }
  | { id: string; type: 'raw_group'; summary: string; open: boolean; items: AgentToolCallTrace[] }

export type AgentTimelineState = { blocks: TimelineBlock[] }

export type AgentTimelineEvent =
  | { type: 'reasoning'; step: number; delta: string; receivedAt: number }
  | { type: 'answer'; step: number; delta: string; receivedAt: number }
  | { type: 'tool'; step: number; toolCall: AgentToolCallTrace; presentation?: TimelineToolPresentation; receivedAt: number }
  | { type: 'done'; receivedAt: number }
  | { type: 'error'; message?: string; receivedAt: number }

type TimelineStepBlock = Extract<TimelineBlock, { type: 'step' }>

/**
 * 一个步骤当前的失败原因。
 *
 * 一个步骤可能聚合多个工具调用（例如多次搜索）。取**第一条失败的**原因而不是拼接
 * 全部：连着显示三条错误既读不完也帮不上忙，而第一条通常就是根因。
 */
function stepFailureReason(items: AgentToolCallTrace[], sourceToolIds: string[]) {
  const failed = sourceToolIds
    .map((id) => items.find((item) => item.id === id))
    .find((item) => item?.status === 'failed' && item.error?.trim())
  return failed?.error?.trim()
}
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

/** 与服务端 toolEventPresentation 对齐的已知工具标题；只做人话，不泄漏参数。 */
const knownTimelineToolTitles: Record<string, TimelineToolPresentation> = {
  ontology_read: { kind: 'read', title: '读取本体上下文' },
  project_memory_search: { kind: 'search', title: '检索项目记忆' },
  asset_group_search: { kind: 'search', title: '搜索素材组' },
  skill_search: { kind: 'search', title: '检索技能' },
  canvas_read: { kind: 'read', title: '读取画布上下文' },
  asset_search: { kind: 'search', title: '搜索素材' },
  skill_run: { kind: 'read_skill', title: '调用创作 Skill' },
  skill_create_propose: { kind: 'write', title: '提议创建项目 Skill' },
  mcp_propose: { kind: 'other', title: '提议 MCP 调用' },
  generation_ask_clarification: { kind: 'other', title: '确认生成参数' },
  generation_create_plan: { kind: 'write', title: '起草生成计划' },
  generate_images: { kind: 'write', title: '准备图片生成' },
  generate_videos: { kind: 'write', title: '准备视频生成' },
  decompose_creative_brief: { kind: 'other', title: '分解创意方案' },
  ask_clarification: { kind: 'other', title: '向用户提问' },
  workflow_create: { kind: 'write', title: '创建画布工作流' },
  generation_submit: { kind: 'write', title: '提交生成任务' },
  skill_apply: { kind: 'write', title: '应用项目 Skill' },
  skill_create: { kind: 'write', title: '创建项目 Skill' },
  mcp_call: { kind: 'other', title: '调用外部工具' },
}

/** 客户端兜底映射：服务端 presentation 缺失时仍只展示人话，不泄漏函数参数。禁止把未发生的步骤标成成功。 */
export function agentTimelineToolPresentation(call: AgentToolCallTrace): TimelineToolPresentation {
  const name = call.name.toLocaleLowerCase()
  const copy = `${call.name} ${call.label} ${call.summary ?? ''}`.toLocaleLowerCase()
  if (name === 'web_search' || name.startsWith('search_') || /(?:网页|网站|互联网|web|website).*(?:搜索|检索|search)/iu.test(copy)) {
    return { kind: 'search', title: '已搜索 1 个网站', count: 1 }
  }
  if (name === 'web_fetch' || /(?:网页获取|获取网页|web.?fetch)/iu.test(copy)) {
    return { kind: 'fetch', title: '正在获取网页' }
  }
  if (/^(?:skill_read|read_skill)$/u.test(name) || (name.includes('skill') && /(?:read|search|load|mount)/u.test(name)) || /skill\.md|mounted skill|已挂载 skill|技能指南/iu.test(copy)) {
    const label = skillLabel(call)
    return { kind: 'read_skill', title: label ? `读取${label}技能指南` : '读取技能指南' }
  }
  if (/^(?:browser_connect|playwright_connect|cdp_attach)$/u.test(name) || /(?:playwright|browser|cdp).*(?:connect|attach|连接)/iu.test(copy)) {
    return { kind: 'connect_runtime', title: '连接浏览器 runtime' }
  }
  const known = knownTimelineToolTitles[name]
  if (known) return { ...known }
  const kind: TimelineStepKind = call.risk === 'write' || call.risk === 'costly'
    ? 'write'
    : call.risk === 'read' ? 'read' : 'other'
  return {
    kind,
    title: call.summary?.trim() ? `${call.label} · ${call.summary.trim()}` : call.label,
  }
}

/**
 * 工具行 / 思考 pill 的球体动画态。
 * 只映射「播哪段动画」；标题、状态词、失败原因仍走 presentation / searchTitle。
 * 思考 pill 固定 breathing（MetalForge thinking-orbs `style=breathe`），不随工具步改态。
 */
export function agentTimelineOrbState(input: {
  surface?: 'thinking' | 'step'
  kind?: TimelineStepKind
  toolName?: string
} = {}): AgentTimelineOrbState {
  if (input.surface === 'thinking') return 'breathing'
  const name = input.toolName?.trim().toLocaleLowerCase() ?? ''
  if (
    name === 'web_search'
    || name.startsWith('search_')
    || /(?:^|_)(?:project_memory_search|asset_group_search|asset_search|skill_search|artifact_search)$/u.test(name)
  ) {
    return 'searching'
  }
  if (name === 'web_fetch' || name.startsWith('mcp_') || /^(?:browser_connect|playwright_connect|cdp_attach)$/u.test(name)) {
    return 'connecting'
  }
  if (name === 'subagent_research' || /^(?:skill_run|skill_read|read_skill|skill_apply)$/u.test(name)) {
    return 'weaving'
  }
  if (name === 'generation_create_plan' || name === 'decompose_creative_brief') return 'composing'
  if (
    name === 'generation_submit'
    || name === 'workflow_create'
    || name.startsWith('generate_')
  ) {
    return 'shaping'
  }
  if (name === 'ask_clarification' || name === 'generation_ask_clarification') return 'listening'

  switch (input.kind) {
    case 'search':
      return 'searching'
    case 'fetch':
    case 'connect_runtime':
      return 'connecting'
    case 'read_skill':
      return 'weaving'
    case 'read':
    case 'write':
    case 'other':
    default:
      return 'working'
  }
}

/** 从时间线 raw 工具列表解析步骤主工具名，供球体映射；没有则只按 kind。 */
export function agentTimelineStepToolName(
  block: Extract<TimelineBlock, { type: 'step' }>,
  items: AgentToolCallTrace[] = [],
) {
  for (const id of block.sourceToolIds) {
    const name = items.find((item) => item.id === id)?.name?.trim()
    if (name) return name
  }
  return undefined
}

/** 有站点摘要且步骤来自 web_search / web_fetch / search_* 时才画 pill。 */
export function timelineStepShowsWebSources(
  block: Extract<TimelineBlock, { type: 'step' }>,
  items: AgentToolCallTrace[] = [],
) {
  if (!block.sources?.length) return false
  return block.sourceToolIds.some((id) => {
    const name = items.find((item) => item.id === id)?.name
    return isWebSourceToolName(name)
  })
}

/** raw 底部不再重复铺网页搜索行；只剩搜索时整块不渲染。 */
export function timelineRawDisplayItems(items: AgentToolCallTrace[]) {
  return items.filter((item) => !isCollapsedWebSearchToolName(item.name))
}

function incomingWebSources(call: AgentToolCallTrace, presentation: TimelineToolPresentation) {
  return isWebSourceToolName(call.name) ? presentation.sources : undefined
}

function stepWithMergedSources(
  block: TimelineStepBlock,
  call: AgentToolCallTrace,
  presentation: TimelineToolPresentation,
): TimelineStepBlock {
  const sources = mergeTimelineWebSources(block.sources, incomingWebSources(call, presentation))
  if (sources?.length) return { ...block, sources }
  if (!block.sources) return block
  const { sources: _removed, ...rest } = block
  return rest
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
  const fetches = new Set(steps.filter((step) => step.kind === 'fetch').flatMap((step) => step.sourceToolIds)).size
  const reads = new Set(steps.filter((step) => step.kind === 'read').flatMap((step) => step.sourceToolIds)).size
  const writes = new Set(steps.filter((step) => step.kind === 'write').flatMap((step) => step.sourceToolIds)).size
  if (searchSteps.length) parts.push(`已搜索 ${searched} 个网站`)
  if (fetches) parts.push(`获取 ${fetches} 个网页`)
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
    const next: TimelineStepBlock = stepWithMergedSources({
      ...existing,
      status,
      kind: presentation.kind,
      title: presentation.kind === 'search' ? searchTitle(status, nextCount) : presentation.title,
      ...(nextCount === undefined ? {} : { count: nextCount }),
      // 恢复成功时清掉上一次的失败原因，否则一条已经跑通的步骤会一直挂着旧错误。
      ...(stepFailureReason(items, existing.sourceToolIds) ? { error: stepFailureReason(items, existing.sourceToolIds) } : { error: undefined }),
    }, event.toolCall, presentation)
    blocks[existingIndex] = next
    return { blocks: withRawGroup(blocks, items, rawGroup?.open ?? false) }
  }

  const last = blocks.at(-1)
  if (presentation.kind === 'search' && last?.type === 'step' && last.kind === 'search') {
    const sourceToolIds = [...last.sourceToolIds, event.toolCall.id]
    const nextCount = incomingStatus === 'succeeded' ? (last.count ?? 0) + incomingCount : last.count
    const status = aggregateStatus(sourceToolIds, items)
    blocks[blocks.length - 1] = stepWithMergedSources({
      ...last,
      sourceToolIds,
      status,
      title: searchTitle(status, nextCount),
      ...(nextCount === undefined ? {} : { count: nextCount }),
      ...(stepFailureReason(items, sourceToolIds) ? { error: stepFailureReason(items, sourceToolIds) } : { error: undefined }),
    }, event.toolCall, presentation)
  } else {
    const count = presentation.kind === 'search' && incomingStatus !== 'succeeded'
      ? undefined
      : knownCount(presentation.count)
    blocks.push(stepWithMergedSources({
      id: `step:${event.toolCall.id}`,
      type: 'step',
      status: incomingStatus,
      kind: presentation.kind,
      title: presentation.kind === 'search' ? searchTitle(incomingStatus, count) : presentation.title,
      ...(count === undefined ? {} : { count }),
      sourceToolIds: [event.toolCall.id],
      ...(event.toolCall.error?.trim() ? { error: event.toolCall.error.trim() } : {}),
    }, event.toolCall, presentation))
  }
  return { blocks: withRawGroup(blocks, items, rawGroup?.open ?? false) }
}

export function createAgentTimeline(startedAt: number): AgentTimelineState {
  return {
    blocks: [{ id: 'thinking', type: 'thinking', status: 'running', startedAt, text: '' }],
  }
}

/**
 * 回合结束后把 live 时间线收进旁路状态，避免清掉 liveConversation 后工具步骤消失。
 * 收口时把仍在转的思考标成结束；空时间线不写入。
 */
export function persistAgentLiveTimeline(
  timelines: Record<string, AgentTimelineState>,
  messageId: string,
  timeline: AgentTimelineState | undefined,
  receivedAt = Date.now(),
): Record<string, AgentTimelineState> {
  if (!timeline?.blocks.length) return timelines
  return { ...timelines, [messageId]: reduceAgentTimeline(timeline, { type: 'done', receivedAt }) }
}

/**
 * 把一轮对话的实时事件拆到两处：回答增量追加到正文，思考/工具进入时间线。
 * 正文只出现一次；时间线不再复制旁白。
 */
export function applyAgentConversationStreamEvent(
  state: { content: string; timeline: AgentTimelineState },
  event: AgentTimelineEvent,
): { content: string; timeline: AgentTimelineState } {
  if (event.type === 'answer') {
    if (!event.delta) return state
    return { content: `${state.content}${event.delta}`, timeline: state.timeline }
  }
  return { content: state.content, timeline: reduceAgentTimeline(state.timeline, event) }
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
  // 回答属于气泡正文，不进入时间线；连续工具步骤因此不会被旁白打断。
  if (event.type === 'answer') return prev
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

function branchStepStatus(status: BotanicAgentRunBranch['status']): TimelineStepBlock['status'] {
  if (status === 'failed' || status === 'cancelled') return 'failed'
  if (status === 'succeeded') return 'succeeded'
  return 'running'
}

function runSubmitStatus(run: Pick<BotanicAgentRun, 'status'>): TimelineStepBlock['status'] {
  if (run.status === 'failed' || run.status === 'cancelled') return 'failed'
  if (run.status === 'awaiting_confirmation') return 'running'
  return 'succeeded'
}

/**
 * 把已持久化的 Run / 分支状态投影为对话时间线步骤。
 * 只反映 Store 里的权威状态，不是动画脚本；未发生的步骤不会标成 succeeded。
 */
export function projectBotanicAgentRunOntoTimeline(
  run: Pick<BotanicAgentRun, 'id' | 'status' | 'branches' | 'error'>,
  previous: AgentTimelineState | undefined,
  now: number,
): AgentTimelineState {
  const preserved = (previous?.blocks ?? []).filter((block) => {
    if (block.type === 'thinking') return false
    if (block.type === 'step' && block.id.startsWith('exec:')) return false
    if (block.type === 'raw_group') return false
    return true
  })
  const submit: TimelineStepBlock = {
    id: 'exec:submit',
    type: 'step',
    status: runSubmitStatus(run),
    kind: 'write',
    title: '提交生成任务',
    sourceToolIds: [`run:${run.id}:submit`],
  }
  const branchSteps: TimelineStepBlock[] = run.branches.map((branch) => ({
    id: `exec:branch:${branch.id}`,
    type: 'step',
    status: branchStepStatus(branch.status),
    kind: 'write',
    title: branch.label.trim() ? `生成 · ${branch.label.trim()}` : '生成分支',
    sourceToolIds: [`run:${run.id}:branch:${branch.id}`],
  }))
  const thinkingDone: TimelineBlock = {
    id: 'thinking',
    type: 'thinking',
    status: 'done',
    startedAt: now,
    endedAt: now,
    text: '',
  }
  return { blocks: [thinkingDone, ...preserved, submit, ...branchSteps] }
}
