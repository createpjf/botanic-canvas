import type {
  CanvasDocument,
  GenerateNodeData,
  ProductionWorkflowApprovalDecision,
  ProductionWorkflowDefinition,
  ProductionWorkflowNodeRun,
  ProductionWorkflowRun,
  ProductionWorkflowValidationReport,
} from './canvas.ts'
import { buildGraphGenerationRecipe } from './generationRecipe.ts'

export type ProductionWorkflowDraft = {
  sourceNodeId: string
  sourceAgentRunId?: string
  name: string
  definition: ProductionWorkflowDefinition
}

export type MarketingExecutionMode = 'fixture' | 'provider'

export type MarketingWorkflowNodeStatus = 'idle' | 'queued' | 'running' | 'completed' | 'failed' | 'awaiting_approval' | 'blocked'

export type MarketingWorkflowRunProjection = {
  status: 'waiting_copy' | 'running' | 'completed' | 'failed' | 'cancelled'
  phase: 'copy-review' | 'poster' | 'review' | 'variants' | 'delivery' | 'completed' | 'failed'
  copyApproved: boolean
  copyRejected: boolean
  currentNodeId?: string
  completedNodeIds: string[]
  nodeStatuses: Record<string, MarketingWorkflowNodeStatus>
  nodeRuns: ProductionWorkflowNodeRun[]
  approvals: ProductionWorkflowApprovalDecision[]
  validationReports: ProductionWorkflowValidationReport[]
  validationPassed: boolean
  deliveryRunnable: boolean
  executionMode?: MarketingExecutionMode
}

const campaignKitGenerationNodeIds = ['poster', 'variant-4-5', 'variant-3-4', 'variant-9-16'] as const

export function marketingPlanWorkflowId(messageId: string) {
  return `marketing-plan-${messageId}`
}

export function marketingPlanRunId(messageId: string) {
  return `marketing-run-${messageId}`
}

export function attachCampaignKitGraph(definition: ProductionWorkflowDefinition): ProductionWorkflowDefinition {
  if (definition.graph?.nodes?.length) return definition
  return {
    ...definition,
    graph: {
      nodes: [
        { id: 'copy', kind: 'content', label: '文案', dependencies: [] },
        { id: 'copy-approval', kind: 'approval', label: '文案审批', dependencies: ['copy'] },
        { id: 'poster', kind: 'generation', label: '主视觉', dependencies: ['copy-approval'] },
        { id: 'poster-qa', kind: 'validation', label: '品牌预检', dependencies: ['poster'] },
        { id: 'variant-4-5', kind: 'generation', label: '4:5 变体', dependencies: ['poster-qa'], parentSourceNodeId: 'poster' },
        { id: 'variant-3-4', kind: 'generation', label: '3:4 变体', dependencies: ['poster-qa'], parentSourceNodeId: 'poster' },
        { id: 'variant-9-16', kind: 'generation', label: '9:16 变体', dependencies: ['poster-qa'], parentSourceNodeId: 'poster' },
        { id: 'delivery', kind: 'delivery', label: '交付', dependencies: ['variant-4-5', 'variant-3-4', 'variant-9-16'] },
      ],
    },
  }
}

function statusFor(status?: ProductionWorkflowNodeRun['status']): MarketingWorkflowNodeStatus {
  if (status === 'succeeded') return 'completed'
  if (status === 'failed' || status === 'cancelled') return 'failed'
  if (status === 'running') return 'running'
  if (status === 'queued') return 'queued'
  if (status === 'awaiting_approval') return 'awaiting_approval'
  if (status === 'blocked') return 'blocked'
  return 'idle'
}

export function isDeliveryNodeRunnable(run: ProductionWorkflowRun) {
  const nodeRuns = run.items[0]?.nodeRuns ?? []
  const approval = nodeRuns.find((item) => item.kind === 'approval')
  const validations = nodeRuns.filter((item) => item.kind === 'validation')
  const delivery = nodeRuns.find((item) => item.kind === 'delivery')
  if (!delivery) return false
  if (approval && approval.status !== 'succeeded') return false
  if (validations.some((item) => item.status !== 'succeeded')) return false
  return delivery.status === 'queued' || delivery.status === 'succeeded'
}

/** 把服务端 NodeRun / 审批 / QA 投影为 Agent 面板视图；UI 不再自行推演整链状态。 */
export function marketingWorkflowRunProjection(run: ProductionWorkflowRun): MarketingWorkflowRunProjection | undefined {
  const item = run.items[0]
  if (!run.definition.graph || !item?.nodeRuns?.length) return undefined
  const nodeRuns = item.nodeRuns
  const approval = nodeRuns.find((entry) => entry.kind === 'approval')
  const validation = nodeRuns.find((entry) => entry.kind === 'validation')
  const delivery = nodeRuns.find((entry) => entry.kind === 'delivery')
  const generationNodes = nodeRuns.filter((entry) => entry.kind === 'generation')
  const rootGeneration = generationNodes.find((entry) => !run.definition.graph?.nodes.find((node) => node.id === entry.nodeId)?.parentSourceNodeId)
    ?? generationNodes[0]
  const variantNodes = generationNodes.filter((entry) => entry.nodeId !== rootGeneration?.nodeId)
  const nodeStatuses = Object.fromEntries(nodeRuns.map((entry) => [entry.nodeId, statusFor(entry.status)]))
  const completedNodeIds = nodeRuns.filter((entry) => entry.status === 'succeeded').map((entry) => entry.nodeId)
  const current = nodeRuns.find((entry) => ['awaiting_approval', 'running', 'queued'].includes(entry.status))
  const copyRejected = approval?.status === 'failed'
  const copyApproved = approval?.status === 'succeeded'
  const validationPassed = validation?.status === 'succeeded'
  const deliveryRunnable = isDeliveryNodeRunnable(run) && copyApproved && validationPassed && delivery?.status !== 'failed'
  let phase: MarketingWorkflowRunProjection['phase'] = 'copy-review'
  if (copyRejected || run.status === 'failed' || delivery?.status === 'failed') phase = 'failed'
  else if (delivery?.status === 'succeeded' && run.status === 'succeeded') phase = 'completed'
  else if (deliveryRunnable || delivery?.status === 'queued' || delivery?.status === 'running') phase = 'delivery'
  else if (variantNodes.some((entry) => ['queued', 'running', 'succeeded'].includes(entry.status)) && !variantNodes.every((entry) => entry.status === 'succeeded')) phase = 'variants'
  else if (validation && ['queued', 'running', 'failed'].includes(validation.status)) phase = 'review'
  else if (rootGeneration && ['queued', 'running', 'succeeded'].includes(rootGeneration.status) && !validationPassed) phase = 'poster'
  else if (copyApproved) phase = 'poster'
  let status: MarketingWorkflowRunProjection['status'] = 'running'
  if (run.status === 'cancelled') status = 'cancelled'
  else if (phase === 'failed' || run.status === 'failed') status = 'failed'
  else if (phase === 'completed') status = 'completed'
  else if (!copyApproved && !copyRejected) status = 'waiting_copy'
  const executionMode = item.input?.executionMode === 'fixture' || item.input?.executionMode === 'provider'
    ? item.input.executionMode
    : undefined
  return {
    status,
    phase,
    copyApproved,
    copyRejected,
    currentNodeId: current?.nodeId,
    completedNodeIds,
    nodeStatuses,
    nodeRuns,
    approvals: run.approvals ?? [],
    validationReports: run.validationReports ?? [],
    validationPassed,
    deliveryRunnable,
    executionMode,
  }
}

function hasStableMedia(recipe?: Record<string, unknown>) {
  const references = Array.isArray(recipe?.references) ? recipe.references as Array<Record<string, unknown>> : []
  return references.some((reference) => {
    const mediaId = typeof reference.mediaId === 'string' ? reference.mediaId : ''
    const image = typeof reference.image === 'string' ? reference.image : ''
    return /^media_[A-Za-z0-9_-]+$/.test(mediaId) || /\/api\/media\//.test(mediaId || image)
  })
}

export function projectFixtureAssets(document: Pick<CanvasDocument, 'assets'>) {
  return document.assets.filter((asset) => Boolean(asset.image) && asset.source !== 'brand')
}

export function resolveMarketingExecutionMode(input: {
  recipe?: Record<string, unknown>
  fixtureAssets: Array<{ id: string; image?: string }>
}): MarketingExecutionMode {
  if (hasStableMedia(input.recipe)) return 'provider'
  if (input.fixtureAssets.length) return 'fixture'
  return 'provider'
}

export function marketingWorkflowRunItems(input: {
  mode: MarketingExecutionMode
  copyText: string
  fixtureAssetIds?: string[]
  generationNodeIds?: string[]
}) {
  const ids = input.generationNodeIds ?? [...campaignKitGenerationNodeIds]
  return ids.map((id) => ({
    id,
    copyText: input.copyText,
    executionMode: input.mode,
    ...(input.mode === 'fixture' && input.fixtureAssetIds?.length ? { fixtureAssetIds: input.fixtureAssetIds } : {}),
  }))
}

function recipeWithoutBytes(recipe?: Record<string, unknown>) {
  if (!recipe) return undefined
  const next = { ...recipe }
  if (Array.isArray(next.references)) {
    next.references = next.references.map((value) => {
      const reference = { ...(value as Record<string, unknown>) }
      delete reference.image
      return reference
    })
  }
  return next
}

export function marketingPlanWorkflowDraft(input: {
  messageId: string
  plan: {
    prompt: string
    summary: string
    settings: { model: string; aspectRatio: string; resolution: string; duration?: number }
    output: { count: number }
    rootRecipe?: Record<string, unknown>
    assetGroupId?: string
  }
  document: CanvasDocument
}): ProductionWorkflowDraft {
  const canvasDraft = productionWorkflowDraftFromCanvas(input.document)
  const recipe = recipeWithoutBytes(input.plan.rootRecipe) ?? canvasDraft?.definition.recipe
  return {
    sourceNodeId: canvasDraft?.sourceNodeId ?? input.messageId,
    sourceAgentRunId: canvasDraft?.sourceAgentRunId,
    name: `${input.plan.summary || '营销生产链'} · 发布`,
    definition: attachCampaignKitGraph({
      prompt: input.plan.prompt,
      model: input.plan.settings.model,
      settings: { ...input.plan.settings, batchCount: input.plan.output.count },
      output: {
        aspectRatio: input.plan.settings.aspectRatio,
        resolution: input.plan.settings.resolution,
        ...(input.plan.settings.duration ? { duration: input.plan.settings.duration } : {}),
        candidates: input.plan.output.count,
      },
      brandRules: input.document.agentMemory
        .filter((item) => item.kind === 'rule' || item.kind === 'avoid')
        .map((item) => item.content),
      assetGroupIds: [
        ...new Set([
          ...(canvasDraft?.definition.assetGroupIds ?? []),
          ...(input.plan.assetGroupId ? [input.plan.assetGroupId] : []),
        ]),
      ],
      confirmationPolicy: 'before-submit',
      recipe,
    }),
  }
}

/**
 * 只把已经落在画布中的生成操作提升为生产工作流。定义保留引用身份，
 * 不复制图片字节或临时 URL；服务端在运行时从项目权威文档解析稳定媒体。
 */
export function productionWorkflowDraftFromCanvas(
  document: CanvasDocument,
  preferredGenerateNodeId?: string,
): ProductionWorkflowDraft | null {
  const generateNodes = document.nodes.filter((node) => node.type === 'generate')
  const orderedNodes = preferredGenerateNodeId
    ? [...generateNodes.filter((node) => node.id === preferredGenerateNodeId), ...generateNodes.filter((node) => node.id !== preferredGenerateNodeId)]
    : generateNodes
  for (const node of orderedNodes) {
    const graph = buildGraphGenerationRecipe(document, node.id)
    const data = node.data as GenerateNodeData
    if (!graph?.prompt.trim() || !graph.recipe.references.length) continue
    const sourceRun = data.agentRun
      ? document.agentRuns.find((run) => run.id === data.agentRun?.runId && ['completed', 'partial'].includes(run.status))
      : undefined
    if (data.agentRun && !sourceRun) continue
    const referenceAssetIds = new Set(graph.recipe.references.map((reference) => reference.assetId))
    const assetGroupIds = document.assetGroups
      .filter((group) => group.assetIds.some((assetId) => referenceAssetIds.has(assetId)))
      .map((group) => group.id)
    const recipe = {
      ...graph.recipe,
      references: graph.recipe.references.map(({ image: _image, ...reference }) => reference),
      ...(sourceRun ? { sourceAgentRunId: sourceRun.id } : {}),
    }
    return {
      sourceNodeId: node.id,
      sourceAgentRunId: sourceRun?.id,
      name: `${data.label || '生产工作流'} · 自动化`,
      definition: {
        prompt: graph.prompt,
        model: data.settings.model,
        settings: { ...data.settings, batchCount: data.batchCount },
        output: {
          aspectRatio: data.settings.aspectRatio,
          resolution: data.settings.resolution,
          ...(data.settings.duration ? { duration: data.settings.duration } : {}),
          candidates: data.batchCount,
        },
        brandRules: document.agentMemory.map((item) => item.content),
        assetGroupIds,
        confirmationPolicy: 'before-submit',
        recipe,
      },
    }
  }
  return null
}
