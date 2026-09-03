import { useEffect, useId, useMemo, useRef, useState } from 'react'
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
import { CheckIcon, CopyIcon, DeleteIcon, FocusIcon, PlusIcon, SparkleIcon } from '../../components/BotanicIcons'
import type { CollaborationActivity, CollaborationDocumentChange } from '../../domain/collaborationActivity'
import { createLatestOperation } from '../../domain/latestOperation'
import { downloadMedia } from '../../lib/mediaDownload'
import { agentArtifactKindLabel, agentMemoryKindLabel, agentRunFeedback, AgentPanelBackButton } from './AgentWorkspaceParts'
import { AgentMarkdown } from './AgentMarkdown'
import { AgentAttachment, AgentAttachmentPreview, AgentAttachments, attachmentFromArtifact } from './AgentAttachment'
import {
  agentReviewCandidateRows,
  agentReviewCoverageSummary,
  agentReviewEvaluatorCostNote,
  agentReviewRequiresReconciliation,
  agentReviewTaskStatusNote,
  type AgentReviewDecision,
  type AgentReviewTaskSnapshot,
} from '../../domain/agentReviewPresentation'
import {
  cancelAgentReviewTask,
  fetchAgentReviewTasks,
  reconcileAgentReviewOutcome,
  submitAgentReviewDecisions,
} from '../../lib/agentApi'
import { brandKitSummary, brandProposalRows, effectiveBrandRuleRows, overriddenBrandRuleRows, type ResolvedBrandKit } from '../../domain/brandKitPresentation'
import { fetchBrandKitLibrary, fetchProjectBrandKit } from '../../lib/brandKitApi'
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
    collaborationAria: '协作动态', collaborationEyebrow: '协作', collaborationTitle: '协作动态', collaborationDescription: '查看成员最近修改，并直接定位到相关节点、对话或任务。',
    remoteCanvasTitle: '画布有新的云端版本', remoteCanvasDetail: '本地草稿仍保留；选择云端将替换当前本地草稿。', remoteVersion: '云端版本', revisionCompare: (local?: number, remote?: number) => `本地基于 revision ${local ?? '未知'} · 云端 revision ${remote ?? '未知'}`,
    viewChanges: (count: number) => `查看 ${count} 项变更`, readingRemoteChanges: '正在读取云端变更…', keepLocal: '保留本地并重试', useRemote: '放弃本地，使用云端',
    readSyncFailed: '已读状态同步失败，点击重试', clearSyncFailed: '清空状态同步失败，点击重试', activitySyncFailed: '协作动态同步失败，点击重试',
    markAllRead: '全部已读', clearHistory: '清空记录', noActivities: '还没有协作变更。', loadingActivities: '正在读取协作动态…', loading: '加载中…', loadEarlierActivities: '加载更早动态',
    activityCount: (count: number) => `${count} 条`, occurrenceCount: (count: number) => `${count} 次`, today: '今天', earlier: '更早', unreadActivities: (count: number) => `${count} 条未读动态`,
    comparePrompt: '对照 Prompt', copied: '已复制', copyPrompt: '复制 Prompt', generatedResult: '生成结果', toolArtifacts: '工具产物', generationBatch: '生成批次',
    detailAria: (label: string) => `${label} 详情`, backToResults: '返回结果', backfilled: '已放到画布', locateCanvas: '定位画布', continueEditing: '继续改', saved: '已入库', save: '入库', download: '下载', open: '打开',
    artifactEyebrow: '产物', resultsAria: 'Agent 结果与文件', resultsEyebrow: '结果', resultsTitle: '结果与文件', readingIndex: '正在读取历史结果…', indexUnavailable: '历史结果暂不可用，已显示当前画布结果。', resultsSections: '结果分区', mediaResults: '生成结果', resultFilter: '结果筛选',
    all: '全部', images: '图片', videos: '视频', libraryFilter: '按入库状态筛选', anyLibraryStatus: '不限入库', unsaved: '未入库', modelFilter: '按生成模型筛选', allModels: '全部模型',
    batchActions: '批量操作', selectedCount: (count: number) => `已选 ${count} 项`, startNextRound: '创建下一轮', cancel: '取消', itemCount: (count: number) => `${count} 项`, notBackfilled: '未入画布', sourceConversation: '来源对话', selectAll: '全选', clearSelection: '取消全选', select: '选择', deselect: '取消选择', view: '查看',
    noToolArtifacts: '还没有 Skill / MCP 产物。', noGeneratedResults: '还没有该条件下的生成结果。', loadEarlierResults: '加载更早结果',
    memoryAria: '项目创作记忆', memoryEyebrow: '记忆', memoryTitle: '项目记忆', memoryDescription: '仅用于当前项目的后续规划；保存品牌规则、认可方向与禁区。', memoryType: '记忆类型', longTermRule: '长期规则', approvedDirection: '已确认方向', avoid: '避免事项', memoryPlaceholder: '例如：商品包装与品牌色不可改变', memoryScope: '适用范围', memoryScopeValue: '适用取值', memoryScopeValuePlaceholder: '例如 tmall', memoryContent: '项目记忆内容', saveMemory: '保存记忆', addMemory: '添加记忆', cancelMemory: '取消', memoryFilters: '筛选项目记忆', noMemoryMatches: '当前筛选下没有记忆。', memorySaved: '记忆已保存。', locateMemory: (content: string) => `在画布定位记忆 ${content}`, locate: '在画布定位', deleteMemory: (content: string) => `删除记忆 ${content}`, deleteMemoryTitle: '删除记忆', noMemory: '还没有项目记忆。', memoryCount: (count: number) => `${count} 条`,
    system: '系统', project: '项目', invoke: '可用', mount: '添加', mounted: '已挂载', unmount: '移除',
    brandAria: '品牌规则', brandEyebrow: '品牌', brandTitle: '品牌规则', brandDescription: '生成前会把这些规则编译进执行提示词，生成后逐条复核。规则分全局品牌、项目 Creative Spec、本次运行覆盖三层，同一槽位由更靠近本次运行的那一层生效。', brandAbout: '规则如何生效', brandSections: '品牌规则分区', brandEmptySection: '该分区暂无规则。',
    brandLoading: '正在读取品牌规则…', brandUnavailable: '品牌规则暂不可用，请稍后重试。',
    brandUnbound: '当前项目未绑定品牌，没有任何品牌规则参与生成。', brandEffective: '生效中', brandPending: '待确认建议', brandOverridden: '被覆盖的规则',
    brandSelect: '选择项目品牌', brandBind: '绑定品牌', brandBinding: '正在绑定…',
    brandLibraryLoading: '正在读取可用品牌…', brandLibraryEmpty: '工作区还没有可绑定的品牌套件。', brandLibraryUnavailable: '可用品牌暂时无法读取。',
    brandBindingFailed: '品牌绑定未完成，请稍后重试。', brandReadOnly: '你对这个项目只有查看权限，不能更改品牌绑定。',
    brandConfirm: '确认启用', brandSourceRef: (ref: string) => `出处：${ref}`,
    reviewAria: '结果评审', reviewEyebrow: '评审', reviewTitle: '结果评审', reviewDescription: '逐条判据说明结果是否符合这次确认的计划；自动评审不代表品牌批准，仍需你来决定。',
    reviewLoading: '正在读取评审…', reviewUnavailable: '评审暂不可用，请稍后重试。', noReviewTasks: '这次任务还没有评审记录。',
    reviewCandidate: (id: string) => `结果 ${id}`, reviewUnverified: (count: number) => `${count} 项未验证`,
    reviewRevision: '修订建议', reviewCustomCriteria: '项目自定义判据', reviewSkillSource: (version: number) => `来自项目 Skill · 版本 ${version}`, reviewAccept: '接受', reviewReject: '拒绝', reviewRetry: '请求重试', reviewDetails: (count: number) => `${count} 条判据与修订建议`,
    reviewAwaiting: '待你决定', reviewReadOnly: '你没有决定权限', reviewSubmitting: '提交中…', reviewDecisionFailed: '决定提交失败，请重试。',
    reviewRetryCreated: (count: number) => `已创建 ${count} 个重试任务；原结果保留。`,
    reviewCancel: '停止评审', reviewCancelling: '正在停止…', reviewCancelFailed: '停止请求未能提交，请重试。',
    reviewContinueUnverifiable: '按未验证继续', reviewRetryOnce: '承担风险并重试一次',
    reviewReconciliationFailed: '对账决定未能提交，请重试。', reviewReconciliationAccepted: '对账决定已记录，后台将继续收口评审。',
    memoryConflicts: (count: number) => `有 ${count} 组规则互相矛盾，每组只有一条会生效。停用其中一条，规则才不会互相打架。`,
  },
  en: {
    collaborationAria: 'Collaboration activity', collaborationEyebrow: 'Collaboration', collaborationTitle: 'Collaboration', collaborationDescription: 'Review recent changes from workspace members and jump to the related node, conversation, or task.',
    remoteCanvasTitle: 'A newer canvas version is available', remoteCanvasDetail: 'Your local draft is preserved; choosing remote replaces the current local draft.', remoteVersion: 'Remote version', revisionCompare: (local?: number, remote?: number) => `Local base revision ${local ?? 'unknown'} · remote revision ${remote ?? 'unknown'}`,
    viewChanges: (count: number) => `View ${count} ${count === 1 ? 'change' : 'changes'}`, readingRemoteChanges: 'Reading remote changes…', keepLocal: 'Keep local and retry', useRemote: 'Discard local and use remote',
    readSyncFailed: 'Read status could not sync. Click to retry.', clearSyncFailed: 'Activity could not be cleared. Click to retry.', activitySyncFailed: 'Collaboration activity could not sync. Click to retry.',
    markAllRead: 'Mark all as read', clearHistory: 'Clear activity', noActivities: 'No collaboration activity yet.', loadingActivities: 'Loading collaboration activity…', loading: 'Loading…', loadEarlierActivities: 'Load earlier activity',
    activityCount: (count: number) => `${count} ${count === 1 ? 'update' : 'updates'}`, occurrenceCount: (count: number) => `${count} times`, today: 'Today', earlier: 'Earlier', unreadActivities: (count: number) => `${count} unread ${count === 1 ? 'update' : 'updates'}`,
    comparePrompt: 'Compare prompt', copied: 'Copied', copyPrompt: 'Copy prompt', generatedResult: 'Generated result', toolArtifacts: 'Tool outputs', generationBatch: 'Generation batch',
    detailAria: (label: string) => `${label} details`, backToResults: 'Back to results', backfilled: 'Added to canvas', locateCanvas: 'Locate on canvas', continueEditing: 'Continue editing', saved: 'Saved', save: 'Save', download: 'Download', open: 'Open',
    artifactEyebrow: 'Output', resultsAria: 'Agent results and files', resultsEyebrow: 'Results', resultsTitle: 'Results & files', readingIndex: 'Loading historical results…', indexUnavailable: 'Historical results are unavailable. Showing results from the current canvas.', resultsSections: 'Result sections', mediaResults: 'Generated results', resultFilter: 'Filter results',
    all: 'All', images: 'Images', videos: 'Videos', libraryFilter: 'Filter by library status', anyLibraryStatus: 'Any library status', unsaved: 'Not saved', modelFilter: 'Filter by generation model', allModels: 'All models',
    batchActions: 'Batch actions', selectedCount: (count: number) => `${count} selected`, startNextRound: 'Start next round', cancel: 'Cancel', itemCount: (count: number) => `${count} ${count === 1 ? 'item' : 'items'}`, notBackfilled: 'Not on canvas', sourceConversation: 'Source conversation', selectAll: 'Select all', clearSelection: 'Clear selection', select: 'Select', deselect: 'Deselect', view: 'View',
    noToolArtifacts: 'No Skill or MCP outputs yet.', noGeneratedResults: 'No generated results match these filters.', loadEarlierResults: 'Load earlier results',
    memoryAria: 'Project creative memory', memoryEyebrow: 'Memory', memoryTitle: 'Project memory', memoryDescription: 'Use project memory in future planning to preserve brand rules, approved directions, and boundaries.', memoryType: 'Memory type', longTermRule: 'Long-term rule', approvedDirection: 'Approved direction', avoid: 'Avoid', memoryPlaceholder: 'For example: Keep the product packaging and brand colors unchanged', memoryScope: 'Applies to', memoryScopeValue: 'Value', memoryScopeValuePlaceholder: 'e.g. tmall', memoryContent: 'Project memory content', saveMemory: 'Save memory', addMemory: 'Add memory', cancelMemory: 'Cancel', memoryFilters: 'Filter project memory', noMemoryMatches: 'No memory matches these filters.', memorySaved: 'Memory saved.', locateMemory: (content: string) => `Locate memory on canvas: ${content}`, locate: 'Locate on canvas', deleteMemory: (content: string) => `Delete memory: ${content}`, deleteMemoryTitle: 'Delete memory', noMemory: 'No project memory yet.', memoryCount: (count: number) => `${count} ${count === 1 ? 'entry' : 'entries'}`,
    brandAria: 'Brand rules', brandEyebrow: 'Brand', brandTitle: 'Brand rules', brandDescription: 'These rules are compiled into the execution prompt before generation and checked one by one afterwards. They come from three layers — global brand, project creative spec, and this run’s override — and for any one slot the layer closest to this run wins.', brandAbout: 'How rules take effect', brandSections: 'Brand rule sections', brandEmptySection: 'No rules in this section.',
    brandLoading: 'Loading brand rules…', brandUnavailable: 'Brand rules are unavailable right now. Try again shortly.',
    brandUnbound: 'This project is not bound to a brand, so no brand rules take part in generation.', brandEffective: 'In effect', brandPending: 'Awaiting confirmation', brandOverridden: 'Overridden rules',
    brandSelect: 'Select project brand', brandBind: 'Bind brand', brandBinding: 'Binding…',
    brandLibraryLoading: 'Loading available brands…', brandLibraryEmpty: 'No brand kits are available in this workspace.', brandLibraryUnavailable: 'Available brands could not be loaded.',
    brandBindingFailed: 'The brand could not be bound. Try again shortly.', brandReadOnly: 'You have view-only access to this project and cannot change its brand binding.',
    brandConfirm: 'Confirm and activate', brandSourceRef: (ref: string) => `Source: ${ref}`,
    reviewAria: 'Result review', reviewEyebrow: 'Review', reviewTitle: 'Result review', reviewDescription: 'Per-criterion findings on whether results match the plan you confirmed. An automatic pass is not brand approval — the call is still yours.',
    reviewLoading: 'Loading review…', reviewUnavailable: 'Review is unavailable right now. Try again shortly.', noReviewTasks: 'No review has been recorded for this task yet.',
    reviewCandidate: (id: string) => `Result ${id}`, reviewUnverified: (count: number) => `${count} not verified`,
    reviewRevision: 'Suggested revision', reviewCustomCriteria: 'Project-defined criterion', reviewSkillSource: (version: number) => `From a project Skill · version ${version}`, reviewAccept: 'Accept', reviewReject: 'Reject', reviewRetry: 'Request retry', reviewDetails: (count: number) => `${count} criteria and revision details`,
    reviewAwaiting: 'Awaiting your decision', reviewReadOnly: 'You cannot decide on this project', reviewSubmitting: 'Submitting…', reviewDecisionFailed: 'The decision could not be submitted. Try again.',
    reviewRetryCreated: (count: number) => `Created ${count} retry task(s); the original results are kept.`,
    reviewCancel: 'Stop review', reviewCancelling: 'Stopping…', reviewCancelFailed: 'The stop request could not be submitted. Try again.',
    reviewContinueUnverifiable: 'Continue as not verified', reviewRetryOnce: 'Accept risk and retry once',
    reviewReconciliationFailed: 'The reconciliation choice could not be submitted. Try again.', reviewReconciliationAccepted: 'The choice was recorded; review will finish in the background.',
    memoryConflicts: (count: number) => `${count} pair(s) of rules contradict each other; only one of each takes effect. Retire one so the intent is unambiguous.`,
    system: 'System', project: 'Project', invoke: 'Available', mount: 'Add', mounted: 'Mounted', unmount: 'Remove',
  },
} as const

function collaborationTime(timestamp: number, locale: ProductLocale) {
  return formatProductDateTime(timestamp, locale, { hour: '2-digit', minute: '2-digit', hour12: false })
}

export function AgentCollaborationPanel({
  activities,
  conflictChanges,
  conflictRevision,
  persistenceStatus,
  onLocate,
  onMarkRead,
  onClear,
  onKeepLocal,
  onUseRemote,
  showConflict = true,
  historyStatus,
  historyHasMore,
  historyErrorAction,
  onLoadMore,
  onReload,
}: {
  activities: CollaborationActivity[]
  conflictChanges: CollaborationDocumentChange[]
  conflictRevision?: { localRevision?: number; remoteRevision: number }
  persistenceStatus: 'saved' | 'saving' | 'offline' | 'conflict' | 'error'
  onLocate: (activity: CollaborationActivity) => void
  onMarkRead: () => Promise<void>
  onClear: () => Promise<void>
  onKeepLocal: () => void
  onUseRemote: () => void
  showConflict?: boolean
  historyStatus: 'idle' | 'loading' | 'loading-more' | 'saving' | 'error'
  historyHasMore: boolean
  historyErrorAction?: 'load' | 'load-more' | 'read' | 'clear'
  onLoadMore: () => Promise<void>
  onReload: () => Promise<void>
}) {
  const { locale } = useProductI18n()
  const copy = useProductMessages(agentUtilityMessages)
  const today = new Date().toDateString()
  const activityGroups = [
    { label: copy.today, items: activities.filter((activity) => new Date(activity.occurredAt).toDateString() === today) },
    { label: copy.earlier, items: activities.filter((activity) => new Date(activity.occurredAt).toDateString() !== today) },
  ].filter((group) => group.items.length)
  const unreadCount = activities.filter((activity) => activity.unread).length
  return <section className="agent-collaboration-panel" aria-label={copy.collaborationAria}>
    <p>{copy.collaborationDescription}</p>
    <div className="agent-collaboration-panel__summary"><strong>{copy.activityCount(activities.length)}</strong>{unreadCount ? <span>{copy.unreadActivities(unreadCount)}</span> : null}</div>
    {showConflict && persistenceStatus === 'conflict' ? <div className="agent-collaboration-panel__conflict">
      <span role="alert"><strong>{copy.remoteCanvasTitle}</strong><small>{copy.remoteCanvasDetail}</small></span>
      {conflictRevision ? <small>{copy.revisionCompare(conflictRevision.localRevision, conflictRevision.remoteRevision)}</small> : null}
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
    <p className="visually-hidden" role="status">{historyStatus === 'loading' || historyStatus === 'loading-more' ? copy.loadingActivities : unreadCount ? copy.unreadActivities(unreadCount) : copy.activityCount(activities.length)}</p>
    <div className="agent-collaboration-panel__list" aria-busy={historyStatus === 'loading' || historyStatus === 'loading-more'}>
      {activityGroups.map((group) => <section key={group.label} className="agent-collaboration-panel__group">
        <h3>{group.label}</h3>
        {group.items.map((activity) => <button key={activity.id} type="button" className={activity.unread ? 'is-unread' : ''} onClick={() => onLocate(activity)}>
          <i aria-hidden="true" />
          <span><strong>{activity.actorName}</strong><small>{activity.summary}{activity.count > 1 ? ` · ${copy.occurrenceCount(activity.count)}` : ''}</small></span>
          <time dateTime={new Date(activity.occurredAt).toISOString()}>{collaborationTime(activity.occurredAt, locale)}</time>
          {activity.target && activity.target.kind !== 'project' ? <FocusIcon /> : null}
        </button>)}
      </section>)}
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
  const showKindFilter = mediaArtifacts.some((artifact) => artifact.kind === 'image') && mediaArtifacts.some((artifact) => artifact.kind === 'video')
  const showLibraryFilter = mediaArtifacts.some((artifact) => artifact.metadata?.savedToLibrary === true) && mediaArtifacts.some((artifact) => artifact.metadata?.savedToLibrary !== true)
  const showMediaFilters = tab === 'media' && mediaArtifacts.length > 0 && (showKindFilter || showLibraryFilter || modelOptions.length > 1)

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
        <h2>{shortLabel}</h2>
      </header>
      <div className="agent-result-panel__detail">
        {media ? <div className="agent-result-panel__hero">
          {preview.kind === 'image' ? <img src={preview.url} alt={shortLabel} /> : <video src={preview.url} controls playsInline />}
        </div> : <div className="agent-result-panel__document is-detail is-rich"><span>{preview.kind === 'workflow' ? '⌘' : 'Aa'}</span><AgentMarkdown content={preview.content ?? preview.label} showSources={false} /></div>}
        <p className="agent-result-panel__detail-meta">
          {agentArtifactKindLabel(preview, locale)}
          {modelLabel ? ` · ${modelLabel}` : ''}
          {locatableNodeId ? ` · ${copy.backfilled}` : ''}
        </p>
        <div className="agent-result-panel__detail-actions">
          {locatableNodeId ? <button type="button" onClick={() => onLocateNode(locatableNodeId)}>{copy.locateCanvas}</button> : null}
          {canContinue ? <button type="button" className="is-primary" onClick={() => onContinue(preview)}>{copy.continueEditing}</button> : null}
          {media ? <button type="button" disabled={preview.metadata?.savedToLibrary === true} onClick={() => onSaveArtifact(preview)}>{preview.metadata?.savedToLibrary === true ? copy.saved : copy.save}</button> : null}
          {media ? <button type="button" onClick={() => void downloadMedia(preview.url!, preview.label, preview.kind === 'video' ? 'video' : 'image')}>{copy.download}</button> : preview.url ? <a href={preview.url} target="_blank" rel="noreferrer">{copy.open}</a> : null}
        </div>
        {prompt ? <AgentResultPrompt prompt={prompt} /> : null}
      </div>
    </section>
  }

  return <section className="agent-result-panel" aria-label={copy.resultsAria}>
    <p className="visually-hidden" role="status">{selectedBatch.artifacts.length ? copy.selectedCount(selectedBatch.artifacts.length) : copy.itemCount(filteredArtifacts.length)}</p>
    {artifactIndexStatus === 'loading' ? <div className="agent-result-panel__index-status" role="status">{copy.readingIndex}</div> : null}
    {artifactIndexStatus === 'error' ? <div className="agent-result-panel__index-status is-warning" role="status">{copy.indexUnavailable}</div> : null}
    {latestFeedback ? <div className={`agent-result-panel__run-status is-${latestFeedback.tone}`} role="status"><strong>{latestFeedback.label}</strong><span>{latestFeedback.detail}</span></div> : null}
    <div className="agent-result-panel__toolbar">
      <div className="agent-result-panel__tabs" role="group" aria-label={copy.resultsSections}>
        <button type="button" aria-pressed={tab === 'media'} className={tab === 'media' ? 'is-active' : ''} onClick={() => openTab('media')}>{copy.mediaResults}<b>{mediaArtifacts.length}</b></button>
        <button type="button" aria-pressed={tab === 'tool'} className={tab === 'tool' ? 'is-active' : ''} onClick={() => openTab('tool')}>{copy.toolArtifacts}<b>{toolArtifacts.length}</b></button>
      </div>
      {showMediaFilters ? <div className="agent-result-panel__filters" role="group" aria-label={copy.resultFilter}>
        {showKindFilter ? <BotanicSelect
          className="agent-result-panel__kind-select"
          value={kindFilter}
          ariaLabel={copy.resultFilter}
          options={[{ value: 'all', label: copy.all }, { value: 'image', label: copy.images }, { value: 'video', label: copy.videos }]}
          onChange={(value) => setKindFilter(value as 'all' | 'image' | 'video')}
        /> : null}
        {showLibraryFilter ? <BotanicSelect
          className="agent-result-panel__library-select"
          value={libraryFilter}
          ariaLabel={copy.libraryFilter}
          options={[
            { value: 'all', label: copy.anyLibraryStatus },
            { value: 'unsaved', label: copy.unsaved },
            { value: 'saved', label: copy.saved },
          ]}
          onChange={(value) => setLibraryFilter(value as 'all' | 'saved' | 'unsaved')}
        /> : null}
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
    </div>
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
    <div className="agent-result-panel__groups" aria-busy={artifactIndexStatus === 'loading' || artifactIndexStatus === 'loading-more'}>
      {groups.map((group) => {
        const backfilled = group.artifacts.some((artifact) => artifact.provenance.sourceNodeIds?.some((nodeId) => availableNodeIds.has(nodeId)))
        return <section key={group.id} className="agent-result-group">
          <header>
            <span><h3>{group.label}</h3><small>{copy.itemCount(group.artifacts.length)}</small></span>
            <em>{backfilled ? copy.backfilled : copy.notBackfilled}</em>
            {conversationRunIds.includes(group.id) ? <button type="button" onClick={() => onLocateConversation(group.id)}>{copy.sourceConversation}</button> : null}
            <button type="button" onClick={() => toggleGroup(group.artifacts)}>{group.artifacts.every((artifact) => selectedIds.includes(artifact.id)) ? copy.clearSelection : copy.selectAll}</button>
          </header>
          <AgentAttachments variant="grid" className={`agent-result-panel__grid${tab === 'tool' ? ' is-documents' : ''}`}>
            {group.artifacts.map((artifact) => {
              const media = isMediaArtifact(artifact)
              const selected = selectedIds.includes(artifact.id)
              const shortLabel = artifactShortLabel(artifact, copy.generatedResult)
              return <AgentAttachment key={artifact.id} data={attachmentFromArtifact(artifact)} selected={selected} className="agent-result-panel__item">
                <button type="button" className="agent-result-panel__select" aria-pressed={selected} aria-label={`${selected ? copy.deselect : copy.select} ${shortLabel}`} title={selected ? copy.deselect : copy.select} onClick={() => toggleSelection(artifact.id)}>{selected ? '✓' : ''}</button>
                <button type="button" className="agent-result-panel__open" aria-label={`${copy.view} ${shortLabel}`} onClick={() => setPreviewId(artifact.id)}>
                  {media
                    ? <AgentAttachmentPreview />
                    : <span className="agent-result-panel__document"><span>{artifact.kind === 'workflow' ? '⌘' : 'Aa'}</span><b>{shortLabel}</b></span>}
                </button>
              </AgentAttachment>
            })}
          </AgentAttachments>
        </section>
      })}
      {!filteredArtifacts.length ? <div className="agent-panel__empty">{tab === 'tool' ? copy.noToolArtifacts : copy.noGeneratedResults}</div> : null}
      {artifactIndexHasMore ? <button type="button" className="agent-result-panel__load-more" disabled={artifactIndexStatus === 'loading-more'} onClick={() => void onLoadMoreArtifacts()}>{artifactIndexStatus === 'loading-more' ? copy.loading : copy.loadEarlierResults}</button> : null}
    </div>
  </section>
}

export function AgentMemoryPanel({ memory, sourceNodeIds, onAddMemory, onRemoveMemory, onLocateNode }: {
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
}) {
  const { locale } = useProductI18n()
  const copy = useProductMessages(agentUtilityMessages)
  const [kind, setKind] = useState<BotanicAgentMemoryKind>('rule')
  const [draft, setDraft] = useState('')
  const [subject, setSubject] = useState<BotanicAgentMemoryItem['subject']>('project')
  const [subjectValue, setSubjectValue] = useState('')
  const [kindFilter, setKindFilter] = useState<'all' | BotanicAgentMemoryKind>('all')
  const [subjectFilter, setSubjectFilter] = useState<'all' | NonNullable<BotanicAgentMemoryItem['subject']>>('all')
  const [formOpen, setFormOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const contentId = useId()
  const subjectValueId = useId()
  const contentRef = useRef<HTMLTextAreaElement | null>(null)
  const comparisonRows = useMemo(() => memoryComparisonRows(memory), [memory])
  const conflictCount = useMemo(() => memoryConflictPairs(memory).length, [memory])
  const filteredRows = useMemo(() => comparisonRows.filter((row) => {
    const item = memory.find((entry) => entry.id === row.id)
    if (!item) return false
    if (kindFilter !== 'all' && item.kind !== kindFilter) return false
    return subjectFilter === 'all' || (item.subject ?? 'project') === subjectFilter
  }), [comparisonRows, kindFilter, memory, subjectFilter])

  useEffect(() => {
    if (!formOpen) return
    const frame = requestAnimationFrame(() => contentRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [formOpen])

  const save = () => {
    if (!draft.trim()) return
    // 限定了范围却没填取值时不提交：那条规则永远匹配不上任何一次执行。
    if (subject !== 'project' && !subjectValue.trim()) return
    if (onAddMemory(kind, draft, sourceNodeIds, { subject, subjectValue: subjectValue.trim() })) {
      setDraft('')
      setSubjectValue('')
      setSubject('project')
      setFormOpen(false)
      setNotice(copy.memorySaved)
    }
  }

  return <section className="agent-memory-panel" aria-label={copy.memoryAria}>
    <p>{copy.memoryDescription}</p>
    {conflictCount ? <p className="agent-memory-panel__conflicts" role="alert">{copy.memoryConflicts(conflictCount)}</p> : null}
    <p className="visually-hidden" role="status">{notice}</p>
    <div className="agent-memory-panel__toolbar" aria-label={copy.memoryFilters}>
      <BotanicSelect value={kindFilter} ariaLabel={copy.memoryType} options={[
        { value: 'all', label: copy.all }, { value: 'rule', label: copy.longTermRule }, { value: 'approved', label: copy.approvedDirection }, { value: 'avoid', label: copy.avoid },
      ]} onChange={(value) => setKindFilter(value as 'all' | BotanicAgentMemoryKind)} />
      <BotanicSelect value={subjectFilter} ariaLabel={copy.memoryScope} options={[
        { value: 'all', label: copy.all }, ...MEMORY_SUBJECT_OPTIONS.map((option) => ({ value: option, label: memorySubjectLabel(option, locale) })),
      ]} onChange={(value) => setSubjectFilter(value as 'all' | NonNullable<BotanicAgentMemoryItem['subject']>)} />
      <button type="button" className="is-primary" aria-expanded={formOpen} onClick={() => setFormOpen((open) => !open)}><PlusIcon />{copy.addMemory}</button>
    </div>
    {formOpen ? <form className="agent-memory-panel__form" onSubmit={(event) => { event.preventDefault(); save() }}>
      <label htmlFor={contentId}><span>{copy.memoryContent}</span><textarea ref={contentRef} id={contentId} required value={draft} maxLength={500} onChange={(event) => setDraft(event.target.value)} placeholder={copy.memoryPlaceholder} /></label>
      <div className="agent-memory-panel__meta">
        <div className="agent-memory-panel__field"><span>{copy.memoryType}</span><BotanicSelect value={kind} ariaLabel={copy.memoryType} options={[
          { value: 'rule', label: copy.longTermRule }, { value: 'approved', label: copy.approvedDirection }, { value: 'avoid', label: copy.avoid },
        ]} onChange={(value) => setKind(value as BotanicAgentMemoryKind)} /></div>
        <div className="agent-memory-panel__field"><span>{copy.memoryScope}</span><BotanicSelect value={subject ?? 'project'} ariaLabel={copy.memoryScope} options={MEMORY_SUBJECT_OPTIONS.map((option) => ({ value: option, label: memorySubjectLabel(option, locale) }))} onChange={(value) => { setSubject(value as BotanicAgentMemoryItem['subject']); if (value === 'project') setSubjectValue('') }} /></div>
        {subject !== 'project' ? <label htmlFor={subjectValueId}><span>{copy.memoryScopeValue}</span><input id={subjectValueId} required value={subjectValue} maxLength={80} placeholder={copy.memoryScopeValuePlaceholder} onChange={(event) => setSubjectValue(event.target.value)} /></label> : null}
      </div>
      <div className="agent-memory-panel__form-actions"><button type="button" onClick={() => setFormOpen(false)}>{copy.cancelMemory}</button><button type="submit" className="is-primary">{copy.saveMemory}</button></div>
    </form> : null}
    <div className="agent-memory-panel__list">
      {filteredRows.map((row) => {
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
      {!filteredRows.length ? <div className="agent-panel__empty">{memory.length ? copy.noMemoryMatches : copy.noMemory}</div> : null}
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
export function BrandKitPanel({ projectId, onBindBrand }: {
  projectId: string
  onBindBrand: (brandId: string) => Promise<boolean>
}) {
  const { locale } = useProductI18n()
  const copy = useProductMessages(agentUtilityMessages)
  const [kit, setKit] = useState<ResolvedBrandKit | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [availableKits, setAvailableKits] = useState<Array<{ brandId: string; name?: string }>>([])
  const [libraryStatus, setLibraryStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [capabilities, setCapabilities] = useState<string[] | undefined>(() => cachedProjectCapabilities(projectId))
  const [selectedBrandId, setSelectedBrandId] = useState('')
  const [binding, setBinding] = useState(false)
  const [bindingError, setBindingError] = useState('')
  const [section, setSection] = useState<'effective' | 'pending' | 'overridden'>('effective')
  const bindingOperations = useMemo(() => createLatestOperation(), [])

  useEffect(() => {
    let active = true
    bindingOperations.invalidate()
    setStatus('loading')
    setCapabilities(cachedProjectCapabilities(projectId))
    setBinding(false)
    setBindingError('')
    fetchProjectBrandKit(projectId)
      .then((loaded) => {
        if (!active) return
        setKit(loaded.brandKit)
        setCapabilities(loaded.capabilities ?? cachedProjectCapabilities(projectId))
        setStatus('ready')
      })
      .catch(() => { if (active) setStatus('error') })
    return () => { active = false }
  }, [bindingOperations, projectId])

  useEffect(() => {
    if (status !== 'ready' || kit) return
    let active = true
    setLibraryStatus('loading')
    fetchBrandKitLibrary()
      .then((library) => {
        if (!active) return
        setAvailableKits(library?.kits ?? [])
        setLibraryStatus('ready')
      })
      .catch(() => { if (active) setLibraryStatus('error') })
    return () => { active = false }
  }, [kit, status])

  useEffect(() => {
    if (!availableKits.length) return
    setSelectedBrandId((current) => availableKits.some((candidate) => candidate.brandId === current)
      ? current
      : availableKits[0].brandId)
  }, [availableKits])

  const effective = useMemo(() => effectiveBrandRuleRows(kit ?? undefined, locale), [kit, locale])
  const overridden = useMemo(() => overriddenBrandRuleRows(kit ?? undefined, locale), [kit, locale])
  const proposals = useMemo(() => brandProposalRows(kit?.pending, locale), [kit, locale])
  const canBindBrand = canUseProjectEntry(capabilities, 'editCanvas', serverPersistenceEnabled)
  const bindBrand = async () => {
    if (!selectedBrandId || binding || kit) return
    const targetProjectId = projectId
    const operationToken = bindingOperations.begin()
    setBinding(true)
    setBindingError('')
    try {
      if (!await onBindBrand(selectedBrandId)) throw new Error('brand binding failed')
      const loaded = await fetchProjectBrandKit(targetProjectId)
      if (!bindingOperations.isCurrent(operationToken)) return
      if (!loaded.brandKit) throw new Error('brand binding was not resolved')
      setKit(loaded.brandKit)
      setCapabilities(loaded.capabilities ?? capabilities)
      setSection('effective')
    } catch {
      if (bindingOperations.isCurrent(operationToken)) setBindingError(copy.brandBindingFailed)
    } finally {
      if (bindingOperations.isCurrent(operationToken)) setBinding(false)
    }
  }

  return <section className="agent-brand-panel" aria-label={copy.brandAria} aria-busy={status === 'loading'}>
    <details className="agent-panel__about"><summary>{copy.brandAbout}</summary><p>{copy.brandDescription}</p></details>
    {status === 'loading' ? <div className="agent-panel__empty" role="status">{copy.brandLoading}</div> : null}
    {status === 'error' ? <div className="agent-panel__empty" role="alert">{copy.brandUnavailable}</div> : null}
    {/* 未绑定品牌与「绑定了但没有规则」是两回事；后者说得出「0 条生效」，前者要说没绑定。 */}
    {status === 'ready' && !kit ? <div className="agent-panel__empty">{copy.brandUnbound}</div> : null}
    {status === 'ready' && !kit && libraryStatus === 'loading' ? <div className="agent-panel__empty" role="status">{copy.brandLibraryLoading}</div> : null}
    {status === 'ready' && !kit && libraryStatus === 'error' ? <div className="agent-panel__empty" role="alert">{copy.brandLibraryUnavailable}</div> : null}
    {status === 'ready' && !kit && libraryStatus === 'ready' && !availableKits.length ? <div className="agent-panel__empty">{copy.brandLibraryEmpty}</div> : null}
    {status === 'ready' && !kit && availableKits.length && canBindBrand ? <div className="agent-brand-panel__binding">
      <BotanicSelect
        value={selectedBrandId}
        ariaLabel={copy.brandSelect}
        options={availableKits.map((candidate) => ({ value: candidate.brandId, label: candidate.name?.trim() || candidate.brandId }))}
        onChange={setSelectedBrandId}
        disabled={binding}
      />
      <button type="button" disabled={binding || !selectedBrandId} onClick={() => void bindBrand()}>{binding ? copy.brandBinding : copy.brandBind}</button>
    </div> : null}
    {status === 'ready' && !kit && availableKits.length && !canBindBrand ? <div className="agent-panel__empty">{copy.brandReadOnly}</div> : null}
    {bindingError ? <p className="agent-brand-panel__binding-error" role="alert">{bindingError}</p> : null}
    {status === 'ready' && kit ? <>
      <p className="agent-brand-panel__summary">{brandKitSummary(kit, locale)}</p>
      <div className="agent-brand-panel__tabs" aria-label={copy.brandSections}>
        {([
          ['effective', copy.brandEffective, effective.length], ['pending', copy.brandPending, proposals.length], ['overridden', copy.brandOverridden, overridden.length],
        ] as const).map(([value, label, count]) => <button key={value} type="button" aria-pressed={section === value} onClick={() => setSection(value)}><span>{label}</span><b>{count}</b></button>)}
      </div>
      {section === 'effective' ? <ul className="agent-brand-panel__rules">
        {effective.map((row) => <li key={row.slot} className={`is-${row.enforcement}`}>
          <header><small>{row.facetLabel}</small><b>{row.enforcementLabel}</b></header>
          <p>{row.statement}</p>
          <small className="agent-brand-panel__provenance">{row.provenance}</small>
        </li>)}
        {!effective.length ? <li className="agent-panel__empty">{copy.brandEmptySection}</li> : null}
      </ul> : null}
      {section === 'pending' ? <ul className="agent-brand-panel__proposals">
          {proposals.map((proposal) => <li key={proposal.id} className={proposal.needsFacet ? 'needs-facet' : ''}>
            <header><small>{proposal.facetLabel}</small></header>
            <p>{proposal.statement}</p>
            {/* 建议看起来和真规则一模一样，因此每条都要写明它当前不生效。 */}
            <small className="agent-brand-panel__hint">{proposal.hint}</small>
            {proposal.sourceRef ? <small>{copy.brandSourceRef(proposal.sourceRef)}</small> : null}
          </li>)}
          {!proposals.length ? <li className="agent-panel__empty">{copy.brandEmptySection}</li> : null}
      </ul> : null}
      {section === 'overridden' ? <ul className="agent-brand-panel__rules is-overridden">
          {overridden.map((row) => <li key={row.id}>
            <header><small>{row.facetLabel}</small></header>
            <p>{row.statement}</p>
            <small className="agent-brand-panel__provenance">{row.provenance}</small>
          </li>)}
          {!overridden.length ? <li className="agent-panel__empty">{copy.brandEmptySection}</li> : null}
      </ul> : null}
    </> : null}
  </section>
}

export function AgentReviewPanel({ runId, projectId }: {
  runId: string
  projectId?: string
}) {
  const { locale } = useProductI18n()
  const copy = useProductMessages(agentUtilityMessages)
  const [tasks, setTasks] = useState<AgentReviewTaskSnapshot[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [reloadEpoch, setReloadEpoch] = useState(0)
  const [pending, setPending] = useState('')
  const [notice, setNotice] = useState('')
  const [noticeTone, setNoticeTone] = useState<'status' | 'error'>('status')
  // 接受/拒绝只改评审状态；请求重试会创建生成 Run，分别对齐服务端两个能力。
  const canDecide = canUseProjectEntry(
    projectId ? cachedProjectCapabilities(projectId) : undefined,
    'decideReview',
    serverPersistenceEnabled,
  )
  const canRetry = canUseProjectEntry(
    projectId ? cachedProjectCapabilities(projectId) : undefined,
    'retryReview',
    serverPersistenceEnabled,
  )

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    setStatus('loading')
    const load = () => fetchAgentReviewTasks(runId)
      .then((loaded) => {
        if (!active) return
        setTasks(loaded)
        setStatus('ready')
        if (loaded.some((task) => ['queued', 'running', 'cancelling'].includes(task.status))) {
          timer = setTimeout(load, 2_500)
        }
      })
      .catch(() => { if (active) setStatus('error') })
    void load()
    return () => { active = false; if (timer) clearTimeout(timer) }
  }, [reloadEpoch, runId])

  const decide = async (taskId: string, artifactId: string, decision: AgentReviewDecision) => {
    setPending(`${taskId}:${artifactId}`)
    setNotice('')
    setNoticeTone('status')
    try {
      const result = await submitAgentReviewDecisions(taskId, [{ artifactId, decision }])
      setTasks((current) => current.map((task) => (task.id === taskId ? result.task : task)))
      // 请求重试会产生新的 Run；照实说明原结果没有被覆盖。
      if (result.retryRuns?.length) setNotice(copy.reviewRetryCreated(result.retryRuns.length))
    } catch {
      setNoticeTone('error')
      setNotice(copy.reviewDecisionFailed)
    } finally {
      setPending('')
    }
  }

  const cancelReview = async (taskId: string) => {
    setPending(`${taskId}:cancel`)
    setNotice('')
    setNoticeTone('status')
    try {
      const result = await cancelAgentReviewTask(taskId)
      setTasks((current) => current.map((task) => (task.id === taskId ? result.task : task)))
    } catch {
      setNoticeTone('error')
      setNotice(copy.reviewCancelFailed)
    } finally {
      setPending('')
    }
  }

  const reconcile = async (taskId: string, action: 'continue_unverifiable' | 'retry_once') => {
    setPending(`${taskId}:${action}`)
    setNotice('')
    setNoticeTone('status')
    try {
      const result = await reconcileAgentReviewOutcome(taskId, action)
      setTasks((current) => current.map((task) => (task.id === taskId ? result.task : task)))
      setNotice(copy.reviewReconciliationAccepted)
    } catch {
      setNoticeTone('error')
      setNotice(copy.reviewReconciliationFailed)
    } finally {
      setPending('')
    }
  }

  return <section className="agent-review-panel" aria-label={copy.reviewAria} aria-busy={status === 'loading'}>
    <p>{copy.reviewDescription}</p>
    {status === 'loading' ? <div className="agent-panel__empty" role="status">{copy.reviewLoading}</div> : null}
    {status === 'error' ? <div className="agent-panel__empty" role="alert">{copy.reviewUnavailable} <button type="button" onClick={() => setReloadEpoch((value) => value + 1)}>{locale === 'en' ? 'Retry' : '重试'}</button></div> : null}
    {status === 'ready' && !tasks.length ? <div className="agent-panel__empty">{copy.noReviewTasks}</div> : null}
    <p className={`agent-review-panel__notice is-${noticeTone}${notice ? '' : ' visually-hidden'}`} role={noticeTone === 'error' ? 'alert' : 'status'}>{notice}</p>
    {tasks.map((task) => {
      const statusNote = agentReviewTaskStatusNote(task, locale)
      const rows = agentReviewCandidateRows(task, locale)
      return <article key={task.id} className="agent-review-panel__task">
        <p className="agent-review-panel__coverage">{agentReviewCoverageSummary(task, locale)}</p>
        {statusNote ? <p className="agent-review-panel__status">{statusNote}</p> : null}
        {canDecide && ['queued', 'running'].includes(task.status) ? <button
          type="button"
          disabled={pending === `${task.id}:cancel`}
          onClick={() => void cancelReview(task.id)}
        >
          {pending === `${task.id}:cancel` ? copy.reviewCancelling : copy.reviewCancel}
        </button> : null}
        {agentReviewRequiresReconciliation(task) ? <div className="agent-review-panel__reconciliation">
          {canDecide ? <button
            type="button"
            disabled={Boolean(pending)}
            onClick={() => void reconcile(task.id, 'continue_unverifiable')}
          >{copy.reviewContinueUnverifiable}</button> : null}
          {canRetry ? <button
            type="button"
            disabled={Boolean(pending)}
            onClick={() => void reconcile(task.id, 'retry_once')}
          >{copy.reviewRetryOnce}</button> : null}
          {!canDecide && !canRetry ? <small className="agent-review-panel__readonly">{copy.reviewReadOnly}</small> : null}
        </div> : null}
        {/* 自定义判据的成本必须在这里就说清楚：评审完再说已经晚了，钱已经花掉。 */}
        {agentReviewEvaluatorCostNote(task, locale)
          ? <p className="agent-review-panel__cost">{agentReviewEvaluatorCostNote(task, locale)}</p>
          : null}
        {rows.map((row) => <div key={row.artifactId} className={`agent-review-panel__candidate is-${row.verdict}`}>
          <header>
            <strong>{copy.reviewCandidate(row.artifactId.split(':').at(-1) ?? row.artifactId)}</strong>
            <span className={`agent-review-panel__verdict is-${row.verdict}`}>{row.verdictLabel}</span>
            {row.unverifiedCount ? <small>{copy.reviewUnverified(row.unverifiedCount)}</small> : null}
          </header>
          <details className="agent-review-panel__details" open={row.awaitingHuman || undefined}>
            <summary>{copy.reviewDetails(row.criteria.length)}</summary>
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
            {row.revisionSuggestion ? <p className="agent-review-panel__revision"><small>{copy.reviewRevision}</small>{row.revisionSuggestion}</p> : null}
          </details>
          <footer>
            {row.awaitingHuman ? <small>{copy.reviewAwaiting}</small> : <small>{row.decisionLabel}</small>}
            <div>
              {canDecide ? (['accepted', 'rejected'] as const).map((decision) => <button
                key={decision}
                type="button"
                className={row.decision === decision ? 'is-active' : undefined}
                disabled={pending === `${task.id}:${row.artifactId}`}
                onClick={() => void decide(task.id, row.artifactId, decision)}
              >
                {decision === 'accepted' ? copy.reviewAccept : copy.reviewReject}
              </button>) : null}
              {canRetry ? <button
                type="button"
                className={row.decision === 'retry_requested' ? 'is-active' : undefined}
                disabled={pending === `${task.id}:${row.artifactId}`}
                onClick={() => void decide(task.id, row.artifactId, 'retry_requested')}
              >
                {copy.reviewRetry}
              </button> : null}
              {!canDecide && !canRetry ? <small className="agent-review-panel__readonly">{copy.reviewReadOnly}</small> : null}
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
  mountDisabled = false,
  onToggle,
  onToggleMount,
}: {
  id: string
  name: string
  instructions: string
  source: 'system' | 'project'
  expanded: boolean
  mounted?: boolean
  mountDisabled?: boolean
  onToggle: (id: string) => void
  onToggleMount?: (id: string, nextMounted: boolean) => void
}) {
  const copy = useProductMessages(agentUtilityMessages)
  const summary = botanicAgentSkillSummary(instructions)
  const body = botanicAgentSkillBody(instructions)
  return <article className={`agent-skill-card${expanded ? ' is-expanded' : ''}${mounted ? ' is-mounted' : ''}`}>
    <button type="button" className="agent-skill-card__toggle" aria-expanded={expanded} aria-controls={`skill-body-${id}`} onClick={() => onToggle(id)}>
      <span className="agent-skill-card__content">
        <span className="agent-skill-card__title">
          {source === 'system' ? <SparkleIcon /> : null}
          <b>{name}</b>
        </span>
        <span className="agent-skill-card__meta">
          <small>{source === 'system' ? copy.system : copy.project}</small>
          <small className={mounted ? 'is-mounted' : undefined}>{mounted ? copy.mounted : copy.invoke}</small>
        </span>
        {!expanded && summary ? <p>{summary}</p> : null}
      </span>
      <span className="agent-skill-card__disclosure" aria-hidden="true">{expanded ? '−' : '＋'}</span>
    </button>
    {onToggleMount ? <button type="button" className="agent-skill-card__mount" disabled={mountDisabled} aria-pressed={mounted} aria-label={mounted ? `${copy.unmount} ${name}` : `${copy.mount} ${name}`} onClick={() => onToggleMount(id, !mounted)}>
      {mounted ? <CheckIcon /> : <PlusIcon />}<span>{mounted ? copy.unmount : copy.mount}</span>
    </button> : null}
    {expanded ? <pre id={`skill-body-${id}`} className="agent-skill-card__body">{body}</pre> : null}
  </article>
}
