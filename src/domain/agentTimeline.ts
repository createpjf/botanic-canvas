import { isBotanicAgentProcessLabel, type AgentToolCallTrace, type BotanicAgentRun, type BotanicAgentRunBranch } from './agent.ts'
import {
  isCollapsedWebSearchToolName,
  isWebSourceToolName,
  mergeTimelineWebSources,
  safeTimelineWebSources,
  type TimelineWebSource,
} from './agentTimelineWebSources.ts'

export type { TimelineWebSource } from './agentTimelineWebSources.ts'
export {
  displayWebSourceHostname,
  isCollapsedWebSearchToolName,
  isWebSourceToolName,
  mergeTimelineWebSources,
  safeTimelineWebSources,
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
    title: string; summary?: string; count?: number; sources?: TimelineWebSource[]; sourceToolIds: string[]
    /** 第一次收到该步骤工具事件的时间；accordion 用它推耗时，不改 ToolCall 契约。 */
    startedAt?: number
    /** 步骤进入 succeeded / failed 的时间。 */
    endedAt?: number
    /**
     * 失败原因。**没有它，界面只能显示一个「失败」**，看的人无从判断该改什么。
     * 实测线上就撞上了：两个写类工具调用连续失败，界面上只有两个红叉与
     * 「Writing project data · Failed」，测试的人完全不知道发生了什么。
     * 原始工具调用列表一直带着 `error`，只是这条时间线路径把它丢了。
     */
    error?: string
    /** 服务端 Job 错误码；对话失败步用 `generationTaskErrorMessage` 出文案，不是每次都有。 */
    errorCode?: string
  }
  | { id: string; type: 'raw_group'; summary: string; open: boolean; items: AgentToolCallTrace[] }

export type AgentTimelineState = {
  blocks: TimelineBlock[]
  truncation?: { loadedCount: number; nextAfter: number }
}

export type AgentTimelineEvent =
  | { type: 'reasoning'; step: number; delta: string; receivedAt: number }
  | { type: 'answer'; step: number; delta: string; receivedAt: number }
  | { type: 'tool'; step: number; toolCall: AgentToolCallTrace; presentation?: TimelineToolPresentation; receivedAt: number }
  | { type: 'handoff'; receivedAt: number }
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
  const blocks = semanticBlocks(state.blocks).map((block): TimelineBlock => (
    block.type === 'thinking' && block.status === 'running'
      ? { ...block, status: 'done', endedAt: event.receivedAt }
      : block
  ))
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
      startedAt: existing.startedAt ?? event.receivedAt,
      ...(status === 'running'
        ? { endedAt: undefined }
        : { endedAt: existing.endedAt ?? event.receivedAt }),
      ...(event.toolCall.summary?.trim()
        ? { summary: event.toolCall.summary.trim() }
        : existing.summary ? { summary: existing.summary } : {}),
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
      startedAt: last.startedAt ?? event.receivedAt,
      ...(status === 'running'
        ? { endedAt: undefined }
        : { endedAt: last.endedAt ?? event.receivedAt }),
      ...(event.toolCall.summary?.trim()
        ? { summary: event.toolCall.summary.trim() }
        : last.summary ? { summary: last.summary } : {}),
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
      startedAt: event.receivedAt,
      ...(incomingStatus === 'running' ? {} : { endedAt: event.receivedAt }),
      ...(event.toolCall.summary?.trim() ? { summary: event.toolCall.summary.trim() } : {}),
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
  if (event.type === 'handoff') return prev
  if (event.type === 'reasoning') {
    const rawGroup = timelineRawGroup(prev.blocks)
    const blocks = semanticBlocks(prev.blocks)
    const activeIndex = blocks.map((block) => block.type === 'thinking' && block.status === 'running').lastIndexOf(true)
    if (activeIndex < 0) {
      blocks.push({
        id: `thinking:${event.step}:${blocks.filter((block) => block.type === 'thinking').length}`,
        type: 'thinking',
        status: 'running',
        startedAt: event.receivedAt,
        text: event.delta,
      })
      return { blocks: rawGroup ? withRawGroup(blocks, rawGroup.items, rawGroup.open) : blocks }
    }
    const active = blocks[activeIndex]
    if (active.type === 'thinking') blocks[activeIndex] = { ...active, text: `${active.text}${event.delta}` }
    return { blocks: rawGroup ? withRawGroup(blocks, rawGroup.items, rawGroup.open) : blocks }
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

function runSubmitStatus(run: Pick<BotanicAgentRun, 'status' | 'branches'>): TimelineStepBlock['status'] {
  if (run.status === 'awaiting_confirmation') return 'running'
  // 已经分支出图，提交本身过了；Run 失败写在出图步骤上，不重复标提交失败。
  if ((run.status === 'failed' || run.status === 'cancelled') && !(run.branches?.length)) return 'failed'
  return 'succeeded'
}

type TimelineJobFailure = { id: string; error?: string; errorCode?: string }

function resolveBranchJob(branch: Pick<BotanicAgentRunBranch, 'activeJobId' | 'jobIds'>, jobs?: readonly TimelineJobFailure[]) {
  if (!jobs?.length) return undefined
  if (branch.activeJobId) {
    const active = jobs.find((job) => job.id === branch.activeJobId)
    if (active) return active
  }
  for (let index = (branch.jobIds?.length ?? 0) - 1; index >= 0; index -= 1) {
    const found = jobs.find((job) => job.id === branch.jobIds[index])
    if (found) return found
  }
}

function timelineFailureFields(error?: string, errorCode?: string): Pick<TimelineStepBlock, 'error' | 'errorCode'> {
  return {
    ...(error ? { error } : {}),
    ...(errorCode ? { errorCode } : {}),
  }
}

/**
 * 把已持久化的 Run / 分支状态投影为对话时间线步骤。
 * 只反映 Store 里的权威状态，不是动画脚本；未发生的步骤不会标成 succeeded。
 * 失败原因读 Job（经 `activeJobId`），没有 Job 再回退分支 / Run 上的文案；不编造。
 */
export function projectBotanicAgentRunOntoTimeline(
  run: Pick<BotanicAgentRun, 'id' | 'status' | 'branches' | 'error'>,
  previous: AgentTimelineState | undefined,
  _now: number,
  jobs?: readonly TimelineJobFailure[],
): AgentTimelineState {
  // 规划期的思考正文与 tool-call 明细（raw_group）是用户已看到的过程，投影不抹历史；
  // 只丢空思考与旧的 exec: 管道步（由本次权威状态重建）。
  const preserved = (previous?.blocks ?? []).filter((block) => {
    if (block.type === 'thinking') return Boolean(block.text.trim())
    if (block.type === 'step' && block.id.startsWith('exec:')) return false
    return true
  })
  const submitStatus = runSubmitStatus(run)
  const submit: TimelineStepBlock = {
    id: 'exec:submit',
    type: 'step',
    status: submitStatus,
    kind: 'write',
    title: '提交生成任务',
    sourceToolIds: [`run:${run.id}:submit`],
    ...(submitStatus === 'failed' ? timelineFailureFields(run.error) : {}),
  }
  const branchSteps: TimelineStepBlock[] = run.branches.map((branch) => {
    const status = branchStepStatus(branch.status)
    const job = status === 'failed' ? resolveBranchJob(branch, jobs) : undefined
    return {
      id: `exec:branch:${branch.id}`,
      type: 'step',
      status,
      kind: 'write',
      title: branch.label.trim() && !isBotanicAgentProcessLabel(branch.label) ? `生成 · ${branch.label.trim()}` : '生成',
      sourceToolIds: [`run:${run.id}:branch:${branch.id}`],
      ...(status === 'failed' ? timelineFailureFields(job?.error ?? branch.error, job?.errorCode) : {}),
    }
  })
  return { blocks: [...preserved, submit, ...branchSteps] }
}

function isSilentThinkingBlock(block: TimelineBlock) {
  if (block.type !== 'thinking') return false
  if (block.status === 'running') return false
  const elapsed = (block.endedAt ?? block.startedAt) - block.startedAt
  return elapsed < 1_000 && !block.text.trim()
}

function isSubmitStep(block: TimelineBlock): block is TimelineStepBlock {
  return block.type === 'step' && block.kind === 'write' && /提交/u.test(block.title)
}

function isGenerateStep(block: TimelineBlock): block is TimelineStepBlock {
  return block.type === 'step' && block.kind === 'write' && (/^生成/u.test(block.title) || /等待生成结果/u.test(block.title))
}

function isPrepareStep(block: TimelineBlock): block is TimelineStepBlock {
  return block.type === 'step' && block.kind === 'write' && /准备/u.test(block.title)
}

/** 出图管道步：提交 / 规划 / 出图。这些走动作行；其余 tool-call 进 accordion。 */
export function isAgentPipelineTimelineStep(block: TimelineBlock): block is TimelineStepBlock {
  return isSubmitStep(block) || isGenerateStep(block) || isPrepareStep(block)
}

export type AgentToolAccordionRowStatus = 'running' | 'succeeded' | 'failed'

export type AgentToolAccordionRow = {
  id: string
  kind: TimelineStepKind
  toolName: string
  verb: string
  detail: string
  status: AgentToolAccordionRowStatus
  durationMs?: number
  error?: string
  callCount?: number
  calls?: AgentToolAccordionRow[]
}

export type AgentToolAccordionGroup = {
  id: string
  title: string
  status: AgentToolAccordionRowStatus
  open: boolean
  rows: AgentToolAccordionRow[]
}

export type AgentToolAccordionView = {
  elapsedMs: number
  groups: AgentToolAccordionGroup[]
}

function isMcpToolName(name: string) {
  const lower = name.toLocaleLowerCase()
  return lower === 'mcp_call' || lower.startsWith('mcp_')
}

/**
 * 时间线 / accordion 行图标：按工具类别固定映射，不给每条工具单独画图形。
 * Lucide：默认 wrench；搜索 search-code；读文件 file-text；shell square-terminal；MCP 无品牌 logo 时 unplug。
 */
export type AgentToolIconKey =
  | 'wrench'
  | 'hammer'
  | 'search-code'
  | 'file-search'
  | 'file-text'
  | 'square-terminal'
  | 'globe'
  | 'mouse-pointer-click'
  | 'unplug'
  | 'sparkles'
  | 'image'
  | 'list-todo'

export function agentToolIconKey(input: {
  toolName?: string
  kind?: TimelineStepKind
  label?: string
} = {}): AgentToolIconKey {
  const name = (input.toolName ?? '').toLocaleLowerCase()
  const label = (input.label ?? '').toLocaleLowerCase()
  const copy = `${name} ${label}`

  if (isMcpToolName(name) || /\bmcp\b/u.test(copy)) return 'unplug'
  if (/(?:^|_)(?:shell|terminal|bash|zsh|cmd)(?:$|_)/u.test(name) || /(?:square.?terminal|终端|shell)/u.test(copy)) {
    return 'square-terminal'
  }
  if (/(?:mouse|pointer).*click|browser_click|playwright_click|点击/u.test(copy)) return 'mouse-pointer-click'
  if (
    input.kind === 'fetch'
    || input.kind === 'connect_runtime'
    || name === 'web_fetch'
    || /(?:browser_connect|playwright|cdp_attach|网页|browse|globe)/u.test(copy)
  ) {
    return 'globe'
  }
  if (/(?:file_search|asset_search|asset_group_search)/u.test(name) || /(?:搜文件|file.?search)/u.test(copy)) {
    return 'file-search'
  }
  if (
    input.kind === 'search'
    || name === 'web_search'
    || name.startsWith('search_')
    || /_search$/u.test(name)
    || /(?:搜索|检索|search-code|grep)/u.test(copy)
  ) {
    return 'search-code'
  }
  if (
    input.kind === 'read'
    || input.kind === 'read_skill'
    || /(?:ontology_read|canvas_read|skill_read|file_read|file_text)/u.test(name)
    || /(?:^|_)read(?:$|_)/u.test(name)
    || /(?:读文件|技能指南|file-text)/u.test(copy)
  ) {
    return 'file-text'
  }
  if (/(?:generate_images|image_generation)/u.test(name) || /(?:^|_)image(?:$|_)/u.test(name)) return 'image'
  if (/(?:generate_|generation_|sparkle)/u.test(name) || /(?:出图|生成中)/u.test(copy)) return 'sparkles'
  if (/(?:clarification|decompose|create_plan|list_todo|todo)/u.test(name) || /(?:待办|\bplan\b)/u.test(copy)) {
    return 'list-todo'
  }
  if (input.kind === 'write' || /(?:skill_run|skill_apply|skill_create|workflow_|hammer)/u.test(name)) {
    return 'hammer'
  }
  return 'wrench'
}

/** 从 MCP 文案抽出 server 名，供品牌 logo；没有 logo 时 UI 回退 unplug。 */
export function agentMcpServerIdFromLabel(label?: string) {
  const text = label?.trim() ?? ''
  const matched = text.match(/(?:MCP[：:]\s*|调用\s*MCP[：:]\s*)([a-z0-9._-]+)\./iu)
    ?? text.match(/\b([a-z][a-z0-9_-]*)\.[a-z][a-z0-9_.-]*\b/iu)
  return matched?.[1]?.toLocaleLowerCase()
}

/** 已知 MCP server → 静态品牌图。未登记的用 unplug。 */
export function agentMcpServerBrandLogoSrc(serverId?: string) {
  if (!serverId) return undefined
  const logos: Record<string, string> = {
    // 有品牌资产后再登记；例如 figma: '/mcp-logos/figma.svg'
  }
  return logos[serverId]
}

function toolCallRowStatus(status: AgentToolCallTrace['status']): AgentToolAccordionRowStatus {
  if (status === 'failed') return 'failed'
  if (status === 'succeeded') return 'succeeded'
  return 'running'
}

function toolAccordionVerb(kind: TimelineStepKind, status: AgentToolAccordionRowStatus, locale: string) {
  const en = locale === 'en'
  if (kind === 'search') {
    if (status === 'running') return en ? 'Searching' : '正在检索'
    if (status === 'failed') return en ? 'Search failed' : '检索失败'
    return en ? 'Searched' : '已检索'
  }
  if (kind === 'fetch') {
    if (status === 'running') return en ? 'Fetching' : '正在获取'
    if (status === 'failed') return en ? 'Fetch failed' : '获取失败'
    return en ? 'Fetched' : '已获取'
  }
  if (kind === 'read_skill' || kind === 'read') {
    if (status === 'running') return en ? 'Reading' : '正在读取'
    if (status === 'failed') return en ? 'Read failed' : '读取失败'
    return en ? 'Read' : '已读取'
  }
  if (kind === 'connect_runtime') {
    if (status === 'running') return en ? 'Connecting' : '正在连接'
    if (status === 'failed') return en ? 'Connection failed' : '连接失败'
    return en ? 'Connected' : '已连接'
  }
  if (kind === 'write') {
    if (status === 'running') return en ? 'Running' : '正在运行'
    if (status === 'failed') return en ? 'Run failed' : '运行失败'
    return en ? 'Ran' : '已运行'
  }
  if (status === 'running') return en ? 'Running' : '正在运行'
  if (status === 'failed') return en ? 'Failed' : '失败'
  return en ? 'Completed' : '已获取'
}

function toolAccordionDetail(call: AgentToolCallTrace) {
  const summary = call.summary?.trim()
  if (summary) return summary
  const label = call.label.trim()
  const stripped = label
    .replace(/^(?:正在)?(?:读取|检索|搜索|获取|运行|调用|应用)\s*/u, '')
    .trim()
  return stripped || label || call.name
}

function toolAccordionDurationMs(startedAt?: number, endedAt?: number) {
  if (startedAt === undefined || endedAt === undefined) return undefined
  const duration = endedAt - startedAt
  return duration >= 1_000 ? duration : undefined
}

function aggregateAccordionStatus(statuses: AgentToolAccordionRowStatus[]): AgentToolAccordionRowStatus {
  if (statuses.some((status) => status === 'failed')) return 'failed'
  if (statuses.some((status) => status === 'running')) return 'running'
  return 'succeeded'
}

function buildToolAccordionRow(
  call: AgentToolCallTrace,
  timing?: { startedAt?: number; endedAt?: number },
  locale = 'zh-CN',
): AgentToolAccordionRow {
  const presentation = agentTimelineToolPresentation(call)
  const status = toolCallRowStatus(call.status)
  const durationMs = toolAccordionDurationMs(timing?.startedAt, timing?.endedAt)
  const verb = durationMs !== undefined && status === 'succeeded'
    ? (locale === 'en'
      ? `Ran in ${Math.round(durationMs / 1_000)}s`
      : `已在 ${Math.round(durationMs / 1_000)}s 内运行`)
    : toolAccordionVerb(presentation.kind, status, locale)
  return {
    id: call.id,
    kind: presentation.kind,
    toolName: call.name,
    verb,
    detail: toolAccordionDetail(call),
    status,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(call.error?.trim() ? { error: call.error.trim() } : {}),
  }
}

/** 连续同名 MCP 收成一行；点开再看每次 call。 */
function mergeMcpAccordionRows(rows: AgentToolAccordionRow[], locale: string): AgentToolAccordionRow[] {
  const merged: AgentToolAccordionRow[] = []
  for (const row of rows) {
    const previous = merged.at(-1)
    if (
      previous
      && isMcpToolName(previous.toolName)
      && isMcpToolName(row.toolName)
      && previous.toolName === row.toolName
      && !previous.calls
    ) {
      const calls = [...(previous.calls ?? [{ ...previous, callCount: undefined }]), row]
      const status = aggregateAccordionStatus(calls.map((call) => call.status))
      const verb = toolAccordionVerb(previous.kind, status, locale)
      merged[merged.length - 1] = {
        ...previous,
        id: `${previous.id}+${row.id}`,
        status,
        verb,
        detail: previous.detail,
        callCount: calls.length,
        calls,
        ...(calls.find((call) => call.error)?.error ? { error: calls.find((call) => call.error)?.error } : { error: undefined }),
      }
      continue
    }
    if (
      previous?.calls
      && isMcpToolName(previous.toolName)
      && isMcpToolName(row.toolName)
      && previous.toolName === row.toolName
    ) {
      const calls = [...previous.calls, row]
      const status = aggregateAccordionStatus(calls.map((call) => call.status))
      merged[merged.length - 1] = {
        ...previous,
        id: `${previous.id}+${row.id}`,
        status,
        verb: toolAccordionVerb(previous.kind, status, locale),
        callCount: calls.length,
        calls,
        ...(calls.find((call) => call.error)?.error ? { error: calls.find((call) => call.error)?.error } : { error: undefined }),
      }
      continue
    }
    merged.push(row)
  }
  return merged.map((row) => {
    if (!row.callCount || row.callCount < 2) return row
    const en = locale === 'en'
    return {
      ...row,
      detail: en
        ? `${row.detail} · ${row.callCount} calls`
        : `${row.detail} · ${row.callCount} calls`,
    }
  })
}

function accordionGroupTitle(step: TimelineStepBlock | undefined, rows: AgentToolAccordionRow[], locale: string) {
  if (step) {
    const titled = conversationTimelineStepTitle(step, locale)
    if (titled) return titled.replace(/…$/u, '')
    return step.title
  }
  const running = rows.find((row) => row.status === 'running')
  if (running) return running.detail || running.verb
  const last = rows.at(-1)
  if (!last) return locale === 'en' ? 'Tool calls' : '工具调用'
  return last.detail || last.verb
}

function timelineElapsedMs(timeline: AgentTimelineState, now: number) {
  // 一整段区间：最早的思考/步骤开始 → 全部结算后的最晚结束；仍有 running 就用 now，
  // 不能在思考结束后冻住（后面的工具还在跑）。
  let startedAt: number | undefined
  let endedAt = 0
  let running = false
  for (const block of timeline.blocks) {
    if (block.type === 'thinking') {
      startedAt = startedAt === undefined ? block.startedAt : Math.min(startedAt, block.startedAt)
      if (block.status === 'running') running = true
      else endedAt = Math.max(endedAt, block.endedAt ?? block.startedAt)
    } else if (block.type === 'step') {
      if (block.status === 'running') running = true
      if (block.startedAt === undefined) continue
      startedAt = startedAt === undefined ? block.startedAt : Math.min(startedAt, block.startedAt)
      if (block.status !== 'running') endedAt = Math.max(endedAt, block.endedAt ?? block.startedAt)
    }
  }
  if (startedAt === undefined) return 0
  return Math.max(0, (running ? now : endedAt) - startedAt)
}

/** 时间线是否有能画出来的内容；空时间线时气泡仍要显示「正在规划」占位。 */
export function agentTimelineHasRenderableContent(timeline: AgentTimelineState) {
  return timeline.blocks.some((block) => {
    if (block.type === 'thinking') return Boolean(block.text.trim())
    if (block.type === 'raw_group') return block.items.length > 0
    return true
  })
}

/**
 * 对话里的 collapsible tool-call accordion。
 * 只投影真实 tool call；出图管道步不进这里。
 */
export function presentAgentToolAccordion(
  timeline: AgentTimelineState,
  locale = 'zh-CN',
  now = Date.now(),
): AgentToolAccordionView | null {
  const rawItems = timelineRawGroup(timeline.blocks)?.items ?? []
  const steps = semanticBlocks(timeline.blocks).filter((block): block is TimelineStepBlock => (
    block.type === 'step' && !isAgentPipelineTimelineStep(block)
  ))
  if (!steps.length && !rawItems.length) return null

  const timingByToolId = new Map<string, { startedAt?: number; endedAt?: number }>()
  for (const step of steps) {
    for (const id of step.sourceToolIds) {
      // 单工具步骤的耗时可信；聚合搜索步只在整步结束时给最后一次调用挂耗时意义不大，整步时间挂在唯一 id 上即可。
      if (step.sourceToolIds.length === 1 || !timingByToolId.has(id)) {
        timingByToolId.set(id, { startedAt: step.startedAt, endedAt: step.endedAt })
      }
    }
  }

  const pipelineToolIds = new Set(
    semanticBlocks(timeline.blocks)
      .filter(isAgentPipelineTimelineStep)
      .flatMap((block) => block.sourceToolIds),
  )

  const orderedCalls = (() => {
    if (rawItems.length) {
      return rawItems.filter((item) => !pipelineToolIds.has(item.id) && !isCollapsedWebSearchToolName(item.name))
    }
    // 没有 raw_group 时（计划卡投影）按步骤顺序展开。
    return steps.flatMap((step) => step.sourceToolIds.map((id) => {
      const fromRaw = rawItems.find((item) => item.id === id)
      if (fromRaw) return fromRaw
      return {
        id,
        name: agentTimelineStepToolName(step) ?? step.kind,
        label: step.title,
        risk: 'read' as const,
        status: step.status === 'failed' ? 'failed' as const : step.status === 'succeeded' ? 'succeeded' as const : 'running' as const,
        requiresConfirmation: false,
        ...(step.summary ? { summary: step.summary } : {}),
        ...(step.error ? { error: step.error } : {}),
      } satisfies AgentToolCallTrace
    }))
  })()

  // 搜索步本身仍要出现：raw 里网页搜索被收起时，用语义步骤补一行。
  const searchStepsMissingRows = steps.filter((step) => (
    step.kind === 'search'
    && step.sourceToolIds.every((id) => !orderedCalls.some((call) => call.id === id))
  ))
  for (const step of searchStepsMissingRows) {
    orderedCalls.push({
      id: step.sourceToolIds[0] ?? step.id,
      name: 'web_search',
      label: step.title,
      risk: 'read',
      status: step.status === 'failed' ? 'failed' : step.status === 'succeeded' ? 'succeeded' : 'running',
      requiresConfirmation: false,
      ...(step.summary ? { summary: step.summary } : {}),
      ...(step.error ? { error: step.error } : {}),
    })
    timingByToolId.set(step.sourceToolIds[0] ?? step.id, { startedAt: step.startedAt, endedAt: step.endedAt })
  }

  if (!orderedCalls.length) return null

  const rows = mergeMcpAccordionRows(
    orderedCalls.map((call) => buildToolAccordionRow(call, timingByToolId.get(call.id), locale)),
    locale,
  )
  const status = aggregateAccordionStatus(rows.map((row) => row.status))
  const focusStep = steps.find((step) => step.status === 'running') ?? steps.at(-1)
  const group: AgentToolAccordionGroup = {
    id: 'tools',
    title: accordionGroupTitle(focusStep, rows, locale),
    status,
    open: status === 'running',
    rows,
  }
  return {
    elapsedMs: timelineElapsedMs(timeline, now),
    groups: [group],
  }
}

/** 计划卡上的 toolCalls，没有 live 时间线时复用同一套 accordion。 */
export function presentAgentToolAccordionFromCalls(
  toolCalls: AgentToolCallTrace[],
  locale = 'zh-CN',
  startedAt?: number,
  now = Date.now(),
): AgentToolAccordionView | null {
  if (!toolCalls.length) return null
  const rows = mergeMcpAccordionRows(
    toolCalls.map((call) => buildToolAccordionRow(call, undefined, locale)),
    locale,
  )
  const status = aggregateAccordionStatus(rows.map((row) => row.status))
  const running = rows.find((row) => row.status === 'running')
  const last = rows.at(-1)
  const title = running
    ? (running.detail || running.verb)
    : last
      ? (last.detail || last.verb)
      : (locale === 'en' ? 'Tool calls' : '工具调用')
  return {
    elapsedMs: startedAt !== undefined ? Math.max(0, now - startedAt) : 0,
    groups: [{
      id: 'plan-tools',
      title,
      status,
      open: status === 'running',
      rows,
    }],
  }
}

export function agentToolAccordionElapsedLabel(elapsedMs: number, locale: string) {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1_000))
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  if (locale === 'en') {
    return minutes ? `Processed ${minutes}m ${remainder}s` : `Processed ${seconds}s`
  }
  return minutes ? `已处理 ${minutes}分钟 ${remainder}秒` : `已处理 ${seconds}秒`
}

/** 对话默认层：空思考丢掉；进行中按到达顺序流在主列。结算后提交让给出图结果，失败也不叠两行。 */
export function presentAgentTimelineConversation(timeline: AgentTimelineState) {
  const blocks = timeline.blocks.filter((block) => {
    if (isSilentThinkingBlock(block)) return false
    // 工具 accordion 接管非管道工具步与 raw；对话层只留管道步 / 思考 / 旁白。
    if (block.type === 'raw_group') return false
    if (block.type === 'step' && !isAgentPipelineTimelineStep(block)) return false
    return true
  })
  const live = timeline.blocks.some((block) => (
    (block.type === 'thinking' && block.status === 'running')
    || (block.type === 'step' && block.status === 'running')
  ))
  if (live) return { live, visible: blocks, collapsed: [] as TimelineBlock[] }
  const generate = blocks.find(isGenerateStep)
  const submit = blocks.find(isSubmitStep)
  const visible = blocks.filter((block) => {
    if (!isSubmitStep(block)) return true
    if (block.status === 'succeeded') return false
    return !generate
  }).map((block) => {
    if (!generate || block.id !== generate.id || !isGenerateStep(block)) return block
    if (block.error || block.errorCode || !(submit?.error || submit?.errorCode)) return block
    return { ...block, ...timelineFailureFields(submit.error, submit.errorCode) }
  })
  return { live, visible, collapsed: [] as TimelineBlock[] }
}

/** 对话里用动作，不用内部管道名。 */
export function conversationTimelineStepTitle(
  block: Extract<TimelineBlock, { type: 'step' }>,
  locale: string,
) {
  const en = locale === 'en'
  const running = block.status === 'running'
  const failed = block.status === 'failed'
  if (block.kind === 'write' && /^生成/u.test(block.title)) {
    const label = block.title.replace(/^生成(?:\s*·\s*|\s*)/u, '').trim()
    const suffix = label && !isBotanicAgentProcessLabel(label) && label !== '分支' ? ` · ${label}` : ''
    if (running) return en ? `Generating${suffix || '…'}` : `正在出图${suffix || '…'}`
    if (failed) return en ? `Generation failed${suffix}` : `出图失败${suffix}`
    return en ? `Generated${suffix}` : `已出图${suffix}`
  }
  if (block.kind === 'write' && /提交/u.test(block.title)) {
    if (running) return en ? 'Submitting…' : '正在提交…'
    if (failed) return en ? 'Submit failed' : '提交失败'
    return en ? 'Submitted' : '已提交'
  }
  if (block.kind === 'write' && /准备/u.test(block.title)) {
    if (running) return en ? 'Planning…' : '正在规划…'
    if (failed) return en ? 'Planning failed' : '规划失败'
    return en ? 'Planned' : '已规划'
  }
  if (/等待生成结果/u.test(block.title)) {
    if (running) return en ? 'Generating…' : '正在出图…'
    if (failed) return en ? 'Generation failed' : '出图失败'
    return en ? 'Generated' : '已出图'
  }
  if (/本体|画布上下文/u.test(block.title)) {
    if (running) return en ? 'Reviewing the project…' : '在看项目…'
    if (failed) return en ? 'Couldn’t read the project' : '没读到项目'
    return en ? 'Reviewed the project' : '看过项目'
  }
  if (/起草生成计划/u.test(block.title)) {
    if (running) return en ? 'Writing the plan…' : '在写计划…'
    if (failed) return en ? 'Couldn’t write the plan' : '计划没写完'
    return en ? 'Wrote the plan' : '已写计划'
  }
  if (/runtime/i.test(block.title)) {
    if (running) return en ? 'Connecting the browser…' : '在连浏览器…'
    if (failed) return en ? 'Couldn’t connect the browser' : '浏览器没连上'
    return en ? 'Connected the browser' : '已连浏览器'
  }
  if (/MCP/u.test(block.title)) {
    if (running) return en ? 'Preparing an external action…' : '准备外部操作…'
    if (failed) return en ? 'External action failed' : '外部操作失败'
    return en ? 'Prepared an external action' : '已准备外部操作'
  }
  return null
}
