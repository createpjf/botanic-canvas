import type { DynamicToolUIPart } from 'ai'
import { useState } from 'react'
import { ChevronDownIcon, FileSearchIcon, FileTextIcon, GlobeIcon, HammerIcon, ImageIcon, ListTodoIcon, MousePointerClickIcon, SearchCodeIcon, SparkleIcon, SquareTerminalIcon, UnplugIcon, WrenchIcon } from '../../components/BotanicIcons'
import {
  agentMcpServerBrandLogoSrc,
  agentMcpServerIdFromLabel,
  agentToolDurationLabel,
  agentToolIconKey,
  type AgentToolAccordionRow,
  type AgentToolAccordionRowStatus,
  type AgentToolAccordionView,
} from '../../domain/agentToolAccordion'
import { timelineWebSourceHref, type TimelineStepKind } from '../../domain/agentTimeline'
import { useProductI18n } from '../../i18n/react'
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtSearchResult,
  ChainOfThoughtSearchResults,
  ChainOfThoughtStep,
} from '../../components/ai-elements/chain-of-thought'
import { Checkpoint, CheckpointIcon } from '../../components/ai-elements/checkpoint'
import {
  Confirmation,
  ConfirmationRequest,
  ConfirmationTitle,
} from '../../components/ai-elements/confirmation'
import { Tool, ToolContent, ToolInput, ToolOutput } from '../../components/ai-elements/tool'
import { CollapsibleTrigger } from '../../components/ui/collapsible'

/** 时间线步骤与 Activity 共用的工具类别图标；MCP 有品牌 logo 时优先。 */
export function AgentToolCallIcon({
  toolName,
  kind,
  label,
}: {
  toolName?: string
  kind?: TimelineStepKind
  label?: string
}) {
  const key = agentToolIconKey({ toolName, kind, label })
  if (key === 'unplug') {
    const logo = agentMcpServerBrandLogoSrc(agentMcpServerIdFromLabel(label))
    if (logo) return <img className="agent-tool-accordion__brand" src={logo} alt="" draggable={false} />
  }
  if (key === 'search-code') return <SearchCodeIcon />
  if (key === 'file-search') return <FileSearchIcon />
  if (key === 'file-text') return <FileTextIcon />
  if (key === 'square-terminal') return <SquareTerminalIcon />
  if (key === 'globe') return <GlobeIcon />
  if (key === 'mouse-pointer-click') return <MousePointerClickIcon />
  if (key === 'unplug') return <UnplugIcon />
  if (key === 'sparkles') return <SparkleIcon />
  if (key === 'image') return <ImageIcon />
  if (key === 'list-todo') return <ListTodoIcon />
  if (key === 'hammer') return <HammerIcon />
  return <WrenchIcon />
}

function toolUiState(status: AgentToolAccordionRowStatus): DynamicToolUIPart['state'] {
  if (status === 'awaiting_confirmation') return 'approval-requested'
  if (status === 'succeeded') return 'output-available'
  if (status === 'failed') return 'output-error'
  if (status === 'aborted') return 'output-denied'
  return 'input-available'
}

function decisionStatus(status: AgentToolAccordionRowStatus) {
  return status === 'running' || status === 'awaiting_confirmation' ? 'active' as const : 'complete' as const
}

function flattenedRows(rows: AgentToolAccordionRow[]): AgentToolAccordionRow[] {
  return rows.flatMap((row) => row.calls?.length ? row.calls : [row])
}

function useActivityDisclosure(phase: string, autoOpen: boolean) {
  const [state, setState] = useState({ phase, open: autoOpen })
  if (state.phase !== phase) setState({ phase, open: autoOpen })
  return { open: state.phase === phase ? state.open : autoOpen, onOpenChange: (open: boolean) => setState({ phase, open }) }
}

function AgentActivityTool({ row }: { row: AgentToolAccordionRow }) {
  const { locale } = useProductI18n()
  const en = locale === 'en'
  const state = toolUiState(row.status)
  const disclosure = useActivityDisclosure(row.status, ['running', 'failed', 'awaiting_confirmation'].includes(row.status))
  const nextStep = row.status === 'failed'
    ? (en ? 'Next: adjust or retry from the related task or action card.' : '下一步：在对应任务或行动卡中调整或重试。')
    : row.status === 'aborted'
      ? (en ? 'This step was cancelled. Completed results are kept.' : '这一步已取消；已完成结果仍会保留。')
      : row.status === 'awaiting_confirmation'
        ? (en ? 'Next: approve or skip it in the action card.' : '下一步：在行动卡中确认执行或跳过。')
        : undefined
  return <Tool className="agent-tool-accordion__tool" {...disclosure}>
      <CollapsibleTrigger className="agent-tool-accordion__tool-header">
        <AgentToolCallIcon toolName={row.toolName} kind={row.kind} label={row.label} />
        <span className="agent-tool-accordion__why"><span>{row.why || row.label || row.detail || row.toolName}</span><small><span>{row.verb}</span><span>{en ? 'Time' : '用时'} {agentToolDurationLabel(row.durationMs, locale)}</span></small></span>
        <ChevronDownIcon aria-hidden="true" />
      </CollapsibleTrigger>
      <ToolContent>
        {row.sources?.length ? <ChainOfThoughtSearchResults className="agent-tool-accordion__search-results" aria-label={en ? 'Sources' : '来源'}>
          {row.sources.map((source) => {
            const href = timelineWebSourceHref(source)
            const label = source.title ? `${source.hostname} — ${source.title}` : source.hostname
            return href ? <ChainOfThoughtSearchResult key={href} asChild title={label}>
              <a href={href} target="_blank" rel="noopener noreferrer" aria-label={label}>{source.hostname}</a>
            </ChainOfThoughtSearchResult> : <ChainOfThoughtSearchResult key={source.hostname} title={label}>{source.hostname}</ChainOfThoughtSearchResult>
          })}
        </ChainOfThoughtSearchResults> : null}
        {row.recovered ? <Checkpoint>
          <CheckpointIcon />
          <span className="px-2 text-xs">
            {en ? 'Recovered' : '已恢复'}
          </span>
        </Checkpoint> : null}
        {row.status === 'awaiting_confirmation' ? <Confirmation approval={{ id: row.id }} state={state}>
          <ConfirmationRequest>
            <ConfirmationTitle>{en ? 'Awaiting approval' : '等待确认'}</ConfirmationTitle>
          </ConfirmationRequest>
        </Confirmation> : null}
        {row.error ? <p role="alert" className="agent-tool-accordion__next is-failed">{row.error}</p> : null}
        {import.meta.env.DEV && (row.input !== undefined || row.output !== undefined) ? <details className="agent-tool-accordion__technical">
          <summary>{en ? 'Technical details' : '技术详情'}</summary>
          {row.input !== undefined ? <ToolInput input={row.input} label={en ? 'Parameters (redacted)' : '参数（已脱敏）'} /> : null}
          <ToolOutput output={row.output} errorText={undefined} resultLabel={en ? 'Output (redacted)' : '输出（已脱敏）'} />
        </details> : null}
        {nextStep ? <p className={`agent-tool-accordion__next is-${row.status}`}>{nextStep}</p> : null}
      </ToolContent>
    </Tool>
}

/** Botanic canonical timeline → AI Elements Activity；不接管执行、恢复或取消。 */
export function AgentToolCallAccordion({ view }: { view: AgentToolAccordionView }) {
  const { locale } = useProductI18n()
  const en = locale === 'en'
  const rows = flattenedRows(view.groups.flatMap((group) => group.rows))
  const needsAttention = rows.some((row) => row.status === 'failed' || row.status === 'awaiting_confirmation')
  const running = rows.some((row) => row.status === 'running')
  const phase = rows.some((row) => row.status === 'awaiting_confirmation') ? 'approval' : needsAttention ? 'failed' : running ? 'running' : 'settled'
  const disclosure = useActivityDisclosure(phase, needsAttention || running)
  if (!view.groups.length) return null
  const elapsed = view.elapsedMs > 0 ? agentToolDurationLabel(view.elapsedMs, locale) : '—'
  return <div className="agent-tool-accordion" aria-label={en ? 'Activity' : '执行记录'}>
    {rows.length ? <ChainOfThought className="agent-tool-accordion__chain" {...disclosure}>
      <ChainOfThoughtHeader className="agent-tool-accordion__chain-header"><span className="agent-tool-accordion__summary"><small>{elapsed === '—' ? (en ? 'Activity' : '执行记录') : en ? `Time ${elapsed}` : `用时 ${elapsed}`}</small></span></ChainOfThoughtHeader>
      <ChainOfThoughtContent className="agent-tool-accordion__chain-content">
        {rows.map((row) => <ChainOfThoughtStep
          className="agent-tool-accordion__chain-step"
          key={row.id}
          label={<AgentActivityTool row={row} />}
          status={decisionStatus(row.status)}
        />)}
      </ChainOfThoughtContent>
    </ChainOfThought> : null}
  </div>
}
