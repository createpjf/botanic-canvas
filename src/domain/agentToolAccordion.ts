import { isBotanicAgentProcessLabel, type AgentToolCallTrace } from './agent.ts'
import { isCollapsedWebSearchToolName } from './agentTimelineWebSources.ts'
import {
  agentTimelineStepToolName,
  isAgentPipelineTimelineStep,
  isGenerateStep,
  isSilentThinkingBlock,
  isSubmitStep,
  agentTimelineToolPresentation,
  semanticBlocks,
  timelineFailureFields,
  timelineRawGroup,
  type AgentTimelineState,
  type TimelineBlock,
  type TimelineStepBlock,
  type TimelineStepKind,
} from './agentTimeline.ts'

export type AgentToolAccordionRowStatus = 'running' | 'awaiting_confirmation' | 'succeeded' | 'failed' | 'aborted'

export type AgentToolAccordionRow = {
  id: string
  kind: TimelineStepKind
  toolName: string
  label?: string
  verb: string
  detail: string
  status: AgentToolAccordionRowStatus
  /** 动作目标（hostname / 节点名 / MCP server 名），来自既有安全展示数据的投影。 */
  target?: string
  durationMs?: number
  error?: string
  why?: string
  input?: unknown
  output?: unknown
  recovery?: AgentToolCallTrace['recovery']
  receiptId?: string
  recovered?: boolean
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
  /** Pending reveal / quiet linger 的下一次纯展示重算时间。 */
  nextUpdateAt?: number
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
  if (input.kind === 'subagent' || name === 'subagent_research') return 'list-todo'
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
  if (status === 'aborted') return 'aborted'
  if (status === 'failed') return 'failed'
  if (status === 'succeeded') return 'succeeded'
  // 等待用户批准与正在运行是两种用户可感知状态：折叠成 running 会让人误以为系统卡住。
  if (status === 'awaiting_confirmation') return 'awaiting_confirmation'
  return 'running'
}

function toolAccordionVerb(kind: TimelineStepKind, status: AgentToolAccordionRowStatus, locale: string) {
  const en = locale === 'en'
  if (status === 'aborted') return en ? 'Not run' : '未执行'
  if (status === 'awaiting_confirmation') return en ? 'Awaiting approval' : '等待确认'
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
  if (kind === 'subagent') {
    if (status === 'running') return en ? 'Researching' : '正在调研'
    if (status === 'failed') return en ? 'Research failed' : '调研失败'
    return en ? 'Research complete' : '调研完成'
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
  if (statuses.some((status) => status === 'awaiting_confirmation')) return 'awaiting_confirmation'
  if (statuses.some((status) => status === 'running')) return 'running'
  if (statuses.some((status) => status === 'aborted')) return 'aborted'
  return 'succeeded'
}

const AGENT_READ_REVEAL_DELAY_MS = 300
const AGENT_READ_MIN_VISIBLE_MS = 600

type QuietReadDisposition = { kind: 'pending' | 'visible' | 'aggregate'; nextUpdateAt?: number }

function quietReadDisposition(
  call: AgentToolCallTrace,
  row: AgentToolAccordionRow,
  timing: { startedAt?: number; endedAt?: number } | undefined,
  now: number,
): QuietReadDisposition {
  const eligible = call.risk === 'read'
    && (row.kind === 'read' || row.kind === 'read_skill')
    && !call.error?.trim()
  if (!eligible || timing?.startedAt === undefined) return { kind: 'visible' }
  const revealAt = timing.startedAt + AGENT_READ_REVEAL_DELAY_MS
  if (row.status === 'running') {
    return now < revealAt ? { kind: 'pending', nextUpdateAt: revealAt } : { kind: 'visible' }
  }
  if (row.status !== 'succeeded') return { kind: 'visible' }
  const endedAt = timing.endedAt ?? timing.startedAt
  // 完成早于 reveal:从未闪现,直接并入摘要。
  if (endedAt < revealAt) return { kind: 'aggregate' }
  // 已经画出来的 quiet success 至少稳定600ms,避免同帧消失。
  const removalAt = revealAt + AGENT_READ_MIN_VISIBLE_MS
  return now < removalAt
    ? { kind: 'visible', nextUpdateAt: removalAt }
    : { kind: 'aggregate' }
}

function quietReadSummaryRow(rows: AgentToolAccordionRow[], locale: string): AgentToolAccordionRow | undefined {
  if (!rows.length) return undefined
  const count = rows.length
  const verb = locale === 'en' ? `Read ${count} item${count === 1 ? '' : 's'}` : `已读取 ${count} 项`
  return {
    id: `quiet-reads:${rows.map((row) => row.id).join('+')}`,
    kind: 'read',
    toolName: 'quiet_reads',
    label: verb,
    verb,
    detail: verb,
    status: 'succeeded',
    callCount: count,
    calls: rows,
  }
}

/** 动作目标：web 步骤取来源 hostname、MCP 取 server 名。纯投影，不新增数据来源。 */
function toolAccordionTarget(call: AgentToolCallTrace, hostname?: string) {
  if (hostname) return hostname
  if (isMcpToolName(call.name)) return agentMcpServerIdFromLabel(call.label)
  return undefined
}

function buildToolAccordionRow(
  call: AgentToolCallTrace,
  timing?: { startedAt?: number; endedAt?: number },
  locale = 'zh-CN',
  hostname?: string,
): AgentToolAccordionRow {
  const presentation = agentTimelineToolPresentation(call)
  const status = toolCallRowStatus(call.status)
  const durationMs = toolAccordionDurationMs(timing?.startedAt, timing?.endedAt)
  const verb = durationMs !== undefined && status === 'succeeded'
    ? (locale === 'en'
      ? `Ran in ${Math.round(durationMs / 1_000)}s`
      : `已在 ${Math.round(durationMs / 1_000)}s 内运行`)
    : toolAccordionVerb(presentation.kind, status, locale)
  const target = toolAccordionTarget(call, hostname)
  return {
    id: call.id,
    kind: presentation.kind,
    toolName: call.name,
    label: call.label,
    verb,
    detail: toolAccordionDetail(call),
    status,
    ...(target ? { target } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(call.error?.trim() ? { error: call.error.trim() } : {}),
    ...(call.summary?.trim() ? { why: call.summary.trim() } : {}),
    ...(call.input !== undefined ? { input: call.input } : {}),
    ...(call.output !== undefined ? { output: call.output } : {}),
    ...(call.recovery ? { recovery: call.recovery } : {}),
    ...(call.receiptId?.trim() ? { receiptId: call.receiptId.trim() } : {}),
    ...(call.recovered ? { recovered: true } : {}),
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
        status: step.status === 'failed' ? 'failed' as const : step.status === 'succeeded' ? 'succeeded' as const : step.status === 'aborted' ? 'aborted' as const : 'running' as const,
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
      status: step.status === 'failed' ? 'failed' : step.status === 'succeeded' ? 'succeeded' : step.status === 'aborted' ? 'aborted' : 'running',
      requiresConfirmation: false,
      ...(step.summary ? { summary: step.summary } : {}),
      ...(step.error ? { error: step.error } : {}),
    })
    timingByToolId.set(step.sourceToolIds[0] ?? step.id, { startedAt: step.startedAt, endedAt: step.endedAt })
  }

  if (!orderedCalls.length) return null

  // web 步骤的目标 hostname：单来源步骤才有明确目标，多来源（聚合搜索）不标。
  const hostnameByToolId = new Map<string, string>()
  for (const step of steps) {
    if (step.sources?.length !== 1) continue
    for (const id of step.sourceToolIds) hostnameByToolId.set(id, step.sources[0].hostname)
  }

  const visibleRows: AgentToolAccordionRow[] = []
  const quietRows: AgentToolAccordionRow[] = []
  let quietInsertIndex: number | undefined
  let nextUpdateAt: number | undefined
  for (const call of orderedCalls) {
    const timing = timingByToolId.get(call.id)
    const row = buildToolAccordionRow(call, timing, locale, hostnameByToolId.get(call.id))
    const disposition = quietReadDisposition(call, row, timing, now)
    if (disposition.nextUpdateAt !== undefined) {
      nextUpdateAt = nextUpdateAt === undefined ? disposition.nextUpdateAt : Math.min(nextUpdateAt, disposition.nextUpdateAt)
    }
    if (disposition.kind === 'pending') continue
    if (disposition.kind === 'aggregate') {
      quietInsertIndex ??= visibleRows.length
      quietRows.push(row)
      continue
    }
    visibleRows.push(row)
  }
  const quietSummary = quietReadSummaryRow(quietRows, locale)
  if (quietSummary) visibleRows.splice(quietInsertIndex ?? visibleRows.length, 0, quietSummary)
  const rows = mergeMcpAccordionRows(visibleRows, locale)
  if (!rows.length) return { elapsedMs: timelineElapsedMs(timeline, now), groups: [], ...(nextUpdateAt ? { nextUpdateAt } : {}) }
  const status = aggregateAccordionStatus(rows.map((row) => row.status))
  const focusStep = steps.find((step) => step.status === 'running') ?? steps.at(-1)
  return {
    elapsedMs: timelineElapsedMs(timeline, now),
    groups: [{ id: 'tools', title: accordionGroupTitle(focusStep, rows, locale), status, open: status === 'running' || status === 'awaiting_confirmation', rows }],
    ...(nextUpdateAt ? { nextUpdateAt } : {}),
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
      open: status === 'running' || status === 'awaiting_confirmation',
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
  if (block.status === 'aborted') return en ? 'Not run' : '未执行'
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
