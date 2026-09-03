import { useEffect, useRef, useState } from 'react'
import { botanicMotion, gsap, prefersReducedMotion, useGSAP } from '../../components/gsapMotion'
import { ChevronDownIcon, FileSearchIcon, FileTextIcon, GlobeIcon, HammerIcon, ImageIcon, ListTodoIcon, MousePointerClickIcon, SearchCodeIcon, SparkleIcon, SquareTerminalIcon, UnplugIcon, WrenchIcon } from '../../components/BotanicIcons'
import {
  agentMcpServerBrandLogoSrc,
  agentMcpServerIdFromLabel,
  agentToolAccordionElapsedLabel,
  agentToolIconKey,
  type AgentToolAccordionGroup,
  type AgentToolAccordionRow,
  type AgentToolAccordionRowStatus,
  type AgentToolAccordionView,
} from '../../domain/agentToolAccordion'
import type { TimelineStepKind } from '../../domain/agentTimeline'
import { useProductI18n } from '../../i18n/react'

/** 时间线步骤与 Action Card 共用的工具类别图标；MCP 有品牌 logo 时优先。 */
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

function actionStatusBadge(status: AgentToolAccordionRowStatus, locale: string) {
  const en = locale === 'en'
  if (status === 'awaiting_confirmation') return en ? 'Awaiting approval' : '等待确认'
  if (status === 'failed') return en ? 'Failed' : '失败'
  if (status === 'aborted') return en ? 'Not run' : '未执行'
  return undefined
}

/** 收起态一行卡片：[类型图标 | 动词 | 目标 | 状态徽标 | 耗时]。展开看 why 摘要、错误与嵌套 calls。 */
function AgentActionCardRow({
  row,
  index,
}: {
  row: AgentToolAccordionRow
  index: number
}) {
  const { locale } = useProductI18n()
  const [detailOpen, setDetailOpen] = useState(false)
  const hasDetail = Boolean(row.error || (row.calls && row.calls.length > 1))
  const badge = actionStatusBadge(row.status, locale)
  const copy = (
    <span className="agent-tool-accordion__row-copy">
      <strong className={row.status === 'running' ? 'is-shimmer' : undefined}>{row.verb}</strong>
      <span className="agent-tool-accordion__detail" title={row.detail}>{row.detail}</span>
      {row.target && row.target !== row.detail ? <span className="agent-tool-accordion__target" title={row.target}>{row.target}</span> : null}
      {badge ? <em className={`agent-tool-accordion__badge is-${row.status}`}>{badge}</em> : null}
      {row.durationMs !== undefined && row.status === 'succeeded' ? <small className="agent-tool-accordion__duration">{Math.round(row.durationMs / 1_000)}s</small> : null}
    </span>
  )
  return <div
    className={`agent-tool-accordion__row is-${row.status}`}
    style={prefersReducedMotion() ? undefined : { animationDelay: `${index * 60}ms` }}
  >
    <span className="agent-tool-accordion__row-icon" aria-hidden="true">
      <AgentToolCallIcon toolName={row.toolName} kind={row.kind} label={row.detail} />
    </span>
    {hasDetail ? <button
      type="button"
      className="agent-tool-accordion__row-toggle"
      aria-expanded={detailOpen}
      onClick={() => setDetailOpen((value) => !value)}
    >
      {copy}
      <ChevronDownIcon />
    </button> : copy}
    {detailOpen && row.error ? <p className="agent-tool-accordion__row-error">{row.error}</p> : null}
    {detailOpen && row.calls?.length ? <div className="agent-tool-accordion__nested">
      {row.calls.map((call) => <div key={call.id} className={`agent-tool-accordion__row is-${call.status} is-nested`}>
        <span className="agent-tool-accordion__row-icon" aria-hidden="true">
          <AgentToolCallIcon toolName={call.toolName} kind={call.kind} label={call.detail} />
        </span>
        <span className="agent-tool-accordion__row-copy">
          <strong>{call.verb}</strong>
          <span className="agent-tool-accordion__detail" title={call.detail}>{call.detail}</span>
        </span>
        {call.error ? <p className="agent-tool-accordion__row-error">{call.error}</p> : null}
      </div>)}
    </div> : null}
  </div>
}

function AgentActionCardGroup({ group }: { group: AgentToolAccordionGroup }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const readyRef = useRef(false)
  const [open, setOpen] = useState(group.open)
  useEffect(() => {
    setOpen(group.open)
  }, [group.id, group.open, group.status])

  useGSAP(() => {
    const panel = panelRef.current
    if (!panel) return
    const duration = prefersReducedMotion() ? 0 : botanicMotion.duration.panel
    if (!readyRef.current) {
      readyRef.current = true
      gsap.set(panel, open
        ? { height: 'auto', autoAlpha: 1, y: 0 }
        : { height: 0, autoAlpha: 0, y: 0 })
      return
    }
    gsap.to(panel, {
      height: open ? 'auto' : 0,
      autoAlpha: open ? 1 : 0,
      y: open || prefersReducedMotion() ? 0 : -4,
      duration,
      ease: botanicMotion.ease,
    })
  }, { dependencies: [open, group.rows.length], scope: rootRef })

  return <div ref={rootRef} className={`agent-tool-accordion__group is-${group.status}${open ? ' is-open' : ''}`}>
    <button
      type="button"
      className={`agent-tool-accordion__title${group.status === 'running' ? ' is-shimmer' : ''}`}
      aria-expanded={open}
      onClick={() => setOpen((value) => !value)}
    >
      <span>{group.title}</span>
      <ChevronDownIcon />
    </button>
    <div
      ref={panelRef}
      className="agent-tool-accordion__panel"
      aria-hidden={!open}
      inert={!open ? true : undefined}
    >
      {group.rows.map((row, index) => <AgentActionCardRow key={row.id} row={row} index={index} />)}
    </div>
  </div>
}

/** Execution Trace 的对话呈现：一组可展开 Action Card。数据由 agentToolAccordion 投影。 */
export function AgentToolCallAccordion({ view }: { view: AgentToolAccordionView }) {
  const { locale } = useProductI18n()
  if (!view.groups.length) return null
  const showElapsed = view.elapsedMs >= 1_000
  return <div className="agent-tool-accordion" aria-label={locale === 'en' ? 'Agent tool calls' : 'Agent 工具调用'}>
    {showElapsed ? <p className="agent-tool-accordion__elapsed">{agentToolAccordionElapsedLabel(view.elapsedMs, locale)}</p> : null}
    {view.groups.map((group) => <AgentActionCardGroup key={group.id} group={group} />)}
  </div>
}
