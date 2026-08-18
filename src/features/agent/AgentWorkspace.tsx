import { type DragEvent, useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from 'react'
import {
  botanicAgentBranchStatusLabel,
  botanicAgentContextSnapshotNodeIds,
  botanicAgentSubmissionKey,
  buildBotanicAgentRunTimeline,
  buildBotanicAgentSessionTimeline,
  filterBotanicAgentSessionTimeline,
  filterBotanicAgentRunTimeline,
  buildBotanicAgentPlan,
  createBotanicAgentContextSnapshot,
  insertBotanicAgentMention,
  readBotanicAgentMentionQuery,
  summarizeBotanicAgentRuntime,
  type BotanicAgentActionProposal,
  type BotanicAgentActionResult,
  type BotanicAgentArtifact,
  type BotanicAgentClarificationResponse,
  type BotanicAgentExecutionMode,
  type BotanicAgentIntent,
  type BotanicAgentMemoryItem,
  type BotanicAgentMemoryKind,
  type BotanicAgentMentionQuery,
  type BotanicAgentMessage,
  type BotanicAgentPlan,
  type BotanicAgentRun,
  type BotanicAgentRunTimelineFilter,
  type BotanicAgentSession,
  type BotanicAgentSessionTimelineFilter,
  type BotanicAgentSkill,
  type BotanicAgentSkillCatalogItem,
} from '../../domain/agent'
import {
  decideBotanicAgentRequest,
  inferBotanicAgentGenerationSettings,
  isBotanicAgentPromptGenerationPending,
  resolveBotanicAgentGenerationPromptDecision,
} from '../../domain/agentChatContract'
import { nextExclusiveSurface, type ExclusiveSurfaceAction } from '../../domain/exclusiveSurface'
import type { CollaborationActivity, CollaborationDocumentChange } from '../../domain/collaborationActivity'
import type {
  AssetGroup,
  GenerationModelOption,
  GenerationSettings,
  UploadedAssetInput,
} from '../../domain/canvas'
import { createProjectAgentSkill, listBotanicAgentSystemSkills, listProjectAgentSkills, requestBotanicAgentChat, requestBotanicAgentPlan } from '../../lib/agentApi'
import { ProductApiError, serverPersistenceEnabled } from '../../lib/productSession'
import { maxUploadAssets, readUploadedAssetInput, validateUploadFiles } from '../../lib/uploadedAssets'
import { useCanvasStore } from '../../store/canvasStore'
import { BotanicSelect } from '../../components/BotanicSelect'
import { AgentPlannerProviderIcon } from '../../components/AgentPlannerProviderIcon'
import {
  agentPlannerModelLabel,
  defaultAgentPlannerModels,
  modelDisplayLabel,
} from '../../components/generationModelPresentation'
import {
  AgentFailureRecoveryActions,
  AgentBranchStatusIcon,
  agentRunFeedback,
  agentRunOutputCount,
  agentRuntimeStepMarker,
  agentRuntimeStepStatusLabel,
  createInitialAgentClarification,
} from './AgentWorkspaceParts'
import {
  agentComposerStateReducer,
  initialAgentComposerState,
  type AgentFailedInstruction,
  type AgentInstructionRetryOptions,
} from './agentComposerState'
import { useAgentMessageDelivery } from './useAgentMessageDelivery'
import { useAgentRuntimeTrace } from './useAgentRuntimeTrace'
import type { AgentArtifactIndexState, AgentContextItem, AgentDockTarget, AgentSkillOption } from './agentWorkspace.types'
import { AgentCollaborationPanel, AgentMemoryPanel, AgentResultPanel } from './AgentUtilityPanels'
import { AgentConversationMessage } from './AgentConversationMessage'
import { AgentComposer } from './AgentComposer'
import {
  AlertIcon,
  BookmarkIcon,
  CheckIcon,
  ChecklistIcon,
  ClockIcon,
  CloseIcon,
  FigmaIcon,
  FocusIcon,
  GalleryIcon,
  EditIcon,
  PlusSquareIcon,
  SparkleIcon,
  UploadIcon,
} from '../../components/BotanicIcons'
import historyIcon from '../../assets/figma/icon-history.svg'

type AgentTransientSurface = 'context' | 'history' | 'utility' | 'mode'
type AgentUtilityPanel = 'result' | 'task' | 'memory' | 'skill' | 'collaboration'
type AgentRunInstructionOptions = AgentInstructionRetryOptions & { appendUser?: string }

function agentTargetDisplayLabel(target?: AgentDockTarget) {
  if (!target) return ''
  const primaryReference = target.rootRecipe.references.find((reference) => reference.primary)
    ?? target.rootRecipe.references[0]
  const referenceName = primaryReference?.name?.trim()
  if (referenceName) return referenceName
  return target.label.trim().replace(/^@+/, '').replace(/\s+\+\d+\b.*$/u, '')
}

function agentTimelineTimestamp(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(timestamp))
}

const agentQuickActions: Array<{ intent: BotanicAgentIntent; label: string; instruction: string }> = [
  { intent: 'replace_scene', label: '换场景', instruction: '保持人物、服装和商品不变，只替换场景与环境光线。' },
  { intent: 'change_pose', label: '换动作', instruction: '保持人物、服装、商品和场景不变，调整动作姿势与构图。' },
  { intent: 'change_style', label: '换风格', instruction: '保持人物、服装、商品、场景和动作不变，调整视觉风格与光线。' },
  { intent: 'replace_person', label: '换模特', instruction: '保持服装、商品、场景和风格不变，替换模特。' },
  { intent: 'replace_product', label: '换商品', instruction: '保持人物、场景和风格不变，替换服装或商品。' },
  { intent: 'redo_from_root', label: '原配方重做', instruction: '复用原始参考素材、提示词和参数，重新生成独立首图。' },
]

function agentGroupRole(intent: BotanicAgentIntent): AssetGroup['role'] | null {
  if (intent === 'replace_scene') return '场景'
  if (intent === 'replace_person') return '模特'
  if (intent === 'replace_product') return '商品'
  if (intent === 'change_style') return '调性'
  return null
}

function AgentRunActionIcon({ label }: { label: string }) {
  if (label.includes('结果')) return <GalleryIcon />
  if (label.includes('失败')) return <AlertIcon />
  return <ChecklistIcon />
}

function AgentTaskFilterIcon({ value }: { value: 'all' | 'active' | 'completed' | 'attention' }) {
  if (value === 'completed') return <CheckIcon />
  if (value === 'attention') return <AlertIcon />
  if (value === 'active') return <ClockIcon />
  return <ChecklistIcon />
}


export default function AgentWorkspace({
  projectId,
  escapeEnabled,
  target,
  groups,
  sessions,
  session,
  contextOptions,
  memory,
  artifacts,
  artifactIndexStatus,
  artifactIndexHasMore,
  latestRun,
  runs,
  plannerModels,
  generationModels,
  onConfirm,
  onConfirmAction,
  onUploadImages,
  onAppendMessage,
  onUpdateMessage,
  onUpdateAction,
  onContextChange,
  onExecutionModeChange,
  onPlannerModelChange,
  onSkillsChange,
  onRenameSession,
  onAddMemory,
  onRemoveMemory,
  onNewSession,
  onSelectSession,
  onUpdateReadingAnchor,
  onRetryBranch,
  onCancelRun,
  onLocateNode,
  onFocusNodes,
  onSaveArtifact,
  onContinueArtifact,
  onLoadMoreArtifacts,
  onUseResultContext,
  onRetryPersistence,
  onRefreshRemote,
  collaborationAwareness,
  onDismissRemoteChange,
  onClearCollaborationActivities,
  onLoadMoreCollaborationActivities,
  onReloadCollaborationActivities,
  persistenceStatus,
  onClose,
}: {
  projectId: string
  escapeEnabled: boolean
  persistenceStatus: 'saved' | 'saving' | 'offline' | 'conflict' | 'error'
  collaborationAwareness: {
    onlineCollaboratorCount: number
    activities: CollaborationActivity[]
    unreadActivityCount: number
    conflictChanges: CollaborationDocumentChange[]
    historyStatus: 'idle' | 'loading' | 'loading-more' | 'saving' | 'error'
    historyHasMore: boolean
    historyErrorAction?: 'load' | 'load-more' | 'read' | 'clear'
  }
  target?: AgentDockTarget
  groups: AssetGroup[]
  sessions: BotanicAgentSession[]
  session?: BotanicAgentSession
  contextOptions: AgentContextItem[]
  memory: BotanicAgentMemoryItem[]
  artifacts: BotanicAgentArtifact[]
  artifactIndexStatus: AgentArtifactIndexState['status']
  artifactIndexHasMore: boolean
  latestRun?: BotanicAgentRun
  runs: BotanicAgentRun[]
  plannerModels: string[]
  generationModels: GenerationModelOption[]
  onConfirm: (plan: BotanicAgentPlan, submissionKey?: string) => Promise<{ started: boolean; runId: string }>
  onConfirmAction: (action: BotanicAgentActionProposal) => Promise<BotanicAgentActionResult>
  onUploadImages: (uploads: UploadedAssetInput[]) => void
  onAppendMessage: (sessionId: string, message: BotanicAgentMessage) => void
  onUpdateMessage: (sessionId: string, messageId: string, patch: Partial<Pick<BotanicAgentMessage, 'content' | 'runId' | 'status' | 'feedback' | 'plan' | 'question' | 'deliveryStatus'>>) => void
  onUpdateAction: (sessionId: string, messageId: string, actionId: string, patch: Partial<Pick<BotanicAgentActionProposal, 'status' | 'error' | 'result'>>) => void
  onContextChange: (sessionId: string, contextNodeIds: string[]) => void
  onExecutionModeChange: (sessionId: string, mode: BotanicAgentExecutionMode) => void
  onPlannerModelChange: (sessionId: string, model: string) => void
  onSkillsChange: (sessionId: string, skillIds: string[]) => void
  onRenameSession: (sessionId: string, title: string) => void
  onAddMemory: (kind: BotanicAgentMemoryKind, content: string, sourceNodeIds?: string[]) => string | null
  onRemoveMemory: (memoryId: string) => void
  onNewSession: () => string
  onSelectSession: (sessionId: string) => void
  onUpdateReadingAnchor: (sessionId: string, messageId: string) => void
  onRetryBranch: (runId: string, branchId: string) => Promise<boolean>
  onCancelRun: (runId: string) => Promise<boolean>
  onLocateNode: (nodeId: string) => void
  onFocusNodes: (nodeIds: string[]) => void
  onSaveArtifact: (artifact: BotanicAgentArtifact) => void
  onContinueArtifact: (artifact: BotanicAgentArtifact) => void
  onLoadMoreArtifacts: () => Promise<void>
  onUseResultContext: (sourceNodeIds: string[]) => void
  onRetryPersistence: () => Promise<boolean>
  onRefreshRemote: () => Promise<boolean>
  onDismissRemoteChange: () => Promise<void>
  onClearCollaborationActivities: () => Promise<void>
  onLoadMoreCollaborationActivities: () => Promise<void>
  onReloadCollaborationActivities: () => Promise<void>
  onClose: () => void
}) {
  const [intent, setIntent] = useState<BotanicAgentIntent>('replace_scene')
  const [groupId, setGroupId] = useState('')
  const plannerModel = plannerModels.includes(session?.plannerModel ?? '')
    ? session!.plannerModel!
    : plannerModels[0] ?? defaultAgentPlannerModels[0]
  const [composerState, updateComposerState] = useReducer(agentComposerStateReducer, initialAgentComposerState)
  const { instruction, error, lastFailedInstruction, lastFailedCommand, lastFailedPlanMessageId, mentionQuery, pendingGenerationOverrides } = composerState
  const setInstruction = useCallback((value: string) => updateComposerState({ instruction: value }), [])
  const setError = useCallback((value: string) => updateComposerState({ error: value }), [])
  const setLastFailedInstruction = useCallback((value: string) => updateComposerState({
    lastFailedInstruction: value,
    ...(!value ? { lastFailedCommand: undefined } : {}),
  }), [])
  const setLastFailedPlanMessageId = useCallback((value: string) => updateComposerState({ lastFailedPlanMessageId: value }), [])
  const setMentionQuery = useCallback((value?: BotanicAgentMentionQuery) => updateComposerState({ mentionQuery: value }), [])
  const setPendingGenerationOverrides = useCallback((value: Partial<Pick<GenerationSettings, 'model' | 'aspectRatio' | 'resolution'>>) => updateComposerState({ pendingGenerationOverrides: value }), [])
  const rememberFailedInstruction = useCallback((command: AgentFailedInstruction) => updateComposerState({
    lastFailedInstruction: command.instruction,
    lastFailedCommand: command,
  }), [])
  const [planning, setPlanning] = useState(false)
  const [submittingMessageId, setSubmittingMessageId] = useState('')
  const [executingActionId, setExecutingActionId] = useState('')
  const [retryingBranchId, setRetryingBranchId] = useState('')
  const [cancellingRunId, setCancellingRunId] = useState('')
  const [activeTransientSurface, setActiveTransientSurface] = useState<AgentTransientSurface | null>(null)
  const setTransientSurfaceOpen = useCallback((surface: AgentTransientSurface, action: ExclusiveSurfaceAction) => {
    setActiveTransientSurface((current) => nextExclusiveSurface(current, surface, action))
  }, [])
  const contextMenuOpen = activeTransientSurface === 'context'
  const historyOpen = activeTransientSurface === 'history'
  const utilityMenuOpen = activeTransientSurface === 'utility'
  const modeMenuOpen = activeTransientSurface === 'mode'
  const setContextMenuOpen = useCallback((action: ExclusiveSurfaceAction) => setTransientSurfaceOpen('context', action), [setTransientSurfaceOpen])
  const setHistoryOpen = useCallback((action: ExclusiveSurfaceAction) => setTransientSurfaceOpen('history', action), [setTransientSurfaceOpen])
  const setUtilityMenuOpen = useCallback((action: ExclusiveSurfaceAction) => setTransientSurfaceOpen('utility', action), [setTransientSurfaceOpen])
  const setModeMenuOpen = useCallback((action: ExclusiveSurfaceAction) => setTransientSurfaceOpen('mode', action), [setTransientSurfaceOpen])
  const [isImageDropActive, setIsImageDropActive] = useState(false)
  const [activeUtilityPanel, setActiveUtilityPanel] = useState<AgentUtilityPanel | null>(null)
  const [taskStatusFilter, setTaskStatusFilter] = useState<BotanicAgentRunTimelineFilter>('all')
  const [historyQuery, setHistoryQuery] = useState('')
  const [historyFilter, setHistoryFilter] = useState<BotanicAgentSessionTimelineFilter>('all')
  const [readingRestoreNotice, setReadingRestoreNotice] = useState(false)
  const [focusedTaskRunId, setFocusedTaskRunId] = useState('')
  const skillPanelOpen = activeUtilityPanel === 'skill'
  const taskPanelOpen = activeUtilityPanel === 'task'
  const resultPanelOpen = activeUtilityPanel === 'result'
  const memoryPanelOpen = activeUtilityPanel === 'memory'
  const collaborationPanelOpen = activeUtilityPanel === 'collaboration'
  const [skills, setSkills] = useState<BotanicAgentSkill[]>([])
  const [systemSkills, setSystemSkills] = useState<BotanicAgentSkillCatalogItem[]>([])
  const [skillName, setSkillName] = useState('')
  const [skillInstructions, setSkillInstructions] = useState('')
  const [skillFormOpen, setSkillFormOpen] = useState(false)
  const [skillConfirming, setSkillConfirming] = useState(false)
  const [skillSaving, setSkillSaving] = useState(false)
  const [skillError, setSkillError] = useState('')
  const [renamingSession, setRenamingSession] = useState(false)
  const [sessionTitleDraft, setSessionTitleDraft] = useState(session?.title ?? '新建对话')
  const [persistenceAction, setPersistenceAction] = useState<'retry' | 'refresh' | ''>('')
  const [promptDrafts, setPromptDrafts] = useState<Record<string, string>>({})
  const [recoveryModelMenuKey, setRecoveryModelMenuKey] = useState('')
  const plannerControllerRef = useRef<AbortController | null>(null)
  const agentMountedRef = useRef(true)
  const isCurrentAgentProject = useCallback(
    () => agentMountedRef.current && useCanvasStore.getState().document.id === projectId,
    [projectId],
  )
  const { appendMessage, retryMessage } = useAgentMessageDelivery({
    projectId,
    session,
    isCurrentProject: isCurrentAgentProject,
    onAppendMessage,
    onUpdateMessage,
  })
  const sendingInstructionRef = useRef(false)
  const submittingMessageIdRef = useRef('')
  // 终态同时记住产出数：服务端可能先标记完成、随后才持久化 Artifact，
  // 这样结果回填后会更新同一条消息，而不会重复刷屏。
  const runNoticeStatusRef = useRef(new Map<string, string>())
  const focusedRunIdsRef = useRef(new Set<string>())
  const messageEndRef = useRef<HTMLDivElement | null>(null)
  const messagesViewportRef = useRef<HTMLDivElement | null>(null)
  const messageNodesRef = useRef(new Map<string, HTMLDivElement>())
  const taskNodesRef = useRef(new Map<string, HTMLElement>())
  const readingAnchorTimerRef = useRef<number | null>(null)
  const readingPositionRestoredRef = useRef(false)
  const followLatestMessagesRef = useRef(true)
  const lastReadingAnchorRef = useRef(session?.readingAnchorMessageId ?? '')
  const locatedMessageTimerRef = useRef<number | null>(null)
  const [locatedMessageId, setLocatedMessageId] = useState('')
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const agentFileInputRef = useRef<HTMLInputElement | null>(null)
  const historyTriggerRef = useRef<HTMLButtonElement | null>(null)
  const utilityMenuButtonRef = useRef<HTMLButtonElement | null>(null)
  const utilityMenuRef = useRef<HTMLDivElement | null>(null)
  const contextMenuButtonRef = useRef<HTMLButtonElement | null>(null)
  const modeMenuButtonRef = useRef<HTMLButtonElement | null>(null)
  const utilityButtonRef = useRef<HTMLButtonElement | null>(null)
  const skillCreateButtonRef = useRef<HTMLButtonElement | null>(null)
  const historyMenuId = useId()
  const utilityMenuId = useId()
  const contextMenuId = useId()
  const modeMenuId = useId()
  const runtimeStepsId = useId()
  const compatibleGroups = groups.filter((group) => group.role === agentGroupRole(intent) && group.assetIds.length)
  const contextItems = contextOptions.filter((item) => session?.contextNodeIds.includes(item.id))
  const imageContextOptions = contextOptions.filter((item) => (
    (item.kind === '素材' || item.kind === '结果')
    && Boolean(item.image)
    && (item.mediaKind ?? 'image') === 'image'
  ))
  const hasMessages = Boolean(session?.messages.length)
  const conversationMessages = useMemo(() => {
    const messages = session?.messages ?? []
    const latestStatusMessageByRun = new Map<string, string>()
    for (const message of messages) {
      if (message.runId && (message.kind === 'run' || message.kind === 'notice')) {
        latestStatusMessageByRun.set(message.runId, message.id)
      }
    }
    return messages.filter((message) => (
      !message.runId
      || (message.kind !== 'run' && message.kind !== 'notice')
      || latestStatusMessageByRun.get(message.runId) === message.id
    ))
  }, [session?.messages])
  const pendingPromptSourceIds = useMemo(() => new Set((session?.messages ?? [])
    .filter((message) => message.question?.sourcePromptMessageId && message.kind === 'question' && message.status === 'pending')
    .map((message) => message.question!.sourcePromptMessageId!)), [session?.messages])
  const mentionOptions = useMemo(() => {
    if (!mentionQuery) return []
    const query = mentionQuery.query.trim().toLocaleLowerCase()
    return contextOptions
      .filter((item) => item.kind === '素材' && Boolean(item.image))
      .filter((item) => !query || item.label.toLocaleLowerCase().includes(query))
      .slice(0, 6)
  }, [contextOptions, mentionQuery])
  const skillOptions = useMemo<AgentSkillOption[]>(() => {
    if (!mentionQuery) return []
    const query = mentionQuery.query.trim().toLocaleLowerCase()
    return [...systemSkills, ...skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      instructions: skill.instructions,
      source: 'project' as const,
    }))]
      .filter((skill, index, items) => items.findIndex((candidate) => candidate.id === skill.id) === index)
      .filter((skill) => !query || skill.name.toLocaleLowerCase().includes(query) || skill.id.toLocaleLowerCase().includes(query))
      .slice(0, 8)
      .map(({ id, name, source }) => ({ id, name, source }))
  }, [mentionQuery, skills, systemSkills])
  const mountedSkillOptions = useMemo<AgentSkillOption[]>(() => {
    const mountedIds = new Set(session?.mountedSkillIds ?? [])
    return [...systemSkills, ...skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      instructions: skill.instructions,
      source: 'project' as const,
    }))]
      .filter((skill, index, items) => mountedIds.has(skill.id) && items.findIndex((candidate) => candidate.id === skill.id) === index)
      .map(({ id, name, source }) => ({ id, name, source }))
  }, [session?.mountedSkillIds, skills, systemSkills])
  const utilityPanelOpen = taskPanelOpen || skillPanelOpen || resultPanelOpen || memoryPanelOpen || collaborationPanelOpen
  const {
    runtimeSteps,
    runtimePhase,
    runtimeDetailsOpen,
    setRuntimePhase,
    setRuntimeDetailsOpen,
    beginRuntimeTrace,
    updateRuntimeStep,
    attachPlannerToolTrace,
    yieldRuntimeFrame,
    completeRuntimeContextReads,
    completeRuntimeTrace,
    failRuntimeTrace,
  } = useAgentRuntimeTrace({
    latestRun,
    planning,
    hasSession: Boolean(session),
    hasTarget: Boolean(target),
    referenceCount: target?.rootRecipe.references.length ?? contextItems.length,
    memoryCount: memory.length,
    assetGroupCount: compatibleGroups.length,
    plannerLabel: agentPlannerModelLabel(plannerModel),
  })
  const runtimeSummary = useMemo(
    () => summarizeBotanicAgentRuntime({ steps: runtimeSteps, phase: runtimePhase }),
    [runtimePhase, runtimeSteps],
  )
  const runtimeFailed = runtimePhase === 'failed' || runtimeSteps.some((step) => step.status === 'failed')
  const runtimeComplete = runtimePhase === 'completed'
  const availableCanvasNodeIds = useMemo(() => new Set(contextOptions.map((item) => item.id)), [contextOptions])
  const latestRunFeedback = latestRun ? agentRunFeedback(latestRun, artifacts, availableCanvasNodeIds) : undefined
  const runTimeline = useMemo(() => buildBotanicAgentRunTimeline(runs, sessions), [runs, sessions])
  const filteredRunTimeline = useMemo(
    () => filterBotanicAgentRunTimeline(runTimeline, taskStatusFilter),
    [runTimeline, taskStatusFilter],
  )
  const taskFilterCounts = useMemo(() => ({
    all: runTimeline.length,
    active: filterBotanicAgentRunTimeline(runTimeline, 'active').length,
    completed: filterBotanicAgentRunTimeline(runTimeline, 'completed').length,
    attention: filterBotanicAgentRunTimeline(runTimeline, 'attention').length,
  }), [runTimeline])
  const sessionTimeline = useMemo(() => buildBotanicAgentSessionTimeline(sessions, runs), [runs, sessions])
  const filteredSessionTimeline = useMemo(
    () => filterBotanicAgentSessionTimeline(sessionTimeline, historyQuery, historyFilter),
    [historyFilter, historyQuery, sessionTimeline],
  )
  const historyFilterCounts = useMemo(() => ({
    all: sessionTimeline.length,
    unread: filterBotanicAgentSessionTimeline(sessionTimeline, '', 'unread').length,
    results: filterBotanicAgentSessionTimeline(sessionTimeline, '', 'results').length,
    attention: filterBotanicAgentSessionTimeline(sessionTimeline, '', 'attention').length,
  }), [sessionTimeline])
  const unreadSessionCount = useMemo(
    () => sessionTimeline.filter((item) => item.unreadRunCount > 0).length,
    [sessionTimeline],
  )
  // 提交任务后以 Run 卡作为唯一任务状态来源；规划/追问阶段仍显示 Runtime 摘要。
  const showRuntimeFeed = runtimeSteps.length > 0 && (!latestRun?.branches.length || !['executing', 'completed', 'failed'].includes(runtimePhase))

  const registerMessageNode = useCallback((messageId: string, node: HTMLDivElement | null) => {
    if (node) messageNodesRef.current.set(messageId, node)
    else messageNodesRef.current.delete(messageId)
  }, [])

  const revealConversationMessage = useCallback((messageId: string, behavior: ScrollBehavior = 'smooth') => {
    const node = messageNodesRef.current.get(messageId)
    if (!node) return false
    node.scrollIntoView({ block: 'center', behavior })
    node.focus({ preventScroll: true })
    setLocatedMessageId(messageId)
    if (locatedMessageTimerRef.current !== null) window.clearTimeout(locatedMessageTimerRef.current)
    locatedMessageTimerRef.current = window.setTimeout(() => setLocatedMessageId(''), 1800)
    return true
  }, [])

  const locateTaskSourceMessage = useCallback((source: { sessionId: string; messageId: string }) => {
    onUpdateReadingAnchor(source.sessionId, source.messageId)
    setActiveUtilityPanel(null)
    if (source.sessionId !== session?.id) {
      onSelectSession(source.sessionId)
      return
    }
    requestAnimationFrame(() => revealConversationMessage(source.messageId))
  }, [onSelectSession, onUpdateReadingAnchor, revealConversationMessage, session?.id])

  const locateRunSourceMessage = useCallback((runId: string) => {
    const source = runTimeline.find((item) => item.run.id === runId)?.source
    if (source) locateTaskSourceMessage(source)
  }, [locateTaskSourceMessage, runTimeline])

  const showTaskForRun = useCallback((runId: string) => {
    setTaskStatusFilter('all')
    setFocusedTaskRunId(runId)
    setActiveUtilityPanel('task')
    setActiveTransientSurface(null)
    setMentionQuery(undefined)
  }, [])

  const locateCollaborationActivity = useCallback((activity: CollaborationActivity) => {
    const target = activity.target
    if (!target || target.kind === 'project') {
      setActiveUtilityPanel('collaboration')
      setActiveTransientSurface(null)
    } else if (target.kind === 'node') {
      onFocusNodes([target.nodeId])
      setActiveUtilityPanel(null)
    } else if (target.kind === 'message') {
      locateTaskSourceMessage({ sessionId: target.sessionId, messageId: target.messageId })
    } else {
      showTaskForRun(target.runId)
    }
    onDismissRemoteChange()
  }, [locateTaskSourceMessage, onDismissRemoteChange, onFocusNodes, showTaskForRun])

  const jumpToLatestConversation = useCallback(() => {
    const latestMessageId = session?.messages.at(-1)?.id
    if (!session || !latestMessageId) return
    followLatestMessagesRef.current = true
    lastReadingAnchorRef.current = latestMessageId
    setReadingRestoreNotice(false)
    messageEndRef.current?.scrollIntoView({ block: 'end', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    onUpdateReadingAnchor(session.id, latestMessageId)
  }, [onUpdateReadingAnchor, session])

  const scheduleReadingAnchorUpdate = useCallback(() => {
    const viewport = messagesViewportRef.current
    if (!viewport) return
    followLatestMessagesRef.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 96
    if (!readingPositionRestoredRef.current || utilityPanelOpen || !session?.id) return
    if (readingAnchorTimerRef.current !== null) window.clearTimeout(readingAnchorTimerRef.current)
    readingAnchorTimerRef.current = window.setTimeout(() => {
      const currentViewport = messagesViewportRef.current
      if (!currentViewport) return
      const viewportRect = currentViewport.getBoundingClientRect()
      const visible = [...messageNodesRef.current.entries()].flatMap(([messageId, node]) => {
        const rect = node.getBoundingClientRect()
        if (rect.bottom <= viewportRect.top || rect.top >= viewportRect.bottom) return []
        return [{ messageId, distance: Math.abs(rect.top - viewportRect.top - 12) }]
      }).sort((left, right) => left.distance - right.distance)
      const messageId = followLatestMessagesRef.current
        ? session.messages.at(-1)?.id
        : visible[0]?.messageId
      if (!messageId || messageId === lastReadingAnchorRef.current) return
      lastReadingAnchorRef.current = messageId
      if (messageId === session.messages.at(-1)?.id) setReadingRestoreNotice(false)
      onUpdateReadingAnchor(session.id, messageId)
    }, 700)
  }, [onUpdateReadingAnchor, session?.id, utilityPanelOpen])

  const importImageFiles = async (files: File[]) => {
    const { accepted, message } = validateUploadFiles(files)
    const imageFiles = accepted.slice(0, maxUploadAssets)
    const limitMessage = accepted.length > maxUploadAssets ? `最多同时添加 ${maxUploadAssets} 张图片，超出部分已跳过。` : ''
    if (message || limitMessage) setError([message, limitMessage].filter(Boolean).join(' '))
    if (!imageFiles.length) return
    const loaded = await Promise.allSettled(imageFiles.map((file) => readUploadedAssetInput(file, '场景')))
    const uploads = loaded
      .filter((result): result is PromiseFulfilledResult<UploadedAssetInput> => result.status === 'fulfilled')
      .map((result) => result.value)
    if (!uploads.length) {
      setError('图片读取失败，请重新拖入或选择图片。')
      return
    }
    onUploadImages(uploads)
    setContextMenuOpen(false)
    setIsImageDropActive(false)
    if (!message && !limitMessage) setError('')
  }

  const handleImageDragOver = (event: DragEvent<HTMLElement>) => {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
    setIsImageDropActive(true)
  }

  const handleImageDragLeave = (event: DragEvent<HTMLElement>) => {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    setIsImageDropActive(false)
  }

  const handleImageDrop = (event: DragEvent<HTMLElement>) => {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return
    event.preventDefault()
    event.stopPropagation()
    setIsImageDropActive(false)
    void importImageFiles(Array.from(event.dataTransfer.files))
  }

  useEffect(() => {
    const frame = requestAnimationFrame(() => composerTextareaRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [])

  // Composer 随内容增长，但空输入时只保留一行半的呼吸空间，避免发送框出现大块空白。
  useEffect(() => {
    const textarea = composerTextareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    const nextHeight = Math.min(180, Math.max(56, textarea.scrollHeight))
    textarea.style.height = `${nextHeight}px`
  }, [instruction])

  useEffect(() => {
    if (!activeTransientSurface) return
    const closeOnOutsidePress = (event: PointerEvent) => {
      const target = event.target as Node
      const trigger = activeTransientSurface === 'history'
        ? historyTriggerRef.current
        : activeTransientSurface === 'utility'
          ? utilityMenuButtonRef.current
          : activeTransientSurface === 'context'
            ? contextMenuButtonRef.current
            : modeMenuButtonRef.current
      const surfaceId = activeTransientSurface === 'history'
        ? historyMenuId
        : activeTransientSurface === 'utility'
          ? utilityMenuId
          : activeTransientSurface === 'context'
            ? contextMenuId
            : modeMenuId
      if (trigger?.contains(target) || document.getElementById(surfaceId)?.contains(target)) return
      setActiveTransientSurface(null)
    }
    document.addEventListener('pointerdown', closeOnOutsidePress)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePress)
  }, [activeTransientSurface, contextMenuId, historyMenuId, modeMenuId, utilityMenuId])

  useEffect(() => {
    if (!mentionQuery) return
    const closeMentionOnOutsidePress = (event: PointerEvent) => {
      const target = event.target as Node
      const element = target instanceof Element ? target : target.parentElement
      if (composerTextareaRef.current?.contains(target) || element?.closest('.agent-composer__mention-menu')) return
      setMentionQuery(undefined)
    }
    document.addEventListener('pointerdown', closeMentionOnOutsidePress)
    return () => document.removeEventListener('pointerdown', closeMentionOnOutsidePress)
  }, [mentionQuery])

  useEffect(() => {
    const closeLayerOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !escapeEnabled) return
      if (mentionQuery) {
        setMentionQuery(undefined)
        requestAnimationFrame(() => composerTextareaRef.current?.focus())
      } else if (contextMenuOpen) {
        setContextMenuOpen(false)
        requestAnimationFrame(() => contextMenuButtonRef.current?.focus())
      } else if (modeMenuOpen) {
        setModeMenuOpen(false)
        requestAnimationFrame(() => modeMenuButtonRef.current?.focus())
      } else if (historyOpen) {
        setHistoryOpen(false)
        requestAnimationFrame(() => historyTriggerRef.current?.focus())
      } else if (utilityMenuOpen) {
        setUtilityMenuOpen(false)
        requestAnimationFrame(() => utilityMenuButtonRef.current?.focus())
      } else if (skillConfirming) {
        setSkillConfirming(false)
        requestAnimationFrame(() => skillCreateButtonRef.current?.focus())
      } else if (recoveryModelMenuKey) {
        setRecoveryModelMenuKey('')
      } else if (runtimeDetailsOpen) {
        setRuntimeDetailsOpen(false)
      } else if (utilityPanelOpen) {
        setActiveUtilityPanel(null)
        requestAnimationFrame(() => utilityButtonRef.current?.focus())
      } else {
        onClose()
      }
      event.preventDefault()
    }
    window.addEventListener('keydown', closeLayerOnEscape)
    return () => window.removeEventListener('keydown', closeLayerOnEscape)
  }, [contextMenuOpen, escapeEnabled, historyOpen, mentionQuery, modeMenuOpen, onClose, recoveryModelMenuKey, runtimeDetailsOpen, skillConfirming, utilityMenuOpen, utilityPanelOpen])

  useEffect(() => () => {
    agentMountedRef.current = false
    plannerControllerRef.current?.abort()
    if (readingAnchorTimerRef.current !== null) window.clearTimeout(readingAnchorTimerRef.current)
    if (locatedMessageTimerRef.current !== null) window.clearTimeout(locatedMessageTimerRef.current)
  }, [])

  useEffect(() => {
    if (!skillPanelOpen) setSkillFormOpen(false)
  }, [skillPanelOpen])

  useEffect(() => {
    let active = true
    setSkillError('')
    if (!serverPersistenceEnabled) {
      setSkills([])
      setSystemSkills([])
      return () => { active = false }
    }
    void Promise.allSettled([listProjectAgentSkills(projectId), listBotanicAgentSystemSkills()]).then(([projectResult, systemResult]) => {
      if (!active) return
      if (projectResult.status === 'fulfilled') setSkills(projectResult.value)
      else setSkillError(projectResult.reason instanceof Error ? projectResult.reason.message : '项目 Skill 列表加载失败。')
      if (systemResult.status === 'fulfilled') setSystemSkills(systemResult.value)
    })
    return () => { active = false }
  }, [projectId, skillPanelOpen])

  useEffect(() => {
    setSessionTitleDraft(session?.title ?? '新建对话')
    setRenamingSession(false)
  }, [session?.id, session?.title])

  useEffect(() => {
    if (utilityPanelOpen || !session || readingPositionRestoredRef.current) return
    const frame = requestAnimationFrame(() => {
      const anchorId = session.readingAnchorMessageId
      const restored = anchorId ? revealConversationMessage(anchorId, 'auto') : false
      if (!restored) messageEndRef.current?.scrollIntoView({ block: 'end', behavior: 'auto' })
      followLatestMessagesRef.current = !anchorId || anchorId === session.messages.at(-1)?.id
      lastReadingAnchorRef.current = anchorId ?? ''
      setReadingRestoreNotice(Boolean(restored && anchorId !== session.messages.at(-1)?.id))
      readingPositionRestoredRef.current = true
    })
    return () => cancelAnimationFrame(frame)
  }, [revealConversationMessage, session, utilityPanelOpen])

  useEffect(() => {
    if (!taskPanelOpen || !focusedTaskRunId) return
    const frame = requestAnimationFrame(() => {
      const node = taskNodesRef.current.get(focusedTaskRunId)
      node?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
      node?.focus({ preventScroll: true })
      window.setTimeout(() => setFocusedTaskRunId(''), 1800)
    })
    return () => cancelAnimationFrame(frame)
  }, [focusedTaskRunId, taskPanelOpen])

  useEffect(() => {
    if (!readingPositionRestoredRef.current || utilityPanelOpen || !followLatestMessagesRef.current) return
    const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
    messageEndRef.current?.scrollIntoView({ block: 'end', behavior })
  }, [session?.messages.length, latestRun?.updatedAt, planning, runtimeSteps.length, runtimeSteps[runtimeSteps.length - 1]?.status, utilityPanelOpen])

  useEffect(() => {
    if (!compatibleGroups.some((group) => group.id === groupId)) setGroupId('')
  }, [compatibleGroups, groupId])

  const toggleUtilityPanel = (panel: AgentUtilityPanel) => {
    utilityButtonRef.current = utilityMenuButtonRef.current
    setActiveUtilityPanel((current) => current === panel ? null : panel)
    setActiveTransientSurface(null)
    setMentionQuery(undefined)
  }

  const openUtilityPanel = (panel: AgentUtilityPanel) => {
    setActiveUtilityPanel(panel)
    setActiveTransientSurface(null)
    setMentionQuery(undefined)
  }

  const openRunFeedback = (run: BotanicAgentRun) => {
    const feedback = agentRunFeedback(run, artifacts, availableCanvasNodeIds)
    openUtilityPanel(feedback.action === 'view_results' ? 'result' : 'task')
  }

  useEffect(() => {
    if (!session) return
    for (const run of runs) {
      const outputCount = agentRunOutputCount(run, artifacts)
      // 只更新同一 Run 的最后一条状态消息；计划消息承载确认状态，不参与流式状态展示。
      const linkedMessage = [...session.messages]
        .reverse()
        .find((message) => message.runId === run.id && (message.kind === 'run' || message.kind === 'notice'))
      const feedback = agentRunFeedback(run, artifacts, availableCanvasNodeIds)
      const noticeKey = feedback.terminal ? `${run.status}:${outputCount}` : run.status
      const previousNoticeKey = runNoticeStatusRef.current.get(run.id)
      const content = feedback.detail

      if (!linkedMessage && previousNoticeKey === undefined) {
        // 不把其他会话的历史 Run 注入当前对话；新任务已有带 runId 的计划消息作为锚点。
        if (!session.messages.some((message) => message.runId === run.id)) continue
        appendMessage({ role: 'assistant', kind: 'run', runId: run.id, content })
        runNoticeStatusRef.current.set(run.id, noticeKey)
      } else if (linkedMessage && (previousNoticeKey === undefined || previousNoticeKey !== noticeKey)) {
        if (linkedMessage.content !== content) onUpdateMessage(session.id, linkedMessage.id, { content })
        runNoticeStatusRef.current.set(run.id, noticeKey)
      }
      const outputNodeIds = artifacts
        .filter((artifact) => artifact.provenance.runId === run.id)
        .flatMap((artifact) => artifact.provenance.sourceNodeIds ?? [])
      if (outputNodeIds.length && !focusedRunIdsRef.current.has(run.id)) {
        focusedRunIdsRef.current.add(run.id)
        onFocusNodes(outputNodeIds)
      }
    }
  }, [artifacts, availableCanvasNodeIds, onFocusNodes, onUpdateMessage, runs, session])

  const confirmSkillCreation = async () => {
    if (!skillName.trim() || !skillInstructions.trim() || skillSaving) return
    setSkillSaving(true)
    setSkillError('')
    try {
      const result = await createProjectAgentSkill({
        projectId,
        name: skillName.trim(),
        instructions: skillInstructions.trim(),
      })
      if (!isCurrentAgentProject()) return
      setSkills((items) => [result.output.skill, ...items.filter((item) => item.id !== result.output.skill.id)])
      if (session) onSkillsChange(session.id, [...new Set([...(session.mountedSkillIds ?? []), result.output.skill.id])])
      setSkillName('')
      setSkillInstructions('')
      setSkillConfirming(false)
      setSkillFormOpen(false)
    } catch (caught) {
      if (isCurrentAgentProject()) setSkillError(caught instanceof Error ? caught.message : 'Skill 创建失败。')
    } finally {
      setSkillSaving(false)
    }
  }

  const selectMention = (item: AgentContextItem) => {
    if (!session || !mentionQuery) return
    const inserted = insertBotanicAgentMention(instruction, mentionQuery, item.label)
    setInstruction(inserted.value)
    if (!session.contextNodeIds.includes(item.id)) onContextChange(session.id, [...session.contextNodeIds, item.id])
    setMentionQuery(undefined)
    requestAnimationFrame(() => {
      composerTextareaRef.current?.focus()
      composerTextareaRef.current?.setSelectionRange(inserted.caret, inserted.caret)
    })
  }

  const selectSkill = (skill: AgentSkillOption) => {
    if (!session || !mentionQuery) return
    const inserted = insertBotanicAgentMention(instruction, mentionQuery, skill.name)
    setInstruction(inserted.value)
    onSkillsChange(session.id, [...new Set([...(session.mountedSkillIds ?? []), skill.id])])
    setMentionQuery(undefined)
    requestAnimationFrame(() => {
      composerTextareaRef.current?.focus()
      composerTextareaRef.current?.setSelectionRange(inserted.caret, inserted.caret)
    })
  }

  const openSkillCreation = () => {
    setMentionQuery(undefined)
    setUtilityMenuOpen(false)
    setActiveUtilityPanel('skill')
    setSkillFormOpen(true)
    setSkillConfirming(false)
    setSkillError('')
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[aria-label="Skill 名称"]')?.focus())
  }

  const preparePlan = async (
    cleanInstruction: string,
    generationOverrides?: Partial<Pick<GenerationSettings, 'model' | 'aspectRatio' | 'resolution'>>,
    clarificationAnswers?: Record<string, string>,
    failedCommand?: AgentFailedInstruction,
  ): Promise<BotanicAgentPlan | BotanicAgentClarificationResponse | null> => {
    if (!target || !isCurrentAgentProject()) return null
    const assetGroup = compatibleGroups.find((group) => group.id === groupId)
    const input = {
      projectId,
      plannerModel,
      mountedSkillIds: session?.mountedSkillIds,
      instruction: cleanInstruction,
      requestedIntent: intent,
      selectedResultNodeId: target.id,
      selectedResultLabel: target.label,
      rootRecipe: target.rootRecipe,
      assetGroup,
      availableAssetGroups: groups,
      projectMemory: memory,
      availableGenerationModels: generationModels,
      generationOverrides,
      clarificationAnswers,
      contextSnapshot: createBotanicAgentContextSnapshot(contextItems),
    }
    plannerControllerRef.current?.abort()
    const controller = new AbortController()
    plannerControllerRef.current = controller
    setPlanning(true)
    setError('')
    setRuntimePhase('planning')
    updateRuntimeStep('call-planner', 'running')
    try {
      const nextPlan = await requestBotanicAgentPlan(input, controller.signal)
      if (controller.signal.aborted) return null
      attachPlannerToolTrace(nextPlan)
      updateRuntimeStep('call-planner', 'succeeded')
      await completeRuntimeTrace(true)
      if (!isCurrentAgentProject()) return null
      return nextPlan
    } catch (planError) {
      if (controller.signal.aborted) return null
      const canUseLocalFallback = planError instanceof ProductApiError
        && (planError.status === 0 || planError.status === 404 || planError.status >= 500)
      if (canUseLocalFallback) {
        try {
          const fallbackPlan = { ...buildBotanicAgentPlan({
            instruction: cleanInstruction,
            intent,
            selectedResultNodeId: target.id,
            selectedResultLabel: target.label,
            rootRecipe: target.rootRecipe,
            assetGroup,
            contextSnapshot: createBotanicAgentContextSnapshot(contextItems),
          }), plannerModel, settings: { ...target.rootRecipe.settings, ...generationOverrides } }
          attachPlannerToolTrace(fallbackPlan)
          updateRuntimeStep('call-planner', 'succeeded')
          await completeRuntimeTrace(true)
          if (!isCurrentAgentProject()) return null
          return fallbackPlan
        } catch (fallbackError) {
          const message = fallbackError instanceof Error ? fallbackError.message : '暂时无法生成计划。'
          setError(message)
          setLastFailedPlanMessageId('')
          rememberFailedInstruction(failedCommand ?? { instruction: cleanInstruction, options: { generationOverrides, clarificationAnswers } })
        }
      } else {
        const message = planError instanceof Error ? planError.message : '暂时无法生成计划。'
        setError(message)
        setLastFailedPlanMessageId('')
        rememberFailedInstruction(failedCommand ?? { instruction: cleanInstruction, options: { generationOverrides, clarificationAnswers } })
      }
      failRuntimeTrace(planError instanceof Error ? planError.message : '暂时无法生成计划。')
    } finally {
      if (plannerControllerRef.current === controller) plannerControllerRef.current = null
      setPlanning(false)
    }
    return null
  }

  const confirmMessagePlan = async (message: BotanicAgentMessage) => {
    if (!session || !message.plan || message.status === 'submitted' || submittingMessageId === message.id || submittingMessageIdRef.current === message.id) return
    if (message.plan.actions?.some((action) => action.status === 'awaiting_confirmation' || action.status === 'running')) {
      setError('请先确认或跳过行动卡，再执行生成计划。')
      return
    }
    submittingMessageIdRef.current = message.id
    setSubmittingMessageId(message.id)
    setRuntimePhase('executing')
    setError('')
    const editedPrompt = promptDrafts[message.id]?.trim()
    const plan = editedPrompt ? { ...message.plan, prompt: editedPrompt } : message.plan
    if (editedPrompt && editedPrompt !== message.plan.prompt) onUpdateMessage(session.id, message.id, { plan })
    try {
      const submission = await onConfirm(plan, botanicAgentSubmissionKey(message.id, plan))
      if (!isCurrentAgentProject()) return
      setLastFailedPlanMessageId('')
      setLastFailedInstruction('')
      if (!submission.started) setRuntimePhase('failed')
      onUpdateMessage(session.id, message.id, { status: submission.started ? 'submitted' : 'failed', runId: submission.runId })
      if (!submission.started) appendMessage({
        role: 'assistant', kind: 'text',
        content: '任务没有启动，请检查参考素材与生成服务后重试。',
      })
    } catch (caught) {
      if (!isCurrentAgentProject()) return
      onUpdateMessage(session.id, message.id, { status: 'failed' })
      setRuntimePhase('failed')
      setError(caught instanceof Error ? caught.message : '任务未能启动，请稍后重试。')
      // 请求可能已被服务端接受，但响应在网络中断时丢失；重试原计划时必须复用同一幂等键。
      setLastFailedInstruction('')
      setLastFailedPlanMessageId(message.id)
    } finally {
      submittingMessageIdRef.current = ''
      setSubmittingMessageId('')
    }
  }

  const confirmAction = async (message: BotanicAgentMessage, action: BotanicAgentActionProposal) => {
    if (!session || executingActionId || action.status === 'succeeded') return
    setExecutingActionId(action.id)
    setRuntimePhase('executing')
    setError('')
    setLastFailedPlanMessageId('')
    onUpdateAction(session.id, message.id, action.id, { status: 'running', error: undefined })
    try {
      const result = await onConfirmAction(action)
      if (!isCurrentAgentProject()) return
      onUpdateAction(session.id, message.id, action.id, { status: 'succeeded', result, error: undefined })
      setRuntimePhase('completed')
      appendMessage({
        role: 'assistant', kind: 'notice',
        content: `${result.message}${result.canvasNodeId ? ' 已写入画布。' : ''}`,
      })
    } catch (caught) {
      if (!isCurrentAgentProject()) return
      const actionError = caught instanceof Error ? caught.message : '行动执行失败，请重试。'
      onUpdateAction(session.id, message.id, action.id, { status: 'failed', error: actionError })
      setRuntimePhase('failed')
      setError(actionError)
    } finally {
      setExecutingActionId('')
    }
  }

  const prepareFailedRunRecovery = (
    run: BotanicAgentRun,
    mode: 'settings' | 'model',
    model?: GenerationModelOption,
  ) => {
    const availableNodeIds = contextOptions.map((item) => item.id)
    const lockedContextIds = botanicAgentContextSnapshotNodeIds(run.plan.contextSnapshot, availableNodeIds)
    const recoveryContextIds = [...new Set([
      ...(run.plan.selectedResultNodeId ? [run.plan.selectedResultNodeId] : []),
      ...lockedContextIds,
    ])]
    if (recoveryContextIds.length) onUseResultContext(recoveryContextIds)
    setIntent(run.plan.intent)
    setGroupId('')
    setRecoveryModelMenuKey('')
    if (mode === 'model' && model) {
      const modelOverrides: Partial<Pick<GenerationSettings, 'model' | 'aspectRatio' | 'resolution'>> = { model: model.id }
      if (model.aspectRatios?.length && !model.aspectRatios.includes(run.plan.settings.aspectRatio)) modelOverrides.aspectRatio = model.aspectRatios[0]
      if (model.resolutions?.length && !model.resolutions.includes(run.plan.settings.resolution)) modelOverrides.resolution = model.resolutions[0]
      setPendingGenerationOverrides(modelOverrides)
      setInstruction(`换用${modelDisplayLabel(model)}重新生成：${run.plan.prompt}`)
    } else {
      setPendingGenerationOverrides({})
      setInstruction(`调整输出设置后重新生成：${run.plan.prompt}`)
    }
    setActiveUtilityPanel(null)
    setError('')
    setLastFailedPlanMessageId('')
    requestAnimationFrame(() => composerTextareaRef.current?.focus())
  }

  const runInstruction = async (
    cleanInstruction: string,
    options: AgentRunInstructionOptions = {},
  ) => {
    if (!session || planning || !isCurrentAgentProject()) return
    if (options.appendUser) appendMessage({ role: 'user', kind: 'text', content: options.appendUser })
    setError('')
    setLastFailedInstruction('')
    setLastFailedPlanMessageId('')
    const failedCommand: AgentFailedInstruction = {
      instruction: cleanInstruction,
      options: {
        ...(options.generationOverrides ? { generationOverrides: options.generationOverrides } : {}),
        ...(options.clarificationAnswers ? { clarificationAnswers: options.clarificationAnswers } : {}),
        ...(options.sourcePromptMessageId ? { sourcePromptMessageId: options.sourcePromptMessageId } : {}),
      },
    }

    const hasImageContext = contextItems.some((item) => (
      (item.kind === '素材' || item.kind === '结果')
      && Boolean(item.image)
      && (item.mediaKind ?? 'image') === 'image'
    ))
    const decision = decideBotanicAgentRequest(cleanInstruction, Boolean(target) || hasImageContext)
    if (decision.kind === 'clarification') {
      appendMessage({
        role: 'assistant',
        kind: 'notice',
        content: decision.reason === 'unsupported_media'
          ? 'Agent 对话暂未接入视频执行链。请先在画布添加「视频生成」节点；本次没有创建节点或任务。'
          : '请明确是只需要建议，还是要我直接生成；本次没有改动画布。',
      })
      return
    }
    if (decision.kind === 'chat') {
      const route = decision.mode
      plannerControllerRef.current?.abort()
      const controller = new AbortController()
      plannerControllerRef.current = controller
      setPlanning(true)
      const runtimeTrace = beginRuntimeTrace({
        hasTarget: Boolean(target),
        referenceCount: target?.rootRecipe.references.length ?? contextItems.length,
        memoryCount: memory.length,
        assetGroupCount: compatibleGroups.length,
        mode: route,
      })
      await completeRuntimeContextReads(runtimeTrace)
      if (!isCurrentAgentProject()) return
      setRuntimePhase('planning')
      updateRuntimeStep('call-planner', 'running')
      const chatMessages = [
        ...session.messages.map((message) => ({ role: message.role, content: message.content })),
        { role: 'user' as const, content: options.appendUser ?? cleanInstruction },
      ].slice(-16)
      try {
        const response = await requestBotanicAgentChat({
          projectId,
          plannerModel,
          mountedSkillIds: session.mountedSkillIds,
          mode: route,
          messages: chatMessages,
          contextNodeIds: session.contextNodeIds,
        }, controller.signal)
        if (controller.signal.aborted) return
        updateRuntimeStep('call-planner', 'succeeded')
        updateRuntimeStep('respond', 'running')
        await yieldRuntimeFrame()
        if (!isCurrentAgentProject()) return
        updateRuntimeStep('respond', 'succeeded')
        setRuntimePhase('completed')
        setRuntimeDetailsOpen(false)
        const sourceNote = route === 'research'
          ? `\n\n来源：${response.sources?.length ? response.sources.join('、') : '当前没有命中项目受控检索来源。'}`
          : ''
        appendMessage({
          role: 'assistant',
          kind: 'text',
          content: `${response.answer}${sourceNote}`,
          ...(response.prompt ? { prompt: response.prompt } : {}),
        })
      } catch (caught) {
        if (controller.signal.aborted) return
        const message = caught instanceof Error ? caught.message : 'Agent 暂时无法回答，请稍后重试。'
        failRuntimeTrace(message)
        setError(message)
        setLastFailedPlanMessageId('')
        rememberFailedInstruction(failedCommand)
      } finally {
        if (plannerControllerRef.current === controller) plannerControllerRef.current = null
        setPlanning(false)
      }
      return
    }
    const promptResolution = resolveBotanicAgentGenerationPromptDecision(
      cleanInstruction,
      session.messages,
      options.sourcePromptMessageId,
    )
    if (promptResolution.status === 'missing') {
      appendMessage({
        role: 'assistant',
        kind: 'notice',
        content: '没有找到你指的 Prompt。请先让 Agent 写一段 Prompt，或粘贴完整 Prompt；本次没有改动画布。',
      })
      return
    }
    const generationPrompt = promptResolution.prompt
    setPlanning(true)
    const runtimeTrace = beginRuntimeTrace({
      hasTarget: Boolean(target),
      referenceCount: target?.rootRecipe.references.length ?? contextItems.length,
      memoryCount: memory.length,
      assetGroupCount: compatibleGroups.length,
    })
    await completeRuntimeContextReads(runtimeTrace)
    if (!isCurrentAgentProject()) return
    setRuntimePhase('planning')
    updateRuntimeStep('call-planner', 'running')
    if (!target) {
      const inferredGenerationOverrides = inferBotanicAgentGenerationSettings(
        cleanInstruction,
        generationModels.filter((model) => model.mediaKind !== 'video'),
      )
      const resolvedGenerationOverrides = { ...inferredGenerationOverrides, ...options.generationOverrides }
      const hasCompleteOutputSettings = Boolean(
        resolvedGenerationOverrides.model
        && resolvedGenerationOverrides.aspectRatio
        && resolvedGenerationOverrides.resolution,
      )
      if (!options.clarificationAnswers && !hasCompleteOutputSettings) {
        updateRuntimeStep('call-planner', 'succeeded')
        await yieldRuntimeFrame()
        if (!isCurrentAgentProject()) return
        setRuntimePhase('waiting_clarification')
        appendMessage({
          role: 'assistant',
          kind: 'question',
          question: {
            ...createInitialAgentClarification(
              cleanInstruction,
              generationModels.filter((model) => model.mediaKind !== 'video'),
              resolvedGenerationOverrides,
            ),
            ...(promptResolution.sourceMessageId
              ? { sourcePromptMessageId: promptResolution.sourceMessageId }
              : {}),
          },
          status: 'pending',
          content: '先确认一下输出设置。',
        })
        setPlanning(false)
        return
      }
      try {
        const initialPlan = {
          ...buildBotanicAgentPlan({
            instruction: generationPrompt,
            intent: 'initial_generation',
            settings: resolvedGenerationOverrides as GenerationSettings,
            contextSnapshot: createBotanicAgentContextSnapshot(contextItems),
          }),
          plannerModel,
        }
        attachPlannerToolTrace(initialPlan)
        updateRuntimeStep('call-planner', 'succeeded')
        await completeRuntimeTrace(true)
        if (!isCurrentAgentProject()) return
        const planMessageId = appendMessage({
          role: 'assistant', kind: 'plan', plan: initialPlan, status: 'pending',
          content: initialPlan.summary,
        })
        if (planMessageId) setRuntimePhase('waiting_confirmation')
        if (session.executionMode === 'auto' && planMessageId) {
          await confirmMessagePlan({
            id: planMessageId, role: 'assistant', kind: 'plan', content: initialPlan.summary,
            createdAt: Date.now(), plan: initialPlan, status: 'pending',
          })
        }
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : '暂时无法创建生成计划。'
        failRuntimeTrace(message)
        setError(message)
        setLastFailedPlanMessageId('')
        rememberFailedInstruction({ ...failedCommand, options: { ...failedCommand.options, generationOverrides: resolvedGenerationOverrides } })
      } finally {
        setPlanning(false)
      }
      return
    }
    const nextPlan = await preparePlan(
      generationPrompt,
      options.generationOverrides,
      options.clarificationAnswers,
      failedCommand,
    )
    if (!nextPlan || !session || !isCurrentAgentProject()) return
    if ('kind' in nextPlan && nextPlan.kind === 'clarification') {
      setRuntimePhase('waiting_clarification')
      appendMessage({
        role: 'assistant', kind: 'question', question: nextPlan.clarification, status: 'pending',
        content: nextPlan.clarification.question,
      })
      return
    }
    const resolvedPlan = nextPlan as BotanicAgentPlan
    const planMessageId = appendMessage({
      role: 'assistant', kind: 'plan', plan: resolvedPlan, status: 'pending',
      content: resolvedPlan.summary,
    })
    if (planMessageId) setRuntimePhase('waiting_confirmation')
    if (session.executionMode === 'auto' && planMessageId && !resolvedPlan.actions?.length) {
      await confirmMessagePlan({
        id: planMessageId, role: 'assistant', kind: 'plan', content: resolvedPlan.summary,
        createdAt: Date.now(), plan: resolvedPlan, status: 'pending',
      })
    }
  }

  const retryLastInstruction = () => {
    const command = lastFailedCommand ?? (lastFailedInstruction.trim()
      ? { instruction: lastFailedInstruction.trim(), options: {} }
      : undefined)
    const retryInstruction = command?.instruction.trim() ?? ''
    if (!retryInstruction || planning || sendingInstructionRef.current) return
    sendingInstructionRef.current = true
    setError('')
    setLastFailedInstruction('')
    setLastFailedPlanMessageId('')
    setInstruction('')
    setMentionQuery(undefined)
    setPendingGenerationOverrides({})
    void runInstruction(retryInstruction, command?.options).finally(() => {
      sendingInstructionRef.current = false
    })
  }

  const retryLastFailedPlan = () => {
    if (!session || !lastFailedPlanMessageId || planning || submittingMessageIdRef.current) return
    const failedMessage = session.messages.find((message) => message.id === lastFailedPlanMessageId && message.plan)
    if (!failedMessage) {
      setLastFailedPlanMessageId('')
      return
    }
    setError('')
    void confirmMessagePlan(failedMessage)
  }

  const sendInstruction = async () => {
    if (!session || planning || sendingInstructionRef.current) return
    const cleanInstruction = instruction.replace(/\u00a0/g, ' ').trim()
    if (!cleanInstruction) return
    sendingInstructionRef.current = true
    setInstruction('')
    setMentionQuery(undefined)
    setLastFailedPlanMessageId('')
    const generationOverrides = pendingGenerationOverrides
    setPendingGenerationOverrides({})
    try {
      await runInstruction(cleanInstruction, { appendUser: cleanInstruction, generationOverrides })
    } finally {
      sendingInstructionRef.current = false
    }
  }

  const answerClarification = async (message: BotanicAgentMessage, answers: Record<string, string>) => {
    if (!session || !message.question || planning || message.status === 'answered') return
    const fields = message.question.fields
    const summary = fields
      .map((field) => `${field.label}：${field.options.find((option) => option.value === answers[field.id])?.label ?? answers[field.id]}`)
      .join('；')
    onUpdateMessage(session.id, message.id, {
      status: 'answered',
      question: {
        ...message.question,
        fields: fields.map((field) => answers[field.id]
          ? { ...field, defaultValue: answers[field.id] }
          : field),
      },
    })
    await runInstruction(message.question.originalInstruction, {
      appendUser: summary,
      clarificationAnswers: answers,
      sourcePromptMessageId: message.question.sourcePromptMessageId,
      generationOverrides: {
        ...(answers.model ? { model: answers.model } : {}),
        ...(answers.aspect_ratio ? { aspectRatio: answers.aspect_ratio as GenerationSettings['aspectRatio'] } : {}),
        ...(answers.resolution ? { resolution: answers.resolution as GenerationSettings['resolution'] } : {}),
      },
    })
  }

  const usePromptForGeneration = (message: BotanicAgentMessage) => {
    if (
      !message.prompt?.trim()
      || planning
      || sendingInstructionRef.current
      || !session
      || isBotanicAgentPromptGenerationPending(message.id, session.messages)
    ) return
    const command = '使用这段 Prompt 生成'
    sendingInstructionRef.current = true
    void runInstruction(command, {
      appendUser: command,
      sourcePromptMessageId: message.id,
    }).finally(() => {
      sendingInstructionRef.current = false
    })
  }

  const commitPlanPrompt = (message: BotanicAgentMessage, prompt: string) => {
    if (!session || !message.plan) return
    const cleanPrompt = prompt.trim()
    if (!cleanPrompt || cleanPrompt === message.plan.prompt) return
    onUpdateMessage(session.id, message.id, { plan: { ...message.plan, prompt: cleanPrompt } })
  }

  const createNextRoundFromResults = (sourceNodeIds: string[], artifactCount: number) => {
    if (!sourceNodeIds.length) return
    onUseResultContext(sourceNodeIds)
    setInstruction(artifactCount === 1
      ? '基于这张结果继续生成：'
      : `基于这 ${artifactCount} 张结果继续生成：`)
    setActiveUtilityPanel(null)
    requestAnimationFrame(() => composerTextareaRef.current?.focus())
  }

  const continueFromArtifact = (artifact: BotanicAgentArtifact) => {
    onContinueArtifact(artifact)
    setInstruction(`基于「${artifact.label}」继续修改：`)
    setActiveUtilityPanel(null)
    requestAnimationFrame(() => composerTextareaRef.current?.focus())
  }

  const persistenceIssue = persistenceStatus === 'offline' || persistenceStatus === 'conflict' || persistenceStatus === 'error'
  const latestCollaborationActivity = collaborationAwareness.activities[0]
  const persistenceCopy = persistenceStatus === 'conflict'
    ? { title: '画布有新的云端版本', detail: '本地草稿仍保留，生成任务与结果不会丢失。', action: 'refresh' as const, actionLabel: '查看变更' }
    : persistenceStatus === 'offline'
      ? { title: '正在使用离线草稿', detail: '恢复网络后会继续同步当前编辑。', action: 'retry' as const, actionLabel: '重试同步' }
      : { title: '画布同步暂时失败', detail: '当前编辑仍在本地，稍后可以继续同步。', action: 'retry' as const, actionLabel: '重试同步' }
  const resolvePersistenceIssue = () => {
    setPersistenceAction(persistenceCopy.action)
    const task = persistenceCopy.action === 'refresh' ? onRefreshRemote() : onRetryPersistence()
    void task.catch(() => undefined).finally(() => setPersistenceAction(''))
  }
  const inspectPersistenceIssue = () => {
    if (persistenceStatus === 'conflict') {
      openUtilityPanel('collaboration')
      return
    }
    resolvePersistenceIssue()
  }
  const commitSessionTitle = () => {
    if (!session) return
    const title = sessionTitleDraft.trim()
    if (title) onRenameSession(session.id, title)
    setRenamingSession(false)
  }

  return (
    <aside
      className="agent-workspace nopan nowheel"
      aria-label="Botanic Agent"
      onDragOver={handleImageDragOver}
      onDragLeave={handleImageDragLeave}
      onDrop={handleImageDrop}
    >
      {isImageDropActive ? <div className="agent-workspace__drop-hint" aria-hidden="true"><UploadIcon /><strong>松开即可添加图片素材</strong><small>PNG / JPEG / WebP，单张不超过 8MB</small></div> : null}
      <header className="agent-workspace__header">
        <div className="agent-workspace__title">
          <button type="button" className="agent-workspace__history-button" onClick={(event) => { historyTriggerRef.current = event.currentTarget; setUtilityMenuOpen(false); setHistoryOpen((open) => !open) }} aria-controls={historyMenuId} aria-expanded={historyOpen} aria-label={unreadSessionCount ? `对话历史，${unreadSessionCount} 个会话有更新` : '对话历史'} title="对话历史"><FigmaIcon src={historyIcon} />{unreadSessionCount ? <span className="agent-workspace__history-unread" aria-hidden="true">{Math.min(unreadSessionCount, 9)}</span> : null}</button>
          {renamingSession ? <form className="agent-workspace__title-editor" onSubmit={(event) => { event.preventDefault(); commitSessionTitle() }}>
            <input value={sessionTitleDraft} onChange={(event) => setSessionTitleDraft(event.target.value)} maxLength={160} autoFocus aria-label="对话名称" onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); setRenamingSession(false) } }} />
            <button type="submit" aria-label="保存对话名称" title="保存"><CheckIcon /></button>
            <button type="button" aria-label="取消编辑对话名称" title="取消" onClick={() => setRenamingSession(false)}><CloseIcon /></button>
          </form> : <>
            <button type="button" className="agent-workspace__title-button" onClick={(event) => { historyTriggerRef.current = event.currentTarget; setUtilityMenuOpen(false); setHistoryOpen((open) => !open) }} aria-controls={historyMenuId} aria-expanded={historyOpen}>{session?.title ?? '新建对话'} <span aria-hidden="true">⌄</span></button>
            {session ? <button type="button" className="agent-workspace__rename-button" aria-label="编辑对话名称" title="编辑对话名称" onClick={() => { setHistoryOpen(false); setSessionTitleDraft(session.title); setRenamingSession(true) }}><EditIcon /></button> : null}
          </>}
        </div>
        <div className="agent-workspace__header-actions">
          {collaborationAwareness.onlineCollaboratorCount ? <span
            className="agent-workspace__collaborators"
            title={`另有 ${collaborationAwareness.onlineCollaboratorCount} 位协作者在线`}
            aria-label={`另有 ${collaborationAwareness.onlineCollaboratorCount} 位协作者在线`}
          ><i aria-hidden="true" />{collaborationAwareness.onlineCollaboratorCount}</span> : null}
          {persistenceIssue ? <button
            type="button"
            className={`agent-workspace__persistence-status is-${persistenceStatus}`}
            aria-label={`${persistenceCopy.title}。${persistenceAction ? '处理中' : persistenceCopy.actionLabel}`}
            title={`${persistenceCopy.title} · ${persistenceCopy.actionLabel}`}
            disabled={Boolean(persistenceAction)}
            onClick={inspectPersistenceIssue}
          ><span aria-hidden="true">{persistenceStatus === 'conflict' ? '!' : '·'}</span></button> : null}
          <div ref={utilityMenuRef} className="agent-workspace__utility-menu-wrap">
            <button ref={utilityMenuButtonRef} type="button" className={`agent-workspace__utility-menu-button${utilityPanelOpen ? ' is-active' : ''}`} aria-haspopup="menu" aria-expanded={utilityMenuOpen} aria-controls={utilityMenuId} aria-label="Agent 工具" title="Agent 工具" onClick={() => { setUtilityMenuOpen((open) => !open); setHistoryOpen(false) }}><ChecklistIcon /></button>
            {utilityMenuOpen ? <div id={utilityMenuId} className="agent-workspace__utility-menu" role="menu" aria-label="Agent 工具">
              <button type="button" role="menuitem" className={resultPanelOpen ? 'is-active' : ''} onClick={() => toggleUtilityPanel('result')}><GalleryIcon /><span>结果与文件</span></button>
              <button type="button" role="menuitem" className={taskPanelOpen ? 'is-active' : ''} onClick={() => toggleUtilityPanel('task')}><ChecklistIcon /><span>Agent 任务</span></button>
              <button type="button" role="menuitem" className={memoryPanelOpen ? 'is-active' : ''} onClick={() => toggleUtilityPanel('memory')}><BookmarkIcon /><span>项目记忆</span></button>
              <button type="button" role="menuitem" className={skillPanelOpen ? 'is-active' : ''} onClick={() => toggleUtilityPanel('skill')}><SparkleIcon /><span>创作技能</span></button>
              <button type="button" role="menuitem" className={collaborationPanelOpen ? 'is-active' : ''} onClick={() => toggleUtilityPanel('collaboration')}><ChecklistIcon /><span>协作动态</span>{collaborationAwareness.unreadActivityCount ? <b>{Math.min(collaborationAwareness.unreadActivityCount, 99)}</b> : null}</button>
              <button type="button" role="menuitem" className="is-danger" onClick={() => { setUtilityMenuOpen(false); onClose() }}><CloseIcon /><span>关闭 Agent</span></button>
            </div> : null}
          </div>
        </div>
        {historyOpen ? <div id={historyMenuId} className="agent-workspace__history" aria-label="对话历史">
          <button type="button" onClick={() => { onNewSession(); setHistoryOpen(false); setHistoryQuery(''); setHistoryFilter('all') }}><PlusSquareIcon /> 新建对话</button>
          <label className="agent-workspace__history-search"><input type="search" aria-label="搜索对话" value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} placeholder="搜索对话、消息或任务" autoFocus /></label>
          <div className="agent-workspace__history-filters" aria-label="筛选协作历史">
            {([
              ['all', '全部'],
              ['unread', '未读'],
              ['results', '新结果'],
              ['attention', '需处理'],
            ] as const).map(([value, label]) => <button
              key={value}
              type="button"
              className={historyFilter === value ? 'is-active' : ''}
              aria-pressed={historyFilter === value}
              onClick={() => setHistoryFilter(value)}
            >{label}<small>{historyFilterCounts[value]}</small></button>)}
          </div>
          {filteredSessionTimeline.map((item) => <button key={item.session.id} type="button" className={item.session.id === session?.id ? 'is-active' : ''} onClick={() => { onSelectSession(item.session.id); setHistoryOpen(false); setHistoryQuery('') }}>
            <span><strong>{item.session.title}</strong><small>{item.preview}</small></span>
            <span className="agent-workspace__history-meta"><time dateTime={new Date(item.updatedAt).toISOString()}>{agentTimelineTimestamp(item.updatedAt)}</time>{item.unreadResultCount ? <b className="is-unread">{item.unreadResultCount} 个新结果</b> : item.unreadRunCount ? <b className="is-unread">{item.unreadRunCount} 条更新</b> : item.attentionRunCount ? <b className="is-attention">{item.attentionRunCount} 项需处理</b> : item.activeRunCount ? <b>{item.activeRunCount} 进行中</b> : item.runCount ? <small>{item.runCount} 个任务</small> : null}</span>
          </button>)}
          {!filteredSessionTimeline.length ? <p className="agent-workspace__history-empty">当前筛选下没有对话。</p> : null}
        </div> : null}
      </header>
      {latestCollaborationActivity?.unread ? <div className="agent-workspace__collaboration-notice" role="status">
        <button type="button" className="agent-workspace__collaboration-summary" onClick={() => locateCollaborationActivity(latestCollaborationActivity)}>
          <i aria-hidden="true" /><span><strong>{latestCollaborationActivity.actorName} · {latestCollaborationActivity.summary}</strong><small>{persistenceStatus === 'conflict' ? '本地改动仍保留，点击查看变更。' : latestCollaborationActivity.target && latestCollaborationActivity.target.kind !== 'project' ? '点击定位变更。' : '最新内容已同步。'}</small></span>
        </button>
        <button type="button" aria-label="关闭协作更新提示" title="知道了" onClick={() => void onDismissRemoteChange().catch(() => undefined)}><CloseIcon /></button>
      </div> : null}
      <div
        ref={messagesViewportRef}
        className="agent-workspace__messages"
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        onScroll={scheduleReadingAnchorUpdate}
      >
        {resultPanelOpen ? <AgentResultPanel
          artifacts={artifacts}
          runs={runs}
          latestRun={latestRun}
          contextOptions={contextOptions}
          artifactIndexStatus={artifactIndexStatus}
          artifactIndexHasMore={artifactIndexHasMore}
          conversationRunIds={runTimeline.flatMap((item) => item.source ? [item.run.id] : [])}
          onLocateNode={onLocateNode}
          onSaveArtifact={onSaveArtifact}
          onContinue={continueFromArtifact}
          onStartNextRound={createNextRoundFromResults}
          onLoadMoreArtifacts={onLoadMoreArtifacts}
          onLocateConversation={locateRunSourceMessage}
        /> : null}
        {collaborationPanelOpen ? <AgentCollaborationPanel
          activities={collaborationAwareness.activities}
          conflictChanges={collaborationAwareness.conflictChanges}
          persistenceStatus={persistenceStatus}
          onLocate={locateCollaborationActivity}
          onMarkRead={onDismissRemoteChange}
          onClear={onClearCollaborationActivities}
          onKeepLocal={onDismissRemoteChange}
          onUseRemote={resolvePersistenceIssue}
          historyStatus={collaborationAwareness.historyStatus}
          historyHasMore={collaborationAwareness.historyHasMore}
          historyErrorAction={collaborationAwareness.historyErrorAction}
          onLoadMore={onLoadMoreCollaborationActivities}
          onReload={onReloadCollaborationActivities}
        /> : null}
        {memoryPanelOpen ? <AgentMemoryPanel
          memory={memory}
          sourceNodeIds={session?.contextNodeIds ?? []}
          onAddMemory={onAddMemory}
          onRemoveMemory={onRemoveMemory}
          onLocateNode={onLocateNode}
        /> : null}
        {taskPanelOpen ? <section className="agent-task-panel" aria-label="Agent 任务与结果">
          <header><div><small>AGENT RUNS</small><h2>Agent 任务</h2></div><span>{runs.length} 个</span></header>
          <p>这里只显示由 Agent 发起的任务；失败分支可重试，也可以修改参数或模型后重新提交，不会覆盖已完成结果。</p>
          <div className="agent-task-panel__filters" aria-label="按任务状态筛选">
            {([
              ['all', '全部', taskFilterCounts.all],
              ['active', '进行中', taskFilterCounts.active],
              ['completed', '已完成', taskFilterCounts.completed],
              ['attention', '需处理', taskFilterCounts.attention],
            ] as const).map(([value, label, count]) => <button
              key={value}
              type="button"
              aria-label={`${label} · ${count} 项`}
              aria-pressed={taskStatusFilter === value}
              title={`${label} · ${count} 项`}
              onClick={() => setTaskStatusFilter(value)}
            ><AgentTaskFilterIcon value={value} /><b>{count}</b></button>)}
          </div>
          <div className="agent-task-panel__list">
            {filteredRunTimeline.map(({ run, source }) => {
              const feedback = agentRunFeedback(run, artifacts, availableCanvasNodeIds)
              const active = run.status === 'queued' || run.status === 'running' || run.status === 'executing'
              return <article key={run.id} ref={(node) => { if (node) taskNodesRef.current.set(run.id, node); else taskNodesRef.current.delete(run.id) }} tabIndex={-1} className={`is-${run.status} is-${feedback.tone}${focusedTaskRunId === run.id ? ' is-located' : ''}`}>
              <header><span><strong>{run.plan.summary}</strong><small>{feedback.label} · <time dateTime={new Date(run.updatedAt).toISOString()}>{agentTimelineTimestamp(run.updatedAt)}</time></small>{source ? <button type="button" className="agent-task-panel__source" aria-label={`定位到「${source.sessionTitle}」`} title={`定位到「${source.sessionTitle}」`} onClick={() => locateTaskSourceMessage(source)}><FocusIcon /></button> : null}</span><div>{active ? <button type="button" className="agent-icon-button agent-icon-button--danger" aria-label="取消任务" title="取消任务" disabled={cancellingRunId === run.id} onClick={() => { setCancellingRunId(run.id); void onCancelRun(run.id).finally(() => setCancellingRunId('')) }}>{cancellingRunId === run.id ? <span className="agent-workspace__mini-spinner" /> : <CloseIcon />}</button> : <button type="button" className="agent-task-panel__feedback-action" aria-label={feedback.actionLabel} title={feedback.actionLabel} onClick={() => openRunFeedback(run)}><AgentRunActionIcon label={feedback.actionLabel} /></button>}<b>{run.completedBranchCount}/{run.branches.length}</b></div></header>
              <p className="agent-task-panel__feedback">{feedback.detail}</p>
              <div className="agent-run-card__track" aria-hidden="true"><i style={{ width: `${run.branches.length ? Math.round(run.completedBranchCount / run.branches.length * 100) : 0}%` }} /></div>
              <details className="agent-task-panel__details">
                <summary aria-label="查看分支详情" title="查看分支详情"><ChecklistIcon /><span>{run.branches.length}</span></summary>
                <div className="agent-task-panel__summary" aria-label="分支状态汇总"><span aria-label={`${run.branches.filter((branch) => branch.status === 'succeeded').length} 项完成`} title="完成"><AgentBranchStatusIcon status="succeeded" /><b>{run.branches.filter((branch) => branch.status === 'succeeded').length}</b></span><span aria-label={`${run.branches.filter((branch) => branch.status === 'running').length} 项生成中`} title="生成中"><AgentBranchStatusIcon status="running" /><b>{run.branches.filter((branch) => branch.status === 'running').length}</b></span><span aria-label={`${run.branches.filter((branch) => branch.status === 'queued').length} 项排队`} title="排队"><AgentBranchStatusIcon status="queued" /><b>{run.branches.filter((branch) => branch.status === 'queued').length}</b></span><span aria-label={`${run.branches.filter((branch) => branch.status === 'failed' || branch.status === 'cancelled').length} 项失败`} title="失败"><AgentBranchStatusIcon status="failed" /><b>{run.branches.filter((branch) => branch.status === 'failed' || branch.status === 'cancelled').length}</b></span></div>
                <div className="agent-task-panel__matrix" aria-label="批量分支矩阵">{run.branches.map((branch, index) => <div key={branch.id} className={`is-${branch.status}`} aria-label={`${branch.label} · ${botanicAgentBranchStatusLabel(branch.status)}`} title={`${branch.label} · ${botanicAgentBranchStatusLabel(branch.status)}`}><span>{index + 1}</span><AgentBranchStatusIcon status={branch.status} /></div>)}</div>
              </details>
              {run.branches.filter((branch) => branch.status === 'failed' || branch.status === 'cancelled').map((branch) => <div className="agent-task-panel__branch" key={branch.id}><span><strong>{branch.label}</strong><small>{branch.error ?? '该分支未完成'}</small></span><AgentFailureRecoveryActions
                branch={branch}
                generationModels={generationModels}
                retrying={retryingBranchId === branch.id}
                menuOpen={recoveryModelMenuKey === `${run.id}:${branch.id}`}
                onToggleModelMenu={() => setRecoveryModelMenuKey((current) => current === `${run.id}:${branch.id}` ? '' : `${run.id}:${branch.id}`)}
                onPrepare={(mode, model) => prepareFailedRunRecovery(run, mode, model)}
                onRetry={() => { setRetryingBranchId(branch.id); void onRetryBranch(run.id, branch.id).finally(() => setRetryingBranchId('')) }}
              /></div>)}
            </article>
            })}
            {!filteredRunTimeline.length ? <div className="agent-panel__empty">{runTimeline.length ? '当前筛选下没有任务。' : '还没有 Agent 任务。'}</div> : null}
          </div>
        </section> : null}
        {skillPanelOpen ? <section className="agent-skill-panel" aria-label="系统与项目 Skill">
          <header><div><small>SKILL REGISTRY</small><h2>创作技能</h2></div><span>{systemSkills.length + skills.length} 个</span></header>
          <p>在输入框键入 @ 即可调用 Skill。新建的项目 Skill 会自动挂载到当前对话。</p>
          {systemSkills.length ? <div className="agent-skill-panel__catalog"><strong>系统 Skills</strong>{systemSkills.map((skill) => <article key={skill.id}><span><SparkleIcon /><b>{skill.name}</b></span><small>{skill.instructions}</small></article>)}</div> : null}
          {!skillFormOpen && !skillConfirming && !skillError ? <button type="button" className="agent-skill-panel__create-entry" aria-expanded="false" onClick={() => setSkillFormOpen(true)}>＋ 新建技能</button> : <div className="agent-skill-panel__form">
              <input value={skillName} onChange={(event) => { setSkillName(event.target.value); setSkillConfirming(false); setSkillError('') }} maxLength={80} placeholder="技能名称，例如：夏日换景" aria-label="Skill 名称" autoFocus />
              <textarea value={skillInstructions} onChange={(event) => { setSkillInstructions(event.target.value); setSkillConfirming(false); setSkillError('') }} maxLength={4000} placeholder="描述必须保持什么、允许改变什么，以及结果规则。" aria-label="Skill 规则" />
              {skillConfirming ? <div className="agent-skill-panel__confirm">
                <span><strong>创建项目 Skill</strong><small>将写入当前项目，之后可被 Agent 调用。</small></span>
                <div><button type="button" autoFocus onClick={() => { setSkillConfirming(false); requestAnimationFrame(() => skillCreateButtonRef.current?.focus()) }}>取消</button><button type="button" disabled={skillSaving} onClick={() => void confirmSkillCreation()}>{skillSaving ? '创建中…' : '确认创建'}</button></div>
              </div> : <div className="agent-skill-panel__form-actions"><button ref={skillCreateButtonRef} type="button" className="agent-skill-panel__cancel" onClick={() => { setSkillFormOpen(false); setSkillError('') }}>取消</button><button type="button" className="agent-skill-panel__create" disabled={!skillName.trim() || !skillInstructions.trim()} onClick={() => setSkillConfirming(true)}>创建 Skill</button></div>}
              {skillError ? <p role="alert">{skillError}</p> : null}
            </div>}
          <div className="agent-skill-panel__list">
            {skills.map((skill) => <article key={skill.id}><strong>{skill.name}</strong><p>{skill.instructions}</p><small>项目 Skill · 可自动调用</small></article>)}
            {!skills.length && !skillError ? <div className="agent-panel__empty">还没有项目 Skill。</div> : null}
          </div>
        </section> : null}
        {!utilityPanelOpen && !hasMessages ? <section className="agent-workspace__welcome">
          <span className="agent-workspace__mark"><SparkleIcon /></span>
          <small>BOTANIC AGENT</small>
          <h2>{target ? `继续优化「${agentTargetDisplayLabel(target)}」` : '今天一起创作什么？'}</h2>
          <p>{target ? '保留当前画面与原始配方，仅调整你刚提出的内容。' : '可以日常对话、生成 Prompt、检索项目，也可以直接描述生图目标。'}</p>
          <div className="agent-workspace__starters">
            {agentQuickActions.slice(0, 3).map((action) => <button key={action.intent} type="button" onClick={() => { setIntent(action.intent); setInstruction(action.instruction) }}><strong>{action.label}</strong><span>{action.instruction}</span></button>)}
          </div>
        </section> : null}
        {!utilityPanelOpen && readingRestoreNotice ? <div className="agent-reading-restore" role="status"><span>已回到上次阅读位置</span><button type="button" onClick={jumpToLatestConversation}>跳到最新</button></div> : null}
        {!utilityPanelOpen && session ? conversationMessages.map((message) => <div
          key={message.id}
          ref={(node) => registerMessageNode(message.id, node)}
          className={`agent-conversation-anchor${locatedMessageId === message.id ? ' is-located' : ''}`}
          tabIndex={-1}
          data-agent-message-id={message.id}
        ><AgentConversationMessage
          message={message}
          sessionId={session.id}
          runs={runs}
          artifacts={artifacts}
          contextOptionIds={contextOptions.map((item) => item.id)}
          generationModels={generationModels}
          planning={planning}
          promptUsePending={pendingPromptSourceIds.has(message.id)}
          plannerModel={plannerModel}
          executingActionId={executingActionId}
          submittingMessageId={submittingMessageId}
          promptDraft={promptDrafts[message.id]}
          onContinueResultContext={(nodeIds, outputCount) => {
            onUseResultContext(nodeIds)
            setInstruction(outputCount === 1 ? '继续优化这张结果：' : outputCount > 1 ? `继续优化这 ${outputCount} 张结果：` : '继续基于当前上下文创作：')
            setActiveUtilityPanel(null)
            requestAnimationFrame(() => composerTextareaRef.current?.focus())
          }}
          onShowResults={() => setActiveUtilityPanel('result')}
          onShowTask={showTaskForRun}
          onFocusNodes={onFocusNodes}
          onAnswerClarification={(targetMessage, answers) => void answerClarification(targetMessage, answers)}
          onLocateNode={onLocateNode}
          onConfirmAction={(targetMessage, action) => void confirmAction(targetMessage, action)}
          onDismissAction={(targetMessage, action) => onUpdateAction(session.id, targetMessage.id, action.id, { status: 'dismissed' })}
          onPromptDraftChange={(messageId, prompt) => setPromptDrafts((current) => ({ ...current, [messageId]: prompt }))}
          onCommitPlanPrompt={commitPlanPrompt}
          onConfirmPlan={(targetMessage) => void confirmMessagePlan(targetMessage)}
          onUsePrompt={usePromptForGeneration}
          onEdit={(content) => { setInstruction(content); requestAnimationFrame(() => composerTextareaRef.current?.focus()) }}
          onRetryDelivery={retryMessage}
          onFeedback={(targetMessage, feedback) => onUpdateMessage(session.id, targetMessage.id, { feedback })}
        /></div>) : null}
        {!utilityPanelOpen && showRuntimeFeed ? (() => {
          const livePhase = runtimePhase === 'reading' || runtimePhase === 'planning' || runtimePhase === 'executing'
          return <section className={`agent-runtime-feed is-${runtimeSummary.phase}${runtimeFailed ? ' is-failed' : runtimeComplete ? ' is-complete' : ''}`} data-phase={runtimeSummary.phase} role="status" aria-live={livePhase ? 'polite' : undefined} aria-label="Agent 运行记录">
            <header className="agent-runtime-feed__header">
              <span className="agent-runtime-feed__status">
                <span className="agent-runtime-feed__mark" aria-hidden="true">
                  {livePhase && !runtimeFailed ? <span className="agent-composer__spinner" /> : runtimeFailed ? <AlertIcon /> : runtimeComplete ? <CheckIcon /> : <ClockIcon />}
                </span>
                <strong>{runtimeSummary.label}</strong>
                {runtimeSummary.totalCount ? <small>{runtimeSummary.completedCount}/{runtimeSummary.totalCount}</small> : null}
              </span>
              <button type="button" className="agent-runtime-feed__toggle" aria-label={runtimeDetailsOpen ? '收起运行步骤' : '查看运行步骤'} title={runtimeDetailsOpen ? '收起运行步骤' : '查看运行步骤'} aria-expanded={runtimeDetailsOpen} aria-controls={runtimeStepsId} onClick={() => setRuntimeDetailsOpen((open) => !open)}>
                <ChecklistIcon />
              </button>
            </header>
            <p className="agent-runtime-feed__summary">{runtimeSummary.detail}</p>
            {runtimeSummary.phase === 'waiting_clarification' || runtimeSummary.phase === 'waiting_confirmation' || runtimeSummary.phase === 'waiting_reference' || runtimeSummary.phase === 'draft_ready' ? <span className="agent-runtime-feed__next">下一步：{runtimeSummary.nextAction}</span> : null}
            {runtimeDetailsOpen ? <ol id={runtimeStepsId} aria-label="运行步骤">
              {runtimeSteps.map((step) => <li key={step.id} className={`is-${step.status}`}>
                <span className="agent-runtime-feed__step-marker" aria-hidden="true">{agentRuntimeStepMarker(step)}</span>
                <span className="agent-runtime-feed__step-copy"><strong>{step.status === 'running' ? `正在${step.label}` : step.label}</strong><small>{step.error ?? step.detail}</small></span>
                <em>{agentRuntimeStepStatusLabel(step.status)}</em>
              </li>)}
            </ol> : null}
          </section>
        })() : null}
        {!utilityPanelOpen && latestRun?.branches.length && latestRunFeedback && ['queued', 'running', 'executing'].includes(latestRun.status) ? <section className={`agent-run-card is-${latestRunFeedback.tone}`} aria-label="Agent Run 实时进度">
          <header><span><strong>生成任务</strong><small>{latestRunFeedback.label}</small></span><div>{latestRun.status === 'queued' || latestRun.status === 'running' || latestRun.status === 'executing' ? <button type="button" className="agent-icon-button agent-icon-button--danger" aria-label="取消任务" title="取消任务" disabled={cancellingRunId === latestRun.id} onClick={() => { setCancellingRunId(latestRun.id); setError(''); void onCancelRun(latestRun.id).then((ok) => { if (!ok) setError('任务取消失败，请稍后重试。') }).catch(() => setError('任务取消失败，请稍后重试。')).finally(() => setCancellingRunId('')) }}>{cancellingRunId === latestRun.id ? <span className="agent-workspace__mini-spinner" /> : <CloseIcon />}</button> : <button type="button" className="agent-run-card__feedback-action" aria-label={latestRunFeedback.actionLabel} title={latestRunFeedback.actionLabel} onClick={() => openRunFeedback(latestRun)}><AgentRunActionIcon label={latestRunFeedback.actionLabel} /></button>}<b>{latestRun.completedBranchCount}/{latestRun.branches.length}</b></div></header>
          <p className="agent-run-card__feedback">{latestRunFeedback.detail}</p>
          <div className="agent-run-card__track" aria-hidden="true"><i style={{ width: `${Math.round(latestRun.completedBranchCount / latestRun.branches.length * 100)}%` }} /></div>
          <div className="agent-run-card__branches">
            {latestRun.branches.map((branch) => <div key={branch.id}><span><strong>{branch.label}</strong><small>{botanicAgentBranchStatusLabel(branch.status)}</small></span>{branch.status === 'failed' || branch.status === 'cancelled' ? <AgentFailureRecoveryActions
              branch={branch}
              generationModels={generationModels}
              retrying={retryingBranchId === branch.id}
              menuOpen={recoveryModelMenuKey === `${latestRun.id}:${branch.id}`}
              onToggleModelMenu={() => setRecoveryModelMenuKey((current) => current === `${latestRun.id}:${branch.id}` ? '' : `${latestRun.id}:${branch.id}`)}
              onPrepare={(mode, model) => prepareFailedRunRecovery(latestRun, mode, model)}
              onRetry={() => { setRetryingBranchId(branch.id); setError(''); void onRetryBranch(latestRun.id, branch.id).then((ok) => { if (!ok) setError(`「${branch.label}」重试失败，请稍后再试。`) }).finally(() => setRetryingBranchId('')) }}
            /> : null}</div>)}
          </div>
        </section> : null}
        <div ref={messageEndRef} />
      </div>
      {!utilityPanelOpen ? <AgentComposer
        session={session}
        contextItems={contextItems}
        mentionQuery={mentionQuery}
        mentionOptions={mentionOptions}
        skillOptions={skillOptions}
        mountedSkills={mountedSkillOptions}
        instruction={instruction}
        error={error}
        canRetry={Boolean(lastFailedPlanMessageId || lastFailedInstruction)}
        retrying={planning || submittingMessageId === lastFailedPlanMessageId}
        planning={planning}
        contextMenuOpen={contextMenuOpen}
        modeMenuOpen={modeMenuOpen}
        contextMenuId={contextMenuId}
        modeMenuId={modeMenuId}
        plannerModel={plannerModel}
        plannerModels={plannerModels}
        groupId={groupId}
        compatibleGroups={compatibleGroups}
        imageContextOptions={imageContextOptions}
        textareaRef={composerTextareaRef}
        fileInputRef={agentFileInputRef}
        contextMenuButtonRef={contextMenuButtonRef}
        modeMenuButtonRef={modeMenuButtonRef}
        onRemoveContext={(itemId) => session && onContextChange(session.id, session.contextNodeIds.filter((id) => id !== itemId))}
        onRemoveMountedSkill={(skillId) => session && onSkillsChange(session.id, (session.mountedSkillIds ?? []).filter((id) => id !== skillId))}
        onSelectMention={selectMention}
        onSelectSkill={selectSkill}
        onCreateSkill={openSkillCreation}
        onDismissMention={() => setMentionQuery(undefined)}
        onInstructionChange={(value, caret) => { setInstruction(value); setMentionQuery(readBotanicAgentMentionQuery(value, caret)); setError(''); setLastFailedInstruction(''); setLastFailedPlanMessageId('') }}
        onInstructionClick={(caret) => setMentionQuery(readBotanicAgentMentionQuery(instruction, caret))}
        onRetry={lastFailedPlanMessageId ? retryLastFailedPlan : retryLastInstruction}
        onImportFiles={(files) => void importImageFiles(files)}
        onToggleContextMenu={() => setContextMenuOpen((open) => !open)}
        onCloseContextMenu={() => { setContextMenuOpen(false); requestAnimationFrame(() => contextMenuButtonRef.current?.focus()) }}
        onToggleModeMenu={() => setModeMenuOpen((open) => !open)}
        onPlannerModelChange={(model) => { if (session) onPlannerModelChange(session.id, model) }}
        onGroupChange={setGroupId}
        onSend={() => void sendInstruction()}
        onToggleImageContext={(itemId, selected) => { if (!session) return; onContextChange(session.id, selected ? session.contextNodeIds.filter((id) => id !== itemId) : [...session.contextNodeIds, itemId]) }}
        onExecutionModeChange={(mode) => { if (session) onExecutionModeChange(session.id, mode); setModeMenuOpen(false); requestAnimationFrame(() => modeMenuButtonRef.current?.focus()) }}
      /> : null}
    </aside>
  )
}
