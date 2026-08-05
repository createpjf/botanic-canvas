import { type DragEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  appendBotanicAgentMessage,
  botanicAgentBranchStatusLabel,
  botanicAgentContextSnapshotNodeIds,
  botanicAgentRunFeedback,
  botanicAgentSubmissionKey,
  buildBotanicAgentPlan,
  buildBotanicAgentPromptDiff,
  createBotanicAgentContextSnapshot,
  createBotanicAgentRuntimeSteps,
  creativeDimensionLabel,
  insertBotanicAgentMention,
  readBotanicAgentMentionQuery,
  resolveBotanicAgentResultSelection,
  restoreBotanicAgentRuntimeSteps,
  summarizeBotanicAgentRuntime,
  updateBotanicAgentRuntimeStep,
  type BotanicAgentActionProposal,
  type BotanicAgentActionResult,
  type BotanicAgentArtifact,
  type BotanicAgentClarification,
  type BotanicAgentClarificationField,
  type BotanicAgentClarificationResponse,
  type BotanicAgentExecutionMode,
  type BotanicAgentIntent,
  type BotanicAgentMemoryItem,
  type BotanicAgentMemoryKind,
  type BotanicAgentMentionQuery,
  type BotanicAgentMessage,
  type BotanicAgentPlan,
  type BotanicAgentPromptDiffSegment,
  type BotanicAgentRun,
  type BotanicAgentRuntimePhase,
  type BotanicAgentRuntimeStep,
  type BotanicAgentSession,
  type BotanicAgentSkill,
  type BotanicIndexedArtifact,
} from '../../domain/agent'
import { classifyBotanicAgentRequest } from '../../domain/agentChatContract'
import { nextExclusiveSurface, type ExclusiveSurfaceAction } from '../../domain/exclusiveSurface'
import type {
  AssetGroup,
  AssetRole,
  AssetSource,
  GenerationMediaKind,
  GenerationModelOption,
  GenerationRecipe,
  GenerationSettings,
  UploadedAssetInput,
} from '../../domain/canvas'
import { createProjectAgentSkill, listProjectAgentSkills, requestBotanicAgentChat, requestBotanicAgentPlan, submitPersistentBotanicAgentMessage } from '../../lib/agentApi'
import { createAgentMessageQueue, createLocalStorageAgentMessageQueueStorage } from '../../lib/agentMessageQueue'
import { downloadMedia } from '../../lib/mediaDownload'
import { ProductApiError, serverPersistenceEnabled } from '../../lib/productSession'
import { maxUploadAssets, readUploadedAssetInput, validateUploadFiles } from '../../lib/uploadedAssets'
import { useCanvasStore } from '../../store/canvasStore'
import { BotanicSelect } from '../../components/BotanicSelect'
import { AgentPlannerProviderIcon } from '../../components/AgentPlannerProviderIcon'
import {
  agentPlannerModelLabel,
  agentPlannerModelShortLabel,
  defaultAgentPlannerModels,
  modelDisplayLabel,
  modelProviderLogo,
} from '../../components/generationModelPresentation'
import {
  ArrowUpIcon,
  ArrowUpRightIcon,
  AutoRunIcon,
  BookmarkIcon,
  ChecklistIcon,
  CloseIcon,
  CopyIcon,
  DeleteIcon,
  DownloadIcon,
  EditIcon,
  FigmaIcon,
  FocusIcon,
  FolderOutlineIcon,
  GalleryIcon,
  PlusIcon,
  PlusSquareIcon,
  RefreshIcon,
  SparkleIcon,
  ThumbDownIcon,
  ThumbUpIcon,
  UploadIcon,
} from '../../components/BotanicIcons'
import historyIcon from '../../assets/figma/icon-history.svg'

export type AgentDockTarget = {
  id: string
  label: string
  image: string
  rootRecipe: GenerationRecipe
}

type AgentTransientSurface = 'context' | 'history' | 'utility' | 'mode'

function agentTargetDisplayLabel(target?: AgentDockTarget) {
  if (!target) return ''
  const primaryReference = target.rootRecipe.references.find((reference) => reference.primary)
    ?? target.rootRecipe.references[0]
  const referenceName = primaryReference?.name?.trim()
  if (referenceName) return referenceName
  return target.label.trim().replace(/^@+/, '').replace(/\s+\+\d+\b.*$/u, '')
}

export type AgentArtifactIndexState = {
  projectId: string
  artifacts: BotanicIndexedArtifact[]
  nextBefore?: string
  status: 'idle' | 'loading' | 'loading-more' | 'ready' | 'error'
}

export type AgentContextItem = {
  id: string
  label: string
  kind: '素材' | '结果' | '文字' | '节点'
  image?: string
  assetId?: string
  role?: AssetRole
  mediaKind?: GenerationMediaKind
  source?: AssetSource
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

function agentToolStatusLabel(status: NonNullable<BotanicAgentPlan['toolCalls']>[number]['status']) {
  if (status === 'succeeded') return '已完成'
  if (status === 'failed') return '失败'
  if (status === 'awaiting_confirmation') return '待确认'
  if (status === 'running') return '执行中'
  return '待执行'
}

function agentRuntimeStepStatusLabel(status: BotanicAgentRuntimeStep['status']) {
  if (status === 'succeeded') return '已完成'
  if (status === 'failed') return '失败'
  if (status === 'running') return '执行中'
  return '待执行'
}

function agentRuntimeStepMarker(step: BotanicAgentRuntimeStep) {
  if (step.status === 'succeeded') return '✓'
  if (step.status === 'failed') return '!'
  if (step.status === 'running') return '·'
  if (step.kind === 'search') return '⌕'
  if (step.kind === 'write') return '↗'
  return '○'
}

function agentMemoryKindLabel(kind: BotanicAgentMemoryKind) {
  if (kind === 'approved') return '已确认方向'
  if (kind === 'avoid') return '避免事项'
  return '长期规则'
}

function agentArtifactKindLabel(artifact: BotanicAgentArtifact) {
  if (artifact.kind === 'image') return '图片'
  if (artifact.kind === 'video') return '视频'
  if (artifact.kind === 'workflow') return '工作流'
  if (artifact.kind === 'asset_group') return '素材组'
  if (artifact.kind === 'file') return '文件'
  return '文本'
}

function agentRunOutputCount(run: BotanicAgentRun, artifacts: BotanicAgentArtifact[]) {
  const persistedCount = artifacts.filter((artifact) => artifact.provenance.runId === run.id).length
  const branchCount = run.branches.reduce((total, branch) => total + branch.outputCount, 0)
  return Math.max(persistedCount, branchCount)
}

function AgentClarificationCard({
  clarification,
  generationModels,
  state,
  onSubmit,
}: {
  clarification: BotanicAgentClarification
  generationModels: GenerationModelOption[]
  state: 'idle' | 'submitting' | 'completed'
  onSubmit: (answers: Record<string, string>) => void
}) {
  const [answers, setAnswers] = useState<Record<string, string>>(() => Object.fromEntries(
    clarification.fields.flatMap((field) => field.defaultValue ? [[field.id, field.defaultValue]] : []),
  ))
  const selectedModel = generationModels.find((model) => model.id === answers.model)
  const fields = clarification.fields.map((field) => {
    const values = field.id === 'aspect_ratio' && selectedModel?.aspectRatios?.length
      ? selectedModel.aspectRatios
      : field.id === 'resolution' && selectedModel?.resolutions?.length
        ? selectedModel.resolutions
        : undefined
    const options = values
      ? values.map((value) => ({ value, label: value, description: value === field.defaultValue ? '推荐' : undefined }))
      : field.options
    return { ...field, options }
  })
  const complete = fields.every((field) => !field.required || Boolean(answers[field.id]) && field.options.some((option) => option.value === answers[field.id]))
  const selectionSummary = fields
    .map((field) => field.options.find((option) => option.value === answers[field.id])?.label)
    .filter(Boolean)
    .join(' · ')
  const selectOption = (fieldId: BotanicAgentClarificationField['id'], value: string) => {
    setAnswers((current: Record<string, string>) => {
      const next: Record<string, string> = { ...current, [fieldId]: value }
      if (fieldId !== 'model') return next
      const model = generationModels.find((item) => item.id === value)
      for (const dependent of fields.filter((field) => field.id === 'aspect_ratio' || field.id === 'resolution')) {
        const supported = dependent.id === 'aspect_ratio' ? model?.aspectRatios : model?.resolutions
        if (supported?.length && !supported.some((item) => item === next[dependent.id])) next[dependent.id] = supported[0]
      }
      return next
    })
  }
  if (state === 'completed') {
    return (
      <section className="agent-clarification-card is-complete" aria-label="已确认的输出设置" aria-live="polite">
        <span className="agent-clarification-card__complete-mark" aria-hidden="true">✓</span>
        <span className="agent-clarification-card__complete-copy">
          <strong>输出设置已确认</strong>
          {selectionSummary ? <small>{selectionSummary}</small> : null}
        </span>
      </section>
    )
  }
  const disabled = state === 'submitting'
  return (
    <section className="agent-clarification-card" aria-label="生成前参数确认">
      <div className="agent-clarification-card__intro">
        <header><strong>确认输出设置</strong><small>确认后继续规划，不会立即生成</small></header>
        <p>{clarification.question}</p>
      </div>
      <div className="agent-clarification-card__fields">
        {fields.map((field) => <fieldset key={field.id} data-field={field.id}>
          <legend>{field.label}</legend>
          <div role="group" aria-label={field.label}>
            {field.options.map((option) => <button
              key={option.value}
              type="button"
              aria-pressed={answers[field.id] === option.value}
              className={answers[field.id] === option.value ? 'is-selected' : ''}
              disabled={disabled}
              onClick={() => selectOption(field.id, option.value)}
            ><span>{option.label}</span>{option.description ? <small>{option.description}</small> : null}</button>)}
          </div>
        </fieldset>)}
      </div>
      <footer className="agent-clarification-card__footer">
        {clarification.helper ? <small className="agent-clarification-card__helper">{clarification.helper}</small> : <span />}
        <button type="button" className="agent-clarification-card__submit" disabled={disabled || !complete} onClick={() => onSubmit(answers)}>{disabled ? '正在规划…' : '继续规划'}</button>
      </footer>
    </section>
  )
}

function AgentPromptDiff({ original, revised }: { original: string; revised: string }) {
  const segments = buildBotanicAgentPromptDiff(original, revised)
  const changed = segments.some((segment) => segment.kind !== 'same')
  const renderSegment = (segment: BotanicAgentPromptDiffSegment, index: number) => {
    if (segment.kind === 'added') return <ins key={`${segment.kind}-${index}`}>{segment.text}</ins>
    if (segment.kind === 'removed') return <del key={`${segment.kind}-${index}`}>{segment.text}</del>
    return <span key={`${segment.kind}-${index}`}>{segment.text}</span>
  }
  return (
    <section className="agent-prompt-review__diff" aria-label="提示词变化">
      <header><span>原文与润色差异</span><b>{changed ? '已突出变化' : '未改动'}</b></header>
      <p>{segments.length ? segments.map(renderSegment) : '暂无提示词内容'}</p>
    </section>
  )
}

function AgentFailureRecoveryActions({
  branch,
  generationModels,
  retrying,
  menuOpen,
  onToggleModelMenu,
  onRetry,
  onPrepare,
}: {
  branch: BotanicAgentRun['branches'][number]
  generationModels: GenerationModelOption[]
  retrying: boolean
  menuOpen: boolean
  onToggleModelMenu: () => void
  onRetry: () => void
  onPrepare: (mode: 'settings' | 'model', model?: GenerationModelOption) => void
}) {
  return (
    <div className="agent-recovery-actions" aria-label={`${branch.label} 恢复操作`}>
      <button type="button" className="is-retry" disabled={retrying} onClick={onRetry} title="复用同一任务，不会创建重复任务">
        {retrying ? <span className="agent-workspace__mini-spinner" /> : <RefreshIcon />}<span>重试当前分支</span>
      </button>
      <button type="button" onClick={() => onPrepare('settings')} title="只预填修改要求，不会立即提交">修改参数</button>
      <span className="agent-recovery-model-picker">
        <button type="button" aria-expanded={menuOpen} onClick={onToggleModelMenu} title="只预填模型，不会立即提交">更换模型</button>
        {menuOpen ? <div className="agent-recovery-model-menu" role="group" aria-label="选择恢复模型" onPointerDown={(event) => event.stopPropagation()}>
          {generationModels.map((model) => <button key={model.id} type="button" onClick={() => onPrepare('model', model)}>
            <span>{modelProviderLogo(model) ? <img src={modelProviderLogo(model)} alt="" /> : null}<b>{modelDisplayLabel(model)}</b></span>
          </button>)}
          {!generationModels.length ? <small>暂无可用模型</small> : null}
        </div> : null}
      </span>
    </div>
  )
}

function createInitialAgentClarification(instruction: string, models: GenerationModelOption[]): BotanicAgentClarification {
  const available = models.length ? models : [{ id: 'gpt-image-2', label: 'GPT Image 2' }]
  const current = available[0]
  const ratios = current.aspectRatios?.length ? current.aspectRatios : ['1:1', '3:4', '4:3', '16:9', '9:16']
  const resolutions = current.resolutions?.length ? current.resolutions : ['1K', '2K']
  return {
    id: `clarification-local-${crypto.randomUUID()}`,
    question: '为了让第一张图更接近你的目标，先确认一下输出设置。',
    helper: '不确定时可以保留推荐值，之后仍可在生成节点里修改。',
    originalInstruction: instruction,
    fields: [
      { id: 'model', label: '生成模型', required: true, defaultValue: current.id, options: available.map((model) => ({ value: model.id, label: model.label, description: model.mediaKind === 'video' ? '视频生成' : '图片生成' })) },
      { id: 'aspect_ratio', label: '画面比例', required: true, defaultValue: ratios[0], options: ratios.map((value) => ({ value, label: value })) },
      { id: 'resolution', label: '分辨率', required: true, defaultValue: resolutions[0], options: resolutions.map((value) => ({ value, label: value })) },
    ],
  }
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
  const [instruction, setInstruction] = useState('')
  const [groupId, setGroupId] = useState('')
  const [plannerModel, setPlannerModel] = useState(plannerModels[0] ?? defaultAgentPlannerModels[0])
  const [error, setError] = useState('')
  const [lastFailedInstruction, setLastFailedInstruction] = useState('')
  const [lastFailedPlanMessageId, setLastFailedPlanMessageId] = useState('')
  const [planning, setPlanning] = useState(false)
  const [runtimeSteps, setRuntimeSteps] = useState<BotanicAgentRuntimeStep[]>([])
  const [runtimePhase, setRuntimePhase] = useState<BotanicAgentRuntimePhase>('idle')
  const [runtimeDetailsOpen, setRuntimeDetailsOpen] = useState(false)
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
  const [skillPanelOpen, setSkillPanelOpen] = useState(false)
  const [taskPanelOpen, setTaskPanelOpen] = useState(false)
  const [resultPanelOpen, setResultPanelOpen] = useState(false)
  const [resultFilter, setResultFilter] = useState<'all' | 'image' | 'video' | 'file'>('all')
  const [selectedArtifactIds, setSelectedArtifactIds] = useState<string[]>([])
  const [memoryPanelOpen, setMemoryPanelOpen] = useState(false)
  const [memoryKind, setMemoryKind] = useState<BotanicAgentMemoryKind>('rule')
  const [memoryDraft, setMemoryDraft] = useState('')
  const [mentionQuery, setMentionQuery] = useState<BotanicAgentMentionQuery>()
  const [skills, setSkills] = useState<BotanicAgentSkill[]>([])
  const [skillName, setSkillName] = useState('')
  const [skillInstructions, setSkillInstructions] = useState('')
  const [skillConfirming, setSkillConfirming] = useState(false)
  const [skillSaving, setSkillSaving] = useState(false)
  const [skillError, setSkillError] = useState('')
  const [persistenceAction, setPersistenceAction] = useState<'retry' | 'refresh' | ''>('')
  const [promptDrafts, setPromptDrafts] = useState<Record<string, string>>({})
  const [recoveryModelMenuKey, setRecoveryModelMenuKey] = useState('')
  const [pendingGenerationOverrides, setPendingGenerationOverrides] = useState<Partial<Pick<GenerationSettings, 'model' | 'aspectRatio' | 'resolution'>>>({})
  const agentMessageQueue = useMemo(() => createAgentMessageQueue({
    storage: createLocalStorageAgentMessageQueueStorage(projectId),
    deliver: async (item) => { await submitPersistentBotanicAgentMessage(item) },
  }), [projectId])
  const plannerControllerRef = useRef<AbortController | null>(null)
  const agentMountedRef = useRef(true)
  const isCurrentAgentProject = () => agentMountedRef.current && useCanvasStore.getState().document.id === projectId
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
  const filteredArtifacts = useMemo(() => artifacts.filter((artifact) => {
    if (resultFilter === 'all') return true
    if (resultFilter === 'file') return artifact.kind !== 'image' && artifact.kind !== 'video'
    return artifact.kind === resultFilter
  }), [artifacts, resultFilter])
  const artifactGroups = useMemo(() => {
    const groups = new Map<string, { id: string; label: string; artifacts: BotanicAgentArtifact[] }>()
    for (const artifact of filteredArtifacts) {
      const runId = artifact.provenance.runId
      const id = runId ?? `action:${artifact.provenance.actionId}`
      const label = runId ? runs.find((run) => run.id === runId)?.plan.summary ?? '生成批次' : '工具产物'
      const group = groups.get(id) ?? { id, label, artifacts: [] }
      group.artifacts.push(artifact)
      groups.set(id, group)
    }
    return [...groups.values()]
  }, [filteredArtifacts, runs])
  const selectedArtifactBatch = useMemo(
    () => resolveBotanicAgentResultSelection(artifacts, selectedArtifactIds),
    [artifacts, selectedArtifactIds],
  )
  const selectedResultNodeIds = useMemo(() => {
    const resultNodeIds = new Set(contextOptions.filter((item) => item.kind === '结果').map((item) => item.id))
    return selectedArtifactBatch.sourceNodeIds.filter((nodeId) => resultNodeIds.has(nodeId))
  }, [contextOptions, selectedArtifactBatch.sourceNodeIds])
  const availableContextNodeIds = useMemo(() => new Set(contextOptions.map((item) => item.id)), [contextOptions])
  const mentionOptions = useMemo(() => {
    if (!mentionQuery) return []
    const query = mentionQuery.query.trim().toLocaleLowerCase()
    return contextOptions
      .filter((item) => item.kind === '素材' && Boolean(item.image))
      .filter((item) => !query || item.label.toLocaleLowerCase().includes(query))
      .slice(0, 6)
  }, [contextOptions, mentionQuery])
  const utilityPanelOpen = taskPanelOpen || skillPanelOpen || resultPanelOpen || memoryPanelOpen
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
        setTaskPanelOpen(false)
        setSkillPanelOpen(false)
        setResultPanelOpen(false)
        setMemoryPanelOpen(false)
        requestAnimationFrame(() => utilityButtonRef.current?.focus())
      } else {
        onClose()
      }
      event.preventDefault()
    }
    window.addEventListener('keydown', closeLayerOnEscape)
    return () => window.removeEventListener('keydown', closeLayerOnEscape)
  }, [contextMenuOpen, escapeEnabled, historyOpen, mentionQuery, modeMenuOpen, onClose, recoveryModelMenuKey, runtimeDetailsOpen, skillConfirming, utilityMenuOpen, utilityPanelOpen])

  useEffect(() => {
    if (!session || !latestRun || planning) return
    // 旧的已完成 Run 不能覆盖当前尚未确认的新计划或追问卡。
    if (runtimePhase === 'waiting_clarification' || runtimePhase === 'waiting_confirmation') return
    const active = latestRun.status === 'queued' || latestRun.status === 'running' || latestRun.status === 'executing'
    const failed = latestRun.status === 'failed' || latestRun.status === 'cancelled'
    setRuntimePhase(active ? 'executing' : failed ? 'failed' : 'completed')
    if (runtimeSteps.length) return
    // Agent Run 是服务端权威状态；刷新、切换项目或重新登录后，
    // 只恢复可验证的阶段，不重放也不猜测模型内部过程。
    setRuntimeSteps(restoreBotanicAgentRuntimeSteps({
      run: latestRun,
      hasTarget: Boolean(target),
      referenceCount: target?.rootRecipe.references.length ?? contextItems.length,
      memoryCount: memory.length,
      assetGroupCount: compatibleGroups.length,
      plannerLabel: agentPlannerModelLabel(plannerModel),
    }))
    setRuntimeDetailsOpen(false)
  }, [compatibleGroups.length, contextItems.length, latestRun?.id, latestRun?.status, latestRun?.updatedAt, memory.length, plannerModel, planning, runtimePhase, runtimeSteps.length, session, target])

  useEffect(() => {
    setSelectedArtifactIds((current) => current.filter((id) => artifacts.some((artifact) => artifact.id === id)))
  }, [artifacts])

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

  useEffect(() => {
    if (!plannerModels.includes(plannerModel)) setPlannerModel(plannerModels[0] ?? defaultAgentPlannerModels[0])
  }, [plannerModel, plannerModels])

  const flushQueuedAgentMessages = useCallback(async () => {
    const queued = new Map(agentMessageQueue.list().map((item) => [item.message.id, item.session.id]))
    const result = await agentMessageQueue.flush()
    if (!agentMountedRef.current || useCanvasStore.getState().document.id !== projectId) return
    for (const messageId of result.delivered) {
      const sessionId = queued.get(messageId)
      if (sessionId) onUpdateMessage(sessionId, messageId, { deliveryStatus: 'synced' })
    }
    for (const messageId of result.failed) {
      const sessionId = queued.get(messageId)
      if (sessionId) onUpdateMessage(sessionId, messageId, { deliveryStatus: 'failed' })
    }
  }, [agentMessageQueue, onUpdateMessage, projectId])

  useEffect(() => {
    if (!serverPersistenceEnabled) return
    return agentMessageQueue.subscribe((items) => {
    for (const item of items) {
      onUpdateMessage(item.session.id, item.message.id, {
        deliveryStatus: item.status === 'failed' ? 'failed' : 'queued',
      })
    }
    })
  }, [agentMessageQueue, onUpdateMessage])

  useEffect(() => {
    if (!serverPersistenceEnabled) return
    const replay = () => { void flushQueuedAgentMessages() }
    if (navigator.onLine) replay()
    window.addEventListener('online', replay)
    window.addEventListener('focus', replay)
    return () => {
      window.removeEventListener('online', replay)
      window.removeEventListener('focus', replay)
    }
  }, [flushQueuedAgentMessages])

  const appendMessage = (message: Omit<BotanicAgentMessage, 'id' | 'createdAt'>) => {
    if (!session || !isCurrentAgentProject()) return ''
    const messageId = `agent-message-${crypto.randomUUID()}`
    const createdAt = Date.now()
    const queuedMessage: BotanicAgentMessage = {
      ...message,
      id: messageId,
      createdAt,
      deliveryStatus: serverPersistenceEnabled ? 'queued' : 'synced',
    }
    const queuedSession = appendBotanicAgentMessage(session, queuedMessage)
    onAppendMessage(session.id, queuedMessage)
    if (!serverPersistenceEnabled) return messageId
    agentMessageQueue.enqueue({
      projectId,
      session: queuedSession,
      message: queuedMessage,
      idempotencyKey: `agent-message-${messageId}`,
    })
    if (navigator.onLine) void flushQueuedAgentMessages()
    return messageId
  }

  const toggleUtilityPanel = (panel: 'result' | 'task' | 'memory' | 'skill') => {
    utilityButtonRef.current = utilityMenuButtonRef.current
    setResultPanelOpen((open) => panel === 'result' ? !open : false)
    setTaskPanelOpen((open) => panel === 'task' ? !open : false)
    setMemoryPanelOpen((open) => panel === 'memory' ? !open : false)
    setSkillPanelOpen((open) => panel === 'skill' ? !open : false)
    setActiveTransientSurface(null)
    setMentionQuery(undefined)
  }

  const openUtilityPanel = (panel: 'result' | 'task' | 'memory' | 'skill') => {
    setResultPanelOpen(panel === 'result')
    setTaskPanelOpen(panel === 'task')
    setMemoryPanelOpen(panel === 'memory')
    setSkillPanelOpen(panel === 'skill')
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

  const saveMemory = () => {
    if (!memoryDraft.trim()) return
    const memoryId = onAddMemory(memoryKind, memoryDraft, session?.contextNodeIds ?? [])
    if (!memoryId) return
    setMemoryDraft('')
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

  const beginRuntimeTrace = (input: {
    hasTarget: boolean
    referenceCount: number
    memoryCount: number
    assetGroupCount: number
    mode?: 'generation' | 'conversation' | 'prompt' | 'research'
  }) => {
    const steps = createBotanicAgentRuntimeSteps({
      ...input,
      plannerLabel: agentPlannerModelLabel(plannerModel),
    })
    const firstStep = steps[0]
    const started = firstStep ? updateBotanicAgentRuntimeStep(steps, firstStep.id, 'running') : steps
    setRuntimeSteps(started)
    setRuntimePhase('reading')
    setRuntimeDetailsOpen(false)
    return started
  }

  const updateRuntimeStep = (
    stepId: string,
    status: BotanicAgentRuntimeStep['status'],
    errorMessage?: string,
  ) => {
    setRuntimeSteps((steps) => updateBotanicAgentRuntimeStep(steps, stepId, status, Date.now(), errorMessage))
  }

  const attachPlannerToolTrace = (plan?: BotanicAgentPlan | BotanicAgentClarificationResponse) => {
    const labels = plan?.toolCalls?.map((call) => call.label).filter(Boolean) ?? []
    if (!labels.length) return
    setRuntimeSteps((steps) => steps.map((step) => step.id === 'call-planner'
      ? { ...step, detail: `已调用：${[...new Set(labels)].join('、')}` }
      : step))
  }

  const yieldRuntimeFrame = () => new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timeoutId)
      window.cancelAnimationFrame(frameId)
      resolve()
    }
    const frameId = window.requestAnimationFrame(finish)
    const timeoutId = window.setTimeout(finish, 50)
  })

  const completeRuntimeContextReads = async (steps: BotanicAgentRuntimeStep[]) => {
    const contextSteps = steps.filter((step) => step.id !== 'call-planner' && step.id !== 'finalize-plan' && step.id !== 'create-workflow' && step.id !== 'respond')
    for (const step of contextSteps) {
      updateRuntimeStep(step.id, 'running')
      await yieldRuntimeFrame()
      updateRuntimeStep(step.id, 'succeeded')
    }
  }

  const completeRuntimeTrace = async (hasTarget: boolean) => {
    updateRuntimeStep('call-planner', 'succeeded')
    const finalStepId = hasTarget ? 'finalize-plan' : 'create-workflow'
    updateRuntimeStep(finalStepId, 'running')
    await yieldRuntimeFrame()
    updateRuntimeStep(finalStepId, 'succeeded')
    setRuntimePhase('completed')
    setRuntimeDetailsOpen(false)
  }

  const failRuntimeTrace = (message: string) => {
    setRuntimePhase('failed')
    setRuntimeSteps((steps) => {
      const active = steps.find((step) => step.status === 'running')
      return active
        ? updateBotanicAgentRuntimeStep(steps, active.id, 'failed', Date.now(), message)
        : steps
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
    setTaskPanelOpen(false)
    setResultPanelOpen(false)
    setSkillPanelOpen(false)
    setMemoryPanelOpen(false)
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

  const toggleArtifactSelection = (artifactId: string) => {
    setSelectedArtifactIds((current) => current.includes(artifactId)
      ? current.filter((id) => id !== artifactId)
      : [...current, artifactId])
  }

  const toggleArtifactGroupSelection = (groupArtifacts: BotanicAgentArtifact[]) => {
    const groupIds = groupArtifacts.map((artifact) => artifact.id)
    setSelectedArtifactIds((current) => {
      const allSelected = groupIds.every((id) => current.includes(id))
      return allSelected
        ? current.filter((id) => !groupIds.includes(id))
        : [...current, ...groupIds.filter((id) => !current.includes(id))]
    })
  }

  const createNextRoundFromSelection = () => {
    if (!selectedResultNodeIds.length) return
    onUseResultContext(selectedResultNodeIds)
    setInstruction(selectedArtifactBatch.artifacts.length === 1
      ? '基于这张结果继续生成：'
      : `基于这 ${selectedArtifactBatch.artifacts.length} 张结果继续生成：`)
    setResultPanelOpen(false)
    requestAnimationFrame(() => composerTextareaRef.current?.focus())
  }

  const continueFromArtifact = (artifact: BotanicAgentArtifact) => {
    onContinueArtifact(artifact)
    setInstruction(`基于「${artifact.label}」继续修改：`)
    setResultPanelOpen(false)
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
        {resultPanelOpen ? <section className="agent-result-panel" aria-label="Agent 结果与文件">
          <header><div><small>AGENT OUTPUTS</small><h2>结果与文件</h2></div><span>{artifacts.length} 项</span></header>
          <p>生成图与 Skill / MCP 产物统一按任务分组；画布节点和版本血缘不变。</p>
          {artifactIndexStatus === 'loading' ? <div className="agent-result-panel__index-status" role="status">正在读取历史 Artifact Index…</div> : null}
          {artifactIndexStatus === 'error' ? <div className="agent-result-panel__index-status is-warning" role="status">历史索引暂不可用，已显示当前画布结果。</div> : null}
          {latestRunFeedback ? <div className={`agent-result-panel__run-status is-${latestRunFeedback.tone}`} role="status"><strong>{latestRunFeedback.label}</strong><span>{latestRunFeedback.detail}</span></div> : null}
          <div className="agent-result-panel__filters" role="group" aria-label="结果类型">
            {([['all', '全部'], ['image', '图片'], ['video', '视频'], ['file', '文件']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={resultFilter === value} className={resultFilter === value ? 'is-active' : ''} onClick={() => setResultFilter(value)}>{label}</button>)}
          </div>
          {selectedArtifactBatch.artifacts.length ? <div className="agent-result-panel__selection" aria-label="批量操作">
            <strong>已选 {selectedArtifactBatch.artifacts.length} 项</strong>
            <div>
              {selectedArtifactBatch.mediaArtifacts.length ? <>
                <button type="button" disabled={selectedArtifactBatch.mediaArtifacts.every((artifact) => artifact.metadata?.savedToLibrary === true)} onClick={() => selectedArtifactBatch.mediaArtifacts.filter((artifact) => artifact.metadata?.savedToLibrary !== true).forEach(onSaveArtifact)}>入库</button>
                <button type="button" onClick={() => void (async () => {
                  for (const artifact of selectedArtifactBatch.mediaArtifacts) {
                    await downloadMedia(artifact.url!, artifact.label, artifact.kind === 'video' ? 'video' : 'image')
                  }
                })()}>下载</button>
              </> : null}
              <button type="button" className="is-primary" disabled={!selectedResultNodeIds.length} onClick={createNextRoundFromSelection}>创建下一轮</button>
              <button type="button" onClick={() => setSelectedArtifactIds([])}>取消</button>
            </div>
          </div> : null}
          <div className="agent-result-panel__groups">
            {artifactGroups.map((group) => <section key={group.id} className="agent-result-group">
              <header><span><strong>{group.label}</strong><small>{group.artifacts.length} 项</small></span><div>
                <button type="button" onClick={() => toggleArtifactGroupSelection(group.artifacts)}>{group.artifacts.every((artifact) => selectedArtifactIds.includes(artifact.id)) ? '取消本组' : '选择本组'}</button>
              </div></header>
              <div className="agent-result-panel__grid">
                {group.artifacts.map((artifact) => {
                  const locatableNodeId = artifact.provenance.sourceNodeIds?.find((nodeId) => availableContextNodeIds.has(nodeId))
                  const canContinue = Boolean(locatableNodeId || (artifact.url && (artifact.kind === 'image' || artifact.kind === 'video')))
                  return <article key={artifact.id} className={selectedArtifactIds.includes(artifact.id) ? 'is-selected' : ''}>
                    <button type="button" className="agent-result-panel__select" aria-pressed={selectedArtifactIds.includes(artifact.id)} aria-label={`${selectedArtifactIds.includes(artifact.id) ? '取消选择' : '选择'} ${artifact.label}`} onClick={() => toggleArtifactSelection(artifact.id)}>{selectedArtifactIds.includes(artifact.id) ? '✓' : ''}</button>
                    {artifact.url && (artifact.kind === 'image' || artifact.kind === 'video') ? <div className="agent-result-panel__preview">
                      {artifact.kind === 'image' ? <img src={artifact.url} alt="" /> : <video src={artifact.url} muted playsInline />}
                    </div> : <div className="agent-result-panel__document"><span>{artifact.kind === 'workflow' ? '⌘' : 'Aa'}</span><p>{artifact.content ?? artifact.label}</p></div>}
                    <div className="agent-result-panel__meta"><span><strong>{artifact.label}</strong><small>{agentArtifactKindLabel(artifact)} · {artifact.provenance.toolName}{locatableNodeId ? ' · 已回填画布' : ''}</small></span><div>
                      {locatableNodeId ? <button type="button" aria-label={`在画布定位 ${artifact.label}`} title="在画布定位" onClick={() => onLocateNode(locatableNodeId)}><FocusIcon /></button> : null}
                      {canContinue ? <button type="button" aria-label={`基于 ${artifact.label} 继续修改`} title="继续修改" onClick={() => continueFromArtifact(artifact)}><SparkleIcon /></button> : null}
                      {artifact.url && (artifact.kind === 'image' || artifact.kind === 'video') ? <button type="button" aria-label={`下载 ${artifact.label}`} title="下载" onClick={() => void downloadMedia(artifact.url!, artifact.label, artifact.kind === 'video' ? 'video' : 'image')}><DownloadIcon /></button> : artifact.url ? <a href={artifact.url} target="_blank" rel="noreferrer" aria-label={`打开 ${artifact.label}`} title="打开"><ArrowUpRightIcon /></a> : null}
                      {artifact.url && (artifact.kind === 'image' || artifact.kind === 'video') ? <button type="button" aria-label={artifact.metadata?.savedToLibrary === true ? `${artifact.label} 已入库` : `将 ${artifact.label} 入库`} title={artifact.metadata?.savedToLibrary === true ? '已入库' : '存入素材库'} disabled={artifact.metadata?.savedToLibrary === true} onClick={() => onSaveArtifact(artifact)}><FolderOutlineIcon /></button> : null}
                    </div></div>
                  </article>
                })}
              </div>
            </section>)}
            {!filteredArtifacts.length ? <div className="agent-skill-panel__empty">还没有该类型结果。生成或执行 Skill / MCP 后会自动汇总。</div> : null}
            {artifactIndexHasMore ? <button type="button" className="agent-result-panel__load-more" disabled={artifactIndexStatus === 'loading-more'} onClick={() => void onLoadMoreArtifacts()}>{artifactIndexStatus === 'loading-more' ? '加载中…' : '加载更早结果'}</button> : null}
          </div>
        </section> : null}
        {memoryPanelOpen ? <section className="agent-memory-panel" aria-label="项目创作记忆">
          <header><div><small>PROJECT MEMORY</small><h2>项目记忆</h2></div><span>{memory.length} 条</span></header>
          <p>仅用于当前项目的后续规划；保存品牌规则、认可方向与禁区。</p>
          <div className="agent-memory-panel__form">
            <BotanicSelect value={memoryKind} ariaLabel="记忆类型" options={[
              { value: 'rule', label: '长期规则' },
              { value: 'approved', label: '已确认方向' },
              { value: 'avoid', label: '避免事项' },
            ]} onChange={(value) => setMemoryKind(value as BotanicAgentMemoryKind)} />
            <textarea value={memoryDraft} maxLength={500} onChange={(event) => setMemoryDraft(event.target.value)} placeholder="例如：商品包装与品牌色不可改变" aria-label="项目记忆内容" />
            <button type="button" disabled={!memoryDraft.trim()} onClick={saveMemory}>保存记忆</button>
          </div>
          <div className="agent-memory-panel__list">
            {memory.map((item) => <article key={item.id} className={`is-${item.kind}`}><span><small>{agentMemoryKindLabel(item.kind)}</small><p>{item.content}</p></span><div>{item.sourceNodeIds[0] ? <button type="button" aria-label={`在画布定位记忆 ${item.content}`} title="在画布定位" onClick={() => onLocateNode(item.sourceNodeIds[0])}><FocusIcon /></button> : null}<button type="button" className="is-delete" aria-label={`删除记忆 ${item.content}`} title="删除记忆" onClick={() => onRemoveMemory(item.id)}><DeleteIcon /></button></div></article>)}
            {!memory.length ? <div className="agent-skill-panel__empty">还没有项目记忆。</div> : null}
          </div>
        </section> : null}
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
                  setResultPanelOpen(false)
                  requestAnimationFrame(() => composerTextareaRef.current?.focus())
                }}>继续修改</button>
                {outputNodeIds.length ? <button type="button" onClick={() => {
                  setResultPanelOpen(true)
                  setTaskPanelOpen(false)
                  setSkillPanelOpen(false)
                  setMemoryPanelOpen(false)
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
