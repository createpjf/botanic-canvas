import type { DynamicToolUIPart } from 'ai'
import { FileSearchIcon, FileTextIcon, GlobeIcon, HammerIcon, ImageIcon, ListTodoIcon, MousePointerClickIcon, SearchCodeIcon, SparkleIcon, SquareTerminalIcon, UnplugIcon, WrenchIcon } from '../../components/BotanicIcons'
import {
  agentMcpServerBrandLogoSrc,
  agentMcpServerIdFromLabel,
  agentToolAccordionElapsedLabel,
  agentToolIconKey,
  type AgentToolAccordionRow,
  type AgentToolAccordionRowStatus,
  type AgentToolAccordionView,
} from '../../domain/agentToolAccordion'
import type { TimelineStepKind } from '../../domain/agentTimeline'
import { useProductI18n } from '../../i18n/react'
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
} from '../../components/ai-elements/chain-of-thought'
import { Checkpoint, CheckpointIcon } from '../../components/ai-elements/checkpoint'
import {
  Confirmation,
  ConfirmationRequest,
  ConfirmationTitle,
} from '../../components/ai-elements/confirmation'
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '../../components/ai-elements/tool'

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

function AgentActivityTool({ row }: { row: AgentToolAccordionRow }) {
  const { locale } = useProductI18n()
  const en = locale === 'en'
  const state = toolUiState(row.status)
  const nextStep = row.status === 'failed'
    ? (en ? 'Next: adjust or retry from the related task or action card.' : '下一步：在对应任务或行动卡中调整或重试。')
    : row.status === 'aborted'
      ? (en ? 'This step was cancelled. Completed results are kept.' : '这一步已取消；已完成结果仍会保留。')
      : row.status === 'awaiting_confirmation'
        ? (en ? 'Next: approve or skip it in the action card.' : '下一步：在行动卡中确认执行或跳过。')
        : row.recovered
          ? (en ? 'Resumed from a checkpoint; completed work was not repeated.' : '已从 checkpoint 恢复，完成过的步骤不会重复执行。')
          : undefined
  return <Tool className="agent-tool-accordion__tool" defaultOpen={row.status === 'failed' || row.status === 'awaiting_confirmation'}>
    <ToolHeader
      className="agent-tool-accordion__tool-header"
      type="dynamic-tool"
      toolName={row.toolName}
      state={state}
      title={row.label || row.detail || row.toolName}
      statusLabel={row.verb}
    />
    <ToolContent>
      {row.recovery || row.receiptId ? <Checkpoint>
        <CheckpointIcon />
        <span className="px-2 text-xs">
          {row.recovered ? (en ? 'Recovered' : '已恢复') : 'Checkpoint'}
          {row.recovery ? ` · ${row.recovery}` : ''}
          {row.receiptId ? ` · Receipt ${row.receiptId}` : ''}
        </span>
      </Checkpoint> : null}
      {row.status === 'awaiting_confirmation' ? <Confirmation approval={{ id: row.id }} state={state}>
        <ConfirmationRequest>
          <ConfirmationTitle>{en ? 'Awaiting approval' : '等待确认'}</ConfirmationTitle>
        </ConfirmationRequest>
      </Confirmation> : null}
      {row.input !== undefined ? <ToolInput input={row.input} label={en ? 'Raw parameters (redacted)' : '原始参数（已脱敏）'} /> : null}
      <ToolOutput
        output={row.output}
        errorText={row.error}
        resultLabel={en ? 'Raw output (redacted)' : '原始输出（已脱敏）'}
        errorLabel={en ? 'Error' : '错误'}
      />
      <dl className="agent-tool-accordion__trace-policy">
        <div><dt>Provider body</dt><dd>{en ? 'Not sent to the UI by security policy' : '按安全策略不下发到界面'}</dd></div>
        {!row.recovery && !row.receiptId ? <div><dt>Checkpoint / Receipt</dt><dd>{en ? 'Not recorded for this event' : '本次事件未记录'}</dd></div> : null}
      </dl>
      {nextStep ? <p className={`agent-tool-accordion__next is-${row.status}`}>{nextStep}</p> : null}
    </ToolContent>
  </Tool>
}

/** Botanic canonical timeline → AI Elements Activity；不接管执行、恢复或取消。 */
export function AgentToolCallAccordion({ view }: { view: AgentToolAccordionView }) {
  const { locale } = useProductI18n()
  if (!view.groups.length) return null
  const en = locale === 'en'
  const rows = flattenedRows(view.groups.flatMap((group) => group.rows))
  const needsAttention = rows.some((row) => row.status === 'failed' || row.status === 'awaiting_confirmation')
  const running = rows.some((row) => row.status === 'running')
  const summary = en
    ? `${rows.length} step${rows.length === 1 ? '' : 's'} · ${needsAttention ? 'needs attention' : running ? 'running' : 'complete'}`
    : `${rows.length} 个步骤 · ${needsAttention ? '需要处理' : running ? '执行中' : '已完成'}`
  return <div className="agent-tool-accordion space-y-3" aria-label={en ? 'Agent activity' : 'Agent 活动'}>
    {rows.length ? <ChainOfThought defaultOpen={needsAttention || running}>
      <ChainOfThoughtHeader><span className="agent-tool-accordion__summary"><span>{en ? 'Reasoning summary' : '推理摘要'}</span><small>{summary}</small></span></ChainOfThoughtHeader>
      <ChainOfThoughtContent>
        <p className="agent-tool-accordion__trace-title">{en ? 'Decision trace' : '决策轨迹'}</p>
        {rows.map((row) => <ChainOfThoughtStep
          key={row.id}
          label={<span className="agent-tool-accordion__why">{row.why ? <small>Why</small> : null}<span>{row.why || row.label || row.detail}</span></span>}
          description={`${row.label || row.toolName} · ${row.verb}`}
          status={decisionStatus(row.status)}
        ><AgentActivityTool row={row} /></ChainOfThoughtStep>)}
      </ChainOfThoughtContent>
    </ChainOfThought> : null}
    {view.elapsedMs >= 1_000 ? <p className="agent-tool-accordion__elapsed">{agentToolAccordionElapsedLabel(view.elapsedMs, locale)}</p> : null}
  </div>
}
