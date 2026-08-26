import { useEffect, useRef, useState } from 'react'
import { botanicMotion, gsap, prefersReducedMotion, useGSAP } from '../../components/gsapMotion'
import {
  botanicAgentAppliedSkillName,
  botanicAgentContextSnapshotNodeIds,
  botanicAgentExecutionPauseHint,
  botanicAgentPendingConfirmationCount,
  botanicAgentPlanMediaKind,
  botanicAgentMessageOffersVisualPrompt,
  creativeDimensionLabel,
  resolveBotanicAgentExecutionDecision,
  shouldRestoreBotanicAgentRuntimeSteps,
  type AgentToolCallTrace,
  type BotanicAgentActionProposal,
  type BotanicAgentArtifact,
  type BotanicAgentContextSnapshot,
  type BotanicAgentExecutionMode,
  type BotanicAgentMemoryKind,
  type BotanicAgentMessage,
  type BotanicAgentRun,
} from '../../domain/agent'
import type { GenerationModelOption, GenerationSettings } from '../../domain/canvas'
import {
  applyCustomGenerationSize,
  customGenerationSizeFields,
  generationSettingsSizeLabel,
  localizeCustomGenerationSizeMessage,
  modelSupportsCustomSize,
  withoutCustomGenerationSize,
} from '../../domain/generationOutputSize'
import { settingsForGenerationModel } from '../../domain/generationRecipe'
import { BobCharacter } from '../../components/bob/BobCharacter'
import { BOB_POST_WOW_HAPPY_MS, bobMessageAllowsSays, bobMessageFailed, bobMessageIsLargeReply, bobMessageUsesLargeAvatar, bobReplyPresentation } from '../../domain/bobPresentation'
import type { BobLauncherPoint } from '../../domain/bobLauncher'
import { useBobLookAt } from './useBobLookAt'
import { useBobSaysPlays } from './useBobSaysPlays'
import { AlertIcon, BookIcon, ChecklistIcon, ChevronDownIcon, ClockIcon, CopyIcon, EditIcon, FocusIcon, GlobeIcon, MoreIcon, SearchIcon, ThumbDownIcon, ThumbUpIcon } from '../../components/BotanicIcons'
import { AgentThinkingOrb } from '../../components/AgentThinkingOrb'
import { AgentToolOrb } from '../../components/AgentToolOrb'
import { agentPlannerModelLabel, modelDisplayLabel } from '../../components/generationModelPresentation'
import { BotanicSelect } from '../../components/BotanicSelect'
import { AgentClarificationCard, AgentPromptDiff, agentToolStatusLabel } from './AgentWorkspaceParts'
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
import { botanicAgentPlanBranchPrompts, botanicAgentPlanConfirmActionLabel, botanicAgentPlanOutputLabel, botanicAgentPlanSheetCountLabel } from '../../domain/agentVariations'
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
  agentTimelineOrbState,
  agentTimelineStepToolName,
  type AgentTimelineState,
  type TimelineBlock,
  type TimelineStepKind,
} from '../../domain/agentTimeline'

/** 单条任务消息内联展示的结果上限；更多结果去结果面板看，避免对话被结果流冲垮。 */
const inlineRunResultLimit = 4
const justFinishedRevealMs = 1200
const copiedStatusMs = 1200

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

  const copy = () => {
    void navigator.clipboard.writeText(message.composition ? formatBotanicAgentCompositionMessage(message.composition, locale) : message.content)
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
      {actions.copy ? <button type="button" aria-label={copied ? t('已复制', 'Copied') : t('复制消息', 'Copy message')} title={t('复制消息', 'Copy message')} onClick={copy}><CopyIcon /></button> : null}
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
  onDecision?: (decision: 'accepted' | 'rejected' | 'retry_requested') => void
}) {
  const { locale } = useProductI18n()
  if (!review.id || !onDecision) return null
  if (review.status && review.status !== 'pending') {
    const label = review.status === 'accepted' ? (locale === 'en' ? 'Accepted' : '已接受') : review.status === 'rejected' ? (locale === 'en' ? 'Rejected' : '已退回') : (locale === 'en' ? 'Retry requested' : '已请求重试')
    return <p className="agent-review-decision" role="status">{label}{review.decisionNote ? ` · ${review.decisionNote}` : ''}</p>
  }
  return <div className="agent-review-decision" aria-label={locale === 'en' ? 'Review decision' : '评审决策'}>
    <span>{locale === 'en' ? 'Human quality gate' : '人工质量门'}</span>
    <button type="button" disabled={pending} onClick={() => onDecision('accepted')}>{locale === 'en' ? 'Accept' : '接受'}</button>
    <button type="button" disabled={pending} onClick={() => onDecision('retry_requested')}>{locale === 'en' ? 'Request retry' : '请求重试'}</button>
    <button type="button" disabled={pending} onClick={() => onDecision('rejected')}>{locale === 'en' ? 'Reject' : '退回'}</button>
  </div>
}

function timelineElapsedLabel(startedAt: number, endedAt: number, locale: ProductLocale) {
  const seconds = Math.max(0, Math.floor((endedAt - startedAt) / 1_000))
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return minutes ? `${locale === 'en' ? 'Thought for' : '思考了'} ${minutes}m ${remainder}s` : `${locale === 'en' ? 'Thought for' : '思考了'} ${seconds}s`
}

function TimelineStepIcon({ kind }: { kind: TimelineStepKind }) {
  if (kind === 'search') return <SearchIcon />
  if (kind === 'fetch' || kind === 'connect_runtime') return <GlobeIcon />
  if (kind === 'read_skill' || kind === 'read') return <BookIcon />
  if (kind === 'write') return <EditIcon />
  return <ChecklistIcon />
}

function TimelineStepMarker({
  block,
  toolItems,
}: {
  block: Extract<TimelineBlock, { type: 'step' }>
  toolItems: AgentToolCallTrace[]
}) {
  if (block.status === 'failed') return <AlertIcon />
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

function timelineStepTitle(block: Extract<TimelineBlock, { type: 'step' }>, locale: ProductLocale) {
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
  if (block.kind === 'connect_runtime') return 'Connecting browser runtime'
  if (block.kind === 'read') return 'Reading project data'
  if (block.kind === 'write') return 'Writing project data'
  return 'Running tool'
}

function AgentMessageTimeline({ timeline }: { timeline: AgentTimelineState }) {
  const { locale } = useProductI18n()
  const running = timeline.blocks.some((block) => block.type === 'thinking' && block.status === 'running')
  const [now, setNow] = useState(() => Date.now())
  const toolItems = timeline.blocks.find((block) => block.type === 'raw_group')?.items ?? []

  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [running])

  return <div className="agent-timeline" aria-label={locale === 'en' ? 'Agent live progress' : 'Agent 实时进度'}>
    {timeline.blocks.map((block) => {
      if (block.type === 'thinking') {
        const label = timelineElapsedLabel(block.startedAt, block.endedAt ?? now, locale)
        const marker = block.status === 'running'
          ? <AgentThinkingOrb label={label} />
          : <ClockIcon />
        const summary = <>{marker}<span>{label}</span></>
        return block.text ? <details key={block.id} className={`agent-timeline__thinking is-${block.status}`}>
          <summary>{summary}</summary>
          <p>{block.text}</p>
        </details> : <div key={block.id} className={`agent-timeline__thinking is-${block.status}`} aria-label={label}>{summary}</div>
      }
      if (block.type === 'narration') return <p key={block.id} className="agent-timeline__narration">{block.text}</p>
      if (block.type === 'step') {
        const statusLabel = block.status === 'running' ? (locale === 'en' ? 'Running' : '进行中') : block.status === 'succeeded' ? (locale === 'en' ? 'Completed' : '已完成') : (locale === 'en' ? 'Failed' : '失败')
        const title = timelineStepTitle(block, locale)
        return <div key={block.id} className={`agent-timeline__step is-${block.status}`} aria-label={`${title}, ${statusLabel}`}>
          <span className="agent-timeline__step-icon" aria-hidden="true"><TimelineStepMarker block={block} toolItems={toolItems} /></span>
          <strong>{title}</strong>
          <small>{statusLabel}</small>
          {/* 失败必须说清原因。只显示「失败」的话，看的人不知道该改什么 —— 线上就撞上过：
              两个写类工具调用连续失败，界面上只有两个红叉。 */}
          {block.status === 'failed' && block.error ? <p className="agent-timeline__step-error">{block.error}</p> : null}
        </div>
      }
      return <details key={block.id} className="agent-timeline__raw" open={block.open || undefined}>
        <summary><span>{locale === 'en' ? `${block.items.length} tool ${block.items.length === 1 ? 'call' : 'calls'}` : block.summary}</span><small>{block.items.length} {locale === 'en' ? 'items' : '项'}</small></summary>
        <div className="agent-timeline__raw-list">
          {block.items.map((item) => <div key={item.id} className={`is-${item.status}`}>
            <span><strong>{item.label}</strong><code>{item.name}</code></span>
            <small>{agentToolStatusLabel(item.status, locale)}</small>
            {item.summary ? <p>{item.summary}</p> : null}
            {item.error ? <p className="is-error">{item.error}</p> : null}
          </div>)}
        </div>
      </details>
    })}
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
  disabled,
  onChange,
}: {
  settings: GenerationSettings
  models: GenerationModelOption[]
  countLabel: string
  disabled: boolean
  onChange: (settings: GenerationSettings) => void
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
  const resolutions = selectedModel.resolutions ?? ['1K', '2K']
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
        value={settings.resolution}
        ariaLabel={locale === 'en' ? 'Select output resolution' : '选择输出清晰度'}
        disabled={disabled}
        options={resolutions.map((resolution) => ({ value: resolution, label: resolution }))}
        onChange={(value) => onChange({ ...settings, resolution: value as GenerationSettings['resolution'] })}
      />
    </label>
    <span>
      <small>{locale === 'en' ? 'Output' : '输出'}</small>
      <span className="agent-plan-settings__readonly" title={locale === 'en' ? 'Output count is set by the plan' : '张数由计划展开决定'}>{countLabel}</span>
    </span>
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
  onDraftChange,
  onCommit,
}: {
  submitted: boolean
  instruction: string
  draft: string
  polished: string
  mentionCatalog?: BotanicAgentMentionCatalog
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
    {comparable ? <details className="agent-prompt-review__compare">
      <summary>{locale === 'en' ? 'Compare original' : '对照原文'}</summary>
      <AgentPromptDiff original={instruction} revised={draft} />
      {submitted ? null : <div className="agent-prompt-review__actions">
        <button type="button" className="agent-text-action" onClick={() => { onDraftChange(instruction); onCommit(instruction) }}>{locale === 'en' ? 'Use original' : '用原文'}</button>
        <button type="button" className="agent-text-action" onClick={() => { onDraftChange(polished); onCommit(polished) }}>{locale === 'en' ? 'Restore refinement' : '恢复润色'}</button>
      </div>}
    </details> : null}
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
  onShowTask: (runId: string) => void
  onFocusNodes: (nodeIds: string[]) => void
  onAnswerClarification: (message: BotanicAgentMessage, answers: Record<string, string>) => void
  onLocateNode: (nodeId: string) => void
  onConfirmAction: (message: BotanicAgentMessage, action: BotanicAgentActionProposal) => void
  onDismissAction: (message: BotanicAgentMessage, action: BotanicAgentActionProposal) => void
  onPromptDraftChange: (messageId: string, prompt: string) => void
  onCommitPlanPrompt: (message: BotanicAgentMessage, prompt: string) => void
  onCommitPlanSettings: (message: BotanicAgentMessage, settings: GenerationSettings) => void
  onConfirmPlan: (message: BotanicAgentMessage) => void
  onGenerateCompositionItem?: (message: BotanicAgentMessage, item: BotanicAgentCompositionItem) => void
  onRunComposition?: (message: BotanicAgentMessage) => void
  onUsePrompt: (message: BotanicAgentMessage) => void
  onEdit: (content: string) => void
  onRetryDelivery: (messageId: string) => void
  onFeedback: (message: BotanicAgentMessage, feedback: BotanicAgentMessage['feedback']) => void
  onSaveAsMemory?: (message: BotanicAgentMessage, kind: BotanicAgentMemoryKind, content: string) => string | null
  onReviewDecision?: (message: BotanicAgentMessage, decision: 'accepted' | 'rejected' | 'retry_requested') => void
  reviewDecisionPending?: boolean
}

export function AgentConversationMessage({
  message,
  timeline,
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
  onShowTask,
  onFocusNodes,
  onAnswerClarification,
  onLocateNode,
  onConfirmAction,
  onDismissAction,
  onPromptDraftChange,
  onCommitPlanPrompt,
  onCommitPlanSettings,
  onConfirmPlan,
  onGenerateCompositionItem,
  onRunComposition,
  onUsePrompt,
  onEdit,
  onRetryDelivery,
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
  const planOutputDisplay = (plan: NonNullable<BotanicAgentMessage['plan']>) => locale === 'en'
    ? (plan.output.mode === 'single' ? planCountLabel(plan) : plan.output.mode === 'batch_by_asset' ? `${plan.output.count} asset variations` : `${plan.output.count} variations`)
    : botanicAgentPlanOutputLabel(plan)
  const linkedRun = message.runId ? runs.find((run) => run.id === message.runId) : undefined
  const bobPlays = useBobSaysPlays(`message:${message.id}`)
  const isLargeReply = bobMessageIsLargeReply(message)
  const allowsSays = message.role === 'assistant' && bobMessageAllowsSays({
    isLatestAssistant,
    isLargeReply,
  })
  const usesLargeAvatar = message.role === 'assistant' && bobMessageUsesLargeAvatar({
    isLatestAssistant,
    streaming,
    message,
  })
  const failed = bobMessageFailed(message)
  const look = useBobLookAt(usesLargeAvatar, composerPoint)
  const bob = message.role === 'assistant'
    ? bobReplyPresentation({
      allowsSays: allowsSays && !prefersReducedMotion(),
      streaming,
      isLatestAssistant,
      agentBusy,
      plays: prefersReducedMotion()
        ? { ...bobPlays.plays, happy: Math.max(bobPlays.plays.happy ?? 0, 1) }
        : bobPlays.plays,
      composerTyping,
      feedback: message.feedback,
      failed,
    })
    : null
  const markHappy = bobPlays.markHappy
  useEffect(() => {
    if (bob?.mood !== 'happy' || message.feedback || failed) return
    if ((bobPlays.plays.happy ?? 0) >= 1) return
    if (prefersReducedMotion()) {
      markHappy()
      return
    }
    const timer = window.setTimeout(() => markHappy(), BOB_POST_WOW_HAPPY_MS)
    return () => window.clearTimeout(timer)
  }, [bob?.mood, bobPlays.plays.happy, failed, markHappy, message.feedback])
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

  return <article className={`agent-message is-${message.role} is-${message.kind}${timeline ? ' has-timeline' : ''}${allowsSays ? ' is-bob-large' : ''}${showUtilities ? utilitySurface.className : ''}`} role={liveStatus ? 'status' : undefined} aria-live={liveStatus ? 'polite' : undefined} aria-busy={streaming || undefined}>
    <div className="agent-message__role" data-bob-mood={bob?.mood} data-bob-says={bob?.says}>{bob ? <BobCharacter mood={bob.mood} says={bob.says} saysCycles={bob.cycles} onSaysComplete={() => bobPlays.markPlayed(bob.says)} /> : <span>{t('你', 'You')}</span>}</div>
    <div className="agent-message__body">
      {timeline ? <AgentMessageTimeline timeline={timeline} /> : null}
      {message.kind === 'composition' && message.composition
        ? <AgentCompositionCard
          composition={message.composition}
          busy={planning || submittingMessageId === message.id}
          mentionCatalog={mentionCatalog}
          onGenerateItem={onGenerateCompositionItem ? (item) => onGenerateCompositionItem(message, item) : undefined}
          onRunAll={onRunComposition ? () => onRunComposition(message) : undefined}
        />
        // 计划消息的标题与 plan.summary 相同，只在计划卡上展示一次，避免主列重复。
        : !message.plan && !message.question && (message.content || message.mentions?.length || streaming) ? (message.role === 'assistant'
          ? streaming
          ? message.content
            ? <AgentPromptResponse content={message.content} prompt={message.prompt} mentionCatalog={mentionCatalog} />
            : <p className="agent-message__pending">{t('正在规划这一步…', 'Planning the next step…')}</p>
          : <AgentCollapsibleContent content={message.content} prompt={message.prompt} mentionCatalog={mentionCatalog} />
          : <AgentMessageRichContent content={message.content} mentions={message.mentions} catalogs={mentionCatalog} />) : null}
      {message.kind === 'run' && inlineRunResults.length ? <div className="agent-run-message__results" aria-label={t('本次任务结果', 'Task results')}>
        {inlineRunResults.map((artifact) => artifact.kind === 'image'
          ? <img key={artifact.id} src={artifact.url} alt={artifact.label} />
          : <video key={artifact.id} src={artifact.url} muted playsInline aria-label={artifact.label} />)}
        {runMediaArtifacts.length > inlineRunResults.length ? <button type="button" className="agent-run-message__more" onClick={onShowResults}>
          {t(`查看全部 ${runMediaArtifacts.length} 项`, `View all ${runMediaArtifacts.length} results`)}
        </button> : null}
      </div> : null}
      {message.role === 'assistant' && botanicAgentMessageOffersVisualPrompt(message) ? <div className="agent-run-message__actions" aria-label={t('Prompt 操作', 'Prompt actions')}>
        <button type="button" disabled={planning || promptUsePending} onClick={() => onUsePrompt(message)}>{promptUsePending ? t('等待确认', 'Awaiting approval') : t('用这段 Prompt 生成', 'Generate with this prompt')}</button>
      </div> : null}
      {message.review ? <AgentReviewDecision review={message.review} pending={reviewDecisionPending} onDecision={onReviewDecision ? (decision) => onReviewDecision(message, decision) : undefined} /> : null}
      {/* 任务/结果/定位画布只挂在已提交计划卡上；Run 消息只留「继续修改」，避免同一 runId 双份 pill。 */}
      {message.kind === 'run' && message.runId && continueNodeIds.length ? <div className="agent-run-message__actions" aria-label={t('继续修改', 'Continue editing')}>
        <button type="button" onClick={() => onContinueResultContext(continueNodeIds, outputNodeIds.length)}>{t('继续修改', 'Continue editing')}</button>
      </div> : null}
      {message.runId && !message.plan && message.kind !== 'run' ? <div className="agent-run-message__actions" aria-label={t('任务与结果操作', 'Task and result actions')}>
        <button type="button" onClick={() => onShowTask(message.runId!)}>{t('查看任务', 'View task')}</button>
        {runArtifacts.length ? <button type="button" onClick={onShowResults}>{t('查看结果', 'View results')}</button> : null}
        {outputNodeIds.length ? <button type="button" onClick={() => onFocusNodes(outputNodeIds)}>{t('定位画布', 'Locate on canvas')}</button> : null}
      </div> : null}
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
        })
        const autoPauseHint = executionMode === 'auto'
          ? botanicAgentExecutionPauseHint(executionDecision, {
            pendingActionCount,
            outputCount: plan.output.count,
          })
          : null
        const appliedSkills = plan.actions?.filter((action) => action.toolName === 'skill_apply') ?? []
        const confirmableActions = plan.actions?.filter((action) => action.toolName !== 'skill_apply') ?? []
        const lockedConstraints = plan.constraints.filter((constraint) => constraint.mode === 'preserve')
        const variedConstraints = plan.constraints.filter((constraint) => constraint.mode === 'vary')
        const branchPrompts = botanicAgentPlanBranchPrompts({
          ...plan,
          prompt: planSubmitted ? plan.prompt : planPrompt,
        })
        const modelLabel = modelDisplayLabel(generationModels.find((model) => model.id === plan.settings.model)) || plan.settings.model
        const contextItems = plan.contextSnapshot ?? []
        const contextLockLabel = contextItems[0]
          ? `${mentionCatalog?.references?.find((item) => item.id === contextItems[0].nodeId)?.label ?? contextItems[0].label}${
            contextItems.length > 1 ? ` +${contextItems.length - 1}` : ''
          }`
          : null
        const recipeMeta = [
          modelLabel,
          generationSettingsSizeLabel(plan.settings),
          locale === 'en' ? planOutputDisplay(plan) : botanicAgentPlanSheetCountLabel(plan),
          contextLockLabel ? (locale === 'en' ? `Based on ${contextLockLabel}` : `基于 ${contextLockLabel}`) : null,
        ].filter(Boolean).join(' · ')
        const recipe = <>
          {plan.toolCalls?.length ? <details
            className="agent-message__tools"
            aria-label={t('Agent 工具调用', 'Agent tool calls')}
            open={plan.toolCalls.some((call) => call.status !== 'succeeded') || undefined}
          >
            <summary><span>{t('执行步骤', 'Execution steps')}</span><small>{plan.toolCalls.filter((call) => call.status === 'succeeded').length}/{plan.toolCalls.length} {t('已完成', 'completed')}</small></summary>
            <div>{plan.toolCalls.map((call) => <div key={call.id} className={`agent-message__tool is-${call.status}`}>
              <span aria-hidden="true">↳</span>
              {/* summary 是模型自述的一句话调用目的，比工具名更能说明这一步在做什么。 */}
              <strong title={call.summary ?? call.label}>{call.label}{call.summary ? <em> · {call.summary}</em> : null}</strong>
              <small>{agentToolStatusLabel(call.status, locale)}</small>
            </div>)}</div>
          </details> : null}
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
                <details className="agent-action-card__details"><summary>{t('查看执行内容', 'View execution details')}</summary><pre>{JSON.stringify(action.arguments, null, 2)}</pre></details>
                {action.error ? <small className="agent-action-card__error">{action.error}</small> : null}
                {action.status === 'succeeded' ? <div className="agent-action-card__result"><span>{t('已执行', 'Executed')}</span>{action.result?.canvasNodeIds?.length ? <small>{t(`已创建 ${action.result.canvasNodeIds.length} 个画布节点`, `${action.result.canvasNodeIds.length} canvas nodes created`)}</small> : action.result?.artifacts?.length ? <small>{t(`已产出 ${action.result.artifacts.length} 项`, `${action.result.artifacts.length} outputs created`)}</small> : null}{action.result?.canvasNodeId ? <button type="button" className="agent-icon-button" aria-label={t('在画布定位结果', 'Locate result on canvas')} title={t('在画布定位', 'Locate on canvas')} onClick={() => onLocateNode(action.result!.canvasNodeId!)}><FocusIcon /></button> : null}</div> : null}
                {action.status === 'running' ? <div className="agent-action-card__running"><span>{t('执行状态待确认', 'Execution status needs confirmation')}</span><button type="button" disabled={executingActionId === action.id} onClick={() => onConfirmAction(message, action)}>{executingActionId === action.id ? t('确认中…', 'Checking…') : t('确认状态', 'Check status')}</button></div> : null}
                {action.status === 'awaiting_confirmation' || action.status === 'failed' ? <div className="agent-action-card__buttons">
                  {action.status === 'awaiting_confirmation' ? <button type="button" className="is-secondary" onClick={() => onDismissAction(message, action)}>{t('跳过', 'Skip')}</button> : null}
                  <button type="button" disabled={executingActionId === action.id} onClick={() => onConfirmAction(message, action)}>{executingActionId === action.id ? t('执行中…', 'Executing…') : action.status === 'failed' ? t('重试', 'Retry') : t('确认执行', 'Approve and run')}</button>
                </div> : null}
              </>
              if (settled) return <details key={action.id} className={`agent-action-card is-settled is-${action.status}`}>
                <summary><span>{action.kind === 'skill' ? 'SKILL' : 'MCP'}</span><strong>{action.label}</strong><small>{action.status === 'succeeded' ? t('已执行', 'Executed') : t('已跳过', 'Skipped')}</small></summary>
                <p>{action.summary}</p>
                {body}
              </details>
              return <article key={action.id} className={`agent-action-card is-${action.status}`}>
                <header><span>{action.kind === 'skill' ? 'SKILL' : 'MCP'}</span><small>{action.risk === 'external' ? t('外部调用', 'External action') : t('写入项目', 'Writes to project')}</small></header>
                <strong>{action.label}</strong>
                <p>{action.summary}</p>
                {body}
              </article>
            })}
          </div> : null}
          <div className="agent-message__constraints">
            {lockedConstraints.length ? <div className="agent-message__constraint-group is-locked"><span>{t('锁定', 'Locked')}</span>{lockedConstraints.map((constraint) => <b key={constraint.dimension}>{dimensionLabel(constraint.dimension)}</b>)}</div> : null}
            {variedConstraints.length ? <div className="agent-message__constraint-group is-variable"><span>{t('变化', 'Varied')}</span>{variedConstraints.map((constraint) => <b key={constraint.dimension}>{dimensionLabel(constraint.dimension)}</b>)}</div> : null}
          </div>
          {planSubmitted
            ? <div className="agent-plan-settings" aria-label={t('本次生成设置', 'Generation settings')}>
              <span><small>{t('模型', 'Model')}</small><b>{modelLabel}</b></span>
              <span><small>{t('尺寸', 'Size')}</small><b>{generationSettingsSizeLabel(plan.settings)}</b></span>
              <span><small>{t('清晰度', 'Resolution')}</small><b>{plan.settings.resolution}</b></span>
              {plan.settings.duration ? <span><small>{t('时长', 'Duration')}</small><b>{plan.settings.duration} {t('秒', 'sec')}</b></span> : null}
              <span><small>{t('输出', 'Output')}</small><b>{planCountLabel(plan)}</b></span>
            </div>
            : <>
              <AgentPlanSettingsEditor
                settings={plan.settings}
                // 换模型不能顺便换媒体类型：视频计划带着 duration，切到图片模型会在提交时被拒。
                models={generationModels.filter((model) => (model.mediaKind === 'video') === (botanicAgentPlanMediaKind(plan) === 'video'))}
                countLabel={locale === 'en' ? planCountLabel(plan) : botanicAgentPlanSheetCountLabel(plan)}
                disabled={submittingMessageId === message.id}
                onChange={(settings) => onCommitPlanSettings(message, settings)}
              />
              {contextItems.length ? <AgentPlanContextChips items={contextItems} mentionCatalog={mentionCatalog} /> : null}
            </>}
          <AgentPlanPromptReview
            submitted={planSubmitted}
            instruction={plan.instruction}
            draft={planSubmitted ? plan.prompt : planPrompt}
            polished={plan.prompt}
            mentionCatalog={mentionCatalog}
            onDraftChange={(value) => onPromptDraftChange(message.id, value)}
            onCommit={(value) => onCommitPlanPrompt(message, value)}
          />
          {branchPrompts.length ? <section className="agent-plan-branches" aria-label={t('变体分支，原参考图保留，各分支单独出图', 'Variation branches; original references are preserved and each branch generates separately')}>
            <ol>{branchPrompts.map((branch, index) => <li key={`${branch.label}-${index}`}>
              <b>{branch.label}</b>
              <p><AgentRichText text={branch.delta || branch.prompt} catalogs={mentionCatalog} /></p>
              {branch.delta ? <details className="agent-plan-branches__full"><summary>{t('完整提示词', 'Full prompt')}</summary><pre className="agent-prompt-output__text"><AgentRichText text={branch.prompt} catalogs={mentionCatalog} /></pre></details> : null}
            </li>)}</ol>
          </section> : null}
          {pendingActionCount ? <details className="agent-message__route"><summary>{t('执行路由', 'Execution route')}</summary><div><span>{t('规划', 'Planning')}</span><b>{agentPlannerModelLabel(plan.plannerModel ?? plannerModel)}</b><span>{t('生成', 'Generation')}</span><b>{plan.settings.model}</b><span>{t('外部行动', 'External actions')}</span><b>{t(`${pendingActionCount} 项，确认后执行`, `${pendingActionCount} to run after approval`)}</b></div></details> : null}
          {planSubmitted ? null : <div className="agent-plan__footer">
            {/* 自动模式下停在这里一定有原因，必须说清楚，否则用户只会觉得“自动模式没生效”。 */}
            {autoPauseHint ? <small className="agent-plan__auto-paused">{locale === 'en' ? `Auto mode is paused for ${pendingActionCount} external action${pendingActionCount === 1 ? '' : 's'}. Generation starts after they are handled.` : autoPauseHint}</small> : null}
            <button type="button" className="agent-plan__confirm" disabled={submittingMessageId === message.id || blockedByActions} onClick={() => onConfirmPlan(message)}>{locale === 'en' ? (submittingMessageId === message.id ? 'Submitting…' : blockedByActions ? 'Approve actions first' : message.status === 'failed' ? 'Retry generation' : `Generate ${plan.output.count} image${plan.output.count === 1 ? '' : 's'}`) : botanicAgentPlanConfirmActionLabel(plan, submittingMessageId === message.id ? 'submitting' : blockedByActions ? 'blocked' : message.status === 'failed' ? 'failed' : 'ready')}</button>
          </div>}
        </>
        // 已提交：主列只留摘要、一行配方、一个主操作；锁/变与 Prompt 等进「配方」。
        if (planSubmitted) return <div className="agent-message__plan is-submitted">
          <header className="agent-plan__receipt-header">
            <strong>{plan.summary}</strong>
            <small>{recipeMeta}</small>
          </header>
          {message.runId ? <div className="agent-plan__receipt-actions" aria-label={t('任务与结果操作', 'Task and result actions')}>
            {runArtifacts.length
              ? <button type="button" className="agent-plan__receipt-primary" onClick={onShowResults}>{t('查看结果', 'View results')}</button>
              : <button type="button" className="agent-plan__receipt-primary" onClick={() => onShowTask(message.runId!)}>{t('查看任务', 'View task')}</button>}
            {outputNodeIds.length ? <button type="button" className="agent-plan__receipt-secondary" onClick={() => onFocusNodes(outputNodeIds)}>{t('定位画布', 'Locate on canvas')}</button> : null}
          </div> : null}
          <details className="agent-plan__recipe">
            <summary className="agent-plan__recipe-toggle">
              <ChevronDownIcon />
              <span>{t('配方', 'Recipe')}</span>
            </summary>
            <div className="agent-plan__recipe-body">{recipe}</div>
          </details>
        </div>
        return <div className="agent-message__plan">{recipe}</div>
      })() : null}
    </div>
    {message.role === 'user' && message.deliveryStatus === 'waiting_network' ? <small className="agent-message__delivery-status" role="status">{t('等待联网', 'Waiting for network')}</small> : null}
    {message.role === 'user' && message.deliveryStatus === 'queued' ? <small className="agent-message__delivery-status" role="status">{t('等待同步', 'Waiting to sync')}</small> : null}
    {message.role === 'user' && message.deliveryStatus === 'syncing' ? <small className="agent-message__delivery-status" role="status">{t('正在同步', 'Syncing')}</small> : null}
    {message.role === 'user' && message.deliveryStatus === 'synced' ? <small className="agent-message__delivery-status is-synced" role="status">{t('已同步', 'Synced')}</small> : null}
    {message.role === 'user' && message.deliveryStatus === 'failed' ? <small className="agent-message__delivery-status is-failed" role="alert">{t('同步失败', 'Sync failed')} <button type="button" onClick={() => onRetryDelivery(message.id)}>{t('重试', 'Retry')}</button></small> : null}
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
