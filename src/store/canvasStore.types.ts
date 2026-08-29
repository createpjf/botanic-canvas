import type { Edge, Viewport, XYPosition } from '@xyflow/react'
import type {
  BotanicAgentActionProposal,
  BotanicAgentActionResult,
  BotanicAgentConfirmationWaiver,
  BotanicAgentExecutionMode,
  BotanicAgentMemoryItem,
  BotanicAgentMemoryKind,
  BotanicAgentMessage,
  BotanicAgentPlan,
  BotanicAgentRunBranch,
  BotanicAgentRunSnapshot,
  BotanicAgentRunStatus,
} from '../domain/agent'
import type {
  AssetGroup,
  AssetRecord,
  AssetRole,
  CanvasDocument,
  CanvasNode,
  CanvasTemplate,
  DeliveryPresetId,
  GenerationCandidate,
  GenerationMediaKind,
  GenerationModelOption,
  GenerationRecipe,
  GenerationSettings,
  GenerateNodeData,
  RefinementMode,
  UploadedAssetInput,
} from '../domain/canvas'

export type GenerationStatus = 'idle' | 'uploading' | 'queued' | 'running' | 'recovering' | 'error'
export type PersistenceStatus = 'saved' | 'saving' | 'offline' | 'conflict' | 'error'

export type TaskNodeIds = {
  generateNodeId: string
  resultNodeId: string
  resultNodeIds?: string[]
}

export type TaskFlowLayout = {
  generate: XYPosition
  result: XYPosition
}

export type GenerationRequest = {
  kind: 'generation' | 'refinement'
  prompt: string
  batchCount: number
  settings: GenerationSettings
  recipe?: GenerationRecipe
  rootRecipe?: GenerationRecipe
  title?: string
  targetNodeId?: string
  parentVersionId?: string
  parentImage?: string
  parentLabel?: string
  jobId?: string
  taskNodeIds?: TaskNodeIds
  taskLayout?: TaskFlowLayout
  sourceGraphNodeId?: string
  refinementMode?: RefinementMode
  agentRun?: { runId: string; branchId: string }
  /** 在请求写入任务节点前生成，并随草稿恢复；避免网络重试创建重复任务。 */
  idempotencyKey?: string
}

export type GenerateBranchDraft = {
  prompt?: string
  batchCount?: number
  settings?: Partial<GenerationSettings>
  refinementMode?: RefinementMode
}

export type UndoAction = {
  id: string
  label: string
}

/**
 * 画布应用对 UI 暴露的稳定端口。
 * 新行为先归类到现有命令域，避免组件直接编排持久化或生成细节。
 */
export type CanvasStore = {
  document: CanvasDocument
  /** 跨项目共享的内置/品牌素材；项目上传与生成资产只保存在 document.assets。 */
  globalAssets: AssetRecord[]
  /** 账号级共享工作流；只包含可跨项目复用的品牌素材引用。 */
  sharedTemplates: CanvasTemplate[]
  hydrated: boolean
  persistenceStatus: PersistenceStatus
  selectedNodeId: string | null
  assistantMessage: string
  generationStatus: GenerationStatus
  generationProgress: number
  generationError: string | null
  expectedCandidateCount: number
  generationCandidates: GenerationCandidate[]
  lastGenerationRequest: GenerationRequest | null
  availableModels: GenerationModelOption[]
  maximumBatchCount: number
  undoAction: UndoAction | null
  undoSnapshot: CanvasDocument | null
  hydrate: () => Promise<void>
  openDocument: (documentId: string) => Promise<boolean>
  refreshDocumentFromRemote: () => Promise<boolean>
  recoverGenerationResultsFromRemote: () => Promise<boolean>
  recoverUnknownGenerationSubmission: () => Promise<boolean>
  openNewDocument: (document: CanvasDocument) => void
  renameDocument: (name: string) => Promise<void>
  setNodes: (nodes: CanvasNode[]) => void
  replaceMediaSources: (replacements: Record<string, string>) => Promise<void>
  setNodesTransient: (nodes: CanvasNode[]) => void
  setEdges: (edges: Edge[]) => void
  setViewport: (viewport: Viewport) => void
  applyCollaborativeGraph: (graph: { nodes: CanvasNode[]; edges: Edge[] }) => void
  selectNode: (nodeId: string | null) => void
  addAssetToCanvas: (assetId: string, position?: XYPosition, connectToGenerateId?: string) => void
  addUploadedAssets: (assets: UploadedAssetInput[]) => void
  addUploadedAssetsToCanvas: (assets: UploadedAssetInput[], position?: XYPosition) => void
  saveGeneratedImageToLibrary: (input: { image: string; name: string; mediaKind?: GenerationMediaKind }) => void
  moveAssetToRole: (assetId: string, role: AssetRole) => void
  createAssetGroup: (name: string, role: AssetGroup['role'], assetIds?: string[]) => string | null
  renameAssetGroup: (groupId: string, name: string) => void
  deleteAssetGroup: (groupId: string) => void
  addAssetsToGroup: (groupId: string, assetIds: string[]) => void
  removeAssetFromGroup: (groupId: string, assetId: string) => void
  /** 返回新建节点 ID；`select: false` 让 Agent 等后台写入不抢走用户当前的画布选中态。 */
  addTextNode: (position?: XYPosition, options?: { select?: boolean }) => string
  addGenerateNode: (position?: XYPosition, mediaKind?: 'image' | 'video', inputNodeIds?: string[]) => string | null
  createGenerateBranchFromResult: (resultNodeId: string, draft?: GenerateBranchDraft) => string | null
  createGenerateFromResultRecipe: (resultNodeId: string) => string | null
  renameCanvasNode: (nodeId: string, label: string) => void
  updateTextNode: (nodeId: string, content: string) => void
  updateGenerateNode: (nodeId: string, patch: Partial<Pick<GenerateNodeData, 'label' | 'prompt' | 'batchCount' | 'settings' | 'refinementMode' | 'videoInputMode'>>) => void
  setGenerateNodePrimaryInput: (nodeId: string, assetNodeId: string) => void
  moveGenerateNodeInput: (nodeId: string, inputNodeId: string, direction: 'earlier' | 'later') => void
  setAvailableModels: (models: GenerationModelOption[]) => void
  setMaximumBatchCount: (count: number) => void
  runGraphGeneration: (nodeId: string, agentRun?: { runId: string; branchId: string }) => Promise<boolean>
  runBatchVariation: (input: {
    sourceResultNodeId: string
    groupId: string
    prompt: string
    candidatesPerAsset: number
    settings: GenerationSettings
    agentRunId?: string
    agentBranches?: Array<{ assetId: string; branchId: string }>
  }) => Promise<boolean>
  saveAgentPlan: (plan: BotanicAgentPlan, options?: { id?: string; branches?: BotanicAgentRunBranch[] }) => string
  applyAgentRunSnapshot: (snapshot: BotanicAgentRunSnapshot) => void
  applyAgentWorkflowPatch: (patch: NonNullable<BotanicAgentActionResult['canvasPatch']>) => Promise<boolean>
  retryAgentBranch: (runId: string, branchId: string) => Promise<boolean>
  cancelAgentRun: (runId: string) => Promise<boolean>
  retryBatchVariationItem: (runId: string, itemId: string) => Promise<boolean>
  updateAgentRunStatus: (runId: string, status: BotanicAgentRunStatus, error?: string) => void
  ensureAgentSession: (contextNodeIds?: string[]) => string
  startNewAgentSession: (contextNodeIds?: string[]) => string
  appendAgentMessage: (sessionId: string, message: BotanicAgentMessage) => void
  upsertAgentMessage: (sessionId: string, message: BotanicAgentMessage) => void
  updateAgentMessage: (sessionId: string, messageId: string, patch: Partial<Pick<BotanicAgentMessage, 'kind' | 'content' | 'runId' | 'turnId' | 'turnCancellationRequestedAt' | 'turnRequestSnapshot' | 'status' | 'feedback' | 'plan' | 'question' | 'composition' | 'deliveryStatus' | 'review'>>) => void
  updateAgentAction: (sessionId: string, messageId: string, actionId: string, patch: Partial<Pick<BotanicAgentActionProposal, 'status' | 'receiptIdempotencyKey' | 'preparedRetryIdempotencyKey' | 'manualRetryResumeAvailable' | 'error' | 'result'>>) => void
  setAgentSessionContext: (sessionId: string, contextNodeIds: string[]) => void
  setAgentSessionExecutionMode: (sessionId: string, mode: BotanicAgentExecutionMode) => void
  waiveAgentSessionConfirmation: (sessionId: string, waiver: BotanicAgentConfirmationWaiver) => void
  setAgentSessionPlannerModel: (sessionId: string, plannerModel: string) => void
  setAgentSessionSkills: (sessionId: string, mountedSkillIds: string[]) => void
  renameAgentSession: (sessionId: string, title: string) => void
  setAgentSessionReadingAnchor: (sessionId: string, messageId: string, updatedAt?: number) => void
  setActiveAgentSession: (sessionId: string) => void
  addAgentMemory: (
    kind: BotanicAgentMemoryKind,
    content: string,
    sourceNodeIds?: string[],
    options?: { subject?: BotanicAgentMemoryItem['subject']; subjectValue?: string },
  ) => string | null
  removeAgentMemory: (memoryId: string) => void
  resumeBatchVariations: () => void
  setAssetReferenceEnabled: (nodeId: string, referenceEnabled: boolean) => void
  setPrimaryProductReference: (nodeId: string) => void
  moveGenerationReference: (nodeId: string, direction: 'earlier' | 'later') => void
  applyGenerationRecipe: (recipe: GenerationRecipe) => void
  removeNodeFromCanvas: (nodeId: string) => void
  deleteAsset: (assetId: string) => void
  saveCurrentAsTemplate: (name: string) => void
  saveCurrentAsSharedTemplate: (name: string) => Promise<boolean>
  createCanvasFromTemplate: (templateId: string) => void
  createCanvasFromSharedTemplate: (templateId: string) => void
  createDocumentFromTemplate: (templateId: string, shared: boolean) => CanvasDocument | null
  refreshSharedTemplates: () => Promise<void>
  createCanvasFromHistory: (historyId: string) => void
  restoreHistoryVersion: (historyId: string) => void
  saveHistoryAsTemplate: (historyId: string) => void
  runGeneration: (input: { prompt: string; batchCount: number; settings: GenerationSettings; recipe?: GenerationRecipe; rootRecipe?: GenerationRecipe; taskLayout?: TaskFlowLayout; sourceGraphNodeId?: string; title?: string; agentRun?: { runId: string; branchId: string } }) => Promise<boolean>
  runRefinement: (input: { targetNodeId: string; prompt: string; batchCount: number; settings: GenerationSettings; recipe?: GenerationRecipe; rootRecipe?: GenerationRecipe; taskLayout?: TaskFlowLayout; sourceGraphNodeId?: string; title?: string; refinementMode?: RefinementMode; agentRun?: { runId: string; branchId: string } }) => Promise<boolean>
  cancelGeneration: () => void
  retryGeneration: () => Promise<boolean>
  retryMissingGeneration: (jobId: string) => Promise<boolean>
  clearGenerationError: () => void
  /** 清除画布级操作反馈；反馈由工作区统一展示，不再只写入 Store。 */
  clearAssistantMessage: () => void
  selectGenerationCandidate: (candidateId: string) => void
  undoLastAction: () => void
  createLocalDeliveries: (input: {
    targetNodeId: string
    presets: DeliveryPresetId[]
    title: string
    subtitle: string
    safeZone: boolean
  }) => void
}

export type PersistedGenerationState = Pick<
  CanvasStore,
  | 'assistantMessage'
  | 'generationStatus'
  | 'generationProgress'
  | 'generationError'
  | 'expectedCandidateCount'
  | 'generationCandidates'
  | 'lastGenerationRequest'
>
