import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { agentArtifactTargetNodeIds } from '../../domain/agentArtifactTargets'
import { botanicMotion, gsap, prefersReducedMotion, useGSAP } from '../../components/gsapMotion'
import {
  BOTANIC_AGENT_MAX_SINGLE_OUTPUT,
  botanicAgentAppliedSkillName,
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
import { AlertIcon, CheckIcon, ChevronDownIcon, ContinueChatIcon, CopyIcon, EditIcon, FocusIcon, MoreIcon, PinNodeIcon, ThumbDownIcon, ThumbUpIcon } from '../../components/BotanicIcons'
import { AgentToolOrb } from '../../components/AgentToolOrb'
import { AgentInlineCitation, AgentWebSourcePills } from '../../components/AgentWebSourcePills'
import { agentPlannerModelLabel, modelDisplayLabel, modelProviderLogo } from '../../components/generationModelPresentation'
import { BotanicSelect } from '../../components/BotanicSelect'
import { AgentPromptDiff } from './AgentWorkspaceParts'
import { AgentClarificationMessage } from './AgentClarificationMessage'
import { AgentMarkdownSources } from './AgentMarkdown'
import { AgentPromptResponse } from './AgentPromptResponse'
import { AgentCanvasActionPreview } from './AgentCanvasActionPreview'
import { AgentActionImpact, AgentPlanImpactSummary } from './AgentImpactSummary'
import { AgentMessageMentions, AgentMessageRichContent, AgentRichText } from './AgentMentionText'
import { agentMessageNeedsCollapse, splitAgentMessageSources } from '../../domain/agentMarkdown'
import type { BotanicAgentMentionCatalog } from '../../domain/agentMentions'
import { botanicAgentMessageRichView } from '../../domain/agentMentions'
import {
  botanicAgentMessageHasUtilities,
  botanicAgentMessageIsRunLinked,
  botanicAgentMessageIsSettled,
  botanicAgentMessageUtilityActions,
  botanicAgentRunResultReadState,
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
import { botanicAgentMessageIsReview } from '../../domain/agentMessageUtilities'
import { agentTimelineOrbState, agentTimelineStepToolName, timelineStepShowsWebSources, timelineWebSourceHref, type AgentTimelineState, type TimelineBlock, type TimelineStepKind, type TimelineWebSource } from '../../domain/agentTimeline'
import { agentTimelineHasRenderableContent, agentToolDurationLabel, conversationTimelineStepTitle, presentAgentTimelineConversation, presentAgentToolAccordion, presentAgentToolAccordionFromCalls } from '../../domain/agentToolAccordion'
import { AgentToolCallAccordion, AgentToolCallIcon } from './AgentActionCard'
import { Message, MessageContent } from '../../components/ai-elements/message'
import { AgentReferenceUsageDetails } from './AgentReferenceUsage'
import { prepareAgentReference } from '../../lib/agentReferencePreparation'
import { serverPersistenceEnabled } from '../../lib/productSession'
import { Reasoning, ReasoningContent, ReasoningTrigger } from '../../components/ai-elements/reasoning'
import { Shimmer } from '../../components/ai-elements/shimmer'
import { agentArtifactDisplayName } from './agentDisplayNames'
import { Sources, SourcesContent, SourcesTrigger } from '../../components/ai-elements/sources'
import { Artifact, ArtifactContent, ArtifactHeader, ArtifactTitle } from '../../components/ai-elements/artifact'
import { WebPreview } from '../../components/ai-elements/web-preview'
import { Plan, PlanAction, PlanContent, PlanDescription, PlanHeader, PlanTitle, PlanTrigger } from '../../components/ai-elements/plan'
import { ModelSelector } from '../../components/ai-elements/model-selector'
import { CodeBlock } from '../../components/ai-elements/code-block'
import { Attachment as ElementsAttachment, AttachmentInfo as ElementsAttachmentInfo, AttachmentPreview as ElementsAttachmentPreview, Attachments as ElementsAttachments, type AttachmentData as ElementsAttachmentData } from '../../components/ai-elements/attachments'
import { AgentAttachment, AgentAttachmentHoverPreview, AgentAttachmentInfo, AgentAttachmentPreview, AgentAttachments, attachmentFromArtifact, attachmentFromContextItem } from './AgentAttachment'
import type { AgentArtifactIndexState } from './agentWorkspace.types'
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
  return <CodeBlock className="agent-action-card__artifact-text" code={JSON.stringify(value, null, 2)} language="json" />
}

function elementsAttachmentData(artifact: BotanicAgentArtifact): ElementsAttachmentData {
  return {
    id: artifact.id,
    type: 'file',
    url: artifact.url ?? '',
    mediaType: artifact.mimeType ?? (artifact.kind === 'video' ? 'video/*' : 'image/*'),
    filename: artifact.label,
  }
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
  const mediaArtifacts = artifacts.filter((artifact) => (artifact.kind === 'image' || artifact.kind === 'video') && artifact.url)
  const nonMediaArtifacts = artifacts.filter((artifact) => !mediaArtifacts.includes(artifact))
  return <div className="agent-action-card__artifacts" aria-label={t('工具结果', 'Tool results')}>
    {mediaArtifacts.length ? <ElementsAttachments variant="grid" className="agent-action-card__media-attachments">
      {mediaArtifacts.map((artifact) => <ElementsAttachment key={artifact.id} data={elementsAttachmentData(artifact)}>
        <ElementsAttachmentPreview />
        <ElementsAttachmentInfo />
        <span className="agent-action-card__media-label">{artifact.label}</span>
      </ElementsAttachment>)}
    </ElementsAttachments> : null}
    {nonMediaArtifacts.map((artifact) => {
      if (artifact.kind === 'text' && artifact.content) {
        const parsed = tryParseJsonValue(artifact.content)
        return <Artifact key={artifact.id} className="agent-action-card__artifact">
          <ArtifactHeader><ArtifactTitle>{artifact.label}</ArtifactTitle></ArtifactHeader>
          <ArtifactContent>{parsed !== undefined ? <AgentMcpStructuredBlock value={parsed} /> : <CodeBlock className="agent-action-card__artifact-text" code={artifact.content} language="text" />}</ArtifactContent>
        </Artifact>
      }
      if (artifact.url) {
        return <WebPreview key={artifact.id} className="agent-action-card__web-preview" title={artifact.label} url={artifact.url} />
      }
      const nodeId = agentArtifactTargetNodeIds(artifact)[0]
      return <Artifact key={artifact.id} className="agent-action-card__artifact is-meta">
        <span>{artifact.label}</span>
        {nodeId ? <button type="button" className="agent-icon-button" aria-label={t('在画布定位', 'Locate on canvas')} title={t('在画布定位', 'Locate on canvas')} onClick={() => onLocateNode(nodeId)}><FocusIcon /></button> : null}
      </Artifact>
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
    const copyText = message.composition
      ? formatBotanicAgentCompositionMessage(message.composition, locale)
      : message.content.trim() || message.prompt?.trim() || message.plan?.summary.trim() || message.question?.question.trim() || ''
    if (!copyText) return
    try {
      await navigator.clipboard.writeText(copyText)
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
    {actions.edit || actions.feedback || actions.copy ? <button type="button" className="agent-message__utility-more" aria-expanded={open} aria-haspopup="true" aria-label={t('消息操作', 'Message actions')} title={t('消息操作', 'Message actions')} onClick={() => onOpenChange(!open)}><MoreIcon /></button> : null}
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

function timelineElapsedLabel(startedAt: number, endedAt: number, locale: ProductLocale) {
  const seconds = Math.max(0, Math.floor((endedAt - startedAt) / 1_000))
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return minutes ? `${locale === 'en' ? 'Thought for' : '思考了'} ${minutes}m ${remainder}s` : `${locale === 'en' ? 'Thought for' : '思考了'} ${seconds}s`
}

function TimelineStepIcon({ kind }: { kind: TimelineStepKind }) {
  // 管道步没有 toolName 时仍按 kind 兜底；accordion 行走 AgentToolCallIcon。
  return <AgentToolCallIcon kind={kind} />
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

function timelineInlineCitationSources(timeline?: AgentTimelineState) {
  if (!timeline) return []
  const toolItems = timeline.blocks.find((block) => block.type === 'raw_group')?.items ?? []
  const seen = new Set<string>()
  const sources: TimelineWebSource[] = []
  for (const block of timeline.blocks) {
    if (block.type !== 'step' || !timelineStepShowsWebSources(block, toolItems)) continue
    for (const source of block.sources ?? []) {
      const key = timelineWebSourceHref(source) || source.hostname.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      sources.push(source)
    }
  }
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
  durationLabel,
  toolItems,
  error,
}: {
  block: Extract<TimelineBlock, { type: 'step' }>
  title: string
  statusLabel: string
  durationLabel: string
  toolItems: AgentToolCallTrace[]
  error: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const sourceCount = block.sources?.length ?? 0
  const accessibleLabel = `${title}${block.summary ? `, ${block.summary}` : ''}, ${statusLabel}, ${durationLabel}`

  return <Sources open={open} onOpenChange={setOpen} className={`agent-timeline__search mb-0 is-${block.status}${open ? ' is-open' : ''}`}>
    <SourcesTrigger count={sourceCount} asChild>
    <button
      type="button"
      className={`agent-timeline__step agent-timeline__search-toggle is-${block.status}`}
      aria-label={accessibleLabel}
    >
      <span className="agent-timeline__step-icon" aria-hidden="true"><TimelineStepMarker block={block} toolItems={toolItems} /></span>
      <span className="agent-timeline__step-copy"><strong>{title}</strong>{block.summary ? <span>{block.summary}</span> : null}</span>
      <small className="agent-timeline__step-meta"><span>{durationLabel}</span><span className="agent-timeline__step-status">{statusLabel}</span></small>
      <ChevronDownIcon />
    </button>
    </SourcesTrigger>
    <SourcesContent
      className="agent-timeline__search-panel mt-0 w-full"
      aria-hidden={!open}
      inert={!open ? true : undefined}
    >
      <AgentWebSourcePills sources={timelineSearchPills(block.sources ?? [])} />
    </SourcesContent>
    {error}
  </Sources>
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
  const pipelineLive = timeline.blocks.some((block) => block.type === 'step' && block.status === 'running')
  const clockLive = timeline.timing?.live ?? (toolLive || thinkingLive || pipelineLive)

  useEffect(() => {
    if (clockLive) {
      const timer = window.setInterval(() => setNow(Date.now()), 1_000)
      return () => window.clearInterval(timer)
    }
    if (accordion?.nextUpdateAt !== undefined && accordion.nextUpdateAt > now) {
      const timer = window.setTimeout(() => setNow(Date.now()), accordion.nextUpdateAt - now + 1)
      return () => window.clearTimeout(timer)
    }
  }, [accordion?.nextUpdateAt, now, clockLive])

  const renderBlock = (block: TimelineBlock) => {
    if (block.type === 'thinking') {
      // 原始推理只来自服务端+用户双开关的 live 通道，不进入 Turn 持久化。
      if (!block.text.trim()) return null
      const label = timelineElapsedLabel(block.startedAt, block.endedAt ?? now, locale)
      return <Reasoning
        key={block.id}
        className={`agent-timeline__thinking is-${block.status}`}
        isStreaming={block.status === 'running'}
        duration={Math.max(0, Math.round(((block.endedAt ?? now) - block.startedAt) / 1_000))}
      >
        <ReasoningTrigger getThinkingMessage={() => <>
          <span>{locale === 'en' ? 'Raw reasoning · live only' : '原始推理 · 仅本轮'}</span>
          <small>{label}</small>
        </>} />
        <ReasoningContent>{block.text}</ReasoningContent>
      </Reasoning>
    }
    if (block.type === 'narration') return <p key={block.id} className="agent-timeline__narration">{block.text}</p>
    if (block.type === 'step') {
      const statusLabel = block.status === 'running'
        ? (locale === 'en' ? 'Running' : '进行中')
        : block.status === 'succeeded'
          ? (locale === 'en' ? 'Completed' : '已完成')
          : block.status === 'aborted'
            ? conversationTimelineStepTitle(block, locale) ?? (locale === 'en' ? 'Not run' : '未执行')
            : (locale === 'en' ? 'Failed' : '失败')
      const title = conversationTimelineStepTitle(block, locale) ?? timelineStepTitle(block, locale)
      const durationEnd = block.status === 'running' && clockLive ? now : block.endedAt
      const durationLabel = agentToolDurationLabel(
        block.startedAt !== undefined && durationEnd !== undefined
          ? Math.max(0, durationEnd - block.startedAt)
          : undefined,
        locale,
      )
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
          durationLabel={durationLabel}
          toolItems={toolItems}
          error={stepError}
        />
      }
      return <div key={block.id} className={`agent-timeline__step is-${block.status}`} aria-label={`${title}${block.summary ? `, ${block.summary}` : ''}, ${statusLabel}, ${durationLabel}`}>
        <span className="agent-timeline__step-icon" aria-hidden="true"><TimelineStepMarker block={block} toolItems={toolItems} /></span>
        <span className="agent-timeline__step-copy"><strong>{title}</strong>{block.summary ? <span>{block.summary}</span> : null}</span>
        <small className="agent-timeline__step-meta"><span>{durationLabel}</span><span className="agent-timeline__step-status">{statusLabel}</span></small>
        {stepError}
      </div>
    }
    return null
  }
  const view = presentAgentTimelineConversation(timeline)
  if (!view.visible.length && !view.collapsed.length && !timeline.truncation && !liveAccordion) return null

  const timing = timeline.timing
  const end = timing?.live ? now : timing?.endedAt
  const elapsed = timing?.startedAt !== undefined && end !== undefined ? agentToolDurationLabel(Math.max(0, end - timing.startedAt), locale) : undefined
  const failures = view.visible.filter((block) => block.type === 'step' && (block.status === 'failed' || block.status === 'aborted'))
  const toolFailed = accordion?.groups.some((group) => group.status === 'failed')
  return <div className="agent-timeline is-total" aria-label={locale === 'en' ? 'Activity' : '执行记录'}>
    <details className="agent-timeline__total" key={toolFailed ? 'failed' : 'normal'} open={toolFailed || undefined}>
      <summary><span>{elapsed ? `${locale === 'en' ? 'Total time' : '用时'} ${elapsed}` : locale === 'en' ? 'View activity' : '查看过程'}</span><ChevronDownIcon aria-hidden="true" /></summary>
      {liveAccordion ? <AgentToolCallAccordion view={liveAccordion} /> : null}
      {[...view.visible.filter((block) => !failures.includes(block)), ...view.collapsed].map(renderBlock)}
    </details>
    {failures.map(renderBlock)}
    {timeline.truncation && onLoadMore ? <button type="button" className="agent-timeline__load-more" disabled={loadingMore} onClick={onLoadMore}>
      {loadingMore ? (locale === 'en' ? 'Loading…' : '加载中…') : (locale === 'en' ? 'More activity' : '更多活动')}
    </button> : null}
  </div>
}

function AgentCollapsibleContent({ content, prompt, mentionCatalog }: { content: string; prompt?: string; mentionCatalog?: BotanicAgentMentionCatalog }) {
  const { locale } = useProductI18n()
  const [expanded, setExpanded] = useState(false)
  const { body } = splitAgentMessageSources(content)
  if (!agentMessageNeedsCollapse(content)) {
    return <AgentPromptResponse content={body} prompt={prompt} mentionCatalog={mentionCatalog} showSources={false} />
  }
  return <div className={`agent-message__collapsible${expanded ? ' is-expanded' : ''}`}>
    <div className="agent-message__collapsible-body">
      <AgentPromptResponse content={body} prompt={prompt} mentionCatalog={mentionCatalog} showSources={false} />
    </div>
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
  return <AgentAttachments variant="inline" className="agent-plan__context-locks" aria-label={locale === 'en' ? 'References' : '参考'}>
    {items.map((item) => {
      const ref = mentionCatalog?.references?.find((candidate) => candidate.id === item.nodeId)
      return <AgentAttachment key={item.nodeId} data={attachmentFromContextItem({
        id: item.nodeId,
        label: item.label,
        kind: item.kind,
        ...(ref?.image ? { image: ref.image } : {}),
      })}>
        <AgentAttachmentPreview />
        <AgentAttachmentInfo />
        <AgentAttachmentHoverPreview />
      </AgentAttachment>
    })}
  </AgentAttachments>
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
      <ModelSelector
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
  const comparable = Boolean(instruction.trim() && instruction.trim() !== draft.trim())
  return <details className="agent-prompt-review" aria-label={locale === 'en' ? 'Refined prompt' : '润色后的提示词'}>
    <summary>{submitted ? (locale === 'en' ? 'Prompt used' : '本次提示词') : (locale === 'en' ? 'Edit prompt' : '编辑提示词')}</summary>
    {submitted
      ? <div className="agent-prompt-review__submitted"><pre className="agent-prompt-output__text"><AgentRichText text={draft} catalogs={mentionCatalog} /></pre></div>
      : <textarea
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        onBlur={(event) => onCommit(event.currentTarget.value)}
        maxLength={6000}
        aria-label={locale === 'en' ? 'Refined prompt' : '润色后提示词'}
      />}
    {(trailing || comparable) ? <div className="agent-prompt-review__meta-row">
      {trailing}
      {comparable ? <details className="agent-prompt-review__compare">
        <summary>{locale === 'en' ? 'Compare original request' : '对比原始要求'}</summary>
        <AgentPromptDiff original={instruction} revised={draft} />
        {submitted ? null : <div className="agent-prompt-review__actions">
          <button type="button" className="agent-text-action" onClick={() => { onDraftChange(instruction); onCommit(instruction) }}>{locale === 'en' ? 'Use original' : '用原文'}</button>
          <button type="button" className="agent-text-action" onClick={() => { onDraftChange(polished); onCommit(polished) }}>{locale === 'en' ? 'Restore refinement' : '恢复润色'}</button>
        </div>}
      </details> : null}
    </div> : null}
  </details>
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
  projectId?: string
  message: BotanicAgentMessage
  sourceMessage?: BotanicAgentMessage
  onLoadEarlierMessages?: () => void
  timeline?: AgentTimelineState
  timelineLoadingMore?: boolean
  onLoadMoreTimeline?: () => void
  streaming?: boolean
  isLatestAssistant?: boolean
  agentBusy?: boolean
  isLatestEvaluable?: boolean
  sessionId?: string
  runs: BotanicAgentRun[]
  runCancelling?: boolean
  artifacts: BotanicAgentArtifact[]
  artifactIndexStatus: AgentArtifactIndexState['status']
  artifactIndexHasMore: boolean
  contextOptionIds: string[]
  mentionCatalog?: BotanicAgentMentionCatalog
  generationModels: GenerationModelOption[]
  executionMode: BotanicAgentExecutionMode
  planning: boolean; canvasWritebackBlocked?: boolean
  promptUsePending: boolean
  plannerModel: string
  executingActionId: string
  submittingMessageId: string
  promptDraft?: string
  onContinueArtifact: (artifact: BotanicAgentArtifact) => void
  onShowResults: () => void
  onShowTasks: (runId?: string) => void
  onRetryArtifacts: () => Promise<void>
  onFocusNodes: (nodeIds: string[]) => void
  /** 把这次运行带进画布的自动化面板；发布本身仍在那里完成。 */
  onPromoteRunToWorkflow: (runId: string) => void
  onAnswerClarification: (message: BotanicAgentMessage, answers: Record<string, string>) => Promise<void>
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
  onRetryTurn?: () => void
  recoveringTurn?: boolean
  recoveryIssue?: { message: string; steps: string[] }
  onRetryDelivery: (messageId: string) => void
  onDiscardDelivery: (messageId: string) => void
  onFeedback: (message: BotanicAgentMessage, feedback: BotanicAgentMessage['feedback']) => void
  onSaveAsMemory?: (message: BotanicAgentMessage, kind: BotanicAgentMemoryKind, content: string) => string | null
  onReviewDecision?: (message: BotanicAgentMessage, decision: 'accepted' | 'rejected') => void
  reviewDecisionPending?: boolean
}

export function AgentConversationMessage({
  message,
  sourceMessage,
  onLoadEarlierMessages,
  projectId,
  timeline,
  timelineLoadingMore = false,
  onLoadMoreTimeline,
  streaming = false,
  isLatestAssistant = false,
  agentBusy = false,
  isLatestEvaluable = false,
  sessionId,
  runs,
  runCancelling = false,
  artifacts,
  artifactIndexStatus,
  artifactIndexHasMore,
  contextOptionIds,
  mentionCatalog,
  generationModels,
  executionMode,
  planning, canvasWritebackBlocked = false,
  promptUsePending,
  plannerModel,
  executingActionId,
  submittingMessageId,
  promptDraft,
  onContinueArtifact,
  onShowResults,
  onShowTasks,
  onRetryArtifacts,
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
  onRetryTurn,
  recoveringTurn,
  recoveryIssue,
  onRetryDelivery,
  onDiscardDelivery,
  onFeedback,
  onSaveAsMemory,
}: AgentConversationMessageProps) {
  const { locale } = useProductI18n()
  const t = (zh: string, en: string) => locale === 'en' ? en : zh
  const [feedbackMemoryOpen, setFeedbackMemoryOpen] = useState(false)
  const [feedbackMemoryKind, setFeedbackMemoryKind] = useState<BotanicAgentMemoryKind>('avoid')
  const [feedbackMemoryDraft, setFeedbackMemoryDraft] = useState('')
  const [feedbackMemorySaved, setFeedbackMemorySaved] = useState(false)
  const feedbackMemoryId = useId()
  useEffect(() => {
    setFeedbackMemoryOpen(false)
    setFeedbackMemoryKind(message.feedback === 'positive' ? 'approved' : 'avoid')
    setFeedbackMemoryDraft('')
    setFeedbackMemorySaved(false)
  }, [message.id, message.feedback])
  const dimensionLabel = (dimension: string) => locale === 'en'
    ? ({ person: 'Person', pose: 'Pose', product: 'Product', garment: 'Garment', scene: 'Scene', composition: 'Composition', style: 'Style', lighting: 'Lighting' }[dimension] ?? dimension)
    : creativeDimensionLabel(dimension as Parameters<typeof creativeDimensionLabel>[0])
  const planCountLabel = (plan: NonNullable<BotanicAgentMessage['plan']>) => locale === 'en'
    ? `${plan.output.count} image${plan.output.count === 1 ? '' : 's'}`
    : botanicAgentPlanSheetCountLabel(plan)
  const linkedRun = message.runId ? runs.find((run) => run.id === message.runId) : undefined
  const isRunLinkedMessage = botanicAgentMessageIsRunLinked(message, linkedRun)
  const messageBusy = streaming || runCancelling || Boolean(isRunLinkedMessage && linkedRun && shouldRestoreBotanicAgentRuntimeSteps(linkedRun.status))
  const utilitySurface = useAgentMessageUtilitySurface({ streaming: messageBusy, isLatestEvaluable, messageId: message.id })
  const bobPlays = useBobSaysPlays(`message:${message.id}`)
  // 进行中的状态由 runtime feed / 底部进度条直播；对话里不画第二张「正在生成」卡。
  if (message.kind === 'run' && linkedRun && shouldRestoreBotanicAgentRuntimeSteps(linkedRun.status)) return null
  const runArtifacts = message.runId
    ? artifacts.filter((artifact) => artifact.provenance.runId === message.runId)
    : []
  const availableNodeIds = new Set(contextOptionIds)
  const outputNodeIds = [...new Set(runArtifacts.flatMap(agentArtifactTargetNodeIds))].filter((id) => availableNodeIds.has(id))
  const editableRunArtifacts = runArtifacts.filter((artifact) => (artifact.url && (artifact.kind === 'image' || artifact.kind === 'video')) || agentArtifactTargetNodeIds(artifact).some((id) => availableNodeIds.has(id)))
  const planPrompt = message.plan ? promptDraft ?? message.plan.prompt : ''
  const messageSources = splitAgentMessageSources(message.content).sources
  const inlineCitationSources = timelineInlineCitationSources(timeline)
  const textSources = messageSources.filter((source) => {
    try {
      const url = new URL(source)
      if (!['https:', 'http:'].includes(url.protocol)) return true
      inlineCitationSources.push({ hostname: url.hostname, href: url.href })
      return false
    } catch { return true }
  })
  const genericWebSources = new Set(['互联网', '网页', 'Internet', 'Web'])
  const projectSources = [...new Set(textSources)].filter((source) => !inlineCitationSources.length || !genericWebSources.has(source))

  const isLiveRunMessage = message.role === 'assistant' && Boolean(message.runId) && (message.kind === 'run' || message.kind === 'notice')
  const planSubmitted = message.status === 'submitted'
  const planStopped = Number.isFinite(message.turnCancellationRequestedAt)
  const runMediaArtifacts = runArtifacts.filter((artifact) => artifact.url && (artifact.kind === 'image' || artifact.kind === 'video'))
  const inlineRunResults = runMediaArtifacts.slice(0, inlineRunResultLimit)
  const continueResultControl = editableRunArtifacts.length === 1
    ? <button type="button" className="agent-run-message__action" onClick={() => onContinueArtifact(editableRunArtifacts[0])}><ContinueChatIcon /><span>{t('继续修改', 'Continue editing')}</span></button>
    : editableRunArtifacts.length > 1 ? <BotanicSelect
      className="agent-run-result-picker"
      value={editableRunArtifacts[0].id}
      ariaLabel={t('选择要修改的结果', 'Choose a result to edit')}
      options={editableRunArtifacts.map((artifact) => ({ value: artifact.id, label: agentArtifactDisplayName(artifact, linkedRun, locale) }))}
      renderTrigger={() => <span>{t('继续修改', 'Continue editing')}</span>}
      renderOption={(option) => {
        const artifact = editableRunArtifacts.find((item) => item.id === option.value)!
        return <span className="agent-run-result-picker__option">{artifact.kind === 'image' && artifact.url ? <img src={artifact.url} alt="" /> : null}<span>{option.label}</span></span>
      }}
      onChange={(id) => { const artifact = editableRunArtifacts.find((item) => item.id === id); if (artifact) onContinueArtifact(artifact) }}
    /> : null

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
  const bob = message.role === 'assistant' && isLatestAssistant
    ? bobReplyPresentation({
      allowsSays: allowsSays && !prefersReducedMotion(),
      streaming,
      isLatestAssistant,
      agentBusy,
      plays: bobPlays.plays,
    })
    : null
  const utilityActions = botanicAgentMessageUtilityActions(message)
  const showUtilities = !messageBusy && botanicAgentMessageHasUtilities(utilityActions)
  const runResults = isRunLinkedMessage && inlineRunResults.length
    ? <AgentAttachments variant="grid" className={`agent-run-message__results${!streaming ? ' is-featured' : ''}`} aria-label={t('本次任务结果', 'Task results')}>
      {inlineRunResults.map((artifact) => {
        const sourceNodeIds = agentArtifactTargetNodeIds(artifact).filter((id) => availableNodeIds.has(id))
        return <AgentAttachment key={artifact.id} data={attachmentFromArtifact({ ...artifact, label: agentArtifactDisplayName(artifact, linkedRun, locale) })} onActivate={sourceNodeIds.length ? () => onFocusNodes(sourceNodeIds) : onShowResults}>
        <AgentAttachmentPreview decorative={false} />
        </AgentAttachment>
      })}
      {artifactIndexHasMore || runMediaArtifacts.length > inlineRunResults.length ? <button type="button" className="agent-run-message__more" onClick={onShowResults}>
        {artifactIndexHasMore ? t('查看更多结果', 'View more results') : t(`查看全部 ${runMediaArtifacts.length} 项`, `View all ${runMediaArtifacts.length} results`)}
      </button> : null}
    </AgentAttachments>
    : null
  const resultReadState = botanicAgentRunResultReadState(isRunLinkedMessage ? linkedRun : undefined, runMediaArtifacts.length > 0, {
    pageReady: artifactIndexStatus === 'ready', hasMore: artifactIndexHasMore, failed: artifactIndexStatus === 'error' || artifactIndexStatus === 'error-more',
  })
  const resultState = resultReadState === 'error'
    ? <div className="agent-run-message__result-state is-error" role="alert"><span>{t('结果读取失败', 'Unable to load results')}</span><button type="button" onClick={() => void onRetryArtifacts()}>{t('重试', 'Retry')}</button></div>
    : resultReadState === 'more'
      ? <div className="agent-run-message__result-state" role="status"><span>{t('结果尚未载入', 'Results not loaded yet')}</span><button type="button" onClick={() => void onRetryArtifacts()}>{t('加载结果', 'Load results')}</button></div>
      : resultReadState === 'missing'
        ? <div className="agent-run-message__result-state" role="status"><span>{t('未找到结果', 'No result found')}</span><button type="button" onClick={() => onShowTasks(linkedRun?.id)}>{t('查看任务', 'View task')}</button></div>
        : resultReadState === 'loading' ? <p className="agent-run-message__result-state" role="status">{t('结果同步中…', 'Syncing results…')}</p> : null
  const pendingLabel = linkedRun && shouldRestoreBotanicAgentRuntimeSteps(linkedRun.status)
    ? t('正在生成…', 'Generating…')
    : timeline?.blocks.some((block) => block.type === 'step' || block.type === 'raw_group')
      ? t('正在执行…', 'Running…')
      : t('正在规划…', 'Planning…')
  const messageProse = botanicAgentMessageIsReview(message) ? null : message.kind === 'composition' && message.composition
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
          ? <AgentPromptResponse content={message.content} prompt={message.prompt} mentionCatalog={mentionCatalog} showSources={false} />
          // 时间线画得出内容时进度在上面；空时间线仍要占位，不能让气泡整段空白。
          : timeline && agentTimelineHasRenderableContent(timeline) ? null : <Shimmer as="p" className="agent-message__pending" duration={1.8}>{pendingLabel}</Shimmer>
        : <AgentCollapsibleContent content={message.content} prompt={message.prompt} mentionCatalog={mentionCatalog} />
      : <AgentMessageRichContent content={message.content} mentions={message.mentions} catalogs={mentionCatalog} hideMentions={message.role === 'user'} />) : null

  return <Message from={message.role} data-settled={botanicAgentMessageIsSettled(message, linkedRun, streaming || runCancelling)} className={`agent-message is-${message.role} is-${message.kind}${timeline ? ' has-timeline' : ''}${allowsSays ? ' is-bob-large' : ''}${showUtilities ? utilitySurface.className : ''}`} role={liveStatus ? 'status' : undefined} aria-live={liveStatus ? 'polite' : undefined} aria-busy={messageBusy || undefined}>
    {bob ? <div className="agent-message__role" data-bob-mood={bob.mood} data-bob-says={bob.says}><BobCharacter mood={bob.mood} says={bob.says} saysCycles={bob.cycles} onSaysComplete={() => bobPlays.markPlayed(bob.says)} /></div> : null}
    {message.role === 'user' ? <AgentMessageMentions mentions={botanicAgentMessageRichView({ content: message.content, mentions: message.mentions, catalogs: mentionCatalog }).mentions} catalogs={mentionCatalog} /> : null}
    <MessageContent className="agent-message__body">
      <AgentReferenceUsageDetails usage={timeline?.references} catalog={mentionCatalog} nodeIds={contextOptionIds} onLocateNode={onLocateNode}
        projectId={projectId} sessionId={sessionId} plannerModel={plannerModel} disabled={streaming || agentBusy}
        onPrepareReference={serverPersistenceEnabled && projectId
          ? (nodeId, signal) => prepareAgentReference(projectId, nodeId, plannerModel, signal) : undefined} />
      {timeline ? <AgentMessageTimeline timeline={timeline} loadingMore={timelineLoadingMore} onLoadMore={onLoadMoreTimeline} /> : null}
      {runResults}
      {resultState}
      {messageProse}
      {message.role === 'assistant' && (projectSources.length || inlineCitationSources.length) ? <div className="agent-message__sources" aria-label={t('引用', 'Citations')}>
        <AgentMarkdownSources sources={projectSources} catalogs={mentionCatalog} onLocate={(id) => onFocusNodes([id])} />
        <AgentInlineCitation sources={inlineCitationSources} />
      </div> : null}
      {message.role === 'assistant' && botanicAgentMessageOffersVisualPrompt(message) ? <div className="agent-run-message__actions" aria-label={t('Prompt 操作', 'Prompt actions')}>
        <button type="button" disabled={planning || promptUsePending} onClick={() => onUsePrompt(message)}>{promptUsePending ? t('等待确认', 'Awaiting approval') : t('用这段 Prompt 生成', 'Generate with this prompt')}</button>
      </div> : null}
      {message.role === 'assistant' && message.status === 'failed' && onRetryTurn ? <div className="agent-run-message__actions" aria-label={t('失败恢复', 'Failure recovery')}>
        <button className="is-retry" type="button" disabled={planning || recoveringTurn} onClick={onRetryTurn}>{recoveringTurn ? t('正在核对…', 'Checking…') : recoveryIssue ? t('刷新状态', 'Refresh status') : t('恢复本轮', 'Recover turn')}</button>
      </div> : null}
      {message.status === 'failed' && recoveryIssue ? <div className="agent-run-message__recovery" role="alert">
        <p>{recoveryIssue.message}</p>
        {recoveryIssue.steps.length ? <details><summary>{t('涉及的操作', 'Affected operations')}</summary><ul>{recoveryIssue.steps.map((step) => <li key={step}>{step}</li>)}</ul></details> : null}
      </div> : null}
      {isRunLinkedMessage && !message.plan && (outputNodeIds.length > 0 || continueResultControl) ? <div className="agent-run-message__bar" aria-label={t('结果操作', 'Result actions')}>
        {outputNodeIds.length ? <button type="button" className="agent-run-message__action" onClick={() => onFocusNodes(outputNodeIds)}><PinNodeIcon /><span>{t('定位画布', 'Locate on canvas')}</span></button> : null}
        {continueResultControl}
      </div> : null}
      {message.question ? <AgentClarificationMessage message={message} sourceMessage={sourceMessage} runs={runs} projectId={projectId} sessionId={sessionId} onLoadEarlierMessages={onLoadEarlierMessages}
        generationModels={generationModels} busy={planning} onShowTask={onShowTasks}
        onRestart={() => onEdit(message.question!.originalInstruction)} onSubmit={(answers) => onAnswerClarification(message, answers)} /> : null}
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
              const writebackPending = action.result?.canvasWritebackPending === true
              const settled = action.status === 'succeeded' || action.status === 'dismissed'
              const body = <>
                {action.toolName === 'canvas_action_set' && action.preview ? <AgentCanvasActionPreview preview={action.preview} locale={locale} /> : null}
                <AgentActionImpact action={action} locale={locale} />
                <details className="agent-action-card__details"><summary>{t('查看参数', 'View parameters')}</summary><pre>{JSON.stringify(action.arguments, null, 2)}</pre></details>
                {action.error ? <small className="agent-action-card__error">{action.error}</small> : null}
                {action.status === 'succeeded' ? <>
                  <div className="agent-action-card__result"><span>{action.result ? t('已执行', 'Executed') : t('已确认生效', 'Confirmed applied')}</span>{action.result?.canvasNodeIds?.length ? <small>{t(`已创建 ${action.result.canvasNodeIds.length} 个画布节点`, `${action.result.canvasNodeIds.length} canvas nodes created`)}</small> : !action.result ? <small>{t('未重放工具，也未生成虚构输出', 'No tool replay or fabricated output')}</small> : null}{action.result?.canvasNodeId ? <button type="button" className="agent-icon-button" aria-label={t('在画布定位结果', 'Locate result on canvas')} title={t('在画布定位', 'Locate on canvas')} onClick={() => onLocateNode(action.result!.canvasNodeId!)}><FocusIcon /></button> : null}</div>
                  {action.result?.artifacts?.length ? <AgentActionResultArtifacts artifacts={action.result.artifacts} onLocateNode={onLocateNode} locale={locale} /> : null}
                </> : null}
                {action.status === 'running' ? <div className="agent-action-card__running"><span>{writebackPending ? canvasWritebackBlocked ? t('结果已完成，等待画布同步', 'Result ready; waiting for canvas sync') : t('结果已完成，等待回写', 'Result ready to add to canvas') : t('执行状态待确认', 'Execution status needs confirmation')}</span><button type="button" disabled={executingActionId === action.id || (writebackPending && canvasWritebackBlocked)} onClick={() => onActionIntent(message, action, 'check_status')}>{executingActionId === action.id ? t('确认中…', 'Checking…') : writebackPending ? t('继续回写', 'Add to canvas') : t('确认状态', 'Check status')}</button></div> : null}
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
          <AgentPlanImpactSummary plan={plan} submitted={planSubmitted} locale={locale} dimensionLabel={dimensionLabel} />
          {planSubmitted
            ? null
            : <>
              <details className="agent-plan__settings-disclosure"><summary>{t('调整参数', 'Adjust settings')}</summary><AgentPlanSettingsEditor
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
                disabled={submittingMessageId === message.id || planStopped}
                onChange={(settings) => onCommitPlanSettings(message, settings)}
              /></details>
              {promptReview}
            </>}
          {contextItems.length ? <AgentPlanContextChips items={contextItems} mentionCatalog={mentionCatalog} /> : null}
          {branchPrompts.length > 1 ? <details className="agent-plan-branches" aria-label={t('变体分支，原参考图保留，各分支单独出图', 'Variation branches; original references are preserved and each branch generates separately')}>
            <summary>{t(`查看 ${branchPrompts.length} 个版本`, `View ${branchPrompts.length} versions`)}</summary>
            <ol>{branchPrompts.map((branch, index) => <li key={`${branch.label}-${index}`}>
              <b>{branch.label}</b>
              <p><AgentRichText text={branch.delta || branch.prompt} catalogs={mentionCatalog} /></p>
              {branch.delta ? <details className="agent-plan-branches__full"><summary>{t('完整提示词', 'Full prompt')}</summary><pre className="agent-prompt-output__text"><AgentRichText text={branch.prompt} catalogs={mentionCatalog} /></pre></details> : null}
            </li>)}</ol>
          </details> : null}
          {pendingActionCount ? <details className="agent-message__route"><summary>{t('执行路由', 'Execution route')}</summary><div><span>{t('规划', 'Planning')}</span><b>{agentPlannerModelLabel(plan.plannerModel ?? plannerModel)}</b><span>{t('生成', 'Generation')}</span><b>{plan.settings.model}</b><span>{t('外部行动', 'External actions')}</span><b>{t(`${pendingActionCount} 项，确认后执行`, `${pendingActionCount} to run after approval`)}</b></div></details> : null}
          {planSubmitted ? null : <div className="agent-plan__footer">
            {/* 停在这里一定有原因，必须说清楚，否则用户只会觉得“自动模式没生效”。 */}
            {autoPauseHint ? <small className="agent-plan__auto-paused">{autoPauseHint}</small> : null}
            {/* 信任按理由逐条交出：勾一次，这一类以后不再拦。外部行动和模型推断意图不在这里。 */}
            {waivableReason && !planStopped ? <details className="agent-plan__waiver"><summary>{t('确认设置', 'Confirmation settings')}</summary>
              <button
                type="button"
                disabled={submittingMessageId === message.id}
                onClick={() => onWaiveConfirmation(waivableReason)}
              >
              <span>{waivableReason === 'batch_count'
                ? t('多张出图以后直接执行', 'Run multi-image plans without asking')
                : t('这类出图以后直接执行', 'Run image plans without asking')}</span>
              </button>
            </details> : null}
            {planStopped ? <span role="status">{t('已请求停止', 'Stop requested')}</span> : <button type="button" className="agent-plan__confirm" disabled={submittingMessageId === message.id || blockedByActions} onClick={() => onConfirmPlan(message)}>{locale === 'en' ? (submittingMessageId === message.id ? 'Submitting…' : blockedByActions ? 'Confirm the actions below' : message.status === 'failed' ? 'Retry generation' : `Generate ${plan.output.count} image${plan.output.count === 1 ? '' : 's'}`) : botanicAgentPlanConfirmActionLabel(plan, submittingMessageId === message.id ? 'submitting' : blockedByActions ? 'blocked' : message.status === 'failed' ? 'failed' : 'ready')}</button>}
          </div>}
        </>
        const planShell = (className: string, content: ReactNode) => <Plan key={planSubmitted ? 'receipt' : 'confirmation'} className={className} defaultOpen={!planSubmitted} isStreaming={planning && !planSubmitted}>
          <PlanHeader>
            <div>
              <PlanTitle>{planSubmitted ? t('已提交', 'Submitted') : presentBotanicAgentPlanSummary(plan.summary) || t('确认生成', 'Confirm generation')}</PlanTitle>
              <PlanDescription>{[planCountLabel(plan), customSize ? `${plan.settings.outputWidth}×${plan.settings.outputHeight}` : plan.settings.aspectRatio, plan.settings.resolution, plan.settings.duration ? `${plan.settings.duration}${t('秒', 's')}` : '', modelLabel].filter(Boolean).join(' · ')}</PlanDescription>
            </div>
            <PlanAction><PlanTrigger aria-label={planSubmitted ? t('查看提交详情', 'View submission details') : t('展开生成计划', 'Expand generation plan')}>{planSubmitted ? t('查看详情', 'View details') : undefined}</PlanTrigger></PlanAction>
          </PlanHeader>
          <PlanContent>{content}</PlanContent>
        </Plan>
        // 已提交：提示词 + 规格芯片当回执；对话里不放任务入口。
        if (planSubmitted) {
          const receiptHeadline = presentBotanicAgentPlanSummary(plan.summary)
          const receiptActions = Boolean(outputNodeIds.length || continueResultControl)
          return planShell('agent-message__plan is-submitted', <>
            {timeline || !receiptHeadline ? null : <header className="agent-plan__receipt-header">
              <strong>{receiptHeadline}</strong>
            </header>}
            {recipe}
            {receiptActions ? <div className="agent-plan__receipt-actions" aria-label={t('结果操作', 'Result actions')}>
              {outputNodeIds.length ? <button type="button" className="agent-run-message__action" onClick={() => onFocusNodes(outputNodeIds)}><PinNodeIcon /><span>{t('定位画布', 'Locate on canvas')}</span></button> : null}
              {continueResultControl}
            </div> : null}
          </>)
        }
        return planShell('agent-message__plan', recipe)
      })() : null}
    </MessageContent>
    {message.role === 'user' && message.deliveryStatus === 'failed' ? <small className="agent-message__delivery-status is-failed" role="alert">{t('同步失败', 'Sync failed')} <button type="button" onClick={() => onRetryDelivery(message.id)}>{t('重试', 'Retry')}</button> <button type="button" onClick={() => onDiscardDelivery(message.id)}>{t('不再同步', 'Discard')}</button></small> : null}
    {showUtilities ? <AgentMessageUtilities
      message={message}
      sessionId={sessionId}
      actions={utilityActions}
      open={utilitySurface.open}
      onOpenChange={utilitySurface.setOpen}
      locale={locale}
      t={t}
      onEdit={onEdit}
      onFeedback={onFeedback}
    /> : null}
    {message.role === 'assistant' && sessionId && message.feedback && onSaveAsMemory ? <button type="button" className="agent-feedback-memory__trigger" aria-expanded={feedbackMemoryOpen} aria-controls={feedbackMemoryId} onClick={() => setFeedbackMemoryOpen((open) => !open)}>{t('记住这个偏好', 'Remember this preference')}</button> : null}
    {message.role === 'assistant' && sessionId && message.feedback && onSaveAsMemory && feedbackMemoryOpen ? <form id={feedbackMemoryId} className="agent-feedback-memory" onSubmit={(event) => {
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
  </Message>
}
