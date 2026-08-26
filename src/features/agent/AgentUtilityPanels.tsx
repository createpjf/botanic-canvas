import { useEffect, useMemo, useState } from 'react'
import {
  botanicAgentArtifactModel,
  botanicAgentArtifactPrompt,
  botanicAgentArtifactTimestamp,
  botanicAgentResultGroupTitle,
  botanicAgentSkillBody,
  botanicAgentSkillSummary,
  clipBotanicAgentNodeTitle,
  resolveBotanicAgentResultSelection,
  type BotanicAgentArtifact,
  type BotanicAgentMemoryItem,
  type BotanicAgentMemoryKind,
  type BotanicAgentRun,
} from '../../domain/agent'
import { BotanicSelect } from '../../components/BotanicSelect'
import { modelDisplayLabel } from '../../components/generationModelPresentation'
import type { GenerationModelOption } from '../../domain/canvas'
import { CopyIcon, DeleteIcon, FocusIcon, SparkleIcon } from '../../components/BotanicIcons'
import type { CollaborationActivity, CollaborationDocumentChange } from '../../domain/collaborationActivity'
import { downloadMedia } from '../../lib/mediaDownload'
import { agentArtifactKindLabel, agentMemoryKindLabel, agentRunFeedback, AgentPanelBackButton } from './AgentWorkspaceParts'
import {
  agentReviewCandidateRows,
  agentReviewCoverageSummary,
  agentReviewEvaluatorCostNote,
  agentReviewTaskStatusNote,
  type AgentReviewDecision,
  type AgentReviewTaskSnapshot,
} from '../../domain/agentReviewPresentation'
import { fetchAgentReviewTasks, submitAgentReviewDecisions } from '../../lib/agentApi'
import {
  brandKitSummary,
  brandProposalRows,
  effectiveBrandRuleRows,
  overriddenBrandRuleRows,
  type ResolvedBrandKit,
} from '../../domain/brandKitPresentation'
import { fetchProjectBrandKit } from '../../lib/brandKitApi'
import { cachedProjectCapabilities } from '../../lib/db'
import { serverPersistenceEnabled } from '../../lib/productSession'
import { canUseProjectEntry } from '../../domain/projectCapabilities'
import {
  MEMORY_SUBJECT_OPTIONS,
  memoryComparisonRows,
  memoryConflictPairs,
  memoryIneffectiveReason,
  memorySubjectDescription,
  memorySubjectLabel,
} from '../../domain/agentMemoryComparison'
import type { AgentArtifactIndexState, AgentContextItem } from './agentWorkspace.types'
import { useProductI18n, useProductMessages } from '../../i18n/react'
import { formatProductDateTime, type ProductLocale } from '../../i18n/core'

const agentUtilityMessages = {
  'zh-CN': {
    collaborationAria: '协作动态', collaborationTitle: '协作动态', collaborationDescription: '查看成员最近修改，并直接定位到相关节点、对话或任务。',
    remoteCanvasTitle: '画布有新的云端版本', remoteCanvasDetail: '本地草稿仍保留。先查看变更，再决定使用哪一版。', remoteVersion: '云端版本',
    viewChanges: (count: number) => `查看 ${count} 项变更`, readingRemoteChanges: '正在读取云端变更…', keepLocal: '暂留本地', useRemote: '使用云端版本',
    readSyncFailed: '已读状态同步失败，点击重试', clearSyncFailed: '清空状态同步失败，点击重试', activitySyncFailed: '协作动态同步失败，点击重试',
    markAllRead: '全部已读', clearHistory: '清空记录', noActivities: '还没有协作变更。', loadingActivities: '正在读取协作动态…', loading: '加载中…', loadEarlierActivities: '加载更早动态',
    activityCount: (count: number) => `${count} 条`, occurrenceCount: (count: number) => `${count} 次`,
    comparePrompt: '对照 Prompt', copied: '已复制', copyPrompt: '复制 Prompt', generatedResult: '生成结果', toolArtifacts: '工具产物', generationBatch: '生成批次',
    detailAria: (label: string) => `${label} 详情`, backToResults: '返回结果', backfilled: '已回填画布', locateCanvas: '定位画布', continueEditing: '继续改', saved: '已入库', save: '入库', download: '下载', open: '打开',
    resultsAria: 'Agent 结果与文件', resultsTitle: '结果与文件', readingIndex: '正在读取历史 Artifact Index…', indexUnavailable: '历史索引暂不可用，已显示当前画布结果。', resultsSections: '结果分区', mediaResults: '生成结果', resultFilter: '结果筛选',
    all: '全部', images: '图片', videos: '视频', libraryFilter: '按入库状态筛选', anyLibraryStatus: '不限入库', unsaved: '未入库', modelFilter: '按生成模型筛选', allModels: '全部模型',
    batchActions: '批量操作', selectedCount: (count: number) => `已选 ${count} 项`, startNextRound: '创建下一轮', cancel: '取消', itemCount: (count: number) => `${count} 项`, notBackfilled: '未入画布', sourceConversation: '来源对话', selectAll: '全选', clearSelection: '取消全选', select: '选择', deselect: '取消选择', view: '查看',
    noToolArtifacts: '还没有 Skill / MCP 产物。', noGeneratedResults: '还没有该条件下的生成结果。', loadEarlierResults: '加载更早结果',
    memoryAria: '项目创作记忆', memoryTitle: '项目记忆', memoryDescription: '仅用于当前项目的后续规划；保存品牌规则、认可方向与禁区。', memoryType: '记忆类型', longTermRule: '长期规则', approvedDirection: '已确认方向', avoid: '避免事项', memoryPlaceholder: '例如：商品包装与品牌色不可改变', memoryScope: '适用范围', memoryScopeValue: '适用取值', memoryScopeValuePlaceholder: '例如 tmall', memoryContent: '项目记忆内容', saveMemory: '保存记忆', locateMemory: (content: string) => `在画布定位记忆 ${content}`, locate: '在画布定位', deleteMemory: (content: string) => `删除记忆 ${content}`, deleteMemoryTitle: '删除记忆', noMemory: '还没有项目记忆。', memoryCount: (count: number) => `${count} 条`,
    system: '系统', project: '项目', invoke: '@调用', mount: '挂载到对话', mounted: '已挂载', unmount: '取消挂载',
    brandAria: '品牌规则', brandTitle: '品牌规则', brandDescription: '生成前会把这些规则编译进执行提示词，生成后逐条复核。规则分全局品牌、项目 Creative Spec、本次运行覆盖三层，同一槽位由更靠近本次运行的那一层生效。',
    brandLoading: '正在读取品牌规则…', brandUnavailable: '品牌规则暂不可用，请稍后重试。',
    brandUnbound: '当前项目未绑定品牌，没有任何品牌规则参与生成。', brandEffective: '生效中', brandPending: '待确认建议', brandOverridden: '被覆盖的规则',
    brandConfirm: '确认启用', brandSourceRef: (ref: string) => `出处：${ref}`,
    reviewAria: '结果评审', reviewTitle: '结果评审', reviewDescription: '逐条判据说明结果是否符合这次确认的计划；自动评审不代表品牌批准，仍需你来决定。',
    reviewLoading: '正在读取评审…', reviewUnavailable: '评审暂不可用，请稍后重试。', noReviewTasks: '这次任务还没有评审记录。',
    reviewCandidate: (id: string) => `候选 ${id}`, reviewUnverified: (count: number) => `${count} 项未验证`,
    reviewRevision: '修订建议', reviewCustomCriteria: '项目自定义判据', reviewSkillSource: (version: number) => `来自项目 Skill · 版本 ${version}`, reviewAccept: '接受', reviewReject: '拒绝', reviewRetry: '请求重试',
    reviewAwaiting: '待你决定', reviewReadOnly: '你没有决定权限', reviewSubmitting: '提交中…', reviewDecisionFailed: '决定提交失败，请重试。',
    reviewRetryCreated: (count: number) => `已创建 ${count} 个重试任务；原结果保留。`,
    memoryConflicts: (count: number) => `有 ${count} 组规则互相矛盾，每组只有一条会生效。停用其中一条，规则才不会互相打架。`,
  },
  en: {
    collaborationAria: 'Collaboration activity', collaborationTitle: 'Collaboration', collaborationDescription: 'Review recent changes from workspace members and jump to the related node, conversation, or task.',
    remoteCanvasTitle: 'A newer canvas version is available', remoteCanvasDetail: 'Your local draft is preserved. Review the changes before choosing a version.', remoteVersion: 'Remote version',
    viewChanges: (count: number) => `View ${count} ${count === 1 ? 'change' : 'changes'}`, readingRemoteChanges: 'Reading remote changes…', keepLocal: 'Keep local version', useRemote: 'Use remote version',
    readSyncFailed: 'Read status could not sync. Click to retry.', clearSyncFailed: 'Activity could not be cleared. Click to retry.', activitySyncFailed: 'Collaboration activity could not sync. Click to retry.',
    markAllRead: 'Mark all as read', clearHistory: 'Clear activity', noActivities: 'No collaboration activity yet.', loadingActivities: 'Loading collaboration activity…', loading: 'Loading…', loadEarlierActivities: 'Load earlier activity',
    activityCount: (count: number) => `${count} ${count === 1 ? 'update' : 'updates'}`, occurrenceCount: (count: number) => `${count} times`,
    comparePrompt: 'Compare prompt', copied: 'Copied', copyPrompt: 'Copy prompt', generatedResult: 'Generated result', toolArtifacts: 'Tool outputs', generationBatch: 'Generation batch',
    detailAria: (label: string) => `${label} details`, backToResults: 'Back to results', backfilled: 'Added to canvas', locateCanvas: 'Locate on canvas', continueEditing: 'Continue editing', saved: 'Saved', save: 'Save', download: 'Download', open: 'Open',
    resultsAria: 'Agent results and files', resultsTitle: 'Results & files', readingIndex: 'Loading historical Artifact Index…', indexUnavailable: 'Historical results are unavailable. Showing results from the current canvas.', resultsSections: 'Result sections', mediaResults: 'Generated results', resultFilter: 'Filter results',
    all: 'All', images: 'Images', videos: 'Videos', libraryFilter: 'Filter by library status', anyLibraryStatus: 'Any library status', unsaved: 'Not saved', modelFilter: 'Filter by generation model', allModels: 'All models',
    batchActions: 'Batch actions', selectedCount: (count: number) => `${count} selected`, startNextRound: 'Start next round', cancel: 'Cancel', itemCount: (count: number) => `${count} ${count === 1 ? 'item' : 'items'}`, notBackfilled: 'Not on canvas', sourceConversation: 'Source conversation', selectAll: 'Select all', clearSelection: 'Clear selection', select: 'Select', deselect: 'Deselect', view: 'View',
    noToolArtifacts: 'No Skill or MCP outputs yet.', noGeneratedResults: 'No generated results match these filters.', loadEarlierResults: 'Load earlier results',
    memoryAria: 'Project creative memory', memoryTitle: 'Project memory', memoryDescription: 'Use project memory in future planning to preserve brand rules, approved directions, and boundaries.', memoryType: 'Memory type', longTermRule: 'Long-term rule', approvedDirection: 'Approved direction', avoid: 'Avoid', memoryPlaceholder: 'For example: Keep the product packaging and brand colors unchanged', memoryScope: 'Applies to', memoryScopeValue: 'Value', memoryScopeValuePlaceholder: 'e.g. tmall', memoryContent: 'Project memory content', saveMemory: 'Save memory', locateMemory: (content: string) => `Locate memory on canvas: ${content}`, locate: 'Locate on canvas', deleteMemory: (content: string) => `Delete memory: ${content}`, deleteMemoryTitle: 'Delete memory', noMemory: 'No project memory yet.', memoryCount: (count: number) => `${count} ${count === 1 ? 'entry' : 'entries'}`,
    brandAria: 'Brand rules', brandTitle: 'Brand rules', brandDescription: 'These rules are compiled into the execution prompt before generation and checked one by one afterwards. They come from three layers — global brand, project creative spec, and this run’s override — and for any one slot the layer closest to this run wins.',
    brandLoading: 'Loading brand rules…', brandUnavailable: 'Brand rules are unavailable right now. Try again shortly.',
    brandUnbound: 'This project is not bound to a brand, so no brand rules take part in generation.', brandEffective: 'In effect', brandPending: 'Awaiting confirmation', brandOverridden: 'Overridden rules',
    brandConfirm: 'Confirm and activate', brandSourceRef: (ref: string) => `Source: ${ref}`,
    reviewAria: 'Result review', reviewTitle: 'Result review', reviewDescription: 'Per-criterion findings on whether results match the plan you confirmed. An automatic pass is not brand approval — the call is still yours.',
    reviewLoading: 'Loading review…', reviewUnavailable: 'Review is unavailable right now. Try again shortly.', noReviewTasks: 'No review has been recorded for this task yet.',
    reviewCandidate: (id: string) => `Candidate ${id}`, reviewUnverified: (count: number) => `${count} not verified`,
    reviewRevision: 'Suggested revision', reviewCustomCriteria: 'Project-defined criterion', reviewSkillSource: (version: number) => `From a project Skill · version ${version}`, reviewAccept: 'Accept', reviewReject: 'Reject', reviewRetry: 'Request retry',
    reviewAwaiting: 'Awaiting your decision', reviewReadOnly: 'You cannot decide on this project', reviewSubmitting: 'Submitting…', reviewDecisionFailed: 'The decision could not be submitted. Try again.',
    reviewRetryCreated: (count: number) => `Created ${count} retry task(s); the original results are kept.`,
    memoryConflicts: (count: number) => `${count} pair(s) of rules contradict each other; only one of each takes effect. Retire one so the intent is unambiguous.`,
    system: 'System', project: 'Project', invoke: '@mention', mount: 'Mount in chat', mounted: 'Mounted', unmount: 'Unmount',
  },
} as const

function collaborationTime(timestamp: number, locale: ProductLocale) {
  return formatProductDateTime(timestamp, locale, { hour: '2-digit', minute: '2-digit', hour12: false })
}

export function AgentCollaborationPanel({
  activities,
  conflictChanges,
  persistenceStatus,
  onLocate,
  onMarkRead,
  onClear,
  onKeepLocal,
  onUseRemote,
  historyStatus,
  historyHasMore,
  historyErrorAction,
  onLoadMore,
  onReload,
  onBackToConversation,
}: {
  activities: CollaborationActivity[]
  conflictChanges: CollaborationDocumentChange[]
  persistenceStatus: 'saved' | 'saving' | 'offline' | 'conflict' | 'error'
  onLocate: (activity: CollaborationActivity) => void
  onMarkRead: () => Promise<void>
  onClear: () => Promise<void>
  onKeepLocal: () => void
  onUseRemote: () => void
  historyStatus: 'idle' | 'loading' | 'loading-more' | 'saving' | 'error'
  historyHasMore: boolean
  historyErrorAction?: 'load' | 'load-more' | 'read' | 'clear'
  onLoadMore: () => Promise<void>
  onReload: () => Promise<void>
  onBackToConversation: () => void
}) {
  const { locale } = useProductI18n()
  const copy = useProductMessages(agentUtilityMessages)
  return <section className="agent-collaboration-panel" aria-label={copy.collaborationAria}>
    <header><AgentPanelBackButton onClick={onBackToConversation} /><div><small>COLLABORATION</small><h2>{copy.collaborationTitle}</h2></div><span>{copy.activityCount(activities.length)}</span></header>
    <p>{copy.collaborationDescription}</p>
    {persistenceStatus === 'conflict' ? <div className="agent-collaboration-panel__conflict" role="alert">
      <span><strong>{copy.remoteCanvasTitle}</strong><small>{copy.remoteCanvasDetail}</small></span>
      {conflictChanges.length ? <details className="agent-collaboration-panel__conflict-details">
        <summary>{copy.viewChanges(conflictChanges.length)}</summary>
        <ul>{conflictChanges.map((change, index) => <li key={`${change.summary}-${index}`}>
          <button type="button" onClick={() => onLocate({ id: `conflict-${index}`, actorName: copy.remoteVersion, occurredAt: Date.now(), unread: false, count: 1, ...change })}>{change.summary}{change.target?.kind === 'node' ? <FocusIcon /> : null}</button>
        </li>)}</ul>
      </details> : <small>{copy.readingRemoteChanges}</small>}
      <div><button type="button" onClick={onKeepLocal}>{copy.keepLocal}</button><button type="button" className="is-primary" onClick={onUseRemote}>{copy.useRemote}</button></div>
    </div> : null}
    {historyStatus === 'error' ? <button type="button" className="agent-collaboration-panel__sync-error" onClick={() => void onReload().catch(() => undefined)}>{historyErrorAction === 'read' ? copy.readSyncFailed : historyErrorAction === 'clear' ? copy.clearSyncFailed : copy.activitySyncFailed}</button> : null}
    <div className="agent-collaboration-panel__toolbar">
      <button type="button" disabled={historyStatus === 'saving' || !activities.some((activity) => activity.unread)} onClick={() => void onMarkRead().catch(() => undefined)}>{copy.markAllRead}</button>
      <button type="button" disabled={historyStatus === 'saving' || !activities.length} onClick={() => void onClear().catch(() => undefined)}>{copy.clearHistory}</button>
    </div>
    <div className="agent-collaboration-panel__list">
      {activities.map((activity) => <button key={activity.id} type="button" className={activity.unread ? 'is-unread' : ''} onClick={() => onLocate(activity)}>
        <i aria-hidden="true" />
        <span><strong>{activity.actorName}</strong><small>{activity.summary}{activity.count > 1 ? ` · ${copy.occurrenceCount(activity.count)}` : ''}</small></span>
        <time dateTime={new Date(activity.occurredAt).toISOString()}>{collaborationTime(activity.occurredAt, locale)}</time>
        {activity.target && activity.target.kind !== 'project' ? <FocusIcon /> : null}
      </button>)}
      {!activities.length && historyStatus !== 'loading' ? <div className="agent-panel__empty">{copy.noActivities}</div> : null}
      {historyStatus === 'loading' ? <div className="agent-panel__empty" role="status">{copy.loadingActivities}</div> : null}
      {historyHasMore ? <button type="button" className="agent-collaboration-panel__load-more" disabled={historyStatus === 'loading-more'} onClick={() => void onLoadMore().catch(() => undefined)}>{historyStatus === 'loading-more' ? copy.loading : copy.loadEarlierActivities}</button> : null}
    </div>
  </section>
}

function isMediaArtifact(artifact: BotanicAgentArtifact) {
  return (artifact.kind === 'image' || artifact.kind === 'video') && Boolean(artifact.url)
}

function AgentResultPrompt({ prompt }: { prompt: string }) {
  const copy = useProductMessages(agentUtilityMessages)
  const [copied, setCopied] = useState(false)
  return <details className="agent-result-panel__prompt">
    <summary>{copy.comparePrompt}</summary>
    <pre>{prompt}</pre>
    <button type="button" onClick={() => {
      if (!navigator.clipboard?.writeText) return
      void navigator.clipboard.writeText(prompt).then(() => setCopied(true)).catch(() => setCopied(false))
    }}><CopyIcon /><span>{copied ? copy.copied : copy.copyPrompt}</span></button>
  </details>
}

function artifactShortLabel(artifact: BotanicAgentArtifact, fallback: string) {
  return clipBotanicAgentNodeTitle(artifact.label) || artifact.label || fallback
}

export function AgentResultPanel({
  artifacts,
  runs,
  latestRun,
  contextOptions,
  generationModels,
  artifactIndexStatus,
  artifactIndexHasMore,
  conversationRunIds,
  onLocateNode,
  onSaveArtifact,
  onContinue,
  onStartNextRound,
  onLoadMoreArtifacts,
  onLocateConversation,
  onBackToConversation,
}: {
  artifacts: BotanicAgentArtifact[]
  runs: BotanicAgentRun[]
  latestRun?: BotanicAgentRun
  contextOptions: AgentContextItem[]
  generationModels: GenerationModelOption[]
  artifactIndexStatus: AgentArtifactIndexState['status']
  artifactIndexHasMore: boolean
  conversationRunIds: string[]
  onLocateNode: (nodeId: string) => void
  onSaveArtifact: (artifact: BotanicAgentArtifact) => void
  onContinue: (artifact: BotanicAgentArtifact) => void
  onStartNextRound: (sourceNodeIds: string[], artifactCount: number) => void
  onLoadMoreArtifacts: () => Promise<void>
  onLocateConversation: (runId: string) => void
  onBackToConversation: () => void
}) {
  const { locale } = useProductI18n()
  const copy = useProductMessages(agentUtilityMessages)
  // 一级直接看画面；点图才进入该项的操作层。Skill / MCP 文本产物仍在次级页签。
  const [tab, setTab] = useState<'media' | 'tool'>('media')
  const [kindFilter, setKindFilter] = useState<'all' | 'image' | 'video'>('all')
  const [modelFilter, setModelFilter] = useState('')
  const [libraryFilter, setLibraryFilter] = useState<'all' | 'saved' | 'unsaved'>('all')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [previewId, setPreviewId] = useState<string | null>(null)

  const mediaArtifacts = useMemo(() => artifacts.filter(isMediaArtifact), [artifacts])
  const toolArtifacts = useMemo(() => artifacts.filter((artifact) => !isMediaArtifact(artifact)), [artifacts])
  const modelOptions = useMemo(() => [...new Set(mediaArtifacts
    .map((artifact) => botanicAgentArtifactModel(artifact))
    .filter((model): model is string => Boolean(model)))], [mediaArtifacts])

  const filteredArtifacts = useMemo(() => {
    if (tab === 'tool') return toolArtifacts
    return mediaArtifacts.filter((artifact) => {
      if (kindFilter !== 'all' && artifact.kind !== kindFilter) return false
      if (modelFilter && botanicAgentArtifactModel(artifact) !== modelFilter) return false
      const saved = artifact.metadata?.savedToLibrary === true
      if (libraryFilter === 'saved' && !saved) return false
      if (libraryFilter === 'unsaved' && saved) return false
      return true
    })
  }, [kindFilter, libraryFilter, mediaArtifacts, modelFilter, tab, toolArtifacts])

  const groups = useMemo(() => {
    const grouped = new Map<string, { id: string; label: string; artifacts: BotanicAgentArtifact[]; updatedAt: number }>()
    for (const artifact of filteredArtifacts) {
      const runId = artifact.provenance.runId
      const id = runId ?? `action:${artifact.provenance.actionId}`
      const plan = runId ? runs.find((run) => run.id === runId)?.plan : undefined
      const label = runId
        ? locale === 'en' ? plan?.title?.trim() || copy.generationBatch : botanicAgentResultGroupTitle(plan)
        : copy.toolArtifacts
      const group = grouped.get(id) ?? { id, label, artifacts: [], updatedAt: 0 }
      group.artifacts.push(artifact)
      group.updatedAt = Math.max(group.updatedAt, botanicAgentArtifactTimestamp(artifact))
      grouped.set(id, group)
    }
    return [...grouped.values()]
      .map((group) => ({
        ...group,
        artifacts: [...group.artifacts].sort((left, right) => botanicAgentArtifactTimestamp(right) - botanicAgentArtifactTimestamp(left)),
      }))
      .sort((left, right) => right.updatedAt - left.updatedAt)
  }, [copy.generationBatch, copy.toolArtifacts, filteredArtifacts, locale, runs])

  const selectedBatch = useMemo(() => resolveBotanicAgentResultSelection(artifacts, selectedIds), [artifacts, selectedIds])
  const availableNodeIds = useMemo(() => new Set(contextOptions.map((item) => item.id)), [contextOptions])
  const resultNodeIds = useMemo(() => new Set(contextOptions.filter((item) => item.kind === '结果').map((item) => item.id)), [contextOptions])
  const selectedResultNodeIds = selectedBatch.sourceNodeIds.filter((nodeId) => resultNodeIds.has(nodeId))
  const latestFeedback = latestRun
    ? agentRunFeedback(latestRun, artifacts, availableNodeIds, locale)
    : undefined
  const preview = previewId ? artifacts.find((artifact) => artifact.id === previewId) : undefined

  useEffect(() => {
    setSelectedIds((current) => current.filter((id) => artifacts.some((artifact) => artifact.id === id)))
  }, [artifacts])

  useEffect(() => {
    if (modelFilter && !modelOptions.includes(modelFilter)) setModelFilter('')
  }, [modelFilter, modelOptions])

  useEffect(() => {
    if (previewId && !artifacts.some((artifact) => artifact.id === previewId)) setPreviewId(null)
  }, [artifacts, previewId])

  const toggleSelection = (artifactId: string) => {
    setSelectedIds((current) => current.includes(artifactId)
      ? current.filter((id) => id !== artifactId)
      : [...current, artifactId])
  }

  const toggleGroup = (groupArtifacts: BotanicAgentArtifact[]) => {
    const groupIds = groupArtifacts.map((artifact) => artifact.id)
    setSelectedIds((current) => groupIds.every((id) => current.includes(id))
      ? current.filter((id) => !groupIds.includes(id))
      : [...current, ...groupIds.filter((id) => !current.includes(id))])
  }

  const openTab = (next: 'media' | 'tool') => {
    setTab(next)
    setPreviewId(null)
  }

  if (preview) {
    const locatableNodeId = preview.provenance.sourceNodeIds?.find((nodeId) => availableNodeIds.has(nodeId))
    const media = isMediaArtifact(preview)
    const canContinue = Boolean(locatableNodeId || media)
    const prompt = botanicAgentArtifactPrompt(preview)
    const model = botanicAgentArtifactModel(preview)
    const shortLabel = artifactShortLabel(preview, copy.generatedResult)
    const modelLabel = model
      ? modelDisplayLabel(generationModels.find((option) => option.id === model)) || model
      : preview.provenance.toolName
    return <section className="agent-result-panel is-detail" aria-label={copy.detailAria(shortLabel)}>
      <header>
        <AgentPanelBackButton label={copy.backToResults} onClick={() => setPreviewId(null)} />
        <div><small>ARTIFACT</small><h2>{shortLabel}</h2></div>
      </header>
      <div className="agent-result-panel__detail">
        {media ? <div className="agent-result-panel__hero">
          {preview.kind === 'image' ? <img src={preview.url} alt={shortLabel} /> : <video src={preview.url} controls playsInline />}
        </div> : <div className="agent-result-panel__document is-detail"><span>{preview.kind === 'workflow' ? '⌘' : 'Aa'}</span><p>{preview.content ?? preview.label}</p></div>}
        <p className="agent-result-panel__detail-meta">
          {agentArtifactKindLabel(preview, locale)}
          {modelLabel ? ` · ${modelLabel}` : ''}
          {locatableNodeId ? ` · ${copy.backfilled}` : ''}
        </p>
        <div className="agent-result-panel__detail-actions">
          {locatableNodeId ? <button type="button" onClick={() => onLocateNode(locatableNodeId)}>{copy.locateCanvas}</button> : null}
          {canContinue ? <button type="button" onClick={() => onContinue(preview)}>{copy.continueEditing}</button> : null}
          {media ? <button type="button" disabled={preview.metadata?.savedToLibrary === true} onClick={() => onSaveArtifact(preview)}>{preview.metadata?.savedToLibrary === true ? copy.saved : copy.save}</button> : null}
          {media ? <button type="button" onClick={() => void downloadMedia(preview.url!, preview.label, preview.kind === 'video' ? 'video' : 'image')}>{copy.download}</button> : preview.url ? <a href={preview.url} target="_blank" rel="noreferrer">{copy.open}</a> : null}
        </div>
        {prompt ? <AgentResultPrompt prompt={prompt} /> : null}
      </div>
    </section>
  }

  return <section className="agent-result-panel" aria-label={copy.resultsAria}>
    <header><AgentPanelBackButton onClick={onBackToConversation} /><div><small>AGENT OUTPUTS</small><h2>{copy.resultsTitle}</h2></div><span>{copy.itemCount(mediaArtifacts.length)}</span></header>
    {artifactIndexStatus === 'loading' ? <div className="agent-result-panel__index-status" role="status">{copy.readingIndex}</div> : null}
    {artifactIndexStatus === 'error' ? <div className="agent-result-panel__index-status is-warning" role="status">{copy.indexUnavailable}</div> : null}
    {latestFeedback ? <div className={`agent-result-panel__run-status is-${latestFeedback.tone}`} role="status"><strong>{latestFeedback.label}</strong><span>{latestFeedback.detail}</span></div> : null}
    <div className="agent-result-panel__tabs" role="group" aria-label={copy.resultsSections}>
      <button type="button" aria-pressed={tab === 'media'} className={tab === 'media' ? 'is-active' : ''} onClick={() => openTab('media')}>{copy.mediaResults}<b>{mediaArtifacts.length}</b></button>
      <button type="button" aria-pressed={tab === 'tool'} className={tab === 'tool' ? 'is-active' : ''} onClick={() => openTab('tool')}>{copy.toolArtifacts}<b>{toolArtifacts.length}</b></button>
    </div>
    {tab === 'media' ? <div className="agent-result-panel__filters" role="group" aria-label={copy.resultFilter}>
      {([['all', copy.all], ['image', copy.images], ['video', copy.videos]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={kindFilter === value} className={kindFilter === value ? 'is-active' : ''} onClick={() => setKindFilter(value)}>{label}</button>)}
      <BotanicSelect
        className="agent-result-panel__library-select"
        value={libraryFilter}
        ariaLabel={copy.libraryFilter}
        options={[
          { value: 'all', label: copy.anyLibraryStatus },
          { value: 'unsaved', label: copy.unsaved },
          { value: 'saved', label: copy.saved },
        ]}
        onChange={(value) => setLibraryFilter(value as 'all' | 'saved' | 'unsaved')}
      />
      {modelOptions.length > 1 ? <BotanicSelect
        className="agent-result-panel__model-select"
        value={modelFilter}
        ariaLabel={copy.modelFilter}
        options={[{ value: '', label: copy.allModels }, ...modelOptions.map((model) => ({
          value: model,
          label: modelDisplayLabel(generationModels.find((option) => option.id === model)) || model,
        }))]}
        onChange={setModelFilter}
      /> : null}
    </div> : null}
    {selectedBatch.artifacts.length ? <div className="agent-result-panel__selection" aria-label={copy.batchActions}>
      <strong>{copy.selectedCount(selectedBatch.artifacts.length)}</strong>
      <div>
        {selectedBatch.mediaArtifacts.length ? <>
          <button type="button" disabled={selectedBatch.mediaArtifacts.every((artifact) => artifact.metadata?.savedToLibrary === true)} onClick={() => selectedBatch.mediaArtifacts.filter((artifact) => artifact.metadata?.savedToLibrary !== true).forEach(onSaveArtifact)}>{copy.save}</button>
          <button type="button" onClick={() => void (async () => {
            for (const artifact of selectedBatch.mediaArtifacts) await downloadMedia(artifact.url!, artifact.label, artifact.kind === 'video' ? 'video' : 'image')
          })()}>{copy.download}</button>
        </> : null}
        <button type="button" className="is-primary" disabled={!selectedResultNodeIds.length} onClick={() => onStartNextRound(selectedResultNodeIds, selectedBatch.artifacts.length)}>{copy.startNextRound}</button>
        <button type="button" onClick={() => setSelectedIds([])}>{copy.cancel}</button>
      </div>
    </div> : null}
    <div className="agent-result-panel__groups">
      {groups.map((group) => {
        const backfilled = group.artifacts.some((artifact) => artifact.provenance.sourceNodeIds?.some((nodeId) => availableNodeIds.has(nodeId)))
        return <section key={group.id} className="agent-result-group">
          <header>
            <span><strong>{group.label}</strong><small>{copy.itemCount(group.artifacts.length)}</small></span>
            <em>{backfilled ? copy.backfilled : copy.notBackfilled}</em>
            {conversationRunIds.includes(group.id) ? <button type="button" onClick={() => onLocateConversation(group.id)}>{copy.sourceConversation}</button> : null}
            <button type="button" onClick={() => toggleGroup(group.artifacts)}>{group.artifacts.every((artifact) => selectedIds.includes(artifact.id)) ? copy.clearSelection : copy.selectAll}</button>
          </header>
          <div className={`agent-result-panel__grid${tab === 'tool' ? ' is-documents' : ''}`}>
            {group.artifacts.map((artifact) => {
              const media = isMediaArtifact(artifact)
              const selected = selectedIds.includes(artifact.id)
              const shortLabel = artifactShortLabel(artifact, copy.generatedResult)
              return <article key={artifact.id} className={selected ? 'is-selected' : ''}>
                <button type="button" className="agent-result-panel__select" aria-pressed={selected} aria-label={`${selected ? copy.deselect : copy.select} ${shortLabel}`} title={selected ? copy.deselect : copy.select} onClick={() => toggleSelection(artifact.id)}>{selected ? '✓' : ''}</button>
                <button type="button" className="agent-result-panel__open" aria-label={`${copy.view} ${shortLabel}`} onClick={() => setPreviewId(artifact.id)}>
                  {media ? <span className="agent-result-panel__preview">
                    {artifact.kind === 'image' ? <img src={artifact.url} alt="" /> : <video src={artifact.url} muted playsInline />}
                  </span> : <span className="agent-result-panel__document"><span>{artifact.kind === 'workflow' ? '⌘' : 'Aa'}</span><b>{shortLabel}</b></span>}
                </button>
              </article>
            })}
          </div>
        </section>
      })}
      {!filteredArtifacts.length ? <div className="agent-panel__empty">{tab === 'tool' ? copy.noToolArtifacts : copy.noGeneratedResults}</div> : null}
      {artifactIndexHasMore ? <button type="button" className="agent-result-panel__load-more" disabled={artifactIndexStatus === 'loading-more'} onClick={() => void onLoadMoreArtifacts()}>{artifactIndexStatus === 'loading-more' ? copy.loading : copy.loadEarlierResults}</button> : null}
    </div>
  </section>
}

export function AgentMemoryPanel({ memory, sourceNodeIds, onAddMemory, onRemoveMemory, onLocateNode, onBackToConversation }: {
  memory: BotanicAgentMemoryItem[]
  sourceNodeIds: string[]
  onAddMemory: (
    kind: BotanicAgentMemoryKind,
    content: string,
    sourceNodeIds?: string[],
    options?: { subject?: BotanicAgentMemoryItem['subject']; subjectValue?: string },
  ) => string | null
  onRemoveMemory: (memoryId: string) => void
  onLocateNode: (nodeId: string) => void
  onBackToConversation: () => void
}) {
  const { locale } = useProductI18n()
  const copy = useProductMessages(agentUtilityMessages)
  const [kind, setKind] = useState<BotanicAgentMemoryKind>('rule')
  const [draft, setDraft] = useState('')
  const [subject, setSubject] = useState<BotanicAgentMemoryItem['subject']>('project')
  const [subjectValue, setSubjectValue] = useState('')
  const comparisonRows = useMemo(() => memoryComparisonRows(memory), [memory])
  const conflictCount = useMemo(() => memoryConflictPairs(memory).length, [memory])
  const save = () => {
    if (!draft.trim()) return
    // 限定了范围却没填取值时不提交：那条规则永远匹配不上任何一次执行。
    if (subject !== 'project' && !subjectValue.trim()) return
    if (onAddMemory(kind, draft, sourceNodeIds, { subject, subjectValue: subjectValue.trim() })) {
      setDraft('')
      setSubjectValue('')
      setSubject('project')
    }
  }

  return <section className="agent-memory-panel" aria-label={copy.memoryAria}>
    <header><AgentPanelBackButton onClick={onBackToConversation} /><div><small>PROJECT MEMORY</small><h2>{copy.memoryTitle}</h2></div><span>{copy.memoryCount(memory.length)}</span></header>
    <p>{copy.memoryDescription}</p>
    {conflictCount ? <p className="agent-memory-panel__conflicts">{copy.memoryConflicts(conflictCount)}</p> : null}
    <div className="agent-memory-panel__form">
      <BotanicSelect value={kind} ariaLabel={copy.memoryType} options={[
        { value: 'rule', label: copy.longTermRule },
        { value: 'approved', label: copy.approvedDirection },
        { value: 'avoid', label: copy.avoid },
      ]} onChange={(value) => setKind(value as BotanicAgentMemoryKind)} />
      <textarea value={draft} maxLength={500} onChange={(event) => setDraft(event.target.value)} placeholder={copy.memoryPlaceholder} aria-label={copy.memoryContent} />
      {/* 适用范围：限定后这条规则只在匹配的生成里生效，其余不带上它。 */}
      <div className="agent-memory-panel__subject">
        <BotanicSelect
          value={subject ?? 'project'}
          ariaLabel={copy.memoryScope}
          options={MEMORY_SUBJECT_OPTIONS.map((option) => ({ value: option, label: memorySubjectLabel(option, locale) }))}
          onChange={(value) => { setSubject(value as BotanicAgentMemoryItem['subject']); if (value === 'project') setSubjectValue('') }}
        />
        {subject !== 'project' ? <input
          value={subjectValue}
          maxLength={80}
          aria-label={copy.memoryScopeValue}
          placeholder={copy.memoryScopeValuePlaceholder}
          onChange={(event) => setSubjectValue(event.target.value)}
        /> : null}
      </div>
      <button type="button" disabled={!draft.trim() || (subject !== 'project' && !subjectValue.trim())} onClick={save}>{copy.saveMemory}</button>
    </div>
    <div className="agent-memory-panel__list">
      {comparisonRows.map((row) => {
        const item = memory.find((entry) => entry.id === row.id)
        if (!item) return null
        // 不生效的原因要说出来：用户看不到冲突就永远不知道该停用哪一条。
        const reason = memoryIneffectiveReason(row, comparisonRows, locale)
        return <article key={item.id} className={`is-${item.kind}${row.effective ? '' : ' is-ineffective'}`}>
          <span>
            <small>{agentMemoryKindLabel(item.kind, locale)}</small>
            <p>{item.content}</p>
            {/* 限定范围的规则不会进入每一次生成；不说清楚，用户会在别的渠道下
                疑惑「我明明写了这条规则」。 */}
            {item.subject && item.subject !== 'project'
              ? <em className="agent-memory-panel__subject-note">{memorySubjectDescription(item, locale)}</em>
              : null}
            {reason ? <em className="agent-memory-panel__reason">{reason}</em> : null}
          </span>
          <div>
            {item.sourceNodeIds[0] ? <button type="button" aria-label={copy.locateMemory(item.content)} title={copy.locate} onClick={() => onLocateNode(item.sourceNodeIds[0])}><FocusIcon /></button> : null}
            <button type="button" className="is-delete" aria-label={copy.deleteMemory(item.content)} title={copy.deleteMemoryTitle} onClick={() => onRemoveMemory(item.id)}><DeleteIcon /></button>
          </div>
        </article>
      })}
      {!memory.length ? <div className="agent-panel__empty">{copy.noMemory}</div> : null}
    </div>
  </section>
}

/**
 * 结果评审面板（Epic 5）。
 *
 * 三条展示约束由 `agentReviewPresentation` 保证，组件只负责渲染：
 * 覆盖摘要必须带被跳过的候选数；`未验证` 与 `不符合` 是两个词；
 * 没有人工决定的候选一律显示为「待你决定」——自动结论不代替品牌批准。
 */
/**
 * 品牌规则面板（Epic 9.1）。
 *
 * 解析由服务端完成，与生成时同一实现 —— 界面显示生效的那条，就是生成时会用的那条。
 * 这里只负责把三段分开摆出来：生效中、待确认（**不生效**）、被覆盖（不隐藏）。
 */
export function BrandKitPanel({ projectId, onBackToConversation }: {
  projectId: string
  onBackToConversation: () => void
}) {
  const { locale } = useProductI18n()
  const copy = useProductMessages(agentUtilityMessages)
  const [kit, setKit] = useState<ResolvedBrandKit | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    let active = true
    setStatus('loading')
    fetchProjectBrandKit(projectId)
      .then((loaded) => { if (active) { setKit(loaded); setStatus('ready') } })
      .catch(() => { if (active) setStatus('error') })
    return () => { active = false }
  }, [projectId])

  const effective = useMemo(() => effectiveBrandRuleRows(kit ?? undefined, locale), [kit, locale])
  const overridden = useMemo(() => overriddenBrandRuleRows(kit ?? undefined, locale), [kit, locale])
  const proposals = useMemo(() => brandProposalRows(kit?.pending, locale), [kit, locale])

  return <section className="agent-brand-panel" aria-label={copy.brandAria}>
    <header><AgentPanelBackButton onClick={onBackToConversation} /><div><small>BRAND KIT</small><h2>{copy.brandTitle}</h2></div></header>
    <p>{copy.brandDescription}</p>
    {status === 'loading' ? <div className="agent-panel__empty">{copy.brandLoading}</div> : null}
    {status === 'error' ? <div className="agent-panel__empty">{copy.brandUnavailable}</div> : null}
    {/* 未绑定品牌与「绑定了但没有规则」是两回事；后者说得出「0 条生效」，前者要说没绑定。 */}
    {status === 'ready' && !kit ? <div className="agent-panel__empty">{copy.brandUnbound}</div> : null}
    {status === 'ready' && kit ? <>
      <p className="agent-brand-panel__summary">{brandKitSummary(kit, locale)}</p>
      <h3>{copy.brandEffective}</h3>
      <ul className="agent-brand-panel__rules">
        {effective.map((row) => <li key={row.slot} className={`is-${row.enforcement}`}>
          <header><small>{row.facetLabel}</small><b>{row.enforcementLabel}</b></header>
          <p>{row.statement}</p>
          <small className="agent-brand-panel__provenance">{row.provenance}</small>
        </li>)}
      </ul>
      {proposals.length ? <>
        <h3>{copy.brandPending}</h3>
        <ul className="agent-brand-panel__proposals">
          {proposals.map((proposal) => <li key={proposal.id} className={proposal.needsFacet ? 'needs-facet' : ''}>
            <header><small>{proposal.facetLabel}</small></header>
            <p>{proposal.statement}</p>
            {/* 建议看起来和真规则一模一样，因此每条都要写明它当前不生效。 */}
            <small className="agent-brand-panel__hint">{proposal.hint}</small>
            {proposal.sourceRef ? <small>{copy.brandSourceRef(proposal.sourceRef)}</small> : null}
          </li>)}
        </ul>
      </> : null}
      {overridden.length ? <>
        <h3>{copy.brandOverridden}</h3>
        <ul className="agent-brand-panel__rules is-overridden">
          {overridden.map((row) => <li key={row.id}>
            <header><small>{row.facetLabel}</small></header>
            <p>{row.statement}</p>
            <small className="agent-brand-panel__provenance">{row.provenance}</small>
          </li>)}
        </ul>
      </> : null}
    </> : null}
  </section>
}

export function AgentReviewPanel({ runId, projectId, onBackToConversation }: {
  runId: string
  projectId?: string
  onBackToConversation: () => void
}) {
  const { locale } = useProductI18n()
  const copy = useProductMessages(agentUtilityMessages)
  const [tasks, setTasks] = useState<AgentReviewTaskSnapshot[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [pending, setPending] = useState('')
  const [notice, setNotice] = useState('')
  // 评审决定需要 edit 能力（与服务端 review_decide 同一能力）。Viewer 不该看到这三个
  // 按钮 —— 点了必然 403，而失败的按钮比没有按钮更让人困惑。
  const canDecide = canUseProjectEntry(
    projectId ? cachedProjectCapabilities(projectId) : undefined,
    'decideReview',
    serverPersistenceEnabled,
  )

  useEffect(() => {
    let active = true
    setStatus('loading')
    fetchAgentReviewTasks(runId)
      .then((loaded) => { if (active) { setTasks(loaded); setStatus('ready') } })
      .catch(() => { if (active) setStatus('error') })
    return () => { active = false }
  }, [runId])

  const decide = async (taskId: string, artifactId: string, decision: AgentReviewDecision) => {
    setPending(`${taskId}:${artifactId}`)
    setNotice('')
    try {
      const result = await submitAgentReviewDecisions(taskId, [{ artifactId, decision }])
      setTasks((current) => current.map((task) => (task.id === taskId ? result.task : task)))
      // 请求重试会产生新的 Run；照实说明原结果没有被覆盖。
      if (result.retryRuns?.length) setNotice(copy.reviewRetryCreated(result.retryRuns.length))
    } catch {
      setNotice(copy.reviewDecisionFailed)
    } finally {
      setPending('')
    }
  }

  return <section className="agent-review-panel" aria-label={copy.reviewAria}>
    <header><AgentPanelBackButton onClick={onBackToConversation} /><div><small>RESULT REVIEW</small><h2>{copy.reviewTitle}</h2></div></header>
    <p>{copy.reviewDescription}</p>
    {status === 'loading' ? <div className="agent-panel__empty">{copy.reviewLoading}</div> : null}
    {status === 'error' ? <div className="agent-panel__empty">{copy.reviewUnavailable}</div> : null}
    {status === 'ready' && !tasks.length ? <div className="agent-panel__empty">{copy.noReviewTasks}</div> : null}
    {notice ? <p className="agent-review-panel__notice">{notice}</p> : null}
    {tasks.map((task) => {
      const statusNote = agentReviewTaskStatusNote(task, locale)
      return <article key={task.id} className="agent-review-panel__task">
        <p className="agent-review-panel__coverage">{agentReviewCoverageSummary(task, locale)}</p>
        {statusNote ? <p className="agent-review-panel__status">{statusNote}</p> : null}
        {/* 自定义判据的成本必须在这里就说清楚：评审完再说已经晚了，钱已经花掉。 */}
        {agentReviewEvaluatorCostNote(task, locale)
          ? <p className="agent-review-panel__cost">{agentReviewEvaluatorCostNote(task, locale)}</p>
          : null}
        {agentReviewCandidateRows(task, locale).map((row) => <div key={row.artifactId} className={`agent-review-panel__candidate is-${row.verdict}`}>
          <header>
            <strong>{copy.reviewCandidate(row.artifactId.split(':').at(-1) ?? row.artifactId)}</strong>
            <span className={`agent-review-panel__verdict is-${row.verdict}`}>{row.verdictLabel}</span>
            {row.unverifiedCount ? <small>{copy.reviewUnverified(row.unverifiedCount)}</small> : null}
          </header>
          <ul className="agent-review-panel__criteria">
            {row.criteria.map((criterion) => <li key={criterion.id} className={`is-${criterion.verdict}${criterion.skillId ? ' is-custom' : ''}`}>
              <small>{criterion.skillId ? copy.reviewCustomCriteria : criterion.layerLabel}</small>
              <span>{criterion.id}</span>
              <em>{criterion.verdictLabel}</em>
              {criterion.evidence ? <p>{criterion.evidence}</p> : null}
              {/* Skill 版本不可变：历史评审要说得清当时按哪一版判的。 */}
              {criterion.skillId ? <p className="agent-review-panel__skill-source">{copy.reviewSkillSource(criterion.skillVersion ?? 1)}</p> : null}
            </li>)}
          </ul>
          {row.revisionSuggestion
            ? <p className="agent-review-panel__revision"><small>{copy.reviewRevision}</small>{row.revisionSuggestion}</p>
            : null}
          <footer>
            {row.awaitingHuman ? <small>{copy.reviewAwaiting}</small> : <small>{row.decisionLabel}</small>}
            <div>
              {canDecide ? (['accepted', 'rejected', 'retry_requested'] as const).map((decision) => <button
                key={decision}
                type="button"
                className={row.decision === decision ? 'is-active' : undefined}
                disabled={pending === `${task.id}:${row.artifactId}`}
                onClick={() => void decide(task.id, row.artifactId, decision)}
              >
                {decision === 'accepted' ? copy.reviewAccept : decision === 'rejected' ? copy.reviewReject : copy.reviewRetry}
              </button>) : <small className="agent-review-panel__readonly">{copy.reviewReadOnly}</small>}
            </div>
          </footer>
        </div>)}
      </article>
    })}
  </section>
}

export function AgentSkillCard({
  id,
  name,
  instructions,
  source,
  expanded,
  mounted = false,
  onToggle,
  onToggleMount,
}: {
  id: string
  name: string
  instructions: string
  source: 'system' | 'project'
  expanded: boolean
  mounted?: boolean
  onToggle: (id: string) => void
  onToggleMount?: (id: string, nextMounted: boolean) => void
}) {
  const copy = useProductMessages(agentUtilityMessages)
  const summary = botanicAgentSkillSummary(instructions)
  const body = botanicAgentSkillBody(instructions)
  return <article className={`agent-skill-card${expanded ? ' is-expanded' : ''}${mounted ? ' is-mounted' : ''}`}>
    <button type="button" aria-expanded={expanded} aria-controls={`skill-body-${id}`} onClick={() => onToggle(id)}>
      <span>
        {source === 'system' ? <SparkleIcon /> : null}
        <b>{name}</b>
      </span>
      <small>{source === 'system' ? copy.system : copy.project} · {mounted ? copy.mounted : copy.invoke}</small>
      {!expanded && summary ? <p>{summary}</p> : null}
    </button>
    {onToggleMount ? <button type="button" className="agent-skill-card__mount" aria-pressed={mounted} aria-label={mounted ? `${copy.unmount} ${name}` : `${copy.mount} ${name}`} onClick={() => onToggleMount(id, !mounted)}>{mounted ? copy.unmount : copy.mount}</button> : null}
    {expanded ? <pre id={`skill-body-${id}`} className="agent-skill-card__body">{body}</pre> : null}
  </article>
}
