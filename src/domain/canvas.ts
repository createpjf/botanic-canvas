import type { Edge, Node, Viewport } from '@xyflow/react'
import type { BotanicAgentMemoryItem, BotanicAgentRun, BotanicAgentSession } from './agent'

export type AssetRole = '商品' | '模特' | '场景' | '调性' | '首图'
export type AssetSource = 'brand' | 'upload' | 'generated'
export type GenerationKind = 'generation' | 'refinement'
/** 精修意图必须显式保存，避免“重跑”和“探索变体”在历史中失去语义。 */
export type RefinementMode = 'faithful' | 'explore'
export type GenerationMediaKind = 'image' | 'video'
export type VideoInputMode = 'first_frame' | 'first_last' | 'reference'
export type GenerationInputRole = 'first_frame' | 'last_frame' | 'reference_image' | 'reference_video'
export type DeliveryPresetId = 'taobao' | 'xiaohongshu' | 'douyin'
export type GenerationAspectRatio = '1:1' | '16:9' | '4:3' | '3:4' | '4:5' | '9:16'
// 模型列表由服务端健康检查下发；画布快照必须保留提交时实际使用的模型 ID。
export type GenerationModelId = string
export type GenerationResolution = '1K' | '2K'
export type GenerationTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
/**
 * 画布在服务端任务号尚未确认时的本地恢复状态。
 * 它不是 Provider 任务状态，不得持久化为 generation_jobs.status。
 */
export type CanvasGenerationTaskStatus = GenerationTaskStatus | 'uploading' | 'submission_unknown'

export type GenerationModelOption = {
  id: GenerationModelId
  label: string
  provider?: 'openai' | 'minimax'
  mediaKind?: GenerationMediaKind
  aspectRatios?: GenerationAspectRatio[]
  resolutions?: GenerationResolution[]
  durations?: number[]
  defaultDuration?: number
  /** gpt-image-2 允许在官方像素窗内自定义宽高；其它模型忽略。 */
  supportsCustomSize?: boolean
  /** 支持局部重绘蒙版（images/edits 的 mask 语义）；缺省视为不支持。 */
  supportsMask?: boolean
}

export const defaultGenerationModels: GenerationModelOption[] = [
  {
    id: 'gpt-image-2',
    label: 'GPT Image 2',
    provider: 'openai',
    mediaKind: 'image',
    aspectRatios: ['1:1', '16:9', '4:3', '3:4', '4:5', '9:16'],
    resolutions: ['1K', '2K'],
    supportsCustomSize: true,
    supportsMask: true,
  },
]

export type GenerationSettings = {
  model: GenerationModelId
  aspectRatio: GenerationAspectRatio
  resolution: GenerationResolution
  /** 仅视频模型使用；历史图片任务缺省该字段。 */
  duration?: number
  /** gpt-image-2 自定义输出宽，须与 outputHeight 同时出现。 */
  outputWidth?: number
  /** gpt-image-2 自定义输出高，须与 outputWidth 同时出现。 */
  outputHeight?: number
}

export type GenerationReference = {
  nodeId: string
  assetId: string
  name: string
  image: string
  role: AssetRole
  /** 视频模型专用；图片模型忽略。 */
  inputRole?: GenerationInputRole
  /** 历史素材缺省时按 image 处理。 */
  mediaKind?: GenerationMediaKind
  source?: AssetSource
  primary?: boolean
  priority?: number
}

export type GenerationRecipe = {
  primaryReferenceNodeId?: string
  references: GenerationReference[]
  prompt: string
  batchCount: number
  settings: GenerationSettings
  /** 仅视频生成节点使用；旧配方缺省时按输入数量推导。 */
  videoInputMode?: VideoInputMode
  /**
   * 局部重绘蒙版（PNG，透明区域=重绘、不透明区域=保持），与 images/edits 的 mask 语义一致。
   * 只对首个基准图（parent 或第一张参考）生效；仅支持 supportsMask 的图片模型。
   */
  maskImage?: string
}

export type AssetRecord = {
  id: string
  role: AssetRole
  name: string
  image: string
  imageWidth?: number
  imageHeight?: number
  source: AssetSource
  /** 历史素材缺省时按 image 处理。 */
  mediaKind?: GenerationMediaKind
  /** 文件夹上传保留的相对合集路径，例如「夏季 / 模特」。 */
  collection?: string
  tags: string[]
}

/**
 * 素材组属于单个项目：可以同时引用共享品牌素材和本项目私有素材，
 * 但不会把项目私有素材泄露到其他项目。上传文件夹会自动成为素材组。
 */
export type AssetGroup = {
  id: string
  name: string
  role: Exclude<AssetRole, '首图'>
  assetIds: string[]
  coverAssetId?: string
  createdAt: number
  updatedAt: number
}

/**
 * 全局素材库只保存内置/品牌素材。上传和生成资产始终归属创建它们的项目，
 * 从而避免不同项目的工作内容、历史和可删除资产相互污染。
 */
export const globalAssetLibraryId = 'global-brand-assets'
export const globalWorkflowTemplateLibraryId = 'global-workflow-templates'

export type GlobalAssetLibrary = {
  id: typeof globalAssetLibraryId
  schemaVersion: 1
  assets: AssetRecord[]
  updatedAt: number
}

export type UploadedAssetInput = {
  name: string
  image: string
  imageWidth?: number
  imageHeight?: number
  role: Exclude<AssetRole, '首图'>
  mediaKind?: GenerationMediaKind
  collection?: string
  tags: string[]
}

export type AssetNodeData = {
  kind: 'asset'
  assetId: string
  role: AssetRole
  name: string
  image: string
  imageWidth?: number
  imageHeight?: number
  source?: AssetSource
  /** 历史画布节点缺省时按 image 处理。 */
  mediaKind?: GenerationMediaKind
  locked?: boolean
  referenceEnabled?: boolean
  primary?: boolean
  referencePriority?: number
  deleted?: boolean
}

export type PromptNodeData = {
  kind: 'prompt'
  jobId?: string
  status: CanvasGenerationTaskStatus
  generationKind: GenerationKind
  prompt: string
  batchCount: number
  settings: GenerationSettings
  label: string
  error?: string
}

export type ReferenceGroupNodeData = {
  kind: 'reference'
  jobId?: string
  status: CanvasGenerationTaskStatus
  recipe: GenerationRecipe
  label: string
  error?: string
}

export type TextNodeData = {
  kind: 'text'
  label: string
  content: string
}

export type GenerateNodeData = {
  kind: 'generate'
  label: string
  prompt: string
  batchCount: number
  settings: GenerationSettings
  /** 输入连线的展示与提交顺序；生成节点是唯一的配方拥有者。 */
  inputOrder?: string[]
  /** 当前生成节点中被锁定为主体的商品素材节点。 */
  primaryInputId?: string
  jobId?: string
  status?: CanvasGenerationTaskStatus
  generationKind?: GenerationKind
  refinementMode?: RefinementMode
  videoInputMode?: VideoInputMode
  /** 提交超时后用原键查询/接管，不得换键重复生成。 */
  submissionKey?: string
  /** 未拿到 jobId 前仍需保留 Agent 分支归属。 */
  agentRun?: { runId: string; branchId: string }
  error?: string
}

export type ResultNodeData = {
  kind: 'result'
  /** 自动写入这张输出图片的生成节点；仅用于溯源与展示。 */
  outputOf?: string
  image?: string
  /** 历史项目缺省时按 image 处理。 */
  mediaKind?: GenerationMediaKind
  selected?: boolean
  status: 'ready' | 'generating' | 'failed' | 'cancelled'
  /** 真实任务状态；结果节点据此展示可解释的生成反馈，不伪造百分比。 */
  taskStatus?: CanvasGenerationTaskStatus
  /** 本次任务写入画布的时间，用于提示等待时长。 */
  submittedAt?: number
  label?: string
  jobId?: string
  /** 同一批生成的占位结果共用该任务锚点，完成后各自替换为独立输出。 */
  taskGroupId?: string
  taskNodeId?: string
  /** 提交状态未知时的持久化恢复键。 */
  submissionKey?: string
  agentRun?: { runId: string; branchId: string }
  error?: string
  candidateId?: string
  versionId?: string
  parentVersionId?: string
  generationKind?: GenerationKind
  refinementMode?: RefinementMode
  refinementInstruction?: string
  generationSettings?: GenerationSettings
  /** 首次首图任务的不可变配方；精修结果仍用它来“原配方重做”。 */
  rootRecipe?: GenerationRecipe
  generationRecipe?: GenerationRecipe
  variant?: number
}

export type CanvasNode = Node<
  AssetNodeData | PromptNodeData | ReferenceGroupNodeData | ResultNodeData | TextNodeData | GenerateNodeData,
  'asset' | 'prompt' | 'reference' | 'result' | 'text' | 'generate'
>

export type CanvasSnapshot = {
  name: string
  nodes: CanvasNode[]
  edges: Edge[]
  viewport: Viewport
}

export type CanvasTemplate = {
  id: string
  name: string
  image: string
  createdAt: number
  sourceHistoryId?: string
  snapshot: CanvasSnapshot
}

/**
 * 工作流模板属于整个工作区。模板只应引用共享品牌素材；项目私有上传和生成图
 * 会在发布到共享库前被移除，避免跨项目泄露或失效引用。
 */
export type GlobalWorkflowTemplateLibrary = {
  id: typeof globalWorkflowTemplateLibraryId
  schemaVersion: 1
  templates: CanvasTemplate[]
  updatedAt: number
}

export type CanvasHistoryEntry = {
  id: string
  name: string
  image: string
  createdAt: number
  kind: 'generation' | 'template' | 'refinement'
  parentVersionId?: string
  sourceTemplateId?: string
  sourceNodeId?: string
  refinementInstruction?: string
  generationRecipe?: GenerationRecipe
  rootRecipe?: GenerationRecipe
  snapshot: CanvasSnapshot
}

export type GenerationCandidate = {
  id: string
  name: string
  image: string
  mediaKind?: GenerationMediaKind
  variant: number
  prompt: string
  createdAt: number
  kind: GenerationKind
  parentVersionId?: string
  parentNodeId?: string
  parentImage?: string
  parentLabel?: string
  sourceAssetNames?: string[]
  refinementInstruction?: string
  refinementMode?: RefinementMode
  settings: GenerationSettings
  recipe: GenerationRecipe
  rootRecipe?: GenerationRecipe
  jobId?: string
  resultNodeId?: string
  provider?: string
  revisedPrompt?: string
  selected?: boolean
}

export type GenerationOutput = {
  id: string
  image: string
  mediaKind?: GenerationMediaKind
  revisedPrompt?: string
}

/** 父生成任务下的独立候选子任务；每个候选可单独观察、失败和重试。 */
export type GenerationVariantStatus = 'queued' | 'running' | 'succeeded' | 'failed'

export type GenerationVariant = {
  index: number
  status: GenerationVariantStatus
  output?: GenerationOutput
  error?: string
  startedAt?: number
  completedAt?: number
}

export type GenerationJob = {
  id: string
  status: GenerationTaskStatus
  kind: GenerationKind
  refinementMode?: RefinementMode
  createdAt: number
  updatedAt: number
  batchCount: number
  outputCount: number
  provider: string
  model: GenerationModelId
  error?: string
  /** 供应商返回不足时任务仍可部分完成；缺口可单独补生成。 */
  missingOutputCount?: number
  partialError?: string
  outputs?: GenerationOutput[]
  variants?: GenerationVariant[]
  /** 用户从画布移除的候选，服务端任务记录保留，但不应在下次恢复时复活。 */
  dismissedOutputIds?: string[]
  /** 浏览器或 Worker 回写画布失败时保留的可恢复标记。 */
  idempotencyKey?: string
  projectWritebackPending?: boolean
  projectWritebackAttempts?: number
  projectWritebackError?: string
  projectWritebackUpdatedAt?: number
  /** 统一图谱中的生成节点；旧字段仅用于迁移历史快照。 */
  generateNodeId?: string
  promptNodeId?: string
  referenceNodeId?: string
  resultNodeId?: string
  parentNodeId?: string
  agentRun?: { runId: string; branchId: string }
}

export type BatchVariationItemStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export type BatchVariationItem = {
  id: string
  assetId: string
  assetName: string
  status: BatchVariationItemStatus
  generateNodeId?: string
  jobId?: string
  error?: string
  agentBranchId?: string
}

/** 一次素材组批量变体会拆成可独立恢复、重试和追溯的子任务。 */
export type BatchVariationRun = {
  id: string
  sourceResultNodeId: string
  groupId: string
  groupName: string
  variableRole: AssetGroup['role']
  prompt: string
  candidatesPerAsset: number
  settings: GenerationSettings
  status: 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled'
  items: BatchVariationItem[]
  createdAt: number
  updatedAt: number
  agentRunId?: string
}

export type DeliveryArtifact = {
  id: string
  targetNodeId: string
  targetVersionId?: string
  targetLabel: string
  image: string
  presetId: DeliveryPresetId
  title: string
  subtitle: string
  safeZone: boolean
  createdAt: number
}

export type ProductionWorkflowDefinition = {
  prompt: string
  model: string
  settings: Record<string, unknown>
  output: Record<string, unknown>
  brandRules: string[]
  assetGroupIds: string[]
  confirmationPolicy: string
  recipe?: Record<string, unknown>
}

export type ProductionWorkflowVersion = {
  version: number
  definition: ProductionWorkflowDefinition
  createdAt: number
  createdBy: string
}

/** 发布后只追加版本；历史运行始终固定到当时的版本快照。 */
export type ProductionWorkflow = {
  id: string
  projectId: string
  name: string
  currentVersion: number
  versions: ProductionWorkflowVersion[]
  createdAt: number
  createdBy: string
  updatedAt: number
  updatedBy: string
}

export type ProductionWorkflowRunItem = {
  id: string
  index: number
  input: Record<string, unknown>
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  attempt: number
  idempotencyKey: string
  jobId?: string
  artifactIds?: string[]
  canvasNodeIds?: string[]
  error?: { code: string; message: string }
  updatedAt: number
  completedAt?: number
}

export type ProductionWorkflowRun = {
  id: string
  workflowId: string
  workflowVersion: number
  projectId: string
  definition: ProductionWorkflowDefinition
  status: 'queued' | 'running' | 'paused' | 'succeeded' | 'partially_failed' | 'failed' | 'cancelled'
  items: ProductionWorkflowRunItem[]
  createdAt: number
  createdBy: string
  updatedAt: number
  startedAt?: number
  completedAt?: number
}

export type CanvasDocument = {
  schemaVersion: 25
  id: string
  name: string
  nodes: CanvasNode[]
  edges: Edge[]
  viewport: Viewport
  /** 当前项目私有的上传/生成素材；全局品牌素材位于 GlobalAssetLibrary。 */
  assets: AssetRecord[]
  assetGroups: AssetGroup[]
  templates: CanvasTemplate[]
  history: CanvasHistoryEntry[]
  deliveries: DeliveryArtifact[]
  generationJobs: GenerationJob[]
  batchVariationRuns: BatchVariationRun[]
  /** 已确认或执行中的 Agent 计划；随项目画布恢复，避免刷新丢失上下文。 */
  agentRuns: BotanicAgentRun[]
  /** Agent 对话与引用的画布上下文；与项目隔离并随画布文档持久化。 */
  agentSessions: BotanicAgentSession[]
  /** 当前项目批准的创作规则、视觉方向与禁用项；不会跨项目自动共享。 */
  agentMemory: BotanicAgentMemoryItem[]
  /** 生产工作流是项目级版本目录；生成任务与 Artifact 仍是执行结果权威。 */
  productionWorkflows?: ProductionWorkflow[]
  productionWorkflowRuns?: ProductionWorkflowRun[]
  activeAgentSessionId?: string
  activeTemplateId?: string
  activeVersionId?: string
  updatedAt: number
}
