import { useEffect, useRef, useState, type ReactNode } from 'react'
import { botanicMotion, gsap, prefersReducedMotion, useGSAP } from '../../components/gsapMotion'
import {
  BOTANIC_AGENT_MAX_SINGLE_OUTPUT,
  botanicAgentAppliedSkillName,
  botanicAgentContextSnapshotNodeIds,
  botanicAgentExecutionPauseHint,
  botanicAgentPendingConfirmationCount,
  botanicAgentPlanMediaKind,
  botanicAgentMessageOffersVisualPrompt,
  presentBotanicAgentPlanSummary,
  creativeDimensionLabel,
  resolveBotanicAgentExecutionDecision,
  shouldRestoreBotanicAgentRuntimeSteps,
  type AgentToolCallTrace,
  type BotanicAgentActionProposal,
  type BotanicAgentActionUserIntent,
  type BotanicAgentArtifact,
  type BotanicAgentConfirmationWaiver,
  type BotanicAgentContextSnapshot,
  type BotanicAgentExecutionMode,
  type BotanicAgentMemoryKind,
  type BotanicAgentMessage,
  type BotanicAgentRun,
} from '../../domain/agent'
import type { GenerationModelOption, GenerationSettings } from '../../domain/canvas'
import { generationTaskErrorMessage } from '../../domain/canvasPresentation'
import {
  applyCustomGenerationSize,
  customGenerationSizeFields,
  localizeCustomGenerationSizeMessage,
  modelSupportsCustomSize,
  withoutCustomGenerationSize,
} from '../../domain/generationOutputSize'
import {
  applyClarityBoost,
  clarityBoostModel,
  clearClarityBoost,
  everydayResolutions,
  settingsForGenerationModel,
} from '../../domain/generationRecipe'
import { BobCharacter } from '../../components/bob/BobCharacter'
import { bobMessageAllowsSays, bobMessageIsLargeReply, bobReplyPresentation } from '../../domain/bobPresentation'
import { useBobSaysPlays } from './useBobSaysPlays'
import { AlertIcon, CheckIcon, ChevronDownIcon, ClockIcon, ContinueChatIcon, CopyIcon, EditIcon, FileSearchIcon, FileTextIcon, FocusIcon, GlobeIcon, HammerIcon, ImageIcon, ListTodoIcon, MoreIcon, MousePointerClickIcon, PinNodeIcon, SearchCodeIcon, SparkleIcon, SquareTerminalIcon, ThumbDownIcon, ThumbUpIcon, UnplugIcon, WrenchIcon } from '../../components/BotanicIcons'
import { AgentThinkingOrb } from '../../components/AgentThinkingOrb'
import { AgentToolOrb } from '../../components/AgentToolOrb'
import { AgentWebSourcePills } from '../../components/AgentWebSourcePills'
import { agentPlannerModelLabel, modelDisplayLabel, modelProviderLogo } from '../../components/generationModelPresentation'
import { BotanicSelect } from '../../components/BotanicSelect'
import { AgentClarificationCard, AgentPromptDiff } from './AgentWorkspaceParts'
import { AgentMarkdownSources } from './AgentMarkdown'
import { AgentPromptResponse } from './AgentPromptResponse'
import { AgentMessageRichContent, AgentRichText } from './AgentMentionText'
import { agentMessageNeedsCollapse, splitAgentMessageSources } from '../../domain/agentMarkdown'
import type { BotanicAgentMentionCatalog } from '../../domain/agentMentions'
import {
  botanicAgentMessageHasUtilities,
  botanicAgentMessageUtilityActions,
  type BotanicAgentMessageUtilityActions,
} from '../../domain/agentMessageUtilities'
import { botanicAgentPlanBranchPrompts, botanicAgentPlanConfirmActionLabel, botanicAgentPlanSheetCountLabel } from '../../domain/agentVariations'
import {
  botanicAgentCompositionItemSpecLabel,
  formatBotanicAgentCompositionMessage,
  type BotanicAgentComposition,
  type BotanicAgentCompositionItem,
} from '../../domain/agentCreativeComposition'
import { useProductI18n } from '../../i18n/react'
import type { ProductLocale } from '../../i18n/core'
import type { BotanicAgentRunReview } from '../../domain/agentReviewContract'
import {
  agentMcpServerBrandLogoSrc,
  agentMcpServerIdFromLabel,
  agentTimelineHasRenderableContent,
  agentTimelineOrbState,
  agentTimelineStepToolName,
  agentToolAccordionElapsedLabel,
  agentToolIconKey,
  conversationTimelineStepTitle,
  presentAgentTimelineConversation,
  presentAgentToolAccordion,
  presentAgentToolAccordionFromCalls,
  timelineStepShowsWebSources,
  timelineWebSourceHref,
  type AgentTimelineState,
  type AgentToolAccordionGroup,
  type AgentToolAccordionRow,
  type AgentToolAccordionView,
  type TimelineBlock,
  type TimelineStepKind,
  type TimelineWebSource,
} from '../../domain/agentTimeline'

/** 单条任务消息内联展示的结果上限；更多结果去结果面板看，避免对话被结果流冲垮。 */
const inlineRunResultLimit = 4
const justFinishedRevealMs = 1200
const copiedStatusMs = 1200

function tryParseJsonValue(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return undefined
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return undefined
  }
}

function AgentMcpStructuredBlock({ value }: { value: unknown }) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 24)
    if (entries.length) {
      return <dl className="agent-action-card__struct">
        {entries.map(([key, entry]) => <div key={key}>
          <dt>{key}</dt>
          <dd>{typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean'
            ? String(entry)
            : JSON.stringify(entry)}</dd>
        </div>)}
      </dl>
    }
  }
  if (Array.isArray(value) && value.every((item) => item && typeof item === 'object' && !Array.isArray(item))) {
    const rows = value as Record<string, unknown>[]
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))].slice(0, 6)
    if (columns.length && rows.length) {
      return <div className="agent-action-card__table-wrap">
        <table>
          <thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
          <tbody>
            {rows.slice(0, 12).map((row, index) => <tr key={index}>
              {columns.map((column) => <td key={column}>{row[column] === undefined || row[column] === null
                ? ''
                : typeof row[column] === 'string' || typeof row[column] === 'number' || typeof row[column] === 'boolean'
                  ? String(row[column])
                  : JSON.stringify(row[column])}</td>)}
            </tr>)}
          </tbody>
        </table>
      </div>
    }
  }
  return <pre className="agent-action-card__artifact-text">{JSON.stringify(value, null, 2)}</pre>
}

function AgentActionResultArtifacts({
  artifacts,
  onLocateNode,
  locale,
}: {
  artifacts: BotanicAgentArtifact[]
  onLocateNode: (nodeId: string) => void
  locale: string
}) {
  if (!artifacts.length) return null
  const t = (zh: string, en: string) => locale === 'en' ? en : zh
  return <div className="agent-action-card__artifacts" aria-label={t('工具结果', 'Tool results')}>
    {artifacts.map((artifact) => {
      if ((artifact.kind === 'image' || artifact.kind === 'video') && artifact.url) {
        return <figure key={artifact.id} className="agent-action-card__media">
          {artifact.kind === 'image'
            ? <img src={artifact.url} alt={artifact.label} />
            : <video src={artifact.url} controls playsInline aria-label={artifact.label} />}
          <figcaption>{artifact.label}</figcaption>
        </figure>
      }
      if (artifact.kind === 'text' && artifact.content) {
        const parsed = tryParseJsonValue(artifact.content)
        if (parsed !== undefined) {
          return <div key={artifact.id} className="agent-action-card__artifact">
            <small>{artifact.label}</small>
            <AgentMcpStructuredBlock value={parsed} />
          </div>
        }
        return <div key={artifact.id} className="agent-action-card__artifact">
          <small>{artifact.label}</small>
          <pre className="agent-action-card__artifact-text">{artifact.content}</pre>
        </div>
      }
      if (artifact.url) {
        return <a key={artifact.id} className="agent-action-card__file" href={artifact.url} target="_blank" rel="noreferrer">{artifact.label}</a>
      }
      const nodeId = artifact.provenance.sourceNodeIds?.[0]
      return <div key={artifact.id} className="agent-action-card__artifact is-meta">
        <span>{artifact.label}</span>
        {nodeId ? <button type="button" className="agent-icon-button" aria-label={t('在画布定位', 'Locate on canvas')} title={t('在画布定位', 'Locate on canvas')} onClick={() => onLocateNode(nodeId)}><FocusIcon /></button> : null}
      </div>
    })}
  </div>
}

function useAgentMessageUtilitySurface(input: { streaming: boolean; isLatestEvaluable: boolean; messageId: string }) {
  const [open, setOpen] = useState(false)
  const [justFinished, setJustFinished] = useState(false)
  const wasStreamingRef = useRef(input.streaming)
  useEffect(() => {
    setOpen(false)
  }, [input.messageId])
  useEffect(() => {
    const wasStreaming = wasStreamingRef.current
    wasStreamingRef.current = input.streaming
    if (input.streaming) {
      setJustFinished(false)
      return
    }
    if (!wasStreaming || !input.isLatestEvaluable || prefersReducedMotion()) return
    setJustFinished(true)
    const timer = window.setTimeout(() => setJustFinished(false), justFinishedRevealMs)
    return () => window.clearTimeout(timer)
  }, [input.isLatestEvaluable, input.messageId, input.streaming])
  return {
    open,
    setOpen,
    className: `${input.isLatestEvaluable ? ' is-latest-evaluable' : ''}${open ? ' is-utilities-open' : ''}${justFinished ? ' is-just-finished' : ''}`,
  }
}

function AgentMessageUtilities({
  message,
  sessionId,
  actions,
  isLatestEvaluable,
  open,
  onOpenChange,
  locale,
  t,
  onEdit,
  onFeedback,
}: {
  message: BotanicAgentMessage
  sessionId?: string
  actions: BotanicAgentMessageUtilityActions
  isLatestEvaluable: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  locale: ProductLocale
  t: (zh: string, en: string) => string
  onEdit: (content: string) => void
  onFeedback: (message: BotanicAgentMessage, feedback: BotanicAgentMessage['feedback']) => void
}) {
  const [copied, setCopied] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const copiedTimerRef = useRef(0)
  useEffect(() => () => window.clearTimeout(copiedTimerRef.current), [])
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return
      onOpenChange(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [onOpenChange, open])

  const copy = async () => {
    if (!navigator.clipboard?.writeText) return
    try {
      await navigator.clipboard.writeText(message.composition ? formatBotanicAgentCompositionMessage(message.composition, locale) : message.content)
    } catch {
      return
    }
    setCopied(true)
    window.clearTimeout(copiedTimerRef.current)
    copiedTimerRef.current = window.setTimeout(() => setCopied(false), copiedStatusMs)
  }

  return <div
    ref={rootRef}
    className="agent-message__utility-layer"
    onKeyDown={(event) => {
      if (event.key !== 'Escape' || !open) return
      event.stopPropagation()
      event.preventDefault()
      onOpenChange(false)
    }}
  >
    {actions.feedback && message.feedback ? <span className="agent-message__utility-mark" aria-hidden="true">{message.feedback === 'positive' ? <ThumbUpIcon /> : <ThumbDownIcon />}</span> : null}
    {isLatestEvaluable && (actions.feedback || actions.copy) ? <button type="button" className="agent-message__utility-more" aria-expanded={open} aria-haspopup="true" aria-label={t('消息操作', 'Message actions')} title={t('消息操作', 'Message actions')} onClick={() => onOpenChange(!open)}><MoreIcon /></button> : null}
    <div className="agent-message__utilities">
      {actions.edit ? <button type="button" aria-label={t('编辑消息', 'Edit message')} title={t('编辑消息', 'Edit message')} onClick={() => onEdit(message.content)}><EditIcon /></button> : null}
      {actions.feedback && sessionId ? <>
        <button type="button" className={message.feedback === 'positive' ? 'is-selected' : ''} aria-pressed={message.feedback === 'positive'} aria-label={t('这个回答有帮助', 'This response was helpful')} title={t('有帮助', 'Helpful')} onClick={() => onFeedback(message, message.feedback === 'positive' ? undefined : 'positive')}><ThumbUpIcon /></button>
        <button type="button" className={message.feedback === 'negative' ? 'is-selected' : ''} aria-pressed={message.feedback === 'negative'} aria-label={t('这个回答需要改进', 'This response needs improvement')} title={t('需改进', 'Needs improvement')} onClick={() => onFeedback(message, message.feedback === 'negative' ? undefined : 'negative')}><ThumbDownIcon /></button>
      </> : null}
      {actions.copy ? <button type="button" aria-label={copied ? t('已复制', 'Copied') : t('复制消息', 'Copy message')} title={t('复制消息', 'Copy message')} onClick={() => void copy()}><CopyIcon /></button> : null}
      {copied ? <small className="agent-message__copied" role="status">{t('已复制', 'Copied')}</small> : null}
    </div>
  </div>
}

function AgentReviewDecision({
  review,
  pending,
  onDecision,
}: {
  review: BotanicAgentRunReview
  pending: boolean
  onDecision?: (decision: 'accepted' | 'rejected') => void
}) {
  const { locale } = useProductI18n()
  if (!review.id || !onDecision) return null
  if (review.status && review.status !== 'pending') {
    const label = review.status === 'accepted' ? (locale === 'en' ? 'Accepted' : '已接受') : review.status === 'rejected' ? (locale === 'en' ? 'Rejected' : '已退回') : (locale === 'en' ? 'Retry requested' : '已请求重试')
    return <p className="agent-review-decision" role="status">{label}{review.decisionNote ? ` · ${review.decisionNote}` : ''}</p>
  }
  return <div className="agent-review-decision" aria-label={locale === 'en' ? 'Review decision' : '评审决策'}>
    <span>{locale === 'en' ? 'Review' : '评审'}</span>
    <button type="button" disabled={pending} onClick={() => onDecision('accepted')}>{locale === 'en' ? 'Accept' : '接受'}</button>
    <button type="button" disabled={pending} onClick={() => onDecision('rejected')}>{locale === 'en' ? 'Reject' : '退回'}</button>
  </div>
}

function timelineElapsedLabel(startedAt: number, endedAt: number, locale: ProductLocale) {
  const seconds = Math.max(0, Math.floor((endedAt - startedAt) / 1_000))
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return minutes ? `${locale === 'en' ? 'Thought for' : '思考了'} ${minutes}m ${remainder}s` : `${locale === 'en' ? 'Thought for' : '思考了'} ${seconds}s`
}

function AgentToolCallIcon({
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

function TimelineStepIcon({ kind }: { kind: TimelineStepKind }) {
  // 管道步没有 toolName 时仍按 kind 兜底；accordion 行走 AgentToolCallIcon。
  return <AgentToolCallIcon kind={kind} />
}

function AgentToolAccordionRowView({
  row,
  index,
}: {
  row: AgentToolAccordionRow
  index: number
}) {
  const [detailOpen, setDetailOpen] = useState(false)
  const hasDetail = Boolean(row.error || (row.calls && row.calls.length > 1))
  const copy = (
    <span className="agent-tool-accordion__row-copy">
      <strong className={row.status === 'running' ? 'is-shimmer' : undefined}>{row.verb}</strong>
      <span className="agent-tool-accordion__detail" title={row.detail}>{row.detail}</span>
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

function AgentToolAccordionGroupView({ group }: { group: AgentToolAccordionGroup }) {
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
      {group.rows.map((row, index) => <AgentToolAccordionRowView key={row.id} row={row} index={index} />)}
    </div>
  </div>
}

function AgentToolCallAccordion({ view }: { view: AgentToolAccordionView }) {
  const { locale } = useProductI18n()
  if (!view.groups.length) return null
  const showElapsed = view.elapsedMs >= 1_000
  return <div className="agent-tool-accordion" aria-label={locale === 'en' ? 'Agent tool calls' : 'Agent 工具调用'}>
    {showElapsed ? <p className="agent-tool-accordion__elapsed">{agentToolAccordionElapsedLabel(view.elapsedMs, locale)}</p> : null}
    {view.groups.map((group) => <AgentToolAccordionGroupView key={group.id} group={group} />)}
  </div>
}

function TimelineStepMarker({
  block,
  toolItems,
}: {
  block: Extract<TimelineBlock, { type: 'step' }>
  toolItems: AgentToolCallTrace[]
}) {
  if (block.status === 'failed') return <AlertIcon />
  if (block.status === 'succeeded') return <CheckIcon />
  if (block.status === 'aborted') return <TimelineStepIcon kind={block.kind} />
  if (block.status === 'running') {
    return (
      <AgentToolOrb
        state={agentTimelineOrbState({
          kind: block.kind,
          toolName: agentTimelineStepToolName(block, toolItems),
        })}
      />
    )
  }
  return <TimelineStepIcon kind={block.kind} />
}

function timelineSearchPills(sources: TimelineWebSource[]) {
  return sources.map((source) => {
    const href = timelineWebSourceHref(source)
    return {
      hostname: source.hostname,
      ...(href ? { href } : {}),
      ...(source.title ? { title: source.title } : {}),
    }
  })
}

function AgentTimelineSearchStep({
  block,
  title,
  statusLabel,
  toolItems,
  error,
}: {
  block: Extract<TimelineBlock, { type: 'step' }>
  title: string
  statusLabel: string
  toolItems: AgentToolCallTrace[]
  error: ReactNode
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const readyRef = useRef(false)
  const [open, setOpen] = useState(false)
  const sourceCount = block.sources?.length ?? 0
  const accessibleLabel = `${title}${block.summary ? `, ${block.summary}` : ''}, ${statusLabel}`

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
  }, { dependencies: [open, sourceCount], scope: rootRef })

  return <div ref={rootRef} className={`agent-timeline__search is-${block.status}${open ? ' is-open' : ''}`}>
    <button
      type="button"
      className={`agent-timeline__step agent-timeline__search-toggle is-${block.status}`}
      aria-expanded={open}
      aria-label={accessibleLabel}
      onClick={() => setOpen((value) => !value)}
    >
      <span className="agent-timeline__step-icon" aria-hidden="true"><TimelineStepMarker block={block} toolItems={toolItems} /></span>
      <span className="agent-timeline__step-copy"><strong>{title}</strong>{block.summary ? <span>{block.summary}</span> : null}</span>
      <small>{statusLabel}</small>
      <ChevronDownIcon />
    </button>
    <div
      ref={panelRef}
      className="agent-timeline__search-panel"
      aria-hidden={!open}
      inert={!open ? true : undefined}
    >
      <AgentWebSourcePills sources={timelineSearchPills(block.sources ?? [])} />
    </div>
    {error}
  </div>
}

function timelineStepTitle(block: Extract<TimelineBlock, { type: 'step' }>, locale: ProductLocale) {
  if (block.status === 'aborted' && locale === 'en') return 'Not run'
  if (locale !== 'en' || !/\p{Script=Han}/u.test(block.title)) return block.title
  if (block.kind === 'search') {
    const count = block.count ?? 1
    if (block.status === 'running') return `Searching websites${block.count ? ` · ${count} checked` : ''}`
    if (block.status === 'failed') return `Website search failed${block.count ? ` · ${count} checked` : ''}`
    return `${count} ${count === 1 ? 'website' : 'websites'} searched`
  }
  if (block.kind === 'fetch') {
    const host = block.title.replace(/^(?:正在)?获取网页\s*|^网页获取\s*/u, '').trim()
    return host && !/\p{Script=Han}/u.test(host) ? `Fetching ${host}` : 'Fetching webpage'
  }
  if (block.kind === 'read_skill') return 'Reading Skill guide'
  if (block.kind === 'subagent') return 'Parallel research'
  if (block.kind === 'connect_runtime') return 'Connecting browser runtime'
  if (block.kind === 'read') return 'Reading project data'
  if (block.kind === 'write') return 'Writing project data'
  return 'Running tool'
}

function AgentMessageTimeline({
  timeline, loadingMore = false, onLoadMore,
}: { timeline: AgentTimelineState; loadingMore?: boolean; onLoadMore?: () => void }) {
  const { locale } = useProductI18n()
  const [now, setNow] = useState(() => Date.now())
  const accordion = presentAgentToolAccordion(timeline, locale, now)
  const toolLive = accordion?.groups.some((group) => group.status === 'running') ?? false
  const thinkingLive = timeline.blocks.some((block) => block.type === 'thinking' && block.status === 'running')
  const toolItems = timeline.blocks.find((block) => block.type === 'raw_group')?.items ?? []
  const liveAccordion = accordion

  useEffect(() => {
    if (toolLive || thinkingLive) {
      const timer = window.setInterval(() => setNow(Date.now()), 1_000)
      return () => window.clearInterval(timer)
    }
    if (accordion?.nextUpdateAt !== undefined && accordion.nextUpdateAt > now) {
      const timer = window.setTimeout(() => setNow(Date.now()), accordion.nextUpdateAt - now + 1)
      return () => window.clearTimeout(timer)
    }
  }, [accordion?.nextUpdateAt, now, thinkingLive, toolLive])

  const renderBlock = (block: TimelineBlock) => {
    if (block.type === 'thinking') {
      // accordion 已有「已处理」；有正文的思考过程仍可展开，空思考不占行。
      if (!block.text.trim()) return null
      if (liveAccordion) {
        return <details key={block.id} className={`agent-timeline__thinking is-${block.status}`}>
          <summary><ClockIcon /><span>{locale === 'en' ? 'Thinking' : '思考过程'}</span><ChevronDownIcon /></summary>
          <p>{block.text}</p>
        </details>
      }
      const label = timelineElapsedLabel(block.startedAt, block.endedAt ?? now, locale)
      const marker = block.status === 'running'
        ? <AgentThinkingOrb label={label} />
        : <ClockIcon />
      const summary = <>{marker}<span>{label}</span><small>{locale === 'en' ? 'Thinking' : '思考过程'}</small><ChevronDownIcon /></>
      return <details key={block.id} className={`agent-timeline__thinking is-${block.status}`}>
        <summary>{summary}</summary>
        <p>{block.text}</p>
      </details>
    }
    if (block.type === 'narration') return <p key={block.id} className="agent-timeline__narration">{block.text}</p>
    if (block.type === 'step') {
      const statusLabel = block.status === 'running'
        ? (locale === 'en' ? 'Running' : '进行中')
        : block.status === 'succeeded'
          ? (locale === 'en' ? 'Completed' : '已完成')
          : block.status === 'aborted'
            ? (locale === 'en' ? 'Not run' : '未执行')
            : (locale === 'en' ? 'Failed' : '失败')
      const title = conversationTimelineStepTitle(block, locale) ?? timelineStepTitle(block, locale)
      const failureCopy = block.status === 'failed'
        ? generationTaskErrorMessage(block.error, block.errorCode, locale === 'en' ? 'en' : 'zh-CN')
        : undefined
      const stepError = failureCopy
        ? <p className="agent-timeline__step-error">{failureCopy}</p>
        : null
      if (timelineStepShowsWebSources(block, toolItems)) {
        return <AgentTimelineSearchStep
          key={block.id}
          block={block}
          title={title}
          statusLabel={statusLabel}
          toolItems={toolItems}
          error={stepError}
        />
      }
      return <div key={block.id} className={`agent-timeline__step is-${block.status}`} aria-label={`${title}${block.summary ? `, ${block.summary}` : ''}, ${statusLabel}`}>
        <span className="agent-timeline__step-icon" aria-hidden="true"><TimelineStepMarker block={block} toolItems={toolItems} /></span>
        <span className="agent-timeline__step-copy"><strong>{title}</strong>{block.summary ? <span>{block.summary}</span> : null}</span>
        <small>{statusLabel}</small>
        {stepError}
      </div>
    }
    return null
  }
  const view = presentAgentTimelineConversation(timeline)
  if (!view.visible.length && !view.collapsed.length && !timeline.truncation && !liveAccordion) return null

  // 竖线轨道只服务可见动作行；accordion 用间距分组，toolLive 不再点亮 is-live，避免线压过图标。
  const flowRailLive = view.visible.some((block) => (
    (block.type === 'thinking' && block.status === 'running')
    || (block.type === 'step' && block.status === 'running')
  ))

  return <div className={`agent-timeline is-flow${flowRailLive ? ' is-live' : ''}`} aria-label={locale === 'en' ? 'Agent live progress' : 'Agent 实时进度'}>
    {liveAccordion ? <AgentToolCallAccordion view={liveAccordion} /> : null}
    {view.visible.map(renderBlock)}
    {view.collapsed.length ? <details className="agent-timeline__settled">
      <summary><span>{locale === 'en' ? 'View steps' : '查看步骤'}</span></summary>
      <div className="agent-timeline__settled-list">{view.collapsed.map(renderBlock)}</div>
    </details> : null}
    {timeline.truncation && onLoadMore ? <button type="button" className="agent-timeline__load-more" disabled={loadingMore} onClick={onLoadMore}>
      {loadingMore ? (locale === 'en' ? 'Loading…' : '加载中…') : (locale === 'en' ? 'More activity' : '更多活动')}
    </button> : null}
  </div>
}

function AgentCollapsibleContent({ content, prompt, mentionCatalog }: { content: string; prompt?: string; mentionCatalog?: BotanicAgentMentionCatalog }) {
  const { locale } = useProductI18n()
  const [expanded, setExpanded] = useState(false)
  const { body, sources } = splitAgentMessageSources(content)
  if (!agentMessageNeedsCollapse(content)) {
    return <AgentPromptResponse content={content} prompt={prompt} mentionCatalog={mentionCatalog} />
  }
  return <div className={`agent-message__collapsible${expanded ? ' is-expanded' : ''}`}>
    <div className="agent-message__collapsible-body">
      <AgentPromptResponse content={body} prompt={prompt} mentionCatalog={mentionCatalog} showSources={false} />
    </div>
    <AgentMarkdownSources sources={sources} />
    <button type="button" className="agent-message__collapsible-toggle" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
      <ChevronDownIcon />
      <span>{expanded ? (locale === 'en' ? 'Collapse' : '收起') : (locale === 'en' ? 'Show full response' : '展开全文')}</span>
    </button>
  </div>
}

function AgentPlanContextChips({
  items,
  mentionCatalog,
}: {
  items: BotanicAgentContextSnapshot[]
  mentionCatalog?: BotanicAgentMentionCatalog
}) {
  const { locale } = useProductI18n()
  if (!items.length) return null
  const kindLabel = (kind: BotanicAgentContextSnapshot['kind']) => locale === 'en'
    ? ({ '素材': 'Asset', '结果': 'Result', '文字': 'Text', '节点': 'Node' }[kind] ?? kind)
    : kind
  return <div className="agent-plan__context-locks" aria-label={locale === 'en' ? 'References' : '参考'}>
    {items.map((item) => {
      const ref = mentionCatalog?.references?.find((candidate) => candidate.id === item.nodeId)
      return <span key={item.nodeId} className="agent-plan__context-lock">
        {ref?.image ? <img src={ref.image} alt="" /> : <i aria-hidden="true">{kindLabel(item.kind).slice(0, 1)}</i>}
        <small>{ref?.label ?? item.label}</small>
      </span>
    })}
  </div>
}

function AgentPlanSettingsEditor({
  settings,
  models,
  countLabel,
  outputCount,
  disabled,
  onChange,
  onCountChange,
}: {
  settings: GenerationSettings
  models: GenerationModelOption[]
  countLabel: string
  /** 仅 single 输出可改张数；批量按素材/分支展开，改它会和来源脱节。 */
  outputCount?: number
  disabled: boolean
  onChange: (settings: GenerationSettings) => void
  onCountChange?: (count: number) => void
}) {
  const { locale } = useProductI18n()
  const selectedModel = models.find((model) => model.id === settings.model)
    ?? models[0]
    ?? { id: settings.model, label: settings.model }
  const modelOptions = models.some((model) => model.id === settings.model)
    ? models
    : [{ id: settings.model, label: settings.model }, ...models]
  const validCustom = customGenerationSizeFields(settings)
  const [customMode, setCustomMode] = useState(Boolean(validCustom))
  const [widthDraft, setWidthDraft] = useState(validCustom ? String(validCustom.outputWidth) : '')
  const [heightDraft, setHeightDraft] = useState(validCustom ? String(validCustom.outputHeight) : '')
  const [customHint, setCustomHint] = useState('')
  const [customHintError, setCustomHintError] = useState(false)
  const customSizeRef = useRef<HTMLDivElement | null>(null)
  const customSizeReadyRef = useRef(false)
  useEffect(() => {
    const next = customGenerationSizeFields(settings)
    if (!next) return
    setCustomMode(true)
    setWidthDraft(String(next.outputWidth))
    setHeightDraft(String(next.outputHeight))
  }, [settings.outputWidth, settings.outputHeight])
  const allowCustom = modelSupportsCustomSize(selectedModel)
  useGSAP(() => {
    const node = customSizeRef.current
    if (!node || !allowCustom) return
    if (!customMode) {
      gsap.set(node, { autoAlpha: 0, y: 0, display: 'none' })
      customSizeReadyRef.current = true
      return
    }
    gsap.set(node, { display: 'grid' })
    if (!customSizeReadyRef.current || prefersReducedMotion()) {
      gsap.set(node, { autoAlpha: 1, y: 0 })
      customSizeReadyRef.current = true
      return
    }
    gsap.fromTo(node, { autoAlpha: 0, y: 6 }, { autoAlpha: 1, y: 0, duration: botanicMotion.duration.chip, ease: botanicMotion.ease })
  }, { dependencies: [allowCustom, customMode] })
  const aspectRatios = selectedModel.aspectRatios ?? ['1:1', '16:9', '4:3', '3:4', '4:5', '9:16']
  const resolutions = everydayResolutions(selectedModel)
  const boostModel = clarityBoostModel(models)
  const commitCustomSize = () => {
    if (!allowCustom || !customMode) return
    if (!widthDraft.trim() && !heightDraft.trim()) {
      setCustomHint('')
      setCustomHintError(false)
      onChange(withoutCustomGenerationSize(settings))
      return
    }
    const applied = applyCustomGenerationSize(settings, Number(widthDraft), Number(heightDraft))
    if (!applied.ok || !applied.settings) {
      setCustomHint(localizeCustomGenerationSizeMessage(
        applied.ok ? '自定义宽高无效。' : applied.message,
        locale,
      ))
      setCustomHintError(true)
      return
    }
    setCustomHint(applied.snapped ? `${locale === 'en' ? 'Adjusted to' : '已对齐为'} ${applied.width}×${applied.height}` : '')
    setCustomHintError(false)
    onChange(applied.settings)
  }
  const sizeOptions = [
    ...aspectRatios.map((ratio) => ({ value: ratio, label: ratio })),
    ...(allowCustom ? [{ value: '__custom__', label: locale === 'en' ? 'Custom' : '自定义' }] : []),
  ]

  return <div className="agent-plan-settings is-editable" aria-label={locale === 'en' ? 'Generation settings' : '本次生成设置'}>
    <label>
      <small>{locale === 'en' ? 'Model' : '模型'}</small>
      <BotanicSelect
        value={settings.model}
        ariaLabel={locale === 'en' ? 'Select generation model' : '选择生成模型'}
        disabled={disabled}
        options={modelOptions.map((model) => ({ value: model.id, label: modelDisplayLabel(model) || model.label || model.id }))}
        onChange={(value) => {
          const model = modelOptions.find((item) => item.id === value)
          if (model) onChange(settingsForGenerationModel(settings, model))
        }}
      />
    </label>
    <label>
      <small>{locale === 'en' ? 'Size' : '尺寸'}</small>
      <BotanicSelect
        value={allowCustom && customMode ? '__custom__' : settings.aspectRatio}
        ariaLabel={locale === 'en' ? 'Select aspect ratio' : '选择画面比例'}
        disabled={disabled}
        options={sizeOptions}
        onChange={(value) => {
          if (value === '__custom__') {
            setCustomMode(true)
            setCustomHint('')
            setCustomHintError(false)
            return
          }
          setCustomMode(false)
          setCustomHint('')
          setCustomHintError(false)
          setWidthDraft('')
          setHeightDraft('')
          onChange({ ...withoutCustomGenerationSize(settings), aspectRatio: value as GenerationSettings['aspectRatio'] })
        }}
      />
    </label>
    <label>
      <small>{locale === 'en' ? 'Resolution' : '清晰度'}</small>
      <BotanicSelect
        value={resolutions.includes(settings.resolution) ? settings.resolution : ''}
        placeholder={settings.resolution === '4K' ? '4K' : undefined}
        ariaLabel={locale === 'en' ? 'Select output resolution' : '选择输出清晰度'}
        disabled={disabled}
        options={resolutions.map((resolution) => ({ value: resolution, label: resolution }))}
        onChange={(value) => onChange({ ...settings, resolution: value as GenerationSettings['resolution'] })}
      />
    </label>
    {onCountChange && outputCount ? <label>
      <small>{locale === 'en' ? 'Output' : '输出'}</small>
      <BotanicSelect
        value={String(outputCount)}
        ariaLabel={locale === 'en' ? 'Select output count' : '选择出图张数'}
        disabled={disabled}
        options={Array.from({ length: BOTANIC_AGENT_MAX_SINGLE_OUTPUT }, (_, index) => {
          const count = index + 1
          return { value: String(count), label: locale === 'en' ? `${count}` : `${count} 张` }
        })}
        onChange={(value) => onCountChange(Number(value))}
      />
    </label> : <span>
      <small>{locale === 'en' ? 'Output' : '输出'}</small>
      <span className="agent-plan-settings__readonly" title={locale === 'en' ? 'Output count is set by the plan' : '张数由计划展开决定'}>{countLabel}</span>
    </span>}
    {boostModel ? (
      <button
        type="button"
        className={`agent-plan-settings__boost${settings.resolution === '4K' ? ' is-selected' : ''}`}
        disabled={disabled}
        onClick={() => onChange(settings.resolution === '4K' ? clearClarityBoost(settings, models) : applyClarityBoost(settings, models))}
      >4K</button>
    ) : null}
    {selectedModel.supportsSearchGrounding ? (
      <label>
        <small>{locale === 'en' ? 'Web reference' : '参考网页'}</small>
        <button
          type="button"
          className={`agent-plan-settings__toggle${settings.searchGrounding !== false ? ' is-selected' : ''}`}
          disabled={disabled}
          onClick={() => onChange({ ...settings, searchGrounding: settings.searchGrounding === false })}
        >{settings.searchGrounding === false ? (locale === 'en' ? 'Off' : '关闭') : (locale === 'en' ? 'On' : '开启')}</button>
      </label>
    ) : null}
    {selectedModel.thinkingLevels?.length ? (
      <label>
        <small>{locale === 'en' ? 'Thinking' : '思考'}</small>
        <BotanicSelect
          value={settings.thinkingLevel ?? 'high'}
          ariaLabel={locale === 'en' ? 'Select thinking level' : '选择思考强度'}
          disabled={disabled}
          options={[
            ...(selectedModel.thinkingLevels.includes('high') ? [{ value: 'high', label: locale === 'en' ? 'High' : '充分' }] : []),
            ...(selectedModel.thinkingLevels.includes('minimal') ? [{ value: 'minimal', label: locale === 'en' ? 'Minimal' : '精简' }] : []),
          ]}
          onChange={(value) => onChange({ ...settings, thinkingLevel: value as GenerationSettings['thinkingLevel'] })}
        />
      </label>
    ) : null}
    {allowCustom ? <div ref={customSizeRef} className={`agent-plan-settings__custom${customMode ? ' is-open' : ''}`} inert={!customMode || undefined}>
      <label className="agent-plan-settings__custom-field">
        <small>{locale === 'en' ? 'Width' : '宽'}</small>
        <input
          type="number"
          inputMode="numeric"
          min={16}
          max={3840}
          step={16}
          value={widthDraft}
          disabled={disabled || !customMode}
          aria-label={locale === 'en' ? 'Custom output width' : '自定义输出宽度'}
          placeholder="1536"
          onChange={(event) => setWidthDraft(event.target.value)}
          onBlur={commitCustomSize}
        />
      </label>
      <i className="agent-plan-settings__times" aria-hidden="true">×</i>
      <label className="agent-plan-settings__custom-field">
        <small>{locale === 'en' ? 'Height' : '高'}</small>
        <input
          type="number"
          inputMode="numeric"
          min={16}
          max={3840}
          step={16}
          value={heightDraft}
          disabled={disabled || !customMode}
          aria-label={locale === 'en' ? 'Custom output height' : '自定义输出高度'}
          placeholder="864"
          onChange={(event) => setHeightDraft(event.target.value)}
          onBlur={commitCustomSize}
        />
      </label>
      {customHint ? <em className={customHintError ? 'is-error' : undefined}>{customHint}</em> : null}
    </div> : null}
  </div>
}

function AgentPlanPromptReview({
  submitted,
  instruction,
  draft,
  polished,
  mentionCatalog,
  trailing,
  onDraftChange,
  onCommit,
}: {
  submitted: boolean
  instruction: string
  draft: string
  polished: string
  mentionCatalog?: BotanicAgentMentionCatalog
  trailing?: ReactNode
  onDraftChange: (value: string) => void
  onCommit: (value: string) => void
}) {
  const { locale } = useProductI18n()
  const [expanded, setExpanded] = useState(false)
  const comparable = Boolean(instruction.trim() && instruction.trim() !== draft.trim())
  const long = draft.length > 96 || draft.split('\n').length > 3
  return <section className="agent-prompt-review" aria-label={locale === 'en' ? 'Refined prompt' : '润色后的提示词'}>
    <header>
      <strong>{submitted ? (locale === 'en' ? 'Prompt used' : '本次提示词') : (locale === 'en' ? 'Prompt' : '提示词')}</strong>
      {!submitted && long ? <button type="button" className="agent-prompt-review__toggle" onClick={() => setExpanded((open) => !open)}>{expanded ? (locale === 'en' ? 'Collapse' : '收起') : (locale === 'en' ? 'Expand' : '展开')}</button> : null}
    </header>
    {submitted
      ? <div className="agent-prompt-review__submitted"><pre className="agent-prompt-output__text"><AgentRichText text={draft} catalogs={mentionCatalog} /></pre></div>
      : <textarea
        className={!expanded && long ? 'is-clamped' : undefined}
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        onFocus={() => setExpanded(true)}
        onBlur={(event) => onCommit(event.currentTarget.value)}
        maxLength={6000}
        aria-label={locale === 'en' ? 'Refined prompt' : '润色后提示词'}
      />}
    {(trailing || comparable) ? <div className="agent-prompt-review__meta-row">
      {trailing}
      {comparable ? <details className="agent-prompt-review__compare">
        <summary>{locale === 'en' ? 'View original' : '看原文'}</summary>
        <AgentPromptDiff original={instruction} revised={draft} />
        {submitted ? null : <div className="agent-prompt-review__actions">
          <button type="button" className="agent-text-action" onClick={() => { onDraftChange(instruction); onCommit(instruction) }}>{locale === 'en' ? 'Use original' : '用原文'}</button>
          <button type="button" className="agent-text-action" onClick={() => { onDraftChange(polished); onCommit(polished) }}>{locale === 'en' ? 'Restore refinement' : '恢复润色'}</button>
        </div>}
      </details> : null}
    </div> : null}
  </section>
}

function AgentCompositionCard({
  composition,
  busy,
  mentionCatalog,
  onGenerateItem,
  onRunAll,
}: {
  composition: BotanicAgentComposition
  busy: boolean
  mentionCatalog?: BotanicAgentMentionCatalog
  onGenerateItem?: (item: BotanicAgentCompositionItem) => void
  onRunAll?: () => void
}) {
  const { locale } = useProductI18n()
  const t = (zh: string, en: string) => locale === 'en' ? en : zh
  const videoCount = composition.items.filter((item) => item.mediaKind === 'video').length
  return <section className="agent-composition" aria-label={t('创意方案', 'Creative composition')}>
    <header className="agent-composition__header">
      <small>{t('创意方案', 'Creative composition')}</small>
      <strong>{composition.theme}</strong>
      <p>
        {locale === 'en' ? `${composition.items.length} items` : `${composition.items.length} 项`}
        {videoCount ? (locale === 'en' ? ` · ${videoCount} video${videoCount === 1 ? '' : 's'}` : ` · 含 ${videoCount} 条视频`) : ''}
        {locale === 'en' ? ' · Generate an item or run the full set' : ' · 点条目生成，或一次执行整套'}
      </p>
    </header>
    <ol className="agent-composition__items">
      {composition.items.map((item) => <li key={`${item.index}-${item.title}`}>
        <div className="agent-composition__item-head">
          <b>{item.index}. {item.title}</b>
          <small>{locale === 'en'
            ? item.mediaKind === 'video'
              ? `${item.duration ?? 5}-second video`
              : `${item.count} ${item.count === 1 ? 'image' : 'images'}`
            : botanicAgentCompositionItemSpecLabel(item)}</small>
        </div>
        {item.purpose ? <p className="agent-composition__purpose">{item.purpose}</p> : null}
        <details className="agent-composition__prompt">
          <summary>{t('提示词', 'Prompt')}</summary>
          <pre className="agent-prompt-output__text"><AgentRichText text={item.prompt} catalogs={mentionCatalog} /></pre>
        </details>
        {onGenerateItem ? <button
          type="button"
          className="agent-composition__item-action"
          disabled={busy}
          onClick={() => onGenerateItem(item)}
        >{t('生成此项', 'Generate item')}</button> : null}
      </li>)}
    </ol>
    {onRunAll ? <div className="agent-composition__footer">
      <button type="button" className="agent-composition__run" disabled={busy} onClick={onRunAll}>{t('执行整套', 'Run full set')}</button>
    </div> : null}
  </section>
}

type AgentConversationMessageProps = {
  message: BotanicAgentMessage
  timeline?: AgentTimelineState
  timelineLoadingMore?: boolean
  onLoadMoreTimeline?: () => void
  streaming?: boolean
  isLatestAssistant?: boolean
  agentBusy?: boolean
  isLatestEvaluable?: boolean
  sessionId?: string
  runs: BotanicAgentRun[]
  artifacts: BotanicAgentArtifact[]
  contextOptionIds: string[]
  mentionCatalog?: BotanicAgentMentionCatalog
  generationModels: GenerationModelOption[]
  executionMode: BotanicAgentExecutionMode
  planning: boolean
  promptUsePending: boolean
  plannerModel: string
  executingActionId: string
  submittingMessageId: string
  promptDraft?: string
  onContinueResultContext: (nodeIds: string[], outputCount: number) => void
  onShowResults: () => void
  onFocusNodes: (nodeIds: string[]) => void
  /** 把这次运行带进画布的自动化面板；发布本身仍在那里完成。 */
  onPromoteRunToWorkflow: (runId: string) => void
  onAnswerClarification: (message: BotanicAgentMessage, answers: Record<string, string>) => void
  onLocateNode: (nodeId: string) => void
  canManualRetryAction: (action: BotanicAgentActionProposal) => boolean
  onActionIntent: (message: BotanicAgentMessage, action: BotanicAgentActionProposal, intent: BotanicAgentActionUserIntent) => void
  onDismissAction: (message: BotanicAgentMessage, action: BotanicAgentActionProposal) => void
  onPromptDraftChange: (messageId: string, prompt: string) => void
  onCommitPlanPrompt: (message: BotanicAgentMessage, prompt: string) => void
  onCommitPlanSettings: (message: BotanicAgentMessage, settings: GenerationSettings) => void
  onCommitPlanOutputCount: (message: BotanicAgentMessage, count: number) => void
  /** 会话已交出的确认理由；外部行动不在其中。 */
  confirmationWaivers?: readonly BotanicAgentConfirmationWaiver[]
  onWaiveConfirmation: (waiver: BotanicAgentConfirmationWaiver) => void
  onConfirmPlan: (message: BotanicAgentMessage) => void
  onGenerateCompositionItem?: (message: BotanicAgentMessage, item: BotanicAgentCompositionItem) => void
  onRunComposition?: (message: BotanicAgentMessage) => void
  onUsePrompt: (message: BotanicAgentMessage) => void
  onEdit: (content: string) => void
  onRetryDelivery: (messageId: string) => void
  onDiscardDelivery: (messageId: string) => void
  onFeedback: (message: BotanicAgentMessage, feedback: BotanicAgentMessage['feedback']) => void
  onSaveAsMemory?: (message: BotanicAgentMessage, kind: BotanicAgentMemoryKind, content: string) => string | null
  onReviewDecision?: (message: BotanicAgentMessage, decision: 'accepted' | 'rejected') => void
  reviewDecisionPending?: boolean
}

export function AgentConversationMessage({
  message,
  timeline,
  timelineLoadingMore = false,
  onLoadMoreTimeline,
  streaming = false,
  isLatestAssistant = false,
  agentBusy = false,
  isLatestEvaluable = false,
  sessionId,
  runs,
  artifacts,
  contextOptionIds,
  mentionCatalog,
  generationModels,
  executionMode,
  planning,
  promptUsePending,
  plannerModel,
  executingActionId,
  submittingMessageId,
  promptDraft,
  onContinueResultContext,
  onShowResults,
  onFocusNodes,
  onAnswerClarification,
  onLocateNode,
  canManualRetryAction,
  onActionIntent,
  onDismissAction,
  onPromptDraftChange,
  onCommitPlanPrompt,
  onCommitPlanSettings,
  onCommitPlanOutputCount,
  confirmationWaivers,
  onWaiveConfirmation,
  onConfirmPlan,
  onGenerateCompositionItem,
  onRunComposition,
  onUsePrompt,
  onEdit,
  onRetryDelivery,
  onDiscardDelivery,
  onFeedback,
  onSaveAsMemory,
  onReviewDecision,
  reviewDecisionPending = false,
}: AgentConversationMessageProps) {
  const { locale } = useProductI18n()
  const t = (zh: string, en: string) => locale === 'en' ? en : zh
  const [feedbackMemoryOpen, setFeedbackMemoryOpen] = useState(false)
  const [feedbackMemoryKind, setFeedbackMemoryKind] = useState<BotanicAgentMemoryKind>('avoid')
  const [feedbackMemoryDraft, setFeedbackMemoryDraft] = useState('')
  const [feedbackMemorySaved, setFeedbackMemorySaved] = useState(false)
  useEffect(() => {
    setFeedbackMemoryOpen(Boolean(message.feedback))
    setFeedbackMemoryKind(message.feedback === 'positive' ? 'approved' : 'avoid')
    setFeedbackMemoryDraft('')
    setFeedbackMemorySaved(false)
  }, [message.id, message.feedback])
  const utilitySurface = useAgentMessageUtilitySurface({ streaming, isLatestEvaluable, messageId: message.id })
  const dimensionLabel = (dimension: string) => locale === 'en'
    ? ({ person: 'Person', pose: 'Pose', product: 'Product', garment: 'Garment', scene: 'Scene', composition: 'Composition', style: 'Style', lighting: 'Lighting' }[dimension] ?? dimension)
    : creativeDimensionLabel(dimension as Parameters<typeof creativeDimensionLabel>[0])
  const planCountLabel = (plan: NonNullable<BotanicAgentMessage['plan']>) => locale === 'en'
    ? `${plan.output.count} image${plan.output.count === 1 ? '' : 's'}`
    : botanicAgentPlanSheetCountLabel(plan)
  const linkedRun = message.runId ? runs.find((run) => run.id === message.runId) : undefined
  const bobPlays = useBobSaysPlays(`message:${message.id}`)
  // 进行中的状态由 runtime feed / 底部进度条直播；对话里不画第二张「正在生成」卡。
  if (message.kind === 'run' && linkedRun && shouldRestoreBotanicAgentRuntimeSteps(linkedRun.status)) return null
  const runArtifacts = message.runId
    ? artifacts.filter((artifact) => artifact.provenance.runId === message.runId)
    : []
  const outputNodeIds = runArtifacts.flatMap((artifact) => artifact.provenance.sourceNodeIds ?? [])
  const lockedContextIds = botanicAgentContextSnapshotNodeIds(linkedRun?.plan.contextSnapshot, contextOptionIds)
  const continueNodeIds = [...new Set(outputNodeIds.length ? outputNodeIds : lockedContextIds)]
  const planPrompt = message.plan ? promptDraft ?? message.plan.prompt : ''

  const isLiveRunMessage = message.role === 'assistant' && Boolean(message.runId) && (message.kind === 'run' || message.kind === 'notice')
  const planSubmitted = message.status === 'submitted'
  const runMediaArtifacts = runArtifacts.filter((artifact) => artifact.url && (artifact.kind === 'image' || artifact.kind === 'video'))
  const inlineRunResults = runMediaArtifacts.slice(0, inlineRunResultLimit)

  // 结算后时间线已经报了「已出图 / 出图失败」；回执里同一句不再占第二行。部分完成仍用正文。
  const hideSettledStatusCopy = Boolean(
    timeline
    && (message.kind === 'run' || message.kind === 'notice')
    && (
      (linkedRun?.status === 'completed' && outputNodeIds.length)
      || linkedRun?.status === 'failed'
      || linkedRun?.status === 'cancelled'
    )
  )
  const liveStatus = isLiveRunMessage || streaming
  const allowsSays = message.role === 'assistant' && bobMessageAllowsSays({
    isLatestAssistant,
    isLargeReply: bobMessageIsLargeReply(message),
  })
  const bob = message.role === 'assistant'
    ? bobReplyPresentation({
      allowsSays: allowsSays && !prefersReducedMotion(),
      streaming,
      isLatestAssistant,
      agentBusy,
      plays: bobPlays.plays,
    })
    : null
  const utilityActions = botanicAgentMessageUtilityActions(message)
  const showUtilities = !timeline && !streaming && botanicAgentMessageHasUtilities(utilityActions)
  // 结算后有图：正文 → 产物 → 过程；过程默认已折叠，不挡主阅读。
  const runResults = message.kind === 'run' && inlineRunResults.length
    ? <div className={`agent-run-message__results${!streaming ? ' is-featured' : ''}`} aria-label={t('本次任务结果', 'Task results')}>
      {inlineRunResults.map((artifact) => artifact.kind === 'image'
        ? <img key={artifact.id} src={artifact.url} alt={artifact.label} />
        : <video key={artifact.id} src={artifact.url} muted playsInline aria-label={artifact.label} />)}
      {runMediaArtifacts.length > inlineRunResults.length ? <button type="button" className="agent-run-message__more" onClick={onShowResults}>
        {t(`查看全部 ${runMediaArtifacts.length} 项`, `View all ${runMediaArtifacts.length} results`)}
      </button> : null}
    </div>
    : null
  const resultsFirst = Boolean(runResults && !streaming)
  const messageProse = message.kind === 'composition' && message.composition
    ? <AgentCompositionCard
      composition={message.composition}
      busy={planning || submittingMessageId === message.id}
      mentionCatalog={mentionCatalog}
      onGenerateItem={onGenerateCompositionItem ? (item) => onGenerateCompositionItem(message, item) : undefined}
      onRunAll={onRunComposition ? () => onRunComposition(message) : undefined}
    />
    // 计划消息的标题与 plan.summary 相同，只在计划卡上展示一次，避免主列重复。
    : !hideSettledStatusCopy && !message.plan && !message.question && (message.content || message.mentions?.length || streaming) ? (message.role === 'assistant'
      ? streaming
        ? message.content
          ? <AgentPromptResponse content={message.content} prompt={message.prompt} mentionCatalog={mentionCatalog} />
          // 时间线画得出内容时进度在上面；空时间线仍要占位，不能让气泡整段空白。
          : timeline && agentTimelineHasRenderableContent(timeline) ? null : <p className="agent-message__pending">{t('正在规划这一步…', 'Planning the next step…')}</p>
        : <AgentCollapsibleContent content={message.content} prompt={message.prompt} mentionCatalog={mentionCatalog} />
      : <AgentMessageRichContent content={message.content} mentions={message.mentions} catalogs={mentionCatalog} />) : null

  return <article className={`agent-message is-${message.role} is-${message.kind}${timeline ? ' has-timeline' : ''}${allowsSays ? ' is-bob-large' : ''}${showUtilities ? utilitySurface.className : ''}`} role={liveStatus ? 'status' : undefined} aria-live={liveStatus ? 'polite' : undefined} aria-busy={streaming || undefined}>
    <div className="agent-message__role" data-bob-mood={bob?.mood} data-bob-says={bob?.says}>{bob ? <BobCharacter mood={bob.mood} says={bob.says} saysCycles={bob.cycles} onSaysComplete={() => bobPlays.markPlayed(bob.says)} /> : <span>{t('你', 'You')}</span>}</div>
    <div className="agent-message__body">
      {resultsFirst ? null : timeline ? <AgentMessageTimeline timeline={timeline} loadingMore={timelineLoadingMore} onLoadMore={onLoadMoreTimeline} /> : null}
      {messageProse}
      {runResults}
      {resultsFirst && timeline ? <AgentMessageTimeline timeline={timeline} loadingMore={timelineLoadingMore} onLoadMore={onLoadMoreTimeline} /> : null}
      {message.role === 'assistant' && botanicAgentMessageOffersVisualPrompt(message) ? <div className="agent-run-message__actions" aria-label={t('Prompt 操作', 'Prompt actions')}>
        <button type="button" disabled={planning || promptUsePending} onClick={() => onUsePrompt(message)}>{promptUsePending ? t('等待确认', 'Awaiting approval') : t('用这段 Prompt 生成', 'Generate with this prompt')}</button>
      </div> : null}
      {message.review ? <AgentReviewDecision review={message.review} pending={reviewDecisionPending} onDecision={onReviewDecision ? (decision) => onReviewDecision(message, decision) : undefined} /> : null}
      {message.runId && !message.plan ? (() => {
        const actions = [
          ...(outputNodeIds.length ? [{ key: 'locate', label: t('定位画布', 'Locate on canvas'), onClick: () => onFocusNodes(outputNodeIds), icon: <PinNodeIcon /> }] : []),
          ...(message.kind === 'run' && continueNodeIds.length > 0
            ? [{ key: 'continue', label: t('继续修改', 'Continue editing'), onClick: () => onContinueResultContext(continueNodeIds, outputNodeIds.length), icon: <ContinueChatIcon /> }]
            : []),
        ]
        if (!actions.length) return null
        return <div className="agent-run-message__bar" aria-label={t('结果操作', 'Result actions')}>
          {actions.map((action) => <button type="button" key={action.key} className="agent-run-message__icon" onClick={action.onClick} aria-label={action.label} data-tooltip={action.label}>{action.icon}</button>)}
        </div>
      })() : null}
      {message.question ? message.status === 'answered' ? <AgentClarificationCard
        clarification={message.question}
        generationModels={generationModels}
        state="completed"
        onSubmit={(answers) => onAnswerClarification(message, answers)}
      /> : <AgentClarificationCard
        clarification={message.question}
        generationModels={generationModels}
        state={planning ? 'submitting' : 'idle'}
        onSubmit={(answers) => onAnswerClarification(message, answers)}
      /> : null}
      {message.plan ? (() => {
        const plan = message.plan
        const pendingActionCount = botanicAgentPendingConfirmationCount(plan.actions)
        const blockedByActions = pendingActionCount > 0
        const executionDecision = resolveBotanicAgentExecutionDecision({
          mode: executionMode,
          settingsComplete: true,
          pendingActionCount,
          outputCount: plan.output.count,
          allowAutoSubmit: plan.requiresGenerationConfirmation !== true,
          waivers: confirmationWaivers,
        })
        // 有豁免后计划模式也会因张数停下，所以暂停说明不再限定自动模式。
        const autoPauseHint = botanicAgentExecutionPauseHint(executionDecision, {
          pendingActionCount,
          outputCount: plan.output.count,
        }, locale)
        // 只允许用户豁免模式和批量张数；外部行动、模型推断意图永远需要当次确认。
        const waivableReason = executionDecision.action === 'confirm'
          && (executionDecision.reason === 'manual' || executionDecision.reason === 'batch_count')
          && !confirmationWaivers?.includes(executionDecision.reason)
          ? executionDecision.reason
          : null
        const appliedSkills = plan.actions?.filter((action) => action.toolName === 'skill_apply') ?? []
        const confirmableActions = plan.actions?.filter((action) => action.toolName !== 'skill_apply') ?? []
        const lockedConstraints = plan.constraints.filter((constraint) => constraint.mode === 'preserve')
        const variedConstraints = plan.constraints.filter((constraint) => constraint.mode === 'vary')
        const branchPrompts = botanicAgentPlanBranchPrompts({
          ...plan,
          prompt: planSubmitted ? plan.prompt : planPrompt,
        })
        const planModel = generationModels.find((model) => model.id === plan.settings.model)
        const modelLabel = modelDisplayLabel(planModel) || plan.settings.model
        const customSize = Number.isInteger(plan.settings.outputWidth) && Number.isInteger(plan.settings.outputHeight)
        const contextItems = plan.contextSnapshot ?? []
        const promptReview = <AgentPlanPromptReview
          submitted={planSubmitted}
          instruction={plan.instruction}
          draft={planSubmitted ? plan.prompt : planPrompt}
          polished={plan.prompt}
          mentionCatalog={mentionCatalog}
          trailing={planSubmitted ? <p className="agent-plan__meta" aria-label={t('本次生成设置', 'Generation settings')}>
            <span className="agent-plan__meta-model">
              <img src={modelProviderLogo(planModel)} alt="" />
              {modelLabel}
            </span>
            {customSize
              ? <span className="agent-plan__meta-spec">{plan.settings.outputWidth}×{plan.settings.outputHeight}</span>
              : <>
                {plan.settings.aspectRatio ? <span className="agent-plan__meta-spec">{plan.settings.aspectRatio}</span> : null}
                {plan.settings.resolution ? <span className="agent-plan__meta-spec">{plan.settings.resolution}</span> : null}
              </>}
            {plan.settings.duration ? <span className="agent-plan__meta-spec">{plan.settings.duration}{t('秒', 's')}</span> : null}
            {plan.output.count > 1 ? <span className="agent-plan__meta-spec">{planCountLabel(plan)}</span> : null}
          </p> : null}
          onDraftChange={(value) => onPromptDraftChange(message.id, value)}
          onCommit={(value) => onCommitPlanPrompt(message, value)}
        />
        const recipe = <>
          {planSubmitted ? promptReview : null}
          {plan.toolCalls?.length ? (() => {
            // Run 投影产出的时间线常常只有 exec: 管道步、画不出工具 accordion；
            // 只有 timeline 真能渲染 accordion 时才让它接管，否则计划卡自己兜底。
            if (timeline && presentAgentToolAccordion(timeline, locale)) return null
            const view = presentAgentToolAccordionFromCalls(plan.toolCalls, locale)
            return view ? <AgentToolCallAccordion view={view} /> : null
          })() : null}
          {appliedSkills.length ? <div className="agent-plan__skills" aria-label={t('已应用 Skill', 'Applied Skills')}>
            {appliedSkills.map((action) => {
              const name = botanicAgentAppliedSkillName(action)
              return <span key={action.id}>Skill · {name === '已应用' ? t('已应用', 'Applied') : name}</span>
            })}
          </div> : null}
          {confirmableActions.length ? <div className="agent-message__actions" aria-label={t('待确认行动', 'Actions awaiting approval')}>
            {confirmableActions.map((action) => {
              // 已执行或已跳过的行动卡收成一行，只有仍需处理的卡片保持展开。
              const settled = action.status === 'succeeded' || action.status === 'dismissed'
              const body = <>
                <div className="agent-action-card__impact"><span>{t('输入', 'Input')}</span><b>{action.toolName === 'mcp_call' ? `${String(action.arguments.server)}.${String(action.arguments.tool)}` : t('新项目 Skill', 'New project Skill')}</b><span>{t('输出', 'Output')}</span><b>{action.toolName === 'mcp_call' ? t('文件 / 结果面板', 'Files / results panel') : t('可复用 Skill', 'Reusable Skill')}</b></div>
                <details className="agent-action-card__details"><summary>{t('查看参数', 'View parameters')}</summary><pre>{JSON.stringify(action.arguments, null, 2)}</pre></details>
                {action.error ? <small className="agent-action-card__error">{action.error}</small> : null}
                {action.status === 'succeeded' ? <>
                  <div className="agent-action-card__result"><span>{action.result ? t('已执行', 'Executed') : t('已确认生效', 'Confirmed applied')}</span>{action.result?.canvasNodeIds?.length ? <small>{t(`已创建 ${action.result.canvasNodeIds.length} 个画布节点`, `${action.result.canvasNodeIds.length} canvas nodes created`)}</small> : !action.result ? <small>{t('未重放工具，也未生成虚构输出', 'No tool replay or fabricated output')}</small> : null}{action.result?.canvasNodeId ? <button type="button" className="agent-icon-button" aria-label={t('在画布定位结果', 'Locate result on canvas')} title={t('在画布定位', 'Locate on canvas')} onClick={() => onLocateNode(action.result!.canvasNodeId!)}><FocusIcon /></button> : null}</div>
                  {action.result?.artifacts?.length ? <AgentActionResultArtifacts artifacts={action.result.artifacts} onLocateNode={onLocateNode} locale={locale} /> : null}
                </> : null}
                {action.status === 'running' ? <div className="agent-action-card__running"><span>{t('执行状态待确认', 'Execution status needs confirmation')}</span><button type="button" disabled={executingActionId === action.id} onClick={() => onActionIntent(message, action, 'check_status')}>{executingActionId === action.id ? t('确认中…', 'Checking…') : t('确认状态', 'Check status')}</button></div> : null}
                {action.status === 'uncertain' ? <div className="agent-action-card__running"><span>{t('结果未知，为避免重复操作已停止自动重试。请先到目标系统核对。', 'Outcome unknown. Automatic retry is blocked to avoid duplication; verify the target system first.')}</span><div className="agent-action-card__buttons"><button type="button" className="is-secondary" disabled={executingActionId === action.id} onClick={() => onActionIntent(message, action, 'confirmed_not_applied')}>{t('确认未生效，可重试', 'Not applied; allow retry')}</button><button type="button" disabled={executingActionId === action.id} onClick={() => onActionIntent(message, action, 'confirmed_applied')}>{t('已在目标系统生效', 'Applied in target system')}</button></div></div> : null}
                {action.status === 'awaiting_confirmation' ? <div className="agent-action-card__buttons">
                  <button type="button" className="is-secondary" onClick={() => onDismissAction(message, action)}>{t('跳过', 'Skip')}</button>
                  <button type="button" disabled={executingActionId === action.id} onClick={() => onActionIntent(message, action, 'execute')}>{executingActionId === action.id ? t('执行中…', 'Executing…') : t('确认执行', 'Approve and run')}</button>
                </div> : null}
                {action.status === 'failed' ? canManualRetryAction(action) ? <div className="agent-action-card__buttons"><button type="button" disabled={executingActionId === action.id} onClick={() => onActionIntent(message, action, 'manual_retry')}>{executingActionId === action.id ? t('执行中…', 'Executing…') : action.manualRetryResumeAvailable ? t('继续执行', 'Continue') : t('重新执行', 'Run again')}</button></div> : <small>{t('本次失败不会原地换新标识重试，请重新发起行动。', 'This failed action will not be retried under a new identity. Start a new action.')}</small> : null}
              </>
              if (settled) return <details key={action.id} className={`agent-action-card is-settled is-${action.status}`}>
                <summary><span>{action.kind === 'skill' ? 'SKILL' : action.kind === 'canvas' ? t('画布', 'CANVAS') : 'MCP'}</span><strong>{action.label}</strong><small>{action.status === 'succeeded' ? action.result ? t('已执行', 'Executed') : t('已确认生效', 'Confirmed applied') : t('已跳过', 'Skipped')}</small></summary>
                <p>{action.summary}</p>
                {body}
              </details>
              return <article key={action.id} className={`agent-action-card is-${action.status}`}>
                <header><span>{action.kind === 'skill' ? 'SKILL' : action.kind === 'canvas' ? t('画布', 'CANVAS') : 'MCP'}</span><small>{action.risk === 'external' ? t('外部调用', 'External action') : t('写入项目', 'Writes to project')}</small></header>
                <strong>{action.label}</strong>
                <p>{action.summary}</p>
                {body}
              </article>
            })}
          </div> : null}
          {planSubmitted ? null : <div className="agent-message__constraints">
            {lockedConstraints.length ? <div className="agent-message__constraint-group is-locked"><span>{t('锁定', 'Locked')}</span>{lockedConstraints.map((constraint) => <b key={constraint.dimension}>{dimensionLabel(constraint.dimension)}</b>)}</div> : null}
            {variedConstraints.length ? <div className="agent-message__constraint-group is-variable"><span>{t('变化', 'Varied')}</span>{variedConstraints.map((constraint) => <b key={constraint.dimension}>{dimensionLabel(constraint.dimension)}</b>)}</div> : null}
          </div>}
          {planSubmitted
            ? null
            : <>
              <AgentPlanSettingsEditor
                settings={plan.settings}
                // 换模型不能顺便换媒体类型：视频计划带着 duration，切到图片模型会在提交时被拒。
                models={generationModels.filter((model) => (model.mediaKind === 'video') === (botanicAgentPlanMediaKind(plan) === 'video'))}
                countLabel={locale === 'en' ? planCountLabel(plan) : botanicAgentPlanSheetCountLabel(plan)}
                // 批量按素材组 / 变体分支展开，张数由来源决定；只有 single 才交给用户改。
                {...(plan.output.mode === 'single'
                  ? {
                    outputCount: plan.output.count,
                    onCountChange: (count: number) => onCommitPlanOutputCount(message, count),
                  }
                  : {})}
                disabled={submittingMessageId === message.id}
                onChange={(settings) => onCommitPlanSettings(message, settings)}
              />
              {contextItems.length ? <AgentPlanContextChips items={contextItems} mentionCatalog={mentionCatalog} /> : null}
              {promptReview}
            </>}
          {branchPrompts.length ? <section className="agent-plan-branches" aria-label={t('变体分支，原参考图保留，各分支单独出图', 'Variation branches; original references are preserved and each branch generates separately')}>
            <ol>{branchPrompts.map((branch, index) => <li key={`${branch.label}-${index}`}>
              <b>{branch.label}</b>
              <p><AgentRichText text={branch.delta || branch.prompt} catalogs={mentionCatalog} /></p>
              {branch.delta ? <details className="agent-plan-branches__full"><summary>{t('完整提示词', 'Full prompt')}</summary><pre className="agent-prompt-output__text"><AgentRichText text={branch.prompt} catalogs={mentionCatalog} /></pre></details> : null}
            </li>)}</ol>
          </section> : null}
          {pendingActionCount ? <details className="agent-message__route"><summary>{t('执行路由', 'Execution route')}</summary><div><span>{t('规划', 'Planning')}</span><b>{agentPlannerModelLabel(plan.plannerModel ?? plannerModel)}</b><span>{t('生成', 'Generation')}</span><b>{plan.settings.model}</b><span>{t('外部行动', 'External actions')}</span><b>{t(`${pendingActionCount} 项，确认后执行`, `${pendingActionCount} to run after approval`)}</b></div></details> : null}
          {planSubmitted ? null : <div className="agent-plan__footer">
            {/* 停在这里一定有原因，必须说清楚，否则用户只会觉得“自动模式没生效”。 */}
            {autoPauseHint ? <small className="agent-plan__auto-paused">{autoPauseHint}</small> : null}
            {/* 信任按理由逐条交出：勾一次，这一类以后不再拦。外部行动和模型推断意图不在这里。 */}
            {waivableReason ? <label className="agent-plan__waiver">
              <input
                type="checkbox"
                checked={false}
                disabled={submittingMessageId === message.id}
                onChange={() => onWaiveConfirmation(waivableReason)}
              />
              <span>{waivableReason === 'batch_count'
                ? t('多张出图以后直接执行', 'Run multi-image plans without asking')
                : t('这类出图以后直接执行', 'Run image plans without asking')}</span>
            </label> : null}
            <button type="button" className="agent-plan__confirm" disabled={submittingMessageId === message.id || blockedByActions} onClick={() => onConfirmPlan(message)}>{locale === 'en' ? (submittingMessageId === message.id ? 'Submitting…' : blockedByActions ? 'Confirm the actions below' : message.status === 'failed' ? 'Retry generation' : `Generate ${plan.output.count} image${plan.output.count === 1 ? '' : 's'}`) : botanicAgentPlanConfirmActionLabel(plan, submittingMessageId === message.id ? 'submitting' : blockedByActions ? 'blocked' : message.status === 'failed' ? 'failed' : 'ready')}</button>
          </div>}
        </>
        // 已提交：提示词 + 规格芯片当回执；对话里不放任务入口。
        if (planSubmitted) {
          const receiptHeadline = presentBotanicAgentPlanSummary(plan.summary)
          const receiptActions = Boolean(outputNodeIds.length || continueNodeIds.length)
          return <div className="agent-message__plan is-submitted">
          {timeline || !receiptHeadline ? null : <header className="agent-plan__receipt-header">
            <strong>{receiptHeadline}</strong>
          </header>}
          {recipe}
          {receiptActions ? <div className="agent-plan__receipt-actions" aria-label={t('结果操作', 'Result actions')}>
            {outputNodeIds.length ? <button type="button" className="agent-run-message__icon" aria-label={t('定位画布', 'Locate on canvas')} data-tooltip={t('定位画布', 'Locate on canvas')} onClick={() => onFocusNodes(outputNodeIds)}><PinNodeIcon /></button> : null}
            {continueNodeIds.length ? <button type="button" className="agent-run-message__icon" aria-label={t('继续修改', 'Continue editing')} data-tooltip={t('继续修改', 'Continue editing')} onClick={() => onContinueResultContext(continueNodeIds, outputNodeIds.length)}><ContinueChatIcon /></button> : null}
          </div> : null}
        </div>
        }
        return <div className="agent-message__plan">{recipe}</div>
      })() : null}
    </div>
    {message.role === 'user' && message.deliveryStatus === 'failed' ? <small className="agent-message__delivery-status is-failed" role="alert">{t('同步失败', 'Sync failed')} <button type="button" onClick={() => onRetryDelivery(message.id)}>{t('重试', 'Retry')}</button> <button type="button" onClick={() => onDiscardDelivery(message.id)}>{t('不再同步', 'Discard')}</button></small> : null}
    {showUtilities ? <AgentMessageUtilities
      message={message}
      sessionId={sessionId}
      actions={utilityActions}
      isLatestEvaluable={isLatestEvaluable}
      open={utilitySurface.open}
      onOpenChange={utilitySurface.setOpen}
      locale={locale}
      t={t}
      onEdit={onEdit}
      onFeedback={onFeedback}
    /> : null}
    {message.role === 'assistant' && sessionId && message.feedback && onSaveAsMemory && feedbackMemoryOpen ? <form className="agent-feedback-memory" onSubmit={(event) => {
      event.preventDefault()
      const content = feedbackMemoryDraft.trim()
      if (!content) return
      const saved = onSaveAsMemory(message, feedbackMemoryKind, content)
      if (!saved) return
      setFeedbackMemorySaved(true)
      setFeedbackMemoryOpen(false)
    }}>
      <div className="agent-feedback-memory__header"><strong>{message.feedback === 'positive' ? t('把认可方向留下来', 'Keep this approved direction') : t('把改进点留下来', 'Keep this improvement point')}</strong><button type="button" onClick={() => setFeedbackMemoryOpen(false)} aria-label={t('关闭反馈记忆', 'Close feedback memory')}>×</button></div>
      <select value={feedbackMemoryKind} onChange={(event) => setFeedbackMemoryKind(event.target.value as BotanicAgentMemoryKind)} aria-label={t('记忆类型', 'Memory type')}>
        <option value="approved">{t('已确认方向', 'Approved direction')}</option>
        <option value="rule">{t('长期规则', 'Long-term rule')}</option>
        <option value="avoid">{t('避免事项', 'Avoid')}</option>
      </select>
      <textarea value={feedbackMemoryDraft} onChange={(event) => setFeedbackMemoryDraft(event.target.value)} placeholder={message.feedback === 'positive' ? t('例如：保留这种克制的自然光与留白。', 'For example: Keep this restrained natural light and negative space.') : t('写下以后要避免或修正的具体点。', 'Write the specific thing to avoid or change next time.')} rows={2} />
      <button type="submit" disabled={!feedbackMemoryDraft.trim()}>{t('保存到项目记忆', 'Save to project memory')}</button>
    </form> : null}
    {feedbackMemorySaved ? <small className="agent-feedback-memory__saved" role="status">{t('已保存到项目记忆。', 'Saved to project memory.')}</small> : null}
  </article>
}
