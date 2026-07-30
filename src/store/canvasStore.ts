import { create } from 'zustand'
import type { Edge, Viewport, XYPosition } from '@xyflow/react'
import { createEmptyCanvasDocument, seedDocument, seedGlobalAssets } from '../data/seed'
import { defaultGenerationModels } from '../domain/canvas'
import type {
  AssetRecord,
  AssetNodeData,
  CanvasDocument,
  CanvasHistoryEntry,
  CanvasNode,
  CanvasSnapshot,
  CanvasTemplate,
  DeliveryArtifact,
  DeliveryPresetId,
  GenerationCandidate,
  GenerationJob,
  GenerationModelOption,
  GenerationRecipe,
  GenerationReference,
  GenerationSettings,
  GenerateNodeData,
  PromptNodeData,
  ReferenceGroupNodeData,
  ResultNodeData,
  TextNodeData,
  UploadedAssetInput,
} from '../domain/canvas'
import {
  deleteGlobalAssetAndScrubDocuments,
  ensureGlobalAssetLibrary,
  readCanvasDocument,
  writeCanvasDocument,
} from '../lib/db'
import { assertGenerationServiceReady, cancelGenerationJob, GenerationApiError, getGenerationJob, submitGenerationJob } from '../lib/generationApi'

type GenerationStatus = 'idle' | 'uploading' | 'queued' | 'running' | 'error'
type PersistenceStatus = 'saved' | 'saving' | 'error'

type TaskNodeIds = {
  generateNodeId: string
  resultNodeId: string
}

type TaskFlowLayout = {
  generate: XYPosition
  result: XYPosition
}

type GenerationRequest = {
  kind: 'generation' | 'refinement'
  prompt: string
  batchCount: number
  settings: GenerationSettings
  recipe?: GenerationRecipe
  rootRecipe?: GenerationRecipe
  targetNodeId?: string
  parentVersionId?: string
  parentImage?: string
  parentLabel?: string
  jobId?: string
  taskNodeIds?: TaskNodeIds
  taskLayout?: TaskFlowLayout
  sourceGraphNodeId?: string
}

type GenerateBranchDraft = {
  prompt?: string
  batchCount?: number
  settings?: Partial<GenerationSettings>
}

type UndoAction = {
  id: string
  label: string
}

let generationPollTimerId: number | null = null
let generationPollRunId = 0
let generationSubmissionRunId = 0
let undoTimerId: number | null = null
let persistenceRunId = 0
/** 当前会话中正在删除或已删除的全局品牌素材，阻止异步任务用旧快照回写引用。 */
const revokedGlobalAssetIds = new Set<string>()

type CanvasStore = {
  document: CanvasDocument
  /** 跨项目共享的内置/品牌素材；项目上传与生成资产只保存在 document.assets。 */
  globalAssets: AssetRecord[]
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
  renameDocument: (name: string) => void
  setNodes: (nodes: CanvasNode[]) => void
  setEdges: (edges: Edge[]) => void
  setViewport: (viewport: Viewport) => void
  selectNode: (nodeId: string | null) => void
  addAssetToCanvas: (assetId: string, position?: XYPosition) => void
  addUploadedAssets: (assets: UploadedAssetInput[]) => void
  addUploadedAssetsToCanvas: (assets: UploadedAssetInput[], position?: XYPosition) => void
  addTextNode: (position?: XYPosition) => void
  addGenerateNode: (position?: XYPosition) => void
  createGenerateBranchFromResult: (resultNodeId: string, draft?: GenerateBranchDraft) => string | null
  createGenerateFromResultRecipe: (resultNodeId: string) => string | null
  renameCanvasNode: (nodeId: string, label: string) => void
  updateTextNode: (nodeId: string, content: string) => void
  updateGenerateNode: (nodeId: string, patch: Partial<Pick<GenerateNodeData, 'label' | 'prompt' | 'batchCount' | 'settings'>>) => void
  setGenerateNodePrimaryInput: (nodeId: string, assetNodeId: string) => void
  moveGenerateNodeInput: (nodeId: string, inputNodeId: string, direction: 'earlier' | 'later') => void
  setAvailableModels: (models: GenerationModelOption[]) => void
  setMaximumBatchCount: (count: number) => void
  runGraphGeneration: (nodeId: string) => Promise<boolean>
  setAssetReferenceEnabled: (nodeId: string, referenceEnabled: boolean) => void
  setPrimaryProductReference: (nodeId: string) => void
  moveGenerationReference: (nodeId: string, direction: 'earlier' | 'later') => void
  applyGenerationRecipe: (recipe: GenerationRecipe) => void
  removeNodeFromCanvas: (nodeId: string) => void
  deleteAsset: (assetId: string) => void
  saveCurrentAsTemplate: (name: string) => void
  createCanvasFromTemplate: (templateId: string) => void
  createCanvasFromHistory: (historyId: string) => void
  restoreHistoryVersion: (historyId: string) => void
  saveHistoryAsTemplate: (historyId: string) => void
  runGeneration: (input: { prompt: string; batchCount: number; settings: GenerationSettings; recipe?: GenerationRecipe; rootRecipe?: GenerationRecipe; taskLayout?: TaskFlowLayout; sourceGraphNodeId?: string }) => Promise<boolean>
  runRefinement: (input: { targetNodeId: string; prompt: string; batchCount: number; settings: GenerationSettings; recipe?: GenerationRecipe; rootRecipe?: GenerationRecipe; taskLayout?: TaskFlowLayout; sourceGraphNodeId?: string }) => Promise<boolean>
  cancelGeneration: () => void
  retryGeneration: () => Promise<boolean>
  clearGenerationError: () => void
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

type PersistedGenerationState = Pick<
  CanvasStore,
  | 'assistantMessage'
  | 'generationStatus'
  | 'generationProgress'
  | 'generationError'
  | 'expectedCandidateCount'
  | 'generationCandidates'
  | 'lastGenerationRequest'
>

function cloneNodes(nodes: CanvasNode[]) {
  return nodes.map((node) => {
    const data = node.type === 'result'
      ? {
          ...node.data,
          generationSettings: (node.data as ResultNodeData).generationSettings
            ? cloneGenerationSettings((node.data as ResultNodeData).generationSettings!)
            : undefined,
          generationRecipe: (node.data as ResultNodeData).generationRecipe
            ? cloneGenerationRecipe((node.data as ResultNodeData).generationRecipe!)
            : undefined,
          rootRecipe: (node.data as ResultNodeData).rootRecipe
            ? cloneGenerationRecipe((node.data as ResultNodeData).rootRecipe!)
            : undefined,
        }
      : node.type === 'prompt'
        ? {
            ...node.data,
            settings: cloneGenerationSettings((node.data as PromptNodeData).settings),
          }
      : node.type === 'reference'
          ? {
              ...node.data,
              recipe: cloneGenerationRecipe((node.data as ReferenceGroupNodeData).recipe),
            }
          : node.type === 'generate'
            ? {
                ...node.data,
                settings: cloneGenerationSettings((node.data as GenerateNodeData).settings),
                inputOrder: (node.data as GenerateNodeData).inputOrder ? [...(node.data as GenerateNodeData).inputOrder!] : undefined,
              }
          : { ...node.data }
    return {
      ...node,
      position: { ...node.position },
      data,
    }
  }) as CanvasNode[]
}

function cloneEdges(edges: Edge[]) {
  return edges.map((edge) => ({ ...edge, style: edge.style ? { ...edge.style } : undefined }))
}

function normalizeSystemOutputEdges(nodes: CanvasNode[], edges: Edge[]): Edge[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  return edges.map((edge) => {
    const source = nodeById.get(edge.source)
    const target = nodeById.get(edge.target)
    if (source?.type !== 'generate' || target?.type !== 'result') return edge
    return {
      ...edge,
      sourceHandle: 'output',
      targetHandle: 'input',
      data: { ...(edge.data ?? {}), system: true, role: 'output' },
      reconnectable: false,
    }
  })
}

function snapshot(document: CanvasDocument, name = document.name): CanvasSnapshot {
  return {
    name,
    nodes: cloneNodes(document.nodes),
    edges: cloneEdges(document.edges),
    viewport: { ...document.viewport },
  }
}

function snapshotThumbnail(nodes: CanvasNode[], fallback: string) {
  const result = [...nodes].reverse().find((node) => node.type === 'result')
  return result ? (result.data as ResultNodeData).image ?? fallback : fallback
}

function clampBatchCount(value: number) {
  return Math.max(1, Math.round(value) || 1)
}

function cloneGenerationSettings(settings: Partial<GenerationSettings> | undefined): GenerationSettings {
  return {
    model: typeof settings?.model === 'string' && settings.model.trim() ? settings.model : 'gpt-image-2',
    aspectRatio: settings?.aspectRatio === '1:1' || settings?.aspectRatio === '3:4' || settings?.aspectRatio === '4:5' || settings?.aspectRatio === '9:16'
      ? settings.aspectRatio
      : '3:4',
    resolution: settings?.resolution === '1K' || settings?.resolution === '2K'
      ? settings.resolution
      : '2K',
  }
}

function cloneGenerationRecipe(recipe: GenerationRecipe): GenerationRecipe {
  return {
    ...recipe,
    settings: cloneGenerationSettings(recipe.settings),
    references: recipe.references.map((reference) => ({ ...reference })),
  }
}

/** 素材库展示与画布入库均使用「全局品牌 + 当前项目私有」的只读合并视图。 */
function availableAssets(document: CanvasDocument, globalAssets: AssetRecord[]) {
  const ids = new Set<string>()
  return [...globalAssets, ...document.assets]
    .filter((asset) => {
      if (ids.has(asset.id)) return false
      ids.add(asset.id)
      return true
    })
}

function findAvailableAsset(document: CanvasDocument, globalAssets: AssetRecord[], assetId: string) {
  return availableAssets(document, globalAssets).find((asset) => asset.id === assetId)
}

function isGenerateInputNode(node: CanvasNode | undefined): node is CanvasNode {
  return Boolean(node && (node.type === 'asset' || node.type === 'text' || node.type === 'result'))
}

function normalizeGenerateNodeInputs(nodes: CanvasNode[], edges: Edge[]): CanvasNode[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  return nodes.map((node) => {
    if (node.type !== 'generate') return node
    const data = node.data as GenerateNodeData
    const connectedIds = [...new Set(edges
      .filter((edge) => edge.target === node.id)
      .map((edge) => edge.source)
      .filter((sourceId) => isGenerateInputNode(nodeById.get(sourceId))))]
    const previousOrder = data.inputOrder ?? []
    const inputOrder = [
      ...previousOrder.filter((inputId) => connectedIds.includes(inputId)),
      ...connectedIds.filter((inputId) => !previousOrder.includes(inputId)),
    ]
    const connectedAssets = inputOrder
      .map((inputId) => nodeById.get(inputId))
      .filter((input): input is CanvasNode => input?.type === 'asset')
    const currentPrimary = connectedAssets.find((input) => input.id === data.primaryInputId)
    const legacyPrimary = connectedAssets.find((input) => {
      const asset = input.data as AssetNodeData
      return Boolean(asset.primary)
    })
    // 任何图片都可以是主参考，避免上传角色误标时阻断生成。
    const fallbackPrimary = connectedAssets[0]
    const primaryInputId = (currentPrimary ?? legacyPrimary ?? fallbackPrimary)?.id
    return {
      ...node,
      data: {
        ...data,
        inputOrder,
        primaryInputId,
      },
    }
  }) as CanvasNode[]
}

function connectedGenerateInputs(document: CanvasDocument, generateNodeId: string) {
  const generateNode = document.nodes.find((node) => node.id === generateNodeId && node.type === 'generate')
  if (!generateNode || generateNode.type !== 'generate') return []
  const data = generateNode.data as GenerateNodeData
  const nodeById = new Map(document.nodes.map((node) => [node.id, node]))
  const connectedIds = [...new Set(document.edges
    .filter((edge) => edge.target === generateNodeId)
    .map((edge) => edge.source)
    .filter((sourceId) => isGenerateInputNode(nodeById.get(sourceId))))]
  const inputOrder = [
    ...(data.inputOrder ?? []).filter((inputId) => connectedIds.includes(inputId)),
    ...connectedIds.filter((inputId) => !(data.inputOrder ?? []).includes(inputId)),
  ]
  return inputOrder
    .map((inputId) => nodeById.get(inputId))
    .filter((node): node is CanvasNode => Boolean(node))
}

function withoutReference(recipe: GenerationRecipe, assetId: string): GenerationRecipe {
  const references = recipe.references.filter((reference) => reference.assetId !== assetId)
  const primary = references.find((reference) => reference.nodeId === recipe.primaryReferenceNodeId && reference.role === '商品')
    ?? references.find((reference) => reference.role === '商品' && reference.primary)
    ?? references.find((reference) => reference.role === '商品')
  return {
    ...cloneGenerationRecipe(recipe),
    primaryReferenceNodeId: primary?.nodeId,
    references: references.map((reference, index) => ({
      ...reference,
      primary: reference.nodeId === primary?.nodeId,
      priority: index + 1,
    })),
  }
}

function scrubDeletedAssetFromNodes(nodes: CanvasNode[], assetId: string): CanvasNode[] {
  return nodes.map((node) => {
    if (node.type === 'result') {
      const result = node.data as ResultNodeData
      return {
        ...node,
        data: {
          ...result,
          generationRecipe: result.generationRecipe ? withoutReference(result.generationRecipe, assetId) : undefined,
          rootRecipe: result.rootRecipe ? withoutReference(result.rootRecipe, assetId) : undefined,
        },
      }
    }
    if (node.type === 'reference') {
      const reference = node.data as ReferenceGroupNodeData
      return { ...node, data: { ...reference, recipe: withoutReference(reference.recipe, assetId) } }
    }
    return node
  }) as CanvasNode[]
}

function scrubDeletedAssetFromSnapshot(snapshotValue: CanvasSnapshot, assetId: string): CanvasSnapshot {
  const withoutNode = withoutAsset(snapshotValue, assetId)
  return { ...withoutNode, nodes: scrubDeletedAssetFromNodes(withoutNode.nodes, assetId) }
}

/** 从单个项目中撤销一个素材及其后续可复用引用；视觉结果和历史条目仍保留。 */
function scrubAssetFromDocument(document: CanvasDocument, assetId: string): CanvasDocument {
  const remainingNodes = document.nodes.filter((node) => node.type !== 'asset' || (node.data as AssetNodeData).assetId !== assetId)
  const scrubbedNodes = scrubDeletedAssetFromNodes(remainingNodes, assetId)
  const nodeIds = new Set(scrubbedNodes.map((node) => node.id))
  const edges = document.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
  const nodes = normalizeGenerateNodeInputs(scrubbedNodes, edges)
  const templates = document.templates.map((template) => ({
    ...template,
    snapshot: scrubDeletedAssetFromSnapshot(template.snapshot, assetId),
  }))
  const history = document.history.map((entry) => ({
    ...entry,
    generationRecipe: entry.generationRecipe ? withoutReference(entry.generationRecipe, assetId) : undefined,
    rootRecipe: entry.rootRecipe ? withoutReference(entry.rootRecipe, assetId) : undefined,
    snapshot: scrubDeletedAssetFromSnapshot(entry.snapshot, assetId),
  }))
  return {
    ...document,
    assets: document.assets.filter((item) => item.id !== assetId),
    nodes,
    edges,
    templates,
    history,
  }
}

function scrubRevokedRecipe(recipe: GenerationRecipe | undefined) {
  if (!recipe) return undefined
  return [...revokedGlobalAssetIds].reduce(
    (current, assetId) => withoutReference(current, assetId),
    recipe,
  )
}

function scrubRevokedGenerationRequest(request: GenerationRequest | null) {
  if (!request) return request
  return {
    ...request,
    recipe: scrubRevokedRecipe(request.recipe),
    rootRecipe: scrubRevokedRecipe(request.rootRecipe),
  }
}

function scrubRevokedGenerationCandidates(candidates: GenerationCandidate[]) {
  if (!revokedGlobalAssetIds.size) return candidates
  return candidates.map((candidate) => ({
    ...candidate,
    recipe: scrubRevokedRecipe(candidate.recipe) ?? candidate.recipe,
    rootRecipe: scrubRevokedRecipe(candidate.rootRecipe),
  }))
}

function scrubRevokedStoreExtra(extra: Partial<CanvasStore>): Partial<CanvasStore> {
  if (!revokedGlobalAssetIds.size) return extra
  return {
    ...extra,
    ...(extra.generationCandidates ? { generationCandidates: scrubRevokedGenerationCandidates(extra.generationCandidates) } : {}),
    ...(extra.lastGenerationRequest !== undefined
      ? { lastGenerationRequest: scrubRevokedGenerationRequest(extra.lastGenerationRequest) }
      : {}),
  }
}

function workflowTemplateSnapshotFromSnapshot(snapshotValue: CanvasSnapshot, name: string): CanvasSnapshot {
  const nodes = cloneNodes(snapshotValue.nodes)
    .filter((node) => node.type === 'asset' || node.type === 'text' || node.type === 'generate')
    .map((node) => {
      if (node.type !== 'generate') return node
      const data = node.data as GenerateNodeData
      return {
        ...node,
        selected: false,
        data: {
          ...data,
          status: undefined,
          jobId: undefined,
          generationKind: undefined,
          error: undefined,
        },
      }
    }) as CanvasNode[]
  const nodeIds = new Set(nodes.map((node) => node.id))
  return {
    name,
    nodes,
    edges: cloneEdges(snapshotValue.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))),
    viewport: { ...snapshotValue.viewport },
  }
}

function workflowTemplateSnapshot(document: CanvasDocument, name: string): CanvasSnapshot {
  return workflowTemplateSnapshotFromSnapshot(snapshot(document, name), name)
}

/** 清理旧版演示状态遗留的 “Mock 生成” 等展示文案，避免再次写回本地画布。 */
function removeLegacyMockCopy(value: string | undefined) {
  if (!value) return value
  const cleaned = value
    .replace(/\s*[·•|｜]\s*mock\s*(?:生成|生图|出图|任务)?/gi, '')
    .replace(/\bmock\s*(?:生成|生图|出图|任务)?\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return cleaned
}

function cleanDisplayName(value: string | undefined, fallback: string) {
  return removeLegacyMockCopy(value) || fallback
}

function canvasNodeDisplayName(node: CanvasNode) {
  if (node.type === 'asset') return (node.data as AssetNodeData).name
  if (node.type === 'text') return (node.data as TextNodeData).label
  if (node.type === 'generate') return (node.data as GenerateNodeData).label
  if (node.type === 'prompt') return (node.data as PromptNodeData).label
  if (node.type === 'reference') return (node.data as ReferenceGroupNodeData).label
  return (node.data as ResultNodeData).label ?? '输出图片'
}

function cleanAssetTags(tags: string[] | undefined) {
  const seen = new Set<string>()
  return (Array.isArray(tags) ? tags : []).flatMap((tag) => {
    const cleaned = removeLegacyMockCopy(tag)
    if (!cleaned || seen.has(cleaned)) return []
    seen.add(cleaned)
    return [cleaned]
  })
}

function normalizeGenerationRecipeCopy(recipe: GenerationRecipe): GenerationRecipe {
  return {
    ...cloneGenerationRecipe(recipe),
    references: recipe.references.map((reference) => ({
      ...reference,
      name: cleanDisplayName(reference.name, '未命名素材'),
    })),
  }
}

function normalizeLegacyCopyNodes(nodes: CanvasNode[]): CanvasNode[] {
  return cloneNodes(nodes).map((node) => {
    if (node.type === 'asset') {
      const data = node.data as AssetNodeData
      return { ...node, data: { ...data, name: cleanDisplayName(data.name, '未命名素材') } }
    }
    if (node.type === 'text') {
      const data = node.data as TextNodeData
      return { ...node, data: { ...data, label: cleanDisplayName(data.label, '生成描述') } }
    }
    if (node.type === 'generate') {
      const data = node.data as GenerateNodeData
      return { ...node, data: { ...data, label: cleanDisplayName(data.label, '首图生成') } }
    }
    if (node.type === 'prompt') {
      const data = node.data as PromptNodeData
      return {
        ...node,
        data: {
          ...data,
          label: cleanDisplayName(data.label, data.generationKind === 'refinement' ? '定向精修指令' : '视觉目标'),
        },
      }
    }
    if (node.type === 'reference') {
      const data = node.data as ReferenceGroupNodeData
      return {
        ...node,
        data: {
          ...data,
          label: cleanDisplayName(data.label, '本次参考'),
          recipe: normalizeGenerationRecipeCopy(data.recipe),
        },
      }
    }
    const data = node.data as ResultNodeData
    const generationRecipe = data.generationRecipe ? normalizeGenerationRecipeCopy(data.generationRecipe) : undefined
    const rootRecipe = data.rootRecipe
      ? normalizeGenerationRecipeCopy(data.rootRecipe)
      : generationRecipe
        ? cloneGenerationRecipe(generationRecipe)
        : undefined
    return {
      ...node,
      data: {
        ...data,
        label: data.label ? cleanDisplayName(data.label, data.generationKind === 'refinement' ? '定向精修结果' : '首图结果') : data.label,
        generationRecipe,
        rootRecipe,
      },
    }
  }) as CanvasNode[]
}

function stopGenerationPolling() {
  if (generationPollTimerId !== null) window.clearTimeout(generationPollTimerId)
  generationPollTimerId = null
  generationPollRunId += 1
}

function clearUndoTimer() {
  if (undoTimerId !== null) window.clearTimeout(undoTimerId)
  undoTimerId = null
}

type CanvasGenerationReference = GenerationReference & {
  enabled: boolean
  primary: boolean
  priority: number
}

function canvasGenerationReferences(document: CanvasDocument): CanvasGenerationReference[] {
  const references = document.nodes
    .flatMap((node, index): CanvasGenerationReference[] => {
      if (node.type !== 'asset') return []
      const asset = node.data as AssetNodeData
      const enabled = asset.referenceEnabled !== false
      return [{
        nodeId: node.id,
        assetId: asset.assetId,
        name: asset.name,
        image: asset.image,
        role: asset.role,
        source: asset.source,
        enabled,
        primary: enabled && asset.role === '商品' && Boolean(asset.primary),
        priority: Number.isInteger(asset.referencePriority) && asset.referencePriority! > 0 ? asset.referencePriority! : index + 1,
      }]
    })
    .sort((left, right) => {
      if (left.primary !== right.primary) return left.primary ? -1 : 1
      if (left.priority !== right.priority) return left.priority - right.priority
      if (left.role === right.role) return left.name.localeCompare(right.name, 'zh-Hans-CN')
      if (left.role === '商品') return -1
      if (right.role === '商品') return 1
      return left.role.localeCompare(right.role, 'zh-Hans-CN')
    })
  return references.map((reference, index) => ({ ...reference, priority: index + 1 }))
}

function buildGenerationRecipe(
  document: CanvasDocument,
  prompt: string,
  batchCount: number,
  settings: GenerationSettings,
): GenerationRecipe {
  const references = canvasGenerationReferences(document).filter((reference) => reference.enabled)
  const primary = references.find((reference) => reference.primary && reference.role === '商品')
    ?? references.find((reference) => reference.role === '商品')
  return {
    primaryReferenceNodeId: primary?.nodeId,
    references: references.map((reference) => ({
      nodeId: reference.nodeId,
      assetId: reference.assetId,
      name: reference.name,
      image: reference.image,
      role: reference.role,
      source: reference.source,
      primary: reference.nodeId === primary?.nodeId,
      priority: reference.priority,
    })),
    prompt,
    batchCount,
    settings: cloneGenerationSettings(settings),
  }
}

function buildGraphGenerationRecipe(document: CanvasDocument, generateNodeId: string) {
  const generateNode = document.nodes.find((node) => node.id === generateNodeId && node.type === 'generate')
  if (!generateNode || generateNode.type !== 'generate') return null

  const generate = generateNode.data as GenerateNodeData
  const connectedNodes = connectedGenerateInputs(document, generateNodeId)

  const directReferences = connectedNodes
    .flatMap((node, index): GenerationReference[] => {
      if (node.type !== 'asset') return []
      const asset = node.data as AssetNodeData
      return [{
        nodeId: node.id,
        assetId: asset.assetId,
        name: asset.name,
        image: asset.image,
        role: asset.role,
        source: asset.source,
        primary: false,
        priority: index + 1,
      }]
    })

  const promptParts = connectedNodes
    .flatMap((node) => node.type === 'text' ? [(node.data as TextNodeData).content.trim()] : [])
    .filter(Boolean)
  if (generate.prompt.trim()) promptParts.push(generate.prompt.trim())

  const resultInputs = connectedNodes.filter((node) => node.type === 'result') as CanvasNode[]
  const parentResult = resultInputs.find((node) => Boolean((node.data as ResultNodeData).image))
  const parentData = parentResult?.type === 'result' ? parentResult.data as ResultNodeData : undefined
  const inheritedReferences = parentData?.generationRecipe?.references ?? []
  const references = [
    ...directReferences,
    ...inheritedReferences.filter((reference) => !directReferences.some((direct) => direct.assetId === reference.assetId)),
  ]
  const primary = references.find((reference) => reference.nodeId === generate.primaryInputId)
    ?? references.find((reference) => reference.primary)
    ?? references[0]

  return {
    prompt: promptParts.join('\n'),
    hasUnselectedResultInput: Boolean(resultInputs.length && !parentResult),
    parent: parentResult && parentData?.image
      ? {
          nodeId: parentResult.id,
          image: parentData.image,
          label: parentData.label ?? '上游首图',
        }
      : undefined,
    recipe: {
      primaryReferenceNodeId: primary?.nodeId,
      references: references.map((reference, index) => ({
        ...reference,
        primary: reference.nodeId === primary?.nodeId,
        priority: index + 1,
      })),
      prompt: promptParts.join('\n'),
      batchCount: clampBatchCount(generate.batchCount),
      settings: cloneGenerationSettings(generate.settings),
    } satisfies GenerationRecipe,
  }
}

function primaryGenerationReference(recipe: GenerationRecipe) {
  return recipe.references.find((reference) => reference.nodeId === recipe.primaryReferenceNodeId)
    ?? recipe.references.find((reference) => reference.primary)
    ?? recipe.references[0]
}

function withoutAsset(snapshotValue: CanvasSnapshot, assetId: string): CanvasSnapshot {
  const filteredNodes = snapshotValue.nodes.filter((node) => node.type !== 'asset' || (node.data as AssetNodeData).assetId !== assetId)
  const nodeIds = new Set(filteredNodes.map((node) => node.id))
  const edges = cloneEdges(snapshotValue.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)))
  return {
    ...snapshotValue,
    nodes: normalizeGenerateNodeInputs(cloneNodes(filteredNodes), edges),
    edges,
  }
}

function normalizeAssetReferenceNodes(nodes: CanvasNode[]): CanvasNode[] {
  let primaryAssigned = false
  let normalized = cloneNodes(nodes).map((node, index) => {
    if (node.type !== 'asset') return node
    const asset = node.data as AssetNodeData
    const enabled = asset.referenceEnabled !== false
    const primary = enabled && asset.role === '商品' && Boolean(asset.primary) && !primaryAssigned
    if (primary) primaryAssigned = true
    return {
      ...node,
      data: {
        ...asset,
        referenceEnabled: enabled,
        primary,
        referencePriority: Number.isInteger(asset.referencePriority) && asset.referencePriority! > 0
          ? asset.referencePriority
          : index + 1,
      },
    }
  }) as CanvasNode[]

  const hasPrimaryProduct = normalized.some((node) => node.type === 'asset'
    && (node.data as AssetNodeData).role === '商品'
    && (node.data as AssetNodeData).referenceEnabled !== false
    && Boolean((node.data as AssetNodeData).primary))

  if (!hasPrimaryProduct) {
    const firstEnabledProduct = normalized.find((node) => node.type === 'asset'
      && (node.data as AssetNodeData).role === '商品'
      && (node.data as AssetNodeData).referenceEnabled !== false)
    if (firstEnabledProduct?.type === 'asset') {
      normalized = normalized.map((node) => node.id === firstEnabledProduct.id
        ? { ...node, data: { ...(node.data as AssetNodeData), primary: true } }
        : node) as CanvasNode[]
    }
  }

  const ordered = normalized
    .flatMap((node, index) => node.type === 'asset' && (node.data as AssetNodeData).referenceEnabled !== false
      ? [{ node, index, asset: node.data as AssetNodeData }]
      : [])
    .sort((left, right) => {
      if (left.asset.primary !== right.asset.primary) return left.asset.primary ? -1 : 1
      if ((left.asset.referencePriority ?? left.index + 1) !== (right.asset.referencePriority ?? right.index + 1)) {
        return (left.asset.referencePriority ?? left.index + 1) - (right.asset.referencePriority ?? right.index + 1)
      }
      return left.index - right.index
    })
  const priorityById = new Map(ordered.map((item, index) => [item.node.id, index + 1]))

  return normalized.map((node) => node.type === 'asset'
    ? { ...node, data: { ...(node.data as AssetNodeData), referencePriority: priorityById.get(node.id) ?? (node.data as AssetNodeData).referencePriority } }
    : node) as CanvasNode[]
}

function nodeVisualWidth(node: CanvasNode) {
  if (node.type === 'asset') return 176
  if (node.type === 'result') return 300
  if (node.type === 'generate') return 286
  if (node.type === 'text') return 236
  return 252
}

function taskFlowKey(node: CanvasNode) {
  return node.id.match(/^(?:prompt|reference|result)-task-(.+)$/)?.[1]
}

function nextTaskFlowStartX(nodes: CanvasNode[]) {
  return Math.max(720, ...nodes.map((node) => node.position.x + nodeVisualWidth(node) + 72))
}

function layoutTaskFlowNodes(nodes: CanvasNode[]): CanvasNode[] {
  const cloned = cloneNodes(nodes)
  const groups = new Map<string, CanvasNode[]>()
  const nonTaskNodes: CanvasNode[] = []

  for (const node of cloned) {
    const key = taskFlowKey(node)
    if (!key) {
      nonTaskNodes.push(node)
      continue
    }
    groups.set(key, [...(groups.get(key) ?? []), node])
  }

  let nextX = nextTaskFlowStartX(nonTaskNodes)
  const positions = new Map<string, XYPosition>()
  const orderedGroups = [...groups.entries()].sort(([left], [right]) => Number(left) - Number(right))
  for (const [, nodesInTask] of orderedGroups) {
    for (const node of nodesInTask) {
      if (node.type === 'prompt') positions.set(node.id, { x: nextX, y: 90 })
      if (node.type === 'reference') positions.set(node.id, { x: nextX, y: 240 })
      if (node.type === 'result') positions.set(node.id, { x: nextX + 300, y: 168 })
    }
    nextX += 680
  }

  return cloned.map((node) => {
    const position = positions.get(node.id)
    return position ? { ...node, position } : node
  }) as CanvasNode[]
}

/**
 * V16 的示例首图沿用了早期紧凑坐标；在实际节点尺寸下会让四张参考图
 * 视觉上贴在一起。仅迁移这组固定的默认节点，不改用户后来手动摆放的节点。
 */
function layoutStarterV03Nodes(nodes: CanvasNode[]): CanvasNode[] {
  const requiredIds = ['asset-product', 'asset-scene', 'asset-model', 'asset-tone', 'text-v03', 'generate-v03', 'result-hero']
  const nodeIds = new Set(nodes.map((node) => node.id))
  if (!requiredIds.every((id) => nodeIds.has(id))) return cloneNodes(nodes)

  const positions: Record<string, XYPosition> = {
    'asset-product': { x: 120, y: 210 },
    'asset-scene': { x: 470, y: 210 },
    'asset-model': { x: 120, y: 560 },
    'asset-tone': { x: 470, y: 560 },
    'text-v03': { x: 860, y: 86 },
    'generate-v03': { x: 860, y: 310 },
    'result-hero': { x: 1330, y: 225 },
  }

  return cloneNodes(nodes).map((node) => positions[node.id]
    ? { ...node, position: positions[node.id] }
    : node) as CanvasNode[]
}

function hasCrampedStarterV03Layout(nodes: CanvasNode[]) {
  const legacyPositions: Record<string, XYPosition> = {
    'asset-product': { x: 290, y: 225 },
    'asset-scene': { x: 490, y: 225 },
    'asset-model': { x: 290, y: 485 },
    'asset-tone': { x: 490, y: 485 },
    'text-v03': { x: 700, y: 86 },
    'generate-v03': { x: 700, y: 282 },
    'result-hero': { x: 1070, y: 210 },
  }
  return Object.entries(legacyPositions).every(([id, position]) => {
    const node = nodes.find((item) => item.id === id)
    return Boolean(node && Math.abs(node.position.x - position.x) < 8 && Math.abs(node.position.y - position.y) < 8)
  })
}

function fallbackGenerationRecipe(nodes: CanvasNode[], prompt: string, settings?: Partial<GenerationSettings>, batchCount = 1): GenerationRecipe {
  const references = nodes.flatMap((node, index): GenerationReference[] => {
    if (node.type !== 'asset') return []
    const asset = node.data as AssetNodeData
    return [{
      nodeId: node.id,
      assetId: asset.assetId,
      name: asset.name,
      image: asset.image,
      role: asset.role,
      source: asset.source,
      priority: index + 1,
    }]
  })
  const primary = references.find((reference) => {
    const node = nodes.find((item) => item.id === reference.nodeId && item.type === 'asset')
    return node?.type === 'asset' && (node.data as AssetNodeData).role === '商品' && Boolean((node.data as AssetNodeData).primary)
  }) ?? references.find((reference) => reference.role === '商品')
  return {
    primaryReferenceNodeId: primary?.nodeId,
    references: references.map((reference, index) => ({
      ...reference,
      primary: reference.nodeId === primary?.nodeId,
      priority: index + 1,
    })),
    prompt,
    batchCount: clampBatchCount(batchCount),
    settings: cloneGenerationSettings(settings),
  }
}

function migrationId(base: string, used: Set<string>) {
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  let suffix = 2
  while (used.has(`${base}-${suffix}`)) suffix += 1
  const id = `${base}-${suffix}`
  used.add(id)
  return id
}

function migrationEdgeId(base: string, edges: Edge[]) {
  const used = new Set(edges.map((edge) => edge.id))
  return migrationId(base, used)
}

function resultGenerationStatus(result: ResultNodeData): GenerateNodeData['status'] {
  if (result.status === 'ready') return 'succeeded'
  if (result.status === 'failed') return 'failed'
  if (result.status === 'cancelled') return 'cancelled'
  return 'running'
}

function migrationInputEdge(
  id: string,
  source: string,
  target: string,
  style: Edge['style'] = { stroke: '#b6cfbd', strokeWidth: 1.3 },
  sourceHandle = 'output',
): Edge {
  return {
    id,
    source,
    sourceHandle,
    target,
    targetHandle: 'input',
    type: 'default',
    style,
  }
}

/** 将 V0.6 的 Prompt → Reference → Result 和更早的素材直连结果，收敛成可编辑图谱。 */
function migrateLegacyWorkflowSnapshot(snapshotValue: CanvasSnapshot): CanvasSnapshot {
  let nodes = cloneNodes(snapshotValue.nodes)
  let edges: Edge[] = cloneEdges(snapshotValue.edges)
  const nodeIds = new Set(nodes.map((node) => node.id))
  const defaultPrompt = '夏日植物与白瓷台面，柔和自然光，顶部留出标题区'

  const taskKeys = [...new Set(nodes
    .filter((node) => node.type === 'prompt' && node.id.startsWith('prompt-task-'))
    .map((node) => node.id.replace('prompt-task-', '')))]

  for (const key of taskKeys) {
    const promptNode = nodes.find((node) => node.id === `prompt-task-${key}` && node.type === 'prompt')
    const referenceNode = nodes.find((node) => node.id === `reference-task-${key}` && node.type === 'reference')
    const resultNode = nodes.find((node) => node.id === `result-task-${key}` && node.type === 'result')
    if (!promptNode || !resultNode) continue

    const prompt = promptNode.data as PromptNodeData
    const reference = referenceNode?.type === 'reference' ? referenceNode.data as ReferenceGroupNodeData : undefined
    const result = resultNode.data as ResultNodeData
    const promptText = prompt.prompt.trim() || reference?.recipe.prompt.trim() || defaultPrompt
    const recipe = cloneGenerationRecipe({
      ...(reference?.recipe ?? result.generationRecipe ?? fallbackGenerationRecipe(nodes, promptText, prompt.settings, prompt.batchCount)),
      prompt: promptText,
      batchCount: clampBatchCount(prompt.batchCount ?? reference?.recipe.batchCount ?? 1),
      settings: cloneGenerationSettings(prompt.settings ?? reference?.recipe.settings ?? result.generationSettings),
    })
    const textNodeId = migrationId(`text-task-${key}`, nodeIds)
    const generateNodeId = migrationId(`generate-task-${key}`, nodeIds)
    const removedIds = new Set([promptNode.id, referenceNode?.id].filter(Boolean) as string[])
    const externalInputs = edges.filter((edge) => removedIds.has(edge.target) && !removedIds.has(edge.source))
    edges = edges.filter((edge) => !removedIds.has(edge.source) && !removedIds.has(edge.target))

    nodes = nodes
      .filter((node) => !removedIds.has(node.id))
      .map((node) => node.id === resultNode.id
        ? {
            ...node,
            data: {
              ...(node.data as ResultNodeData),
              generationKind: prompt.generationKind ?? result.generationKind ?? 'generation',
              generationSettings: cloneGenerationSettings(recipe.settings),
              generationRecipe: cloneGenerationRecipe(recipe),
            },
          }
        : node) as CanvasNode[]

    nodes.push(
      {
        id: textNodeId,
        type: 'text',
        position: { ...promptNode.position },
        draggable: true,
        data: { kind: 'text', label: prompt.label || '生成描述', content: promptText },
      },
      {
        id: generateNodeId,
        type: 'generate',
        position: { ...(referenceNode?.position ?? { x: promptNode.position.x + 286, y: promptNode.position.y + 56 }) },
        draggable: true,
        data: {
          kind: 'generate',
          label: prompt.generationKind === 'refinement' ? '定向精修' : '首图生成',
          prompt: '',
          batchCount: recipe.batchCount,
          settings: cloneGenerationSettings(recipe.settings),
          status: prompt.status,
          generationKind: prompt.generationKind,
          jobId: prompt.jobId,
          error: prompt.error,
        },
      },
    )

    const addEdge = (edge: Edge) => {
      if (edges.some((item) => item.source === edge.source && item.target === edge.target)) return
      edges.push({ ...edge, id: migrationEdgeId(edge.id, edges) })
    }
    for (const edge of externalInputs) {
      const source = nodes.find((node) => node.id === edge.source)
      if (!source) continue
      addEdge(migrationInputEdge(`task-parent-generate-${key}`, source.id, generateNodeId, source.type === 'result'
        ? { stroke: '#7e9785', strokeWidth: 1.2, strokeDasharray: '4 3' }
        : { stroke: '#b6cfbd', strokeWidth: 1.3 }, source.type === 'asset' ? 'asset-output' : 'output'))
    }
    for (const item of recipe.references) {
      if (!nodes.some((node) => node.id === item.nodeId && node.type === 'asset')) continue
      addEdge(migrationInputEdge(`task-asset-generate-${key}-${item.nodeId}`, item.nodeId, generateNodeId, undefined, 'asset-output'))
    }
    addEdge(migrationInputEdge(`task-text-generate-${key}`, textNodeId, generateNodeId))
    addEdge({
      id: `task-generate-result-${key}`,
      source: generateNodeId,
      sourceHandle: 'output',
      target: resultNode.id,
      type: 'default',
      style: { stroke: '#2a5238', strokeWidth: 1.7 },
    })
  }

  const results = nodes.filter((node) => node.type === 'result')
  for (const resultNode of results) {
    const hasGenerateInput = edges.some((edge) => edge.target === resultNode.id
      && nodes.some((node) => node.id === edge.source && node.type === 'generate'))
    const directInputs = edges.filter((edge) => edge.target === resultNode.id
      && nodes.some((node) => node.id === edge.source && (node.type === 'asset' || node.type === 'text')))
    if (hasGenerateInput || !directInputs.length) continue

    const result = resultNode.data as ResultNodeData
    const inputText = directInputs
      .map((edge) => nodes.find((node) => node.id === edge.source && node.type === 'text'))
      .find((node): node is CanvasNode => Boolean(node))
    const textContent = inputText?.type === 'text'
      ? (inputText.data as TextNodeData).content.trim() || result.generationRecipe?.prompt || defaultPrompt
      : result.generationRecipe?.prompt || defaultPrompt
    const recipe = cloneGenerationRecipe(result.generationRecipe ?? fallbackGenerationRecipe(nodes, textContent, result.generationSettings))
    const generateNodeId = migrationId(resultNode.id === 'result-hero' ? 'generate-v03' : `generate-legacy-${resultNode.id}`, nodeIds)
    const needsText = !inputText
    const textNodeId = needsText
      ? migrationId(resultNode.id === 'result-hero' ? 'text-v03' : `text-legacy-${resultNode.id}`, nodeIds)
      : inputText!.id
    const originalPosition = { ...resultNode.position }

    nodes = nodes.map((node) => node.id === resultNode.id
      ? {
          ...node,
          position: { x: originalPosition.x + 370, y: originalPosition.y + 54 },
          data: {
            ...(node.data as ResultNodeData),
            generationKind: result.generationKind ?? 'generation',
            generationSettings: cloneGenerationSettings(recipe.settings),
            generationRecipe: cloneGenerationRecipe(recipe),
          },
        }
      : node) as CanvasNode[]
    if (needsText) {
      nodes.push({
        id: textNodeId,
        type: 'text',
        position: { x: originalPosition.x, y: originalPosition.y - 170 },
        draggable: true,
        data: { kind: 'text', label: '首图创意描述', content: textContent },
      })
    }
    nodes.push({
      id: generateNodeId,
      type: 'generate',
      position: { x: originalPosition.x, y: originalPosition.y + 34 },
      draggable: true,
      data: {
        kind: 'generate',
        label: result.generationKind === 'refinement' ? '定向精修' : '首图生成',
        prompt: '',
        batchCount: recipe.batchCount,
        settings: cloneGenerationSettings(recipe.settings),
        status: resultGenerationStatus(result),
        generationKind: result.generationKind ?? 'generation',
        jobId: result.jobId,
        error: result.error,
      },
    })
    edges = edges.map((edge) => directInputs.some((input) => input.id === edge.id)
      ? { ...edge, target: generateNodeId, targetHandle: 'input' }
      : edge)
    const addEdge = (edge: Edge) => {
      if (edges.some((item) => item.source === edge.source && item.target === edge.target)) return
      edges.push({ ...edge, id: migrationEdgeId(edge.id, edges) })
    }
    if (needsText) addEdge(migrationInputEdge(`legacy-text-generate-${resultNode.id}`, textNodeId, generateNodeId))
    addEdge({
      id: `legacy-generate-result-${resultNode.id}`,
      source: generateNodeId,
      sourceHandle: 'output',
      target: resultNode.id,
      type: 'default',
      style: { stroke: '#2a5238', strokeWidth: 1.7 },
    })
  }

  edges = edges.map((edge) => {
    const source = nodes.find((node) => node.id === edge.source)
    const target = nodes.find((node) => node.id === edge.target)
    if (source?.type === 'asset' && target?.type === 'generate') {
      return { ...edge, sourceHandle: 'asset-output', targetHandle: 'input' }
    }
    if (source?.type === 'text' && target?.type === 'generate') {
      return { ...edge, sourceHandle: 'output', targetHandle: 'input' }
    }
    if (source?.type === 'result' && target?.type === 'generate') {
      return {
        ...edge,
        sourceHandle: 'output',
        targetHandle: 'input',
        style: { stroke: '#7e9785', strokeWidth: 1.2, strokeDasharray: '4 3' },
      }
    }
    if (source?.type === 'generate' && target?.type === 'result') {
      return { ...edge, sourceHandle: 'output', targetHandle: 'input' }
    }
    return edge
  })

  return {
    ...snapshotValue,
    nodes: normalizeAssetReferenceNodes(nodes),
    edges,
  }
}

function migrateGenerationJobs(jobs: GenerationJob[]) {
  return jobs.map((job) => {
    const key = job.promptNodeId?.match(/^prompt-task-(.+)$/)?.[1]
    if (!key) return {
      ...job,
      outputs: job.outputs?.map((output) => ({ ...output })),
      dismissedOutputIds: job.dismissedOutputIds ? [...job.dismissedOutputIds] : undefined,
    }
    const { promptNodeId: _promptNodeId, referenceNodeId: _referenceNodeId, ...rest } = job
    return {
      ...rest,
      generateNodeId: job.generateNodeId ?? `generate-task-${key}`,
      outputs: job.outputs?.map((output) => ({ ...output })),
      dismissedOutputIds: job.dismissedOutputIds ? [...job.dismissedOutputIds] : undefined,
    }
  })
}

function normalizeCanvasSnapshot(snapshotValue: CanvasSnapshot, layoutTaskNodes = false, migrateWorkflow = false): CanvasSnapshot {
  const normalizedNodes = normalizeLegacyCopyNodes(normalizeAssetReferenceNodes(snapshotValue.nodes))
  const normalized = {
    ...snapshotValue,
    name: cleanDisplayName(snapshotValue.name, '未命名画布'),
    nodes: layoutTaskNodes ? layoutTaskFlowNodes(normalizedNodes) : normalizedNodes,
    edges: cloneEdges(snapshotValue.edges),
    viewport: { ...snapshotValue.viewport },
  }
  const migrated = migrateWorkflow ? migrateLegacyWorkflowSnapshot(normalized) : normalized
  const nodes = normalizeGenerateNodeInputs(normalizeLegacyCopyNodes(migrated.nodes), migrated.edges)
  return {
    ...migrated,
    nodes,
    edges: normalizeSystemOutputEdges(nodes, migrated.edges),
  }
}

function normalizeDocument(stored: CanvasDocument | undefined): CanvasDocument {
  if (!stored) return seedDocument

  const legacy = stored as Partial<CanvasDocument>
  const needsTaskLayoutMigration = (legacy.schemaVersion ?? 0) < 8
  const needsWorkflowMigration = (legacy.schemaVersion ?? 0) < 12
  const needsTemplateBlueprintMigration = (legacy.schemaVersion ?? 0) < 14
  // 首批 V17 快照已经带上版本号，但仍保存了 V16 的紧凑示例坐标；用坐标兜底仅迁移这一组确定的默认节点。
  const needsStarterSpacingMigration = (legacy.schemaVersion ?? 0) < 17 || hasCrampedStarterV03Layout(legacy.nodes ?? [])
  const templates = (legacy.templates ?? seedDocument.templates).map((template) => {
    const normalizedSnapshot = normalizeCanvasSnapshot(template.snapshot, needsTaskLayoutMigration, needsWorkflowMigration)
    return {
    ...template,
    name: cleanDisplayName(template.name, '未命名模板'),
    snapshot: needsTemplateBlueprintMigration
      ? workflowTemplateSnapshotFromSnapshot(normalizedSnapshot, cleanDisplayName(template.name, '未命名模板'))
      : normalizedSnapshot,
  }
  })
  const history = (legacy.history ?? seedDocument.history).map((entry) => ({
    ...entry,
    name: cleanDisplayName(entry.name, '未命名版本'),
    generationRecipe: entry.generationRecipe ? normalizeGenerationRecipeCopy(entry.generationRecipe) : undefined,
    rootRecipe: entry.rootRecipe
      ? normalizeGenerationRecipeCopy(entry.rootRecipe)
      : entry.generationRecipe
        ? normalizeGenerationRecipeCopy(entry.generationRecipe)
        : undefined,
    snapshot: normalizeCanvasSnapshot(entry.snapshot, needsTaskLayoutMigration, needsWorkflowMigration),
  }))
  const normalizedRootSnapshot = normalizeCanvasSnapshot({
    name: legacy.name ?? seedDocument.name,
    nodes: legacy.nodes ?? seedDocument.nodes,
    edges: legacy.edges ?? seedDocument.edges,
    viewport: legacy.viewport ?? seedDocument.viewport,
  }, needsTaskLayoutMigration, needsWorkflowMigration)
  const rootSnapshot = needsStarterSpacingMigration
    ? {
        ...normalizedRootSnapshot,
        nodes: layoutStarterV03Nodes(normalizedRootSnapshot.nodes),
        // 同步清除旧画布的默认 100% 视角，让首次打开按完整图谱适配。
        viewport: { x: 0, y: 0, zoom: 1 },
      }
    : normalizedRootSnapshot
  const document: CanvasDocument = {
    ...seedDocument,
    ...legacy,
    schemaVersion: 18,
    name: cleanDisplayName(legacy.name, seedDocument.name),
    viewport: rootSnapshot.viewport,
    nodes: rootSnapshot.nodes,
    edges: rootSnapshot.edges,
    // V16 起品牌素材存在全局库，CanvasDocument 仅保留项目上传/生成资产。
    assets: (legacy.assets ?? seedDocument.assets).filter((asset) => asset.source !== 'brand').map((asset) => ({
      ...asset,
      name: cleanDisplayName(asset.name, '未命名素材'),
      tags: cleanAssetTags(asset.tags),
    })),
    templates,
    history,
    deliveries: (legacy.deliveries ?? seedDocument.deliveries).map((delivery) => ({
      ...delivery,
      targetLabel: cleanDisplayName(delivery.targetLabel, '已选首图'),
      title: removeLegacyMockCopy(delivery.title) ?? delivery.title,
      subtitle: removeLegacyMockCopy(delivery.subtitle) ?? delivery.subtitle,
    })),
    generationJobs: migrateGenerationJobs(legacy.generationJobs ?? []),
    activeVersionId: legacy.activeVersionId ?? seedDocument.activeVersionId,
  }
  // V18 起，同一次任务的每张输出都是画布上的独立结果节点；旧任务在首次打开时补齐。
  return document.generationJobs.reduce((nextDocument, job) => {
    if (job.status !== 'succeeded' || !job.outputs?.length) return nextDocument
    const request = requestFromPersistedJob(nextDocument, job)
    return request ? materializeGenerationOutputs(nextDocument, job, request) : nextDocument
  }, document)
}

function commit(
  set: (next: Partial<CanvasStore>) => void,
  document: CanvasDocument,
  extra: Partial<CanvasStore> = {},
) {
  const sanitizedDocument = [...revokedGlobalAssetIds].reduce(
    (current, assetId) => scrubAssetFromDocument(current, assetId),
    document,
  )
  const nextDocument = { ...sanitizedDocument, updatedAt: Date.now() }
  const runId = ++persistenceRunId
  set({ document: nextDocument, persistenceStatus: 'saving', ...scrubRevokedStoreExtra(extra) })
  void writeCanvasDocument(nextDocument)
    .then(() => {
      if (runId === persistenceRunId) set({ persistenceStatus: 'saved' })
    })
    .catch(() => {
      if (runId !== persistenceRunId) return
      set({
        persistenceStatus: 'error',
        assistantMessage: '项目保存失败：请先不要刷新，稍后重试或导出当前结果。',
      })
    })
}

function setGenerationError(set: (next: Partial<CanvasStore>) => void, message: string, preserveLastRequest = false) {
  set({
    generationStatus: 'error',
    generationProgress: 0,
    generationError: message,
    generationCandidates: [],
    ...(preserveLastRequest ? {} : { lastGenerationRequest: null }),
    assistantMessage: message,
  })
  return false
}

function taskResultStatus(status: GenerationJob['status'] | 'uploading'): ResultNodeData['status'] {
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'succeeded') return 'ready'
  return 'generating'
}

function taskFlowLabel(kind: GenerationRequest['kind']) {
  return kind === 'refinement' ? '定向精修' : '首图生成'
}

function createTaskFlow(
  document: CanvasDocument,
  request: GenerationRequest,
  parentNode?: CanvasNode,
): { document: CanvasDocument; taskNodeIds: TaskNodeIds } {
  const timestamp = Date.now()
  const sourceGenerateNode = request.sourceGraphNodeId
    ? document.nodes.find((node) => node.id === request.sourceGraphNodeId && node.type === 'generate')
    : undefined
  const taskNodeIds: TaskNodeIds = {
    generateNodeId: sourceGenerateNode?.id ?? `generate-task-${timestamp}`,
    resultNodeId: `result-task-${timestamp}`,
  }
  const x = nextTaskFlowStartX(document.nodes)
  const y = 160
  const existingOutputCount = sourceGenerateNode
    ? document.edges.filter((edge) => edge.source === sourceGenerateNode.id && document.nodes.some((node) => node.id === edge.target && node.type === 'result')).length
    : 0
  const layout = request.taskLayout ?? (sourceGenerateNode
    ? {
        generate: { ...sourceGenerateNode.position },
        result: { x: sourceGenerateNode.position.x + 372, y: sourceGenerateNode.position.y + 28 + existingOutputCount * 254 },
      }
    : {
        generate: { x, y },
        result: { x: x + 378, y: y + 48 },
      })
  const recipe = request.recipe ? cloneGenerationRecipe(request.recipe) : undefined

  if (!recipe) throw new Error('生成配方缺失。')
  const parentRootRecipe = parentNode?.type === 'result'
    ? (parentNode.data as ResultNodeData).rootRecipe ?? (parentNode.data as ResultNodeData).generationRecipe
    : undefined
  const rootRecipe = cloneGenerationRecipe(request.rootRecipe ?? parentRootRecipe ?? recipe)

  const textNodeId = sourceGenerateNode ? undefined : `text-task-${timestamp}`
  const textNode: CanvasNode | undefined = textNodeId
    ? {
        id: textNodeId,
        type: 'text',
        position: { x: layout.generate.x, y: layout.generate.y - 172 },
        draggable: true,
        data: { kind: 'text', label: request.kind === 'refinement' ? '精修描述' : '生成描述', content: request.prompt },
      }
    : undefined
  const generateNode: CanvasNode = sourceGenerateNode
    ? {
        ...sourceGenerateNode,
        selected: false,
        data: {
          ...(sourceGenerateNode.data as GenerateNodeData),
          status: 'uploading',
          generationKind: request.kind,
          jobId: undefined,
          error: undefined,
        },
      }
    : {
        id: taskNodeIds.generateNodeId,
        type: 'generate',
        position: { ...layout.generate },
        draggable: true,
        data: {
          kind: 'generate',
          label: taskFlowLabel(request.kind),
          prompt: '',
          batchCount: request.batchCount,
          settings: cloneGenerationSettings(request.settings),
          status: 'uploading',
          generationKind: request.kind,
        },
      }
  const resultNode: CanvasNode = {
    id: taskNodeIds.resultNodeId,
    type: 'result',
    position: { ...layout.result },
    draggable: true,
    data: {
      kind: 'result',
      outputOf: taskNodeIds.generateNodeId,
      status: 'generating',
      taskStatus: 'uploading',
      submittedAt: timestamp,
      label: `${request.kind === 'refinement' ? '精修' : '首图'}候选 · 等待任务`,
      generationKind: request.kind,
      generationSettings: cloneGenerationSettings(request.settings),
      generationRecipe: recipe,
      rootRecipe,
    },
  }
  const taskEdges: Edge[] = []
  const nodeIds = new Set(document.nodes.map((node) => node.id))
  if (!sourceGenerateNode) {
    for (const reference of recipe.references) {
      if (!nodeIds.has(reference.nodeId)) continue
      taskEdges.push({
        ...migrationInputEdge(`task-asset-generate-${timestamp}-${reference.nodeId}`, reference.nodeId, taskNodeIds.generateNodeId, undefined, 'asset-output'),
        className: 'task-edge task-edge--active',
      })
    }
    if (textNodeId) {
      taskEdges.push({
        ...migrationInputEdge(`task-text-generate-${timestamp}`, textNodeId, taskNodeIds.generateNodeId),
        className: 'task-edge task-edge--active',
      })
    }
  }

  if (parentNode && !document.edges.some((edge) => edge.source === parentNode.id && edge.target === taskNodeIds.generateNodeId)) {
    taskEdges.push({
      id: `task-parent-generate-${timestamp}`,
      source: parentNode.id,
      target: taskNodeIds.generateNodeId,
      targetHandle: 'input',
      type: 'default',
      style: { stroke: '#7e9785', strokeWidth: 1.2, strokeDasharray: '4 3' },
      className: 'task-edge task-edge--active',
    })
  }

  taskEdges.push({
    id: `task-generate-result-${timestamp}`,
    source: taskNodeIds.generateNodeId,
    sourceHandle: 'output',
    target: taskNodeIds.resultNodeId,
    type: 'default',
    style: { stroke: '#2a5238', strokeWidth: 1.7 },
    className: 'task-edge task-edge--active',
    data: { system: true, role: 'output' },
    reconnectable: false,
  })

  const baseNodes = document.nodes
    .map((node) => node.id === taskNodeIds.generateNodeId
      ? generateNode
      : { ...node, selected: false }) as CanvasNode[]
  if (!sourceGenerateNode) baseNodes.push(generateNode)
  if (textNode) baseNodes.push(textNode)
  baseNodes.push(resultNode)

  return {
    document: {
      ...document,
      nodes: baseNodes,
      edges: [...document.edges, ...taskEdges],
    },
    taskNodeIds,
  }
}

function updateTaskNodes(
  document: CanvasDocument,
  taskNodeIds: TaskNodeIds,
  status: GenerationJob['status'] | 'uploading',
  jobId?: string,
  error?: string,
) {
  const nodes = document.nodes.map((node) => {
    if (node.id === taskNodeIds.generateNodeId && node.type === 'generate') {
      return {
        ...node,
        data: { ...(node.data as GenerateNodeData), status, jobId, error },
      }
    }
    if (node.id === taskNodeIds.resultNodeId && node.type === 'result') {
      const result = node.data as ResultNodeData
      return {
        ...node,
        data: {
          ...result,
          status: taskResultStatus(status),
          taskStatus: status,
          jobId,
          taskNodeId: taskNodeIds.resultNodeId,
          error,
          label: status === 'succeeded'
            ? `${result.generationKind === 'refinement' ? '精修' : '首图'}候选 · 等待选择`
            : result.label,
        },
      }
    }
    return node
  }) as CanvasNode[]
  const isActive = status === 'uploading' || status === 'queued' || status === 'running'
  const edges = document.edges.map((edge) => {
    const belongsToTask = edge.target === taskNodeIds.generateNodeId || edge.source === taskNodeIds.generateNodeId || edge.target === taskNodeIds.resultNodeId
    if (!belongsToTask || !edge.className?.includes('task-edge')) return edge
    return { ...edge, className: isActive ? 'task-edge task-edge--active' : 'task-edge' }
  })
  return { ...document, nodes, edges }
}

function jobForDocument(job: GenerationJob, taskNodeIds: TaskNodeIds, dismissedOutputIds: string[] = []): GenerationJob {
  const { promptNodeId: _promptNodeId, referenceNodeId: _referenceNodeId, ...persistedJob } = job
  const outputs = job.status === 'succeeded'
    ? job.outputs?.filter((output) => !dismissedOutputIds.includes(output.id)).map((output) => ({ ...output }))
    : undefined
  return {
    ...persistedJob,
    // 已完成任务的每张输出都随项目持久化；被用户移除的候选不再恢复。
    outputs,
    outputCount: outputs?.length ?? job.outputCount,
    dismissedOutputIds: dismissedOutputIds.length ? [...dismissedOutputIds] : undefined,
    generateNodeId: taskNodeIds.generateNodeId,
    resultNodeId: taskNodeIds.resultNodeId,
  }
}

function recordGenerationJob(document: CanvasDocument, job: GenerationJob, taskNodeIds: TaskNodeIds) {
  const taskDocument = updateTaskNodes(document, taskNodeIds, job.status, job.id, job.error)
  const priorJob = document.generationJobs.find((item) => item.id === job.id)
  const dismissedOutputIds = [...new Set([...(priorJob?.dismissedOutputIds ?? []), ...(job.dismissedOutputIds ?? [])])]
  const persistedJob = jobForDocument(job, taskNodeIds, dismissedOutputIds)
  return {
    ...taskDocument,
    generationJobs: [
      persistedJob,
      ...taskDocument.generationJobs.filter((item) => item.id !== job.id),
    ].slice(0, 60),
  }
}

function requestFromPersistedJob(document: CanvasDocument, job: GenerationJob): GenerationRequest | null {
  if (!job.generateNodeId || !job.resultNodeId) return null
  const generateNode = document.nodes.find((node) => node.id === job.generateNodeId && node.type === 'generate')
  const resultNode = document.nodes.find((node) => node.id === job.resultNodeId && node.type === 'result')
  if (!generateNode || !resultNode) return null

  const generate = generateNode.data as GenerateNodeData
  const result = resultNode.data as ResultNodeData
  const recipe = result.generationRecipe
    ? cloneGenerationRecipe(result.generationRecipe)
    : buildGraphGenerationRecipe(document, generateNode.id)?.recipe
  if (!recipe) return null
  const parentNodeId = job.kind === 'refinement'
    ? document.edges.find((edge) => edge.target === generateNode.id && document.nodes.some((node) => node.id === edge.source && node.type === 'result'))?.source
    : undefined
  const parentNode = parentNodeId
    ? document.nodes.find((node) => node.id === parentNodeId && node.type === 'result')
    : undefined
  const parent = parentNode?.type === 'result' ? parentNode.data as ResultNodeData : undefined

  return {
    kind: job.kind,
    prompt: recipe.prompt || generate.prompt,
    batchCount: recipe.batchCount,
    settings: cloneGenerationSettings(recipe.settings),
    recipe,
    rootRecipe: result.rootRecipe ? cloneGenerationRecipe(result.rootRecipe) : cloneGenerationRecipe(recipe),
    targetNodeId: parentNodeId,
    parentVersionId: parent?.versionId,
    parentImage: parent?.image,
    parentLabel: parent?.label,
    jobId: job.id,
    taskNodeIds: {
      generateNodeId: generateNode.id,
      resultNodeId: job.resultNodeId,
    },
  }
}

function candidatesFromJob(job: GenerationJob, request: GenerationRequest): GenerationCandidate[] {
  const recipe = request.recipe
  if (!recipe) return []
  return (job.outputs ?? []).map((output, index) => ({
    id: output.id,
    name: `${request.kind === 'refinement' ? '精修' : '首图'}候选 ${String(index + 1).padStart(2, '0')}`,
    image: output.image,
    variant: index,
    prompt: request.prompt,
    createdAt: job.updatedAt,
    kind: request.kind,
    parentVersionId: request.parentVersionId,
    parentNodeId: request.targetNodeId,
    parentImage: request.parentImage,
    parentLabel: request.parentLabel,
    sourceAssetNames: recipe.references.map((reference) => reference.name),
    refinementInstruction: request.kind === 'refinement' ? request.prompt : undefined,
    settings: cloneGenerationSettings(request.settings),
    recipe: cloneGenerationRecipe(recipe),
    rootRecipe: request.rootRecipe ? cloneGenerationRecipe(request.rootRecipe) : cloneGenerationRecipe(recipe),
    jobId: job.id,
    resultNodeId: request.taskNodeIds?.resultNodeId,
    provider: job.provider,
    revisedPrompt: output.revisedPrompt,
  }))
}

function resultGridPosition(origin: XYPosition, candidate: GenerationCandidate) {
  const row = Math.floor(candidate.variant / 2)
  const height = candidate.settings.aspectRatio === '9:16'
    ? 570
    : candidate.settings.aspectRatio === '4:5'
      ? 412
      : candidate.settings.aspectRatio === '1:1'
        ? 338
        : 436
  return {
    x: origin.x + (candidate.variant % 2) * 320,
    y: origin.y + row * (height + 24),
  }
}

/** 将一次任务的全部输出展开为同级结果节点；不再把候选藏在临时面板里。 */
function materializeGenerationOutputs(document: CanvasDocument, job: GenerationJob, request: GenerationRequest): CanvasDocument {
  const candidates = candidatesFromJob(job, request)
  if (!candidates.length) return document

  const taskResultNodeId = request.taskNodeIds?.resultNodeId ?? job.resultNodeId
  const taskResultNode = taskResultNodeId
    ? document.nodes.find((node) => node.id === taskResultNodeId && node.type === 'result')
    : undefined
  const taskResult = taskResultNode?.type === 'result' ? taskResultNode.data as ResultNodeData : undefined
  const outputOf = taskResult?.outputOf ?? request.taskNodeIds?.generateNodeId ?? job.generateNodeId
  const outputGenerator = outputOf
    ? document.nodes.find((node) => node.id === outputOf && node.type === 'generate')
    : undefined
  const origin = taskResultNode?.position
    ?? (outputGenerator ? { x: outputGenerator.position.x + 372, y: outputGenerator.position.y + 28 } : { x: 770, y: 155 })
  const existingCandidateIds = new Set(document.nodes
    .filter((node) => node.type === 'result')
    .map((node) => (node.data as ResultNodeData).candidateId)
    .filter((candidateId): candidateId is string => Boolean(candidateId)))
  const reusableTaskNode = taskResultNode && !taskResult?.image && !taskResult?.candidateId
    ? taskResultNode
    : undefined
  let taskNodeUsed = false

  const createResultNode = (candidate: GenerationCandidate, nodeId: string, position: XYPosition): CanvasNode => ({
    id: nodeId,
    type: 'result',
    position,
    draggable: true,
    selected: false,
    data: {
      ...(taskResult ?? {}),
      kind: 'result',
      outputOf,
      image: candidate.image,
      selected: false,
      status: 'ready',
      taskStatus: 'succeeded',
      submittedAt: taskResult?.submittedAt ?? job.createdAt,
      label: candidate.name,
      jobId: job.id,
      taskNodeId: nodeId,
      error: undefined,
      candidateId: candidate.id,
      versionId: undefined,
      parentVersionId: candidate.parentVersionId,
      generationKind: candidate.kind,
      refinementInstruction: candidate.refinementInstruction,
      generationSettings: cloneGenerationSettings(candidate.settings),
      generationRecipe: cloneGenerationRecipe(candidate.recipe),
      rootRecipe: cloneGenerationRecipe(candidate.rootRecipe ?? candidate.recipe),
      variant: candidate.variant,
    },
  })

  const nodes = document.nodes.map((node) => {
    if (!reusableTaskNode || node.id !== reusableTaskNode.id || taskNodeUsed) return node
    const candidate = candidates.find((item) => !existingCandidateIds.has(item.id))
    if (!candidate) return node
    taskNodeUsed = true
    existingCandidateIds.add(candidate.id)
    return createResultNode(candidate, node.id, resultGridPosition(origin, candidate))
  }) as CanvasNode[]
  const extraNodes: CanvasNode[] = []
  const extraEdges: Edge[] = []
  for (const candidate of candidates) {
    if (existingCandidateIds.has(candidate.id)) continue
    const nodeId = `result-${candidate.id}`
    existingCandidateIds.add(candidate.id)
    extraNodes.push(createResultNode(candidate, nodeId, resultGridPosition(origin, candidate)))
    if (outputOf && !document.edges.some((edge) => edge.source === outputOf && edge.target === nodeId)) {
      extraEdges.push({
        id: `output-edge-${job.id}-${candidate.id}`,
        source: outputOf,
        sourceHandle: 'output',
        target: nodeId,
        targetHandle: 'input',
        type: 'default',
        style: { stroke: '#2a5238', strokeWidth: 1.7 },
        data: { system: true, role: 'output' },
        reconnectable: false,
      })
    }
  }
  if (!taskNodeUsed && !extraNodes.length) return document
  return { ...document, nodes: [...nodes, ...extraNodes], edges: [...document.edges, ...extraEdges] }
}

/**
 * 真实任务的输出图保存在项目文档中。无论从刷新、路由恢复还是切回项目进入，
 * 都必须从同一份持久化任务状态恢复候选图或继续轮询，不能只恢复种子画布。
 */
function persistedGenerationState(document: CanvasDocument, fallbackMessage: string): { state: PersistedGenerationState; pollJobId?: string } {
  const idleState: PersistedGenerationState = {
    assistantMessage: fallbackMessage,
    generationStatus: 'idle',
    generationProgress: 0,
    generationError: null,
    expectedCandidateCount: 0,
    generationCandidates: [],
    lastGenerationRequest: null,
  }
  const latestJob = [...document.generationJobs].sort((left, right) => right.updatedAt - left.updatedAt)[0]
  const request = latestJob ? requestFromPersistedJob(document, latestJob) : null
  if (!latestJob || !request) return { state: idleState }

  if (latestJob.status === 'queued' || latestJob.status === 'running') {
    return {
      state: {
        ...idleState,
        lastGenerationRequest: request,
        generationStatus: latestJob.status,
        expectedCandidateCount: latestJob.batchCount,
        assistantMessage: '已恢复真实生成任务，正在同步图像服务状态。',
      },
      pollJobId: latestJob.id,
    }
  }

  if (latestJob.status === 'succeeded' && latestJob.outputs?.length) {
    return {
      state: {
        ...idleState,
        lastGenerationRequest: { ...request, jobId: latestJob.id },
        assistantMessage: `已恢复 ${latestJob.outputs.length} 张生成结果；每张图都保留在画布中。`,
      },
    }
  }

  if (latestJob.status === 'failed') {
    const message = latestJob.error ?? '真实生图任务失败，请重试。'
    return {
      state: {
        ...idleState,
        lastGenerationRequest: { ...request, jobId: latestJob.id },
        generationStatus: 'error',
        generationError: message,
        expectedCandidateCount: latestJob.batchCount,
        assistantMessage: message,
      },
    }
  }

  if (latestJob.status === 'cancelled') {
    return {
      state: {
        ...idleState,
        assistantMessage: '上一次真实生成任务已取消；提示词、参考组和节点记录仍可继续使用。',
      },
    }
  }

  return { state: idleState }
}

function syncGenerationJob(
  set: (next: Partial<CanvasStore>) => void,
  get: () => CanvasStore,
  job: GenerationJob,
) {
  const request = get().lastGenerationRequest
  if (!request?.taskNodeIds || request.jobId !== job.id) return

  const recordedDocument = recordGenerationJob(get().document, job, request.taskNodeIds)
  if (job.status === 'succeeded') {
    const recordedJob = recordedDocument.generationJobs.find((item) => item.id === job.id) ?? job
    const candidates = candidatesFromJob(recordedJob, request)
    const document = materializeGenerationOutputs(recordedDocument, recordedJob, request)
    commit(set, document, {
      generationStatus: 'idle',
      generationProgress: 0,
      generationError: candidates.length ? null : '真实生图未返回候选图，请重试。',
      expectedCandidateCount: 0,
      generationCandidates: [],
      assistantMessage: candidates.length
        ? `真实生成已完成：${candidates.length} 张图片已作为独立节点写入画布；不需要的可直接删除。`
        : '真实生图没有返回候选图，请重试。',
    })
    return
  }

  if (job.status === 'failed') {
    commit(set, recordedDocument, {
      generationStatus: 'error',
      generationProgress: 0,
      generationError: job.error ?? '真实生图任务失败，请重试。',
      expectedCandidateCount: 0,
      generationCandidates: [],
      assistantMessage: job.error ?? '真实生图任务失败，请重试。',
    })
    return
  }

  if (job.status === 'cancelled') {
    commit(set, recordedDocument, {
      generationStatus: 'idle',
      generationProgress: 0,
      generationError: null,
      expectedCandidateCount: 0,
      generationCandidates: [],
      assistantMessage: '已取消真实生成任务；画布保留本次的提示词、参考组与任务记录。',
    })
    return
  }

  commit(set, recordedDocument, {
    generationStatus: job.status,
    generationProgress: 0,
    generationError: null,
    expectedCandidateCount: job.batchCount,
    assistantMessage: job.status === 'queued' ? '真实生成任务已入队，等待图像服务处理。' : '图像服务正在生成，请保留此页面或稍后返回查看结果。',
  })
}

function pollGenerationJob(
  set: (next: Partial<CanvasStore>) => void,
  get: () => CanvasStore,
  jobId: string,
) {
  stopGenerationPolling()
  const runId = generationPollRunId
  const poll = async () => {
    if (runId !== generationPollRunId) return
    try {
      const job = await getGenerationJob(jobId)
      if (runId !== generationPollRunId) return
      syncGenerationJob(set, get, job)
      if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') {
        generationPollTimerId = null
        return
      }
      generationPollTimerId = window.setTimeout(() => void poll(), 1_250)
    } catch (error) {
      if (runId !== generationPollRunId) return
      if (error instanceof GenerationApiError && error.code === 'JOB_NOT_FOUND') {
        const request = get().lastGenerationRequest
        const message = '生成服务已重启，无法恢复本次任务。请重试。'
        const failedDocument = request?.taskNodeIds
          ? updateTaskNodes(get().document, request.taskNodeIds, 'failed', request.jobId, message)
          : get().document
        const document = {
          ...failedDocument,
          generationJobs: failedDocument.generationJobs.map((job) => job.id === jobId
            ? { ...job, status: 'failed' as const, error: message, updatedAt: Date.now() }
            : job),
        }
        commit(set, document, {
          generationStatus: 'error',
          generationProgress: 0,
          generationError: message,
          generationCandidates: [],
          assistantMessage: message,
        })
        generationPollTimerId = null
        return
      }
      set({ assistantMessage: error instanceof Error ? `${error.message} 任务仍可能在服务端执行。` : '任务状态同步失败，任务仍可能在服务端执行。' })
      generationPollTimerId = window.setTimeout(() => void poll(), 2_000)
    }
  }
  void poll()
}

function cloneSnapshotAsCanvas(snapshotValue: CanvasSnapshot, prefix: string) {
  const timestamp = Date.now()
  const idMap = new Map<string, string>()
  const nodes = snapshotValue.nodes.map((node, index) => {
    const id = `${prefix}-node-${timestamp}-${index}`
    idMap.set(node.id, id)
    const data = node.type === 'result'
      ? { ...node.data, selected: false, versionId: undefined, parentVersionId: undefined }
      : { ...node.data }
    return {
      ...node,
      id,
      selected: false,
      position: { ...node.position },
      data,
    }
  }) as CanvasNode[]

  const edges = snapshotValue.edges.map((edge, index) => ({
    ...edge,
    id: `${prefix}-edge-${timestamp}-${index}`,
    source: idMap.get(edge.source) ?? edge.source,
    target: idMap.get(edge.target) ?? edge.target,
    style: edge.style ? { ...edge.style } : undefined,
  }))

  return { nodes, edges }
}

function historyName(count: number, kind: GenerationCandidate['kind'] = 'generation') {
  const prefix = kind === 'refinement' ? '精修分支' : '首图分支'
  return `${prefix} · v${String(count + 3).padStart(2, '0')}`
}

export const useCanvasStore = create<CanvasStore>((set, get) => ({
  document: seedDocument,
  globalAssets: [],
  hydrated: false,
  persistenceStatus: 'saved',
  selectedNodeId: 'result-hero',
  assistantMessage: '首图已生成并选中。可在下方输入描述，或使用 /、@ 继续微调。',
  generationStatus: 'idle',
  generationProgress: 0,
  generationError: null,
  expectedCandidateCount: 0,
  generationCandidates: [],
  lastGenerationRequest: null,
  availableModels: defaultGenerationModels.map((model) => ({ ...model })),
  maximumBatchCount: 8,
  undoAction: null,
  undoSnapshot: null,

  hydrate: async () => {
    const globalLibrary = await ensureGlobalAssetLibrary(seedGlobalAssets)
    const stored = await readCanvasDocument(seedDocument.id)
    // 示例项目可被删除；没有存档时仅创建内存占位，刷新后不会复活旧 Demo。
    const document = stored
      ? normalizeDocument(stored)
      : createEmptyCanvasDocument('workspace-placeholder', '未命名画布')
    const selectedNode = [...document.nodes].reverse().find((node) => node.selected || (node.type === 'result' && Boolean((node.data as ResultNodeData).selected)))
    const recoveredGeneration = persistedGenerationState(document, document.nodes.length ? `已打开「${document.name}」。` : `「${document.name}」已创建，可以从素材或一句话开始。`)
    set({
      document,
      globalAssets: globalLibrary.assets,
      hydrated: true,
      persistenceStatus: 'saved',
      selectedNodeId: selectedNode?.id ?? null,
      ...recoveredGeneration.state,
    })
    const hasLegacyMockCopy = Boolean(stored && /mock/i.test(JSON.stringify(stored)))
    if (stored && (document.schemaVersion !== stored.schemaVersion || hasLegacyMockCopy || hasCrampedStarterV03Layout(stored.nodes))) {
      try {
        await writeCanvasDocument(document)
        set({ persistenceStatus: 'saved' })
      } catch {
        set({ persistenceStatus: 'error', assistantMessage: '本地初始化保存失败：请先不要刷新。' })
      }
    }
    if (recoveredGeneration.pollJobId) pollGenerationJob(set, get, recoveredGeneration.pollJobId)
  },

  openDocument: async (documentId) => {
    const globalLibrary = await ensureGlobalAssetLibrary(seedGlobalAssets)
    const stored = await readCanvasDocument(documentId)
    if (!stored) return false

    stopGenerationPolling()
    const document = normalizeDocument(stored)
    const selectedNode = [...document.nodes].reverse().find((node) => node.selected || (node.type === 'result' && Boolean((node.data as ResultNodeData).selected)))
    const recoveredGeneration = persistedGenerationState(
      document,
      document.nodes.length ? `已打开「${document.name}」。` : `「${document.name}」已创建，可以从素材或一句话开始。`,
    )
    set({
      document,
      globalAssets: globalLibrary.assets,
      hydrated: true,
      persistenceStatus: 'saved',
      selectedNodeId: selectedNode?.id ?? null,
      ...recoveredGeneration.state,
      undoAction: null,
      undoSnapshot: null,
    })
    if (document.schemaVersion !== stored.schemaVersion || hasCrampedStarterV03Layout(stored.nodes)) {
      try {
        await writeCanvasDocument(document)
        set({ persistenceStatus: 'saved' })
      } catch {
        set({ persistenceStatus: 'error', assistantMessage: '项目迁移保存失败：请先不要刷新。' })
      }
    }
    if (recoveredGeneration.pollJobId) pollGenerationJob(set, get, recoveredGeneration.pollJobId)
    return true
  },

  renameDocument: (name) => {
    const nextName = cleanDisplayName(name, '')
    if (!nextName || nextName === get().document.name) return
    commit(set, { ...get().document, name: nextName }, { assistantMessage: `项目已重命名为「${nextName}」。` })
  },

  setNodes: (nodes) => {
    const normalizedNodes = normalizeGenerateNodeInputs(nodes, get().document.edges)
    const synchronizedNodes = normalizedNodes.map((node) => ({
      ...node,
      data: node.type === 'result'
        ? { ...node.data, selected: Boolean(node.selected) }
        : { ...node.data },
    })) as CanvasNode[]
    const selected = synchronizedNodes.filter((node) => node.selected)
    const document = { ...get().document, nodes: synchronizedNodes }
    commit(set, document, { selectedNodeId: selected.length === 1 ? selected[0].id : null })
  },

  setEdges: (edges) => {
    const normalizedEdges = normalizeSystemOutputEdges(get().document.nodes, edges)
    const document = {
      ...get().document,
      edges: normalizedEdges,
      nodes: normalizeGenerateNodeInputs(get().document.nodes, normalizedEdges),
    }
    commit(set, document)
  },

  setViewport: (viewport) => {
    const document = { ...get().document, viewport }
    commit(set, document)
  },

  selectNode: (selectedNodeId) => {
    if (!selectedNodeId) {
      const nodes = get().document.nodes.map((node) => ({
        ...node,
        selected: false,
        data: node.type === 'result' ? { ...node.data, selected: false } : { ...node.data },
      })) as CanvasNode[]
      commit(set, { ...get().document, nodes }, { selectedNodeId: null })
      return
    }

    const nodes = get().document.nodes.map((node) => ({
      ...node,
      selected: node.id === selectedNodeId,
      data: node.type === 'result'
        ? { ...node.data, selected: node.id === selectedNodeId }
        : { ...node.data },
    })) as CanvasNode[]
    commit(set, { ...get().document, nodes }, { selectedNodeId })
  },

  setAssetReferenceEnabled: (nodeId, referenceEnabled) => {
    const document = get().document
    const target = document.nodes.find((node) => node.id === nodeId)
    if (!target || target.type !== 'asset') return

    const targetAsset = target.data as AssetNodeData
    if (targetAsset.primary && targetAsset.referenceEnabled !== false && !referenceEnabled) {
      const alternateProduct = document.nodes.find((node) => node.type === 'asset'
        && node.id !== nodeId
        && (node.data as AssetNodeData).role === '商品'
        && (node.data as AssetNodeData).referenceEnabled !== false)
      if (!alternateProduct) {
        set({ assistantMessage: `「${targetAsset.name}」是已锁定的主商品。请先加入另一张商品并设为主商品。` })
        return
      }
    }

    let nodes = document.nodes.map((node) => {
      if (node.type !== 'asset') return node
      const asset = node.data as AssetNodeData
      if (node.id !== nodeId) return { ...node, data: { ...asset } }
      return {
        ...node,
        data: {
          ...asset,
          referenceEnabled,
          primary: referenceEnabled ? asset.primary : false,
        },
      }
    }) as CanvasNode[]

    const activeProducts = nodes.filter((node) => node.type === 'asset'
      && (node.data as AssetNodeData).role === '商品'
      && (node.data as AssetNodeData).referenceEnabled !== false)
    const hasPrimaryProduct = activeProducts.some((node) => Boolean((node.data as AssetNodeData).primary))
    if (!hasPrimaryProduct && activeProducts.length) {
      const nextPrimaryId = activeProducts[0].id
      nodes = nodes.map((node) => node.type === 'asset' && node.id === nextPrimaryId
        ? { ...node, data: { ...(node.data as AssetNodeData), primary: true } }
        : node) as CanvasNode[]
    }

    commit(set, { ...document, nodes }, {
      assistantMessage: referenceEnabled
        ? `已让「${targetAsset.name}」参与本次生成。`
        : `已从本次生成参考中排除「${targetAsset.name}」。`,
    })
  },

  setPrimaryProductReference: (nodeId) => {
    const document = get().document
    const target = document.nodes.find((node) => node.id === nodeId)
    if (!target || target.type !== 'asset') return
    const targetAsset = target.data as AssetNodeData
    if (targetAsset.role !== '商品') {
      set({ assistantMessage: '只有「商品」角色可以锁定为主商品。' })
      return
    }

    const nodes = document.nodes.map((node) => {
      if (node.type !== 'asset') return node
      const asset = node.data as AssetNodeData
      if (asset.role !== '商品') return { ...node, data: { ...asset } }
      return {
        ...node,
        data: {
          ...asset,
          referenceEnabled: node.id === nodeId ? true : asset.referenceEnabled !== false,
          primary: node.id === nodeId,
        },
      }
    }) as CanvasNode[]

    commit(set, { ...document, nodes }, {
      assistantMessage: `已锁定「${targetAsset.name}」为本次生成的主商品。`,
    })
  },

  moveGenerationReference: (nodeId, direction) => {
    const document = get().document
    const references = canvasGenerationReferences(document).filter((reference) => reference.enabled)
    const target = references.find((reference) => reference.nodeId === nodeId)
    if (!target) return
    if (target.primary) {
      set({ assistantMessage: '主商品固定为 P1；可调整其余参考的顺序。' })
      return
    }

    const movable = references.filter((reference) => !reference.primary)
    const index = movable.findIndex((reference) => reference.nodeId === nodeId)
    const nextIndex = direction === 'earlier' ? index - 1 : index + 1
    if (index < 0 || nextIndex < 0 || nextIndex >= movable.length) {
      set({ assistantMessage: direction === 'earlier' ? '该参考已排在最前。' : '该参考已排在最后。' })
      return
    }

    const reordered = [...movable]
    ;[reordered[index], reordered[nextIndex]] = [reordered[nextIndex], reordered[index]]
    const ordered = [references.find((reference) => reference.primary), ...reordered].filter(Boolean) as CanvasGenerationReference[]
    const priorityByNodeId = new Map(ordered.map((reference, order) => [reference.nodeId, order + 1]))
    const nodes = document.nodes.map((node) => node.type === 'asset'
      ? {
          ...node,
          data: {
            ...(node.data as AssetNodeData),
            referencePriority: priorityByNodeId.get(node.id) ?? (node.data as AssetNodeData).referencePriority,
          },
        }
      : node) as CanvasNode[]

    commit(set, { ...document, nodes }, {
      assistantMessage: `已调整「${target.name}」的参考优先级。`,
    })
  },

  applyGenerationRecipe: (recipe) => {
    const document = get().document
    const referencesByNodeId = new Map(recipe.references.map((reference) => [reference.nodeId, reference]))
    const referencesByAssetId = new Map<string, GenerationReference[]>()
    for (const reference of recipe.references) {
      referencesByAssetId.set(reference.assetId, [...(referencesByAssetId.get(reference.assetId) ?? []), reference])
    }

    const usedReferences = new Set<GenerationReference>()
    const resolvedNodeIds = new Set<string>()
    const matchReference = (node: CanvasNode) => {
      if (node.type !== 'asset') return undefined
      const asset = node.data as AssetNodeData
      const direct = referencesByNodeId.get(node.id)
      if (direct && !usedReferences.has(direct)) return direct
      return (referencesByAssetId.get(asset.assetId) ?? []).find((reference) => !usedReferences.has(reference))
    }

    let nodes = document.nodes.map((node) => {
      if (node.type !== 'asset') return node
      const asset = node.data as AssetNodeData
      const reference = matchReference(node)
      if (reference) {
        usedReferences.add(reference)
        resolvedNodeIds.add(node.id)
      }
      return {
        ...node,
        data: {
          ...asset,
          referenceEnabled: Boolean(reference),
          primary: Boolean(reference && (reference.primary || reference.nodeId === recipe.primaryReferenceNodeId)),
          referencePriority: reference?.priority ?? asset.referencePriority,
        },
      }
    }) as CanvasNode[]

    const remainingReferences = recipe.references.filter((reference) => !usedReferences.has(reference))
    const existingAssetNodeCount = nodes.filter((node) => node.type === 'asset').length
    const restored = remainingReferences.flatMap((reference, index) => {
      const asset = findAvailableAsset(document, get().globalAssets, reference.assetId)
      if (!asset) return []
      const nodeId = `asset-${asset.id}-restored-${Date.now()}-${index}`
      resolvedNodeIds.add(nodeId)
      return [{
        id: nodeId,
        type: 'asset' as const,
        position: {
          x: 110 + ((existingAssetNodeCount + index) % 3) * 205,
          y: 150 + Math.floor((existingAssetNodeCount + index) / 3) * 250,
        },
        draggable: true,
        data: {
          kind: 'asset' as const,
          assetId: asset.id,
          role: asset.role,
          name: asset.name,
          image: asset.image,
          imageWidth: asset.imageWidth,
          imageHeight: asset.imageHeight,
          source: asset.source,
          referenceEnabled: true,
          primary: Boolean(reference.primary || reference.nodeId === recipe.primaryReferenceNodeId),
          referencePriority: reference.priority,
        },
      }]
    })
    nodes = normalizeAssetReferenceNodes([...nodes, ...restored] as CanvasNode[])

    const unavailable = remainingReferences.length - restored.length
    const restoredCount = nodes.filter((node) => node.type === 'asset' && resolvedNodeIds.has(node.id)).length
    commit(set, { ...document, nodes }, {
      assistantMessage: unavailable
        ? `已恢复 ${restoredCount} 个参考；${unavailable} 个已删除素材未加入下一次草稿。`
        : `已恢复 ${restoredCount} 个参考到下一次生成草稿。`,
    })
  },

  addAssetToCanvas: (assetId, dropPosition) => {
    const document = get().document
    const asset = findAvailableAsset(document, get().globalAssets, assetId)
    if (!asset) return

    const assetNodes = document.nodes.filter((node) => node.type === 'asset')
    const index = assetNodes.length
    const nodeId = `asset-${asset.id}-${Date.now()}`
    const hasPrimaryProduct = assetNodes.some((item) => item.type === 'asset'
      && (item.data as AssetNodeData).role === '商品'
      && (item.data as AssetNodeData).referenceEnabled !== false
      && Boolean((item.data as AssetNodeData).primary))
    const node: CanvasNode = {
      id: nodeId,
      type: 'asset',
      position: dropPosition ?? {
        x: 110 + (index % 3) * 205,
        y: 150 + Math.floor(index / 3) * 250,
      },
      draggable: true,
      selected: true,
      data: {
        kind: 'asset',
        assetId: asset.id,
        role: asset.role,
        name: asset.name,
        image: asset.image,
        imageWidth: asset.imageWidth,
        imageHeight: asset.imageHeight,
        source: asset.source,
        referenceEnabled: true,
        primary: asset.role === '商品' && !hasPrimaryProduct,
        referencePriority: assetNodes.length + 1,
      },
    }

    const nodes = [...document.nodes.map((item) => ({ ...item, selected: false })), node] as CanvasNode[]
    commit(set, { ...document, nodes }, {
      selectedNodeId: nodeId,
      assistantMessage: `已将「${asset.name}」加入画布，可拖拽调整位置。`,
    })
  },

  addUploadedAssets: (uploads) => {
    if (!uploads.length) return

    const document = get().document
    const timestamp = Date.now()
    const assets: AssetRecord[] = uploads.map((upload, index) => ({
      id: `upload-${timestamp}-${index}`,
      role: upload.role,
      name: upload.name.trim() || `上传素材 ${String(index + 1).padStart(2, '0')}`,
      image: upload.image,
      imageWidth: upload.imageWidth,
      imageHeight: upload.imageHeight,
      source: 'upload',
      tags: upload.tags.length ? [...new Set(upload.tags)] : ['上传素材'],
    }))

    commit(set, {
      ...document,
      assets: [...assets, ...document.assets],
    }, {
      assistantMessage: `已将 ${assets.length} 张本地素材存入当前项目素材库。拖入画布后，可将它们作为真实生成参考。`,
    })
  },

  addUploadedAssetsToCanvas: (uploads, dropPosition) => {
    if (!uploads.length) return

    const document = get().document
    const timestamp = Date.now()
    const assets: AssetRecord[] = uploads.map((upload, index) => ({
      id: `upload-${timestamp}-${index}`,
      role: upload.role,
      name: upload.name.trim() || `上传素材 ${String(index + 1).padStart(2, '0')}`,
      image: upload.image,
      imageWidth: upload.imageWidth,
      imageHeight: upload.imageHeight,
      source: 'upload',
      tags: upload.tags.length ? [...new Set(upload.tags)] : ['上传素材'],
    }))
    const existingAssetNodes = document.nodes.filter((node) => node.type === 'asset')
    let hasPrimaryProduct = existingAssetNodes.some((node) => node.type === 'asset'
      && (node.data as AssetNodeData).role === '商品'
      && (node.data as AssetNodeData).referenceEnabled !== false
      && Boolean((node.data as AssetNodeData).primary))
    const basePosition = dropPosition ?? {
      x: 110 + (existingAssetNodes.length % 3) * 205,
      y: 150 + Math.floor(existingAssetNodes.length / 3) * 250,
    }
    const nodes = assets.map((asset, index) => {
      const shouldBePrimary = asset.role === '商品' && !hasPrimaryProduct
      if (shouldBePrimary) hasPrimaryProduct = true
      return {
        id: `asset-${asset.id}`,
        type: 'asset' as const,
        position: {
          x: Math.max(16, basePosition.x + (index % 3) * 198),
          y: Math.max(16, basePosition.y + Math.floor(index / 3) * 246),
        },
        draggable: true,
        selected: index === 0,
        data: {
          kind: 'asset' as const,
          assetId: asset.id,
          role: asset.role,
          name: asset.name,
          image: asset.image,
          imageWidth: asset.imageWidth,
          imageHeight: asset.imageHeight,
          source: 'upload' as const,
          referenceEnabled: true,
          primary: shouldBePrimary,
          referencePriority: existingAssetNodes.length + index + 1,
        },
      }
    }) as CanvasNode[]

    commit(set, {
      ...document,
      assets: [...assets, ...document.assets],
      nodes: [...document.nodes.map((node) => ({ ...node, selected: false })), ...nodes] as CanvasNode[],
    }, {
      selectedNodeId: nodes[0]?.id ?? null,
      assistantMessage: `已将 ${assets.length} 张本地图片直接加入画布，并同步存入当前项目素材库。`,
    })
  },

  addTextNode: (position) => {
    const document = get().document
    const timestamp = Date.now()
    const nodeId = `text-${timestamp}`
    const node: CanvasNode = {
      id: nodeId,
      type: 'text',
      position: position ?? { x: 190, y: 140 },
      draggable: true,
      selected: true,
      data: {
        kind: 'text',
        label: '视觉描述',
        content: '描述商品、场景、构图与留白要求',
      },
    }
    commit(set, {
      ...document,
      nodes: [...document.nodes.map((item) => ({ ...item, selected: false })), node] as CanvasNode[],
    }, {
      selectedNodeId: nodeId,
      assistantMessage: '已创建文本节点；将右侧端口连到生成节点即可作为本次描述。',
    })
  },

  addGenerateNode: (position) => {
    const document = get().document
    const timestamp = Date.now()
    const nodeId = `generate-${timestamp}`
    const node: CanvasNode = {
      id: nodeId,
      type: 'generate',
      position: position ?? { x: 470, y: 240 },
      draggable: true,
      selected: true,
      data: {
        kind: 'generate',
        label: '首图生成',
        prompt: '',
        batchCount: 1,
        settings: {
          model: get().availableModels[0]?.id ?? 'gpt-image-2',
          aspectRatio: '3:4',
          resolution: '2K',
        },
      },
    }
    commit(set, {
      ...document,
      nodes: [...document.nodes.map((item) => ({ ...item, selected: false })), node] as CanvasNode[],
    }, {
      selectedNodeId: nodeId,
      assistantMessage: '已创建生成节点；连接商品图片与文本描述后，可直接在节点内发起生成。',
    })
  },

  createGenerateBranchFromResult: (resultNodeId, draft) => {
    const document = get().document
    const parent = document.nodes.find((node) => node.id === resultNodeId && node.type === 'result')
    if (!parent || parent.type !== 'result') return null
    const result = parent.data as ResultNodeData
    if (!result.image) return null
    const timestamp = Date.now()
    const nodeId = `generate-branch-${timestamp}`
    const recipe = result.generationRecipe
    const defaultSettings = recipe?.settings ?? result.generationSettings
    const node: CanvasNode = {
      id: nodeId,
      type: 'generate',
      position: { x: parent.position.x + 372, y: parent.position.y + 38 },
      draggable: true,
      selected: true,
      data: {
        kind: 'generate',
        label: '基于此图继续生成',
        prompt: draft?.prompt ?? '',
        batchCount: Math.min(get().maximumBatchCount, clampBatchCount(draft?.batchCount ?? recipe?.batchCount ?? 1)),
        settings: cloneGenerationSettings({ ...defaultSettings, ...draft?.settings }),
        inputOrder: [resultNodeId],
      },
    }
    const edge: Edge = {
      id: `branch-input-${timestamp}`,
      source: resultNodeId,
      sourceHandle: 'output',
      target: nodeId,
      targetHandle: 'input',
      type: 'default',
      style: { stroke: '#7e9785', strokeWidth: 1.2, strokeDasharray: '4 3' },
    }
    const nodes = [...document.nodes.map((item) => ({ ...item, selected: false, data: item.type === 'result' ? { ...item.data, selected: false } : { ...item.data } })), node] as CanvasNode[]
    commit(set, { ...document, nodes, edges: [...document.edges, edge] }, {
      selectedNodeId: nodeId,
      assistantMessage: `已基于「${result.label ?? '已选输出'}」创建下一版本生成节点。`,
    })
    return nodeId
  },

  createGenerateFromResultRecipe: (resultNodeId) => {
    const document = get().document
    const resultNode = document.nodes.find((node) => node.id === resultNodeId && node.type === 'result')
    if (!resultNode || resultNode.type !== 'result') return null

    const result = resultNode.data as ResultNodeData
    const recipe = result.rootRecipe ?? result.generationRecipe
    if (!recipe) return null

    const timestamp = Date.now()
    const usedNodeIds = new Set(document.nodes.map((node) => node.id))
    const nodeId = migrationId(`generate-recipe-${timestamp}`, usedNodeIds)
    const orderedReferences = recipe.references
      .map((reference, index) => ({ reference, index }))
      .sort((left, right) => (left.reference.priority ?? left.index + 1) - (right.reference.priority ?? right.index + 1) || left.index - right.index)
    const usedAssetNodeIds = new Set<string>()
    const restoredAssetNodes: CanvasNode[] = []
    const existingAssetNodeCount = document.nodes.filter((node) => node.type === 'asset').length
    const restoredInputs = orderedReferences.flatMap(({ reference }) => {
      const direct = document.nodes.find((node) => node.id === reference.nodeId
        && node.type === 'asset'
        && !usedAssetNodeIds.has(node.id))
      const fallback = direct ?? document.nodes.find((node) => node.type === 'asset'
        && (node.data as AssetNodeData).assetId === reference.assetId
        && !usedAssetNodeIds.has(node.id))
      if (fallback?.type === 'asset') {
        usedAssetNodeIds.add(fallback.id)
        return [{ reference, nodeId: fallback.id }]
      }

      const asset = findAvailableAsset(document, get().globalAssets, reference.assetId)
      if (!asset) return []
      const restoredNodeId = migrationId(`asset-${asset.id}-recipe-${timestamp}`, usedNodeIds)
      restoredAssetNodes.push({
        id: restoredNodeId,
        type: 'asset',
        position: {
          x: 110 + ((existingAssetNodeCount + restoredAssetNodes.length) % 3) * 205,
          y: 150 + Math.floor((existingAssetNodeCount + restoredAssetNodes.length) / 3) * 250,
        },
        draggable: true,
        data: {
          kind: 'asset',
          assetId: asset.id,
          role: asset.role,
          name: asset.name,
          image: asset.image,
          imageWidth: asset.imageWidth,
          imageHeight: asset.imageHeight,
          source: asset.source,
          referenceEnabled: true,
          primary: Boolean(reference.primary || reference.nodeId === recipe.primaryReferenceNodeId),
          referencePriority: reference.priority,
        },
      })
      usedAssetNodeIds.add(restoredNodeId)
      return [{ reference, nodeId: restoredNodeId }]
    })
    const primaryReference = orderedReferences.find(({ reference }) => reference.nodeId === recipe.primaryReferenceNodeId && reference.role === '商品')?.reference
      ?? orderedReferences.find(({ reference }) => reference.role === '商品' && Boolean(reference.primary))?.reference
    const primaryInputId = restoredInputs.find((input) => input.reference === primaryReference)?.nodeId
    const node: CanvasNode = {
      id: nodeId,
      type: 'generate',
      position: { x: Math.max(resultNode.position.x + 372, nextTaskFlowStartX(document.nodes)), y: resultNode.position.y + 38 },
      draggable: true,
      selected: true,
      data: {
        kind: 'generate',
        label: '复用原始参考重做首图',
        prompt: recipe.prompt,
        batchCount: Math.min(get().maximumBatchCount, clampBatchCount(recipe.batchCount)),
        settings: cloneGenerationSettings(recipe.settings),
        inputOrder: restoredInputs.map((input) => input.nodeId),
        primaryInputId,
      },
    }
    const usedEdgeIds = new Set(document.edges.map((edge) => edge.id))
    const restoredEdges: Edge[] = restoredInputs.map((input, index) => ({
      id: migrationId(`recipe-input-${timestamp}-${index}`, usedEdgeIds),
      source: input.nodeId,
      sourceHandle: 'asset-output',
      target: nodeId,
      targetHandle: 'input',
      type: 'default',
      style: { stroke: '#4f805b', strokeWidth: 1.6 },
      reconnectable: true,
    }))
    const edges = [...document.edges, ...restoredEdges]
    const nodes = normalizeGenerateNodeInputs([
      ...document.nodes.map((item) => ({
        ...item,
        selected: false,
        data: item.type === 'result' ? { ...item.data, selected: false } : { ...item.data },
      })),
      ...restoredAssetNodes,
      node,
    ] as CanvasNode[], edges)
    const missingReferenceCount = recipe.references.length - restoredInputs.length

    commit(set, { ...document, nodes, edges }, {
      selectedNodeId: nodeId,
      assistantMessage: missingReferenceCount
        ? `已从「${result.label ?? '已选输出'}」新建独立首图节点，恢复 ${restoredInputs.length} 个原始参考；${missingReferenceCount} 个素材已不在画布中。`
        : `已从「${result.label ?? '已选输出'}」新建独立首图节点，并恢复原始配方与 ${restoredInputs.length} 个参考。`,
    })
    return nodeId
  },

  renameCanvasNode: (nodeId, label) => {
    const nextLabel = cleanDisplayName(label, '')
    if (!nextLabel) return
    const document = get().document
    const nodes = document.nodes.map((node) => {
      if (node.id !== nodeId) return node
      if (node.type === 'asset') return { ...node, data: { ...(node.data as AssetNodeData), name: nextLabel } }
      if (node.type === 'text') return { ...node, data: { ...(node.data as TextNodeData), label: nextLabel } }
      if (node.type === 'generate') return { ...node, data: { ...(node.data as GenerateNodeData), label: nextLabel } }
      if (node.type === 'prompt') return { ...node, data: { ...(node.data as PromptNodeData), label: nextLabel } }
      if (node.type === 'reference') return { ...node, data: { ...(node.data as ReferenceGroupNodeData), label: nextLabel } }
      return { ...node, data: { ...(node.data as ResultNodeData), label: nextLabel } }
    }) as CanvasNode[]
    commit(set, { ...document, nodes })
  },

  updateTextNode: (nodeId, content) => {
    const document = get().document
    const nodes = document.nodes.map((node) => node.id === nodeId && node.type === 'text'
      ? { ...node, data: { ...(node.data as TextNodeData), content } }
      : node) as CanvasNode[]
    commit(set, { ...document, nodes })
  },

  updateGenerateNode: (nodeId, patch) => {
    const document = get().document
    const nodes = document.nodes.map((node) => {
      if (node.id !== nodeId || node.type !== 'generate') return node
      const current = node.data as GenerateNodeData
      return {
        ...node,
        data: {
          ...current,
          ...patch,
          batchCount: patch.batchCount === undefined ? current.batchCount : clampBatchCount(patch.batchCount),
          settings: patch.settings ? cloneGenerationSettings(patch.settings) : cloneGenerationSettings(current.settings),
        },
      }
    }) as CanvasNode[]
    commit(set, { ...document, nodes })
  },

  setGenerateNodePrimaryInput: (nodeId, assetNodeId) => {
    const document = get().document
    const target = document.nodes.find((node) => node.id === assetNodeId && node.type === 'asset')
    const isConnected = document.edges.some((edge) => edge.source === assetNodeId && edge.target === nodeId)
    if (!target || !isConnected) return
    const nodes = document.nodes.map((node) => node.id === nodeId && node.type === 'generate'
      ? { ...node, data: { ...(node.data as GenerateNodeData), primaryInputId: assetNodeId } }
      : node) as CanvasNode[]
    commit(set, { ...document, nodes }, {
      assistantMessage: `已将「${(target.data as AssetNodeData).name}」设为当前生成节点的主商品。`,
    })
  },

  moveGenerateNodeInput: (nodeId, inputNodeId, direction) => {
    const document = get().document
    const generate = document.nodes.find((node) => node.id === nodeId && node.type === 'generate')
    if (!generate || generate.type !== 'generate') return
    const connected = connectedGenerateInputs(document, nodeId).map((node) => node.id)
    const current = generate.data as GenerateNodeData
    const inputOrder = [
      ...(current.inputOrder ?? []).filter((inputId) => connected.includes(inputId)),
      ...connected.filter((inputId) => !(current.inputOrder ?? []).includes(inputId)),
    ]
    const index = inputOrder.indexOf(inputNodeId)
    const nextIndex = direction === 'earlier' ? index - 1 : index + 1
    if (index < 0 || nextIndex < 0 || nextIndex >= inputOrder.length) return
    ;[inputOrder[index], inputOrder[nextIndex]] = [inputOrder[nextIndex], inputOrder[index]]
    const nodes = document.nodes.map((node) => node.id === nodeId && node.type === 'generate'
      ? { ...node, data: { ...(node.data as GenerateNodeData), inputOrder } }
      : node) as CanvasNode[]
    commit(set, { ...document, nodes }, { assistantMessage: '已调整当前生成节点的输入顺序。' })
  },

  setAvailableModels: (models) => {
    const seen = new Set<string>()
    const availableModels = models
      .filter((model) => typeof model?.id === 'string' && model.id.trim())
      .filter((model) => {
        if (seen.has(model.id)) return false
        seen.add(model.id)
        return true
      })
      .map((model) => ({ id: model.id, label: model.label?.trim() || model.id }))
    set({ availableModels: availableModels.length ? availableModels : defaultGenerationModels.map((model) => ({ ...model })) })
  },

  setMaximumBatchCount: (count) => {
    const maximumBatchCount = Math.max(1, Math.round(count) || 1)
    const document = get().document
    const nodes = document.nodes.map((node) => node.type === 'generate'
      ? {
          ...node,
          data: {
            ...(node.data as GenerateNodeData),
            batchCount: Math.min(maximumBatchCount, clampBatchCount((node.data as GenerateNodeData).batchCount)),
          },
        }
      : node) as CanvasNode[]
    commit(set, { ...document, nodes }, { maximumBatchCount })
  },

  runGraphGeneration: async (nodeId) => {
    const graphRecipe = buildGraphGenerationRecipe(get().document, nodeId)
    if (!graphRecipe) return setGenerationError(set, '未找到要执行的生成节点。')
    if (!graphRecipe.prompt.trim()) return setGenerationError(set, '请填写生成描述，或连接一个文本节点。')
    if (graphRecipe.hasUnselectedResultInput) return setGenerationError(set, '上游结果尚未选图；请先在候选中选中一张首图，再继续生成。')
    if (!graphRecipe.recipe.references.length && !graphRecipe.parent) return setGenerationError(set, '请至少连接一张商品图片、参考素材或已选首图。')
    if (graphRecipe.recipe.references.length > 8) return setGenerationError(set, '单个生成节点最多连接 8 张图片参考。')
    if (!primaryGenerationReference(graphRecipe.recipe) && !graphRecipe.parent) return setGenerationError(set, '请在当前生成节点至少连接一张图片作为主参考。')
    if (graphRecipe.parent) {
      return get().runRefinement({
        targetNodeId: graphRecipe.parent.nodeId,
        prompt: graphRecipe.prompt,
        batchCount: graphRecipe.recipe.batchCount,
        settings: graphRecipe.recipe.settings,
        recipe: graphRecipe.recipe,
        sourceGraphNodeId: nodeId,
      })
    }
    return get().runGeneration({
      prompt: graphRecipe.prompt,
      batchCount: graphRecipe.recipe.batchCount,
      settings: graphRecipe.recipe.settings,
      recipe: graphRecipe.recipe,
      sourceGraphNodeId: nodeId,
    })
  },

  removeNodeFromCanvas: (nodeId) => {
    const document = get().document
    const removed = document.nodes.find((node) => node.id === nodeId)
    if (!removed) return

    const nodes = document.nodes.filter((node) => node.id !== nodeId)
    const edges = document.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId)
    const removedResult = removed.type === 'result' ? removed.data as ResultNodeData : undefined
    const generationJobs = removedResult?.jobId && removedResult.candidateId
      ? document.generationJobs.map((job) => {
          if (job.id !== removedResult.jobId) return job
          const dismissedOutputIds = [...new Set([...(job.dismissedOutputIds ?? []), removedResult.candidateId!])]
          const outputs = job.outputs?.filter((output) => output.id !== removedResult.candidateId)
          return { ...job, outputs, outputCount: outputs?.length ?? job.outputCount, dismissedOutputIds }
        })
      : document.generationJobs
    const nodeName = canvasNodeDisplayName(removed)
    const undoId = `undo-remove-node-${Date.now()}`
    clearUndoTimer()
    commit(set, { ...document, nodes: normalizeGenerateNodeInputs(nodes, edges), edges, generationJobs }, {
      selectedNodeId: null,
      assistantMessage: removedResult?.candidateId
        ? `已删除生成结果「${nodeName}」，它不会在下次打开画布时恢复。`
        : `已从画布移除「${nodeName}」。素材库原件仍保留。`,
      undoAction: { id: undoId, label: `已移除「${nodeName}」` },
      undoSnapshot: document,
    })
    undoTimerId = window.setTimeout(() => {
      if (get().undoAction?.id === undoId) set({ undoAction: null, undoSnapshot: null })
    }, 6_000)
  },

  deleteAsset: (assetId) => {
    const document = get().document
    const globalAsset = get().globalAssets.find((item) => item.id === assetId)
    if (globalAsset) {
      // 先在内存和下一次持久化快照中撤销引用；随后所有异步回写都会经过
      // commit 的 revokedGlobalAssetIds 保护，无法把旧引用重新写回来。
      revokedGlobalAssetIds.add(assetId)
      const nextDocument = scrubAssetFromDocument(document, assetId)
      const generationCandidates = get().generationCandidates.map((candidate) => ({
        ...candidate,
        recipe: withoutReference(candidate.recipe, assetId),
        rootRecipe: candidate.rootRecipe ? withoutReference(candidate.rootRecipe, assetId) : undefined,
      }))
      const lastGenerationRequest = get().lastGenerationRequest
      const nextLastGenerationRequest = lastGenerationRequest?.recipe
        ? {
            ...lastGenerationRequest,
            recipe: withoutReference(lastGenerationRequest.recipe, assetId),
            rootRecipe: lastGenerationRequest.rootRecipe ? withoutReference(lastGenerationRequest.rootRecipe, assetId) : undefined,
          }
        : lastGenerationRequest
      clearUndoTimer()
      commit(set, nextDocument, {
        globalAssets: get().globalAssets.filter((item) => item.id !== assetId),
        selectedNodeId: null,
        generationCandidates,
        lastGenerationRequest: nextLastGenerationRequest,
        assistantMessage: `正在从全局品牌素材库删除「${globalAsset.name}」并清理所有项目引用…`,
        undoAction: null,
        undoSnapshot: null,
      })
      void deleteGlobalAssetAndScrubDocuments(assetId, scrubAssetFromDocument)
        .then(({ deleted, library, documents }) => {
          const activeDocument = scrubAssetFromDocument(get().document, assetId)
          const selectedNode = [...activeDocument.nodes].reverse().find((node) => node.selected || (node.type === 'result' && Boolean((node.data as ResultNodeData).selected)))
          const activeCandidates = get().generationCandidates.map((candidate) => ({
            ...candidate,
            recipe: withoutReference(candidate.recipe, assetId),
            rootRecipe: candidate.rootRecipe ? withoutReference(candidate.rootRecipe, assetId) : undefined,
          }))
          const activeRequest = get().lastGenerationRequest
          const nextActiveRequest = activeRequest?.recipe
            ? {
                ...activeRequest,
                recipe: withoutReference(activeRequest.recipe, assetId),
                rootRecipe: activeRequest.rootRecipe ? withoutReference(activeRequest.rootRecipe, assetId) : undefined,
              }
            : activeRequest
          set({
            document: activeDocument,
            globalAssets: library.assets,
            selectedNodeId: selectedNode?.id ?? null,
            generationCandidates: activeCandidates,
            lastGenerationRequest: nextActiveRequest,
            assistantMessage: deleted
              ? `已从全局品牌素材库删除「${globalAsset.name}」，并同步清理 ${documents.length} 个项目中的画布、模板与历史配方引用。`
              : `「${globalAsset.name}」已不在全局品牌素材库，当前项目引用已同步移除。`,
            undoAction: null,
            undoSnapshot: null,
          })
        })
        .catch(() => {
          revokedGlobalAssetIds.delete(assetId)
          const currentGlobalAssets = get().globalAssets
          set({
            globalAssets: currentGlobalAssets.some((item) => item.id === assetId)
              ? currentGlobalAssets
              : [globalAsset, ...currentGlobalAssets],
            assistantMessage: `全局删除「${globalAsset.name}」失败；当前项目引用已移除，可重试全局下架。`,
          })
        })
      return
    }

    const asset = document.assets.find((item) => item.id === assetId)
    if (!asset) return
    const nextDocument = scrubAssetFromDocument(document, assetId)
    const generationCandidates = get().generationCandidates.map((candidate) => ({
      ...candidate,
      recipe: withoutReference(candidate.recipe, assetId),
      rootRecipe: candidate.rootRecipe ? withoutReference(candidate.rootRecipe, assetId) : undefined,
    }))
    const lastGenerationRequest = get().lastGenerationRequest
    const nextLastGenerationRequest = lastGenerationRequest?.recipe
      ? {
          ...lastGenerationRequest,
          recipe: withoutReference(lastGenerationRequest.recipe, assetId),
          rootRecipe: lastGenerationRequest.rootRecipe ? withoutReference(lastGenerationRequest.rootRecipe, assetId) : undefined,
        }
      : lastGenerationRequest

    const undoId = `undo-delete-asset-${Date.now()}`
    clearUndoTimer()
    commit(set, nextDocument, {
      selectedNodeId: null,
      generationCandidates,
      lastGenerationRequest: nextLastGenerationRequest,
      assistantMessage: `已从当前项目删除「${asset.name}」，并撤销它在当前画布、模板与历史配方中的后续复用。`,
      undoAction: { id: undoId, label: `已删除「${asset.name}」` },
      undoSnapshot: document,
    })
    undoTimerId = window.setTimeout(() => {
      if (get().undoAction?.id === undoId) set({ undoAction: null, undoSnapshot: null })
    }, 6_000)
  },

  undoLastAction: () => {
    const snapshotValue = get().undoSnapshot
    const action = get().undoAction
    if (!snapshotValue || !action) return

    clearUndoTimer()
    const selectedNode = [...snapshotValue.nodes].reverse().find((node) => node.selected || (node.type === 'result' && Boolean((node.data as ResultNodeData).selected)))
    commit(set, snapshotValue, {
      selectedNodeId: selectedNode?.id ?? null,
      undoAction: null,
      undoSnapshot: null,
      assistantMessage: `已撤销：${action.label}。`,
    })
  },

  saveCurrentAsTemplate: (name) => {
    const document = get().document
    if (!document.nodes.length) {
      set({ assistantMessage: '请先添加素材、描述或生成节点，再保存为模板。' })
      return
    }
    const cleanedName = name.trim() || `${document.name} · 视觉目标`
    const template: CanvasTemplate = {
      id: `template-${Date.now()}`,
      name: cleanedName,
      image: snapshotThumbnail(document.nodes, availableAssets(document, get().globalAssets)[0]?.image ?? ''),
      createdAt: Date.now(),
      sourceHistoryId: document.activeVersionId,
      snapshot: workflowTemplateSnapshot(document, cleanedName),
    }
    commit(set, { ...document, templates: [template, ...document.templates] }, {
      assistantMessage: `已将当前画布沉淀为视觉目标「${cleanedName}」。`,
    })
  },

  createCanvasFromTemplate: (templateId) => {
    const document = get().document
    const template = document.templates.find((item) => item.id === templateId)
    if (!template) return

    const nextName = `${template.name} · 新画布`
    const cloned = cloneSnapshotAsCanvas(template.snapshot, 'template')
    const historyEntry: CanvasHistoryEntry = {
      id: `history-template-${Date.now()}`,
      name: nextName,
      image: template.image,
      createdAt: Date.now(),
      kind: 'template',
      parentVersionId: document.activeVersionId,
      sourceTemplateId: template.id,
      snapshot: {
        name: nextName,
        nodes: cloneNodes(cloned.nodes),
        edges: cloneEdges(cloned.edges),
        viewport: { x: 0, y: 0, zoom: 1 },
      },
    }

    commit(set, {
      ...document,
      name: nextName,
      nodes: cloned.nodes,
      edges: cloned.edges,
      viewport: { x: 0, y: 0, zoom: 1 },
      activeTemplateId: template.id,
      activeVersionId: historyEntry.id,
      history: [...document.history, historyEntry],
    }, {
      selectedNodeId: null,
      assistantMessage: `已从工作流模板「${template.name}」新建画布，可继续补充素材并生成。`,
    })
  },

  createCanvasFromHistory: (historyId) => {
    const document = get().document
    const source = document.history.find((item) => item.id === historyId)
    if (!source) return

    const nextName = `${source.name} · 延展`
    const cloned = cloneSnapshotAsCanvas(source.snapshot, 'history')
    const historyEntry: CanvasHistoryEntry = {
      id: `history-continue-${Date.now()}`,
      name: nextName,
      image: source.image,
      createdAt: Date.now(),
      kind: 'generation',
      parentVersionId: source.id,
      snapshot: {
        name: nextName,
        nodes: cloneNodes(cloned.nodes),
        edges: cloneEdges(cloned.edges),
        viewport: { x: 0, y: 0, zoom: 1 },
      },
    }

    commit(set, {
      ...document,
      name: nextName,
      nodes: cloned.nodes,
      edges: cloned.edges,
      viewport: { x: 0, y: 0, zoom: 1 },
      activeTemplateId: undefined,
      activeVersionId: historyEntry.id,
      history: [...document.history, historyEntry],
    }, {
      selectedNodeId: null,
      assistantMessage: `已基于「${source.name}」创建延展画布，下一次生成会作为它的分支。`,
    })
  },

  restoreHistoryVersion: (historyId) => {
    const document = get().document
    const source = document.history.find((item) => item.id === historyId)
    if (!source) return

    const lastResult = [...source.snapshot.nodes].reverse().find((node) => node.type === 'result')
    const selectedNodeId = lastResult?.id ?? null
    const nodes = cloneNodes(source.snapshot.nodes).map((node) => ({
      ...node,
      selected: node.id === selectedNodeId,
      data: node.type === 'result'
        ? { ...node.data, selected: node.id === selectedNodeId }
        : { ...node.data },
    })) as CanvasNode[]

    commit(set, {
      ...document,
      name: source.snapshot.name,
      nodes,
      edges: cloneEdges(source.snapshot.edges),
      viewport: { ...source.snapshot.viewport },
      activeVersionId: source.id,
    }, {
      selectedNodeId,
      assistantMessage: `已回到「${source.name}」。历史分支均保留，可继续在此版定向精修。`,
    })
  },

  saveHistoryAsTemplate: (historyId) => {
    const document = get().document
    const source = document.history.find((item) => item.id === historyId)
    if (!source) return

    const template: CanvasTemplate = {
      id: `template-history-${Date.now()}`,
      name: `${source.name} · 视觉目标`,
      image: source.image,
      createdAt: Date.now(),
      sourceHistoryId: source.id,
      snapshot: workflowTemplateSnapshotFromSnapshot(source.snapshot, `${source.name} · 视觉目标`),
    }
    commit(set, { ...document, templates: [template, ...document.templates] }, {
      assistantMessage: `已将历史画布「${source.name}」沉淀为可复用视觉目标。`,
    })
  },

  runGeneration: async ({ prompt, batchCount, settings, recipe: inputRecipe, rootRecipe: inputRootRecipe, taskLayout, sourceGraphNodeId }) => {
    if (get().generationStatus !== 'idle' && get().generationStatus !== 'error') return false

    const cleanPrompt = prompt.trim()
    if (!cleanPrompt) return setGenerationError(set, '请先描述你想生成的首图。')

    const document = get().document
    const normalizedBatchCount = clampBatchCount(batchCount)
    const recipe = inputRecipe
      ? cloneGenerationRecipe({
          ...inputRecipe,
          prompt: cleanPrompt,
          batchCount: normalizedBatchCount,
          settings: cloneGenerationSettings(settings),
        })
      : buildGenerationRecipe(document, cleanPrompt, normalizedBatchCount, settings)
    const primaryProduct = primaryGenerationReference(recipe)
    if (!primaryProduct) return setGenerationError(set, '请在当前生成节点至少连接一张图片作为主参考。')

    try {
      await assertGenerationServiceReady()
    } catch (error) {
      return setGenerationError(set, error instanceof Error ? error.message : '真实生图服务暂不可用，请稍后重新检查。')
    }

    const request: GenerationRequest = {
      kind: 'generation',
      prompt: cleanPrompt,
      batchCount: normalizedBatchCount,
      settings: cloneGenerationSettings(settings),
      recipe: cloneGenerationRecipe(recipe),
      rootRecipe: cloneGenerationRecipe(inputRootRecipe ?? recipe),
      parentVersionId: document.activeVersionId,
      taskLayout,
      sourceGraphNodeId,
    }
    const flow = createTaskFlow(document, request)
    const preparedRequest = { ...request, taskNodeIds: flow.taskNodeIds }
    const submissionRunId = ++generationSubmissionRunId
    commit(set, flow.document, {
      generationStatus: 'uploading',
      generationProgress: 0,
      generationError: null,
      expectedCandidateCount: normalizedBatchCount,
      generationCandidates: [],
      lastGenerationRequest: preparedRequest,
      assistantMessage: `正在提交真实任务：主商品「${primaryProduct.name}」与 ${recipe.references.length} 个画布参考。`,
    })

    try {
      const job = await submitGenerationJob({
        projectId: document.id,
        kind: request.kind,
        prompt: request.prompt,
        batchCount: request.batchCount,
        settings: request.settings,
        recipe,
      })
      if (submissionRunId !== generationSubmissionRunId) {
        void cancelGenerationJob(job.id)
        return false
      }
      set({ lastGenerationRequest: scrubRevokedGenerationRequest({ ...preparedRequest, jobId: job.id }) })
      syncGenerationJob(set, get, job)
      if (job.status === 'queued' || job.status === 'running') pollGenerationJob(set, get, job.id)
      return true
    } catch (error) {
      if (submissionRunId !== generationSubmissionRunId) return false
      const message = error instanceof Error ? error.message : '真实生图任务提交失败，请重试。'
      const failedDocument = updateTaskNodes(get().document, flow.taskNodeIds, 'failed', undefined, message)
      commit(set, failedDocument, {
        generationStatus: 'error',
        generationProgress: 0,
        generationError: message,
        expectedCandidateCount: 0,
        generationCandidates: [],
        lastGenerationRequest: preparedRequest,
        assistantMessage: message,
      })
      return false
    }
  },

  runRefinement: async ({ targetNodeId, prompt, batchCount, settings, recipe: inputRecipe, rootRecipe: inputRootRecipe, taskLayout, sourceGraphNodeId }) => {
    if (get().generationStatus !== 'idle' && get().generationStatus !== 'error') return false

    const cleanPrompt = prompt.trim()
    if (!cleanPrompt) return setGenerationError(set, '请先描述要如何精修这张首图。')

    const document = get().document
    const target = document.nodes.find((node) => node.id === targetNodeId)
    if (!target || target.type !== 'result') return setGenerationError(set, '未找到要精修的首图，请重新选择。')

    const result = target.data as ResultNodeData
    if (!result.image) return setGenerationError(set, '请先从真实任务候选中选中一张首图，再进行定向精修。')
    const parentVersionId = result.versionId ?? document.activeVersionId
    const parentLabel = result.label ?? '已选首图'
    const parentImage = result.image
    const normalizedBatchCount = clampBatchCount(batchCount)
    const recipe = inputRecipe
      ? cloneGenerationRecipe({
          ...inputRecipe,
          prompt: cleanPrompt,
          batchCount: normalizedBatchCount,
          settings: cloneGenerationSettings(settings),
        })
      : result.generationRecipe
        ? cloneGenerationRecipe({
            ...result.generationRecipe,
            prompt: cleanPrompt,
            batchCount: normalizedBatchCount,
            settings: cloneGenerationSettings(settings),
          })
        : buildGenerationRecipe(document, cleanPrompt, normalizedBatchCount, settings)
    const rootRecipe = cloneGenerationRecipe(inputRootRecipe ?? result.rootRecipe ?? result.generationRecipe ?? recipe)

    try {
      await assertGenerationServiceReady()
    } catch (error) {
      return setGenerationError(set, error instanceof Error ? error.message : '真实生图服务暂不可用，请稍后重新检查。')
    }

    const request: GenerationRequest = {
      kind: 'refinement',
      prompt: cleanPrompt,
      batchCount: normalizedBatchCount,
      settings: cloneGenerationSettings(settings),
      recipe: cloneGenerationRecipe(recipe),
      rootRecipe,
      targetNodeId,
      parentVersionId,
      parentImage,
      parentLabel,
      taskLayout,
      sourceGraphNodeId,
    }
    const flow = createTaskFlow(document, request, target)
    const preparedRequest = { ...request, taskNodeIds: flow.taskNodeIds }
    const submissionRunId = ++generationSubmissionRunId
    commit(set, flow.document, {
      generationStatus: 'uploading',
      generationProgress: 0,
      generationError: null,
      expectedCandidateCount: normalizedBatchCount,
      generationCandidates: [],
      lastGenerationRequest: preparedRequest,
      assistantMessage: `正在提交「${parentLabel}」的真实精修任务。`,
    })

    try {
      const job = await submitGenerationJob({
        projectId: document.id,
        kind: request.kind,
        prompt: request.prompt,
        batchCount: request.batchCount,
        settings: request.settings,
        recipe,
        parent: { nodeId: targetNodeId, name: parentLabel, image: parentImage },
      })
      if (submissionRunId !== generationSubmissionRunId) {
        void cancelGenerationJob(job.id)
        return false
      }
      set({ lastGenerationRequest: scrubRevokedGenerationRequest({ ...preparedRequest, jobId: job.id }) })
      syncGenerationJob(set, get, job)
      if (job.status === 'queued' || job.status === 'running') pollGenerationJob(set, get, job.id)
      return true
    } catch (error) {
      if (submissionRunId !== generationSubmissionRunId) return false
      const message = error instanceof Error ? error.message : '真实精修任务提交失败，请重试。'
      const failedDocument = updateTaskNodes(get().document, flow.taskNodeIds, 'failed', undefined, message)
      commit(set, failedDocument, {
        generationStatus: 'error',
        generationProgress: 0,
        generationError: message,
        expectedCandidateCount: 0,
        generationCandidates: [],
        lastGenerationRequest: preparedRequest,
        assistantMessage: message,
      })
      return false
    }
  },

  cancelGeneration: () => {
    const request = get().lastGenerationRequest
    if (!request?.taskNodeIds || (get().generationStatus !== 'uploading' && get().generationStatus !== 'queued' && get().generationStatus !== 'running')) return

    generationSubmissionRunId += 1
    stopGenerationPolling()
    const cancelledDocument = updateTaskNodes(get().document, request.taskNodeIds, 'cancelled', request.jobId)
    commit(set, cancelledDocument, {
      generationStatus: 'idle',
      generationProgress: 0,
      generationError: null,
      expectedCandidateCount: 0,
      generationCandidates: [],
      assistantMessage: request.jobId ? '正在取消真实生成任务…' : '已取消本地素材提交。',
    })

    if (!request.jobId) return
    void cancelGenerationJob(request.jobId)
      .then((job) => syncGenerationJob(set, get, job))
      .catch(() => set({ assistantMessage: '取消请求未能同步到服务端，请在任务面板稍后确认状态。' }))
  },

  retryGeneration: async () => {
    const request = get().lastGenerationRequest
    if (!request) return setGenerationError(set, '没有可重试的真实生成任务。')
    if (request.kind === 'refinement' && request.targetNodeId) {
      return get().runRefinement({
        targetNodeId: request.targetNodeId,
        prompt: request.prompt,
        batchCount: request.batchCount,
        settings: request.settings,
        recipe: request.recipe,
        rootRecipe: request.rootRecipe,
        taskLayout: request.taskLayout,
        sourceGraphNodeId: request.sourceGraphNodeId ?? request.taskNodeIds?.generateNodeId,
      })
    }
    return get().runGeneration({
      prompt: request.prompt,
      batchCount: request.batchCount,
      settings: request.settings,
      recipe: request.recipe,
      rootRecipe: request.rootRecipe,
      taskLayout: request.taskLayout,
      sourceGraphNodeId: request.taskNodeIds?.generateNodeId,
    })
  },

  clearGenerationError: () => {
    if (get().generationStatus !== 'error') return
    set({ generationStatus: 'idle', generationError: null })
  },

  selectGenerationCandidate: (candidateId) => {
    const candidate = get().generationCandidates.find((item) => item.id === candidateId)
    if (!candidate) return

    const document = get().document
    const existingSelection = document.nodes.find((node) => node.type === 'result' && (node.data as ResultNodeData).candidateId === candidateId)
    if (existingSelection) {
      get().selectNode(existingSelection.id)
      set({
        generationCandidates: get().generationCandidates.map((item) => ({ ...item, selected: item.id === candidateId })),
        assistantMessage: `已定位到已选输出「${candidate.name}」。`,
      })
      return
    }

    const versionId = `history-generation-${Date.now()}`
    const resultCount = document.nodes.filter((node) => node.type === 'result').length
    const taskResultNode = candidate.resultNodeId
      ? document.nodes.find((node) => node.id === candidate.resultNodeId && node.type === 'result')
      : undefined
    const canReuseTaskOutput = Boolean(taskResultNode && !(taskResultNode.data as ResultNodeData).image)
    const resultNodeId = canReuseTaskOutput ? taskResultNode!.id : `result-${candidate.id}`
    const outputOf = (taskResultNode?.data as ResultNodeData | undefined)?.outputOf
      ?? document.edges.find((edge) => edge.target === taskResultNode?.id && document.nodes.some((node) => node.id === edge.source && node.type === 'generate'))?.source
      ?? get().lastGenerationRequest?.taskNodeIds?.generateNodeId
    const outputGenerator = outputOf
      ? document.nodes.find((node) => node.id === outputOf && node.type === 'generate')
      : undefined
    const parentNode = candidate.parentNodeId
      ? document.nodes.find((node) => node.id === candidate.parentNodeId)
      : undefined
    const baseNodes = document.nodes.map((node) => {
      const data = node.type === 'result' ? { ...node.data, selected: false } : { ...node.data }
      return { ...node, selected: false, data }
    }) as CanvasNode[]
    const resultNode: CanvasNode = {
      id: resultNodeId,
      type: 'result',
      position: {
        x: canReuseTaskOutput ? taskResultNode!.position.x : outputGenerator ? outputGenerator.position.x + 372 : (candidate.kind === 'refinement' && parentNode ? parentNode.position.x + 342 : 770 + (resultCount % 2) * 330),
        y: canReuseTaskOutput ? taskResultNode!.position.y : outputGenerator ? outputGenerator.position.y + 28 + resultCount * 36 : (candidate.kind === 'refinement' && parentNode ? parentNode.position.y + 26 + (resultCount % 3) * 22 : 155 + Math.floor(resultCount / 2) * 430),
      },
      draggable: true,
      selected: true,
      data: {
        ...(taskResultNode?.data as ResultNodeData | undefined),
        kind: 'result',
        outputOf,
        image: candidate.image,
        selected: true,
        status: 'ready',
        label: candidate.name,
        candidateId: candidate.id,
        versionId,
        parentVersionId: candidate.parentVersionId,
        generationKind: candidate.kind,
        refinementInstruction: candidate.refinementInstruction,
        generationSettings: cloneGenerationSettings(candidate.settings),
        generationRecipe: cloneGenerationRecipe(candidate.recipe),
        rootRecipe: cloneGenerationRecipe(candidate.rootRecipe ?? candidate.recipe),
        variant: candidate.variant,
        error: undefined,
      },
    }
    const nodes = canReuseTaskOutput
      ? baseNodes.map((node) => node.id === resultNodeId ? resultNode : node) as CanvasNode[]
      : [...baseNodes, resultNode]
    const edges = !canReuseTaskOutput && outputOf
      ? [...document.edges, {
          id: `output-edge-${candidate.id}`,
          source: outputOf,
          sourceHandle: 'output',
          target: resultNodeId,
          type: 'default',
          style: { stroke: '#2a5238', strokeWidth: 1.7 },
          data: { system: true, role: 'output' },
          reconnectable: false,
        }]
      : document.edges
    const generatedAsset: AssetRecord = {
      id: `generated-${candidate.id}`,
      role: '首图',
      name: candidate.name,
      image: candidate.image,
      source: 'generated',
      tags: [
        '首图',
        '真实生成',
        candidate.provider ?? 'openai-images',
        `${candidate.settings.aspectRatio}`,
        primaryGenerationReference(candidate.recipe) ? `主商品 · ${primaryGenerationReference(candidate.recipe)!.name}` : '继承父版本配方',
        candidate.kind === 'refinement' ? '定向精修' : candidate.sourceAssetNames?.length ? '基于画布参考' : '已选中',
      ],
    }
    const historyEntry: CanvasHistoryEntry = {
      id: versionId,
      name: historyName(document.history.length, candidate.kind),
      image: candidate.image,
      createdAt: Date.now(),
      kind: candidate.kind,
      parentVersionId: candidate.parentVersionId,
      sourceNodeId: candidate.parentNodeId,
      refinementInstruction: candidate.refinementInstruction,
      generationRecipe: cloneGenerationRecipe(candidate.recipe),
      rootRecipe: cloneGenerationRecipe(candidate.rootRecipe ?? candidate.recipe),
      snapshot: {
        name: document.name,
        nodes: cloneNodes(nodes),
        edges: cloneEdges(edges),
        viewport: { ...document.viewport },
      },
    }

    commit(set, {
      ...document,
      nodes,
      edges,
      assets: [generatedAsset, ...document.assets],
      history: [...document.history, historyEntry],
      generationJobs: document.generationJobs,
      activeVersionId: versionId,
    }, {
      selectedNodeId: resultNodeId,
      generationCandidates: get().generationCandidates.map((item) => ({ ...item, selected: item.id === candidateId })),
      assistantMessage: candidate.kind === 'refinement'
        ? `已选中「${candidate.name}」，并从「${candidate.parentLabel ?? '父版本'}」创建 ${historyEntry.name}。其他候选仍可保留为分支。`
        : `已选中「${candidate.name}」，并从当前画布创建 ${historyEntry.name}。其他候选仍可保留为分支。`,
    })
  },

  createLocalDeliveries: ({ targetNodeId, presets, title, subtitle, safeZone }) => {
    const document = get().document
    const target = document.nodes.find((node) => node.id === targetNodeId)
    if (!target || target.type !== 'result' || !presets.length) return

    const result = target.data as ResultNodeData
    if (!result.image) return
    const image = result.image
    const timestamp = Date.now()
    const label = result.label ?? '已选首图'
    const artifacts: DeliveryArtifact[] = presets.map((presetId, index) => ({
      id: `delivery-${targetNodeId}-${presetId}-${timestamp}-${index}`,
      targetNodeId,
      targetVersionId: result.versionId ?? document.activeVersionId,
      targetLabel: label,
      image,
      presetId,
      title: title.trim(),
      subtitle: subtitle.trim(),
      safeZone,
      createdAt: timestamp,
    }))
    const deliveries = [
      ...artifacts,
      ...document.deliveries.filter((item) => item.targetNodeId !== targetNodeId),
    ]

    commit(set, { ...document, deliveries }, {
      assistantMessage: `已为「${label}」派生 ${artifacts.length} 个投放规格。确认预览后即可导出 ZIP 交付包。`,
    })
  },
}))
