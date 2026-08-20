import { type DragEvent, useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from 'react'
import {
  botanicAgentComposerGroupRole,
  botanicAgentBranchStatusLabel,
  botanicAgentActionReceiptMessageId,
  botanicAgentContextSnapshotNodeIds,
  botanicAgentAutoRetryTargets,
  botanicAgentSubmissionKey,
  buildBotanicAgentRunTimeline,
  buildBotanicAgentSessionTimeline,
  filterBotanicAgentSessionTimeline,
  filterBotanicAgentRunTimeline,
  buildBotanicAgentPlan,
  createBotanicAgentContextSnapshot,
  botanicAgentRequestMessageContent,
  consumeBotanicAgentMention,
  prepareBotanicAgentComposerSubmission,
  readBotanicAgentMentionQuery,
  resolveBotanicAgentExecutionDecision,
  botanicAgentPendingConfirmationCount,
  summarizeBotanicAgentRuntime,
  shouldRestoreBotanicAgentRuntimeSteps,
  shouldShowBotanicAgentRuntimeFeed,
  type BotanicAgentActionProposal,
  type BotanicAgentActionResult,
  type BotanicAgentArtifact,
  type BotanicAgentClarificationResponse,
  type BotanicAgentExecutionMode,
  type BotanicAgentIntent,
  type BotanicAgentMemoryItem,
  type BotanicAgentMemoryKind,
  type BotanicAgentMentionCatalog,
  type BotanicAgentMentionQuery,
  type BotanicAgentMessage,
  type BotanicAgentMessageMention,
  type BotanicAgentPlan,
  type BotanicAgentRun,
  type BotanicAgentRunTimelineFilter,
  type BotanicAgentSession,
  type BotanicAgentSessionTimelineFilter,
  type BotanicAgentSkill,
  type BotanicAgentSkillCatalogItem,
  type BotanicCreativeBrief,
} from '../../domain/agent'
import {
  decideBotanicAgentRequest,
  isBotanicAgentPromptGenerationPending,
} from '../../domain/agentChatContract'
import { advanceBotanicCreativeBrief, applyBotanicCreativeBriefAnswers } from '../../domain/agentCreativeBrief'
import {
  buildBotanicAgentInitialDraftPlan,
  prepareBotanicAgentGenerationDraft,
  resolveBotanicAgentInstructionEntry,
} from '../../domain/agentInstructionRouting'
import { botanicAgentRunReviewMessageId, formatBotanicAgentRunReviewMessage } from '../../domain/agentReviewContract'
import { resolveAgentChatPrompt } from '../../domain/agentMarkdown'
import type { BotanicAgentChatStreamEvent } from '../../domain/agentChatStream'
import { applyAgentConversationStreamEvent, createAgentTimeline, projectBotanicAgentRunOntoTimeline, type AgentTimelineEvent, type AgentTimelineState } from '../../domain/agentTimeline'
import { nextExclusiveSurface, type ExclusiveSurfaceAction } from '../../domain/exclusiveSurface'
import type { CollaborationActivity, CollaborationDocumentChange } from '../../domain/collaborationActivity'
import type {
  AssetGroup,
  GenerationModelOption,
  GenerationSettings,
  UploadedAssetInput,
} from '../../domain/canvas'
import type { GenerationSizeOverride } from '../../domain/generationOutputSize'
import { createProjectAgentSkill, listBotanicAgentSystemSkills, listProjectAgentSkills, requestBotanicAgentPlan, requestBotanicAgentRunReview, streamBotanicAgentChat, streamBotanicAgentPlan, streamBotanicAgentTurn } from '../../lib/agentApi'
import { botanicAgentRegionSelectNotice, instructionRequestsMarkOverlay } from '../../domain/generationComposition'
import { describeRegionRect } from '../../domain/regionMask'
import { RegionMaskEditor } from '../canvas/RegionMaskEditor'
import {
  botanicAgentMessageComposition,
  buildBotanicAgentCompositionPlan,
  formatBotanicAgentCompositionSummary,
  instructionRequestsCompositionRun,
  latestBotanicAgentComposition,
  normalizeBotanicAgentComposition,
  resolveBotanicAgentCompositionItem,
} from '../../domain/agentCreativeComposition'
import {
  applyBotanicAgentVariationToPlan,
  botanicAgentBriefWithVariationAnswers,
} from '../../domain/agentVariations'
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
  AgentPanelBackButton,
  agentRunFeedback,
  agentRunOutputCount,
  agentRuntimeStepMarker,
  agentRuntimeStepStatusLabel,
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
import { AgentCollaborationPanel, AgentMemoryPanel, AgentResultPanel, AgentSkillCard } from './AgentUtilityPanels'
import { AgentConversationMessage } from './AgentConversationMessage'
import { AgentComposer } from './AgentComposer'
import {
  AlertIcon,
  BookmarkIcon,
  CheckIcon,
  ChecklistIcon,
  ChevronLeftIcon,
  ClockIcon,
  CloseIcon,
  FigmaIcon,
  GalleryIcon,
  EditIcon,
  PlusSquareIcon,
  SparkleIcon,
  UploadIcon,
} from '../../components/BotanicIcons'
import historyIcon from '../../assets/figma/icon-history.svg'
import { useProductI18n, useProductMessages } from '../../i18n/react'
import { localizeProductError, productIntlLocale, type ProductLocale } from '../../i18n/core'

type AgentTransientSurface = 'context' | 'history' | 'utility' | 'mode'
type AgentUtilityPanel = 'result' | 'task' | 'memory' | 'skill' | 'collaboration'
type AgentRunInstructionOptions = AgentInstructionRetryOptions & {
  appendUser?: string
  mentions?: BotanicAgentMessageMention[]
}
type AgentLiveConversation = {
  sessionId: string
  message: BotanicAgentMessage
  timeline: AgentTimelineState
  streaming: boolean
}

function agentTimelineEvent(event: BotanicAgentChatStreamEvent, receivedAt: number): AgentTimelineEvent {
  if (event.type === 'reasoning') return { type: event.type, step: event.step, delta: event.delta, receivedAt }
  if (event.type === 'answer') return { type: event.type, step: event.step, delta: event.delta, receivedAt }
  if (event.type === 'tool') return {
    type: event.type,
    step: event.step,
    toolCall: event.toolCall,
    ...(event.presentation ? { presentation: event.presentation } : {}),
    receivedAt,
  }
  if (event.type === 'error') return { type: event.type, ...(event.message ? { message: event.message } : {}), receivedAt }
  return { type: 'done', receivedAt }
}

function agentTargetDisplayLabel(target?: AgentDockTarget) {
  if (!target) return ''
  const primaryReference = target.rootRecipe.references.find((reference) => reference.primary)
    ?? target.rootRecipe.references[0]
  const referenceName = primaryReference?.name?.trim()
  if (referenceName) return referenceName
  return target.label.trim().replace(/^@+/, '').replace(/\s+\+\d+\b.*$/u, '')
}

function agentTimelineTimestamp(timestamp: number, locale: ProductLocale) {
  return new Intl.DateTimeFormat(productIntlLocale(locale), {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(timestamp))
}

function agentQuickActions(locale: ProductLocale): Array<{ intent: BotanicAgentIntent; label: string; instruction: string }> {
  return locale === 'en' ? [
    { intent: 'replace_scene', label: 'Change scene', instruction: 'Keep the person, clothing, and product unchanged; replace only the scene and ambient lighting.' },
    { intent: 'change_pose', label: 'Change pose', instruction: 'Keep the person, clothing, product, and scene unchanged; adjust the pose and composition.' },
    { intent: 'change_style', label: 'Change style', instruction: 'Keep the person, clothing, product, scene, and pose unchanged; adjust the visual style and lighting.' },
    { intent: 'replace_person', label: 'Change model', instruction: 'Keep the clothing, product, scene, and style unchanged; replace the model.' },
    { intent: 'replace_product', label: 'Change product', instruction: 'Keep the person, scene, and style unchanged; replace the clothing or product.' },
    { intent: 'redo_from_root', label: 'Redo original recipe', instruction: 'Reuse the original references, prompt, and settings to generate a new independent key visual.' },
  ] : [
    { intent: 'replace_scene', label: '换场景', instruction: '保持人物、服装和商品不变，只替换场景与环境光线。' },
    { intent: 'change_pose', label: '换动作', instruction: '保持人物、服装、商品和场景不变，调整动作姿势与构图。' },
    { intent: 'change_style', label: '换风格', instruction: '保持人物、服装、商品、场景和动作不变，调整视觉风格与光线。' },
    { intent: 'replace_person', label: '换模特', instruction: '保持服装、商品、场景和风格不变，替换模特。' },
    { intent: 'replace_product', label: '换商品', instruction: '保持人物、场景和风格不变，替换服装或商品。' },
    { intent: 'redo_from_root', label: '原配方重做', instruction: '复用原始参考素材、提示词和参数，重新生成独立首图。' },
  ]
}

function AgentTaskFilterIcon({ value }: { value: 'all' | 'active' | 'completed' | 'attention' }) {
  if (value === 'completed') return <CheckIcon />
  if (value === 'attention') return <AlertIcon />
  if (value === 'active') return <ClockIcon />
  return <ChecklistIcon />
}

function agentTaskBranchSummary(run: BotanicAgentRun, locale: ProductLocale) {
  const succeeded = run.branches.filter((branch) => branch.status === 'succeeded').length
  const running = run.branches.filter((branch) => branch.status === 'running').length
  const queued = run.branches.filter((branch) => branch.status === 'queued').length
  const failed = run.branches.filter((branch) => branch.status === 'failed' || branch.status === 'cancelled').length
  return [
    succeeded ? `${succeeded} ${locale === 'en' ? 'complete' : '完成'}` : '',
    running ? `${running} ${locale === 'en' ? 'generating' : '生成中'}` : '',
    queued ? `${queued} ${locale === 'en' ? 'queued' : '排队'}` : '',
    failed ? `${failed} ${locale === 'en' ? 'failed' : '失败'}` : '',
  ].filter(Boolean).join(' · ') || `${run.branches.length} ${locale === 'en' ? 'branches' : '个分支'}`
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
  onResolveRunNodes,
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
  /** 解析某个 Run 当前在画布上的占位/结果节点；Agent 面板本身读不到画布图谱。 */
  onResolveRunNodes: (runId: string) => string[]
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
  const { locale } = useProductI18n()
  const copy = useProductMessages({
    'zh-CN': {
      tools: 'Agent 工具', back: '返回对话', results: '结果与文件', tasks: 'Agent 任务', memory: '项目记忆', skills: '创作技能', collaboration: '协作动态', close: '关闭 Agent',
      welcome: '今天一起创作什么？', welcomeTarget: (name: string) => `继续优化「${name}」`, welcomeBody: '可以日常对话、生成 Prompt、检索项目，也可以直接描述生图目标。', welcomeTargetBody: '保留当前画面与原始配方，仅调整你刚提出的内容。',
      sources: '来源', unavailable: 'Agent 暂时无法回答，请稍后重试。', unsupportedVideo: 'Agent 对话暂未接入视频执行链。请先在画布添加「视频生成」节点；本次没有创建节点或任务。', clarifyAction: '请明确是只需要建议，还是要我直接生成；本次没有改动画布。',
    },
    en: {
      tools: 'Agent tools', back: 'Back to conversation', results: 'Results & files', tasks: 'Agent tasks', memory: 'Project memory', skills: 'Creative skills', collaboration: 'Collaboration', close: 'Close Agent',
      welcome: 'What shall we create today?', welcomeTarget: (name: string) => `Continue refining “${name}”`, welcomeBody: 'Chat, create prompts, search this project, or describe the image you want to make.', welcomeTargetBody: 'Keep the current visual and original recipe, and change only what you just requested.',
      sources: 'Sources', unavailable: 'Agent is temporarily unavailable. Try again shortly.', unsupportedVideo: 'Video execution is not available in Agent chat yet. Add a Video Generation node on the canvas; no node or task was created.', clarifyAction: 'Please clarify whether you only want advice or want me to generate it. The canvas was not changed.',
    },
  })
  const flowCopy = locale === 'en' ? {
    sources: 'Sources', noSources: 'No governed project sources matched this request.', incomplete: 'Not completed', unavailable: 'Agent is temporarily unavailable. Try again shortly.',
    promptMissing: 'I could not find the prompt you referenced. Ask Agent to write one or paste the complete prompt. The canvas was not changed.',
    settingsMissing: 'No complete generation settings are available. Check the model catalog.', planFailed: 'Unable to create the generation plan. Try again shortly.', customDirection: 'Custom direction',
    usePrompt: 'Use this prompt to generate', nextRoundOne: 'Continue from this result:', nextRoundMany: (count: number) => `Continue from these ${count} results:`, continueArtifact: (label: string) => `Continue editing “${label}”:`,
    conflict: { title: 'A newer canvas version is available', detail: 'Your local draft and generation results are preserved.', actionLabel: 'Review changes' },
    offline: { title: 'Using an offline draft', detail: 'This edit will sync when the connection is restored.', actionLabel: 'Retry sync' },
    syncError: { title: 'Canvas sync is temporarily unavailable', detail: 'Your current edits remain saved locally and can sync later.', actionLabel: 'Retry sync' },
    dropImages: 'Drop to add image assets', uploadLimits: 'PNG / JPEG / WebP, up to 8 MB each', imageLimit: (count: number) => `You can add up to ${count} images at once. Extra images were skipped.`, imageReadFailed: 'Unable to read the images. Drop or select them again.',
    planningUnavailable: 'Unable to create the plan. Try again shortly.', confirmActionsFirst: 'Approve or skip the pending action cards before starting generation.', taskNotStarted: 'The task did not start. Check the references and generation service, then retry.', taskStartFailed: 'Unable to start the task. Try again shortly.', canvasWritten: ' Added to the canvas.', actionFailed: 'Unable to complete the action. Try again.', retryWithModel: (model: string, prompt: string) => `Regenerate with ${model}: ${prompt}`, retrySettings: (prompt: string) => `Adjust the output settings and regenerate: ${prompt}`, pendingQuestion: 'A confirmation card above still needs an answer. Select or enter a response in the card. No task was created.', noPendingPlan: 'There is no generation plan awaiting approval. Describe the image or batch values you want, and Agent will prepare a plan for review.',
    history: 'Conversation history', historyUnread: (count: number) => `Conversation history, ${count} ${count === 1 ? 'conversation has' : 'conversations have'} updates`, conversationName: 'Conversation name', saveName: 'Save conversation name', save: 'Save', cancelName: 'Cancel editing conversation name', cancel: 'Cancel', newConversation: 'New conversation', editName: 'Edit conversation name', collaborators: (count: number) => `${count} other ${count === 1 ? 'collaborator' : 'collaborators'} online`, processing: 'Processing',
    searchConversations: 'Search conversations', searchPlaceholder: 'Search conversations, messages, or tasks', historyFilters: 'Filter collaboration history', all: 'All', unread: 'Unread', newResults: 'New results', attention: 'Needs attention', resultUpdates: (count: number) => `${count} new ${count === 1 ? 'result' : 'results'}`, updates: (count: number) => `${count} ${count === 1 ? 'update' : 'updates'}`, attentionCount: (count: number) => `${count} need${count === 1 ? 's' : ''} attention`, activeCount: (count: number) => `${count} active`, taskCount: (count: number) => `${count} ${count === 1 ? 'task' : 'tasks'}`, noConversations: 'No conversations match these filters.', noMessagesYet: 'No messages yet',
    localChangesKept: 'Local changes are preserved. Review the update.', locateChange: 'Locate this change.', latestSynced: 'Latest content synced.', closeCollaborationUpdate: 'Close collaboration update', gotIt: 'Got it', readingRestored: 'Returned to your previous reading position', jumpLatest: 'Jump to latest',
    tasksAria: 'Agent tasks and results', tasksTitle: 'Agent tasks', tasksDescription: 'Tasks started by Agent only. Failed tasks can be retried without replacing completed results.', taskFilters: 'Filter by task status', active: 'Active', completed: 'Completed', filterCount: (label: string, count: number) => `${label} · ${count} ${count === 1 ? 'item' : 'items'}`, sourceConversation: 'Source conversation', cancelling: 'Cancelling…', branchStatus: 'Branch status', branchIncomplete: 'This branch did not complete.', noFilteredTasks: 'No tasks match this filter.', noTasks: 'No Agent tasks yet.',
    skillsAria: 'System and project Skills', skillsTitle: 'Creative skills', skillsDescription: 'Type @ in the composer to use a Skill. New project Skills are added to the current conversation automatically.', systemSkills: 'System Skills', newSkill: '+ New Skill', skillNamePlaceholder: 'Skill name, for example: Summer scene swap', skillName: 'Skill name', skillRulesPlaceholder: 'Describe what must stay fixed, what may change, and the result rules.', skillRules: 'Skill rules', createProjectSkill: 'Create project Skill', createProjectSkillDetail: 'This Skill will be saved to the current project and available to Agent.', creating: 'Creating…', confirmCreate: 'Create Skill', createSkill: 'Create Skill', skillCreateFailed: 'Unable to create the Skill. Try again shortly.', noProjectSkills: 'No project Skills yet.', skillCount: (count: number) => `${count} ${count === 1 ? 'Skill' : 'Skills'}`,
    refineOne: 'Continue refining this result:', refineMany: (count: number) => `Continue refining these ${count} results:`, continueContext: 'Continue creating from the current context:', runtimeAria: 'Agent run details', collapseSteps: 'Collapse run steps', viewSteps: 'View run steps', nextStep: 'Next:', runSteps: 'Run steps', runningStep: (label: string) => `Running ${label}`, runtimeStepFailed: 'This step did not complete.', runProgress: 'Agent Run progress', generationTask: 'Generation task', cancelTask: 'Cancel task', cancelFailed: 'Unable to cancel the task. Try again shortly.', retryFailed: (label: string) => `Unable to retry “${label}”. Try again shortly.`,
  } : {
    sources: '来源', noSources: '当前没有命中项目受控检索来源。', incomplete: '未完成', unavailable: 'Agent 暂时无法回答，请稍后重试。',
    promptMissing: '没有找到你指的 Prompt。请先让 Agent 写一段 Prompt，或粘贴完整 Prompt；本次没有改动画布。',
    settingsMissing: '当前没有可用的完整生成设置，请检查模型目录。', planFailed: '暂时无法创建生成计划。', customDirection: '自定义优化方向',
    usePrompt: '使用这段 Prompt 生成', nextRoundOne: '基于这张结果继续生成：', nextRoundMany: (count: number) => `基于这 ${count} 张结果继续生成：`, continueArtifact: (label: string) => `基于「${label}」继续修改：`,
    conflict: { title: '画布有新的云端版本', detail: '本地草稿仍保留，生成任务与结果不会丢失。', actionLabel: '查看变更' },
    offline: { title: '正在使用离线草稿', detail: '恢复网络后会继续同步当前编辑。', actionLabel: '重试同步' },
    syncError: { title: '画布同步暂时失败', detail: '当前编辑仍在本地，稍后可以继续同步。', actionLabel: '重试同步' },
    dropImages: '松开即可添加图片素材', uploadLimits: 'PNG / JPEG / WebP，单张不超过 8MB', imageLimit: (count: number) => `最多同时添加 ${count} 张图片，超出部分已跳过。`, imageReadFailed: '图片读取失败，请重新拖入或选择图片。',
    planningUnavailable: '暂时无法生成计划。', confirmActionsFirst: '请先确认或跳过行动卡，再执行生成计划。', taskNotStarted: '任务没有启动，请检查参考素材与生成服务后重试。', taskStartFailed: '任务未能启动，请稍后重试。', canvasWritten: ' 已写入画布。', actionFailed: '行动执行失败，请重试。', retryWithModel: (model: string, prompt: string) => `换用${model}重新生成：${prompt}`, retrySettings: (prompt: string) => `调整输出设置后重新生成：${prompt}`, pendingQuestion: '上面还有一张待回答的确认卡，请直接在卡片里选择或填写；本次没有创建任务。', noPendingPlan: '当前没有待确认的生成计划。请直接描述要生成的画面或批量取值，Agent 会先给出待确认计划。',
    history: '对话历史', historyUnread: (count: number) => `对话历史，${count} 个会话有更新`, conversationName: '对话名称', saveName: '保存对话名称', save: '保存', cancelName: '取消编辑对话名称', cancel: '取消', newConversation: '新建对话', editName: '编辑对话名称', collaborators: (count: number) => `另有 ${count} 位协作者在线`, processing: '处理中',
    searchConversations: '搜索对话', searchPlaceholder: '搜索对话、消息或任务', historyFilters: '筛选协作历史', all: '全部', unread: '未读', newResults: '新结果', attention: '需处理', resultUpdates: (count: number) => `${count} 个新结果`, updates: (count: number) => `${count} 条更新`, attentionCount: (count: number) => `${count} 项需处理`, activeCount: (count: number) => `${count} 进行中`, taskCount: (count: number) => `${count} 个任务`, noConversations: '当前筛选下没有对话。', noMessagesYet: '还没有消息',
    localChangesKept: '本地改动仍保留，点击查看变更。', locateChange: '点击定位变更。', latestSynced: '最新内容已同步。', closeCollaborationUpdate: '关闭协作更新提示', gotIt: '知道了', readingRestored: '已回到上次阅读位置', jumpLatest: '跳到最新',
    tasksAria: 'Agent 任务与结果', tasksTitle: 'Agent 任务', tasksDescription: '仅 Agent 发起的任务。失败可重试，不覆盖已完成结果。', taskFilters: '按任务状态筛选', active: '进行中', completed: '已完成', filterCount: (label: string, count: number) => `${label} · ${count} 项`, sourceConversation: '来源对话', cancelling: '取消中…', branchStatus: '分支状态', branchIncomplete: '该分支未完成', noFilteredTasks: '当前筛选下没有任务。', noTasks: '还没有 Agent 任务。',
    skillsAria: '系统与项目 Skill', skillsTitle: '创作技能', skillsDescription: '在输入框键入 @ 即可调用 Skill。新建的项目 Skill 会自动挂载到当前对话。', systemSkills: '系统 Skills', newSkill: '＋ 新建技能', skillNamePlaceholder: '技能名称，例如：夏日换景', skillName: 'Skill 名称', skillRulesPlaceholder: '描述必须保持什么、允许改变什么，以及结果规则。', skillRules: 'Skill 规则', createProjectSkill: '创建项目 Skill', createProjectSkillDetail: '将写入当前项目，之后可被 Agent 调用。', creating: '创建中…', confirmCreate: '确认创建', createSkill: '创建 Skill', skillCreateFailed: 'Skill 创建失败。', noProjectSkills: '还没有项目 Skill。', skillCount: (count: number) => `${count} 个`,
    refineOne: '继续优化这张结果：', refineMany: (count: number) => `继续优化这 ${count} 张结果：`, continueContext: '继续基于当前上下文创作：', runtimeAria: 'Agent 运行记录', collapseSteps: '收起运行步骤', viewSteps: '查看运行步骤', nextStep: '下一步：', runSteps: '运行步骤', runningStep: (label: string) => `正在${label}`, runtimeStepFailed: '该步骤未完成。', runProgress: 'Agent Run 实时进度', generationTask: '生成任务', cancelTask: '取消任务', cancelFailed: '任务取消失败，请稍后重试。', retryFailed: (label: string) => `「${label}」重试失败，请稍后再试。`,
  }
  const branchStatusLabel = (status: BotanicAgentRun['branches'][number]['status']) => locale === 'en'
    ? ({ succeeded: 'Completed', running: 'Generating', queued: 'Queued', cancelled: 'Cancelled', failed: 'Failed' }[status])
    : botanicAgentBranchStatusLabel(status)
  const displaySessionTitle = (title?: string) => locale === 'en' && title === '新建对话'
    ? flowCopy.newConversation
    : title ?? flowCopy.newConversation
  const displaySessionPreview = (preview: string) => locale === 'en' && preview === '还没有消息'
    ? flowCopy.noMessagesYet
    : preview
  const [intent, setIntent] = useState<BotanicAgentIntent | undefined>(undefined)
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
  const setPendingGenerationOverrides = useCallback((value: GenerationSizeOverride) => updateComposerState({ pendingGenerationOverrides: value }), [])
  const rememberFailedInstruction = useCallback((command: AgentFailedInstruction) => updateComposerState({
    lastFailedInstruction: command.instruction,
    lastFailedCommand: command,
  }), [])
  const [planning, setPlanning] = useState(false)
  /** 局部重绘语等待框选：选区回来后带 region 重放该指令。 */
  const [pendingRegionInstruction, setPendingRegionInstruction] = useState<{
    instruction: string
    options: AgentInstructionRetryOptions
  } | null>(null)
  const [liveConversation, setLiveConversation] = useState<AgentLiveConversation>()
  /** 确认后的 Run 进度投影：keyed by 计划消息 id，只反映已持久化状态。 */
  const [executionTimelines, setExecutionTimelines] = useState<Record<string, AgentTimelineState>>({})
  const [submittingMessageId, setSubmittingMessageId] = useState('')
  const [executingActionId, setExecutingActionId] = useState('')
  const executingActionIdRef = useRef('')
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
  const [expandedSkillId, setExpandedSkillId] = useState('')
  const [renamingSession, setRenamingSession] = useState(false)
  const [sessionTitleDraft, setSessionTitleDraft] = useState(displaySessionTitle(session?.title))
  const [persistenceAction, setPersistenceAction] = useState<'retry' | 'refresh' | ''>('')
  const [promptDrafts, setPromptDrafts] = useState<Record<string, string>>({})
  const [recoveryModelMenuKey, setRecoveryModelMenuKey] = useState('')
  const plannerControllerRef = useRef<AbortController | null>(null)
  const agentMountedRef = useRef(true)
  const isCurrentAgentProject = useCallback(
    () => agentMountedRef.current && useCanvasStore.getState().document.id === projectId,
    [projectId],
  )
  const { appendMessage, persistMessage, retryMessage } = useAgentMessageDelivery({
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
  const requestedRunReviewsRef = useRef(new Set<string>())
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
  const skillNameInputRef = useRef<HTMLInputElement | null>(null)
  const historyMenuId = useId()
  const utilityMenuId = useId()
  const contextMenuId = useId()
  const modeMenuId = useId()
  const runtimeStepsId = useId()
  const compatibleGroups = groups.filter((group) => group.role === botanicAgentComposerGroupRole(intent) && group.assetIds.length)
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
  const renderedConversationMessages = useMemo(() => {
    const base = (() => {
      if (!session || !liveConversation || liveConversation.sessionId !== session.id) return conversationMessages
      if (conversationMessages.some((message) => message.id === liveConversation.message.id)) return conversationMessages
      return [...conversationMessages, liveConversation.message]
    })()
    // 进行中的 Run 状态由 runtime feed / 底部进度条直播，对话里不画第二张「正在生成」卡。
    return base.filter((message) => {
      if (message.kind !== 'run' || !message.runId) return true
      const run = runs.find((item) => item.id === message.runId)
      return !run || !shouldRestoreBotanicAgentRuntimeSteps(run.status)
    })
  }, [conversationMessages, liveConversation, runs, session])
  const pendingPromptSourceIds = useMemo(() => new Set((session?.messages ?? [])
    .filter((message) => message.question?.sourcePromptMessageId && message.kind === 'question' && message.status === 'pending')
    .map((message) => message.question!.sourcePromptMessageId!)), [session?.messages])
  const mentionOptions = useMemo(() => {
    if (!mentionQuery) return []
    const query = mentionQuery.query.trim().toLocaleLowerCase()
    return contextOptions
      // 文字节点现在会作为补充描述进入提示词，所以它和图片素材一样可以被 @ 引用。
      .filter((item) => (item.kind === '素材' && Boolean(item.image)) || (item.kind === '文字' && Boolean(item.content)))
      .filter((item) => !query || item.label.toLocaleLowerCase().includes(query))
      .slice(0, 6)
  }, [contextOptions, mentionQuery])
  const skillOptions = useMemo<AgentSkillOption[]>(() => {
    if (!mentionQuery) return []
    const query = mentionQuery.query.trim().toLocaleLowerCase()
    const catalog = [...systemSkills, ...skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      instructions: skill.instructions,
      source: 'project' as const,
    }))]
      .filter((skill, index, items) => items.findIndex((candidate) => candidate.id === skill.id) === index)
      .filter((skill) => !query || skill.name.toLocaleLowerCase().includes(query) || skill.id.toLocaleLowerCase().includes(query))
    // 系统 Skill 全量出现在 @ 菜单；项目 Skill 仍截断，避免目录把菜单撑爆。
    const systemMatches = catalog.filter((skill) => skill.source === 'system')
    const projectMatches = catalog.filter((skill) => skill.source !== 'system').slice(0, 8)
    return [...systemMatches, ...projectMatches].map(({ id, name, source }) => ({ id, name, source }))
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
  const mentionCatalog = useMemo<BotanicAgentMentionCatalog>(() => ({
    skills: [...systemSkills, ...skills]
      .filter((skill, index, items) => items.findIndex((candidate) => candidate.id === skill.id) === index)
      .map((skill) => ({ id: skill.id, name: skill.name })),
    references: contextOptions.map((item) => ({
      id: item.id,
      label: item.label,
      ...(item.image ? { image: item.image } : {}),
    })),
  }), [contextOptions, skills, systemSkills])
  const utilityPanelOpen = taskPanelOpen || skillPanelOpen || resultPanelOpen || memoryPanelOpen || collaborationPanelOpen
  const {
    runtimeSteps,
    runtimePhase,
    runtimeMode,
    runtimeDetailsOpen,
    setRuntimePhase,
    setRuntimeDetailsOpen,
    resetRuntimeTrace,
    attachPlannerToolTrace,
    attachRuntimeReasoning,
    appendRuntimeReasoningDelta,
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
    () => summarizeBotanicAgentRuntime({ steps: runtimeSteps, phase: runtimePhase, mode: runtimeMode }),
    [runtimeMode, runtimePhase, runtimeSteps],
  )
  const runtimeDisplaySummary = useMemo(() => {
    if (locale !== 'en') return runtimeSummary
    if (runtimeSummary.phase === 'reading') return { ...runtimeSummary, label: 'Reading project context', detail: 'Reading the current canvas, references, and project memory.', nextAction: 'Wait for context' }
    if (runtimeSummary.phase === 'planning') return { ...runtimeSummary, label: 'Planning', detail: 'Organizing the goal, locked elements, and output settings.', nextAction: 'Wait for the plan' }
    if (runtimeSummary.phase === 'waiting_clarification') return { ...runtimeSummary, label: 'Waiting for settings', detail: 'Add the delivery settings or creative direction before Agent continues.', nextAction: 'Choose settings' }
    if (runtimeSummary.phase === 'waiting_confirmation') return { ...runtimeSummary, label: 'Waiting for approval', detail: 'Review the prompt and output settings, then approve generation.', nextAction: 'Approve generation' }
    if (runtimeSummary.phase === 'waiting_reference') return { ...runtimeSummary, label: 'Waiting for a reference image', detail: 'Add or @mention an image to continue. No empty node will be created.', nextAction: 'Add a reference image' }
    if (runtimeSummary.phase === 'draft_ready') return { ...runtimeSummary, label: 'Generation draft created', detail: 'An editable node was added to the canvas. No generation task has been submitted yet.', nextAction: 'Review and generate' }
    if (runtimeSummary.phase === 'executing') return { ...runtimeSummary, label: 'Generation in progress', detail: 'The task was submitted. Results will be added to the canvas when ready.', nextAction: 'View task' }
    if (runtimeSummary.phase === 'failed') return { ...runtimeSummary, label: 'Agent run not completed', detail: 'The failure point is preserved. Edit the request or retry the task.', nextAction: 'Review and retry' }
    if (runtimeSummary.phase === 'completed') {
      if (runtimeMode === 'prompt') return { ...runtimeSummary, label: 'Prompt created', detail: 'Copy it or use it to start generation.', nextAction: 'Use prompt to generate' }
      if (runtimeMode === 'research') return { ...runtimeSummary, label: 'Research complete', detail: 'Matched project sources are listed in the response.', nextAction: 'Ask a follow-up' }
      if (runtimeMode !== 'generation') return { ...runtimeSummary, label: 'Response complete', detail: 'Continue the conversation or describe a creative goal.', nextAction: 'Continue conversation' }
      return { ...runtimeSummary, label: 'Agent completed', detail: 'Results were added to the canvas and are ready to refine.', nextAction: 'Continue editing' }
    }
    return runtimeMode === 'research'
      ? { ...runtimeSummary, label: 'Waiting for your question', detail: 'Ask about verifiable information in this project.', nextAction: 'Enter a question' }
      : { ...runtimeSummary, label: 'Waiting for your request', detail: 'Describe a goal and Agent will read the context before planning.', nextAction: 'Enter a request' }
  }, [locale, runtimeMode, runtimeSummary])
  const runtimeFailed = runtimePhase === 'failed' || runtimeSteps.some((step) => step.status === 'failed')
  const runtimeComplete = runtimePhase === 'completed'
  const availableCanvasNodeIds = useMemo(() => new Set(contextOptions.map((item) => item.id)), [contextOptions])
  const latestRunFeedback = latestRun ? agentRunFeedback(latestRun, artifacts, availableCanvasNodeIds, locale) : undefined
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
  // 运行轨迹只描述“这一轮正在发生什么”：轮次收束后由对话内的状态消息接手，
  // 底部不再留下上一轮的完成卡。提交任务后仍以 Run 卡作为唯一任务状态来源。
  // 对话流式时同一段回答已经在气泡里出现，不再另开运行卡。
  const showRuntimeFeed = shouldShowBotanicAgentRuntimeFeed({
    runtimePhase,
    hasRuntimeSteps: runtimeSteps.length > 0,
    hasLiveConversation: Boolean(liveConversation),
    runBranchCount: latestRun?.branches.length,
  })

  // 切换会话时上一轮轨迹不再跟随；新会话若有进行中的 Run 会由恢复逻辑重新填充。
  const sessionId = session?.id
  useEffect(() => {
    resetRuntimeTrace()
    setLiveConversation(undefined)
    setExecutionTimelines({})
  }, [resetRuntimeTrace, sessionId])

  // 确认后把已持久化的 Run/分支状态投影进同款对话时间线；不发明未发生的步骤。
  useEffect(() => {
    if (!session?.messages.length || !runs.length) return
    setExecutionTimelines((current) => {
      let changed = false
      const next = { ...current }
      for (const message of session.messages) {
        if (!message.runId || (message.status !== 'submitted' && message.kind !== 'run')) continue
        const run = runs.find((item) => item.id === message.runId)
        if (!run) continue
        const projected = projectBotanicAgentRunOntoTimeline(run, current[message.id], run.updatedAt)
        const previous = current[message.id]
        const same = previous
          && previous.blocks.length === projected.blocks.length
          && previous.blocks.every((block, index) => {
            const other = projected.blocks[index]
            if (!other || block.type !== other.type) return false
            if (block.type === 'step' && other.type === 'step') {
              return block.id === other.id && block.status === other.status && block.title === other.title
            }
            return block.id === other.id
          })
        if (!same) {
          next[message.id] = projected
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [runs, session?.messages])

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
    const { accepted, message } = validateUploadFiles(files, locale)
    const imageFiles = accepted.slice(0, maxUploadAssets)
    const limitMessage = accepted.length > maxUploadAssets ? flowCopy.imageLimit(maxUploadAssets) : ''
    if (message || limitMessage) setError([message, limitMessage].filter(Boolean).join(' '))
    if (!imageFiles.length) return
    const loaded = await Promise.allSettled(imageFiles.map((file) => readUploadedAssetInput(file, '场景')))
    const uploads = loaded
      .filter((result): result is PromiseFulfilledResult<UploadedAssetInput> => result.status === 'fulfilled')
      .map((result) => result.value)
    if (!uploads.length) {
      setError(flowCopy.imageReadFailed)
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

  useEffect(() => {
    // Strict Mode 会执行 setup → cleanup → setup；每次 setup 都必须恢复活动标记，
    // 否则开发环境中的消息发送会被误判为“组件已卸载”而静默丢弃。
    agentMountedRef.current = true
    return () => {
      agentMountedRef.current = false
      plannerControllerRef.current?.abort()
      if (readingAnchorTimerRef.current !== null) window.clearTimeout(readingAnchorTimerRef.current)
      if (locatedMessageTimerRef.current !== null) window.clearTimeout(locatedMessageTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!skillPanelOpen) {
      setSkillFormOpen(false)
      setExpandedSkillId('')
    }
  }, [skillPanelOpen])

  useEffect(() => {
    let active = true
    setSkillError('')
    // 系统 Skill 是静态目录，不依赖项目持久化；关掉 persistence 时 Composer @ 仍要能挂载。
    void listBotanicAgentSystemSkills()
      .then((items) => { if (active) setSystemSkills(items) })
      .catch(() => { if (active) setSystemSkills([]) })
    if (!serverPersistenceEnabled) {
      setSkills([])
      return () => { active = false }
    }
    void listProjectAgentSkills(projectId).then((items) => {
      if (active) setSkills(items)
    }).catch((reason) => {
      if (active) setSkillError(localizeProductError(reason, locale, {
        'zh-CN': '项目 Skill 列表加载失败。',
        en: 'Unable to load project Skills.',
      }))
    })
    return () => { active = false }
  }, [locale, projectId, skillPanelOpen])

  useEffect(() => {
    setSessionTitleDraft(displaySessionTitle(session?.title))
    setRenamingSession(false)
  }, [locale, session?.id, session?.title])

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
  }, [session?.messages.length, latestRun?.updatedAt, liveConversation, planning, runtimeSteps.length, runtimeSteps[runtimeSteps.length - 1]?.status, utilityPanelOpen])

  useEffect(() => {
    if (!compatibleGroups.some((group) => group.id === groupId)) setGroupId('')
  }, [compatibleGroups, groupId])

  const toggleUtilityPanel = (panel: AgentUtilityPanel) => {
    utilityButtonRef.current = utilityMenuButtonRef.current
    setActiveUtilityPanel((current) => current === panel ? null : panel)
    setActiveTransientSurface(null)
    setMentionQuery(undefined)
  }

  const closeUtilityPanel = () => {
    setActiveUtilityPanel(null)
    setUtilityMenuOpen(false)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      (composerTextareaRef.current ?? utilityButtonRef.current)?.focus()
    }))
  }

  const openUtilityPanel = (panel: AgentUtilityPanel) => {
    setActiveUtilityPanel(panel)
    setActiveTransientSurface(null)
    setMentionQuery(undefined)
  }

  const openRunFeedback = (run: BotanicAgentRun) => {
    const feedback = agentRunFeedback(run, artifacts, availableCanvasNodeIds, locale)
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
      const feedback = agentRunFeedback(run, artifacts, availableCanvasNodeIds, locale)
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
    }
  }, [artifacts, availableCanvasNodeIds, onUpdateMessage, runs, session])

  // 导演回看：自动模式下失败分支自动重试一次（attempt 0 → 1），再失败就停手交还用户。
  // 重试端点按 attempt 幂等，取消的分支不重试；手动模式保持人工点按。
  const autoRetriedBranchesRef = useRef(new Set<string>())
  useEffect(() => {
    if (session?.executionMode !== 'auto') return
    const sessionRunIds = new Set(session.messages.flatMap((message) => (message.runId ? [message.runId] : [])))
    for (const target of botanicAgentAutoRetryTargets(runs, sessionRunIds)) {
      const key = `${target.runId}:${target.branchId}`
      if (autoRetriedBranchesRef.current.has(key)) continue
      autoRetriedBranchesRef.current.add(key)
      void onRetryBranch(target.runId, target.branchId).catch(() => { /* 重试失败交还用户手动处理。 */ })
    }
  }, [onRetryBranch, runs, session?.executionMode, session?.messages])

  // 结果自评：Run 终态且结果回填后请求一次视觉评审，以固定消息 id 追加为会话消息。
  // 评审是派生数据：未配置、失败或结果未回填都静默跳过，绝不影响 Run 与结果本身；
  // 结果晚于终态回填时，Run 对账会更新 updatedAt，下一次请求键随之重试。
  useEffect(() => {
    if (!session || !latestRun) return
    if (latestRun.status !== 'completed' && latestRun.status !== 'partial') return
    // 只评当前会话里的任务，不把其他会话的历史 Run 拉进来点评。
    if (!session.messages.some((message) => message.runId === latestRun.id)) return
    const reviewMessageId = botanicAgentRunReviewMessageId(latestRun.id)
    if (session.messages.some((message) => message.id === reviewMessageId)) return
    const requestKey = `${latestRun.id}:${latestRun.status}:${latestRun.updatedAt}`
    if (requestedRunReviewsRef.current.has(requestKey)) return
    requestedRunReviewsRef.current.add(requestKey)
    void requestBotanicAgentRunReview(projectId, latestRun.id, undefined, locale).then((review) => {
      if (!review || !isCurrentAgentProject()) return
      appendMessage({
        id: reviewMessageId,
        role: 'assistant',
        kind: 'text',
        content: formatBotanicAgentRunReviewMessage(review, locale),
      })
      // 挑选循环闭合：评审选出的最佳结果直接成为下一轮迭代目标，替代「第一个结果」的默认跟随。
      if (review.bestNodeId) onUseResultContext([review.bestNodeId])
    }).catch(() => { /* 评审失败静默：结果本身不受影响。 */ })
  }, [appendMessage, isCurrentAgentProject, latestRun, locale, onUseResultContext, projectId, session])

  // 任务开始时把视角带到正在生成的节点，且每个 Run 只带一次；之后画布归用户，
  // 结果完成不再抢视角——需要回看结果时用消息里的「定位画布」。
  useEffect(() => {
    for (const run of runs) {
      if (!['queued', 'running', 'executing'].includes(run.status)) continue
      if (focusedRunIdsRef.current.has(run.id)) continue
      const pendingNodeIds = onResolveRunNodes(run.id)
      if (!pendingNodeIds.length) continue
      focusedRunIdsRef.current.add(run.id)
      onFocusNodes(pendingNodeIds)
    }
  }, [onFocusNodes, onResolveRunNodes, runs])

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
      if (isCurrentAgentProject()) setSkillError(localizeProductError(caught, locale, { 'zh-CN': flowCopy.skillCreateFailed, en: flowCopy.skillCreateFailed }))
    } finally {
      setSkillSaving(false)
    }
  }

  const selectMention = (item: AgentContextItem) => {
    if (!session || !mentionQuery) return
    const consumed = consumeBotanicAgentMention(instruction, mentionQuery)
    setInstruction(consumed.value)
    if (!session.contextNodeIds.includes(item.id)) onContextChange(session.id, [...session.contextNodeIds, item.id])
    setMentionQuery(undefined)
    requestAnimationFrame(() => {
      composerTextareaRef.current?.focus()
      composerTextareaRef.current?.setSelectionRange(consumed.caret, consumed.caret)
    })
  }

  const toggleMountedSkill = (skillId: string, nextMounted: boolean) => {
    if (!session) return
    const current = session.mountedSkillIds ?? []
    onSkillsChange(session.id, nextMounted
      ? [...new Set([...current, skillId])]
      : current.filter((id) => id !== skillId))
  }

  const selectSkill = (skill: AgentSkillOption) => {
    if (!session || !mentionQuery) return
    const consumed = consumeBotanicAgentMention(instruction, mentionQuery)
    setInstruction(consumed.value)
    onSkillsChange(session.id, [...new Set([...(session.mountedSkillIds ?? []), skill.id])])
    setMentionQuery(undefined)
    requestAnimationFrame(() => {
      composerTextareaRef.current?.focus()
      composerTextareaRef.current?.setSelectionRange(consumed.caret, consumed.caret)
    })
  }

  const openSkillCreation = () => {
    setMentionQuery(undefined)
    setUtilityMenuOpen(false)
    setActiveUtilityPanel('skill')
    setSkillFormOpen(true)
    setSkillConfirming(false)
    setSkillError('')
    requestAnimationFrame(() => skillNameInputRef.current?.focus())
  }

  const preparePlan = async (
    cleanInstruction: string,
    generationOverrides?: GenerationSizeOverride,
    clarificationAnswers?: Record<string, string>,
    creativeBrief?: BotanicCreativeBrief,
    failedCommand?: AgentFailedInstruction,
    outputCount?: number,
    sourceInstruction?: string,
    structuredVariants?: Array<{ label: string; promptDelta: string }>,
    variationAxisLabel?: string,
  ): Promise<BotanicAgentPlan | BotanicAgentClarificationResponse | null> => {
    if (!session || !target || !isCurrentAgentProject()) return null
    const assetGroup = compatibleGroups.find((group) => group.id === groupId)
    const input = {
      projectId,
      locale,
      plannerModel,
      mountedSkillIds: session?.mountedSkillIds,
      instruction: cleanInstruction,
      // 综合 Prompt 链路里 cleanInstruction 是模型写的画面描述；变体轴必须从用户原话解析。
      ...(sourceInstruction?.trim() ? { sourceInstruction: sourceInstruction.trim() } : {}),
      // 回合模型结构化声明的变体：规划器直接展开，不再从自然语言里挖轴。
      ...(structuredVariants?.length ? { structuredVariants } : {}),
      ...(structuredVariants?.length && variationAxisLabel ? { variationAxisLabel } : {}),
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
      creativeBrief,
      contextSnapshot: createBotanicAgentContextSnapshot(contextItems),
      ...(outputCount ? { outputCount } : {}),
    }
    plannerControllerRef.current?.abort()
    const controller = new AbortController()
    plannerControllerRef.current = controller
    setPlanning(true)
    setError('')
    setRuntimePhase('planning')
    const liveMessageId = `agent-message-${crypto.randomUUID()}`
    const liveStartedAt = Date.now()
    setLiveConversation({
      sessionId: session.id,
      message: {
        id: liveMessageId,
        role: 'assistant',
        kind: 'text',
        content: '',
        createdAt: liveStartedAt,
      },
      timeline: createAgentTimeline(liveStartedAt),
      streaming: true,
    })
    try {
      const nextPlan = await streamBotanicAgentPlan(input, {
        signal: controller.signal,
        onReasoning: attachRuntimeReasoning,
        onEvent: (event) => {
          if (controller.signal.aborted) return
          const receivedAt = Date.now()
          setLiveConversation((current) => {
            if (current?.sessionId !== session.id || current.message.id !== liveMessageId) return current
            const next = applyAgentConversationStreamEvent(
              { content: current.message.content, timeline: current.timeline },
              agentTimelineEvent(event, receivedAt),
            )
            return {
              ...current,
              message: { ...current.message, content: next.content },
              timeline: next.timeline,
              streaming: event.type !== 'done' && event.type !== 'error',
            }
          })
          if (event.type === 'tool') {
            attachPlannerToolTrace({ toolCalls: [event.toolCall] } as BotanicAgentPlan)
          }
          if (event.type === 'reasoning') {
            appendRuntimeReasoningDelta(event.step, event.delta)
          }
        },
      })
      if (controller.signal.aborted) return null
      attachPlannerToolTrace(nextPlan)
      setLiveConversation((current) => current?.message.id === liveMessageId ? undefined : current)
      setRuntimePhase('waiting_confirmation')
      if (!isCurrentAgentProject()) return null
      return nextPlan
    } catch (planError) {
      if (controller.signal.aborted) return null
      setLiveConversation((current) => {
        if (current?.sessionId !== session.id || current.message.id !== liveMessageId) return current
        const message = localizeProductError(planError, locale, { 'zh-CN': flowCopy.planningUnavailable, en: flowCopy.planningUnavailable })
        const next = applyAgentConversationStreamEvent(
          { content: current.message.content, timeline: current.timeline },
          { type: 'error', message, receivedAt: Date.now() },
        )
        return {
          ...current,
          message: { ...current.message, content: message },
          timeline: next.timeline,
          streaming: false,
        }
      })
      const canUseLocalFallback = planError instanceof ProductApiError
        && (planError.status === 0 || planError.status === 404 || planError.status >= 500)
        && !(planError.code === 'STREAM_DISCONNECTED' || planError.code === 'REQUEST_TIMEOUT')
      if (canUseLocalFallback) {
        setLiveConversation((current) => current?.message.id === liveMessageId ? undefined : current)
        try {
          const fallbackPlan = { ...buildBotanicAgentPlan({
            instruction: cleanInstruction,
            locale,
            intent,
            selectedResultNodeId: target.id,
            selectedResultLabel: target.label,
            rootRecipe: target.rootRecipe,
            assetGroup,
            creativeBrief,
            contextSnapshot: createBotanicAgentContextSnapshot(contextItems),
            ...(outputCount ? { outputCount } : {}),
          }), plannerModel, settings: { ...target.rootRecipe.settings, ...generationOverrides } }
          const applied = applyBotanicAgentVariationToPlan(fallbackPlan, {
            // 变体轴只从用户原话解析：cleanInstruction 在综合 Prompt 链路里是模型 prose。
            instruction: sourceInstruction ?? failedCommand?.instruction ?? cleanInstruction,
            locale,
            requestedIntent: intent,
            clarificationAnswers,
            brief: creativeBrief,
            fallbackPrompt: target.rootRecipe?.prompt,
            structuredVariants,
            variationAxisLabel,
            assetGroup: assetGroup
              ? { id: assetGroup.id, role: assetGroup.role, assetCount: assetGroup.assetIds.length }
              : undefined,
          })
          if (applied.kind === 'clarification') return applied
          const resolvedFallback = { ...fallbackPlan, ...applied.plan }
          attachPlannerToolTrace(resolvedFallback)
          setRuntimePhase('waiting_confirmation')
          if (!isCurrentAgentProject()) return null
          return resolvedFallback
        } catch (fallbackError) {
          const message = localizeProductError(fallbackError, locale, { 'zh-CN': flowCopy.planningUnavailable, en: flowCopy.planningUnavailable })
          setError(message)
          setLastFailedPlanMessageId('')
          rememberFailedInstruction(failedCommand ?? { instruction: cleanInstruction, options: { generationOverrides, clarificationAnswers, creativeBrief } })
        }
      } else {
        const message = localizeProductError(planError, locale, { 'zh-CN': flowCopy.planningUnavailable, en: flowCopy.planningUnavailable })
        setError(message)
        setLastFailedPlanMessageId('')
        rememberFailedInstruction(failedCommand ?? { instruction: cleanInstruction, options: { generationOverrides, clarificationAnswers, creativeBrief } })
      }
      failRuntimeTrace(localizeProductError(planError, locale, { 'zh-CN': flowCopy.planningUnavailable, en: flowCopy.planningUnavailable }))
      return null
    } finally {
      if (plannerControllerRef.current === controller) plannerControllerRef.current = null
      setPlanning(false)
    }
  }

  const confirmMessagePlan = async (message: BotanicAgentMessage) => {
    if (!session || !message.plan || message.status === 'submitted' || submittingMessageId === message.id || submittingMessageIdRef.current === message.id) return
    if (botanicAgentPendingConfirmationCount(message.plan.actions) > 0) {
      setError(flowCopy.confirmActionsFirst)
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
      if (submission.started) {
        // 本次参考已随计划快照提交，composer 里就该清空：留着它们下一轮会被继续带上，
        // 参考集越改越脏。要复用同一张参考时重新 @ 引用即可。
        if (session.contextNodeIds.length) onContextChange(session.id, [])
        setGroupId('')
        const run = runs.find((item) => item.id === submission.runId)
        setExecutionTimelines((current) => ({
          ...current,
          [message.id]: projectBotanicAgentRunOntoTimeline(
            run ?? {
              id: submission.runId,
              status: 'queued',
              branches: [],
            },
            current[message.id] ?? liveConversation?.timeline,
            Date.now(),
          ),
        }))
      }
      if (!submission.started) appendMessage({
        role: 'assistant', kind: 'text',
        content: flowCopy.taskNotStarted,
      })
    } catch (caught) {
      if (!isCurrentAgentProject()) return
      onUpdateMessage(session.id, message.id, { status: 'failed' })
      setRuntimePhase('failed')
      setError(localizeProductError(caught, locale, { 'zh-CN': flowCopy.taskStartFailed, en: flowCopy.taskStartFailed }))
      // 请求可能已被服务端接受，但响应在网络中断时丢失；重试原计划时必须复用同一幂等键。
      setLastFailedInstruction('')
      setLastFailedPlanMessageId(message.id)
    } finally {
      submittingMessageIdRef.current = ''
      setSubmittingMessageId('')
    }
  }

  const confirmAction = async (message: BotanicAgentMessage, action: BotanicAgentActionProposal) => {
    if (!session || executingActionId || executingActionIdRef.current || action.status === 'succeeded') return
    // setState 在同一事件循环内不是同步锁；双击确认会在重渲染前发出两次请求，
    // 进而产生重复 Skill 回执，并让卡片长期停留在 running。
    executingActionIdRef.current = action.id
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
        id: botanicAgentActionReceiptMessageId(action.id),
        role: 'assistant', kind: 'notice',
        content: `${result.message}${result.canvasNodeId ? flowCopy.canvasWritten : ''}`,
      })
    } catch (caught) {
      if (!isCurrentAgentProject()) return
      const actionError = localizeProductError(caught, locale, { 'zh-CN': flowCopy.actionFailed, en: flowCopy.actionFailed })
      onUpdateAction(session.id, message.id, action.id, { status: 'failed', error: actionError })
      setRuntimePhase('failed')
      setError(actionError)
    } finally {
      if (executingActionIdRef.current === action.id) executingActionIdRef.current = ''
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
      const modelOverrides: GenerationSizeOverride = { model: model.id }
      if (model.aspectRatios?.length && !model.aspectRatios.includes(run.plan.settings.aspectRatio)) modelOverrides.aspectRatio = model.aspectRatios[0]
      if (model.resolutions?.length && !model.resolutions.includes(run.plan.settings.resolution)) modelOverrides.resolution = model.resolutions[0]
      setPendingGenerationOverrides(modelOverrides)
      setInstruction(flowCopy.retryWithModel(modelDisplayLabel(model), run.plan.prompt))
    } else {
      setPendingGenerationOverrides({})
      setInstruction(flowCopy.retrySettings(run.plan.prompt))
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
    // 快捷操作选的意图只作用于紧随其后的这一条指令；用完即清，
    // 避免一次点击后的残留意图长期覆盖回合模型的判断。
    if (intent) setIntent(undefined)
    if (options.appendUser !== undefined) appendMessage({
      role: 'user',
      kind: 'text',
      content: options.appendUser,
      ...(options.mentions?.length ? { mentions: options.mentions } : {}),
    })
    setLiveConversation(undefined)
    setError('')
    setLastFailedInstruction('')
    setLastFailedPlanMessageId('')
    const failedCommand: AgentFailedInstruction = {
      instruction: cleanInstruction,
      options: {
        ...(options.generationOverrides ? { generationOverrides: options.generationOverrides } : {}),
        ...(options.clarificationAnswers ? { clarificationAnswers: options.clarificationAnswers } : {}),
        ...(options.creativeBrief ? { creativeBrief: options.creativeBrief } : {}),
        ...(options.sourcePromptMessageId ? { sourcePromptMessageId: options.sourcePromptMessageId } : {}),
        ...(options.resolvedGeneration ? { resolvedGeneration: options.resolvedGeneration } : {}),
        ...(options.region ? { region: options.region } : {}),
        ...(options.composition ? { composition: options.composition } : {}),
      },
    }

    // 结构化方案活在会话消息上：方案卡点选带上该卡的 composition，输入「生成第 N 项」取最近一条。
    const composition = options.composition ?? latestBotanicAgentComposition(session.messages) ?? undefined
    if (composition && !failedCommand.options.composition) {
      failedCommand.options = { ...failedCommand.options, composition }
    }
    const compositionItem = composition && !options.resolvedGeneration
      ? resolveBotanicAgentCompositionItem(composition, cleanInstruction)
      : null
    if (compositionItem) {
      options = {
        ...options,
        composition,
        resolvedGeneration: {
          mediaKind: compositionItem.mediaKind,
          prompt: compositionItem.prompt,
          count: compositionItem.count,
          ...(compositionItem.duration ? { duration: compositionItem.duration } : {}),
        },
      }
      failedCommand.options = {
        ...failedCommand.options,
        composition,
        resolvedGeneration: options.resolvedGeneration,
      }
    }

    // 「执行方案 / 整套生成」：分支按方案条目展开成一个异构 Run，一次确认整套推进。
    if (composition && !options.resolvedGeneration && !compositionItem
      && instructionRequestsCompositionRun(cleanInstruction)) {
      const executionDecision = resolveBotanicAgentExecutionDecision({
        mode: session.executionMode,
        settingsComplete: true,
        pendingActionCount: 0,
      })
      const imageModel = generationModels.find((model) => (model.mediaKind ?? 'image') === 'image')
      if (!imageModel) {
        setError('当前没有可用的图片生成模型，无法整套执行。')
        return
      }
      try {
        const compositionPlan = {
          ...buildBotanicAgentCompositionPlan({
            instruction: cleanInstruction,
            composition,
            contextSnapshot: createBotanicAgentContextSnapshot(contextItems),
            locale,
            settings: {
              model: imageModel.id,
              aspectRatio: imageModel.aspectRatios?.[0] ?? '3:4',
              resolution: imageModel.resolutions?.[0] ?? '1K',
              ...pendingGenerationOverrides,
            } as GenerationSettings,
          }),
          plannerModel,
        }
        const planMessageId = appendMessage({
          role: 'assistant', kind: 'plan', plan: compositionPlan, status: 'pending',
          content: compositionPlan.summary,
        })
        if (planMessageId && executionDecision.action === 'auto_submit') {
          await confirmMessagePlan({
            id: planMessageId, role: 'assistant', kind: 'plan', content: compositionPlan.summary,
            createdAt: Date.now(), plan: compositionPlan, status: 'pending',
          })
        }
      } catch (caught) {
        setError(localizeProductError(caught, locale, {
          'zh-CN': '暂时无法创建整套生成计划。',
          en: 'Unable to create the full-set generation plan. Try again shortly.',
        }))
      }
      return
    }

    const hasImageContext = contextItems.some((item) => (
      (item.kind === '素材' || item.kind === '结果')
      && Boolean(item.image)
      && (item.mediaKind ?? 'image') === 'image'
    ))
    const hasVisualContext = Boolean(target) || hasImageContext
    // 路由与生成前置全部是纯决策，由领域模块拥有；这里只按返回值执行副作用。
    const entry = resolveBotanicAgentInstructionEntry({
      instruction: cleanInstruction,
      options,
      hasVisualContext,
      canSelectRegion: Boolean(target?.image),
      messages: session.messages,
    })
    if (entry.kind === 'confirm_plan') {
      await confirmMessagePlan(entry.message)
      return
    }
    if (entry.kind === 'select_region') {
      // 局部重绘先框选：选区回来后带 region 重放这条指令，直接进入生成链路。
      setPendingRegionInstruction({ instruction: cleanInstruction, options })
      appendMessage({
        role: 'assistant',
        kind: 'notice',
        content: locale === 'en'
          ? (instructionRequestsMarkOverlay(cleanInstruction)
            ? `Box the spot on “${target?.label ?? 'Current result'}” where the logo should go. We’ll stamp the reference as-is instead of regenerating a badge.`
            : `Select the area to redraw on “${target?.label ?? 'Current result'}”; everything outside it will stay unchanged.`)
          : botanicAgentRegionSelectNotice(cleanInstruction, target?.label ?? '当前结果'),
      })
      return
    }
    if (entry.kind === 'notice') {
      appendMessage({
        role: 'assistant',
        kind: 'notice',
        content: entry.notice === 'answer_pending_question'
          ? flowCopy.pendingQuestion
          : flowCopy.noPendingPlan,
      })
      return
    }

    // 服务端回合解析器：让模型读整段对话判断意图并综合可执行 Prompt，取代浏览器端正则路由。
    // 服务端未配置或离线时回退到本地正则决策，保证本地开发、e2e 与无 Provider 部署不受影响。
    let serverDecision: ReturnType<typeof decideBotanicAgentRequest> | undefined = entry.decision
    let synthesizedPrompt: string | undefined = entry.synthesizedPrompt
    let synthesizedCount: number | undefined = entry.synthesizedCount
    let synthesizedDuration: number | undefined = entry.synthesizedDuration
    let synthesizedVariants: Array<{ label: string; promptDelta: string }> | undefined = entry.synthesizedVariants
    let synthesizedAxisLabel: string | undefined = entry.synthesizedAxisLabel
    let resolvedOptions = entry.options
    if (entry.useServerTurn) {
      plannerControllerRef.current?.abort()
      const controller = new AbortController()
      plannerControllerRef.current = controller
      setPlanning(true)
      setRuntimePhase('planning')
      const liveMessageId = `agent-message-${crypto.randomUUID()}`
      const liveStartedAt = Date.now()
      setLiveConversation({
        sessionId: session.id,
        message: {
          id: liveMessageId,
          role: 'assistant',
          kind: 'text',
          content: '',
          createdAt: liveStartedAt,
        },
        timeline: createAgentTimeline(liveStartedAt),
        streaming: true,
      })
      try {
        const turn = await streamBotanicAgentTurn({
          projectId,
          locale,
          plannerModel,
          mountedSkillIds: session.mountedSkillIds,
          messages: [
            ...session.messages.map((message) => ({ role: message.role, content: botanicAgentRequestMessageContent(message, locale) })),
            { role: 'user' as const, content: botanicAgentRequestMessageContent({ content: options.appendUser, mentions: options.mentions }, locale) || cleanInstruction },
          ],
          contextNodeIds: session.contextNodeIds,
          hasTarget: Boolean(target),
          // 选中态与执行模式是系统事实：模型据此判断改图还是新建，以及生成后是自动提交还是等确认。
          ...(target ? { selectedResultLabel: target.label } : {}),
          executionMode: session.executionMode,
          generationModels,
        }, {
          signal: controller.signal,
          onEvent: (event) => {
            if (controller.signal.aborted) return
            const receivedAt = Date.now()
            setLiveConversation((current) => {
              if (current?.sessionId !== session.id || current.message.id !== liveMessageId) return current
              const next = applyAgentConversationStreamEvent(
                { content: current.message.content, timeline: current.timeline },
                agentTimelineEvent(event, receivedAt),
              )
              return {
                ...current,
                message: { ...current.message, content: next.content },
                timeline: next.timeline,
                streaming: event.type !== 'done' && event.type !== 'error',
              }
            })
          },
        })
        if (controller.signal.aborted) return
        if (turn.kind === 'chat') {
          setRuntimePhase('completed')
          setRuntimeDetailsOpen(false)
          const sourceNote = turn.sources?.length ? `\n\n${copy.sources}: ${turn.sources.join(locale === 'en' ? ', ' : '、')}` : ''
          appendMessage({
            id: liveMessageId,
            role: 'assistant',
            kind: 'text',
            content: `${turn.answer}${sourceNote}`,
          })
          setLiveConversation((current) => current?.message.id === liveMessageId ? undefined : current)
          return
        }
        if (turn.kind === 'clarification') {
          // 模型的结构化中断：这一轮在等用户补充核心信息，答案作为下一条消息自然回流
          // 服务端回合（对话里已有提问与回答），不进入本地 brief 表单。
          if (!isCurrentAgentProject()) return
          setRuntimePhase('waiting_clarification')
          const optionLines = turn.options?.length
            ? `\n\n${turn.options.map((option, index) => `${index + 1}. ${option}`).join('\n')}`
            : ''
          appendMessage({
            id: liveMessageId,
            role: 'assistant',
            kind: 'text',
            content: `${turn.question}${optionLines}`,
          })
          setLiveConversation((current) => current?.message.id === liveMessageId ? undefined : current)
          return
        }
        if (turn.kind === 'composition') {
          if (!isCurrentAgentProject()) return
          setRuntimePhase('completed')
          setRuntimeDetailsOpen(false)
          const composition = normalizeBotanicAgentComposition({ theme: turn.theme, items: turn.items })
          setLiveConversation((current) => current?.message.id === liveMessageId ? undefined : current)
          if (!composition) {
            appendMessage({
              role: 'assistant',
              kind: 'notice',
              content: locale === 'en'
                ? 'The request did not produce a usable composition. Describe the items you want to deliver again.'
                : '这次分解没有形成可用的成套方案，请再描述一次交付项。',
            })
            return
          }
          appendMessage({
            id: liveMessageId,
            role: 'assistant',
            kind: 'composition',
            composition,
            content: formatBotanicAgentCompositionSummary(composition, locale),
          })
          return
        }
        setLiveConversation((current) => current?.message.id === liveMessageId ? undefined : current)
        serverDecision = { kind: 'generation', mediaKind: turn.mediaKind, promptSource: 'instruction' }
        synthesizedPrompt = turn.prompt
        synthesizedCount = turn.count
        synthesizedDuration = turn.duration
        synthesizedVariants = turn.variants
        synthesizedAxisLabel = turn.axisLabel
        if (turn.settingsHint && Object.keys(turn.settingsHint).length) {
          resolvedOptions = { ...options, generationOverrides: { ...turn.settingsHint, ...options.generationOverrides } }
        }
      } catch (caught) {
        if (controller.signal.aborted) return
        setLiveConversation((current) => {
          if (current?.sessionId !== session.id || current.message.id !== liveMessageId) return current
          const message = caught instanceof Error ? caught.message : copy.unavailable
          const next = applyAgentConversationStreamEvent(
            { content: current.message.content, timeline: current.timeline },
            { type: 'error', message, receivedAt: Date.now() },
          )
          return {
            ...current,
            message: { ...current.message, content: message },
            timeline: next.timeline,
            streaming: false,
          }
        })
        // 离线(0)、项目缺失(404) 与所有 5xx（未配置、网关/代理故障、模型无可用结论）
        // 都回退本地正则——与 preparePlan 的降级判定保持同一语义；其余按 Agent 错误处理。
        const fallBack = caught instanceof ProductApiError
          && (caught.status === 0 || caught.status === 404 || caught.status >= 500)
          && !(caught.code === 'STREAM_DISCONNECTED' || caught.code === 'REQUEST_TIMEOUT')
        if (!fallBack) {
          const message = localizeProductError(caught, locale, {
            'zh-CN': copy.unavailable,
            en: copy.unavailable,
          })
          failRuntimeTrace(message)
          setError(message)
          rememberFailedInstruction(failedCommand)
          return
        }
        setLiveConversation((current) => current?.message.id === liveMessageId ? undefined : current)
      } finally {
        if (plannerControllerRef.current === controller) plannerControllerRef.current = null
        // 生成流程自己会重新置忙。这里无条件复位：下面到追问、失败等早退分支之间没有
        // await，用户看不到闪烁，而漏掉复位会把输入框和确认卡一起锁死。
        setPlanning(false)
      }
    }

    const decision = serverDecision ?? decideBotanicAgentRequest(cleanInstruction, hasVisualContext)
    if (decision.kind === 'clarification') {
      appendMessage({
        role: 'assistant',
        kind: 'notice',
        content: decision.reason === 'video_requires_reference'
          ? locale === 'en'
            ? 'Video generation needs an image as the first frame. Reference an asset or result, then describe the video you want; no task was created.'
            : '视频需要一张图片作首帧。请先 @ 引用一张素材或点选一张结果图，再说要生成的视频；本次没有创建任务。'
          : decision.reason === 'unsupported_media'
            ? copy.unsupportedVideo
            : copy.clarifyAction,
      })
      return
    }
    if (decision.kind === 'chat') {
      const route = decision.mode
      let routedInstruction = cleanInstruction
      let routedFailedCommand = failedCommand
      if (route === 'prompt') {
        const briefTurn = advanceBotanicCreativeBrief({
          mode: 'prompt',
          locale,
          executionMode: session.executionMode,
          instruction: cleanInstruction,
          previousBrief: options.creativeBrief,
          answers: options.clarificationAnswers,
        })
        if (briefTurn.kind === 'ask') {
          setRuntimePhase('waiting_clarification')
          appendMessage({
            role: 'assistant',
            kind: 'question',
            question: briefTurn.clarification,
            status: 'pending',
            content: briefTurn.clarification.question,
          })
          return
        }
        if (briefTurn.kind === 'failed') {
          setError(briefTurn.message)
          return
        }
        routedInstruction = briefTurn.prompt
        routedFailedCommand = {
          instruction: cleanInstruction,
          options: { ...failedCommand.options, creativeBrief: briefTurn.brief },
        }
      }
      plannerControllerRef.current?.abort()
      const controller = new AbortController()
      plannerControllerRef.current = controller
      setPlanning(true)
      setRuntimePhase('planning')
      const chatMessages = [
        ...session.messages.map((message) => ({ role: message.role, content: botanicAgentRequestMessageContent(message, locale) })),
        { role: 'user' as const, content: routedInstruction },
      ].slice(-16)
      const liveMessageId = `agent-message-${crypto.randomUUID()}`
      const liveStartedAt = Date.now()
      setLiveConversation({
        sessionId: session.id,
        message: {
          id: liveMessageId,
          role: 'assistant',
          kind: 'text',
          content: '',
          createdAt: liveStartedAt,
        },
        timeline: createAgentTimeline(liveStartedAt),
        streaming: true,
      })
      try {
        // 实时通道只改变“回答什么时候到”：思考与工具进入时间线，回答增量写入气泡正文。
        // 完整回答仍等 done 一次性落成消息，避免半截内容进入对话记录。
        // 工具步进只来自服务端 execute 前后的真实 emit，不做 rAF 假进度。
        const response = await streamBotanicAgentChat({
          projectId,
          locale,
          plannerModel,
          mountedSkillIds: session.mountedSkillIds,
          mode: route,
          messages: chatMessages,
          contextNodeIds: session.contextNodeIds,
        }, {
          signal: controller.signal,
          onEvent: (event) => {
            if (controller.signal.aborted) return
            const receivedAt = Date.now()
            setLiveConversation((current) => {
              if (current?.sessionId !== session.id || current.message.id !== liveMessageId) return current
              const next = applyAgentConversationStreamEvent(
                { content: current.message.content, timeline: current.timeline },
                agentTimelineEvent(event, receivedAt),
              )
              return {
                ...current,
                message: { ...current.message, content: next.content },
                timeline: next.timeline,
                streaming: event.type !== 'done' && event.type !== 'error',
              }
            })
            if (event.type === 'tool') {
              attachPlannerToolTrace({ toolCalls: [event.toolCall] } as BotanicAgentPlan)
              return
            }
            if (event.type === 'reasoning') {
              appendRuntimeReasoningDelta(event.step, event.delta)
            }
          },
        })
        if (controller.signal.aborted) return
        attachPlannerToolTrace({ toolCalls: response.toolCalls } as BotanicAgentPlan)
        attachRuntimeReasoning(response.reasoning)
        if (!isCurrentAgentProject()) return
        setRuntimePhase('completed')
        setRuntimeDetailsOpen(false)
        const sourceNote = route === 'research'
          ? `\n\n${flowCopy.sources}: ${response.sources?.length ? response.sources.join(locale === 'en' ? ', ' : '、') : flowCopy.noSources}`
          : ''
        const chatPrompt = resolveAgentChatPrompt(response.answer)
        appendMessage({
          id: liveMessageId,
          role: 'assistant',
          kind: 'text',
          content: `${response.answer}${sourceNote}`,
          // 可执行提示词只能来自回答里显式的 Prompt 区块，不能把整段解释当成提示词存下来。
          ...(chatPrompt ? { prompt: chatPrompt } : {}),
        })
        setLiveConversation((current) => current?.message.id === liveMessageId ? undefined : current)
      } catch (caught) {
        if (controller.signal.aborted) return
        const message = localizeProductError(caught, locale, { 'zh-CN': flowCopy.unavailable, en: flowCopy.unavailable })
        setLiveConversation((current) => {
          if (current?.sessionId !== session.id || current.message.id !== liveMessageId) return current
          const next = applyAgentConversationStreamEvent(
            { content: current.message.content, timeline: current.timeline },
            { type: 'error', message, receivedAt: Date.now() },
          )
          return {
            ...current,
            message: { ...current.message, content: `${flowCopy.incomplete}: ${message}` },
            timeline: next.timeline,
            streaming: false,
          }
        })
        failRuntimeTrace(message)
        setError(message)
        setLastFailedPlanMessageId('')
        rememberFailedInstruction(routedFailedCommand)
      } finally {
        if (plannerControllerRef.current === controller) plannerControllerRef.current = null
        setPlanning(false)
      }
      return
    }
    if (decision.kind !== 'generation') return
    const variationGroup = compatibleGroups.find((group) => group.id === groupId)
    const draft = prepareBotanicAgentGenerationDraft({
      instruction: cleanInstruction,
      locale,
      decision,
      options: resolvedOptions,
      messages: session.messages,
      generationModels,
      executionMode: session.executionMode,
      requestedIntent: intent,
      target: target
        ? { id: target.id, label: target.label, image: target.image, inheritedSettings: target.rootRecipe.settings }
        : undefined,
      contextItems,
      variationAssetGroup: variationGroup
        ? { id: variationGroup.id, role: variationGroup.role, assetCount: variationGroup.assetIds.length }
        : undefined,
      synthesizedPrompt,
      synthesizedCount,
      synthesizedDuration,
      synthesizedVariants,
      synthesizedAxisLabel,
    })
    if (draft.kind === 'notice') {
      appendMessage({
        role: 'assistant',
        kind: 'notice',
        content: draft.notice === 'prompt_missing' ? flowCopy.promptMissing : copy.unsupportedVideo,
      })
      return
    }
    if (draft.kind === 'ask') {
      setRuntimePhase('waiting_clarification')
      appendMessage({
        role: 'assistant',
        kind: 'question',
        question: draft.clarification,
        status: 'pending',
        content: draft.clarification.question,
      })
      return
    }
    if (draft.kind === 'failed') {
      // 已经开过运行轨迹的轮次必须显式收尾，否则运行卡会一直停在“规划中”。
      failRuntimeTrace(draft.message)
      setError(draft.message)
      return
    }
    const resolvedFailedCommand: AgentFailedInstruction = {
      instruction: cleanInstruction,
      options: {
        ...failedCommand.options,
        generationOverrides: draft.generationOverrides,
        creativeBrief: draft.brief,
      },
    }
    setPlanning(true)
    setRuntimePhase('planning')
    if (resolvedOptions.region && target) {
      // 局部重绘：选区+指令已完全确定这次生成，本地构建计划，不经服务端图片规划器改写。
      const executionDecision = resolveBotanicAgentExecutionDecision({
        mode: session.executionMode,
        settingsComplete: true,
        pendingActionCount: 0,
      })
      try {
        const regionPlan = {
          ...buildBotanicAgentPlan({
            instruction: draft.prompt,
            locale,
            creativeBrief: draft.brief,
            selectedResultNodeId: target.id,
            selectedResultLabel: target.label,
            rootRecipe: target.rootRecipe,
            contextSnapshot: createBotanicAgentContextSnapshot(draft.planContextItems),
            region: resolvedOptions.region,
          }),
          plannerModel,
          settings: { ...target.rootRecipe.settings, ...draft.generationOverrides },
        }
        if (!isCurrentAgentProject()) return
        setRuntimePhase('waiting_confirmation')
        const planMessageId = appendMessage({
          role: 'assistant', kind: 'plan', plan: regionPlan, status: 'pending',
          content: regionPlan.summary,
        })
        if (planMessageId && executionDecision.action === 'auto_submit') {
          await confirmMessagePlan({
            id: planMessageId, role: 'assistant', kind: 'plan', content: regionPlan.summary,
            createdAt: Date.now(), plan: regionPlan, status: 'pending',
          })
        }
      } catch (caught) {
        const message = locale === 'en' ? flowCopy.planFailed : caught instanceof Error ? caught.message : '暂时无法创建局部重绘计划。'
        failRuntimeTrace(message)
        setError(message)
        rememberFailedInstruction(resolvedFailedCommand)
      } finally {
        setPlanning(false)
      }
      return
    }
    if (draft.useInitialFlow) {
      // 执行决策放在计划构建之后：自动模式必须看到展开后的张数才能决定是否直接提交。
      try {
        const appliedInitial = buildBotanicAgentInitialDraftPlan(draft, resolvedOptions.clarificationAnswers, locale)
        if (appliedInitial.kind === 'clarification') {
          setRuntimePhase('waiting_clarification')
          appendMessage({
            role: 'assistant',
            kind: 'question',
            question: appliedInitial.clarification,
            status: 'pending',
            content: appliedInitial.clarification.question,
          })
          return
        }
        const resolvedInitialPlan = { ...appliedInitial.plan, plannerModel }
        attachPlannerToolTrace(resolvedInitialPlan)
        if (!isCurrentAgentProject()) return
        setRuntimePhase('waiting_confirmation')
        const executionDecision = resolveBotanicAgentExecutionDecision({
          mode: session.executionMode,
          // draft 流程里设置不完整会提前走 clarification，到这里必然完整。
          settingsComplete: true,
          pendingActionCount: 0,
          outputCount: resolvedInitialPlan.output.count,
        })
        const planMessageId = appendMessage({
          role: 'assistant', kind: 'plan', plan: resolvedInitialPlan, status: 'pending',
          content: resolvedInitialPlan.summary,
        })
        if (planMessageId && executionDecision.action === 'auto_submit') {
          await confirmMessagePlan({
            id: planMessageId, role: 'assistant', kind: 'plan', content: resolvedInitialPlan.summary,
            createdAt: Date.now(), plan: resolvedInitialPlan, status: 'pending',
          })
        }
      } catch (caught) {
        const message = localizeProductError(caught, locale, { 'zh-CN': flowCopy.planFailed, en: flowCopy.planFailed })
        failRuntimeTrace(message)
        setError(message)
        setLastFailedPlanMessageId('')
        rememberFailedInstruction(resolvedFailedCommand)
      } finally {
        setPlanning(false)
      }
      return
    }
    const nextPlan = await preparePlan(
      draft.prompt,
      draft.generationOverrides,
      resolvedOptions.clarificationAnswers,
      draft.brief,
      resolvedFailedCommand,
      draft.outputCount,
      draft.instruction,
      draft.structuredVariants,
      draft.variationAxisLabel,
    )
    if (!nextPlan || !session || !isCurrentAgentProject()) return
    if ('kind' in nextPlan && nextPlan.kind === 'clarification') {
      setRuntimePhase('waiting_clarification')
      appendMessage({
        role: 'assistant', kind: 'question', question: {
          ...nextPlan.clarification,
          ...draft.carryOver,
        }, status: 'pending',
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
    const planExecutionDecision = resolveBotanicAgentExecutionDecision({
      mode: session.executionMode,
      settingsComplete: true,
      pendingActionCount: botanicAgentPendingConfirmationCount(resolvedPlan.actions),
      outputCount: resolvedPlan.output.count,
    })
    if (planMessageId && planExecutionDecision.action === 'auto_submit') {
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
    const prepared = prepareBotanicAgentComposerSubmission({
      instruction,
      mountedSkills: mountedSkillOptions,
      contextItems,
      locale,
    })
    if (!prepared) return
    sendingInstructionRef.current = true
    setInstruction('')
    setMentionQuery(undefined)
    setLastFailedPlanMessageId('')
    const generationOverrides = pendingGenerationOverrides
    setPendingGenerationOverrides({})
    try {
      await runInstruction(prepared.instruction, {
        appendUser: prepared.content,
        mentions: prepared.mentions,
        generationOverrides,
      })
    } finally {
      sendingInstructionRef.current = false
    }
  }

  const answerClarification = async (message: BotanicAgentMessage, answers: Record<string, string>) => {
    if (!session || !message.question || planning || message.status === 'answered') return
    const fields = message.question.fields
    const summary = [
      ...fields.map((field) => `${field.label}${locale === 'en' ? ': ' : '：'}${field.options.find((option) => option.value === answers[field.id])?.label ?? answers[field.id]}`),
      answers.custom_direction?.trim() && !fields.some((field) => field.id === 'custom_direction')
        ? `${flowCopy.customDirection}: ${answers.custom_direction.trim()}`
        : '',
    ].filter(Boolean).join(locale === 'en' ? '; ' : '；')
    const answeredMessage: BotanicAgentMessage = {
      ...message,
      status: 'answered',
      updatedAt: Date.now(),
      question: {
        ...message.question,
        fields: fields.map((field) => answers[field.id]
          ? { ...field, defaultValue: answers[field.id] }
          : field),
      },
    }
    onUpdateMessage(session.id, message.id, {
      status: answeredMessage.status,
      question: answeredMessage.question,
    })
    persistMessage(answeredMessage)
    await runInstruction(message.question.originalInstruction, {
      appendUser: summary,
      clarificationAnswers: answers,
      creativeBrief: botanicAgentBriefWithVariationAnswers(
        applyBotanicCreativeBriefAnswers(message.question.brief, answers),
        answers,
      ),
      sourcePromptMessageId: message.question.sourcePromptMessageId,
      resolvedGeneration: message.question.resolvedGeneration,
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
    const command = flowCopy.usePrompt
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
    // 任务已按这条计划提交，改写提示词只会让历史记录与真实执行不一致。
    if (message.status === 'submitted') return
    const cleanPrompt = prompt.trim()
    if (!cleanPrompt || cleanPrompt === message.plan.prompt) return
    onUpdateMessage(session.id, message.id, { plan: { ...message.plan, prompt: cleanPrompt } })
  }

  const commitPlanSettings = (message: BotanicAgentMessage, settings: GenerationSettings) => {
    if (!session || !message.plan) return
    if (message.status === 'submitted') return
    onUpdateMessage(session.id, message.id, { plan: { ...message.plan, settings } })
  }

  const createNextRoundFromResults = (sourceNodeIds: string[], artifactCount: number) => {
    if (!sourceNodeIds.length) return
    onUseResultContext(sourceNodeIds)
    setInstruction(artifactCount === 1
      ? flowCopy.nextRoundOne
      : flowCopy.nextRoundMany(artifactCount))
    setActiveUtilityPanel(null)
    requestAnimationFrame(() => composerTextareaRef.current?.focus())
  }

  const continueFromArtifact = (artifact: BotanicAgentArtifact) => {
    onContinueArtifact(artifact)
    setInstruction(flowCopy.continueArtifact(artifact.label))
    setActiveUtilityPanel(null)
    requestAnimationFrame(() => composerTextareaRef.current?.focus())
  }

  const persistenceIssue = persistenceStatus === 'offline' || persistenceStatus === 'conflict' || persistenceStatus === 'error'
  const latestCollaborationActivity = collaborationAwareness.activities[0]
  const persistenceCopy = persistenceStatus === 'conflict'
    ? { ...flowCopy.conflict, action: 'refresh' as const }
    : persistenceStatus === 'offline'
      ? { ...flowCopy.offline, action: 'retry' as const }
      : { ...flowCopy.syncError, action: 'retry' as const }
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
      {isImageDropActive ? <div className="agent-workspace__drop-hint" aria-hidden="true"><UploadIcon /><strong>{flowCopy.dropImages}</strong><small>{flowCopy.uploadLimits}</small></div> : null}
      <header className="agent-workspace__header">
        <div className="agent-workspace__title">
          <button type="button" className="agent-workspace__history-button" onClick={(event) => { historyTriggerRef.current = event.currentTarget; setUtilityMenuOpen(false); setHistoryOpen((open) => !open) }} aria-controls={historyMenuId} aria-expanded={historyOpen} aria-label={unreadSessionCount ? flowCopy.historyUnread(unreadSessionCount) : flowCopy.history} title={flowCopy.history}><FigmaIcon src={historyIcon} />{unreadSessionCount ? <span className="agent-workspace__history-unread" aria-hidden="true">{Math.min(unreadSessionCount, 9)}</span> : null}</button>
          {renamingSession ? <form className="agent-workspace__title-editor" onSubmit={(event) => { event.preventDefault(); commitSessionTitle() }}>
            <input value={sessionTitleDraft} onChange={(event) => setSessionTitleDraft(event.target.value)} maxLength={160} autoFocus aria-label={flowCopy.conversationName} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); setRenamingSession(false) } }} />
            <button type="submit" aria-label={flowCopy.saveName} title={flowCopy.save}><CheckIcon /></button>
            <button type="button" aria-label={flowCopy.cancelName} title={flowCopy.cancel} onClick={() => setRenamingSession(false)}><CloseIcon /></button>
          </form> : <>
            <button type="button" className="agent-workspace__title-button" onClick={(event) => { historyTriggerRef.current = event.currentTarget; setUtilityMenuOpen(false); setHistoryOpen((open) => !open) }} aria-controls={historyMenuId} aria-expanded={historyOpen}>{displaySessionTitle(session?.title)} <span aria-hidden="true">⌄</span></button>
            {session ? <button type="button" className="agent-workspace__rename-button" aria-label={flowCopy.editName} title={flowCopy.editName} onClick={() => { setHistoryOpen(false); setSessionTitleDraft(displaySessionTitle(session.title)); setRenamingSession(true) }}><EditIcon /></button> : null}
          </>}
        </div>
        <div className="agent-workspace__header-actions">
          {collaborationAwareness.onlineCollaboratorCount ? <span
            className="agent-workspace__collaborators"
            title={flowCopy.collaborators(collaborationAwareness.onlineCollaboratorCount)}
            aria-label={flowCopy.collaborators(collaborationAwareness.onlineCollaboratorCount)}
          ><i aria-hidden="true" />{collaborationAwareness.onlineCollaboratorCount}</span> : null}
          {persistenceIssue ? <button
            type="button"
            className={`agent-workspace__persistence-status is-${persistenceStatus}`}
            aria-label={`${persistenceCopy.title}. ${persistenceAction ? flowCopy.processing : persistenceCopy.actionLabel}`}
            title={`${persistenceCopy.title} · ${persistenceCopy.actionLabel}`}
            disabled={Boolean(persistenceAction)}
            onClick={inspectPersistenceIssue}
          ><span aria-hidden="true">{persistenceStatus === 'conflict' ? '!' : '·'}</span></button> : null}
          <div ref={utilityMenuRef} className="agent-workspace__utility-menu-wrap">
            <button ref={utilityMenuButtonRef} type="button" className={`agent-workspace__utility-menu-button${utilityPanelOpen ? ' is-active' : ''}`} aria-haspopup="menu" aria-expanded={utilityMenuOpen} aria-controls={utilityMenuId} aria-label={copy.tools} title={copy.tools} onClick={() => { setUtilityMenuOpen((open) => !open); setHistoryOpen(false) }}><ChecklistIcon /></button>
            {utilityMenuOpen ? <div id={utilityMenuId} className="agent-workspace__utility-menu" role="menu" aria-label={copy.tools}>
              {utilityPanelOpen ? <button type="button" role="menuitem" onClick={closeUtilityPanel}><ChevronLeftIcon /><span>{copy.back}</span></button> : null}
              <button type="button" role="menuitem" className={resultPanelOpen ? 'is-active' : ''} onClick={() => toggleUtilityPanel('result')}><GalleryIcon /><span>{copy.results}</span></button>
              <button type="button" role="menuitem" className={taskPanelOpen ? 'is-active' : ''} onClick={() => toggleUtilityPanel('task')}><ChecklistIcon /><span>{copy.tasks}</span></button>
              <button type="button" role="menuitem" className={memoryPanelOpen ? 'is-active' : ''} onClick={() => toggleUtilityPanel('memory')}><BookmarkIcon /><span>{copy.memory}</span></button>
              <button type="button" role="menuitem" className={skillPanelOpen ? 'is-active' : ''} onClick={() => toggleUtilityPanel('skill')}><SparkleIcon /><span>{copy.skills}</span></button>
              <button type="button" role="menuitem" className={collaborationPanelOpen ? 'is-active' : ''} onClick={() => toggleUtilityPanel('collaboration')}><ChecklistIcon /><span>{copy.collaboration}</span>{collaborationAwareness.unreadActivityCount ? <b>{Math.min(collaborationAwareness.unreadActivityCount, 99)}</b> : null}</button>
              <button type="button" role="menuitem" className="is-danger" onClick={() => { setUtilityMenuOpen(false); onClose() }}><CloseIcon /><span>{copy.close}</span></button>
            </div> : null}
          </div>
        </div>
        {historyOpen ? <div id={historyMenuId} className="agent-workspace__history" aria-label={flowCopy.history}>
          <button type="button" onClick={() => { onNewSession(); setHistoryOpen(false); setHistoryQuery(''); setHistoryFilter('all') }}><PlusSquareIcon /> {flowCopy.newConversation}</button>
          <label className="agent-workspace__history-search"><input type="search" aria-label={flowCopy.searchConversations} value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} placeholder={flowCopy.searchPlaceholder} autoFocus /></label>
          <div className="agent-workspace__history-filters" aria-label={flowCopy.historyFilters}>
            {([
              ['all', flowCopy.all],
              ['unread', flowCopy.unread],
              ['results', flowCopy.newResults],
              ['attention', flowCopy.attention],
            ] as const).map(([value, label]) => <button
              key={value}
              type="button"
              className={historyFilter === value ? 'is-active' : ''}
              aria-pressed={historyFilter === value}
              onClick={() => setHistoryFilter(value)}
            >{label}<small>{historyFilterCounts[value]}</small></button>)}
          </div>
          {filteredSessionTimeline.map((item) => <button key={item.session.id} type="button" className={item.session.id === session?.id ? 'is-active' : ''} onClick={() => { onSelectSession(item.session.id); setHistoryOpen(false); setHistoryQuery('') }}>
            <span><strong>{displaySessionTitle(item.session.title)}</strong><small>{displaySessionPreview(item.preview)}</small></span>
            <span className="agent-workspace__history-meta"><time dateTime={new Date(item.updatedAt).toISOString()}>{agentTimelineTimestamp(item.updatedAt, locale)}</time>{item.unreadResultCount ? <b className="is-unread">{flowCopy.resultUpdates(item.unreadResultCount)}</b> : item.unreadRunCount ? <b className="is-unread">{flowCopy.updates(item.unreadRunCount)}</b> : item.attentionRunCount ? <b className="is-attention">{flowCopy.attentionCount(item.attentionRunCount)}</b> : item.activeRunCount ? <b>{flowCopy.activeCount(item.activeRunCount)}</b> : item.runCount ? <small>{flowCopy.taskCount(item.runCount)}</small> : null}</span>
          </button>)}
          {!filteredSessionTimeline.length ? <p className="agent-workspace__history-empty">{flowCopy.noConversations}</p> : null}
        </div> : null}
      </header>
      <div className="agent-workspace__body">
      {latestCollaborationActivity?.unread || (!utilityPanelOpen && readingRestoreNotice) ? <div className="agent-workspace__chrome">
      {latestCollaborationActivity?.unread ? <div className="agent-workspace__collaboration-notice" role="status">
        <button type="button" className="agent-workspace__collaboration-summary" onClick={() => locateCollaborationActivity(latestCollaborationActivity)}>
          <i aria-hidden="true" /><span><strong>{latestCollaborationActivity.actorName} · {latestCollaborationActivity.summary}</strong><small>{persistenceStatus === 'conflict' ? flowCopy.localChangesKept : latestCollaborationActivity.target && latestCollaborationActivity.target.kind !== 'project' ? flowCopy.locateChange : flowCopy.latestSynced}</small></span>
        </button>
        <button type="button" aria-label={flowCopy.closeCollaborationUpdate} title={flowCopy.gotIt} onClick={() => void onDismissRemoteChange().catch(() => undefined)}><CloseIcon /></button>
      </div> : null}
      {!utilityPanelOpen && readingRestoreNotice ? <div className="agent-reading-restore" role="status"><span>{flowCopy.readingRestored}</span><button type="button" onClick={jumpToLatestConversation}>{flowCopy.jumpLatest}</button></div> : null}
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
          generationModels={generationModels}
          artifactIndexStatus={artifactIndexStatus}
          artifactIndexHasMore={artifactIndexHasMore}
          conversationRunIds={runTimeline.flatMap((item) => item.source ? [item.run.id] : [])}
          onLocateNode={onLocateNode}
          onSaveArtifact={onSaveArtifact}
          onContinue={continueFromArtifact}
          onStartNextRound={createNextRoundFromResults}
          onLoadMoreArtifacts={onLoadMoreArtifacts}
          onLocateConversation={locateRunSourceMessage}
          onBackToConversation={closeUtilityPanel}
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
          onBackToConversation={closeUtilityPanel}
        /> : null}
        {memoryPanelOpen ? <AgentMemoryPanel
          memory={memory}
          sourceNodeIds={session?.contextNodeIds ?? []}
          onAddMemory={onAddMemory}
          onRemoveMemory={onRemoveMemory}
          onLocateNode={onLocateNode}
          onBackToConversation={closeUtilityPanel}
        /> : null}
        {taskPanelOpen ? <section className="agent-task-panel" aria-label={flowCopy.tasksAria}>
          <header><AgentPanelBackButton onClick={closeUtilityPanel} /><div><small>AGENT RUNS</small><h2>{flowCopy.tasksTitle}</h2></div><span>{flowCopy.taskCount(runs.length)}</span></header>
          <p>{flowCopy.tasksDescription}</p>
          <div className="agent-task-panel__filters" aria-label={flowCopy.taskFilters}>
            {([
              ['all', flowCopy.all, taskFilterCounts.all],
              ['active', flowCopy.active, taskFilterCounts.active],
              ['completed', flowCopy.completed, taskFilterCounts.completed],
              ['attention', flowCopy.attention, taskFilterCounts.attention],
            ] as const).map(([value, label, count]) => <button
              key={value}
              type="button"
              aria-label={flowCopy.filterCount(label, count)}
              aria-pressed={taskStatusFilter === value}
              title={flowCopy.filterCount(label, count)}
              onClick={() => setTaskStatusFilter(value)}
            ><AgentTaskFilterIcon value={value} /><span>{label}</span><b>{count}</b></button>)}
          </div>
          <div className="agent-task-panel__list">
            {filteredRunTimeline.map(({ run, source }) => {
              const feedback = agentRunFeedback(run, artifacts, availableCanvasNodeIds, locale)
              const active = run.status === 'queued' || run.status === 'running' || run.status === 'executing'
              const failedBranches = run.branches.filter((branch) => branch.status === 'failed' || branch.status === 'cancelled')
              return <article key={run.id} ref={(node) => { if (node) taskNodesRef.current.set(run.id, node); else taskNodesRef.current.delete(run.id) }} tabIndex={-1} className={`is-${run.status} is-${feedback.tone}${focusedTaskRunId === run.id ? ' is-located' : ''}`}>
              <header><span><strong>{run.plan.summary}</strong><small>{feedback.label} · <time dateTime={new Date(run.updatedAt).toISOString()}>{agentTimelineTimestamp(run.updatedAt, locale)}</time></small></span></header>
              <p className="agent-task-panel__feedback">{feedback.detail}</p>
              {active ? <div className="agent-run-card__track" aria-hidden="true"><i style={{ width: `${run.branches.length ? Math.round(run.completedBranchCount / run.branches.length * 100) : 0}%` }} /></div> : null}
              <div className="agent-task-panel__actions">
                {source ? <button type="button" onClick={() => locateTaskSourceMessage(source)}>{flowCopy.sourceConversation}</button> : null}
                {!active && feedback.action !== 'none' ? <button type="button" onClick={() => openRunFeedback(run)}>{feedback.actionLabel}</button> : null}
                {active ? <button type="button" className="is-danger" disabled={cancellingRunId === run.id} onClick={() => { setCancellingRunId(run.id); void onCancelRun(run.id).finally(() => setCancellingRunId('')) }}>{cancellingRunId === run.id ? flowCopy.cancelling : flowCopy.cancel}</button> : null}
              </div>
              {run.branches.length >= 2 ? <details className="agent-task-panel__details" open>
                <summary>{agentTaskBranchSummary(run, locale)}</summary>
                <div className="agent-task-panel__branch-list" aria-label={flowCopy.branchStatus}>
                  {run.branches.map((branch) => <div className={`agent-task-panel__branch-row is-${branch.status}`} key={branch.id}>
                    <strong>{branch.label}</strong>
                    <small>{branchStatusLabel(branch.status)}</small>
                  </div>)}
                </div>
              </details> : null}
              {failedBranches.map((branch) => <div className="agent-task-panel__branch" key={branch.id}><span><strong>{branch.label}</strong><small>{branch.error ? localizeProductError(new Error(branch.error), locale, { 'zh-CN': flowCopy.branchIncomplete, en: flowCopy.branchIncomplete }) : flowCopy.branchIncomplete}</small></span><AgentFailureRecoveryActions
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
            {!filteredRunTimeline.length ? <div className="agent-panel__empty">{runTimeline.length ? flowCopy.noFilteredTasks : flowCopy.noTasks}</div> : null}
          </div>
        </section> : null}
        {skillPanelOpen ? <section className="agent-skill-panel" aria-label={flowCopy.skillsAria}>
          <header><AgentPanelBackButton onClick={closeUtilityPanel} /><div><small>SKILL REGISTRY</small><h2>{flowCopy.skillsTitle}</h2></div><span>{flowCopy.skillCount(systemSkills.length + skills.length)}</span></header>
          <p>{flowCopy.skillsDescription}</p>
          {systemSkills.length ? <div className="agent-skill-panel__catalog"><strong>{flowCopy.systemSkills}</strong>{systemSkills.map((skill) => <AgentSkillCard
            key={skill.id}
            id={skill.id}
            name={skill.name}
            instructions={skill.instructions}
            source="system"
            expanded={expandedSkillId === skill.id}
            mounted={Boolean(session?.mountedSkillIds?.includes(skill.id))}
            onToggle={(id) => setExpandedSkillId((current) => current === id ? '' : id)}
            onToggleMount={session ? toggleMountedSkill : undefined}
          />)}</div> : null}
          {!skillFormOpen && !skillConfirming && !skillError ? <button type="button" className="agent-skill-panel__create-entry" aria-expanded="false" onClick={() => setSkillFormOpen(true)}>{flowCopy.newSkill}</button> : <div className="agent-skill-panel__form">
              <input ref={skillNameInputRef} value={skillName} onChange={(event) => { setSkillName(event.target.value); setSkillConfirming(false); setSkillError('') }} maxLength={80} placeholder={flowCopy.skillNamePlaceholder} aria-label={flowCopy.skillName} autoFocus />
              <textarea value={skillInstructions} onChange={(event) => { setSkillInstructions(event.target.value); setSkillConfirming(false); setSkillError('') }} maxLength={4000} placeholder={flowCopy.skillRulesPlaceholder} aria-label={flowCopy.skillRules} />
              {skillConfirming ? <div className="agent-skill-panel__confirm">
                <span><strong>{flowCopy.createProjectSkill}</strong><small>{flowCopy.createProjectSkillDetail}</small></span>
                <div><button type="button" autoFocus onClick={() => { setSkillConfirming(false); requestAnimationFrame(() => skillCreateButtonRef.current?.focus()) }}>{flowCopy.cancel}</button><button type="button" disabled={skillSaving} onClick={() => void confirmSkillCreation()}>{skillSaving ? flowCopy.creating : flowCopy.confirmCreate}</button></div>
              </div> : <div className="agent-skill-panel__form-actions"><button ref={skillCreateButtonRef} type="button" className="agent-skill-panel__cancel" onClick={() => { setSkillFormOpen(false); setSkillError('') }}>{flowCopy.cancel}</button><button type="button" className="agent-skill-panel__create" disabled={!skillName.trim() || !skillInstructions.trim()} onClick={() => setSkillConfirming(true)}>{flowCopy.createSkill}</button></div>}
              {skillError ? <p role="alert">{skillError}</p> : null}
            </div>}
          <div className="agent-skill-panel__list">
            {skills.map((skill) => <AgentSkillCard
              key={skill.id}
              id={skill.id}
              name={skill.name}
              instructions={skill.instructions}
              source="project"
              expanded={expandedSkillId === skill.id}
              mounted={Boolean(session?.mountedSkillIds?.includes(skill.id))}
              onToggle={(id) => setExpandedSkillId((current) => current === id ? '' : id)}
              onToggleMount={session ? toggleMountedSkill : undefined}
            />)}
            {!skills.length && !skillError ? <div className="agent-panel__empty">{flowCopy.noProjectSkills}</div> : null}
          </div>
        </section> : null}
        {!utilityPanelOpen && !hasMessages ? <section className="agent-workspace__welcome">
          <span className="agent-workspace__mark"><SparkleIcon /></span>
          <small>BOTANIC AGENT</small>
          <h2>{target ? copy.welcomeTarget(agentTargetDisplayLabel(target)) : copy.welcome}</h2>
          <p>{target ? copy.welcomeTargetBody : copy.welcomeBody}</p>
          <div className="agent-workspace__starters">
            {agentQuickActions(locale).slice(0, 3).map((action) => <button key={action.intent} type="button" onClick={() => { setIntent(action.intent); setInstruction(action.instruction) }}><strong>{action.label}</strong><span>{action.instruction}</span></button>)}
          </div>
        </section> : null}
        {!utilityPanelOpen && session ? renderedConversationMessages.map((message) => {
          const live = liveConversation?.sessionId === session.id && liveConversation.message.id === message.id
            ? liveConversation
            : undefined
          const executionTimeline = executionTimelines[message.id]
          return <div
            key={message.id}
            ref={(node) => registerMessageNode(message.id, node)}
            className={`agent-conversation-anchor${locatedMessageId === message.id ? ' is-located' : ''}`}
            tabIndex={-1}
            data-agent-message-id={message.id}
          ><AgentConversationMessage
          message={message}
          timeline={live?.timeline ?? executionTimeline}
          streaming={live?.streaming}
          sessionId={session.id}
          runs={runs}
          artifacts={artifacts}
          contextOptionIds={contextOptions.map((item) => item.id)}
          mentionCatalog={mentionCatalog}
          generationModels={generationModels}
          executionMode={session.executionMode}
          planning={planning}
          promptUsePending={pendingPromptSourceIds.has(message.id)}
          plannerModel={plannerModel}
          executingActionId={executingActionId}
          submittingMessageId={submittingMessageId}
          promptDraft={promptDrafts[message.id]}
          onContinueResultContext={(nodeIds, outputCount) => {
            onUseResultContext(nodeIds)
            setInstruction(outputCount === 1 ? flowCopy.refineOne : outputCount > 1 ? flowCopy.refineMany(outputCount) : flowCopy.continueContext)
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
          onCommitPlanSettings={commitPlanSettings}
          onConfirmPlan={(targetMessage) => void confirmMessagePlan(targetMessage)}
          onGenerateCompositionItem={(targetMessage, item) => {
            const composition = botanicAgentMessageComposition(targetMessage)
            if (!composition) return
            const instruction = locale === 'en' ? `Generate item ${item.index}` : `生成第 ${item.index} 项`
            void runInstruction(instruction, {
              appendUser: instruction,
              composition,
              resolvedGeneration: {
                mediaKind: item.mediaKind,
                prompt: item.prompt,
                count: item.count,
                ...(item.duration ? { duration: item.duration } : {}),
              },
            })
          }}
          onRunComposition={(targetMessage) => {
            const composition = botanicAgentMessageComposition(targetMessage)
            if (!composition) return
            const instruction = locale === 'en' ? 'Run the full composition' : '执行方案'
            void runInstruction(instruction, { appendUser: instruction, composition })
          }}
          onUsePrompt={usePromptForGeneration}
          onEdit={(content) => { setInstruction(content); requestAnimationFrame(() => composerTextareaRef.current?.focus()) }}
          onRetryDelivery={retryMessage}
          onFeedback={(targetMessage, feedback) => onUpdateMessage(session.id, targetMessage.id, { feedback })}
        /></div>
        }) : null}
        {!utilityPanelOpen && showRuntimeFeed ? (() => {
          const livePhase = runtimePhase === 'reading' || runtimePhase === 'planning' || runtimePhase === 'executing'
          return <section className={`agent-runtime-feed is-${runtimeDisplaySummary.phase}${runtimeFailed ? ' is-failed' : runtimeComplete ? ' is-complete' : ''}`} data-phase={runtimeDisplaySummary.phase} role="status" aria-live={livePhase ? 'polite' : undefined} aria-label={flowCopy.runtimeAria}>
            <header className="agent-runtime-feed__header">
              <span className="agent-runtime-feed__status">
                <span className="agent-runtime-feed__mark" aria-hidden="true">
                  {livePhase && !runtimeFailed ? <span className="agent-composer__spinner" /> : runtimeFailed ? <AlertIcon /> : runtimeComplete ? <CheckIcon /> : <ClockIcon />}
                </span>
                <strong>{runtimeDisplaySummary.label}</strong>
                {runtimeDisplaySummary.totalCount ? <small>{runtimeDisplaySummary.completedCount}/{runtimeDisplaySummary.totalCount}</small> : null}
              </span>
              <button type="button" className="agent-runtime-feed__toggle" aria-label={runtimeDetailsOpen ? flowCopy.collapseSteps : flowCopy.viewSteps} title={runtimeDetailsOpen ? flowCopy.collapseSteps : flowCopy.viewSteps} aria-expanded={runtimeDetailsOpen} aria-controls={runtimeStepsId} onClick={() => setRuntimeDetailsOpen((open) => !open)}>
                <ChecklistIcon />
              </button>
            </header>
            <p className="agent-runtime-feed__summary">{runtimeDisplaySummary.detail}</p>
            {runtimeDisplaySummary.phase === 'waiting_clarification' || runtimeDisplaySummary.phase === 'waiting_confirmation' || runtimeDisplaySummary.phase === 'waiting_reference' || runtimeDisplaySummary.phase === 'draft_ready' ? <span className="agent-runtime-feed__next">{flowCopy.nextStep}{runtimeDisplaySummary.nextAction}</span> : null}
            {runtimeDetailsOpen ? <ol id={runtimeStepsId} aria-label={flowCopy.runSteps}>
              {runtimeSteps.map((step) => <li key={step.id} className={`is-${step.status}`}>
                <span className="agent-runtime-feed__step-marker" aria-hidden="true">{agentRuntimeStepMarker(step)}</span>
                <span className="agent-runtime-feed__step-copy"><strong>{step.status === 'running' ? flowCopy.runningStep(step.label) : step.label}</strong><small>{step.error && locale === 'en' ? flowCopy.runtimeStepFailed : step.error ?? step.detail}</small></span>
                <em>{agentRuntimeStepStatusLabel(step.status, locale)}</em>
              </li>)}
            </ol> : null}
          </section>
        })() : null}
        {!utilityPanelOpen && latestRun?.branches.length && latestRunFeedback && ['queued', 'running', 'executing'].includes(latestRun.status) ? <section className={`agent-run-card is-${latestRunFeedback.tone} is-compact`} aria-label={flowCopy.runProgress}>
          <header>
            <b aria-label={flowCopy.runProgress}>{latestRun.completedBranchCount}/{latestRun.branches.length}</b>
            <button type="button" className="agent-icon-button agent-icon-button--danger" aria-label={flowCopy.cancelTask} title={flowCopy.cancelTask} disabled={cancellingRunId === latestRun.id} onClick={() => { setCancellingRunId(latestRun.id); setError(''); void onCancelRun(latestRun.id).then((ok) => { if (!ok) setError(flowCopy.cancelFailed) }).catch(() => setError(flowCopy.cancelFailed)).finally(() => setCancellingRunId('')) }}>{cancellingRunId === latestRun.id ? <span className="agent-workspace__mini-spinner" /> : <CloseIcon />}</button>
          </header>
          <div className="agent-run-card__track" aria-hidden="true"><i style={{ width: `${Math.round(latestRun.completedBranchCount / latestRun.branches.length * 100)}%` }} /></div>
          <div className="agent-run-card__branches">
            {latestRun.branches.map((branch) => <div key={branch.id}><span><strong>{branch.label}</strong></span>{branch.status === 'failed' || branch.status === 'cancelled' ? <AgentFailureRecoveryActions
              branch={branch}
              generationModels={generationModels}
              retrying={retryingBranchId === branch.id}
              menuOpen={recoveryModelMenuKey === `${latestRun.id}:${branch.id}`}
              onToggleModelMenu={() => setRecoveryModelMenuKey((current) => current === `${latestRun.id}:${branch.id}` ? '' : `${latestRun.id}:${branch.id}`)}
              onPrepare={(mode, model) => prepareFailedRunRecovery(latestRun, mode, model)}
              onRetry={() => { setRetryingBranchId(branch.id); setError(''); void onRetryBranch(latestRun.id, branch.id).then((ok) => { if (!ok) setError(flowCopy.retryFailed(branch.label)) }).finally(() => setRetryingBranchId('')) }}
            /> : null}</div>)}
          </div>
        </section> : null}
        <div ref={messageEndRef} />
      </div>
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
      {pendingRegionInstruction && target?.image ? <RegionMaskEditor
        target={{ id: target.id, name: target.label, image: target.image }}
        busy={planning}
        hidePrompt
        submitLabel={locale === 'en' ? 'Continue with selection' : '按选区继续'}
        onSubmit={({ rect }) => {
          const request = pendingRegionInstruction
          setPendingRegionInstruction(null)
          void runInstruction(request.instruction, {
            ...request.options,
            region: { rect, description: describeRegionRect(rect, locale) },
          })
        }}
        onClose={() => {
          setPendingRegionInstruction(null)
          appendMessage({ role: 'assistant', kind: 'notice', content: locale === 'en' ? 'Region selection cancelled. You can select an area again when you send another instruction.' : '已取消局部重绘框选；再次发送指令时可重新框选。' })
        }}
      /> : null}
    </aside>
  )
}
