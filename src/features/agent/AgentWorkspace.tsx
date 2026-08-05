import { type DragEvent, useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from 'react'
import {
  botanicAgentBranchStatusLabel,
  botanicAgentContextSnapshotNodeIds,
  botanicAgentRunFeedback,
  botanicAgentSubmissionKey,
  buildBotanicAgentPlan,
  createBotanicAgentContextSnapshot,
  creativeDimensionLabel,
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
  type BotanicAgentSession,
  type BotanicAgentSkill,
} from '../../domain/agent'
import { classifyBotanicAgentRequest } from '../../domain/agentChatContract'
import { nextExclusiveSurface, type ExclusiveSurfaceAction } from '../../domain/exclusiveSurface'
import type {
  AssetGroup,
  GenerationModelOption,
  GenerationSettings,
  UploadedAssetInput,
} from '../../domain/canvas'
import { createProjectAgentSkill, listProjectAgentSkills, requestBotanicAgentChat, requestBotanicAgentPlan } from '../../lib/agentApi'
import { ProductApiError } from '../../lib/productSession'
import { maxUploadAssets, readUploadedAssetInput, validateUploadFiles } from '../../lib/uploadedAssets'
import { useCanvasStore } from '../../store/canvasStore'
import { BotanicSelect } from '../../components/BotanicSelect'
import { AgentPlannerProviderIcon } from '../../components/AgentPlannerProviderIcon'
import {
  agentPlannerModelLabel,
  agentPlannerModelShortLabel,
  defaultAgentPlannerModels,
  modelDisplayLabel,
} from '../../components/generationModelPresentation'
import {
  AgentClarificationCard,
  AgentFailureRecoveryActions,
  AgentPromptDiff,
  agentRunOutputCount,
  agentRuntimeStepMarker,
  agentRuntimeStepStatusLabel,
  agentToolStatusLabel,
  createInitialAgentClarification,
} from './AgentWorkspaceParts'
import { agentComposerStateReducer, initialAgentComposerState } from './agentComposerState'
import { useAgentMessageDelivery } from './useAgentMessageDelivery'
import { useAgentRuntimeTrace } from './useAgentRuntimeTrace'
import type { AgentArtifactIndexState, AgentContextItem, AgentDockTarget } from './agentWorkspace.types'
import { AgentMemoryPanel, AgentResultPanel } from './AgentUtilityPanels'
import {
  ArrowUpIcon,
  AutoRunIcon,
  BookmarkIcon,
  ChecklistIcon,
  CloseIcon,
  CopyIcon,
  EditIcon,
  FigmaIcon,
  FocusIcon,
  GalleryIcon,
  PlusIcon,
  PlusSquareIcon,
  SparkleIcon,
  ThumbDownIcon,
  ThumbUpIcon,
  UploadIcon,
} from '../../components/BotanicIcons'
import historyIcon from '../../assets/figma/icon-history.svg'

type AgentTransientSurface = 'context' | 'history' | 'utility' | 'mode'
type AgentUtilityPanel = 'result' | 'task' | 'memory' | 'skill'

function agentTargetDisplayLabel(target?: AgentDockTarget) {
  if (!target) return ''
  const primaryReference = target.rootRecipe.references.find((reference) => reference.primary)
    ?? target.rootRecipe.references[0]
  const referenceName = primaryReference?.name?.trim()
  if (referenceName) return referenceName
  return target.label.trim().replace(/^@+/, '').replace(/\s+\+\d+\b.*$/u, '')
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
  onCreateDraft,
  onUploadImages,
  onAppendMessage,
  onUpdateMessage,
  onUpdateAction,
  onContextChange,
  onExecutionModeChange,
  onAddMemory,
  onRemoveMemory,
  onNewSession,
  onSelectSession,
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
  persistenceStatus,
  onClose,
}: {
  projectId: string
  escapeEnabled: boolean
  persistenceStatus: 'saved' | 'saving' | 'offline' | 'conflict' | 'error'
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
  onCreateDraft: (instruction: string, contextNodeIds: string[], autoExecute: boolean, generationOverrides?: Partial<Pick<GenerationSettings, 'model' | 'aspectRatio' | 'resolution'>>) => Promise<{ created: boolean; started: boolean; needsReference: boolean }>
  onUploadImages: (uploads: UploadedAssetInput[]) => void
  onAppendMessage: (sessionId: string, message: BotanicAgentMessage) => void
  onUpdateMessage: (sessionId: string, messageId: string, patch: Partial<Pick<BotanicAgentMessage, 'content' | 'runId' | 'status' | 'feedback' | 'plan' | 'question' | 'deliveryStatus'>>) => void
  onUpdateAction: (sessionId: string, messageId: string, actionId: string, patch: Partial<Pick<BotanicAgentActionProposal, 'status' | 'error' | 'result'>>) => void
  onContextChange: (sessionId: string, contextNodeIds: string[]) => void
  onExecutionModeChange: (sessionId: string, mode: BotanicAgentExecutionMode) => void
  onAddMemory: (kind: BotanicAgentMemoryKind, content: string, sourceNodeIds?: string[]) => string | null
  onRemoveMemory: (memoryId: string) => void
  onNewSession: () => string
  onSelectSession: (sessionId: string) => void
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
  onClose: () => void
}) {
  const [intent, setIntent] = useState<BotanicAgentIntent>('replace_scene')
  const [groupId, setGroupId] = useState('')
  const [plannerModelPreference, setPlannerModel] = useState(plannerModels[0] ?? defaultAgentPlannerModels[0])
  const plannerModel = plannerModels.includes(plannerModelPreference)
    ? plannerModelPreference
    : plannerModels[0] ?? defaultAgentPlannerModels[0]
  const [composerState, updateComposerState] = useReducer(agentComposerStateReducer, initialAgentComposerState)
  const { instruction, error, lastFailedInstruction, lastFailedPlanMessageId, mentionQuery, pendingGenerationOverrides } = composerState
  const setInstruction = useCallback((value: string) => updateComposerState({ instruction: value }), [])
  const setError = useCallback((value: string) => updateComposerState({ error: value }), [])
  const setLastFailedInstruction = useCallback((value: string) => updateComposerState({ lastFailedInstruction: value }), [])
  const setLastFailedPlanMessageId = useCallback((value: string) => updateComposerState({ lastFailedPlanMessageId: value }), [])
  const setMentionQuery = useCallback((value?: BotanicAgentMentionQuery) => updateComposerState({ mentionQuery: value }), [])
  const setPendingGenerationOverrides = useCallback((value: Partial<Pick<GenerationSettings, 'model' | 'aspectRatio' | 'resolution'>>) => updateComposerState({ pendingGenerationOverrides: value }), [])
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
  const skillPanelOpen = activeUtilityPanel === 'skill'
  const taskPanelOpen = activeUtilityPanel === 'task'
  const resultPanelOpen = activeUtilityPanel === 'result'
  const memoryPanelOpen = activeUtilityPanel === 'memory'
  const [skills, setSkills] = useState<BotanicAgentSkill[]>([])
  const [skillName, setSkillName] = useState('')
  const [skillInstructions, setSkillInstructions] = useState('')
  const [skillConfirming, setSkillConfirming] = useState(false)
  const [skillSaving, setSkillSaving] = useState(false)
  const [skillError, setSkillError] = useState('')
  const [persistenceAction, setPersistenceAction] = useState<'retry' | 'refresh' | ''>('')
  const [promptDrafts, setPromptDrafts] = useState<Record<string, string>>({})
  const [recoveryModelMenuKey, setRecoveryModelMenuKey] = useState('')
  const plannerControllerRef = useRef<AbortController | null>(null)
  const agentMountedRef = useRef(true)
  const isCurrentAgentProject = useCallback(
    () => agentMountedRef.current && useCanvasStore.getState().document.id === projectId,
    [projectId],
  )
  const { appendMessage } = useAgentMessageDelivery({
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
  const compatibleGroups = groups.filter((group) => group.role === agentGroupRole(intent) && group.assetIds.length)
  const contextItems = contextOptions.filter((item) => session?.contextNodeIds.includes(item.id))
  const imageContextOptions = contextOptions.filter((item) => (
    (item.kind === '素材' || item.kind === '结果')
    && Boolean(item.image)
    && (item.mediaKind ?? 'image') === 'image'
  ))
  const hasMessages = Boolean(session?.messages.length)
  const mentionOptions = useMemo(() => {
    if (!mentionQuery) return []
    const query = mentionQuery.query.trim().toLocaleLowerCase()
    return contextOptions
      .filter((item) => item.kind === '素材' && Boolean(item.image))
      .filter((item) => !query || item.label.toLocaleLowerCase().includes(query))
      .slice(0, 6)
  }, [contextOptions, mentionQuery])
  const utilityPanelOpen = taskPanelOpen || skillPanelOpen || resultPanelOpen || memoryPanelOpen
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
  const latestRunOutputCount = latestRun ? agentRunOutputCount(latestRun, artifacts) : 0
  const latestRunFeedback = latestRun ? botanicAgentRunFeedback(latestRun.status, latestRunOutputCount, latestRun.error) : undefined
  // 提交任务后以 Run 卡作为唯一任务状态来源；规划/追问阶段仍显示 Runtime 摘要。
  const showRuntimeFeed = runtimeSteps.length > 0 && (!latestRun?.branches.length || !['executing', 'completed', 'failed'].includes(runtimePhase))

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
  }, [])

  useEffect(() => {
    if (!skillPanelOpen) return
    let active = true
    setSkillError('')
    void listProjectAgentSkills(projectId).then((items) => {
      if (active) setSkills(items)
    }).catch((caught) => {
      if (active) setSkillError(caught instanceof Error ? caught.message : 'Skill 列表加载失败。')
    })
    return () => { active = false }
  }, [projectId, skillPanelOpen])

  useEffect(() => {
    const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
    messageEndRef.current?.scrollIntoView({ block: 'end', behavior })
  }, [session?.messages.length, latestRun?.updatedAt, planning, runtimeSteps.length, runtimeSteps[runtimeSteps.length - 1]?.status])

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
    const feedback = botanicAgentRunFeedback(run.status, agentRunOutputCount(run, artifacts), run.error)
    openUtilityPanel(feedback.action === 'view_results' ? 'result' : 'task')
  }

  useEffect(() => {
    if (!session) return
    for (const run of runs) {
      const outputCount = agentRunOutputCount(run, artifacts)
      // 终态消息优先取已有的 run 卡；计划消息只负责承载提交前的确认状态。
      const linkedMessage = session.messages.find((message) => message.runId === run.id && message.kind === 'run')
        ?? session.messages.find((message) => message.runId === run.id)
      const feedback = botanicAgentRunFeedback(run.status, outputCount, run.error)
      const noticeKey = feedback.terminal ? `${run.status}:${outputCount}` : run.status
      const previousNoticeKey = runNoticeStatusRef.current.get(run.id)
      const content = feedback.detail

      if (!linkedMessage && previousNoticeKey === undefined) {
        appendMessage({ role: 'assistant', kind: feedback.terminal ? 'run' : 'notice', runId: run.id, content })
        runNoticeStatusRef.current.set(run.id, noticeKey)
      } else if (linkedMessage && feedback.terminal && previousNoticeKey !== undefined && previousNoticeKey !== noticeKey) {
        if (linkedMessage.kind === 'run') onUpdateMessage(session.id, linkedMessage.id, { content })
        else appendMessage({ role: 'assistant', kind: 'run', runId: run.id, content })
        runNoticeStatusRef.current.set(run.id, noticeKey)
      } else if (previousNoticeKey === undefined) {
        // 已有提交提示的历史会话：记住当前状态，后续只在状态变化时追加结果。
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
  }, [artifacts, onFocusNodes, onUpdateMessage, runs, session])

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
      setSkillName('')
      setSkillInstructions('')
      setSkillConfirming(false)
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

  const preparePlan = async (
    cleanInstruction: string,
    generationOverrides?: Partial<Pick<GenerationSettings, 'model' | 'aspectRatio' | 'resolution'>>,
    clarificationAnswers?: Record<string, string>,
  ): Promise<BotanicAgentPlan | BotanicAgentClarificationResponse | null> => {
    if (!target || !isCurrentAgentProject()) return null
    const assetGroup = compatibleGroups.find((group) => group.id === groupId)
    const input = {
      projectId,
      plannerModel,
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
          setLastFailedInstruction(cleanInstruction)
        }
      } else {
        const message = planError instanceof Error ? planError.message : '暂时无法生成计划。'
        setError(message)
        setLastFailedPlanMessageId('')
        setLastFailedInstruction(cleanInstruction)
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
      appendMessage({
        role: 'assistant', kind: submission.started ? 'notice' : 'text', runId: submission.runId,
        content: submission.started ? '任务已提交。结果会直接出现在画布中，你可以继续告诉我下一步要改什么。' : '任务没有启动，请检查参考素材与生成服务后重试。',
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
    options: {
      appendUser?: string
      generationOverrides?: Partial<Pick<GenerationSettings, 'model' | 'aspectRatio' | 'resolution'>>
      clarificationAnswers?: Record<string, string>
    } = {},
  ) => {
    if (!session || planning || !isCurrentAgentProject()) return
    if (options.appendUser) appendMessage({ role: 'user', kind: 'text', content: options.appendUser })
    setError('')
    setLastFailedInstruction('')
    setLastFailedPlanMessageId('')

    const route = classifyBotanicAgentRequest(cleanInstruction, Boolean(target))
    if (route !== 'generation') {
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
        appendMessage({ role: 'assistant', kind: 'text', content: `${response.answer}${sourceNote}` })
      } catch (caught) {
        if (controller.signal.aborted) return
        const message = caught instanceof Error ? caught.message : 'Agent 暂时无法回答，请稍后重试。'
        failRuntimeTrace(message)
        setError(message)
        setLastFailedPlanMessageId('')
        setLastFailedInstruction(cleanInstruction)
      } finally {
        if (plannerControllerRef.current === controller) plannerControllerRef.current = null
        setPlanning(false)
      }
      return
    }
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
      const instructionMentionsSettings = /(?:1\s*:\s*1|16\s*:\s*9|4\s*:\s*3|3\s*:\s*4|4\s*:\s*5|9\s*:\s*16|\b1k\b|\b2k\b|分辨率|比例|模型|gpt[- ]?image|minimax|h3)/iu.test(cleanInstruction)
      if (!options.clarificationAnswers && !instructionMentionsSettings) {
        updateRuntimeStep('call-planner', 'succeeded')
        updateRuntimeStep('create-workflow', 'running')
        await yieldRuntimeFrame()
        if (!isCurrentAgentProject()) return
        updateRuntimeStep('create-workflow', 'succeeded')
        setRuntimePhase('waiting_clarification')
        appendMessage({
          role: 'assistant',
          kind: 'question',
          question: createInitialAgentClarification(cleanInstruction, generationModels),
          status: 'pending',
          content: '先确认一下输出设置。',
        })
        setPlanning(false)
        return
      }
      try {
        const result = await onCreateDraft(cleanInstruction, session.contextNodeIds, session.executionMode === 'auto', options.generationOverrides)
        if (!isCurrentAgentProject()) return
        const content = result.started
          ? '已根据画布上下文创建工作流并提交生成，结果会出现在画布中。'
          : result.needsReference
            ? '已在画布创建生成节点。再添加一张商品图或参考图，我就可以继续执行。'
              : result.created
                ? '已在画布创建可编辑的生成工作流，你可以检查节点后手动生成。'
                : '暂时无法创建工作流，请检查画布状态后重试。'
        if (result.created) {
          await completeRuntimeTrace(false)
        } else {
          updateRuntimeStep('call-planner', 'succeeded')
          updateRuntimeStep('create-workflow', 'failed', content)
        }
        appendMessage({ role: 'assistant', kind: result.created ? 'notice' : 'text', content })
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : '暂时无法创建工作流。'
        failRuntimeTrace(message)
        setError(message)
        setLastFailedPlanMessageId('')
        setLastFailedInstruction(cleanInstruction)
      } finally {
        setPlanning(false)
      }
      return
    }
    const nextPlan = await preparePlan(cleanInstruction, options.generationOverrides, options.clarificationAnswers)
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
    const retryInstruction = lastFailedInstruction.trim()
    if (!retryInstruction || planning || sendingInstructionRef.current) return
    sendingInstructionRef.current = true
    setError('')
    setLastFailedInstruction('')
    setLastFailedPlanMessageId('')
    setInstruction('')
    setMentionQuery(undefined)
    setPendingGenerationOverrides({})
    void runInstruction(retryInstruction).finally(() => {
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
      generationOverrides: {
        ...(answers.model ? { model: answers.model } : {}),
        ...(answers.aspect_ratio ? { aspectRatio: answers.aspect_ratio as GenerationSettings['aspectRatio'] } : {}),
        ...(answers.resolution ? { resolution: answers.resolution as GenerationSettings['resolution'] } : {}),
      },
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
  const persistenceCopy = persistenceStatus === 'conflict'
    ? { title: '画布有新的云端版本', detail: '本地草稿仍保留，生成任务与结果不会丢失。', action: 'refresh' as const, actionLabel: '使用云端版本' }
    : persistenceStatus === 'offline'
      ? { title: '正在使用离线草稿', detail: '恢复网络后会继续同步当前编辑。', action: 'retry' as const, actionLabel: '重试同步' }
      : { title: '画布同步暂时失败', detail: '当前编辑仍在本地，稍后可以继续同步。', action: 'retry' as const, actionLabel: '重试同步' }
  const resolvePersistenceIssue = () => {
    setPersistenceAction(persistenceCopy.action)
    const task = persistenceCopy.action === 'refresh' ? onRefreshRemote() : onRetryPersistence()
    void task.catch(() => undefined).finally(() => setPersistenceAction(''))
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
          <button type="button" className="agent-workspace__history-button" onClick={(event) => { historyTriggerRef.current = event.currentTarget; setUtilityMenuOpen(false); setHistoryOpen((open) => !open) }} aria-controls={historyMenuId} aria-expanded={historyOpen} aria-label="对话历史" title="对话历史"><FigmaIcon src={historyIcon} /></button>
          <button type="button" className="agent-workspace__title-button" onClick={(event) => { historyTriggerRef.current = event.currentTarget; setUtilityMenuOpen(false); setHistoryOpen((open) => !open) }} aria-controls={historyMenuId} aria-expanded={historyOpen}>{session?.title ?? '新建对话'} <span aria-hidden="true">⌄</span></button>
        </div>
        <div className="agent-workspace__header-actions">
          {persistenceIssue ? <button
            type="button"
            className={`agent-workspace__persistence-status is-${persistenceStatus}`}
            aria-label={`${persistenceCopy.title}。${persistenceAction ? '处理中' : persistenceCopy.actionLabel}`}
            title={`${persistenceCopy.title} · ${persistenceCopy.actionLabel}`}
            disabled={Boolean(persistenceAction)}
            onClick={resolvePersistenceIssue}
          ><span aria-hidden="true">{persistenceStatus === 'conflict' ? '!' : '·'}</span></button> : null}
          <div ref={utilityMenuRef} className="agent-workspace__utility-menu-wrap">
            <button ref={utilityMenuButtonRef} type="button" className={`agent-workspace__utility-menu-button${utilityPanelOpen ? ' is-active' : ''}`} aria-haspopup="menu" aria-expanded={utilityMenuOpen} aria-controls={utilityMenuId} aria-label="Agent 工具" title="Agent 工具" onClick={() => { setUtilityMenuOpen((open) => !open); setHistoryOpen(false) }}><ChecklistIcon /></button>
            {utilityMenuOpen ? <div id={utilityMenuId} className="agent-workspace__utility-menu" role="menu" aria-label="Agent 工具">
              <button type="button" role="menuitem" className={resultPanelOpen ? 'is-active' : ''} onClick={() => toggleUtilityPanel('result')}><GalleryIcon /><span>结果与文件</span></button>
              <button type="button" role="menuitem" className={taskPanelOpen ? 'is-active' : ''} onClick={() => toggleUtilityPanel('task')}><ChecklistIcon /><span>Agent 任务</span></button>
              <button type="button" role="menuitem" className={memoryPanelOpen ? 'is-active' : ''} onClick={() => toggleUtilityPanel('memory')}><BookmarkIcon /><span>项目记忆</span></button>
              <button type="button" role="menuitem" className={skillPanelOpen ? 'is-active' : ''} onClick={() => toggleUtilityPanel('skill')}><SparkleIcon /><span>创作技能</span></button>
              <button type="button" role="menuitem" className="is-danger" onClick={() => { setUtilityMenuOpen(false); onClose() }}><CloseIcon /><span>关闭 Agent</span></button>
            </div> : null}
          </div>
        </div>
        {historyOpen ? <div id={historyMenuId} className="agent-workspace__history" aria-label="对话历史">
          <button type="button" onClick={() => { onNewSession(); setHistoryOpen(false) }}><PlusSquareIcon /> 新建对话</button>
          {sessions.map((item) => <button key={item.id} type="button" className={item.id === session?.id ? 'is-active' : ''} onClick={() => { onSelectSession(item.id); setHistoryOpen(false) }}><span>{item.title}</span><small>{item.messages.length} 条</small></button>)}
        </div> : null}
      </header>
      <div className="agent-workspace__messages" role="log" aria-live="polite" aria-relevant="additions text">
        {resultPanelOpen ? <AgentResultPanel
          artifacts={artifacts}
          runs={runs}
          latestRun={latestRun}
          contextOptions={contextOptions}
          artifactIndexStatus={artifactIndexStatus}
          artifactIndexHasMore={artifactIndexHasMore}
          onLocateNode={onLocateNode}
          onSaveArtifact={onSaveArtifact}
          onContinue={continueFromArtifact}
          onStartNextRound={createNextRoundFromResults}
          onLoadMoreArtifacts={onLoadMoreArtifacts}
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
          <div className="agent-task-panel__list">
            {runs.map((run) => {
              const outputCount = agentRunOutputCount(run, artifacts)
              const feedback = botanicAgentRunFeedback(run.status, outputCount, run.error)
              const active = run.status === 'queued' || run.status === 'running' || run.status === 'executing'
              return <article key={run.id} className={`is-${run.status} is-${feedback.tone}`}>
              <header><span><strong>{run.plan.summary}</strong><small>{feedback.label}</small></span><div>{active ? <button type="button" className="agent-icon-button agent-icon-button--danger" aria-label="取消任务" title="取消任务" disabled={cancellingRunId === run.id} onClick={() => { setCancellingRunId(run.id); void onCancelRun(run.id).finally(() => setCancellingRunId('')) }}>{cancellingRunId === run.id ? <span className="agent-workspace__mini-spinner" /> : <CloseIcon />}</button> : <button type="button" className="agent-task-panel__feedback-action" onClick={() => openRunFeedback(run)}>{feedback.actionLabel}</button>}<b>{run.completedBranchCount}/{run.branches.length}</b></div></header>
              <p className="agent-task-panel__feedback">{feedback.detail}</p>
              <div className="agent-run-card__track" aria-hidden="true"><i style={{ width: `${run.branches.length ? Math.round(run.completedBranchCount / run.branches.length * 100) : 0}%` }} /></div>
              <div className="agent-task-panel__summary" aria-label="分支状态汇总"><span><b>{run.branches.filter((branch) => branch.status === 'succeeded').length}</b>完成</span><span><b>{run.branches.filter((branch) => branch.status === 'running').length}</b>生成中</span><span><b>{run.branches.filter((branch) => branch.status === 'queued').length}</b>排队</span><span><b>{run.branches.filter((branch) => branch.status === 'failed' || branch.status === 'cancelled').length}</b>失败</span></div>
              <div className="agent-task-panel__matrix" aria-label="批量分支矩阵">{run.branches.map((branch, index) => <div key={branch.id} className={`is-${branch.status}`} title={`${branch.label} · ${botanicAgentBranchStatusLabel(branch.status)}`}><span>{index + 1}</span><small>{branch.label}</small></div>)}</div>
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
            {!runs.length ? <div className="agent-skill-panel__empty">还没有 Agent 任务。</div> : null}
          </div>
        </section> : null}
        {skillPanelOpen ? <section className="agent-skill-panel" aria-label="项目 Skill">
          <header><div><small>PROJECT SKILLS</small><h2>创作技能</h2></div><span>{skills.length} 个</span></header>
          <p>把常用的锁定项和创作规则保存到当前项目，Agent 规划时可自动调用。</p>
          <div className="agent-skill-panel__form">
            <input value={skillName} onChange={(event) => { setSkillName(event.target.value); setSkillConfirming(false); setSkillError('') }} maxLength={80} placeholder="技能名称，例如：夏日换景" aria-label="Skill 名称" />
            <textarea value={skillInstructions} onChange={(event) => { setSkillInstructions(event.target.value); setSkillConfirming(false); setSkillError('') }} maxLength={4000} placeholder="描述必须保持什么、允许改变什么，以及结果规则。" aria-label="Skill 规则" />
            {skillConfirming ? <div className="agent-skill-panel__confirm">
              <span><strong>创建项目 Skill</strong><small>将写入当前项目，之后可被 Agent 调用。</small></span>
              <div><button type="button" autoFocus onClick={() => { setSkillConfirming(false); requestAnimationFrame(() => skillCreateButtonRef.current?.focus()) }}>取消</button><button type="button" disabled={skillSaving} onClick={() => void confirmSkillCreation()}>{skillSaving ? '创建中…' : '确认创建'}</button></div>
            </div> : <button ref={skillCreateButtonRef} type="button" className="agent-skill-panel__create" disabled={!skillName.trim() || !skillInstructions.trim()} onClick={() => setSkillConfirming(true)}>创建 Skill</button>}
            {skillError ? <p role="alert">{skillError}</p> : null}
          </div>
          <div className="agent-skill-panel__list">
            {skills.map((skill) => <article key={skill.id}><strong>{skill.name}</strong><p>{skill.instructions}</p><small>项目 Skill · 可自动调用</small></article>)}
            {!skills.length && !skillError ? <div className="agent-skill-panel__empty">还没有项目 Skill。</div> : null}
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
        {!utilityPanelOpen ? session?.messages.map((message) => <article key={message.id} className={`agent-message is-${message.role} is-${message.kind}`}>
          <div className="agent-message__role">{message.role === 'assistant' ? <SparkleIcon /> : <span>你</span>}</div>
          <div className="agent-message__body">
            {!message.question ? <p>{message.content}</p> : null}
            {message.role === 'user' && message.deliveryStatus === 'queued' ? <small className="agent-message__delivery-status" role="status">待同步</small> : null}
            {message.role === 'user' && message.deliveryStatus === 'failed' ? <small className="agent-message__delivery-status is-failed" role="status">同步失败，请检查权限</small> : null}
            {message.kind === 'run' && message.runId ? (() => {
              const linkedRun = runs.find((run) => run.id === message.runId)
              const outputNodeIds = artifacts
                .filter((artifact) => artifact.provenance.runId === message.runId)
                .flatMap((artifact) => artifact.provenance.sourceNodeIds ?? [])
              const lockedContextIds = botanicAgentContextSnapshotNodeIds(linkedRun?.plan.contextSnapshot, contextOptions.map((item) => item.id))
              const continueNodeIds = [...new Set(outputNodeIds.length ? outputNodeIds : lockedContextIds)]
              return continueNodeIds.length ? <div className="agent-run-message__actions" aria-label="结果操作">
                <button type="button" onClick={() => {
                  onUseResultContext(continueNodeIds)
                  setInstruction(outputNodeIds.length === 1 ? '继续优化这张结果：' : outputNodeIds.length > 1 ? `继续优化这 ${outputNodeIds.length} 张结果：` : '继续基于当前上下文创作：')
                  setActiveUtilityPanel(null)
                  requestAnimationFrame(() => composerTextareaRef.current?.focus())
                }}>继续修改</button>
                {outputNodeIds.length ? <button type="button" onClick={() => {
                  setActiveUtilityPanel('result')
                }}>查看结果</button> : null}
                {outputNodeIds.length ? <button type="button" onClick={() => onFocusNodes(outputNodeIds)}>定位画布</button> : null}
              </div> : null
            })() : null}
            {message.question ? <AgentClarificationCard
              clarification={message.question}
              generationModels={generationModels}
              state={message.status === 'answered' ? 'completed' : planning ? 'submitting' : 'idle'}
              onSubmit={(answers) => void answerClarification(message, answers)}
            /> : null}
            {message.plan ? <div className="agent-message__plan">
              {message.plan.toolCalls?.length ? <div className="agent-message__tools" aria-label="Agent 工具调用">
                {message.plan.toolCalls.map((call) => <div key={call.id} className={`agent-message__tool is-${call.status}`}>
                  <span aria-hidden="true">↳</span><strong>{call.label}</strong><small>{agentToolStatusLabel(call.status)}</small>
                </div>)}
              </div> : null}
              {message.plan.actions?.length ? <div className="agent-message__actions" aria-label="待确认行动">
                {message.plan.actions.map((action) => <article key={action.id} className={`agent-action-card is-${action.status}`}>
                  <header><span>{action.kind === 'skill' ? 'SKILL' : 'MCP'}</span><small>{action.risk === 'external' ? '外部调用' : action.toolName === 'skill_create' ? '写入项目' : '写入画布'}</small></header>
                  <strong>{action.label}</strong>
                  <p>{action.summary}</p>
                  <div className="agent-action-card__impact"><span>输入</span><b>{action.toolName === 'mcp_call' ? `${String(action.arguments.server)}.${String(action.arguments.tool)}` : action.toolName === 'skill_create' ? '新项目 Skill' : '当前项目 Skill'}</b><span>输出</span><b>{action.toolName === 'mcp_call' ? '文件 / 画布节点' : action.toolName === 'skill_create' ? '可复用 Skill' : '工作流规则节点'}</b></div>
                  <details className="agent-action-card__details"><summary>查看执行内容</summary><pre>{JSON.stringify(action.arguments, null, 2)}</pre></details>
                  {action.error ? <small className="agent-action-card__error">{action.error}</small> : null}
                  {action.status === 'succeeded' ? <div className="agent-action-card__result"><span>已执行</span>{action.result?.canvasNodeIds?.length ? <small>已创建 {action.result.canvasNodeIds.length} 个画布节点</small> : action.result?.artifacts?.length ? <small>已产出 {action.result.artifacts.length} 项</small> : null}{action.result?.canvasNodeId ? <button type="button" className="agent-icon-button" aria-label="在画布定位结果" title="在画布定位" onClick={() => onLocateNode(action.result!.canvasNodeId!)}><FocusIcon /></button> : null}</div> : null}
                  {action.status === 'dismissed' ? <span className="agent-action-card__dismissed">已跳过</span> : null}
                  {action.status === 'running' ? <div className="agent-action-card__running"><span>执行状态待确认</span><button type="button" disabled={executingActionId === action.id} onClick={() => void confirmAction(message, action)}>{executingActionId === action.id ? '确认中…' : '确认状态'}</button></div> : null}
                  {action.status === 'awaiting_confirmation' || action.status === 'failed' ? <div className="agent-action-card__buttons">
                    {action.status === 'awaiting_confirmation' ? <button type="button" className="is-secondary" onClick={() => session && onUpdateAction(session.id, message.id, action.id, { status: 'dismissed' })}>跳过</button> : null}
                    <button type="button" disabled={executingActionId === action.id} onClick={() => void confirmAction(message, action)}>{executingActionId === action.id ? '执行中…' : action.status === 'failed' ? '重试' : '确认执行'}</button>
                  </div> : null}
                </article>)}
              </div> : null}
              <section className="agent-prompt-review" aria-label="润色后的提示词">
                <header><span><strong>生成前确认</strong><small>已按 Botanic 结构整理</small></span><b>可编辑</b></header>
                <div className="agent-prompt-review__original"><small>原始要求</small><p>{message.plan.instruction}</p></div>
                <label><span>润色后提示词</span><textarea
                  value={promptDrafts[message.id] ?? message.plan.prompt}
                  onChange={(event) => setPromptDrafts((current) => ({ ...current, [message.id]: event.target.value }))}
                  onBlur={(event) => commitPlanPrompt(message, event.currentTarget.value)}
                  maxLength={6000}
                  aria-label="润色后提示词"
                /></label>
                <AgentPromptDiff original={message.plan.instruction} revised={promptDrafts[message.id] ?? message.plan.prompt} />
                <div className="agent-prompt-review__actions">
                  <button type="button" className="is-secondary" onClick={() => { setPromptDrafts((current) => ({ ...current, [message.id]: message.plan!.instruction })); commitPlanPrompt(message, message.plan!.instruction) }}>用原文</button>
                  <button type="button" className="is-secondary" onClick={() => { setPromptDrafts((current) => ({ ...current, [message.id]: message.plan!.prompt })); commitPlanPrompt(message, message.plan!.prompt) }}>恢复润色</button>
                </div>
              </section>
              <div className="agent-message__constraints">
                {message.plan.constraints.map((constraint) => <span key={constraint.dimension} className={constraint.mode === 'preserve' ? 'is-locked' : 'is-variable'}>{constraint.mode === 'preserve' ? '锁定' : '变化'} · {creativeDimensionLabel(constraint.dimension)}</span>)}
              </div>
              <div className="agent-plan-settings" aria-label="本次生成设置">
                <span><small>模型</small><b>{modelDisplayLabel(generationModels.find((model) => model.id === message.plan!.settings.model)) || message.plan.settings.model}</b></span>
                <span><small>比例</small><b>{message.plan.settings.aspectRatio}</b></span>
                <span><small>清晰度</small><b>{message.plan.settings.resolution}</b></span>
                <span><small>输出</small><b>{message.plan.output.mode === 'batch_by_asset' ? `${message.plan.output.count} 个分支` : '1 个版本'}</b></span>
              </div>
              <small>{message.plan.references.length} 个输入 · {message.plan.output.mode === 'batch_by_asset' ? `${message.plan.output.count} 个分支` : '1 个新版本'}</small>
              {message.plan.contextSnapshot?.length ? <small className="agent-plan__context-lock">已锁定上下文 · {message.plan.contextSnapshot.slice(0, 3).map((item) => item.label).join('、')}{message.plan.contextSnapshot.length > 3 ? ` 等 ${message.plan.contextSnapshot.length} 项` : ''}</small> : null}
              <details className="agent-message__route"><summary>执行路由</summary><div><span>规划</span><b>{agentPlannerModelLabel(message.plan.plannerModel ?? plannerModel)}</b><span>生成</span><b>{message.plan.settings.model}</b><span>外部行动</span><b>{message.plan.actions?.length ? `${message.plan.actions.length} 项，确认后执行` : '无'}</b></div></details>
              {message.status !== 'submitted' ? <><small className="agent-plan__confirm-hint">确认后才会提交生成任务，当前设置仍可在上方编辑。</small><button type="button" disabled={submittingMessageId === message.id || message.plan.actions?.some((action) => action.status === 'awaiting_confirmation' || action.status === 'running')} onClick={() => void confirmMessagePlan(message)}>{submittingMessageId === message.id ? '正在提交…' : message.plan.actions?.some((action) => action.status === 'awaiting_confirmation' || action.status === 'running') ? '先处理行动卡' : message.status === 'failed' ? '重新提交计划' : '确认并生成'}</button></> : <span className="agent-message__submitted">已提交</span>}
            </div> : null}
          </div>
          <div className="agent-message__utilities">
            {message.role === 'user' ? <button type="button" aria-label="编辑消息" title="编辑消息" onClick={() => { setInstruction(message.content); requestAnimationFrame(() => composerTextareaRef.current?.focus()) }}><EditIcon /></button> : null}
            {message.role === 'assistant' && session ? <>
              <button type="button" className={message.feedback === 'positive' ? 'is-selected' : ''} aria-label="这个回答有帮助" title="有帮助" onClick={() => onUpdateMessage(session.id, message.id, { feedback: message.feedback === 'positive' ? undefined : 'positive' })}><ThumbUpIcon /></button>
              <button type="button" className={message.feedback === 'negative' ? 'is-selected' : ''} aria-label="这个回答需要改进" title="需改进" onClick={() => onUpdateMessage(session.id, message.id, { feedback: message.feedback === 'negative' ? undefined : 'negative' })}><ThumbDownIcon /></button>
            </> : null}
            <button type="button" aria-label="复制消息" title="复制消息" onClick={() => void navigator.clipboard.writeText(message.content)}><CopyIcon /></button>
          </div>
        </article>) : null}
        {!utilityPanelOpen && showRuntimeFeed ? (() => {
          const livePhase = runtimePhase === 'reading' || runtimePhase === 'planning' || runtimePhase === 'executing'
          return <section className={`agent-runtime-feed is-${runtimeSummary.phase}${runtimeFailed ? ' is-failed' : runtimeComplete ? ' is-complete' : ''}`} data-phase={runtimeSummary.phase} role="status" aria-live={livePhase ? 'polite' : undefined} aria-label="Agent 运行记录">
            <header className="agent-runtime-feed__header">
              <span className="agent-runtime-feed__status">
                <span className="agent-runtime-feed__mark" aria-hidden="true">
                  {livePhase && !runtimeFailed ? <span className="agent-composer__spinner" /> : runtimeFailed ? '!' : runtimeComplete ? '✓' : '·'}
                </span>
                <strong>{runtimeSummary.label}</strong>
                {runtimeSummary.totalCount ? <small>{runtimeSummary.completedCount}/{runtimeSummary.totalCount}</small> : null}
              </span>
              <button type="button" className="agent-runtime-feed__toggle" aria-expanded={runtimeDetailsOpen} onClick={() => setRuntimeDetailsOpen((open) => !open)}>
                {runtimeDetailsOpen ? '收起记录' : '查看记录'}
              </button>
            </header>
            <p className="agent-runtime-feed__summary">{runtimeSummary.detail}</p>
            {runtimeSummary.phase === 'waiting_clarification' || runtimeSummary.phase === 'waiting_confirmation' ? <span className="agent-runtime-feed__next">下一步：{runtimeSummary.nextAction}</span> : null}
            {runtimeDetailsOpen ? <ol aria-label="运行步骤">
              {runtimeSteps.map((step) => <li key={step.id} className={`is-${step.status}`}>
                <span className="agent-runtime-feed__step-marker" aria-hidden="true">{agentRuntimeStepMarker(step)}</span>
                <span className="agent-runtime-feed__step-copy"><strong>{step.status === 'running' ? `正在${step.label}` : step.label}</strong><small>{step.error ?? step.detail}</small></span>
                <em>{agentRuntimeStepStatusLabel(step.status)}</em>
              </li>)}
            </ol> : null}
          </section>
        })() : null}
        {!utilityPanelOpen && latestRun?.branches.length && latestRunFeedback ? <section className={`agent-run-card is-${latestRunFeedback.tone}`} aria-label="Agent Run 实时进度">
          <header><span><strong>生成任务</strong><small>{latestRunFeedback.label}</small></span><div>{latestRun.status === 'queued' || latestRun.status === 'running' || latestRun.status === 'executing' ? <button type="button" className="agent-icon-button agent-icon-button--danger" aria-label="取消任务" title="取消任务" disabled={cancellingRunId === latestRun.id} onClick={() => { setCancellingRunId(latestRun.id); setError(''); void onCancelRun(latestRun.id).then((ok) => { if (!ok) setError('任务取消失败，请稍后重试。') }).catch(() => setError('任务取消失败，请稍后重试。')).finally(() => setCancellingRunId('')) }}>{cancellingRunId === latestRun.id ? <span className="agent-workspace__mini-spinner" /> : <CloseIcon />}</button> : <button type="button" className="agent-run-card__feedback-action" onClick={() => openRunFeedback(latestRun)}>{latestRunFeedback.actionLabel}</button>}<b>{latestRun.completedBranchCount}/{latestRun.branches.length}</b></div></header>
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
      {!utilityPanelOpen ? <div className="agent-composer">
        {contextItems.length ? <div className="agent-composer__context">{contextItems.map((item) => <button key={item.id} type="button" aria-label={`移除 ${item.label}`} title={`移除 ${item.label}`} onClick={() => session && onContextChange(session.id, session.contextNodeIds.filter((id) => id !== item.id))}>{item.image ? <img src={item.image} alt="" /> : <span>{item.kind.slice(0, 1)}</span>}<i aria-hidden="true">×</i></button>)}</div> : null}
        {mentionQuery ? <div className="agent-composer__mention-menu" role="group" aria-label="引用画布内容" onPointerDown={(event) => event.stopPropagation()}>
          {mentionOptions.map((item) => <button key={item.id} type="button" onMouseDown={(event) => event.preventDefault()} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); selectMention(item) }}>{item.image ? <img src={item.image} alt="" /> : <span>{item.kind.slice(0, 1)}</span>}<b>{item.label}</b><small>{item.kind}</small></button>)}
          {!mentionOptions.length ? <p>没有匹配的素材</p> : null}
        </div> : null}
        <textarea ref={composerTextareaRef} value={instruction} onChange={(event) => { const value = event.target.value; setInstruction(value); setMentionQuery(readBotanicAgentMentionQuery(value, event.target.selectionStart ?? value.length)); setError(''); setLastFailedInstruction(''); setLastFailedPlanMessageId('') }} onClick={(event) => setMentionQuery(readBotanicAgentMentionQuery(instruction, event.currentTarget.selectionStart ?? instruction.length))} onKeyDown={(event) => {
          if (event.key === 'Escape' && mentionQuery) { event.preventDefault(); setMentionQuery(undefined); return }
          if (event.key === 'Enter' && mentionQuery && mentionOptions[0]) { event.preventDefault(); selectMention(mentionOptions[0]); return }
          if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendInstruction() }
        }} placeholder="和 Agent 聊天、生成 Prompt 或描述创作需求，@ 引用画布内容" aria-label="Agent 消息" />
        {error ? <div className="agent-composer__error" role="alert"><span>{error}</span>{lastFailedPlanMessageId || lastFailedInstruction ? <button type="button" onClick={lastFailedPlanMessageId ? retryLastFailedPlan : retryLastInstruction} disabled={planning || submittingMessageId === lastFailedPlanMessageId}>重试</button> : null}</div> : null}
        <input
          ref={agentFileInputRef}
          className="asset-file-input"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          aria-label="从电脑添加图片素材"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? [])
            event.currentTarget.value = ''
            void importImageFiles(files)
          }}
        />
        <div className="agent-composer__toolbar">
          <div>
            <button ref={contextMenuButtonRef} type="button" className="agent-composer__add" onClick={() => setContextMenuOpen((open) => !open)} aria-controls={contextMenuId} aria-expanded={contextMenuOpen} aria-label="添加图像素材" title="添加图像素材"><PlusIcon /></button>
            <button ref={modeMenuButtonRef} type="button" className="agent-composer__mode" onClick={() => setModeMenuOpen((open) => !open)} aria-controls={modeMenuId} aria-expanded={modeMenuOpen} aria-label={session?.executionMode === 'auto' ? '自动执行' : '手动确认'} title={session?.executionMode === 'auto' ? '自动执行' : '手动确认'}>
              {session?.executionMode === 'auto' ? <AutoRunIcon /> : <ChecklistIcon />}<span className="agent-composer__mode-label" aria-hidden="true">{session?.executionMode === 'auto' ? '自动生成' : '手动确认'}</span><span className="agent-composer__mode-chevron" aria-hidden="true">⌄</span>
            </button>
            <BotanicSelect
              className="agent-composer__model-select"
              value={plannerModel}
              ariaLabel={`Agent 模型：${agentPlannerModelLabel(plannerModel)}`}
              menuWidth={220}
              options={plannerModels.map((model) => ({ value: model, label: agentPlannerModelLabel(model) }))}
              onChange={setPlannerModel}
              renderTrigger={(selected) => <span className="agent-model-trigger" title={agentPlannerModelShortLabel(selected?.value ?? plannerModel)}><AgentPlannerProviderIcon model={selected?.value ?? plannerModel} /><span className="agent-model-trigger__label">{agentPlannerModelShortLabel(selected?.value ?? plannerModel)}</span></span>}
              renderOption={(option, selected) => <span className="agent-model-option"><span className="agent-model-option__main"><AgentPlannerProviderIcon model={option.value} /><span>{option.label}</span></span>{selected ? <b aria-hidden="true">✓</b> : null}</span>}
            />
            {compatibleGroups.length ? <BotanicSelect className="agent-composer__group-select" value={groupId} placeholder="素材组" ariaLabel="批量素材组" options={[{ value: '', label: '单张' }, ...compatibleGroups.map((group) => ({ value: group.id, label: `${group.name} · ${group.assetIds.length}` }))]} onChange={setGroupId} renderTrigger={(selected) => <span className="agent-group-trigger" title={selected?.label ?? '单张'}><strong>{selected?.value ? '组' : '1'}</strong></span>} /> : null}
          </div>
          <button type="button" className="agent-composer__send" disabled={!instruction.trim() || planning || !session} onClick={() => void sendInstruction()} aria-label="发送给 Agent">{planning ? <span className="agent-composer__spinner" /> : <ArrowUpIcon />}</button>
        </div>
        {contextMenuOpen ? <div id={contextMenuId} className="agent-composer__context-menu" role="group" aria-label="添加图像素材" onPointerDown={(event) => event.stopPropagation()}>
          <header><strong>添加图像素材</strong><button type="button" aria-label="关闭添加图像素材" onClick={() => { setContextMenuOpen(false); requestAnimationFrame(() => contextMenuButtonRef.current?.focus()) }}><CloseIcon /></button></header>
          <div className="agent-composer__context-upload">
            <button type="button" onClick={() => agentFileInputRef.current?.click()}><UploadIcon /><span><b>从电脑选择图片</b><small>也可以直接拖入 Agent 面板</small></span></button>
          </div>
          {imageContextOptions.length ? imageContextOptions.map((item) => { const selected = session?.contextNodeIds.includes(item.id) ?? false; return <button key={item.id} type="button" className={selected ? 'is-selected' : ''} aria-pressed={selected} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); if (!session) return; onContextChange(session.id, selected ? session.contextNodeIds.filter((id) => id !== item.id) : [...session.contextNodeIds, item.id]) }}>{item.image ? <img src={item.image} alt="" /> : null}<span><b>{item.label}</b><small>{item.kind}</small></span>{selected ? <i aria-hidden="true">✓</i> : null}</button> }) : <p>暂无图像素材，可从电脑选择或直接拖入。</p>}
        </div> : null}
        {modeMenuOpen ? <div id={modeMenuId} className="agent-composer__mode-menu" role="group" aria-label="执行模式">
          <button type="button" className={session?.executionMode === 'manual' ? 'is-selected' : ''} onClick={() => { if (session) onExecutionModeChange(session.id, 'manual'); setModeMenuOpen(false); requestAnimationFrame(() => modeMenuButtonRef.current?.focus()) }}><ChecklistIcon /><span><strong>手动确认</strong><small>执行生成前先确认锁定项</small></span></button>
          <button type="button" className={session?.executionMode === 'auto' ? 'is-selected' : ''} onClick={() => { if (session) onExecutionModeChange(session.id, 'auto'); setModeMenuOpen(false); requestAnimationFrame(() => modeMenuButtonRef.current?.focus()) }}><AutoRunIcon /><span><strong>自动执行</strong><small>规划完成后直接创建任务</small></span></button>
        </div> : null}
      </div> : null}
    </aside>
  )
}
