import { create } from 'zustand'
import { seedDocument } from '../data/seed'
import { defaultGenerationModels } from '../domain/canvas'
import type { BotanicAgentSession } from '../domain/agent'
import {
  cloneGenerationRecipe,
  cloneGenerationSettings,
  normalizeGenerateNodeInputs,
  primaryGenerationReference,
} from '../domain/generationRecipe'
import { reconcileAgentSessionsAfterDocumentSync } from '../domain/agentCollaboration'
import { isRemoteDocumentConflict } from '../domain/remoteDocumentSync'
import { createLatestOperation } from '../domain/latestOperation'
import type {
  AssetRecord,
  CanvasDocument,
  CanvasHistoryEntry,
  CanvasNode,
  DeliveryArtifact,
  GenerationCandidate,
  GenerationRecipe,
  ResultNodeData,
} from '../domain/canvas'
import {
  deleteGlobalAssetAndScrubDocuments,
  persistAcknowledgedRemoteCanvasPatch,
  writeCanvasDocument,
} from '../lib/db'
import { cancelPersistentBotanicAgentRun, retryPersistentBotanicAgentBranch, submitPersistentBotanicAgentSession } from '../lib/agentApi'
import { serverPersistenceEnabled } from '../lib/productSession'
import { ProductApiError } from '../lib/productSession'
import type { CanvasStore, GenerationRequest } from './canvasStore.types'
import { createCanvasAgentActions } from './canvasAgentActions'
import { createCanvasBatchVariationActions } from './canvasBatchVariationActions'
import { createCanvasGenerationActions } from './canvasGenerationActions'
import { createCanvasDocumentLifecycleActions } from './canvasDocumentLifecycleActions'
import { createCanvasAssetGraphActions } from './canvasAssetGraphActions'
import {
  requestFromPersistedGenerationJob,
} from './canvasGenerationLifecycle'
import {
  cloneEdges,
  cloneNodes,
  scrubAssetFromDocument,
  withoutReference,
} from './canvasDocumentAssets'
import {
  canvasNodeDisplayName,
  normalizeCanvasDocumentBase,
} from './canvasDocumentMigration'
import {
  materializeGenerationOutputs,
  updateTaskNodes,
} from './canvasGenerationProjection'
import { createCanvasTemplateHistoryActions } from './canvasTemplateHistoryActions'

let undoTimerId: number | null = null
const persistenceOperations = createLatestOperation()
/** 当前会话中正在删除或已删除的全局品牌素材，阻止异步任务用旧快照回写引用。 */
const revokedGlobalAssetIds = new Set<string>()

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

function clearUndoTimer() {
  if (undoTimerId !== null) window.clearTimeout(undoTimerId)
  undoTimerId = null
}

function normalizeDocument(stored: CanvasDocument | undefined): CanvasDocument {
  const document = normalizeCanvasDocumentBase(stored, seedDocument)
  // V18 起，同一次任务的每张输出都是画布上的独立结果节点；旧任务在首次打开时补齐。
  return document.generationJobs.reduce((nextDocument, job) => {
    if (job.status === 'succeeded' && job.outputs?.length) {
      const request = requestFromPersistedGenerationJob(nextDocument, job)
      return request ? materializeGenerationOutputs(nextDocument, job, request) : nextDocument
    }
    if (job.status === 'failed' && job.error === '图像服务没有返回结果，请重试。' && job.generateNodeId && job.resultNodeId) {
      return updateTaskNodes(nextDocument, {
        generateNodeId: job.generateNodeId,
        resultNodeId: job.resultNodeId,
      }, 'failed', job.id, job.error)
    }
    return nextDocument
  }, document)
}

function commit(
  set: (next: Partial<CanvasStore>) => void,
  document: CanvasDocument,
  extra: Partial<CanvasStore> = {},
  options: { immediate?: boolean; rejectOnFailure?: boolean } = {},
) {
  const activeProjectId = useCanvasStore.getState().document.id
  if (activeProjectId !== document.id) return Promise.resolve()
  const sanitizedDocument = [...revokedGlobalAssetIds].reduce(
    (current, assetId) => scrubAssetFromDocument(current, assetId),
    document,
  )
  const nextDocument = { ...sanitizedDocument, updatedAt: Date.now() }
  const operationToken = persistenceOperations.begin()
  set({ document: nextDocument, persistenceStatus: 'saving', ...scrubRevokedStoreExtra(extra) })
  const persistence = writeCanvasDocument(nextDocument, { immediate: options.immediate })
    .then((savedDocument) => {
      const current = useCanvasStore.getState().document
      if (nextDocument.id === current.id && persistenceOperations.isCurrent(operationToken)) {
        const incoming = savedDocument ?? nextDocument
        set({
          document: {
            ...incoming,
            agentSessions: reconcileAgentSessionsAfterDocumentSync(current.agentSessions, incoming.agentSessions),
          },
          persistenceStatus: 'saved',
        })
      }
    })
    .catch(async (error) => {
      if (nextDocument.id !== useCanvasStore.getState().document.id || !persistenceOperations.isCurrent(operationToken)) {
        // 这是正常的写入合并：较新的本地快照已经接管当前项目，旧写入
        // 即使失败也不能冒泡成“请重新提交 Agent”的未捕获 Promise 错误。
        return
      }
      if (isRemoteDocumentConflict(error)) {
        // db 层已经以增量重试并保护 Worker 输出；仍冲突时保留本地草稿，
        // 不再整份刷新远端（那会丢掉当前编辑），让用户明确看到可恢复状态。
        set({
          persistenceStatus: 'conflict',
          assistantMessage: '云端已有新的画布编辑，本地草稿已保留；请稍后重试同步。',
        })
        if (options.rejectOnFailure) throw new Error('云端已有新的画布编辑，本地草稿已保留，请稍后重试同步。')
        return
      }
      if (error instanceof ProductApiError && error.status === 0) {
        set({
          persistenceStatus: 'offline',
          assistantMessage: '云端暂时不可用，已保存到本地草稿；恢复网络后会自动同步。',
        })
        if (options.rejectOnFailure) throw new Error('参考图片已上传，但画布尚未同步到云端，请恢复网络后重试。')
        return
      }
      set({
        persistenceStatus: 'error',
        assistantMessage: '云端保存暂时失败，本地草稿已保留；请稍后重试。',
      })
      if (options.rejectOnFailure) throw new Error('参考图片已上传，但画布保存失败，请稍后重试。')
    })
  return persistence
}


function historyName(count: number, kind: GenerationCandidate['kind'] = 'generation') {
  const prefix = kind === 'refinement' ? '精修分支' : '首图分支'
  return `${prefix} · v${String(count + 3).padStart(2, '0')}`
}


export const useCanvasStore = create<CanvasStore>((set, get) => {
  const agentSessionPersistence = new Map<string, Promise<BotanicAgentSession | undefined>>()
  const agentSessionRevisions = new Map<string, number>()
  const persistAgentSession = (projectId: string, snapshot: BotanicAgentSession) => {
    if (!serverPersistenceEnabled || projectId === 'workspace-placeholder') return Promise.resolve(undefined)
    const key = `${projectId}\u0000${snapshot.id}`
    const previous = agentSessionPersistence.get(key) ?? Promise.resolve(undefined)
    const operation = previous.then(async () => {
      const current = get().document.id === projectId
        ? get().document.agentSessions.find((session) => session.id === snapshot.id)
        : undefined
      const revision = Math.max(
        agentSessionRevisions.get(key) ?? 0,
        snapshot.revision ?? 0,
        current?.revision ?? 0,
      )
      const saved = await submitPersistentBotanicAgentSession(projectId, { ...snapshot, revision })
      agentSessionRevisions.set(key, saved.revision ?? revision)
      if (get().document.id === projectId) {
        const document = get().document
        set({
          document: {
            ...document,
            agentSessions: document.agentSessions.map((session) => session.id === saved.id
              ? { ...session, revision: Math.max(session.revision ?? 0, saved.revision ?? revision) }
              : session),
          },
        })
      }
      return saved
    })
    agentSessionPersistence.set(key, operation)
    void operation.finally(() => {
      if (agentSessionPersistence.get(key) === operation) agentSessionPersistence.delete(key)
    }).catch(() => undefined)
    return operation
  }
  const generation = createCanvasGenerationActions({
    set,
    get,
    commitDocument: (document, extra, options) => commit(set, document, extra, options),
    normalizeDocument,
    scrubGenerationRequest: scrubRevokedGenerationRequest,
  })
  const documentLifecycle = createCanvasDocumentLifecycleActions({
    set,
    get,
    normalizeDocument,
    invalidatePersistence: () => persistenceOperations.invalidate(),
    stopGenerationPolling: generation.stopPolling,
    pollGenerationJob: generation.pollJob,
    recoverGenerationResults: generation.recoverResults,
  })
  const assetGraphActions = createCanvasAssetGraphActions({
    set,
    get,
    commitDocument: (document, extra, options) => commit(set, document, extra, options),
  })
  return ({
  document: seedDocument,
  globalAssets: [],
  sharedTemplates: [],
  hydrated: false,
  persistenceStatus: 'saved',
  selectedNodeId: 'result-hero',
  assistantMessage: '',
  generationStatus: 'idle',
  generationProgress: 0,
  generationError: null,
  expectedCandidateCount: 0,
  generationCandidates: [],
  lastGenerationRequest: null,
  availableModels: defaultGenerationModels.map((model) => ({ ...model })),
  unavailableModels: [],
  maximumBatchCount: 8,
  undoAction: null,
  undoSnapshot: null,

  ...documentLifecycle,
  ...assetGraphActions,



  ...createCanvasAgentActions({
    set,
    get,
    commitDocument: (document, extra, options) => commit(set, document, extra, options),
    persistentAgentRunApi: {
      retryBranch: retryPersistentBotanicAgentBranch,
      cancelRun: cancelPersistentBotanicAgentRun,
    },
    persistAcknowledgedRemotePatch: persistAcknowledgedRemoteCanvasPatch,
    persistAgentSession,
  }),

  ...createCanvasBatchVariationActions({
    set,
    get,
    commitDocument: (document, extra, options) => commit(set, document, extra, options),
    stopGenerationPolling: generation.stopPolling,
    createGenerationSubmissionKey: generation.createSubmissionKey,
  }),

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
              ? `已从全局品牌素材库删除「${globalAsset.name}」，并同步清理 ${documents.length} 个项目中的画布、模板与历史参数引用。`
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
      assistantMessage: `已从当前项目删除「${asset.name}」，并撤销它在当前画布、模板与历史参数中的后续复用。`,
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

  ...createCanvasTemplateHistoryActions({ set, get, commit }),

  clearAssistantMessage: () => set({ assistantMessage: '' }),

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
        mediaKind: candidate.mediaKind ?? 'image',
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
      mediaKind: candidate.mediaKind ?? 'image',
      collection: '生成结果',
      tags: [
        candidate.mediaKind === 'video' ? '视频' : '首图',
        '真实生成',
        candidate.provider ?? 'openai-images',
        `${candidate.settings.aspectRatio}`,
        primaryGenerationReference(candidate.recipe) ? `主商品 · ${primaryGenerationReference(candidate.recipe)!.name}` : '继承父版本参数',
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
        ? `已选中「${candidate.name}」，并从「${candidate.parentLabel ?? '父版本'}」创建 ${historyEntry.name}。其他结果仍可保留为分支。`
        : `已选中「${candidate.name}」，并从当前画布创建 ${historyEntry.name}。其他结果仍可保留为分支。`,
    })
  },

  ...generation.actions,

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
  })
})
