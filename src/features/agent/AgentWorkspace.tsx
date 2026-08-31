import { type ClipboardEvent, type DragEvent, useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from 'react'
import {
  botanicAgentComposerGroupRole,
  botanicAgentCanResumeManualRetry,
  botanicAgentCanUseManualRetryAuthorization,
  botanicAgentContextSnapshotNodeIds,
  botanicAgentAutoRetryTargets,
  botanicAgentSubmissionKey,
  buildBotanicAgentRunTimeline,
  buildBotanicAgentSessionTimeline,
  filterBotanicAgentSessionTimeline,
  buildBotanicAgentPlan,
  createBotanicAgentContextSnapshot,
  consumeBotanicAgentMention,
  normalizeBotanicAgentContextNodeIds,
  prepareBotanicAgentComposerSubmission,
  snapshotBotanicAgentComposerMentions,
  readBotanicAgentMentionQuery,
  resolveBotanicAgentExecutionDecision,
  BOTANIC_AGENT_MAX_SINGLE_OUTPUT,
  botanicAgentPendingConfirmationCount,
  pendingBotanicAgentAutoSubmission,
  shouldRetryBotanicAgentAutoSubmission,
  summarizeBotanicAgentRuntime,
  shouldRestoreBotanicAgentRuntimeSteps,
  shouldShowBotanicAgentRuntimeFeed,
  type BotanicAgentActionProposal,
  type BotanicAgentActionResult,
  type BotanicAgentArtifact,
  type BotanicAgentClarificationResponse,
  type BotanicAgentConfirmationWaiver,
  type BotanicAgentExecutionMode,
  type BotanicAgentIntent,
  type BotanicAgentMemoryItem,
  type BotanicAgentMemoryKind,
  type BotanicAgentManualRetryAuthorization,
  type BotanicAgentMentionCatalog,
  type BotanicAgentMentionQuery,
  type BotanicAgentMessage,
  type BotanicAgentMessageMention,
  type BotanicAgentPlan,
  type BotanicAgentRun,
  type BotanicAgentSession,
  type BotanicAgentSessionTimelineFilter,
  type BotanicCreativeBrief,
} from '../../domain/agent'
import {
  botanicAgentComposerIntentHint,
  decideBotanicAgentRequest,
  isBotanicAgentPromptGenerationPending,
} from '../../domain/agentChatContract'
import { advanceBotanicCreativeBrief, applyBotanicCreativeBriefAnswers } from '../../domain/agentCreativeBrief'
import {
  buildBotanicAgentInitialDraftPlan,
  prepareBotanicAgentGenerationDraft,
  resolveBotanicAgentInstructionEntry,
} from '../../domain/agentInstructionRouting'
import { formatBotanicAgentRunReviewMessage } from '../../domain/agentReviewContract'
import type { BotanicAgentRunReview } from '../../domain/agentReviewContract'
import { resolveAgentChatPrompt } from '../../domain/agentMarkdown'
import type { BotanicAgentChatStreamEvent } from '../../domain/agentChatStream'
import {
  botanicAgentTurnRequestFromSnapshot,
  botanicAgentTurnRequestSnapshot,
} from '../../domain/agentTurnContract'
import {
  botanicAgentTurnRequestKey,
  botanicAgentTurnGenerationContinuation,
  botanicAgentTurnProjectionMessageId,
  botanicAgentTurnRecoveryKey,
  hasBotanicAgentTurnCancellationIntent,
  isRetryableBotanicAgentTurnRecoveryError,
  pendingBotanicAgentTurnProjection,
  resolveBotanicAgentContinuationTarget,
  retryBotanicAgentTurnCancellation,
  settleBotanicAgentCancellationSession,
  stopBotanicAgentPlanning,
} from '../../domain/agentTurnObservation'
import { applyAgentConversationStreamEvent, createAgentTimeline, persistAgentLiveTimeline, projectBotanicAgentRunOntoTimeline, type AgentTimelineEvent, type AgentTimelineState } from '../../domain/agentTimeline'
import { botanicAgentLatestEvaluableMessageId } from '../../domain/agentMessageUtilities'
import { nextExclusiveSurface, type ExclusiveSurfaceAction } from '../../domain/exclusiveSurface'
import { uploadLimitsLabel } from '../../domain/mediaFormats'
import { clipboardHasPlainText, clipboardMediaFiles, pasteTarget } from '../../domain/clipboardMedia'
import type { CollaborationActivity, CollaborationDocumentChange } from '../../domain/collaborationActivity'
import type {
  AssetGroup,
  GenerationModelOption,
  GenerationSettings,
  UploadedAssetInput,
} from '../../domain/canvas'
import type { GenerationSizeOverride } from '../../domain/generationOutputSize'
import {
  cancelPersistentBotanicAgentTurn,
  observePersistentBotanicAgentTurn,
  readPersistentBotanicAgentTurnEvents,
  requestBotanicAgentPlan,
  submitBotanicAgentReviewDecision,
  streamBotanicAgentChat,
  streamBotanicAgentPlan,
  streamBotanicAgentTurn,
} from '../../lib/agentApi'
import {
  agentTurnTimelineHydrationFailureDisposition,
  agentTurnTimelineFromHydrationRead,
  beginAgentTurnTimelineHydrationBatch,
  mergeHydratedAgentTurnTimeline,
  releaseAbortedAgentTurnTimelineHydrations,
  type AgentTurnTimelineHydrationAttemptState,
} from './agentTurnTimelineHydration'
import { botanicAgentRegionSelectNotice, instructionRequestsMarkOverlay } from '../../domain/generationComposition'
import { describeRegionRect } from '../../domain/regionMask'
import { RegionMaskEditor } from '../canvas/RegionMaskEditor'
import {
  botanicAgentMessageComposition,
  botanicAgentCompositionTotalCandidateCount,
  buildBotanicAgentCompositionPlan,
  formatBotanicAgentCompositionSummary,
  instructionRequestsCompositionRun,
  latestBotanicAgentComposition,
  normalizeBotanicAgentComposition,
  resolveBotanicAgentCompositionImageModel,
  resolveBotanicAgentCompositionItem,
} from '../../domain/agentCreativeComposition'
import {
  applyBotanicAgentVariationToPlan,
  botanicAgentBriefWithVariationAnswers,
} from '../../domain/agentVariations'
import { ProductApiError, serverPersistenceEnabled } from '../../lib/productSession'
import { maxUploadAssets, readUploadedAssetInput, validateUploadFiles } from '../../lib/uploadedAssets'
import { useCanvasStore } from '../../store/canvasStore'
import type { CollaborationStatus } from '../../store/canvasStore.types'
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
  applyAgentSessionContextChange,
  initialAgentComposerState,
  resolveAgentRetrySourceMessage,
  type AgentFailedInstruction,
  type AgentInstructionRetryOptions,
} from './agentComposerState'
import { useAgentMessageDelivery } from './useAgentMessageDelivery'
import {
  persistBotanicAgentActionMessageUpdate,
  persistBotanicAgentMessageUpdate,
  upsertBotanicAgentMessageProjection,
  type AgentMessagePatch,
} from './agentActionMessagePersistence'
import { useAgentReviewProjection } from './useAgentReviewProjection'
import { useAgentRuntimeTrace } from './useAgentRuntimeTrace'
import { recoverPendingAgentTurn } from './agentTurnRecovery'
import { useAgentActionLifecycle } from './useAgentActionLifecycle'
import type { AgentArtifactIndexState, AgentContextItem, AgentDockTarget, AgentSkillOption } from './agentWorkspace.types'
import { AgentCollaborationPanel, AgentMemoryPanel, AgentResultPanel, AgentReviewPanel, BrandKitPanel } from './AgentUtilityPanels'
import { AgentSkillPanel } from './AgentSkillPanel'
import { AgentTaskPanel } from './AgentTaskPanel'
import { useAgentSkillRegistry } from './useAgentSkillRegistry'
import { agentEscapeDismissTarget, type AgentDismissTarget } from './agentWorkspaceNavigation'
import { AgentConversationMessage } from './AgentConversationMessage'
import { AgentComposer } from './AgentComposer'
import { BobCharacter } from '../../components/bob/BobCharacter'
import { bobWelcomePresentation } from '../../domain/bobPresentation'
import { useBobSaysPlays } from './useBobSaysPlays'
import {
  AlertIcon,
  BookIcon,
  BookmarkIcon,
  CheckIcon,
  ChecklistIcon,
  ClockIcon,
  CloseIcon,
  DismissIcon,
  FocusIcon,
  GalleryIcon,
  EditIcon,
  GlobeIcon,
  MoreIcon,
  PlusIcon,
  SparkleIcon,
  UploadIcon,
} from '../../components/BotanicIcons'
import {
  botanicMotion,
  captureFlipState,
  gsap,
  isFollowingLatest,
  playSurfaceFlip,
  prefersReducedMotion,
  scrollElementIntoView,
  useGSAP,
} from '../../components/gsapMotion'
import { useProductI18n, useProductMessages } from '../../i18n/react'
import { localizeProductError, productIntlLocale, type ProductLocale } from '../../i18n/core'

type AgentTransientSurface = 'context' | 'history' | 'utility' | 'mode'
type AgentUtilityPanel = 'result' | 'task' | 'memory' | 'skill' | 'collaboration' | 'review' | 'brand'
type AgentRunInstructionOptions = AgentInstructionRetryOptions & {
  appendUser?: string
  mentions?: BotanicAgentMessageMention[]
  turnProjection?: { turnId: string; messageId: string }
  sourceMessageId?: string
  requestId?: string
  sourceTurnId?: string
}
type AgentLiveConversation = {
  sessionId: string
  message: BotanicAgentMessage
  timeline: AgentTimelineState
  streaming: boolean
}

const maximumConcurrentTurnTimelineHydrations = 2

function agentTimelineEvent(event: BotanicAgentChatStreamEvent, receivedAt: number): AgentTimelineEvent {
  if (event.type === 'handoff') return { type: 'handoff', receivedAt }
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
    { intent: 'replace_scene', label: 'Change scene', instruction: 'Replace the scene and light. Keep person, clothes, and product.' },
    { intent: 'change_pose', label: 'Change pose', instruction: 'Adjust pose and framing. Keep person, clothes, product, and scene.' },
    { intent: 'change_style', label: 'Change style', instruction: 'Adjust visual style. Keep person, clothes, product, and scene.' },
  ] : [
    { intent: 'replace_scene', label: '换场景', instruction: '替换场景和光线。人物、服装、商品保持。' },
    { intent: 'change_pose', label: '换动作', instruction: '调整姿势和构图。人物、服装、商品、场景保持。' },
    { intent: 'change_style', label: '换风格', instruction: '调整视觉风格。人物、服装、商品、场景保持。' },
  ]
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
  onPrepareVisionContext,
  onResolveTarget,
  onAppendMessage,
  onUpsertMessage,
  onUpdateMessage,
  onUpdateAction,
  onContextChange,
  onExecutionModeChange,
  onWaiveConfirmation,
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
  onPromoteRunToWorkflow,
  onResolveRunNodes,
  onSaveArtifact,
  onContinueArtifact,
  onLoadMoreArtifacts,
  onUseResultContext,
  onRetryPersistence,
  onRefreshRemote,
  onBindBrand,
  collaborationAwareness,
  onDismissRemoteChange,
  onClearCollaborationActivities,
  onLoadMoreCollaborationActivities,
  onReloadCollaborationActivities,
  onLoadOlderMessages,
  hasOlderMessages = false,
  loadingOlderMessages = false,
  persistenceStatus,
  fromEmptyGuide = false,
  onClose,
}: {
  projectId: string
  escapeEnabled: boolean
  persistenceStatus: 'saved' | 'saving' | 'offline' | 'conflict' | 'error'
  collaborationAwareness: {
    realtimeStatus: CollaborationStatus
    onlineCollaboratorCount: number
    activities: CollaborationActivity[]
    unreadActivityCount: number
    conflictChanges: CollaborationDocumentChange[]
    conflictRevision?: { localRevision?: number; remoteRevision: number }
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
  onConfirmAction: (
    action: BotanicAgentActionProposal,
    context: { sessionId: string; messageId: string },
    options?: {
      manualRetryAuthorization?: BotanicAgentManualRetryAuthorization
      resumeManualRetry?: { retryIdempotencyKey: string }
      observedResult?: BotanicAgentActionResult
    },
  ) => Promise<BotanicAgentActionResult>
  onUploadImages: (uploads: UploadedAssetInput[]) => void
  onPrepareVisionContext?: (sessionId: string) => Promise<string[]>
  /** 按 Turn 快照中的稳定 nodeId 解析父结果；禁止用当前选中猜测。 */
  onResolveTarget: (nodeId: string) => AgentDockTarget | undefined
  onAppendMessage: (sessionId: string, message: BotanicAgentMessage) => void
  onUpsertMessage: (sessionId: string, message: BotanicAgentMessage) => void
  onUpdateMessage: (sessionId: string, messageId: string, patch: Partial<Pick<BotanicAgentMessage, 'kind' | 'content' | 'runId' | 'status' | 'feedback' | 'plan' | 'question' | 'composition' | 'deliveryStatus' | 'review' | 'turnId' | 'turnCancellationRequestedAt' | 'turnRequestSnapshot'>>) => void
  onUpdateAction: (
    sessionId: string,
    messageId: string,
    actionId: string,
    patch: Partial<Pick<BotanicAgentActionProposal, 'status' | 'receiptIdempotencyKey' | 'preparedRetryIdempotencyKey' | 'manualRetryResumeAvailable' | 'error' | 'result'>>,
  ) => void
  onContextChange: (sessionId: string, contextNodeIds: string[]) => void
  onExecutionModeChange: (sessionId: string, mode: BotanicAgentExecutionMode) => void
  onWaiveConfirmation: (sessionId: string, waiver: BotanicAgentConfirmationWaiver) => void
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
  /** 把这次运行带进画布的自动化面板；发布本身仍在那里完成。 */
  onPromoteRunToWorkflow: (runId: string) => void
  /** 解析某个 Run 当前在画布上的占位/结果节点；Agent 面板本身读不到画布图谱。 */
  onResolveRunNodes: (runId: string) => string[]
  onSaveArtifact: (artifact: BotanicAgentArtifact) => void
  onContinueArtifact: (artifact: BotanicAgentArtifact) => void
  onLoadMoreArtifacts: () => Promise<void>
  onUseResultContext: (sourceNodeIds: string[]) => void
  onRetryPersistence: () => Promise<boolean>
  onRefreshRemote: () => Promise<boolean>
  onBindBrand: (brandId: string) => Promise<boolean>
  onDismissRemoteChange: () => Promise<void>
  onClearCollaborationActivities: () => Promise<void>
  onLoadMoreCollaborationActivities: () => Promise<void>
  onReloadCollaborationActivities: () => Promise<void>
  onLoadOlderMessages?: () => void
  hasOlderMessages?: boolean
  loadingOlderMessages?: boolean
  /** 从空画布引导 Flip 打开时关掉 CSS 侧滑，并挂上 data-flip-id。 */
  fromEmptyGuide?: boolean
  onClose: () => void
}) {
  const { locale } = useProductI18n()
  const copy = useProductMessages({
    'zh-CN': {
      tools: 'Agent 工具', results: '结果与文件', tasks: 'Agent 任务', review: '结果评审', brand: '品牌规则', memory: '项目记忆', skills: '创作技能', collaboration: '协作动态', close: '关闭 Agent',
      welcomeMark: 'Botanic Agent',
      welcome: '今天一起创作什么？', welcomeTarget: (name: string) => `继续优化「${name}」`, welcomeBody: '可以日常对话、生成 Prompt、检索项目，也可以直接描述生图目标。', welcomeTargetBody: '保留当前画面与原始参数，仅调整你刚提出的内容。',
      sources: '来源', unavailable: 'Agent 暂时无法回答，请稍后重试。', unsupportedVideo: 'Agent 对话暂未接入视频执行链。请先在画布添加「视频生成」节点；本次没有创建节点或任务。', clarifyAction: '请明确是只需要建议，还是要我直接生成；本次没有改动画布。',
    },
    en: {
      tools: 'Agent tools', results: 'Results & files', tasks: 'Agent tasks', review: 'Result review', brand: 'Brand rules', memory: 'Project memory', skills: 'Creative skills', collaboration: 'Collaboration', close: 'Close Agent',
      welcomeMark: 'BOTANIC AGENT',
      welcome: 'What are we making?', welcomeTarget: (name: string) => `Refine “${name}”`, welcomeBody: 'Chat, write prompts, or search the project.', welcomeTargetBody: 'Keep the current visual and original settings. Change only what you asked.',
      sources: 'Sources', unavailable: 'Agent is temporarily unavailable. Try again shortly.', unsupportedVideo: 'Video execution is not available in Agent chat yet. Add a Video Generation node on the canvas; no node or task was created.', clarifyAction: 'Please clarify whether you only want advice or want me to generate it. The canvas was not changed.',
    },
  })
  const flowCopy = locale === 'en' ? {
    sources: 'Sources', noSources: 'No governed project sources matched this request.', incomplete: 'Not completed', unavailable: 'Agent is temporarily unavailable. Try again shortly.',
    promptMissing: 'I could not find the prompt you referenced. Ask Agent to write one or paste the complete prompt. The canvas was not changed.',
    settingsMissing: 'No complete generation settings are available. Check the model catalog.', planFailed: 'Unable to create the generation plan. Try again shortly.', customDirection: 'Custom direction',
    usePrompt: 'Use this prompt to generate', nextRoundOne: 'Continue from this result:', nextRoundMany: (count: number) => `Continue from these ${count} results:`, continueArtifact: (label: string) => `Continue editing “${label}”:`,
    conflict: { title: 'A newer canvas version is available', detail: 'Your local draft and generation results are preserved.', actionLabel: 'Review changes' }, useRemoteConfirm: 'Replace this local draft with the cloud version?',
    offline: { title: 'Using an offline draft', detail: 'This edit will sync when the connection is restored.', actionLabel: 'Retry sync' },
    syncError: { title: 'Canvas sync is temporarily unavailable', detail: 'Your current edits remain saved locally and can sync later.', actionLabel: 'Retry sync' },
    dropImages: 'Drop to add image assets', uploadLimits: uploadLimitsLabel('en'), imageLimit: (count: number) => `You can add up to ${count} images at once. Extra images were skipped.`, imageReadFailed: 'Unable to read the images. Drop or select them again.',
    planningUnavailable: 'Unable to create the plan. Try again shortly.', localPreviewChat: 'The local preview is not connected to Agent services. You can still use the canvas and structured prompts; connect the workspace service for chat, research, and execution.', localPreviewPrompt: (prompt: string) => `Local preview prepared this structured Prompt:\n\n${prompt}\n\nConnect the workspace service to continue with research or execution.`, confirmActionsFirst: 'Approve or skip the pending action cards before starting generation.', taskNotStarted: 'The task did not start. Check the references and generation service, then retry.', taskStartFailed: 'Unable to start the task. Try again.', canvasWritten: ' Added to the canvas.', actionFailed: 'Unable to complete the action. Try again.', retryWithModel: (model: string, prompt: string) => `Regenerate with ${model}: ${prompt}`, retrySettings: (prompt: string) => `Adjust the output settings and regenerate: ${prompt}`, pendingQuestion: 'A confirmation card above still needs an answer. Select or enter a response in the card. No task was created.', noPendingPlan: 'There is no generation plan awaiting approval. Describe the image or batch values you want, and Agent will prepare a plan for review.',
    history: 'Conversation history', historyUnread: (count: number) => `Conversation history, ${count} ${count === 1 ? 'conversation has' : 'conversations have'} updates`, conversationName: 'Conversation name', saveName: 'Save conversation name', save: 'Save', cancelName: 'Cancel editing conversation name', cancel: 'Cancel', newConversation: 'New chat', editName: 'Rename', collaborators: (count: number) => `${count} other ${count === 1 ? 'collaborator' : 'collaborators'} online`, processing: 'Processing', realtimeConnecting: 'Connecting collaboration…', realtimeReconnecting: 'Reconnecting…', realtimeReconnectDetail: 'Canvas editing is paused until the connection is restored.',
    searchConversations: 'Search conversations', searchPlaceholder: 'Search conversations, messages, or tasks', historyFilters: 'Filter collaboration history', all: 'All', unread: 'Unread', newResults: 'New results', attention: 'Needs attention', resultUpdates: (count: number) => `${count} new ${count === 1 ? 'result' : 'results'}`, updates: (count: number) => `${count} ${count === 1 ? 'update' : 'updates'}`, attentionCount: (count: number) => `${count} need${count === 1 ? 's' : ''} attention`, activeCount: (count: number) => `${count} active`, taskCount: (count: number) => `${count} ${count === 1 ? 'task' : 'tasks'}`, noConversations: 'No conversations match these filters.', noMessagesYet: 'No messages yet',
    localChangesKept: 'Local changes are preserved. Review the update.', locateChange: 'Locate this change.', latestSynced: 'Latest content synced.', closeCollaborationUpdate: 'Close collaboration update', gotIt: 'Got it', readingRestored: 'Returned to your previous reading position', jumpLatest: 'Jump to latest',
    tasksAria: 'Agent tasks and results', tasksEyebrow: 'Tasks', tasksTitle: 'Agent tasks', tasksDescription: 'Tasks started by Agent only. Failed tasks can be retried without replacing completed results.', taskFilters: 'Filter by task status', active: 'Active', completed: 'Completed', filterCount: (label: string, count: number) => `${label} · ${count} ${count === 1 ? 'item' : 'items'}`, sourceConversation: 'Source conversation', cancelling: 'Cancelling…', branchStatus: 'Branch status', branchIncomplete: 'This branch did not complete.', noFilteredTasks: 'No tasks match this filter.', noTasks: 'No Agent tasks yet.',
    skillsAria: 'System and project Skills', skillsEyebrow: 'Skills', skillsTitle: 'Creative skills', skillsDescription: 'Type / in the composer to mount a Skill. New project Skills are added to the current conversation automatically.', skillsUnavailableLocal: 'Skill registry is available when the workspace service is connected.', systemSkills: 'System Skills', availableSkills: 'Available Skills', mountedSkills: (count: number) => `${count} mounted ${count === 1 ? 'Skill' : 'Skills'}`, noMountedSkills: 'No Skills mounted in this conversation yet.', skillSearch: 'Search Skills', skillSourceFilter: 'Filter Skill source', skillSourceAll: 'All', skillSourceSystem: 'System', skillSourceProject: 'Project', removeSkill: (name: string) => `Remove ${name}`, noSkillMatches: 'No Skills match this search.', newSkill: '+ New Skill', skillNamePlaceholder: 'Skill name, for example: Summer scene swap', skillName: 'Skill name', skillRulesPlaceholder: 'Describe what must stay fixed, what may change, and the result rules.', skillRules: 'Skill rules', createProjectSkill: 'Create project Skill', createProjectSkillDetail: 'This Skill will be saved to the current project and available to Agent.', creating: 'Creating…', confirmCreate: 'Create Skill', createSkill: 'Create Skill', skillCreateFailed: 'Unable to create the Skill. Try again shortly.', noProjectSkills: 'No project Skills yet.', skillCount: (count: number) => `${count} ${count === 1 ? 'Skill' : 'Skills'}`,
    refineOne: 'Continue refining this result:', refineMany: (count: number) => `Continue refining these ${count} results:`, continueContext: 'Continue creating from the current context:', runtimeAria: 'Agent run details', collapseSteps: 'Collapse run steps', viewSteps: 'View run steps', nextStep: 'Next:', runSteps: 'Run steps', runningStep: (label: string) => `Running ${label}`, runtimeStepFailed: 'This step did not complete.', runProgress: 'Agent Run progress', generationTask: 'Generation task', cancelTask: 'Cancel task', cancelFailed: 'Unable to cancel the task. Try again shortly.', retryFailed: (label: string) => `Unable to retry “${label}”. Try again shortly.`,
  } : {
    sources: '来源', noSources: '当前没有命中项目受控检索来源。', incomplete: '未完成', unavailable: 'Agent 暂时无法回答，请稍后重试。',
    promptMissing: '没有找到你指的 Prompt。请先让 Agent 写一段 Prompt，或粘贴完整 Prompt；本次没有改动画布。',
    settingsMissing: '当前没有可用的完整生成设置，请检查模型目录。', planFailed: '暂时无法创建生成计划。', customDirection: '自定义优化方向',
    usePrompt: '使用这段 Prompt 生成', nextRoundOne: '基于这张结果继续生成：', nextRoundMany: (count: number) => `基于这 ${count} 张结果继续生成：`, continueArtifact: (label: string) => `基于「${label}」继续修改：`,
    conflict: { title: '画布有新的云端版本', detail: '本地草稿仍保留，生成任务与结果不会丢失。', actionLabel: '查看变更' }, useRemoteConfirm: '确定用云端版本替换当前本地草稿吗？',
    offline: { title: '正在使用离线草稿', detail: '恢复网络后会继续同步当前编辑。', actionLabel: '重试同步' },
    syncError: { title: '画布同步暂时失败', detail: '当前编辑仍在本地，稍后可以继续同步。', actionLabel: '重试同步' },
    dropImages: '松开即可添加图片素材', uploadLimits: uploadLimitsLabel('zh-CN'), imageLimit: (count: number) => `最多同时添加 ${count} 张图片，超出部分已跳过。`, imageReadFailed: '图片读取失败，请重新拖入或选择图片。',
    planningUnavailable: '暂时无法生成计划。', localPreviewChat: '本地预览模式未连接 Agent 服务；仍可使用画布和结构化 Prompt，连接云端后再使用对话、检索与执行。', localPreviewPrompt: (prompt: string) => `本地预览已整理出结构化 Prompt：\n\n${prompt}\n\n连接工作区服务后可继续检索或执行。`, confirmActionsFirst: '请先确认或跳过行动卡，再执行生成计划。', taskNotStarted: '任务没有启动，请检查参考素材与生成服务后重试。', taskStartFailed: '任务未能启动，请稍后重试。', canvasWritten: ' 已写入画布。', actionFailed: '行动执行失败，请重试。', retryWithModel: (model: string, prompt: string) => `换用${model}重新生成：${prompt}`, retrySettings: (prompt: string) => `调整输出设置后重新生成：${prompt}`, pendingQuestion: '上面还有一张待回答的确认卡，请直接在卡片里选择或填写；本次没有创建任务。', noPendingPlan: '当前没有待确认的生成计划。请直接描述要生成的画面或批量取值，Agent 会先给出待确认计划。',
    history: '对话历史', historyUnread: (count: number) => `对话历史，${count} 个会话有更新`, conversationName: '对话名称', saveName: '保存对话名称', save: '保存', cancelName: '取消编辑对话名称', cancel: '取消', newConversation: '新对话', editName: '重命名', collaborators: (count: number) => `另有 ${count} 位协作者在线`, processing: '处理中', realtimeConnecting: '正在连接协作服务…', realtimeReconnecting: '正在重新连接…', realtimeReconnectDetail: '画布编辑暂时暂停，连接恢复后继续。',
    searchConversations: '搜索对话', searchPlaceholder: '搜索对话、消息或任务', historyFilters: '筛选协作历史', all: '全部', unread: '未读', newResults: '新结果', attention: '需处理', resultUpdates: (count: number) => `${count} 个新结果`, updates: (count: number) => `${count} 条更新`, attentionCount: (count: number) => `${count} 项需处理`, activeCount: (count: number) => `${count} 进行中`, taskCount: (count: number) => `${count} 个任务`, noConversations: '当前筛选下没有对话。', noMessagesYet: '还没有消息',
    localChangesKept: '本地改动仍保留，点击查看变更。', locateChange: '点击定位变更。', latestSynced: '最新内容已同步。', closeCollaborationUpdate: '关闭协作更新提示', gotIt: '知道了', readingRestored: '已回到上次阅读位置', jumpLatest: '跳到最新',
    tasksAria: 'Agent 任务与结果', tasksEyebrow: '任务', tasksTitle: 'Agent 任务', tasksDescription: '仅 Agent 发起的任务。失败可重试，不覆盖已完成结果。', taskFilters: '按任务状态筛选', active: '进行中', completed: '已完成', filterCount: (label: string, count: number) => `${label} · ${count} 项`, sourceConversation: '来源对话', cancelling: '取消中…', branchStatus: '分支状态', branchIncomplete: '该分支未完成', noFilteredTasks: '当前筛选下没有任务。', noTasks: '还没有 Agent 任务。',
    skillsAria: '系统与项目 Skill', skillsEyebrow: '技能', skillsTitle: '创作技能', skillsDescription: '在输入框键入 / 即可挂载 Skill。新建的项目 Skill 会自动挂载到当前对话。', skillsUnavailableLocal: '本地预览模式未连接工作区服务；连接云端后可管理 Skill。', systemSkills: '系统 Skills', availableSkills: '可用技能', mountedSkills: (count: number) => `本轮已挂载 ${count} 个`, noMountedSkills: '本轮还没有挂载 Skill。', skillSearch: '搜索技能', skillSourceFilter: '筛选技能来源', skillSourceAll: '全部', skillSourceSystem: '系统', skillSourceProject: '项目', removeSkill: (name: string) => `移除 ${name}`, noSkillMatches: '没有匹配的 Skill。', newSkill: '＋ 新建技能', skillNamePlaceholder: '技能名称，例如：夏日换景', skillName: 'Skill 名称', skillRulesPlaceholder: '描述必须保持什么、允许改变什么，以及结果规则。', skillRules: 'Skill 规则', createProjectSkill: '创建项目 Skill', createProjectSkillDetail: '将写入当前项目，之后可被 Agent 调用。', creating: '创建中…', confirmCreate: '确认创建', createSkill: '创建 Skill', skillCreateFailed: 'Skill 创建失败。', noProjectSkills: '还没有项目 Skill。', skillCount: (count: number) => `${count} 个`,
    refineOne: '继续优化这张结果：', refineMany: (count: number) => `继续优化这 ${count} 张结果：`, continueContext: '继续基于当前上下文创作：', runtimeAria: 'Agent 运行记录', collapseSteps: '收起运行步骤', viewSteps: '查看运行步骤', nextStep: '下一步：', runSteps: '运行步骤', runningStep: (label: string) => `正在${label}`, runtimeStepFailed: '该步骤未完成。', runProgress: 'Agent Run 实时进度', generationTask: '生成任务', cancelTask: '取消任务', cancelFailed: '任务取消失败，请稍后重试。', retryFailed: (label: string) => `「${label}」重试失败，请稍后再试。`,
  }
  const displaySessionTitle = (title?: string) => !title || title === '新建对话'
    ? flowCopy.newConversation
    : title
  const displaySessionPreview = (preview: string) => locale === 'en' && preview === '还没有消息'
    ? flowCopy.noMessagesYet
    : preview
  const [intent, setIntent] = useState<BotanicAgentIntent | undefined>(undefined)
  const [groupId, setGroupId] = useState('')
  const [rawReasoningSessions, setRawReasoningSessions] = useState<Record<string, boolean>>({})
  const showRawReasoning = session ? rawReasoningSessions[session.id] === true : false
  const plannerModel = plannerModels.includes(session?.plannerModel ?? '')
    ? session!.plannerModel!
    : plannerModels[0] ?? defaultAgentPlannerModels[0]
  const [composerState, updateComposerState] = useReducer(agentComposerStateReducer, initialAgentComposerState)
  const { instruction, error, lastFailedInstruction, lastFailedCommand, lastFailedPlanMessageId, mentionQuery, pendingGenerationOverrides, pendingRecoveryContextSnapshot } = composerState
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
  const [cancellingSessionId, setCancellingSessionId] = useState('')
  const [turnRecoveryEpoch, setTurnRecoveryEpoch] = useState(0)
  /** 局部重绘语等待框选：选区回来后带 region 重放该指令。 */
  const [pendingRegionInstruction, setPendingRegionInstruction] = useState<{
    instruction: string
    options: AgentInstructionRetryOptions
  } | null>(null)
  const [liveConversation, setLiveConversation] = useState<AgentLiveConversation>()
  /** 气泡旁路时间线：回合结束后的工具步骤，以及确认后的 Run 进度投影。 */
  const [executionTimelines, setExecutionTimelines] = useState<Record<string, AgentTimelineState>>({})
  const [timelineHydrationEpoch, setTimelineHydrationEpoch] = useState(0)
  const timelineHydrationAttemptsRef = useRef(new Map<string, AgentTurnTimelineHydrationAttemptState>())
  const [submittingMessageId, setSubmittingMessageId] = useState('')
  const [autoSubmissionRetryEpoch, setAutoSubmissionRetryEpoch] = useState(0)
  const autoSubmissionRetryAttemptsRef = useRef(new Map<string, number>())
  const autoSubmissionRetryTimerRef = useRef<{ messageId: string; timer: number } | null>(null)
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
  const [historyQuery, setHistoryQuery] = useState('')
  const [historyFilter, setHistoryFilter] = useState<BotanicAgentSessionTimelineFilter>('all')
  const [readingRestoreNotice, setReadingRestoreNotice] = useState(false)
  const [focusedTaskRunId, setFocusedTaskRunId] = useState('')
  const clearFocusedTaskRun = useCallback(() => setFocusedTaskRunId(''), [])
  const skillPanelOpen = activeUtilityPanel === 'skill'
  const taskPanelOpen = activeUtilityPanel === 'task'
  const resultPanelOpen = activeUtilityPanel === 'result'
  const memoryPanelOpen = activeUtilityPanel === 'memory'
  const reviewPanelOpen = activeUtilityPanel === 'review'
  const brandPanelOpen = activeUtilityPanel === 'brand'
  const collaborationPanelOpen = activeUtilityPanel === 'collaboration'
  const [reviewDecisionPendingId, setReviewDecisionPendingId] = useState('')
  const [renamingSession, setRenamingSession] = useState(false)
  const [sessionTitleDraft, setSessionTitleDraft] = useState(displaySessionTitle(session?.title))
  const [persistenceAction, setPersistenceAction] = useState<'retry' | 'refresh' | ''>('')
  const [promptDrafts, setPromptDrafts] = useState<Record<string, string>>({})
  const [recoveryModelMenuKey, setRecoveryModelMenuKey] = useState('')
  const plannerControllerRef = useRef<AbortController | null>(null)
  const activeTurnIdRef = useRef('')
  const activeTurnInputMessageIdRef = useRef('')
  const activeTurnInputMessageRef = useRef<BotanicAgentMessage | null>(null)
  const awaitingTurnIdentityRef = useRef(false)
  const cancelWhenAcceptedSessionIdRef = useRef('')
  const reattachingTurnIdsRef = useRef(new Set<string>())
  const cancellingTurnIdsRef = useRef(new Set<string>())
  const cancellationPromisesRef = useRef(new Map<string, Promise<unknown>>())
  const cancellationAcceptedTurnIdsRef = useRef(new Set<string>())
  const turnCancellationIntentRef = useRef(new Map<string, number>())
  const agentMountedRef = useRef(true)
  const isCurrentAgentProject = useCallback(
    () => agentMountedRef.current && useCanvasStore.getState().document.id === projectId,
    [projectId],
  )
  const skillRegistry = useAgentSkillRegistry({
    projectId,
    session,
    locale,
    panelOpen: skillPanelOpen,
    serverPersistenceEnabled,
    isCurrentAgentProject,
    onSkillsChange,
    createFailedMessage: flowCopy.skillCreateFailed,
  })
  const { skills, systemSkills } = skillRegistry
  const { appendMessage: appendNewMessage, persistMessage, retryMessage, ensureMessageDurable } = useAgentMessageDelivery({
    projectId,
    session,
    isCurrentProject: isCurrentAgentProject,
    onAppendMessage,
    onUpdateMessage,
  })
  const persistActionUpdate = (
    message: BotanicAgentMessage,
    actionId: string,
    patch: Partial<Pick<BotanicAgentActionProposal, 'status' | 'receiptIdempotencyKey' | 'preparedRetryIdempotencyKey' | 'manualRetryResumeAvailable' | 'error' | 'result'>>,
  ) => session
    ? persistBotanicAgentActionMessageUpdate({
        session,
        message,
        actionId,
        patch,
        onUpsertMessage,
        onUpdateAction,
        persistMessage,
      })
    : message
  const persistMessageUpdate = (message: BotanicAgentMessage, patch: AgentMessagePatch) => session
    ? persistBotanicAgentMessageUpdate({
        session,
        message,
        patch,
        onUpsertMessage,
        onUpdateMessage,
        persistMessage,
      })
    : message
  const appendMessage = (
    message: Omit<BotanicAgentMessage, 'id' | 'createdAt'> & { id?: string; createdAt?: number },
  ) => upsertBotanicAgentMessageProjection({
    message, session, activeTurnInputMessage: activeTurnInputMessageRef.current,
    append: appendNewMessage, update: persistMessageUpdate,
  })
  const ensureDeepTurnCancellation = (turnId: string, signal?: AbortSignal) => {
    if (cancellationAcceptedTurnIdsRef.current.has(turnId)) return Promise.resolve()
    const existing = cancellationPromisesRef.current.get(turnId)
    if (existing) return existing
    const cancellationSessionId = session?.id ?? ''
    setCancellingSessionId(cancellationSessionId)
    cancellingTurnIdsRef.current.add(turnId)
    const cancellation = retryBotanicAgentTurnCancellation({
      turnId,
      signal,
      cancelTurn: cancelPersistentBotanicAgentTurn,
    }).then((result) => {
      cancellationAcceptedTurnIdsRef.current.add(turnId)
      return result
    }).finally(() => {
      cancellationPromisesRef.current.delete(turnId)
      cancellingTurnIdsRef.current.delete(turnId)
      if (!cancellationPromisesRef.current.size) {
        setCancellingSessionId((current) => current === cancellationSessionId ? '' : current)
      }
    })
    cancellationPromisesRef.current.set(turnId, cancellation)
    return cancellation
  }
  const settlePreIdentityCancellation = (
    operationSessionId: string,
    turnIdentityKnown: boolean,
    recoveryPending = false,
  ) => {
    if (!turnIdentityKnown && !recoveryPending
      && cancelWhenAcceptedSessionIdRef.current === operationSessionId) {
      cancelWhenAcceptedSessionIdRef.current = ''
    }
    setCancellingSessionId((currentSessionId) => settleBotanicAgentCancellationSession({
      currentSessionId,
      operationSessionId,
      turnIdentityKnown,
      recoveryPending,
    }))
  }
  const sendingInstructionRef = useRef(false)
  const submittingMessageIdRef = useRef('')
  // 终态同时记住产出数：服务端可能先标记完成、随后才持久化 Artifact，
  // 这样结果回填后会更新同一条消息，而不会重复刷屏。
  const runNoticeStatusRef = useRef(new Map<string, string>())
  const focusedRunIdsRef = useRef(new Set<string>())
  const workspaceRef = useRef<HTMLElement | null>(null)
  const messageEndRef = useRef<HTMLDivElement | null>(null)
  const messagesViewportRef = useRef<HTMLDivElement | null>(null)
  const utilityFlipStateRef = useRef<ReturnType<typeof captureFlipState>>(null)
  const setUtilityPanel = (panel: AgentUtilityPanel | null | ((current: AgentUtilityPanel | null) => AgentUtilityPanel | null)) => {
    utilityFlipStateRef.current = captureFlipState(messagesViewportRef.current)
    setActiveUtilityPanel(panel)
  }
  const lastAnimatedMessageIdRef = useRef('')
  const messageNodesRef = useRef(new Map<string, HTMLDivElement>())
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
  const historyMenuId = useId()
  const utilityMenuId = useId()
  const contextMenuId = useId()
  const modeMenuId = useId()
  const runtimeStepsId = useId()
  const compatibleGroups = groups.filter((group) => group.role === botanicAgentComposerGroupRole(intent) && group.assetIds.length)
  const contextItems = contextOptions.filter((item) => session?.contextNodeIds.includes(item.id))
  const composerHasVisual = Boolean(target?.image) || contextItems.some((item) => (
    Boolean(item.image) && (item.mediaKind ?? 'image') === 'image'
  ))
  const composerIntentHint = instruction.trim() || composerHasVisual
    ? botanicAgentComposerIntentHint(
      decideBotanicAgentRequest(instruction, composerHasVisual),
      { hasVisualContext: composerHasVisual },
      locale,
    )
    : ''
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
  const latestEvaluableMessageId = useMemo(
    () => botanicAgentLatestEvaluableMessageId(renderedConversationMessages),
    [renderedConversationMessages],
  )
  const pendingPromptSourceIds = useMemo(() => new Set((session?.messages ?? [])
    .filter((message) => message.question?.sourcePromptMessageId && message.kind === 'question' && message.status === 'pending')
    .map((message) => message.question!.sourcePromptMessageId!)), [session?.messages])
  const mentionOptions = useMemo(() => {
    if (!mentionQuery || mentionQuery.trigger !== '@') return []
    const query = mentionQuery.query.trim().toLocaleLowerCase()
    const canReference = (item: AgentContextItem) => {
      if (item.kind === '文字') return Boolean(item.content)
      // 图/视频素材与结果都可 @；视频没封面时仍保留，由菜单用「视」徽章展示。
      if (item.kind === '素材' || item.kind === '结果') {
        return Boolean(item.image) || item.mediaKind === 'video'
      }
      return false
    }
    return contextOptions
      .filter(canReference)
      .filter((item) => !query || item.label.toLocaleLowerCase().includes(query))
      .slice(0, 8)
  }, [contextOptions, mentionQuery])
  const skillOptions = useMemo<AgentSkillOption[]>(() => {
    if (!mentionQuery || mentionQuery.trigger !== '/') return []
    const query = mentionQuery.query.trim().toLocaleLowerCase()
    const catalog = [...systemSkills, ...skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      instructions: skill.instructions,
      source: 'project' as const,
    }))]
      .filter((skill, index, items) => items.findIndex((candidate) => candidate.id === skill.id) === index)
      .filter((skill) => !query || skill.name.toLocaleLowerCase().includes(query) || skill.id.toLocaleLowerCase().includes(query))
    // 系统 Skill 全量出现在 / 菜单；项目 Skill 仍截断，避免目录把菜单撑爆。
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
  const utilityPanelOpen = taskPanelOpen || skillPanelOpen || resultPanelOpen || memoryPanelOpen || collaborationPanelOpen || reviewPanelOpen || brandPanelOpen
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
  const {
    executingActionId,
    confirmAction,
    manualRetryAuthorization,
  } = useAgentActionLifecycle({
    projectId,
    session,
    locale,
    copy: flowCopy,
    isCurrentProject: isCurrentAgentProject,
    persistActionUpdate,
    appendMessage,
    onConfirmAction,
    setRuntimePhase,
    setError,
    clearFailedPlan: () => setLastFailedPlanMessageId(''),
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
    timelineHydrationAttemptsRef.current.clear()
    setTimelineHydrationEpoch((current) => current + 1)
  }, [resetRuntimeTrace, sessionId])

  useEffect(() => {
    const retryTransientHydrations = () => {
      let changed = false
      for (const [turnId, status] of timelineHydrationAttemptsRef.current) {
        if (status !== 'transient') continue
        timelineHydrationAttemptsRef.current.delete(turnId)
        changed = true
      }
      if (changed) setTimelineHydrationEpoch((current) => current + 1)
    }
    window.addEventListener('online', retryTransientHydrations)
    window.addEventListener('focus', retryTransientHydrations)
    return () => {
      window.removeEventListener('online', retryTransientHydrations)
      window.removeEventListener('focus', retryTransientHydrations)
    }
  }, [sessionId])

  // 确认后把已持久化的 Run/分支状态投影进同款对话时间线；不发明未发生的步骤。
  useEffect(() => {
    if (!session?.messages.length || !runs.length) return
    const timelineMessageIdByRun = new Map<string, string>()
    for (const message of session.messages) {
      if (message.runId && message.status === 'submitted') timelineMessageIdByRun.set(message.runId, message.id)
    }
    for (const message of session.messages) {
      if (message.runId && message.kind === 'run' && !timelineMessageIdByRun.has(message.runId)) {
        timelineMessageIdByRun.set(message.runId, message.id)
      }
    }
    setExecutionTimelines((current) => {
      let changed = false
      const next = { ...current }
      for (const message of session.messages) {
        if (!message.runId || timelineMessageIdByRun.get(message.runId) !== message.id) continue
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

  // 已有稳定助手投影不再 observer/execute，只从 durable Turn Events 有界补回气泡时间线。
  useEffect(() => {
    if (!serverPersistenceEnabled || !session?.id || !session.messages.length) return
    const attempts = timelineHydrationAttemptsRef.current
    const targets = beginAgentTurnTimelineHydrationBatch(
      session.messages,
      attempts,
      maximumConcurrentTurnTimelineHydrations,
    )
    if (!targets.length) return
    const controller = new AbortController()
    let settled = false
    void Promise.all(targets.map(async (target) => {
      try {
        const result = await readPersistentBotanicAgentTurnEvents(target.turnId, projectId, {
          signal: controller.signal,
        })
        return {
          target,
          timeline: agentTurnTimelineFromHydrationRead(result),
          caught: undefined,
        }
      } catch (caught) {
        return { target, timeline: undefined, caught }
      }
    })).then((hydrated) => {
      if (controller.signal.aborted || !isCurrentAgentProject()) return
      settled = true
      for (const item of hydrated) {
        if (!item.caught || item.timeline) {
          attempts.set(item.target.turnId, 'terminal')
          continue
        }
        const disposition = agentTurnTimelineHydrationFailureDisposition(item.caught)
        if (disposition === 'cancelled') attempts.delete(item.target.turnId)
        else attempts.set(item.target.turnId, disposition === 'terminal' ? 'terminal' : 'transient')
      }
      setExecutionTimelines((current) => {
        let changed = false
        const next = { ...current }
        for (const item of hydrated) {
          if (!item.timeline) continue
          next[item.target.messageId] = mergeHydratedAgentTurnTimeline(
            current[item.target.messageId],
            item.timeline,
          )
          changed = true
        }
        return changed ? next : current
      })
      // 每批最多两个；本批落定后选择当前消息集合中的下一批，直到渐进覆盖完。
      setTimelineHydrationEpoch((current) => current + 1)
    })
    return () => {
      controller.abort()
      if (!settled) {
        releaseAbortedAgentTurnTimelineHydrations(targets, attempts)
      }
    }
  }, [executionTimelines, isCurrentAgentProject, projectId, session?.id, session?.messages, timelineHydrationEpoch])

  const registerMessageNode = useCallback((messageId: string, node: HTMLDivElement | null) => {
    if (node) messageNodesRef.current.set(messageId, node)
    else messageNodesRef.current.delete(messageId)
  }, [])

  const revealConversationMessage = useCallback((messageId: string, behavior: ScrollBehavior = 'smooth') => {
    const node = messageNodesRef.current.get(messageId)
    if (!node) return false
    const viewport = messagesViewportRef.current
    if (viewport) scrollElementIntoView(viewport, node, { duration: behavior === 'auto' ? 0 : botanicMotion.duration.panel, block: 'center' })
    node.focus({ preventScroll: true })
    setLocatedMessageId(messageId)
    if (locatedMessageTimerRef.current !== null) window.clearTimeout(locatedMessageTimerRef.current)
    locatedMessageTimerRef.current = window.setTimeout(() => setLocatedMessageId(''), 1800)
    return true
  }, [])

  const locateTaskSourceMessage = useCallback((source: { sessionId: string; messageId: string }) => {
    onUpdateReadingAnchor(source.sessionId, source.messageId)
    setUtilityPanel(null)
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
    setFocusedTaskRunId(runId)
    setUtilityPanel('task')
    setActiveTransientSurface(null)
    setMentionQuery(undefined)
  }, [])

  const locateCollaborationActivity = useCallback((activity: CollaborationActivity) => {
    const target = activity.target
    if (!target || target.kind === 'project') {
      setUtilityPanel('collaboration')
      setActiveTransientSurface(null)
    } else if (target.kind === 'node') {
      onFocusNodes([target.nodeId])
      setUtilityPanel(null)
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
    const viewport = messagesViewportRef.current
    if (viewport) scrollElementIntoView(viewport, messageEndRef.current ?? 'max', { duration: botanicMotion.duration.panel, block: 'end' })
    onUpdateReadingAnchor(session.id, latestMessageId)
  }, [onUpdateReadingAnchor, session])

  const scheduleReadingAnchorUpdate = useCallback(() => {
    const viewport = messagesViewportRef.current
    if (!viewport) return
    followLatestMessagesRef.current = isFollowingLatest(viewport)
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

  const handleMessagesScroll = useCallback(() => {
    scheduleReadingAnchorUpdate()
    const viewport = messagesViewportRef.current
    if (!viewport || !hasOlderMessages || loadingOlderMessages || !onLoadOlderMessages) return
    if (viewport.scrollTop > 96) return
    onLoadOlderMessages()
  }, [hasOlderMessages, loadingOlderMessages, onLoadOlderMessages, scheduleReadingAnchorUpdate])

  const importImageFiles = async (files: File[], source: 'drop' | 'paste' = 'drop') => {
    const { accepted, message } = validateUploadFiles(files, locale)
    const imageFiles = accepted.slice(0, maxUploadAssets)
    const limitMessage = accepted.length > maxUploadAssets ? flowCopy.imageLimit(maxUploadAssets) : ''
    if (message || limitMessage) setError([message, limitMessage].filter(Boolean).join(' '))
    if (!imageFiles.length) return
    const loaded = await Promise.allSettled(imageFiles.map((file) => readUploadedAssetInput(file, '场景', { source, locale })))
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

  const handlePaste = (event: ClipboardEvent<HTMLElement>) => {
    const items = Array.from(event.clipboardData?.items ?? [])
    const files = clipboardMediaFiles(items)
    const target = event.target
    const element = target instanceof Element ? target : null
    // 与 CanvasWorkspace 的 window 粘贴监听器共用同一份判定式（同一个 pasteTarget）。
    // 这里的 onPaste 挂在 .agent-workspace 上，本身只会在事件冒泡经过面板的
    // React 子树时触发；但 Agent 对话里发起的局部重绘编辑器也用 createPortal
    // 挂到 document.body——冒泡仍会经过这个 onPaste（React 按组件树而非 DOM
    // 树冒泡），可 DOM 上它已经不在 .agent-workspace 之下。不重新计算
    // insideAgentPanel/modalOpen，会让这次粘贴被误当成「composer 有焦点」，
    // 静默把图片塞进被弹层挡住、用户看不到的输入框。
    const agentPanelMounted = Boolean(window.document.querySelector('.agent-workspace'))
    const insideAgentPanel = Boolean(element?.closest('.agent-workspace'))
      || (agentPanelMounted && Boolean(element?.closest('.botanic-select__menu')))
    const insideTextEntry = Boolean(element?.closest('input, textarea, [contenteditable="true"]'))
    const modalOpen = Boolean(window.document.querySelector('[aria-modal="true"]'))
    if (pasteTarget({ hasMediaFiles: files.length > 0, insideAgentPanel, insideTextEntry, modalOpen }) !== 'composer') return
    // 表格单元格复制这类混合内容会同时带一段文本；不分情况地 preventDefault
    // 会把这段文本一起吞掉。只在剪贴板没有纯文本时才拦截默认粘贴，图片始终正常导入。
    if (!clipboardHasPlainText(items)) event.preventDefault()
    void importImageFiles(files, 'paste')
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
    if (!utilityMenuOpen) return
    const frame = requestAnimationFrame(() => document.getElementById(utilityMenuId)?.querySelector<HTMLButtonElement>('button')?.focus())
    return () => cancelAnimationFrame(frame)
  }, [utilityMenuId, utilityMenuOpen])

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
    // 优先级在 agentWorkspaceNavigation 里以数据声明并有测试锁定；这里只负责把
    // 判定结果落到 setState 与焦点归还上。
    const dismiss: Record<AgentDismissTarget, () => void> = {
      mention: () => {
        setMentionQuery(undefined)
        requestAnimationFrame(() => composerTextareaRef.current?.focus())
      },
      contextMenu: () => {
        setContextMenuOpen(false)
        requestAnimationFrame(() => contextMenuButtonRef.current?.focus())
      },
      modeMenu: () => {
        setModeMenuOpen(false)
        requestAnimationFrame(() => modeMenuButtonRef.current?.focus())
      },
      history: () => {
        setHistoryOpen(false)
        requestAnimationFrame(() => historyTriggerRef.current?.focus())
      },
      utilityMenu: () => {
        setUtilityMenuOpen(false)
        requestAnimationFrame(() => utilityMenuButtonRef.current?.focus())
      },
      // 目录自己负责把焦点还给创建按钮。
      skillConfirm: () => skillRegistry.cancelConfirm(),
      recoveryMenu: () => setRecoveryModelMenuKey(''),
      runtimeDetails: () => setRuntimeDetailsOpen(false),
      utilityPanel: () => {
        setUtilityPanel(null)
        requestAnimationFrame(() => utilityButtonRef.current?.focus())
      },
      workspace: () => onClose(),
    }
    const closeLayerOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !escapeEnabled) return
      dismiss[agentEscapeDismissTarget({
        mention: Boolean(mentionQuery),
        contextMenu: contextMenuOpen,
        modeMenu: modeMenuOpen,
        history: historyOpen,
        utilityMenu: utilityMenuOpen,
        skillConfirm: skillRegistry.form.confirming,
        recoveryMenu: Boolean(recoveryModelMenuKey),
        runtimeDetails: runtimeDetailsOpen,
        utilityPanel: utilityPanelOpen,
      })]()
      event.preventDefault()
    }
    window.addEventListener('keydown', closeLayerOnEscape)
    return () => window.removeEventListener('keydown', closeLayerOnEscape)
  }, [contextMenuOpen, escapeEnabled, historyOpen, mentionQuery, modeMenuOpen, onClose, recoveryModelMenuKey, runtimeDetailsOpen, skillRegistry, utilityMenuOpen, utilityPanelOpen])

  useEffect(() => {
    // Strict Mode 会执行 setup → cleanup → setup；每次 setup 都必须恢复活动标记，
    // 否则开发环境中的消息发送会被误判为“组件已卸载”而静默丢弃。
    agentMountedRef.current = true
    return () => {
      agentMountedRef.current = false
      plannerControllerRef.current?.abort()
      if (readingAnchorTimerRef.current !== null) window.clearTimeout(readingAnchorTimerRef.current)
      if (locatedMessageTimerRef.current !== null) window.clearTimeout(locatedMessageTimerRef.current)
      if (autoSubmissionRetryTimerRef.current) window.clearTimeout(autoSubmissionRetryTimerRef.current.timer)
    }
  }, [])

  useEffect(() => {
    setSessionTitleDraft(displaySessionTitle(session?.title))
    setRenamingSession(false)
  }, [locale, session?.id, session?.title])

  useEffect(() => {
    reattachingTurnIdsRef.current.clear()
    cancellingTurnIdsRef.current.clear()
    cancellationPromisesRef.current.clear()
    cancellationAcceptedTurnIdsRef.current.clear()
    turnCancellationIntentRef.current.clear()
    autoSubmissionRetryAttemptsRef.current.clear()
    if (autoSubmissionRetryTimerRef.current) {
      window.clearTimeout(autoSubmissionRetryTimerRef.current.timer)
      autoSubmissionRetryTimerRef.current = null
    }
    activeTurnIdRef.current = ''
    activeTurnInputMessageIdRef.current = ''
    activeTurnInputMessageRef.current = null
    awaitingTurnIdentityRef.current = false
    cancelWhenAcceptedSessionIdRef.current = ''
  }, [projectId, session?.id])

  useEffect(() => {
    if (utilityPanelOpen || !session || readingPositionRestoredRef.current) return
    const frame = requestAnimationFrame(() => {
      const anchorId = session.readingAnchorMessageId
      const restored = anchorId ? revealConversationMessage(anchorId, 'auto') : false
      if (!restored) {
        const viewport = messagesViewportRef.current
        if (viewport) scrollElementIntoView(viewport, messageEndRef.current ?? 'max', { duration: 0, block: 'end' })
      }
      followLatestMessagesRef.current = !anchorId || anchorId === session.messages.at(-1)?.id
      lastReadingAnchorRef.current = anchorId ?? ''
      lastAnimatedMessageIdRef.current = session.messages.at(-1)?.id ?? ''
      setReadingRestoreNotice(Boolean(restored && anchorId !== session.messages.at(-1)?.id))
      readingPositionRestoredRef.current = true
    })
    return () => cancelAnimationFrame(frame)
  }, [revealConversationMessage, session, utilityPanelOpen])

  useEffect(() => {
    if (!readingPositionRestoredRef.current || utilityPanelOpen || !followLatestMessagesRef.current) return
    const viewport = messagesViewportRef.current
    if (viewport) scrollElementIntoView(viewport, messageEndRef.current ?? 'max', { duration: botanicMotion.duration.panel, block: 'end' })
  }, [session?.messages.length, latestRun?.updatedAt, liveConversation, planning, runtimeSteps.length, runtimeSteps[runtimeSteps.length - 1]?.status, utilityPanelOpen])

  const latestRenderedMessageId = renderedConversationMessages.at(-1)?.id ?? ''
  const latestAssistantMessageId = [...renderedConversationMessages].reverse().find((message) => message.role === 'assistant')?.id
  const agentBusy = planning || Boolean(liveConversation?.streaming)
  const welcomeSays = useBobSaysPlays(`welcome:${session?.id ?? projectId}`)
  const welcomeBob = bobWelcomePresentation(prefersReducedMotion() ? { hmm: 1, wow: 0 } : welcomeSays.plays)

  const welcomePlayedRef = useRef(false)
  useGSAP(() => {
    if (utilityPanelOpen || hasMessages || prefersReducedMotion() || welcomePlayedRef.current) return
    welcomePlayedRef.current = true
    // Flip 开栏时跳过欢迎 stagger，避免和侧栏展开叠成两次入场。
    if (fromEmptyGuide) return
    const welcome = gsap.timeline({ defaults: { duration: botanicMotion.duration.panel, ease: botanicMotion.ease } })
    welcome
      .from('.agent-workspace__mark', { autoAlpha: 0, scale: 0.92 }, 0)
      .from('.agent-workspace__welcome small', { autoAlpha: 0, y: 6 }, '>-0.12')
      .from('.agent-workspace__welcome h2', { autoAlpha: 0, y: 8 }, '>-0.16')
      .from('.agent-workspace__welcome p', { autoAlpha: 0, y: 6 }, '>-0.18')
      .from('.agent-workspace__starters button', { autoAlpha: 0, y: 8, stagger: 0.05 }, '>-0.12')
  }, { scope: workspaceRef, dependencies: [fromEmptyGuide, hasMessages, utilityPanelOpen, locale] })

  useGSAP(() => {
    if (!readingPositionRestoredRef.current || !latestRenderedMessageId) return
    if (lastAnimatedMessageIdRef.current === latestRenderedMessageId) return
    const node = messageNodesRef.current.get(latestRenderedMessageId)
    lastAnimatedMessageIdRef.current = latestRenderedMessageId
    if (!node || prefersReducedMotion()) return
    gsap.from(node, { autoAlpha: 0, y: 8, duration: botanicMotion.duration.toast, ease: botanicMotion.ease })
  }, { scope: workspaceRef, dependencies: [latestRenderedMessageId] })

  useGSAP(() => {
    playSurfaceFlip(utilityFlipStateRef.current, messagesViewportRef.current?.querySelectorAll('[data-agent-flip]') ?? null)
    utilityFlipStateRef.current = null
  }, { scope: workspaceRef, dependencies: [activeUtilityPanel] })

  useEffect(() => {
    if (!compatibleGroups.some((group) => group.id === groupId)) setGroupId('')
  }, [compatibleGroups, groupId])

  const toggleUtilityPanel = (panel: AgentUtilityPanel) => {
    utilityButtonRef.current = utilityMenuButtonRef.current
    setUtilityPanel((current) => current === panel ? null : panel)
    setHistoryOpen(false)
    setRenamingSession(false)
    setActiveTransientSurface(null)
    setMentionQuery(undefined)
  }

  const closeUtilityPanel = () => {
    setUtilityPanel(null)
    setUtilityMenuOpen(false)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      (composerTextareaRef.current ?? utilityButtonRef.current)?.focus()
    }))
  }

  const openUtilityPanel = (panel: AgentUtilityPanel) => {
    setUtilityPanel(panel)
    setHistoryOpen(false)
    setRenamingSession(false)
    setActiveTransientSurface(null)
    setMentionQuery(undefined)
  }

  const openRunFeedback = (run: BotanicAgentRun) => {
    const feedback = agentRunFeedback(run, artifacts, availableCanvasNodeIds, locale)
    openUtilityPanel(feedback.action === 'view_results' ? 'result' : 'task')
  }

  const decideReview = async (message: BotanicAgentMessage, decision: 'accepted' | 'rejected') => {
    const review = message.review
    if (!review?.id || !session || reviewDecisionPendingId) return
    setReviewDecisionPendingId(review.id)
    try {
      const saved = await submitBotanicAgentReviewDecision({ projectId, reviewId: review.id, decision })
      if (!isCurrentAgentProject()) return
      onUpdateMessage(session.id, message.id, {
        review: saved,
        content: formatBotanicAgentRunReviewMessage(saved, locale),
      })
    } catch {
      // 决策失败保留 pending 状态，用户可再次提交。
    } finally {
      setReviewDecisionPendingId('')
    }
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
  // 结果自评由 durable Review Task 投影。
  const reviewProjection = useAgentReviewProjection({ session, latestRun, locale, isCurrentProject: isCurrentAgentProject, appendMessage })
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
  const changeSessionContext = (nodeIds: string[]) => applyAgentSessionContextChange({
    session, nodeIds, locale, onChange: onContextChange, onError: setError })
  const selectMention = (item: AgentContextItem) => {
    if (!session || !mentionQuery) return
    if (!session.contextNodeIds.includes(item.id)
      && !changeSessionContext([...session.contextNodeIds, item.id])) return
    const consumed = consumeBotanicAgentMention(instruction, mentionQuery)
    setInstruction(consumed.value)
    setMentionQuery(undefined)
    requestAnimationFrame(() => {
      composerTextareaRef.current?.focus()
      composerTextareaRef.current?.setSelectionRange(consumed.caret, consumed.caret)
    })
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

  // 导航归工作区，表单归目录：先把用户带到 Skill 面板，再让目录自己打开表单。
  const openSkillCreation = () => {
    setMentionQuery(undefined)
    setUtilityMenuOpen(false)
    setUtilityPanel('skill')
    skillRegistry.openForm()
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
    runtimeRequestKey?: string,
    resolvedIntent?: BotanicAgentIntent,
  ): Promise<BotanicAgentPlan | BotanicAgentClarificationResponse | null> => {
    if (!session || !target || !isCurrentAgentProject()) return null
    const assetGroup = compatibleGroups.find((group) => group.id === groupId)
    // 失败 Run 恢复的权威引用优先进入快照（构建时按 nodeId 去重，先到先得）。
    const recoveryContextItems = failedCommand?.options.recoveryContextSnapshot ?? []
    const planContextSnapshot = () => createBotanicAgentContextSnapshot([...recoveryContextItems, ...contextItems])
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
      requestedIntent: resolvedIntent ?? intent,
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
      contextSnapshot: planContextSnapshot(),
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
    let runtimeTurnId = ''
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
    if (serverPersistenceEnabled) awaitingTurnIdentityRef.current = true
    try {
      const nextPlan = serverPersistenceEnabled
        ? await streamBotanicAgentPlan(input, {
            signal: controller.signal,
            ...(runtimeRequestKey ? { requestKey: runtimeRequestKey } : {}),
            onAccepted: (turnId) => {
              runtimeTurnId = turnId
              awaitingTurnIdentityRef.current = false
              activeTurnIdRef.current = turnId
              if (cancelWhenAcceptedSessionIdRef.current === session.id) {
                cancelWhenAcceptedSessionIdRef.current = ''
                void ensureDeepTurnCancellation(turnId, controller.signal).catch((caught) => {
                  if (!controller.signal.aborted) setError(localizeProductError(caught, locale, {
                    'zh-CN': '暂时无法取消本轮 Agent 规划，请重试。',
                    en: 'Unable to cancel this Agent planning turn. Try again.',
                  }))
                })
              }
            },
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
        : buildBotanicAgentPlan({
            instruction: cleanInstruction,
            locale,
            intent,
            selectedResultNodeId: target.id,
            selectedResultLabel: target.label,
            rootRecipe: target.rootRecipe,
            assetGroup,
            contextSnapshot: planContextSnapshot(),
            ...(outputCount ? { outputCount } : {}),
            settings: { ...target.rootRecipe.settings, ...generationOverrides },
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
            contextSnapshot: planContextSnapshot(),
            ...(outputCount ? { outputCount } : {}),
          }), plannerModel, settings: { ...target.rootRecipe.settings, ...generationOverrides } }
          const applied = applyBotanicAgentVariationToPlan(fallbackPlan, {
            // 变体轴只从用户原话解析：cleanInstruction 在综合 Prompt 链路里是模型 prose。
            instruction: sourceInstruction ?? failedCommand?.instruction ?? cleanInstruction,
            locale,
            requestedIntent: resolvedIntent ?? intent,
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
      awaitingTurnIdentityRef.current = false
      settlePreIdentityCancellation(session.id, Boolean(runtimeTurnId))
      if (runtimeTurnId && activeTurnIdRef.current === runtimeTurnId) activeTurnIdRef.current = ''
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
    let persistedPlanMessage = message
    if (editedPrompt && editedPrompt !== message.plan.prompt) {
      persistedPlanMessage = persistMessageUpdate(persistedPlanMessage, { plan })
    }
    try {
      const submission = await onConfirm(plan, botanicAgentSubmissionKey(message.id, plan))
      if (!isCurrentAgentProject()) return
      autoSubmissionRetryAttemptsRef.current.delete(message.id)
      if (autoSubmissionRetryTimerRef.current?.messageId === message.id) {
        window.clearTimeout(autoSubmissionRetryTimerRef.current.timer)
        autoSubmissionRetryTimerRef.current = null
      }
      setLastFailedPlanMessageId('')
      setLastFailedInstruction('')
      if (!submission.started) setRuntimePhase('failed')
      persistedPlanMessage = persistMessageUpdate(persistedPlanMessage, {
        status: submission.started ? 'submitted' : 'failed',
        runId: submission.runId,
      })
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
      if (shouldRetryBotanicAgentAutoSubmission(
        persistedPlanMessage,
        session.executionMode,
        caught,
        session.confirmationWaivers,
      )) {
        const attempt = (autoSubmissionRetryAttemptsRef.current.get(message.id) ?? 0) + 1
        autoSubmissionRetryAttemptsRef.current.set(message.id, attempt)
        if (!autoSubmissionRetryTimerRef.current) {
          const triggerRetry = () => {
            // 另一条计划正在提交时不能吞掉本轮定时触发；等它交接完再唤醒 selector，
            // selector 仍会按 createdAt 选择最早 pending，多个计划不会互相饿死。
            if (submittingMessageIdRef.current) {
              const timer = window.setTimeout(triggerRetry, 250)
              autoSubmissionRetryTimerRef.current = { messageId: message.id, timer }
              return
            }
            autoSubmissionRetryTimerRef.current = null
            setAutoSubmissionRetryEpoch((current) => current + 1)
          }
          const timer = window.setTimeout(
            triggerRetry,
            Math.min(500 * (2 ** Math.max(0, attempt - 1)), 5_000),
          )
          autoSubmissionRetryTimerRef.current = { messageId: message.id, timer }
        }
        setRuntimePhase('executing')
        setError(locale === 'en'
          ? 'The Run response was interrupted. Reconnecting with the same submission identity…'
          : 'Run 响应中断，正在用同一提交身份恢复…')
        return
      }
      autoSubmissionRetryAttemptsRef.current.delete(message.id)
      persistedPlanMessage = persistMessageUpdate(persistedPlanMessage, { status: 'failed' })
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

  const pendingAutoSubmission = pendingBotanicAgentAutoSubmission(
    session?.messages ?? [],
    session?.executionMode ?? 'manual',
    session?.confirmationWaivers,
  )
  useEffect(() => {
    if (!pendingAutoSubmission || planning || submittingMessageIdRef.current) return
    // plan Message 已 durable、Run POST 尚未发生时刷新会落在这里。confirm 内仍使用
    // Message+Plan 派生的稳定 submission key，因此响应丢失也只会复用同一 Run。
    void confirmMessagePlan(pendingAutoSubmission)
    // confirmMessagePlan 随渲染重建；这里仅由持久化计划身份/工作状态驱动，避免重复提交。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSubmissionRetryEpoch, pendingAutoSubmission?.id, pendingAutoSubmission?.updatedAt, planning, projectId, session?.id])

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
    // 权威引用直接随下一次指令结构化下发；UI 上下文只是可见回显，不再是唯一来源。
    updateComposerState({ pendingRecoveryContextSnapshot: run.plan.contextSnapshot?.length ? run.plan.contextSnapshot : undefined })
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
    setUtilityPanel(null)
    setError('')
    setLastFailedPlanMessageId('')
    requestAnimationFrame(() => composerTextareaRef.current?.focus())
  }

  const runInstruction = async (
    cleanInstruction: string,
    options: AgentRunInstructionOptions = {},
  ) => {
    if (!session || planning || !isCurrentAgentProject()) return
    const mentions = options.mentions?.length
      ? options.mentions
      : snapshotBotanicAgentComposerMentions({ references: contextItems })
    if (mentions.length) options = { ...options, mentions }
    // continuation 显式携带 targetNodeId（包括 null）时，一律按 Turn 快照解析。
    // 这样刷新后上下文第一张图变了，也不会把旧意图落到新目标。
    let instructionTarget = Object.prototype.hasOwnProperty.call(options, 'targetNodeId')
      ? resolveBotanicAgentContinuationTarget(options.targetNodeId, onResolveTarget)
      : target
    // 快捷操作选的意图只作用于紧随其后的这一条指令；用完即清，
    // 避免一次点击后的残留意图长期覆盖回合模型的判断。
    if (intent) setIntent(undefined); const appendedUserMessageCreatedAt = options.appendUser !== undefined ? Date.now() : undefined
    const appendedUserMessageId = options.appendUser !== undefined
      ? appendMessage({
          role: 'user',
          kind: 'text',
          content: options.appendUser,
          ...(options.mentions?.length ? { mentions: options.mentions } : {}),
          createdAt: appendedUserMessageCreatedAt,
        })
      : ''
    setLiveConversation(undefined); setError('')
    setLastFailedInstruction('')
    setLastFailedPlanMessageId('')
    const failedCommand: AgentFailedInstruction = {
      instruction: cleanInstruction,
      ...(appendedUserMessageId || options.sourceMessageId
        ? { sourceMessageId: appendedUserMessageId || options.sourceMessageId }
        : {}),
      ...(options.requestId ? { requestId: options.requestId } : {}),
      ...(options.sourceTurnId ? { turnId: options.sourceTurnId } : {}),
      options: {
        ...(options.generationOverrides ? { generationOverrides: options.generationOverrides } : {}),
        ...(options.recoveryContextSnapshot?.length ? { recoveryContextSnapshot: options.recoveryContextSnapshot } : {}),
        ...(options.clarificationAnswers ? { clarificationAnswers: options.clarificationAnswers } : {}),
        ...(options.creativeBrief ? { creativeBrief: options.creativeBrief } : {}),
        ...(options.sourcePromptMessageId ? { sourcePromptMessageId: options.sourcePromptMessageId } : {}),
        ...(options.resolvedGeneration ? { resolvedGeneration: options.resolvedGeneration } : {}),
        ...(options.region ? { region: options.region } : {}),
        ...(options.composition ? { composition: options.composition } : {}),
        ...(Object.prototype.hasOwnProperty.call(options, 'targetNodeId')
          ? { targetNodeId: options.targetNodeId }
          : {}),
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
      const totalCandidateCount = botanicAgentCompositionTotalCandidateCount(composition)
      const executionDecision = resolveBotanicAgentExecutionDecision({
        mode: session.executionMode,
        settingsComplete: true,
        pendingActionCount: 0,
        outputCount: totalCandidateCount,
        waivers: session.confirmationWaivers,
      })
      const sessionModel = [...session.messages].reverse().find((message) => message.plan)?.plan?.settings.model
      const { model: requestedModel, ...compositionOverrides } = pendingGenerationOverrides
      const imageModel = resolveBotanicAgentCompositionImageModel(generationModels, [
        requestedModel,
        sessionModel,
        target?.rootRecipe.settings.model,
      ])
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
              ...compositionOverrides,
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
    const hasVisualContext = Boolean(instructionTarget) || hasImageContext
    // 路由与生成前置全部是纯决策，由领域模块拥有；这里只按返回值执行副作用。
    const entry = resolveBotanicAgentInstructionEntry({
      instruction: cleanInstruction,
      options,
      hasVisualContext,
      canSelectRegion: Boolean(instructionTarget?.image),
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
            ? `Box the spot on “${instructionTarget?.label ?? 'Current result'}” where the logo should go. We’ll stamp the reference as-is instead of regenerating a badge.`
            : `Select the area to redraw on “${instructionTarget?.label ?? 'Current result'}”; everything outside it will stay unchanged.`)
          : botanicAgentRegionSelectNotice(cleanInstruction, instructionTarget?.label ?? '当前结果'),
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

    // 服务端回合解析器：由会话 ID 与本轮消息从权威 Message 实体重建历史，
    // 再判断意图并综合可执行 Prompt，取代浏览器端正则路由。
    // 服务端未配置或离线时回退到本地正则决策，保证本地开发、e2e 与无 Provider 部署不受影响。
    let serverDecision: ReturnType<typeof decideBotanicAgentRequest> | undefined = entry.decision
    let synthesizedPrompt: string | undefined = entry.synthesizedPrompt
    let requestedIntent: BotanicAgentIntent | undefined = intent ?? entry.synthesizedIntent
    let synthesizedCount: number | undefined = entry.synthesizedCount
    let synthesizedDuration: number | undefined = entry.synthesizedDuration
    let synthesizedVariants: Array<{ label: string; promptDelta: string }> | undefined = entry.synthesizedVariants
    let synthesizedAxisLabel: string | undefined = entry.synthesizedAxisLabel
    // 提出这条计划的回合。确认后随 Run 持久化，Turn 侧据此反查产出的 Run；
    // 追问回程不再发起新回合，所以要从 entry 带回来而不是重新取。
    let sourceTurnId: string | undefined = options.sourceTurnId ?? entry.synthesizedTurnId
    const sourceTurnMessageIdentity = () => {
      if (!sourceTurnId) return {}
      const messageId = options.turnProjection?.turnId === sourceTurnId
        ? options.turnProjection.messageId
        : botanicAgentTurnProjectionMessageId(sourceTurnId)
      return { id: messageId, turnId: sourceTurnId, status: 'answered' as const }
    }
    let resolvedOptions = entry.options
    if (entry.useServerTurn) {
      // 正常发送直接复用 appendMessage 返回的身份；失败重试只按保存的 Message 身份恢复。
      const existingInputMessage = appendedUserMessageId
        ? undefined
        : resolveAgentRetrySourceMessage(session.messages, options.sourceMessageId)
      const turnInputMessage = appendedUserMessageId
        ? {
            id: appendedUserMessageId,
            content: options.appendUser ?? cleanInstruction,
            ...(options.mentions?.length ? { mentions: options.mentions } : {}),
          }
        : existingInputMessage
          ? {
              id: existingInputMessage.id,
              content: existingInputMessage.content,
              ...(existingInputMessage.mentions?.length ? { mentions: existingInputMessage.mentions } : {}),
            }
          : undefined
      if (serverPersistenceEnabled && turnInputMessage) {
      plannerControllerRef.current?.abort()
      const controller = new AbortController()
      plannerControllerRef.current = controller
      setPlanning(true)
      setRuntimePhase('planning')
      const liveMessageId = `agent-message-${crypto.randomUUID()}`
      const liveStartedAt = Date.now()
      let latestTimeline = createAgentTimeline(liveStartedAt)
      let latestLiveContent = ''
      let runtimeTurnId = ''
      setLiveConversation({
        sessionId: session.id,
        message: {
          id: liveMessageId,
          role: 'assistant',
          kind: 'text',
          content: '',
          createdAt: liveStartedAt,
        },
        timeline: latestTimeline,
        streaming: true,
      })
      let persistedInputMessage: BotanicAgentMessage = existingInputMessage ?? {
        id: turnInputMessage.id,
        role: 'user',
        kind: 'text',
        content: turnInputMessage.content,
        ...(turnInputMessage.mentions?.length ? { mentions: turnInputMessage.mentions } : {}),
        createdAt: appendedUserMessageCreatedAt ?? Date.now(),
      }
      try {
        const preparedContextIds = onPrepareVisionContext
          ? await onPrepareVisionContext(session.id)
          : []
        const contextNodeIds = normalizeBotanicAgentContextNodeIds([
          ...(turnInputMessage.mentions ?? []).filter((item) => item.kind === 'reference').map((item) => item.id),
          ...session.contextNodeIds,
          ...preparedContextIds,
        ])
        const turnRequest = {
          projectId,
          sessionId: session.id,
          inputMessage: turnInputMessage,
          locale,
          plannerModel,
          ...(showRawReasoning ? { showRawReasoning: true } : {}),
          mountedSkillIds: session.mountedSkillIds,
          contextNodeIds,
          hasTarget: Boolean(instructionTarget),
          ...(instructionTarget ? {
            selectedResultNodeId: instructionTarget.id,
            selectedResultLabel: instructionTarget.label,
          } : {}),
          executionMode: session.executionMode,
          generationModels,
        }
        failedCommand.sourceMessageId = turnInputMessage.id
        failedCommand.requestId = options.requestId ?? await botanicAgentTurnRequestKey(turnRequest)
        // accepted 前也先留下 durable「已提交」意图；若响应在身份到达前断线，刷新/重渲染
        // 会用同一 Message 派生的稳定 key 续提交，而不是把请求永久停在一条错误提示上。
        persistedInputMessage = persistMessageUpdate(persistedInputMessage, {
          status: 'pending',
          turnRequestSnapshot: botanicAgentTurnRequestSnapshot(turnRequest),
        })
        awaitingTurnIdentityRef.current = true
        activeTurnInputMessageIdRef.current = turnInputMessage.id
        activeTurnInputMessageRef.current = persistedInputMessage
        // 离线队列先同步保存 snapshot：哪怕 Turn POST 一个字节也没到服务端，
        // 刷新/换设备后仍能用原 target/context/model/mode 续提交。
        await ensureMessageDurable(persistedInputMessage)
        const turn = await streamBotanicAgentTurn(turnRequest, {
          signal: controller.signal,
          onAccepted: (turnId) => {
            runtimeTurnId = turnId
            failedCommand.turnId = turnId
            awaitingTurnIdentityRef.current = false
            activeTurnIdRef.current = turnId
            const cancellationRequestedAt = turnCancellationIntentRef.current.get(turnInputMessage.id)
              ?? persistedInputMessage.turnCancellationRequestedAt
            persistedInputMessage = persistMessageUpdate(persistedInputMessage, {
              turnId,
              ...(cancellationRequestedAt ? { turnCancellationRequestedAt: cancellationRequestedAt } : {}),
            })
            activeTurnInputMessageRef.current = persistedInputMessage
            if (cancelWhenAcceptedSessionIdRef.current === session.id || cancellationRequestedAt) {
              cancelWhenAcceptedSessionIdRef.current = ''
              void ensureDeepTurnCancellation(turnId, controller.signal).catch((caught) => {
                if (controller.signal.aborted) return
                setError(localizeProductError(caught, locale, {
                  'zh-CN': '暂时无法取消本轮 Agent 任务，请重试。',
                  en: 'Unable to cancel this Agent turn. Try again.',
                }))
              })
            }
          },
          onEvent: (event) => {
            if (controller.signal.aborted) return
            const receivedAt = Date.now()
            const next = applyAgentConversationStreamEvent(
              { content: latestLiveContent, timeline: latestTimeline },
              agentTimelineEvent(event, receivedAt),
            )
            latestLiveContent = next.content
            latestTimeline = next.timeline
            setLiveConversation((current) => {
              if (current?.sessionId !== session.id || current.message.id !== liveMessageId) return current
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
        const projectedTurnId = turn.runtimeTurnId ?? runtimeTurnId
        const projectedMessageId = projectedTurnId
          ? botanicAgentTurnProjectionMessageId(projectedTurnId)
          : liveMessageId
        const cancellationRequestedAt = turnCancellationIntentRef.current.get(turnInputMessage.id)
        if (hasBotanicAgentTurnCancellationIntent(persistedInputMessage, cancellationRequestedAt)) {
          if (!projectedTurnId) {
            throw new ProductApiError('Agent 回合取消时缺少稳定身份。', 0, 'AGENT_TURN_IDENTITY_MISSING')
          }
          // Stop 可能在 observer 即将返回 completed 时才到达。终态投影/生成 handoff 前
          // 再以实时 intent 压一次，并等待深取消，不能让先到的 completed 穿过去。
          await ensureDeepTurnCancellation(projectedTurnId, controller.signal)
          await observePersistentBotanicAgentTurn(projectedTurnId, projectId, { signal: controller.signal })
          throw new ProductApiError('Agent 回合已取消。', 0, 'AGENT_TURN_CANCELLED')
        }
        const settleTurnLive = (persistTimeline: boolean) => {
          attachPlannerToolTrace({ toolCalls: turn.toolCalls } as BotanicAgentPlan)
          attachRuntimeReasoning(turn.reasoning)
          if (persistTimeline) {
            setExecutionTimelines((current) => persistAgentLiveTimeline(current, projectedMessageId, latestTimeline))
          }
          setLiveConversation((current) => current?.message.id === liveMessageId ? undefined : current)
        }
        if (turn.kind === 'chat') {
          setRuntimePhase('completed')
          setRuntimeDetailsOpen(false)
          const sourceNote = turn.sources?.length ? `\n\n${copy.sources}: ${turn.sources.join(locale === 'en' ? ', ' : '、')}` : ''
          appendMessage({
            id: projectedMessageId,
            role: 'assistant',
            kind: 'text',
            content: `${turn.answer}${sourceNote}`,
            status: 'answered',
            ...(projectedTurnId ? { turnId: projectedTurnId } : {}),
          })
          settleTurnLive(true)
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
            id: projectedMessageId,
            role: 'assistant',
            kind: 'text',
            content: `${turn.question}${optionLines}`,
            status: 'answered',
            ...(projectedTurnId ? { turnId: projectedTurnId } : {}),
          })
          settleTurnLive(true)
          return
        }
        if (turn.kind === 'composition') {
          if (!isCurrentAgentProject()) return
          setRuntimePhase('completed')
          setRuntimeDetailsOpen(false)
          const composition = normalizeBotanicAgentComposition({ theme: turn.theme, items: turn.items })
          if (!composition) {
            settleTurnLive(false)
            appendMessage({
              id: projectedMessageId,
              role: 'assistant',
              kind: 'notice',
              status: 'failed',
              content: locale === 'en'
                ? 'The request did not produce a usable composition. Describe the items you want to deliver again.'
                : '这次分解没有形成可用的成套方案，请再描述一次交付项。',
              ...(projectedTurnId ? { turnId: projectedTurnId } : {}),
            })
            return
          }
          appendMessage({
            id: projectedMessageId,
            role: 'assistant',
            kind: 'composition',
            composition,
            content: formatBotanicAgentCompositionSummary(composition, locale),
            status: 'answered',
            ...(projectedTurnId ? { turnId: projectedTurnId } : {}),
          })
          settleTurnLive(true)
          return
        }
        settleTurnLive(false)
        serverDecision = { kind: 'generation', mediaKind: turn.mediaKind, promptSource: 'instruction' }
        const continuation = botanicAgentTurnGenerationContinuation(turn, projectedTurnId ?? '')
        instructionTarget = resolveBotanicAgentContinuationTarget(continuation.targetNodeId, onResolveTarget)
        synthesizedPrompt = continuation.resolvedGeneration.prompt
        requestedIntent ??= continuation.resolvedGeneration.intent
        synthesizedCount = continuation.resolvedGeneration.count
        synthesizedDuration = continuation.resolvedGeneration.duration
        synthesizedVariants = continuation.resolvedGeneration.variants
        synthesizedAxisLabel = continuation.resolvedGeneration.variationAxisLabel
        sourceTurnId = projectedTurnId
        resolvedOptions = {
          ...resolvedOptions,
          targetNodeId: continuation.targetNodeId,
          ...(continuation.generationOverrides
            ? { generationOverrides: { ...continuation.generationOverrides, ...options.generationOverrides } }
            : {}),
        }
        // 后续计划器失败的重试命令也必须继承这个 immutable target；
        // settingsHint 缺失不得让目标身份跟着丢失。
        failedCommand.options = { ...failedCommand.options, targetNodeId: continuation.targetNodeId }
      } catch (caught) {
        if (controller.signal.aborted) return
        if (!runtimeTurnId && isRetryableBotanicAgentTurnRecoveryError(caught)) {
          // accepted 前的传输失败不能等价成“服务端没收到”，也不能回退本地生成。
          // pending/Stop 意图已随用户 Message 入队；effect 会用同一稳定 key 续提交。
          const cancellationPending = cancelWhenAcceptedSessionIdRef.current === session.id
            || turnCancellationIntentRef.current.has(turnInputMessage.id)
          setLiveConversation((current) => current?.message.id === liveMessageId ? undefined : current)
          setError(cancellationPending
            ? locale === 'en'
              ? 'The stop request is saved. Reconnecting to the Agent turn…'
              : '取消意图已保存，正在用同一回合身份重新连接…'
            : locale === 'en'
              ? 'The Agent connection was interrupted. Reconnecting to the same turn…'
              : 'Agent 连接中断，正在用同一回合身份恢复…')
          // planning 本身不能放进 observer effect 依赖（effect 会自己置忙形成循环）。
          // 这个显式 handoff 与 finally 的 setPlanning(false) 同批提交，驱动同 Message 恢复。
          window.setTimeout(() => {
            if (agentMountedRef.current && isCurrentAgentProject()) {
              setTurnRecoveryEpoch((current) => current + 1)
            }
          }, 0)
          return
        }
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
        // 非传输类失败才允许结束 durable 恢复意图。网络/404/网关错误已在上面保留
        // pending，避免 POST 实际已到服务端却又在浏览器本地重跑一次。
        const fallBack = !runtimeTurnId && caught instanceof ProductApiError
          && (caught.status === 0 || caught.status === 404 || caught.status >= 500)
          && !(caught.code === 'STREAM_DISCONNECTED' || caught.code === 'REQUEST_TIMEOUT')
        if (!fallBack) {
          if (!runtimeTurnId) persistedInputMessage = persistMessageUpdate(persistedInputMessage, { status: 'failed' })
          const message = localizeProductError(caught, locale, {
            'zh-CN': copy.unavailable,
            en: copy.unavailable,
          })
          const cancelled = caught instanceof ProductApiError && caught.code === 'AGENT_TURN_CANCELLED'
          if (runtimeTurnId) {
            appendMessage({
              id: botanicAgentTurnProjectionMessageId(runtimeTurnId),
              turnId: runtimeTurnId,
              role: 'assistant',
              kind: 'notice',
              status: 'failed',
              content: cancelled
                ? (locale === 'en' ? 'Agent turn cancelled.' : '已取消本轮 Agent 任务。')
                : message,
            })
            setLiveConversation((current) => current?.message.id === liveMessageId ? undefined : current)
          }
          if (cancelled) {
            setRuntimePhase('idle')
            return
          }
          failRuntimeTrace(message)
          setError(message)
          rememberFailedInstruction(failedCommand)
          return
        }
        persistedInputMessage = persistMessageUpdate(persistedInputMessage, { status: 'answered' })
        setLiveConversation((current) => current?.message.id === liveMessageId ? undefined : current)
      } finally {
        awaitingTurnIdentityRef.current = false
        settlePreIdentityCancellation(
          session.id,
          Boolean(runtimeTurnId),
          persistedInputMessage.status === 'pending',
        )
        if (runtimeTurnId) cancellingTurnIdsRef.current.delete(runtimeTurnId)
        if (plannerControllerRef.current === controller) plannerControllerRef.current = null
        if (runtimeTurnId && activeTurnIdRef.current === runtimeTurnId) activeTurnIdRef.current = ''
        if (activeTurnInputMessageIdRef.current === turnInputMessage.id) {
          activeTurnInputMessageIdRef.current = ''
          activeTurnInputMessageRef.current = null
        }
        // 生成流程自己会重新置忙。这里无条件复位：下面到追问、失败等早退分支之间没有
        // await，用户看不到闪烁，而漏掉复位会把输入框和确认卡一起锁死。
        setPlanning(false)
      }
      }
    }

    const decision = serverDecision ?? decideBotanicAgentRequest(cleanInstruction, hasVisualContext)
    if (decision.kind === 'clarification') {
      appendMessage({
        ...sourceTurnMessageIdentity(),
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
            ...sourceTurnMessageIdentity(),
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
          ...failedCommand,
          instruction: cleanInstruction,
          options: { ...failedCommand.options, creativeBrief: briefTurn.brief },
        }
      }
      if (!serverPersistenceEnabled) {
        setRuntimePhase('completed')
        setRuntimeDetailsOpen(false)
        appendMessage({
          role: 'assistant',
          kind: 'text',
          content: route === 'prompt' ? flowCopy.localPreviewPrompt(routedInstruction) : flowCopy.localPreviewChat,
          ...(route === 'prompt' ? { prompt: routedInstruction } : {}),
        })
        return
      }
      plannerControllerRef.current?.abort()
      const controller = new AbortController()
      plannerControllerRef.current = controller
      setPlanning(true)
      setRuntimePhase('planning')
      const liveMessageId = `agent-message-${crypto.randomUUID()}`
      const liveStartedAt = Date.now()
      let runtimeTurnId = ''
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
      awaitingTurnIdentityRef.current = true
      try {
        // 实时通道只改变“回答什么时候到”：思考与工具进入时间线，回答增量写入气泡正文。
        // 完整回答仍等 done 一次性落成消息，避免半截内容进入对话记录。
        // 工具步进只来自服务端 execute 前后的真实 emit，不做 rAF 假进度。
        const preparedContextIds = onPrepareVisionContext
          ? await onPrepareVisionContext(session.id)
          : []
        const contextNodeIds = normalizeBotanicAgentContextNodeIds([
          ...session.contextNodeIds,
          ...preparedContextIds,
        ])
        const existingInputMessage = appendedUserMessageId
          ? undefined
          : resolveAgentRetrySourceMessage(session.messages, options.sourceMessageId)
        const durableInputMessage: BotanicAgentMessage = existingInputMessage ?? {
          id: appendedUserMessageId || `agent-message-${crypto.randomUUID()}`,
          role: 'user',
          kind: 'text',
          content: options.appendUser ?? cleanInstruction,
          ...(options.mentions?.length ? { mentions: options.mentions } : {}),
          createdAt: appendedUserMessageCreatedAt ?? Date.now(),
        }
        routedFailedCommand.sourceMessageId = durableInputMessage.id
        routedFailedCommand.requestId = options.requestId
          ?? `agent-chat:${sourceTurnId ?? durableInputMessage.id}`
        await ensureMessageDurable(durableInputMessage)
        const response = await streamBotanicAgentChat({
          projectId,
          sessionId: session.id,
          inputMessage: { id: durableInputMessage.id, content: durableInputMessage.content },
          locale,
          plannerModel,
          mountedSkillIds: session.mountedSkillIds,
          mode: route,
          contextNodeIds,
        }, {
          signal: controller.signal,
          requestKey: routedFailedCommand.requestId,
          onAccepted: (turnId) => {
            runtimeTurnId = turnId
            routedFailedCommand.turnId = turnId
            awaitingTurnIdentityRef.current = false
            activeTurnIdRef.current = turnId
            if (cancelWhenAcceptedSessionIdRef.current === session.id) {
              cancelWhenAcceptedSessionIdRef.current = ''
              void ensureDeepTurnCancellation(turnId, controller.signal).catch((caught) => {
                if (!controller.signal.aborted) setError(localizeProductError(caught, locale, {
                  'zh-CN': '暂时无法取消本轮 Agent 对话，请重试。',
                  en: 'Unable to cancel this Agent chat turn. Try again.',
                }))
              })
            }
          },
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
        awaitingTurnIdentityRef.current = false
        settlePreIdentityCancellation(session.id, Boolean(runtimeTurnId))
        if (runtimeTurnId && activeTurnIdRef.current === runtimeTurnId) activeTurnIdRef.current = ''
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
      requestedIntent,
      target: instructionTarget
        ? { id: instructionTarget.id, label: instructionTarget.label, image: instructionTarget.image, inheritedSettings: instructionTarget.rootRecipe.settings }
        : undefined,
      // 失败 Run 恢复的权威引用排在最前：身份、顺序与角色以原计划快照为准，
      // 快照构建会按 nodeId 去重，UI 里新增的引用仍可追加在后。
      contextItems: resolvedOptions.recoveryContextSnapshot?.length
        ? [...resolvedOptions.recoveryContextSnapshot, ...contextItems]
        : contextItems,
      variationAssetGroup: variationGroup
        ? { id: variationGroup.id, role: variationGroup.role, assetCount: variationGroup.assetIds.length }
        : undefined,
      synthesizedPrompt,
      synthesizedCount,
      synthesizedDuration,
      synthesizedVariants,
      synthesizedAxisLabel,
      synthesizedTurnId: sourceTurnId,
    })
    if (draft.kind === 'notice') {
      appendMessage({
        ...sourceTurnMessageIdentity(),
        role: 'assistant',
        kind: 'notice',
        content: draft.notice === 'prompt_missing' ? flowCopy.promptMissing : copy.unsupportedVideo,
      })
      return
    }
    if (draft.kind === 'ask') {
      setRuntimePhase('waiting_clarification')
      appendMessage({
        ...sourceTurnMessageIdentity(),
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
      if (sourceTurnId) appendMessage({
        ...sourceTurnMessageIdentity(),
        role: 'assistant', kind: 'notice', content: draft.message,
      })
      return
    }
    const resolvedFailedCommand: AgentFailedInstruction = {
      ...failedCommand,
      instruction: cleanInstruction,
      options: {
        ...failedCommand.options,
        generationOverrides: draft.generationOverrides,
        creativeBrief: draft.brief,
      },
    }
    setPlanning(true)
    setRuntimePhase('planning')
    if (resolvedOptions.region && instructionTarget) {
      // 局部重绘：选区+指令已完全确定这次生成，本地构建计划，不经服务端图片规划器改写。
      const executionDecision = resolveBotanicAgentExecutionDecision({
        mode: session.executionMode,
        settingsComplete: true,
        pendingActionCount: 0,
        allowAutoSubmit: !entry.requiresGenerationConfirmation,
        waivers: session.confirmationWaivers,
      })
      try {
        const regionPlan = {
          ...buildBotanicAgentPlan({
            instruction: draft.prompt,
            locale,
            creativeBrief: draft.brief,
            selectedResultNodeId: instructionTarget.id,
            selectedResultLabel: instructionTarget.label,
            rootRecipe: instructionTarget.rootRecipe,
            contextSnapshot: createBotanicAgentContextSnapshot(draft.planContextItems),
            region: resolvedOptions.region,
          }),
          plannerModel,
          settings: { ...instructionTarget.rootRecipe.settings, ...draft.generationOverrides },
          ...(sourceTurnId ? { turnId: sourceTurnId } : {}),
          ...(entry.requiresGenerationConfirmation ? { requiresGenerationConfirmation: true } : {}),
        }
        if (!isCurrentAgentProject()) return
        setRuntimePhase('waiting_confirmation')
        const planMessageId = appendMessage({
          ...sourceTurnMessageIdentity(),
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
            ...sourceTurnMessageIdentity(),
            role: 'assistant',
            kind: 'question',
            question: appliedInitial.clarification,
            status: 'pending',
            content: appliedInitial.clarification.question,
          })
          return
        }
        const resolvedInitialPlan = {
          ...appliedInitial.plan,
          plannerModel,
          ...(sourceTurnId ? { turnId: sourceTurnId } : {}),
          ...(entry.requiresGenerationConfirmation ? { requiresGenerationConfirmation: true } : {}),
        }
        attachPlannerToolTrace(resolvedInitialPlan)
        if (!isCurrentAgentProject()) return
        setRuntimePhase('waiting_confirmation')
        const executionDecision = resolveBotanicAgentExecutionDecision({
          mode: session.executionMode,
          // draft 流程里设置不完整会提前走 clarification，到这里必然完整。
          settingsComplete: true,
          pendingActionCount: 0,
          outputCount: resolvedInitialPlan.output.count,
          allowAutoSubmit: !entry.requiresGenerationConfirmation,
          waivers: session.confirmationWaivers,
        })
        const planMessageId = appendMessage({
          ...sourceTurnMessageIdentity(),
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
      sourceTurnId ? `agent-plan:${sourceTurnId}` : undefined,
      requestedIntent,
    )
    if (!nextPlan || !session || !isCurrentAgentProject()) return
    if ('kind' in nextPlan && nextPlan.kind === 'clarification') {
      setRuntimePhase('waiting_clarification')
      appendMessage({
        ...sourceTurnMessageIdentity(),
        role: 'assistant', kind: 'question', question: {
          ...nextPlan.clarification,
          ...draft.carryOver,
        }, status: 'pending',
        content: nextPlan.clarification.question,
      })
      return
    }
    const planned = nextPlan as BotanicAgentPlan
    const resolvedPlan = {
      ...planned,
      ...(sourceTurnId ? { turnId: sourceTurnId } : {}),
      ...(entry.requiresGenerationConfirmation ? { requiresGenerationConfirmation: true } : {}),
    }
    const planMessageId = appendMessage({
      ...sourceTurnMessageIdentity(),
      role: 'assistant', kind: 'plan', plan: resolvedPlan, status: 'pending',
      content: resolvedPlan.summary,
    })
    if (planMessageId) setRuntimePhase('waiting_confirmation')
    const planExecutionDecision = resolveBotanicAgentExecutionDecision({
      mode: session.executionMode,
      settingsComplete: true,
      pendingActionCount: botanicAgentPendingConfirmationCount(resolvedPlan.actions),
      outputCount: resolvedPlan.output.count,
      allowAutoSubmit: !entry.requiresGenerationConfirmation,
      waivers: session.confirmationWaivers,
    })
    if (planMessageId && planExecutionDecision.action === 'auto_submit') {
      await confirmMessagePlan({
        id: planMessageId, role: 'assistant', kind: 'plan', content: resolvedPlan.summary,
        createdAt: Date.now(), plan: resolvedPlan, status: 'pending',
      })
    }
  }

  const pendingTurnMessage = pendingBotanicAgentTurnProjection(session?.messages ?? [])
  const pendingTurnId = pendingTurnMessage?.turnId?.trim() ?? ''
  const pendingTurnRecoveryKey = botanicAgentTurnRecoveryKey(pendingTurnMessage)

  useEffect(() => {
    if (!serverPersistenceEnabled || !session || !pendingTurnMessage || !pendingTurnRecoveryKey) return
    if (activeTurnIdRef.current || awaitingTurnIdentityRef.current || planning
      || reattachingTurnIdsRef.current.has(pendingTurnRecoveryKey)) return
    reattachingTurnIdsRef.current.add(pendingTurnRecoveryKey)
    const controller = new AbortController()
    let observedTurnId = pendingTurnId
    let resultMessageId = observedTurnId
      ? botanicAgentTurnProjectionMessageId(observedTurnId)
      : `agent-turn-pending-${pendingTurnMessage.id}`
    const liveMessageId = resultMessageId
    const startedAt = Date.now()
    let latestTimeline = createAgentTimeline(startedAt)
    let latestLiveContent = ''
    let handedOffToGeneration = false
    const cancellationRequested = hasBotanicAgentTurnCancellationIntent(pendingTurnMessage)
    if (cancellationRequested) {
      turnCancellationIntentRef.current.set(
        pendingTurnMessage.id,
        Number(pendingTurnMessage.turnCancellationRequestedAt),
      )
    }
    activeTurnIdRef.current = observedTurnId
    activeTurnInputMessageIdRef.current = pendingTurnMessage.id
    activeTurnInputMessageRef.current = pendingTurnMessage
    awaitingTurnIdentityRef.current = !observedTurnId
    plannerControllerRef.current = controller
    setPlanning(true)
    setRuntimePhase('planning')
    setLiveConversation({
      sessionId: session.id,
      message: {
        id: liveMessageId,
        role: 'assistant',
        kind: 'text',
        content: '',
        createdAt: startedAt,
        ...(observedTurnId ? { turnId: observedTurnId } : {}),
      },
      timeline: latestTimeline,
      streaming: true,
    })

    const onTurnEvent = (event: Parameters<typeof agentTimelineEvent>[0]) => {
      if (controller.signal.aborted) return
      const receivedAt = Date.now()
      const next = applyAgentConversationStreamEvent(
        { content: latestLiveContent, timeline: latestTimeline },
        agentTimelineEvent(event, receivedAt),
      )
      latestLiveContent = next.content
      latestTimeline = next.timeline
      setLiveConversation((current) => {
        if (current?.sessionId !== session.id || current.message.id !== liveMessageId) return current
        return {
          ...current,
          message: { ...current.message, content: next.content },
          timeline: next.timeline,
          streaming: event.type !== 'done' && event.type !== 'error',
        }
      })
      if (event.type === 'tool') attachPlannerToolTrace({ toolCalls: [event.toolCall] } as BotanicAgentPlan)
      if (event.type === 'reasoning') appendRuntimeReasoningDelta(event.step, event.delta)
    }

    const recoveryInputMessage = {
      id: pendingTurnMessage.id,
      content: pendingTurnMessage.content,
      ...(pendingTurnMessage.mentions?.length ? { mentions: pendingTurnMessage.mentions } : {}),
    }
    const turnRequest = pendingTurnMessage.turnRequestSnapshot
      ? botanicAgentTurnRequestFromSnapshot({
          projectId,
          sessionId: session.id,
          inputMessage: recoveryInputMessage,
          snapshot: pendingTurnMessage.turnRequestSnapshot,
        })
      : {
          // 已有 turnId 的 legacy Message 先 GET observer。若后续需要 bounded POST
          // revalidate，服务端只会复用 immutable stored request；不存在则 409 fail closed。
          projectId,
          sessionId: session.id,
          inputMessage: recoveryInputMessage,
          locale,
          contextNodeIds: [] as string[],
          hasTarget: false,
        } as const

    const acceptRecoveredTurn = (turnId: string) => {
      if (observedTurnId && observedTurnId !== turnId) {
        throw new ProductApiError('Agent 回合身份校验失败。', 409, 'AGENT_TURN_IDENTITY_MISMATCH')
      }
      observedTurnId = turnId
      resultMessageId = botanicAgentTurnProjectionMessageId(turnId)
      awaitingTurnIdentityRef.current = false
      activeTurnIdRef.current = turnId
      const recoveredCancellationRequestedAt = turnCancellationIntentRef.current.get(pendingTurnMessage.id)
        ?? pendingTurnMessage.turnCancellationRequestedAt
      persistMessageUpdate(pendingTurnMessage, {
        turnId,
        ...(Number.isFinite(recoveredCancellationRequestedAt)
          ? { turnCancellationRequestedAt: Number(recoveredCancellationRequestedAt) }
          : {}),
      })
      if (cancelWhenAcceptedSessionIdRef.current === session.id
        || hasBotanicAgentTurnCancellationIntent(pendingTurnMessage, recoveredCancellationRequestedAt)) {
        cancelWhenAcceptedSessionIdRef.current = ''
        void ensureDeepTurnCancellation(turnId, controller.signal).catch((caught) => {
          if (controller.signal.aborted) return
          setError(localizeProductError(caught, locale, {
            'zh-CN': '暂时无法取消本轮 Agent 任务，系统会保留取消意图并重试。',
            en: 'Unable to cancel this Agent turn yet. The stop request is saved and will retry.',
          }))
        })
      }
    }

    if (observedTurnId && cancellationRequested) {
      void ensureDeepTurnCancellation(observedTurnId, controller.signal).catch((caught) => {
        if (controller.signal.aborted) return
        setError(localizeProductError(caught, locale, {
          'zh-CN': '暂时无法取消本轮 Agent 任务，系统会保留取消意图并重试。',
          en: 'Unable to cancel this Agent turn yet. The stop request is saved and will retry.',
        }))
      })
    }

    void (async () => {
      try {
        const recovered = await recoverPendingAgentTurn({
          projectId,
          message: pendingTurnMessage,
          request: turnRequest,
          initialTurnId: pendingTurnId,
          signal: controller.signal,
          onEvent: onTurnEvent,
          onAccepted: acceptRecoveredTurn,
          ensureMessageDurable,
          cancellationRequested: () => hasBotanicAgentTurnCancellationIntent(
            pendingTurnMessage,
            turnCancellationIntentRef.current.get(pendingTurnMessage.id),
          ),
          ensureCancellation: ensureDeepTurnCancellation,
          submitTurn: streamBotanicAgentTurn,
          observeTurn: observePersistentBotanicAgentTurn,
          createError: (message, status, code) => new ProductApiError(message, status, code),
        })
        const { turn, turnId: finalTurnId } = recovered
        observedTurnId = finalTurnId
        resultMessageId = botanicAgentTurnProjectionMessageId(finalTurnId)
        if (controller.signal.aborted || !isCurrentAgentProject()) return
        attachPlannerToolTrace({ toolCalls: turn.toolCalls } as BotanicAgentPlan)
        attachRuntimeReasoning(turn.reasoning)
        setExecutionTimelines((current) => persistAgentLiveTimeline(current, resultMessageId, latestTimeline))
        if (turn.kind === 'chat') {
          const sourceNote = turn.sources?.length
            ? `\n\n${copy.sources}: ${turn.sources.join(locale === 'en' ? ', ' : '、')}`
            : ''
          appendMessage({
            id: resultMessageId, turnId: finalTurnId,
            role: 'assistant', kind: 'text', status: 'answered', content: `${turn.answer}${sourceNote}`,
          })
          setRuntimePhase('completed')
          return
        }
        if (turn.kind === 'clarification') {
          const optionLines = turn.options?.length
            ? `\n\n${turn.options.map((option, index) => `${index + 1}. ${option}`).join('\n')}`
            : ''
          appendMessage({
            id: resultMessageId, turnId: finalTurnId,
            role: 'assistant', kind: 'text', status: 'answered', content: `${turn.question}${optionLines}`,
          })
          setRuntimePhase('waiting_clarification')
          return
        }
        if (turn.kind === 'composition') {
          const composition = normalizeBotanicAgentComposition({ theme: turn.theme, items: turn.items })
          appendMessage(composition
            ? {
                id: resultMessageId, turnId: finalTurnId,
                role: 'assistant', kind: 'composition', composition, status: 'answered',
                content: formatBotanicAgentCompositionSummary(composition, locale),
              }
            : {
                id: resultMessageId, turnId: finalTurnId,
                role: 'assistant', kind: 'notice', status: 'failed',
                content: locale === 'en'
                  ? 'The request did not produce a usable composition. Describe the items you want to deliver again.'
                  : '这次分解没有形成可用的成套方案，请再描述一次交付项。',
              })
          setRuntimePhase('completed')
          return
        }
        handedOffToGeneration = true
        if (plannerControllerRef.current === controller) plannerControllerRef.current = null
        if (activeTurnIdRef.current === finalTurnId) activeTurnIdRef.current = ''
        setLiveConversation((current) => current?.message.id === liveMessageId ? undefined : current)
        setPlanning(false)
        await runInstruction(pendingTurnMessage.content, {
          ...botanicAgentTurnGenerationContinuation(turn, finalTurnId),
          turnProjection: { turnId: finalTurnId, messageId: resultMessageId },
          sourceMessageId: pendingTurnMessage.id,
          sourceTurnId: finalTurnId,
        })
      } catch (caught) {
        if (controller.signal.aborted) return
        const message = caught instanceof ProductApiError && caught.code === 'AGENT_TURN_CANCELLED'
          ? (locale === 'en' ? 'Agent turn cancelled.' : '已取消本轮 Agent 任务。')
          : localizeProductError(caught, locale, { 'zh-CN': copy.unavailable, en: copy.unavailable })
        if (observedTurnId) {
          appendMessage({
            id: botanicAgentTurnProjectionMessageId(observedTurnId), turnId: observedTurnId,
            role: 'assistant', kind: 'notice', status: 'failed', content: message,
          })
        } else {
          // POST 对稳定 Message 身份给出 400/409 等明确拒绝后，这条输入不再是恢复意图。
          // durable failed 会推进 selector；Stop 审计字段仍保留，但不会让它永久饿死后续轮次。
          persistMessageUpdate(pendingTurnMessage, { status: 'failed' })
        }
        setRuntimePhase(caught instanceof ProductApiError && caught.code === 'AGENT_TURN_CANCELLED' ? 'idle' : 'failed')
        if (!(caught instanceof ProductApiError && caught.code === 'AGENT_TURN_CANCELLED')) setError(message)
      } finally {
        awaitingTurnIdentityRef.current = false
        settlePreIdentityCancellation(session.id, Boolean(observedTurnId))
        if (observedTurnId) cancellingTurnIdsRef.current.delete(observedTurnId)
        if (plannerControllerRef.current === controller) plannerControllerRef.current = null
        if (observedTurnId && activeTurnIdRef.current === observedTurnId) activeTurnIdRef.current = ''
        if (activeTurnInputMessageIdRef.current === pendingTurnMessage.id) {
          activeTurnInputMessageIdRef.current = ''
          activeTurnInputMessageRef.current = null
        }
        if (!handedOffToGeneration) {
          setLiveConversation((current) => current?.message.id === liveMessageId ? undefined : current)
          setPlanning(false)
        }
      }
    })()

    return () => {
      controller.abort()
      reattachingTurnIdsRef.current.delete(pendingTurnRecoveryKey)
      if (plannerControllerRef.current === controller) plannerControllerRef.current = null
      if (observedTurnId && activeTurnIdRef.current === observedTurnId) activeTurnIdRef.current = ''
      if (activeTurnInputMessageIdRef.current === pendingTurnMessage.id) {
        activeTurnInputMessageIdRef.current = ''
        activeTurnInputMessageRef.current = null
      }
    }
    // 只以 pending identity 驱动 observer 生命周期；渲染期函数会随状态重建，不能因此中断 durable 续读。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingTurnRecoveryKey, projectId, session?.id, turnRecoveryEpoch])

  const cancelPlanning = () => {
    const turnId = activeTurnIdRef.current
    const inputMessageId = activeTurnInputMessageIdRef.current
    const inputMessage = session?.messages.find((message) => message.id === inputMessageId && message.role === 'user')
      ?? (activeTurnInputMessageRef.current?.id === inputMessageId
        ? activeTurnInputMessageRef.current
        : undefined)
    if (inputMessage) {
      const requestedAt = inputMessage.turnCancellationRequestedAt ?? Date.now()
      turnCancellationIntentRef.current.set(inputMessage.id, requestedAt)
      persistMessageUpdate(inputMessage, { turnCancellationRequestedAt: requestedAt })
    }
    if (turnId && cancellationPromisesRef.current.has(turnId)) return
    const cancellationSessionId = session?.id ?? ''
    setCancellingSessionId(cancellationSessionId)
    void stopBotanicAgentPlanning({
      turnId,
      turnIdentityPending: awaitingTurnIdentityRef.current,
      cancelTurn: async (targetTurnId) => {
        await ensureDeepTurnCancellation(targetTurnId, plannerControllerRef.current?.signal)
      },
      cancelWhenAccepted: () => { cancelWhenAcceptedSessionIdRef.current = cancellationSessionId },
      abortLocalRequest: () => plannerControllerRef.current?.abort(),
    }).then((result) => {
      if (result.kind === 'aborted_local') {
        setCancellingSessionId((current) => current === cancellationSessionId ? '' : current)
      }
    }).catch((caught) => {
      setCancellingSessionId((current) => current === cancellationSessionId ? '' : current)
      setError(localizeProductError(caught, locale, {
        'zh-CN': '暂时无法取消本轮 Agent 任务，取消意图已保存，请稍后重试。',
        en: 'Unable to cancel this Agent turn yet. The stop request is saved for retry.',
      }))
    })
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
    updateComposerState({ pendingGenerationOverrides: {}, pendingRecoveryContextSnapshot: undefined })
    void runInstruction(retryInstruction, {
      ...command?.options,
      ...(command?.sourceMessageId
        ? { sourceMessageId: command.sourceMessageId }
        : { appendUser: retryInstruction }),
      ...(command?.requestId ? { requestId: command.requestId } : {}),
      ...(command?.turnId ? { sourceTurnId: command.turnId } : {}),
    }).finally(() => {
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
    const recoveryContextSnapshot = pendingRecoveryContextSnapshot
    updateComposerState({ pendingGenerationOverrides: {}, pendingRecoveryContextSnapshot: undefined })
    try {
      await runInstruction(prepared.instruction, {
        appendUser: prepared.content,
        mentions: prepared.mentions,
        generationOverrides,
        ...(recoveryContextSnapshot?.length ? { recoveryContextSnapshot } : {}),
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

  // 张数是这张卡上唯一直接决定费用的量。批量输出由素材组/变体分支展开，改它会和来源脱节，
  // 所以只有 single 可改，且钳在领域上限内。
  const commitPlanOutputCount = (message: BotanicAgentMessage, count: number) => {
    if (!session || !message.plan) return
    if (message.status === 'submitted') return
    if (message.plan.output.mode !== 'single') return
    const next = Math.min(BOTANIC_AGENT_MAX_SINGLE_OUTPUT, Math.max(1, Math.floor(count)))
    if (!Number.isFinite(next) || next === message.plan.output.count) return
    onUpdateMessage(session.id, message.id, {
      plan: { ...message.plan, output: { ...message.plan.output, count: next } },
    })
  }

  const createNextRoundFromResults = (sourceNodeIds: string[], artifactCount: number) => {
    if (!sourceNodeIds.length) return
    onUseResultContext(sourceNodeIds)
    setInstruction(artifactCount === 1
      ? flowCopy.nextRoundOne
      : flowCopy.nextRoundMany(artifactCount))
    setUtilityPanel(null)
    requestAnimationFrame(() => composerTextareaRef.current?.focus())
  }

  const continueFromArtifact = (artifact: BotanicAgentArtifact) => {
    onContinueArtifact(artifact)
    setInstruction(flowCopy.continueArtifact(artifact.label))
    setUtilityPanel(null)
    requestAnimationFrame(() => composerTextareaRef.current?.focus())
  }

  const persistenceIssue = persistenceStatus === 'offline' || persistenceStatus === 'conflict' || persistenceStatus === 'error'
  const realtimeStatus = collaborationAwareness.realtimeStatus
  const realtimeStatusLabel = realtimeStatus === 'reconnecting'
    ? flowCopy.realtimeReconnecting
    : realtimeStatus === 'connecting'
      ? flowCopy.realtimeConnecting
      : ''
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
  const keepLocalDraft = () => {
    setPersistenceAction('retry')
    void onRetryPersistence().catch(() => undefined).finally(() => setPersistenceAction(''))
  }
  const useRemoteCanvas = () => {
    if (!window.confirm(flowCopy.useRemoteConfirm)) return
    resolvePersistenceIssue()
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
      ref={workspaceRef}
      className={`agent-workspace nopan nowheel${fromEmptyGuide ? ' is-from-guide' : ''}`}
      data-flip-id={fromEmptyGuide ? 'empty-agent-open' : undefined}
      aria-label="Botanic Agent"
      onDragOver={handleImageDragOver}
      onDragLeave={handleImageDragLeave}
      onDrop={handleImageDrop}
      onPaste={handlePaste}
    >
      {isImageDropActive ? <div className="agent-workspace__drop-hint" aria-hidden="true"><UploadIcon /><strong>{flowCopy.dropImages}</strong><small>{flowCopy.uploadLimits}</small></div> : null}
      <header className="agent-workspace__header">
        <div className="agent-workspace__title">
          {renamingSession ? <form className="agent-workspace__title-editor" onSubmit={(event) => { event.preventDefault(); commitSessionTitle() }}>
            <input value={sessionTitleDraft} onChange={(event) => setSessionTitleDraft(event.target.value)} maxLength={160} autoFocus aria-label={flowCopy.conversationName} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); setRenamingSession(false) } }} />
            <button type="submit" aria-label={flowCopy.saveName} title={flowCopy.save}><CheckIcon /></button>
            <button type="button" aria-label={flowCopy.cancelName} title={flowCopy.cancel} onClick={() => setRenamingSession(false)}><CloseIcon /></button>
          </form> : utilityPanelOpen && activeUtilityPanel ? <div className="agent-workspace__panel-chrome">
            <AgentPanelBackButton onClick={closeUtilityPanel} />
            <h2>{({
              result: copy.results,
              task: copy.tasks,
              review: copy.review,
              brand: copy.brand,
              memory: copy.memory,
              skill: copy.skills,
              collaboration: copy.collaboration,
            })[activeUtilityPanel]}</h2>
          </div> : <button
            type="button"
            className="agent-workspace__title-button"
            onClick={(event) => { historyTriggerRef.current = event.currentTarget; setUtilityMenuOpen(false); setHistoryOpen((open) => !open) }}
            aria-controls={historyMenuId}
            aria-expanded={historyOpen}
            title={unreadSessionCount ? flowCopy.historyUnread(unreadSessionCount) : flowCopy.history}
          >
            <span className="agent-workspace__title-label">{displaySessionTitle(session?.title)}</span>
            {unreadSessionCount ? <span className="agent-workspace__history-unread" aria-hidden="true">{Math.min(unreadSessionCount, 9)}</span> : null}
            <span aria-hidden="true">⌄</span>
          </button>}
        </div>
        <div className="agent-workspace__header-actions">
          {realtimeStatusLabel ? <span
            className={`agent-workspace__realtime-status is-${realtimeStatus}`}
            role="status"
            title={realtimeStatus === 'reconnecting' ? flowCopy.realtimeReconnectDetail : realtimeStatusLabel}
          ><i aria-hidden="true" />{realtimeStatusLabel}</span> : null}
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
          <div ref={utilityMenuRef} className="agent-workspace__utility-menu-wrap" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setUtilityMenuOpen(false) }}>
            <button ref={utilityMenuButtonRef} type="button" className={`agent-workspace__utility-menu-button${utilityPanelOpen ? ' is-active' : ''}`} aria-expanded={utilityMenuOpen} aria-controls={utilityMenuId} aria-label={copy.tools} title={copy.tools} onClick={() => { setUtilityMenuOpen((open) => !open); setHistoryOpen(false) }}><MoreIcon /></button>
            {utilityMenuOpen ? <div id={utilityMenuId} className="agent-workspace__utility-menu" aria-label={copy.tools}>
              <button type="button" aria-pressed={resultPanelOpen} className={resultPanelOpen ? 'is-active' : ''} onClick={() => toggleUtilityPanel('result')}><GalleryIcon /><span>{copy.results}</span></button>
              <button type="button" aria-pressed={taskPanelOpen} className={`${taskPanelOpen ? 'is-active ' : ''}${latestRun?.id ? '' : 'is-group-end'}`} onClick={() => toggleUtilityPanel('task')}><ChecklistIcon /><span>{copy.tasks}</span></button>
              {latestRun?.id ? <button type="button" aria-pressed={reviewPanelOpen} className={`${reviewPanelOpen ? 'is-active ' : ''}is-group-end`} onClick={() => toggleUtilityPanel('review')}><FocusIcon /><span>{copy.review}</span></button> : null}
              <button type="button" aria-pressed={brandPanelOpen} className={brandPanelOpen ? 'is-active' : ''} onClick={() => toggleUtilityPanel('brand')}><BookIcon /><span>{copy.brand}</span></button>
              <button type="button" aria-pressed={memoryPanelOpen} className={memoryPanelOpen ? 'is-active' : ''} onClick={() => toggleUtilityPanel('memory')}><BookmarkIcon /><span>{copy.memory}</span></button>
              <button type="button" aria-pressed={skillPanelOpen} className={`${skillPanelOpen ? 'is-active ' : ''}is-group-end`} onClick={() => toggleUtilityPanel('skill')}><SparkleIcon /><span>{copy.skills}</span></button>
              <button type="button" aria-pressed={collaborationPanelOpen} className={collaborationPanelOpen ? 'is-active' : ''} onClick={() => toggleUtilityPanel('collaboration')}><GlobeIcon /><span>{copy.collaboration}</span>{collaborationAwareness.unreadActivityCount ? <b>{Math.min(collaborationAwareness.unreadActivityCount, 99)}</b> : null}</button>
            </div> : null}
          </div>
          <button type="button" className="agent-workspace__close-button" aria-label={copy.close} title={copy.close} onClick={onClose}><DismissIcon /></button>
        </div>
        {historyOpen && !utilityPanelOpen ? <div id={historyMenuId} className="agent-workspace__history" aria-label={flowCopy.history}>
          <div className="agent-workspace__history-find">
            <div className="agent-workspace__history-toolbar">
              <label className="agent-workspace__history-search"><input type="search" aria-label={flowCopy.searchConversations} value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} placeholder={flowCopy.searchPlaceholder} autoFocus /></label>
              <button type="button" className="agent-workspace__history-new" onClick={() => { onNewSession(); setHistoryOpen(false); setHistoryQuery(''); setHistoryFilter('all') }}><PlusIcon /> {flowCopy.newConversation}</button>
            </div>
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
          </div>
          <div className="agent-workspace__history-list">
          {filteredSessionTimeline.map((item) => {
            const active = item.session.id === session?.id
            return <div key={item.session.id} className={`agent-workspace__history-item${active ? ' is-active' : ''}`}>
              <button type="button" className="agent-workspace__history-select" onClick={() => { onSelectSession(item.session.id); setHistoryOpen(false); setHistoryQuery('') }}>
                <span><strong>{displaySessionTitle(item.session.title)}</strong><small>{displaySessionPreview(item.preview)}</small></span>
                <span className="agent-workspace__history-meta"><time dateTime={new Date(item.updatedAt).toISOString()}>{agentTimelineTimestamp(item.updatedAt, locale)}</time>{item.unreadResultCount ? <b className="is-unread">{flowCopy.resultUpdates(item.unreadResultCount)}</b> : item.unreadRunCount ? <b className="is-unread">{flowCopy.updates(item.unreadRunCount)}</b> : item.attentionRunCount ? <b className="is-attention">{flowCopy.attentionCount(item.attentionRunCount)}</b> : item.activeRunCount ? <b>{flowCopy.activeCount(item.activeRunCount)}</b> : item.runCount ? <small>{flowCopy.taskCount(item.runCount)}</small> : null}</span>
              </button>
              {active ? <button type="button" className="agent-workspace__history-rename" aria-label={flowCopy.editName} title={flowCopy.editName} onClick={() => { setHistoryOpen(false); setSessionTitleDraft(displaySessionTitle(item.session.title)); setRenamingSession(true) }}><EditIcon /></button> : null}
            </div>
          })}
          </div>
          {!filteredSessionTimeline.length ? <p className="agent-workspace__history-empty">{flowCopy.noConversations}</p> : null}
        </div> : null}
      </header>
      <div className="agent-workspace__body">
      {latestCollaborationActivity?.unread || (!utilityPanelOpen && (readingRestoreNotice || reviewProjection.failed)) ? <div className="agent-workspace__chrome">
      {latestCollaborationActivity?.unread ? <div className="agent-workspace__collaboration-notice" role="status">
        <button type="button" className="agent-workspace__collaboration-summary" onClick={() => locateCollaborationActivity(latestCollaborationActivity)}>
          <i aria-hidden="true" /><span><strong>{latestCollaborationActivity.actorName} · {latestCollaborationActivity.summary}</strong><small>{persistenceStatus === 'conflict' ? flowCopy.localChangesKept : latestCollaborationActivity.target && latestCollaborationActivity.target.kind !== 'project' ? flowCopy.locateChange : flowCopy.latestSynced}</small></span>
        </button>
        <button type="button" aria-label={flowCopy.closeCollaborationUpdate} title={flowCopy.gotIt} onClick={() => void onDismissRemoteChange().catch(() => undefined)}><CloseIcon /></button>
      </div> : null}
      {!utilityPanelOpen && readingRestoreNotice ? <div className="agent-reading-restore" role="status"><span>{flowCopy.readingRestored}</span><button type="button" onClick={jumpToLatestConversation}>{flowCopy.jumpLatest}</button></div> : null}
      {!utilityPanelOpen && reviewProjection.failed ? <div className="agent-reading-restore" role="alert"><span>{locale === 'en' ? 'Review results could not be loaded.' : '评审结果暂时无法读取。'}</span><button type="button" onClick={reviewProjection.retry}>{locale === 'en' ? 'Retry' : '重试'}</button></div> : null}
      </div> : null}
      <div
        ref={messagesViewportRef}
        className="agent-workspace__messages"
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        onScroll={handleMessagesScroll}
      >
        {loadingOlderMessages ? <div className="agent-workspace__history-loading" role="status">{flowCopy.processing}</div> : null}
        {resultPanelOpen ? <div data-agent-flip className="agent-workspace__flip-surface"><AgentResultPanel
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
        /></div> : null}
        {collaborationPanelOpen ? <div data-agent-flip className="agent-workspace__flip-surface"><AgentCollaborationPanel
          activities={collaborationAwareness.activities}
          conflictChanges={collaborationAwareness.conflictChanges}
          conflictRevision={collaborationAwareness.conflictRevision}
          persistenceStatus={persistenceStatus}
          onLocate={locateCollaborationActivity}
          onMarkRead={onDismissRemoteChange}
          onClear={onClearCollaborationActivities}
          onKeepLocal={keepLocalDraft}
          onUseRemote={useRemoteCanvas}
          historyStatus={collaborationAwareness.historyStatus}
          historyHasMore={collaborationAwareness.historyHasMore}
          historyErrorAction={collaborationAwareness.historyErrorAction}
          onLoadMore={onLoadMoreCollaborationActivities}
          onReload={onReloadCollaborationActivities}
        /></div> : null}
        {reviewPanelOpen && latestRun?.id ? <div data-agent-flip className="agent-workspace__flip-surface"><AgentReviewPanel
          runId={latestRun.id}
          projectId={projectId}
        /></div> : null}
        {brandPanelOpen ? <div data-agent-flip className="agent-workspace__flip-surface"><BrandKitPanel
          projectId={projectId}
          onBindBrand={onBindBrand}
        /></div> : null}
        {memoryPanelOpen ? <div data-agent-flip className="agent-workspace__flip-surface"><AgentMemoryPanel
          memory={memory}
          sourceNodeIds={session?.contextNodeIds ?? []}
          onAddMemory={onAddMemory}
          onRemoveMemory={onRemoveMemory}
          onLocateNode={onLocateNode}
        /></div> : null}
        {taskPanelOpen ? <div data-agent-flip className="agent-workspace__flip-surface"><AgentTaskPanel
          timeline={runTimeline}
          artifacts={artifacts}
          availableCanvasNodeIds={availableCanvasNodeIds}
          generationModels={generationModels}
          focusedRunId={focusedTaskRunId}
          retryingBranchId={retryingBranchId}
          cancellingRunId={cancellingRunId}
          recoveryModelMenuKey={recoveryModelMenuKey}
          onFocusedRunHandled={clearFocusedTaskRun}
          onLocateSource={locateTaskSourceMessage}
          onOpenFeedback={openRunFeedback}
          onPrepareRecovery={prepareFailedRunRecovery}
          onRetryBranch={onRetryBranch}
          onCancelRun={onCancelRun}
          onRetryingBranchChange={setRetryingBranchId}
          onCancellingRunChange={setCancellingRunId}
          onRecoveryModelMenuChange={setRecoveryModelMenuKey}
        /></div> : null}
        {skillPanelOpen ? <div data-agent-flip className="agent-workspace__flip-surface"><AgentSkillPanel
          open={skillPanelOpen}
          serverPersistenceEnabled={serverPersistenceEnabled}
          copy={flowCopy}
          systemSkills={systemSkills}
          skills={skills}
          mountedSkillIds={session?.mountedSkillIds}
          expandedSkillId={skillRegistry.expandedSkillId}
          form={skillRegistry.form}
          nameInputRef={skillRegistry.nameInputRef}
          createButtonRef={skillRegistry.createButtonRef}
          onToggleExpanded={skillRegistry.toggleExpanded}
          onToggleMounted={skillRegistry.toggleMounted}
          onEditName={skillRegistry.editName}
          onEditInstructions={skillRegistry.editInstructions}
          onOpenForm={skillRegistry.openForm}
          onCloseForm={skillRegistry.closeForm}
          onRequestConfirm={skillRegistry.requestConfirm}
          onCancelConfirm={skillRegistry.cancelConfirm}
          onSubmit={skillRegistry.submit}
        /></div> : null}
        {!utilityPanelOpen ? <div data-agent-flip className="agent-workspace__conversation">
        {!hasMessages ? <section className="agent-workspace__welcome">
          <span className="agent-workspace__mark" data-bob-mood={welcomeBob.mood} data-bob-says={welcomeBob.says}><BobCharacter mood={welcomeBob.mood} says={welcomeBob.says} saysCycles={welcomeBob.cycles} onSaysComplete={() => welcomeSays.markPlayed(welcomeBob.says)} /></span>
          <small>{copy.welcomeMark}</small>
          <h2>{target ? copy.welcomeTarget(agentTargetDisplayLabel(target)) : copy.welcome}</h2>
          <p>{target ? copy.welcomeTargetBody : copy.welcomeBody}</p>
          <div className="agent-workspace__starters">
            {agentQuickActions(locale).map((action) => <button key={action.intent} type="button" onClick={() => { setIntent(action.intent); setInstruction(action.instruction) }}><strong>{action.label}</strong><span>{action.instruction}</span></button>)}
          </div>
        </section> : null}
        {session ? renderedConversationMessages.map((message) => {
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
          isLatestAssistant={message.id === latestAssistantMessageId}
          agentBusy={agentBusy}
          isLatestEvaluable={message.id === latestEvaluableMessageId}
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
            setUtilityPanel(null)
            requestAnimationFrame(() => composerTextareaRef.current?.focus())
          }}
          onShowResults={() => setUtilityPanel('result')}
          onShowTask={showTaskForRun}
          onFocusNodes={onFocusNodes}
          onPromoteRunToWorkflow={onPromoteRunToWorkflow}
          onAnswerClarification={(targetMessage, answers) => void answerClarification(targetMessage, answers)}
          onLocateNode={onLocateNode}
          canManualRetryAction={(action) => botanicAgentCanResumeManualRetry(action)
            || botanicAgentCanUseManualRetryAuthorization(
              action,
              manualRetryAuthorization(message, action),
            )}
          onActionIntent={(targetMessage, action, intent) => void confirmAction(targetMessage, action, intent)}
          onDismissAction={(targetMessage, action) => { persistActionUpdate(targetMessage, action.id, { status: 'dismissed' }) }}
          onPromptDraftChange={(messageId, prompt) => setPromptDrafts((current) => ({ ...current, [messageId]: prompt }))}
          onCommitPlanPrompt={commitPlanPrompt}
          onCommitPlanSettings={commitPlanSettings}
          onCommitPlanOutputCount={commitPlanOutputCount}
          confirmationWaivers={session.confirmationWaivers}
          onWaiveConfirmation={(waiver) => onWaiveConfirmation(session.id, waiver)}
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
          onSaveAsMemory={(targetMessage, kind, content) => onAddMemory(kind, content, targetMessage.sourceNodeIds ?? [])}
          onReviewDecision={(targetMessage, decision) => void decideReview(targetMessage, decision)}
          reviewDecisionPending={Boolean(reviewDecisionPendingId && reviewDecisionPendingId === message.review?.id)}
        /></div>
        }) : null}
        {showRuntimeFeed ? (() => {
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
        {latestRun?.branches.length && latestRunFeedback && ['queued', 'running', 'executing'].includes(latestRun.status) ? <section className={`agent-run-card is-${latestRunFeedback.tone} is-compact`} aria-label={flowCopy.runProgress}>
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
        </div> : null}
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
        intentHint={composerIntentHint}
        error={error}
        canRetry={Boolean(lastFailedPlanMessageId || lastFailedInstruction)}
        retrying={planning || submittingMessageId === lastFailedPlanMessageId}
        planning={planning}
        cancelling={planning && cancellingSessionId === session?.id}
        contextMenuOpen={contextMenuOpen}
        modeMenuOpen={modeMenuOpen}
        contextMenuId={contextMenuId}
        modeMenuId={modeMenuId}
        plannerModel={plannerModel}
        plannerModels={plannerModels}
        showRawReasoning={showRawReasoning}
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
        onInstructionChange={(value, caret) => { setInstruction(value); setIntent(undefined); setMentionQuery(readBotanicAgentMentionQuery(value, caret)); setError(''); setLastFailedInstruction(''); setLastFailedPlanMessageId('') }}
        onInstructionClick={(caret) => setMentionQuery(readBotanicAgentMentionQuery(instruction, caret))}
        onRetry={lastFailedPlanMessageId ? retryLastFailedPlan : retryLastInstruction}
        onImportFiles={(files) => void importImageFiles(files)}
        onToggleContextMenu={() => setContextMenuOpen((open) => !open)}
        onCloseContextMenu={() => { setContextMenuOpen(false); requestAnimationFrame(() => contextMenuButtonRef.current?.focus()) }}
        onToggleModeMenu={() => setModeMenuOpen((open) => !open)}
        onPlannerModelChange={(model) => { if (session) onPlannerModelChange(session.id, model) }}
        onShowRawReasoningChange={(show) => {
          if (!session) return
          setRawReasoningSessions((current) => ({ ...current, [session.id]: show }))
        }}
        onGroupChange={setGroupId}
        onSend={() => void sendInstruction()}
        onCancelPlanning={cancelPlanning}
        onToggleImageContext={(itemId, selected) => { if (!session) return; changeSessionContext(selected ? session.contextNodeIds.filter((id) => id !== itemId) : [...session.contextNodeIds, itemId]) }}
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
