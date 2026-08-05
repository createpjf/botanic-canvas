import { create } from 'zustand'
import type { Edge, XYPosition } from '@xyflow/react'
import { createEmptyCanvasDocument, seedDocument, seedGlobalAssets } from '../data/seed'
import { defaultGenerationModels } from '../domain/canvas'
import { normalizeAssetCollection, normalizeAssetRecord } from '../domain/assets'
import { normalizeAssetGroupName, normalizeAssetGroups, removeAssetFromGroups, upsertCollectionGroups } from '../domain/assetGroups'
import { createBatchVariationRun, mapBatchVariationWithConcurrency, summarizeBatchVariationRun } from '../domain/batchVariations'
import { mergeCollaborativeCanvasGraph } from '../domain/collaborativeGraph'
import { findOpenGeneratePosition, planGenerateNodeCreation } from '../domain/generateNodeCreation'
import { planGenerationOutputPlacement } from '../domain/generationOutputPlacement'
import { generationTaskResultLabel } from '../domain/canvasPresentation'
import { generationSubmissionFailureDisposition } from '../domain/generationSubmission'
import {
  buildGenerationRecipe,
  buildGraphGenerationRecipe,
  canvasGenerationReferences,
  clampBatchCount,
  cloneGenerationRecipe,
  cloneGenerationSettings,
  connectedGenerateInputs,
  defaultSettingsForModel,
  normalizeGenerateNodeInputs,
  primaryGenerationReference,
} from '../domain/generationRecipe'
import type { CanvasGenerationReference } from '../domain/generationRecipe'
import { isRemoteDocumentConflict, resolveRemoteCanvasRefresh } from '../domain/remoteDocumentSync'
import { createLatestOperation } from '../domain/latestOperation'
import { assignVideoInputRoles } from '../domain/videoGeneration'
import { replaceMediaSources as replaceDocumentMediaSources } from '../domain/agentMedia'
import { createBotanicAgentMemoryItem } from '../domain/agent'
import type { BotanicAgentRun } from '../domain/agent'
import type {
  AssetRecord,
  AssetGroup,
  BatchVariationRun,
  AssetNodeData,
  CanvasDocument,
  CanvasGenerationTaskStatus,
  CanvasHistoryEntry,
  CanvasNode,
  DeliveryArtifact,
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
} from '../domain/canvas'
import {
  deleteGlobalAssetAndScrubDocuments,
  ensureGlobalAssetLibrary,
  readGlobalWorkflowTemplateLibrary,
  readCanvasDocument,
  readLatestCanvasDocument,
  persistAcceptedRemoteCanvasDocument,
  flushPendingCanvasDocumentWrites,
  renameCanvasProject,
  writeGlobalAssetLibrary,
  writeCanvasDocument,
} from '../lib/db'
import { ProductApiError, serverPersistenceEnabled } from '../lib/productSession'
import { assertGenerationServiceReady, cancelGenerationJob, GenerationApiError, getGenerationJob, listProjectGenerationJobs, reconcileProjectGenerationResults, submitGenerationJob } from '../lib/generationApi'
import type { CanvasStore, GenerationRequest, TaskNodeIds } from './canvasStore.types'
import { createCanvasAgentActions } from './canvasAgentActions'
import {
  requestFromGenerationTaskNode,
  requestFromPersistedGenerationJob,
  requestFromUnknownGenerationSubmission,
  restoreGenerationLifecycleState,
} from './canvasGenerationLifecycle'
import {
  availableAssets,
  cloneEdges,
  cloneNodes,
  findAvailableAsset,
  normalizeSystemOutputEdges,
  scrubAssetFromDocument,
  withoutReference,
} from './canvasDocumentAssets'
import {
  canvasNodeDisplayName,
  cleanDisplayName,
  hasCrampedStarterV03Layout,
  migrationId,
  migrationInputEdge,
  nextTaskFlowStartX,
  normalizeAssetReferenceNodes,
  normalizeCanvasDocumentBase,
} from './canvasDocumentMigration'
import {
  applyGenerationJobToDocument,
  candidatesFromJob,
  createTaskFlow,
  materializeGenerationOutputs,
  recordGenerationJob,
  settleExpiredGenerationSubmissions,
  updateBatchVariationItemDocument,
  updateTaskNodes,
} from './canvasGenerationProjection'
import { createCanvasTemplateHistoryActions } from './canvasTemplateHistoryActions'

let generationPollTimerId: number | null = null
let generationPollRunId = 0
let generationSubmissionRunId = 0

function createGenerationSubmissionKey() {
  const uuid = globalThis.crypto?.randomUUID?.()
  return `gen_${(uuid ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`).replaceAll('-', '')}`
}
let undoTimerId: number | null = null
const persistenceOperations = createLatestOperation()
const openDocumentOperations = createLatestOperation()
const activeBatchVariationRuns = new Set<string>()
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

function stopGenerationPolling() {
  if (generationPollTimerId !== null) window.clearTimeout(generationPollTimerId)
  generationPollTimerId = null
  generationPollRunId += 1
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

/**
 * 服务端回填可能与 React Flow 的节点测量、选中态更新同时返回。
 * 这里只合并权威任务记录，再基于当前画布展开图片，避免用打开时的旧快照
 * 覆盖用户刚发生的布局或新一轮生成。
 */
function mergeRecoveredGenerationJobs(current: CanvasDocument, recovered: CanvasDocument) {
  const jobsById = new Map(current.generationJobs.map((job) => [job.id, job]))
  for (const job of recovered.generationJobs) {
    const existing = jobsById.get(job.id)
    if (!existing
      || job.updatedAt > existing.updatedAt
      || (job.outputs?.length ?? 0) > (existing.outputs?.length ?? 0)) {
      jobsById.set(job.id, job)
    }
  }
  return normalizeDocument({
    ...current,
    generationJobs: [...jobsById.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, 60),
  })
}

function resultImageCount(document: CanvasDocument) {
  return document.nodes.filter((node) => node.type === 'result' && Boolean((node.data as ResultNodeData).image)).length
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
      if (nextDocument.id === useCanvasStore.getState().document.id && persistenceOperations.isCurrent(operationToken)) {
        set({ document: savedDocument ?? nextDocument, persistenceStatus: 'saved' })
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

async function applyGenerationSubmissionFailure(
  set: (next: Partial<CanvasStore>) => void,
  get: () => CanvasStore,
  request: GenerationRequest & { taskNodeIds: TaskNodeIds },
  error: unknown,
) {
  const disposition = generationSubmissionFailureDisposition(error)
  const fallbackMessage = request.kind === 'refinement'
    ? '真实精修任务提交失败，请重试。'
    : '真实生图任务提交失败，请重试。'
  const message = disposition.message ?? fallbackMessage
  const nextDocument = updateTaskNodes(
    get().document,
    request.taskNodeIds,
    disposition.taskStatus,
    undefined,
    message,
  )
  if (disposition.kind === 'recovering') {
    await commit(set, nextDocument, {
      generationStatus: 'recovering',
      generationProgress: 0,
      generationError: null,
      expectedCandidateCount: request.batchCount,
      generationCandidates: [],
      lastGenerationRequest: request,
      assistantMessage: message,
    }, { immediate: true })
    return false
  }
  void commit(set, nextDocument, {
    generationStatus: 'error',
    generationProgress: 0,
    generationError: message,
    expectedCandidateCount: 0,
    generationCandidates: [],
    lastGenerationRequest: request,
    assistantMessage: message,
  })
  return false
}

function recoverTaskNodeJobs(
  set: (next: Partial<CanvasStore>) => void,
  get: () => CanvasStore,
  documentId: string,
) {
  const document = get().document
  const requests = new Map<string, GenerationRequest>()
  for (const node of document.nodes) {
    if (node.type !== 'result') continue
    const result = node.data as ResultNodeData
    // 只恢复尚未落图的任务组首节点；批量任务的其他占位节点共用同一 jobId。
    if (result.image || !result.jobId || (result.taskGroupId && node.id !== result.taskGroupId)) continue
    const request = requestFromGenerationTaskNode(document, node)
    if (request?.jobId) requests.set(request.jobId, request)
  }

  // 兼容旧任务：早期版本只把 jobId 写在生成节点，结果占位节点没有 jobId。
  // 这正是“已完成但仍等待结果”的典型遗留状态。
  for (const node of document.nodes) {
    if (node.type !== 'generate') continue
    const generate = node.data as GenerateNodeData
    if (!generate.jobId || requests.has(generate.jobId)) continue
    const taskResultNode = document.nodes.find((candidate) => {
      if (candidate.type !== 'result') return false
      const result = candidate.data as ResultNodeData
      return result.outputOf === node.id
        && !result.image
        && (!result.taskGroupId || candidate.id === result.taskGroupId)
    })
    if (!taskResultNode || taskResultNode.type !== 'result') continue
    const request = requestFromGenerationTaskNode(document, {
      ...taskResultNode,
      data: { ...(taskResultNode.data as ResultNodeData), jobId: generate.jobId },
    } as CanvasNode)
    if (request?.jobId) requests.set(request.jobId, request)
  }

  for (const request of requests.values()) {
    void getGenerationJob(request.jobId!)
      .then((job) => {
        if (get().document.id !== documentId) return
        // 同一页面已有更晚一次任务时，仍只回收对应 jobId，不覆盖用户正在编辑的任务。
        set({ lastGenerationRequest: request })
        syncGenerationJob(set, get, job)
        if (job.status === 'queued' || job.status === 'running') pollGenerationJob(set, get, job.id)
      })
      // 恢复失败不把可继续编辑的画布变成错误页；轮询或下次打开会再次尝试。
      .catch(() => undefined)
  }

  // 再兜底一次：极早期或异常中断的前端既没有把 jobId 写入结果节点，也没有写入生成节点。
  // 服务端任务表是权威来源；按任务类型与提交时间一一对应，且只回填尚无图片的任务组首节点。
  const unresolvedTaskNodes = document.nodes.filter((node) => {
    if (node.type !== 'result') return false
    const result = node.data as ResultNodeData
    return !result.image && (!result.taskGroupId || node.id === result.taskGroupId)
  })
  if (!unresolvedTaskNodes.length) return

  void listProjectGenerationJobs(documentId)
    .then((jobs) => {
      if (get().document.id !== documentId) return
      const usedJobIds = new Set(requests.keys())
      const candidates = jobs
        .filter((job) => !usedJobIds.has(job.id) && job.status === 'succeeded' && Boolean(job.outputs?.length))
        .sort((left, right) => left.createdAt - right.createdAt)
      for (const taskResultNode of unresolvedTaskNodes) {
        const result = taskResultNode.data as ResultNodeData
        const kind = result.generationKind ?? 'generation'
        const matching = candidates
          .filter((job) => !usedJobIds.has(job.id) && job.kind === kind)
          .sort((left, right) => Math.abs(left.createdAt - (result.submittedAt ?? left.createdAt)) - Math.abs(right.createdAt - (result.submittedAt ?? right.createdAt)))[0]
        if (!matching) continue
        const request = requestFromGenerationTaskNode(get().document, {
          ...taskResultNode,
          data: { ...result, jobId: matching.id },
        } as CanvasNode)
        if (!request?.jobId) continue
        usedJobIds.add(matching.id)
        set({ lastGenerationRequest: request })
        syncGenerationJob(set, get, matching)
      }
    })
    .catch(() => undefined)
}

function syncGenerationJob(
  set: (next: Partial<CanvasStore>) => void,
  get: () => CanvasStore,
  job: GenerationJob,
) {
  const request = get().lastGenerationRequest
  if (!request?.taskNodeIds || request.jobId !== job.id) return

  const recordedDocument = recordGenerationJob(get().document, job, request.taskNodeIds)
  const existingJob = get().document.generationJobs.find((item) => item.id === job.id)
  if (job.status === 'succeeded') {
    const recordedJob = recordedDocument.generationJobs.find((item) => item.id === job.id) ?? job
    const candidates = candidatesFromJob(recordedJob, request)
    const document = candidates.length
      ? materializeGenerationOutputs(recordedDocument, recordedJob, request)
      : updateTaskNodes(recordedDocument, request.taskNodeIds, 'failed', job.id, '生成服务没有返回结果，请重试。')
    commit(set, document, {
      generationStatus: 'idle',
      generationProgress: 0,
      generationError: candidates.length ? null : '真实生成未返回候选结果，请重试。',
      expectedCandidateCount: job.missingOutputCount ? job.batchCount : 0,
      generationCandidates: job.missingOutputCount ? candidates : [],
      assistantMessage: candidates.length
        ? job.missingOutputCount
          ? `真实生成已完成 ${candidates.length}/${job.batchCount} 个；缺少的 ${job.missingOutputCount} 个可单独补生成。`
          : `真实生成已完成：${candidates.length} 个结果已作为独立节点写入画布；不需要的可直接删除。`
        : '真实生成没有返回候选结果，请重试。',
    }, { immediate: true })
    return
  }

  if (job.status === 'failed') {
    commit(set, recordedDocument, {
      generationStatus: 'error',
      generationProgress: 0,
      generationError: job.error ?? '真实生成任务失败，请重试。',
      expectedCandidateCount: 0,
      generationCandidates: [],
      assistantMessage: job.error ?? '真实生成任务失败，请重试。',
    }, { immediate: true })
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
    }, { immediate: true })
    return
  }

  // queued / running 的每一次轮询只更新临时 UI；仅状态转换才保存项目，
  // 避免一个长任务持续重写整份画布。
  const transientState = {
    generationStatus: job.status,
    generationProgress: 0,
    generationError: null,
    expectedCandidateCount: job.batchCount,
    assistantMessage: job.status === 'queued' ? '真实生成任务已入队，等待生成服务处理。' : '生成服务正在处理，请保留此页面或稍后返回查看结果。',
  }
  if (!existingJob || existingJob.status !== job.status) {
    // 首次拿到服务端 jobId、以及生命周期状态切换时都属于刷新恢复锚点，不能等
    // 普通交互的 debounce，否则完成中的任务会变成无法关联的孤立结果。
    commit(set, recordedDocument, transientState, { immediate: true })
    return
  }
  set(transientState)
}

function pollGenerationJob(
  set: (next: Partial<CanvasStore>) => void,
  get: () => CanvasStore,
  jobId: string,
) {
  stopGenerationPolling()
  const runId = generationPollRunId
  let retryDelay = 1_500
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
      const nextDelay = window.document.hidden ? 10_000 : retryDelay
      retryDelay = Math.min(5_000, Math.round(retryDelay * 1.5))
      // 不在 UI 推断任务超时：图片与 H3 的等待上限不同，持久化服务端任务才是权威状态。
      generationPollTimerId = window.setTimeout(() => void poll(), nextDelay)
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
      retryDelay = Math.min(10_000, Math.max(2_000, Math.round(retryDelay * 2)))
      generationPollTimerId = window.setTimeout(() => void poll(), window.document.hidden ? 15_000 : retryDelay)
    }
  }
  void poll()
}

function updateBatchVariationRun(
  set: (next: Partial<CanvasStore>) => void,
  get: () => CanvasStore,
  projectId: string,
  runId: string,
  updater: (run: BatchVariationRun) => BatchVariationRun,
  assistantMessage?: string,
) {
  const document = get().document
  if (document.id !== projectId) return
  if (!document.batchVariationRuns.some((run) => run.id === runId)) return
  commit(set, {
    ...document,
    batchVariationRuns: document.batchVariationRuns.map((run) => run.id === runId ? updater(run) : run),
  }, assistantMessage ? { assistantMessage } : {}, { immediate: true })
}

async function waitForBatchGenerationJob(jobId: string, timeoutMs = 300_000, shouldContinue: () => boolean = () => true) {
  const deadline = Date.now() + timeoutMs
  let delay = 1_500
  while (Date.now() < deadline) {
    if (!shouldContinue()) return undefined
    const job = await getGenerationJob(jobId)
    if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') return job
    await new Promise((resolve) => window.setTimeout(resolve, window.document.hidden ? 8_000 : delay))
    delay = Math.min(5_000, Math.round(delay * 1.45))
  }
  throw new Error('子任务仍在服务端处理，稍后返回画布会自动继续恢复。')
}

async function executeBatchVariationRun(
  set: (next: Partial<CanvasStore>) => void,
  get: () => CanvasStore,
  projectId: string,
  runId: string,
) {
  if (get().document.id !== projectId) return
  const scopedRunId = `${projectId}:${runId}`
  if (activeBatchVariationRuns.has(scopedRunId)) return
  activeBatchVariationRuns.add(scopedRunId)
  try {
    stopGenerationPolling()
    updateBatchVariationRun(set, get, projectId, runId, (run) => ({ ...run, status: 'running', updatedAt: Date.now() }))
    const run = get().document.batchVariationRuns.find((item) => item.id === runId)
    if (!run || run.status === 'cancelled') return
    const pendingItems = run.items.filter((item) => item.status === 'queued' || item.status === 'running')
    // 父任务只负责编排；每个素材对应一个可恢复子任务，最多同时运行 3 个。
    await mapBatchVariationWithConcurrency(pendingItems, batchVariationConcurrency, (item) => executeBatchVariationItem(set, get, projectId, runId, item.id))

    if (get().document.id !== projectId) return
    const completed = get().document.batchVariationRuns.find((item) => item.id === runId)
    if (!completed) return
    const { status, succeeded, failed } = summarizeBatchVariationRun(completed.items)
    updateBatchVariationRun(set, get, projectId, runId, (run) => ({ ...run, status, updatedAt: Date.now() }),
      failed ? `批量变体完成 ${succeeded}/${completed.items.length} 项；失败项可保留节点后单独重试。` : `批量变体已完成 ${succeeded} 项。`)
  } finally {
    activeBatchVariationRuns.delete(scopedRunId)
    if (get().document.id === projectId) window.setTimeout(() => get().resumeBatchVariations(), 0)
  }
}

const batchVariationConcurrency = 3

async function executeBatchVariationItem(
  set: (next: Partial<CanvasStore>) => void,
  get: () => CanvasStore,
  projectId: string,
  runId: string,
  itemId: string,
) {
  if (get().document.id !== projectId) return
  const initialRun = get().document.batchVariationRuns.find((run) => run.id === runId)
  const initialItem = initialRun?.items.find((item) => item.id === itemId)
  if (!initialRun || !initialItem || initialItem.status === 'succeeded' || initialItem.status === 'cancelled') return
  let jobId = initialItem.jobId
  let request: GenerationRequest | undefined

  try {
    let item = initialItem
    let run = initialRun

    // 刷新后已有 jobId 的子任务直接恢复，不再创建重复分支。
    if (item.status === 'running' && jobId) {
      const recordedJob = get().document.generationJobs.find((job) => job.id === jobId)
      request = recordedJob ? requestFromPersistedGenerationJob(get().document, recordedJob) ?? undefined : undefined
    }

    if (!request) {
      const asset = findAvailableAsset(get().document, get().globalAssets, item.assetId)
      if (!asset) throw new Error('素材已不存在。')
      let branchId = item.generateNodeId
      if (!branchId || !get().document.nodes.some((node) => node.id === branchId && node.type === 'generate')) {
        branchId = get().createGenerateBranchFromResult(run.sourceResultNodeId, {
          prompt: `${run.prompt.trim()}\n本次${run.variableRole}参考：${asset.name}。父图作为主体保持参考，不覆盖父图。`,
          batchCount: run.candidatesPerAsset,
          settings: run.settings,
          refinementMode: 'faithful',
        }) ?? undefined
        if (!branchId) throw new Error('无法创建批量变体节点。')
        const branch = get().document.nodes.find((node) => node.id === branchId)
        get().addAssetToCanvas(asset.id, branch
          ? { x: Math.max(20, branch.position.x - 236), y: branch.position.y + 16 }
          : undefined, branchId)
      }
      const graphRecipe = buildGraphGenerationRecipe(get().document, branchId)
      if (!graphRecipe || !graphRecipe.prompt.trim()) throw new Error('批量变体缺少生成描述。')
      if (!graphRecipe.recipe.references.length && !graphRecipe.parent) throw new Error('批量变体缺少参考素材。')
      const sourceResult = get().document.nodes.find((node) => node.id === run.sourceResultNodeId && node.type === 'result')
      const sourceData = sourceResult?.type === 'result' ? sourceResult.data as ResultNodeData : undefined
      const recipe = cloneGenerationRecipe(graphRecipe.recipe)
      request = {
        kind: 'refinement',
        prompt: graphRecipe.prompt,
        batchCount: recipe.batchCount,
        settings: cloneGenerationSettings(recipe.settings),
        recipe,
        rootRecipe: cloneGenerationRecipe(sourceData?.rootRecipe ?? sourceData?.generationRecipe ?? recipe),
        targetNodeId: graphRecipe.parent?.nodeId,
        parentVersionId: sourceData?.versionId,
        parentImage: sourceData?.image,
        parentLabel: sourceData?.label,
        sourceGraphNodeId: branchId,
        refinementMode: 'faithful',
        agentRun: run.agentRunId && item.agentBranchId
          ? { runId: run.agentRunId, branchId: item.agentBranchId }
          : undefined,
        idempotencyKey: createGenerationSubmissionKey(),
      }
      const flow = createTaskFlow(get().document, request, sourceResult)
      request = { ...request, taskNodeIds: flow.taskNodeIds }
      await commit(set, flow.document, {}, { immediate: true })
      if (get().document.id !== projectId) return
      item = { ...item, generateNodeId: branchId }
      run = get().document.batchVariationRuns.find((candidate) => candidate.id === runId) ?? run
      await commit(set, updateBatchVariationItemDocument(get().document, runId, itemId, {
        status: 'running',
        generateNodeId: branchId,
        error: undefined,
      }), { assistantMessage: `批量变体：已提交「${item.assetName}」子任务。` }, { immediate: true })
      if (get().document.id !== projectId) return
      const job = await submitGenerationJob({
        projectId,
        kind: request.kind,
        prompt: request.prompt,
        batchCount: request.batchCount,
        settings: request.settings,
        recipe: request.recipe!,
        parent: graphRecipe.parent
          ? { nodeId: graphRecipe.parent.nodeId, name: graphRecipe.parent.label, image: graphRecipe.parent.image }
          : undefined,
        refinementMode: request.refinementMode,
        agentRun: request.agentRun,
        idempotencyKey: request.idempotencyKey,
      })
      if (get().document.id !== projectId) return
      jobId = job.id
      // 新建子任务时 taskNodeIds 已由 createTaskFlow 生成；非空断言避免把不完整的旧任务形状写入权威记录。
      const persisted = recordGenerationJob(get().document, job, request.taskNodeIds!)
      await commit(set, updateBatchVariationItemDocument(persisted, runId, itemId, {
        status: job.status === 'succeeded' ? 'succeeded' : 'running',
        jobId,
        generateNodeId: item.generateNodeId,
      }), {}, { immediate: true })
      if (get().document.id !== projectId) return
    }

    if (!jobId || !request) throw new Error('无法恢复批量子任务配方。')
    const finalJob = await waitForBatchGenerationJob(jobId, 300_000, () => get().document.id === projectId)
    if (!finalJob || get().document.id !== projectId) return
    const nextDocument = applyGenerationJobToDocument(get().document, finalJob, request)
    const status = finalJob.status === 'succeeded' ? 'succeeded' : finalJob.status === 'cancelled' ? 'cancelled' : 'failed'
    await commit(set, updateBatchVariationItemDocument(nextDocument, runId, itemId, {
      status,
      jobId,
      error: finalJob.error,
    }), {}, { immediate: true })
  } catch (error) {
    if (get().document.id !== projectId) return
    const message = error instanceof Error ? error.message : '批量子任务执行失败。'
    // 子任务失败也要收敛画布节点与 GenerationJob，否则父任务结束后会留下
    // 永远“处理中”的占位节点，刷新后又会被误判为可恢复任务。
    try {
      const currentDocument = get().document
      const failedNodesDocument = request?.taskNodeIds
        ? updateTaskNodes(currentDocument, request.taskNodeIds, 'failed', jobId, message)
        : currentDocument
      const failedDocument = jobId
        ? {
            ...failedNodesDocument,
            generationJobs: failedNodesDocument.generationJobs.map((job) => job.id === jobId
              ? { ...job, status: 'failed' as const, error: message, updatedAt: Date.now() }
              : job),
          }
        : failedNodesDocument
      await commit(set, updateBatchVariationItemDocument(failedDocument, runId, itemId, {
        status: 'failed',
        jobId,
        error: message,
      }), { assistantMessage: message }, { immediate: true })
    } catch {
      // 持久化异常不应掩盖原始子任务错误；父任务仍会把该子任务标记为失败。
      updateBatchVariationRun(set, get, projectId, runId, (current) => ({
        ...current,
        items: current.items.map((candidate) => candidate.id === itemId
          ? { ...candidate, status: 'failed', error: message }
          : candidate),
        updatedAt: Date.now(),
      }), message)
    }
  }
}

function historyName(count: number, kind: GenerationCandidate['kind'] = 'generation') {
  const prefix = kind === 'refinement' ? '精修分支' : '首图分支'
  return `${prefix} · v${String(count + 3).padStart(2, '0')}`
}

function applyRemoteDocumentRefresh(
  set: (next: Partial<CanvasStore>) => void,
  get: () => CanvasStore,
  remoteDocument: CanvasDocument,
  baselineUpdatedAt: number,
  hasPendingDraft = false,
) {
  const current = get().document
  const normalizedRemote = settleExpiredGenerationSubmissions(normalizeDocument(remoteDocument)).document
  const resolved = resolveRemoteCanvasRefresh({
    current,
    remote: normalizedRemote,
    baselineUpdatedAt,
    hasPendingDraft,
  })
  if (!resolved.applied) return false

  stopGenerationPolling()
  const document = resolved.document
  const selectedNode = [...document.nodes].reverse().find(
    (node) => node.selected || (node.type === 'result' && Boolean((node.data as ResultNodeData).selected)),
  )
  const recoveredGeneration = restoreGenerationLifecycleState(document, '已同步其他设备的更新。')
  set({
    document,
    persistenceStatus: 'saved',
    selectedNodeId: selectedNode?.id ?? null,
    ...recoveredGeneration.state,
    assistantMessage: recoveredGeneration.state.generationStatus === 'recovering'
      ? recoveredGeneration.state.assistantMessage
      : '已同步其他设备的更新。',
    undoAction: null,
    undoSnapshot: null,
  })
  if (recoveredGeneration.pollJobId) pollGenerationJob(set, get, recoveredGeneration.pollJobId)
  else if (recoveredGeneration.state.generationStatus === 'recovering') {
    queueMicrotask(() => { void get().recoverUnknownGenerationSubmission() })
  }
  return true
}

/**
 * 只合并服务端已完成任务与输出，不替换当前节点坐标、选中态或未提交编辑。
 * 用于 Realtime 重连、跨设备恢复和 Agent Run 终态对账。
 */
async function recoverGenerationResults(
  set: (next: Partial<CanvasStore>) => void,
  get: () => CanvasStore,
  documentId: string,
) {
  if (!serverPersistenceEnabled) return false
  try {
    const recovered = await reconcileProjectGenerationResults(documentId)
    const current = get().document
    if (current.id !== documentId) return false
    const reconciledDocument = mergeRecoveredGenerationJobs(current, recovered.document)
    if (resultImageCount(reconciledDocument) <= resultImageCount(current)) {
      recoverTaskNodeJobs(set, get, documentId)
      return false
    }
    const selected = [...reconciledDocument.nodes].reverse().find(
      (node) => node.selected || (node.type === 'result' && Boolean((node.data as ResultNodeData).selected)),
    )
    const state = restoreGenerationLifecycleState(reconciledDocument, '已从服务端补回生成结果。')
    set({
      document: reconciledDocument,
      persistenceStatus: 'saved',
      selectedNodeId: selected?.id ?? null,
      ...state.state,
    })
    // 服务端输出是权威来源；覆盖本机旧草稿，避免下次打开再次出现空占位。
    void writeCanvasDocument(reconciledDocument, { immediate: true }).catch(() => undefined)
    return true
  } catch {
    recoverTaskNodeJobs(set, get, documentId)
    return false
  }
}

export const useCanvasStore = create<CanvasStore>((set, get) => ({
  document: seedDocument,
  globalAssets: [],
  sharedTemplates: [],
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
    // 首页与项目列表不读取素材库或示例画布；具体项目打开时再并行加载。
    // 这让鉴权恢复后的项目首屏不再被全局素材库请求阻塞。
    const document = createEmptyCanvasDocument('workspace-placeholder', '未命名画布')
    const selectedNode = [...document.nodes].reverse().find((node) => node.selected || (node.type === 'result' && Boolean((node.data as ResultNodeData).selected)))
    const recoveredGeneration = restoreGenerationLifecycleState(document, document.nodes.length ? `已打开「${document.name}」。` : `「${document.name}」已创建，可以从素材或一句话开始。`)
    set({
      document,
      globalAssets: [],
      sharedTemplates: [],
      hydrated: true,
      persistenceStatus: 'saved',
      selectedNodeId: selectedNode?.id ?? null,
      ...recoveredGeneration.state,
    })
  },

  openDocument: async (documentId) => {
    const operationToken = openDocumentOperations.begin()
    // 项目切换前先收敛当前项目的延迟写入；失败时草稿仍保留在本地，不能阻塞切换。
    await flushPendingCanvasDocumentWrites().catch(() => undefined)
    if (!openDocumentOperations.isCurrent(operationToken)) return false
    // 画布本身是打开项目的关键路径；共享素材库仅服务素材面板，不能让它的
    // 网络故障阻塞整个画布恢复。
    const stored = await readCanvasDocument(documentId, {
      onRemoteDocument: ({ cachedDocument, remoteDocument }) => (
        applyRemoteDocumentRefresh(set, get, remoteDocument, cachedDocument.updatedAt)
      ),
    })
    if (!stored || !openDocumentOperations.isCurrent(operationToken)) return false

    stopGenerationPolling()
    persistenceOperations.invalidate()
    const normalizedDocument = normalizeDocument(stored)
    const settledSubmission = settleExpiredGenerationSubmissions(normalizedDocument)
    const document = settledSubmission.document
    const selectedNode = [...document.nodes].reverse().find((node) => node.selected || (node.type === 'result' && Boolean((node.data as ResultNodeData).selected)))
    const recoveredGeneration = restoreGenerationLifecycleState(
      document,
      document.nodes.length ? `已打开「${document.name}」。` : `「${document.name}」已创建，可以从素材或一句话开始。`,
    )
    set({
      document,
      globalAssets: get().globalAssets,
      hydrated: true,
      persistenceStatus: 'saved',
      selectedNodeId: selectedNode?.id ?? null,
      ...recoveredGeneration.state,
      undoAction: null,
      undoSnapshot: null,
    })
    if (settledSubmission.changed || document.schemaVersion !== stored.schemaVersion || hasCrampedStarterV03Layout(stored.nodes)) {
      try {
        await writeCanvasDocument(document)
        if (openDocumentOperations.isCurrent(operationToken) && get().document.id === documentId) set({ persistenceStatus: 'saved' })
      } catch {
        if (openDocumentOperations.isCurrent(operationToken) && get().document.id === documentId) {
          set({ persistenceStatus: 'error', assistantMessage: '项目迁移保存失败：请先不要刷新。' })
        }
      }
    }
    // 素材库在后台补齐；失败不影响当前项目打开，用户稍后可在素材库重试。
    void ensureGlobalAssetLibrary(seedGlobalAssets)
      .then((library) => {
        if (get().document.id !== documentId) return
        set({ globalAssets: library.assets })
        get().resumeBatchVariations()
      })
      .catch(() => undefined)
    void readGlobalWorkflowTemplateLibrary()
      .then((library) => set({ sharedTemplates: library?.templates ?? [] }))
      .catch(() => undefined)
    if (recoveredGeneration.pollJobId) pollGenerationJob(set, get, recoveredGeneration.pollJobId)
    else if (recoveredGeneration.state.generationStatus === 'recovering') {
      queueMicrotask(() => { void get().recoverUnknownGenerationSubmission() })
    }
    // 仅在共享素材已就绪时恢复批量任务；否则由素材库加载完成后继续，
    // 避免把共享品牌素材误判为“已不存在”。
    if (get().globalAssets.length) window.setTimeout(() => get().resumeBatchVariations(), 0)
    // 历史任务可能在浏览器断开时完成，根本没有写入画布。服务端一次性回填，
    // 同时修复其他设备或旧版本留下的空占位节点。
    void recoverGenerationResults(set, get, documentId)
    return true
  },

  refreshDocumentFromRemote: async () => {
    const baseline = get().document
    if (baseline.id === 'workspace-placeholder') return false
    try {
      const latest = await readLatestCanvasDocument(baseline.id)
      if (!latest.document) return false
      const applied = applyRemoteDocumentRefresh(
        set,
        get,
        latest.document,
        baseline.updatedAt,
        latest.hasPendingDraft,
      )
      if (applied) await persistAcceptedRemoteCanvasDocument(latest.document)
      return applied
    } catch {
      return false
    }
  },

  recoverGenerationResultsFromRemote: async () => {
    const documentId = get().document.id
    if (documentId === 'workspace-placeholder') return false
    return recoverGenerationResults(set, get, documentId)
  },

  recoverUnknownGenerationSubmission: async () => {
    const projectId = get().document.id
    const request = get().lastGenerationRequest
    if (
      get().generationStatus !== 'recovering'
      || !request?.taskNodeIds
      || !request.recipe
      || !request.idempotencyKey
    ) return false
    const recoverableRequest: GenerationRequest & {
      taskNodeIds: TaskNodeIds
      recipe: GenerationRecipe
      idempotencyKey: string
    } = {
      ...request,
      taskNodeIds: request.taskNodeIds,
      recipe: request.recipe,
      idempotencyKey: request.idempotencyKey,
    }

    const submissionRunId = ++generationSubmissionRunId
    set({
      generationError: null,
      assistantMessage: '正在用原幂等键确认任务，不会重复生成。',
    })
    try {
      const job = await submitGenerationJob({
        projectId,
        kind: recoverableRequest.kind,
        prompt: recoverableRequest.prompt,
        batchCount: recoverableRequest.batchCount,
        settings: recoverableRequest.settings,
        recipe: recoverableRequest.recipe,
        parent: recoverableRequest.kind === 'refinement' && recoverableRequest.targetNodeId && recoverableRequest.parentImage
          ? { nodeId: recoverableRequest.targetNodeId, name: recoverableRequest.parentLabel ?? '已选首图', image: recoverableRequest.parentImage }
          : undefined,
        refinementMode: recoverableRequest.refinementMode,
        agentRun: recoverableRequest.agentRun,
        idempotencyKey: recoverableRequest.idempotencyKey,
      })
      if (get().document.id !== projectId || submissionRunId !== generationSubmissionRunId) return false
      const recoveredRequest = { ...recoverableRequest, jobId: job.id }
      set({ lastGenerationRequest: recoveredRequest })
      syncGenerationJob(set, get, job)
      if (job.status === 'queued' || job.status === 'running') pollGenerationJob(set, get, job.id)
      return true
    } catch (error) {
      if (get().document.id !== projectId || submissionRunId !== generationSubmissionRunId) return false
      return applyGenerationSubmissionFailure(set, get, recoverableRequest, error)
    }
  },

  openNewDocument: (document) => {
    openDocumentOperations.invalidate()
    persistenceOperations.invalidate()
    stopGenerationPolling()
    document = settleExpiredGenerationSubmissions(document).document
    const selectedNode = [...document.nodes].reverse().find((node) => node.selected || (node.type === 'result' && Boolean((node.data as ResultNodeData).selected)))
    const recoveredGeneration = restoreGenerationLifecycleState(
      document,
      document.nodes.length ? `已打开「${document.name}」。` : `「${document.name}」已创建，可以从素材或一句话开始。`,
    )
    set({
      document,
      hydrated: true,
      persistenceStatus: 'saved',
      selectedNodeId: selectedNode?.id ?? null,
      ...recoveredGeneration.state,
      undoAction: null,
      undoSnapshot: null,
    })
    // 新建空项目无需等待共享素材库。素材在后台就绪，首次打开素材库前会自动补齐。
    void ensureGlobalAssetLibrary(seedGlobalAssets)
      .then((library) => set({ globalAssets: library.assets }))
      .catch(() => undefined)
    void readGlobalWorkflowTemplateLibrary()
      .then((library) => set({ sharedTemplates: library?.templates ?? [] }))
      .catch(() => undefined)
    if (recoveredGeneration.state.generationStatus === 'recovering') {
      queueMicrotask(() => { void get().recoverUnknownGenerationSubmission() })
    }
    window.setTimeout(() => get().resumeBatchVariations(), 0)
  },

  renameDocument: (name) => {
    const nextName = cleanDisplayName(name, '')
    if (!nextName || nextName === get().document.name) return Promise.resolve()
    const current = get().document
    set({
      document: { ...current, name: nextName },
      persistenceStatus: 'saving',
      assistantMessage: `正在重命名为「${nextName}」。`,
    })
    return renameCanvasProject(current.id, nextName)
      .then((saved) => {
        if (get().document.id !== current.id) return
        const active = get().document
        set({
          document: { ...active, name: saved.name, updatedAt: Math.max(active.updatedAt, saved.updatedAt) },
          persistenceStatus: 'saved',
          assistantMessage: `项目已重命名为「${nextName}」。`,
        })
      })
      .catch((error) => {
        if (get().document.id === current.id) {
          const active = get().document
          set({
            document: active.name === nextName ? { ...active, name: current.name } : active,
            persistenceStatus: 'error',
            assistantMessage: '项目重命名失败，请检查网络后重试。',
          })
        }
        throw error
      })
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

  replaceMediaSources: async (replacements) => {
    if (!Object.keys(replacements).length) return
    const document = get().document
    const nextDocument = replaceDocumentMediaSources(document, replacements)
    if (nextDocument === document) return
    await commit(set, nextDocument, {
      assistantMessage: '参考图片已准备完成。',
    }, { immediate: true })
  },

  setNodesTransient: (nodes) => {
    const synchronizedNodes = nodes.map((node) => ({
      ...node,
      data: node.type === 'result'
        ? { ...node.data, selected: Boolean(node.selected) }
        : { ...node.data },
    })) as CanvasNode[]
    const selected = synchronizedNodes.filter((node) => node.selected)
    set({
      document: { ...get().document, nodes: synchronizedNodes },
      selectedNodeId: selected.length === 1 ? selected[0].id : null,
    })
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

  applyCollaborativeGraph: ({ nodes, edges }) => {
    const current = get().document
    const synchronized = mergeCollaborativeCanvasGraph(
      { nodes: current.nodes, edges: current.edges },
      { nodes, edges },
    )
    const synchronizedNodes = synchronized.nodes
    const synchronizedNodeIds = new Set(synchronizedNodes.map((node) => node.id))
    const normalizedEdges = normalizeSystemOutputEdges(
      synchronizedNodes,
      synchronized.edges.filter((edge) => synchronizedNodeIds.has(edge.source) && synchronizedNodeIds.has(edge.target)),
    )
    const normalizedNodes = normalizeGenerateNodeInputs(synchronizedNodes, normalizedEdges)
    const selected = normalizedNodes.filter((node) => node.selected)
    set({
      document: { ...current, nodes: normalizedNodes, edges: normalizedEdges },
      selectedNodeId: selected.length === 1 ? selected[0].id : null,
    })
  },

  selectNode: (selectedNodeId) => {
    if (!selectedNodeId) {
      const nodes = get().document.nodes.map((node) => ({
        ...node,
        selected: false,
        data: node.type === 'result' ? { ...node.data, selected: false } : { ...node.data },
      })) as CanvasNode[]
      set({ document: { ...get().document, nodes }, selectedNodeId: null })
      return
    }

    const nodes = get().document.nodes.map((node) => ({
      ...node,
      selected: node.id === selectedNodeId,
      data: node.type === 'result'
        ? { ...node.data, selected: node.id === selectedNodeId }
        : { ...node.data },
    })) as CanvasNode[]
    set({ document: { ...get().document, nodes }, selectedNodeId })
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
          mediaKind: asset.mediaKind ?? 'image',
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

  addAssetToCanvas: (assetId, dropPosition, connectToGenerateId) => {
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
        mediaKind: asset.mediaKind ?? 'image',
        referenceEnabled: true,
        primary: asset.role === '商品' && !hasPrimaryProduct,
        referencePriority: assetNodes.length + 1,
      },
    }

    const target = connectToGenerateId ? document.nodes.find((item) => item.id === connectToGenerateId && item.type === 'generate') : undefined
    const connectedAssetCount = target
      ? document.edges.filter((edge) => edge.target === target.id && document.nodes.some((item) => item.id === edge.source && item.type === 'asset')).length
      : 0
    const canConnect = Boolean(target && connectedAssetCount < 8)
    const edges = canConnect && target
      ? [...document.edges, {
          id: `graph-edge-${nodeId}-${target.id}-${Date.now()}`,
          source: nodeId,
          sourceHandle: 'asset-output',
          target: target.id,
          targetHandle: 'input',
          type: 'default',
          style: { stroke: '#4f805b', strokeWidth: 1.6 },
          reconnectable: true,
        }]
      : document.edges
    const nodes = normalizeGenerateNodeInputs([
      ...document.nodes.map((item) => ({ ...item, selected: target ? item.id === target.id : false })),
      { ...node, selected: !target },
    ] as CanvasNode[], edges)
    commit(set, { ...document, nodes, edges }, {
      selectedNodeId: target?.id ?? nodeId,
      assistantMessage: canConnect
        ? `已将「${asset.name}」加入画布，并连接到「${(target!.data as GenerateNodeData).label}」。`
        : target
          ? `已将「${asset.name}」加入画布；「${(target.data as GenerateNodeData).label}」最多可连接 8 张图片。`
          : `已将「${asset.name}」加入画布，可拖拽调整位置。`,
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
      mediaKind: upload.mediaKind ?? 'image',
      collection: normalizeAssetCollection(upload.collection),
      tags: upload.tags.length ? [...new Set(upload.tags)] : ['上传素材'],
    }))

    commit(set, {
      ...document,
      assets: [...assets, ...document.assets],
      assetGroups: upsertCollectionGroups(document.assetGroups, assets, timestamp),
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
      mediaKind: upload.mediaKind ?? 'image',
      collection: normalizeAssetCollection(upload.collection),
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
          mediaKind: asset.mediaKind ?? 'image',
          referenceEnabled: true,
          primary: shouldBePrimary,
          referencePriority: existingAssetNodes.length + index + 1,
        },
      }
    }) as CanvasNode[]

    commit(set, {
      ...document,
      assets: [...assets, ...document.assets],
      assetGroups: upsertCollectionGroups(document.assetGroups, assets, timestamp),
      nodes: [...document.nodes.map((node) => ({ ...node, selected: false })), ...nodes] as CanvasNode[],
    }, {
      selectedNodeId: nodes[0]?.id ?? null,
      assistantMessage: `已将 ${assets.length} 张本地图片直接加入画布，并同步存入当前项目素材库。`,
    })
  },

  saveGeneratedImageToLibrary: ({ image, name, mediaKind = 'image' }) => {
    const document = get().document
    if (document.assets.some((asset) => asset.source === 'generated' && asset.image === image)) {
      set({ assistantMessage: `「${name}」已在当前项目素材库中。` })
      return
    }

    const asset: AssetRecord = {
      id: `generated-library-${Date.now()}`,
      role: '首图',
      name: name.trim() || (mediaKind === 'video' ? '生成视频' : '生成图片'),
      image,
      source: 'generated',
      mediaKind,
      collection: '生成结果',
      tags: [mediaKind === 'video' ? '视频' : '首图', '画布入库'],
    }
    commit(set, { ...document, assets: [asset, ...document.assets] }, {
      assistantMessage: `已将「${asset.name}」存入当前项目素材库。`,
    })
  },

  moveAssetToRole: (assetId, role) => {
    const document = get().document
    const globalAsset = get().globalAssets.find((asset) => asset.id === assetId)
    const localAsset = document.assets.find((asset) => asset.id === assetId)
    const target = globalAsset ?? localAsset
    if (!target || target.role === role) return

    const updateNodeRoles = (nodes: CanvasNode[]) => normalizeAssetReferenceNodes(nodes.map((node) => {
      if (node.type !== 'asset' || (node.data as AssetNodeData).assetId !== assetId) return node
      const assetNode = node.data as AssetNodeData
      return { ...node, data: { ...assetNode, role, primary: role === '商品' ? assetNode.primary : false } }
    }) as CanvasNode[])
    const nodes = updateNodeRoles(document.nodes)

    if (globalAsset) {
      const previousGlobalAssets = get().globalAssets
      const globalAssets = previousGlobalAssets.map((asset) => asset.id === assetId ? { ...asset, role } : asset)
      commit(set, { ...document, nodes }, {
        globalAssets,
        assistantMessage: `已将「${target.name}」移动到「${role}」分组。`,
      })
      void writeGlobalAssetLibrary({ id: 'global-brand-assets', schemaVersion: 1, assets: globalAssets, updatedAt: Date.now() })
        .catch(() => {
          const activeDocument = get().document
          const activeGlobalAsset = get().globalAssets.find((asset) => asset.id === assetId)
          if (activeGlobalAsset?.role !== role) return
          const revertedNodes = activeDocument.id === document.id
            ? normalizeAssetReferenceNodes(activeDocument.nodes.map((node) => {
              if (node.type !== 'asset' || (node.data as AssetNodeData).assetId !== assetId) return node
              return { ...node, data: { ...(node.data as AssetNodeData), role: target.role } }
            }) as CanvasNode[])
            : activeDocument.nodes
          commit(set, { ...activeDocument, nodes: revertedNodes }, {
            globalAssets: previousGlobalAssets,
            assistantMessage: `「${target.name}」的分组未能保存，请重试。`,
          })
        })
      return
    }

    commit(set, {
      ...document,
      nodes,
      assets: document.assets.map((asset) => asset.id === assetId ? { ...asset, role } : asset),
    }, {
      assistantMessage: `已将「${target.name}」移动到「${role}」分组。`,
    })
  },

  createAssetGroup: (name, role, assetIds = []) => {
    const cleanName = normalizeAssetGroupName(name)
    if (!cleanName) return null
    const document = get().document
    const availableIds = new Set(availableAssets(document, get().globalAssets).map((asset) => asset.id))
    const normalizedAssetIds = [...new Set(assetIds)].filter((assetId) => availableIds.has(assetId))
    const timestamp = Date.now()
    const group: AssetGroup = {
      id: `asset-group-${timestamp}`,
      name: cleanName,
      role,
      assetIds: normalizedAssetIds,
      coverAssetId: normalizedAssetIds[0],
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    commit(set, { ...document, assetGroups: [group, ...document.assetGroups] }, {
      assistantMessage: normalizedAssetIds.length
        ? `已创建素材组「${cleanName}」，并加入 ${normalizedAssetIds.length} 项素材。`
        : `已创建素材组「${cleanName}」。`,
    })
    return group.id
  },

  renameAssetGroup: (groupId, name) => {
    const cleanName = normalizeAssetGroupName(name)
    if (!cleanName) return
    const document = get().document
    if (!document.assetGroups.some((group) => group.id === groupId)) return
    commit(set, {
      ...document,
      assetGroups: document.assetGroups.map((group) => group.id === groupId
        ? { ...group, name: cleanName, updatedAt: Date.now() }
        : group),
    }, { assistantMessage: `素材组已重命名为「${cleanName}」。` })
  },

  deleteAssetGroup: (groupId) => {
    const document = get().document
    const group = document.assetGroups.find((item) => item.id === groupId)
    if (!group) return
    commit(set, { ...document, assetGroups: document.assetGroups.filter((item) => item.id !== groupId) }, {
      assistantMessage: `已删除素材组「${group.name}」，组内素材仍保留在素材库。`,
    })
  },

  addAssetsToGroup: (groupId, assetIds) => {
    const document = get().document
    const availableIds = new Set(availableAssets(document, get().globalAssets).map((asset) => asset.id))
    const additions = [...new Set(assetIds)].filter((assetId) => availableIds.has(assetId))
    if (!additions.length || !document.assetGroups.some((group) => group.id === groupId)) return
    const timestamp = Date.now()
    commit(set, {
      ...document,
      assetGroups: document.assetGroups.map((group) => {
        if (group.id !== groupId) return group
        const nextAssetIds = [...new Set([...group.assetIds, ...additions])]
        return { ...group, assetIds: nextAssetIds, coverAssetId: group.coverAssetId ?? nextAssetIds[0], updatedAt: timestamp }
      }),
    }, { assistantMessage: `已将 ${additions.length} 项素材加入素材组。` })
  },

  removeAssetFromGroup: (groupId, assetId) => {
    const document = get().document
    const group = document.assetGroups.find((item) => item.id === groupId)
    if (!group?.assetIds.includes(assetId)) return
    const assetIds = group.assetIds.filter((id) => id !== assetId)
    commit(set, {
      ...document,
      assetGroups: document.assetGroups.map((item) => item.id === groupId
        ? { ...item, assetIds, coverAssetId: item.coverAssetId === assetId ? assetIds[0] : item.coverAssetId, updatedAt: Date.now() }
        : item),
    }, { assistantMessage: '已将素材移出当前素材组；素材原件仍保留。' })
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

  addGenerateNode: (position, mediaKind = 'image', inputNodeIds) => {
    const document = get().document
    const timestamp = Date.now()
    const nodeId = `generate-${timestamp}`
    const matchingModel = get().availableModels.find((model) => (model.mediaKind ?? 'image') === mediaKind)
    if (!matchingModel && mediaKind === 'video') {
      set({ assistantMessage: '视频模型尚未配置，请先检查 MiniMax H3。' })
      return null
    }
    const defaultSettings = defaultSettingsForModel(matchingModel)
    const planned = planGenerateNodeCreation({
      nodes: document.nodes,
      nodeId,
      position: position ?? { x: 470, y: 240 },
      mediaKind,
      settings: defaultSettings,
      inputNodeIds,
    })
    commit(set, {
      ...document,
      nodes: [...document.nodes.map((item) => ({ ...item, selected: false })), planned.node] as CanvasNode[],
      edges: [...document.edges, ...planned.edges],
    }, {
      selectedNodeId: nodeId,
      assistantMessage: planned.edges.length
        ? `已创建「${planned.node.data.label}」并连接所选输入。`
        : mediaKind === 'video'
          ? '已创建视频生成节点；连接首帧、首尾帧或参考素材后即可生成。'
          : '已创建图像生成节点；连接商品图片后，可直接填写描述并生成。',
    })
    return nodeId
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
    const siblingBranchCount = document.edges.filter((edge) => edge.source === resultNodeId
      && document.nodes.some((node) => node.id === edge.target && node.type === 'generate')).length
    const branchSettings = cloneGenerationSettings({ ...defaultSettings, ...draft?.settings })
    const branchModel = get().availableModels.find((model) => model.id === branchSettings.model)
    const branchMediaKind = branchModel?.mediaKind ?? (branchSettings.duration === undefined ? 'image' : 'video')
    const branchPosition = findOpenGeneratePosition(document.nodes, {
      x: parent.position.x + 372,
      y: parent.position.y + 38 + siblingBranchCount * 238,
    })
    const planned = planGenerateNodeCreation({
      nodes: document.nodes,
      nodeId,
      // 只为新分支寻找右侧空位；用户已经排好的节点不发生位移。
      position: branchPosition,
      mediaKind: branchMediaKind,
      settings: branchSettings,
      inputNodeIds: [resultNodeId],
    })
    const node: CanvasNode = {
      ...planned.node,
      data: {
        ...planned.node.data,
        prompt: draft?.prompt ?? '',
        batchCount: Math.min(get().maximumBatchCount, clampBatchCount(draft?.batchCount ?? recipe?.batchCount ?? 1)),
        refinementMode: draft?.refinementMode ?? 'faithful',
      },
    }
    const nodes = [...document.nodes.map((item) => ({ ...item, selected: false, data: item.type === 'result' ? { ...item.data, selected: false } : { ...item.data } })), node] as CanvasNode[]
    commit(set, { ...document, nodes, edges: [...document.edges, ...planned.edges] }, {
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
      .map((model) => ({ ...model, id: model.id, label: model.label?.trim() || model.id }))
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

  runGraphGeneration: async (nodeId, agentRun) => {
    const graphRecipe = buildGraphGenerationRecipe(get().document, nodeId)
    if (!graphRecipe) return setGenerationError(set, '未找到要执行的生成节点。')
    if (!graphRecipe.prompt.trim()) return setGenerationError(set, '请填写生成描述。')
    if (graphRecipe.hasUnselectedResultInput) return setGenerationError(set, '上游结果尚未选图；请先在候选中选中一张首图，再继续生成。')
    if (!graphRecipe.recipe.references.length && !graphRecipe.parent) return setGenerationError(set, '请至少连接一张商品图片、参考素材或已选首图。')
    if (graphRecipe.recipe.references.length > 8) return setGenerationError(set, '单个生成节点最多连接 8 个参考素材。')
    const selectedModel = get().availableModels.find((model) => model.id === graphRecipe.recipe.settings.model)
    const isVideoModel = selectedModel?.mediaKind === 'video'
    let preparedRecipe: GenerationRecipe = graphRecipe.recipe
    if (isVideoModel) {
      const defaultMode = preparedRecipe.references.some((reference) => reference.mediaKind === 'video')
        ? 'reference'
        : preparedRecipe.references.length === 2 ? 'first_last' : 'first_frame'
      const assignment = assignVideoInputRoles(preparedRecipe.references, preparedRecipe.videoInputMode ?? defaultMode)
      if (assignment.error) return setGenerationError(set, assignment.error)
      preparedRecipe = {
        ...preparedRecipe,
        videoInputMode: preparedRecipe.videoInputMode ?? defaultMode,
        references: assignment.references,
      }
    } else if (preparedRecipe.references.some((reference) => reference.mediaKind === 'video')) {
      return setGenerationError(set, '视频素材只能连接到视频生成模型。')
    }
    if (!isVideoModel && !primaryGenerationReference(preparedRecipe) && !graphRecipe.parent) return setGenerationError(set, '请在当前生成节点至少连接一张图片作为主参考。')
    if (graphRecipe.parent) {
      const refinementMode = (get().document.nodes.find((node) => node.id === nodeId && node.type === 'generate')?.data as GenerateNodeData | undefined)?.refinementMode ?? 'faithful'
      return get().runRefinement({
        targetNodeId: graphRecipe.parent.nodeId,
        prompt: graphRecipe.prompt,
        batchCount: preparedRecipe.batchCount,
        settings: preparedRecipe.settings,
        recipe: preparedRecipe,
        sourceGraphNodeId: nodeId,
        refinementMode,
        agentRun,
      })
    }
    return get().runGeneration({
      prompt: graphRecipe.prompt,
      batchCount: preparedRecipe.batchCount,
      settings: preparedRecipe.settings,
      recipe: preparedRecipe,
      sourceGraphNodeId: nodeId,
      agentRun,
    })
  },

  ...createCanvasAgentActions({
    set,
    get,
    commitDocument: (document, extra, options) => commit(set, document, extra, options),
  }),

  runBatchVariation: async ({ sourceResultNodeId, groupId, prompt, candidatesPerAsset, settings, agentRunId, agentBranches }) => {
    const cleanPrompt = prompt.trim()
    if (!cleanPrompt) return setGenerationError(set, '请先描述这批图片要如何变化。')
    if (get().generationStatus !== 'idle' && get().generationStatus !== 'error') {
      return setGenerationError(set, '当前已有生成任务，请等待完成后再发起批量变体。')
    }
    const document = get().document
    const projectId = document.id
    if (document.batchVariationRuns.some((run) => run.status === 'queued' || run.status === 'running')) {
      return setGenerationError(set, '当前已有一组批量变体正在执行。')
    }
    const source = document.nodes.find((node) => node.id === sourceResultNodeId && node.type === 'result')
    const sourceData = source?.type === 'result' ? source.data as ResultNodeData : undefined
    if (!sourceData?.image) return setGenerationError(set, '请选择一张已完成的结果图作为批量变体父图。')
    const group = document.assetGroups.find((item) => item.id === groupId)
    if (!group) return setGenerationError(set, '请选择一个素材组。')
    const availableIds = new Set(availableAssets(document, get().globalAssets).filter((asset) => (asset.mediaKind ?? 'image') === 'image').map((asset) => asset.id))
    const assetIds = group.assetIds.filter((assetId) => availableIds.has(assetId))
    if (!assetIds.length) return setGenerationError(set, '这个素材组暂无可用图片。')
    let run: BatchVariationRun
    try {
      run = createBatchVariationRun({
        now: Date.now(),
        sourceResultNodeId,
        group: { ...group, assetIds },
        prompt: cleanPrompt,
        candidatesPerAsset,
        maximumBatchCount: get().maximumBatchCount,
        settings,
        resolveAssetName: (assetId, index) => findAvailableAsset(document, get().globalAssets, assetId)?.name ?? `素材 ${index + 1}`,
        agentRunId,
        agentBranches,
      })
    } catch (error) {
      return setGenerationError(set, error instanceof Error ? error.message : '批量变体计划无效。')
    }
    await commit(set, { ...document, batchVariationRuns: [run, ...document.batchVariationRuns] }, {
      generationError: null,
      assistantMessage: `已创建批量变体：${assetIds.length} 个${group.role} × ${run.candidatesPerAsset} 张候选。`,
    }, { immediate: true })
    if (get().document.id !== projectId) return false
    void executeBatchVariationRun(set, get, projectId, run.id)
    return true
  },

  retryBatchVariationItem: async (runId, itemId) => {
    const projectId = get().document.id
    if (activeBatchVariationRuns.has(`${projectId}:${runId}`)) {
      set({ assistantMessage: '这组批量变体仍在执行，请等待其他子任务完成。' })
      return false
    }
    const document = get().document
    const run = document.batchVariationRuns.find((candidate) => candidate.id === runId)
    const item = run?.items.find((candidate) => candidate.id === itemId)
    if (!run || !item || (item.status !== 'failed' && item.status !== 'cancelled')) return false
    const nextDocument = {
      ...document,
      batchVariationRuns: document.batchVariationRuns.map((candidate) => candidate.id === runId
        ? {
            ...candidate,
            status: 'queued' as const,
            items: candidate.items.map((child) => child.id === itemId
              ? { ...child, status: 'queued' as const, jobId: undefined, error: undefined }
              : child),
            updatedAt: Date.now(),
          }
        : candidate),
    }
    await commit(set, nextDocument, { assistantMessage: `已重新排队「${item.assetName}」子任务。` }, { immediate: true })
    if (get().document.id !== projectId) return false
    void executeBatchVariationRun(set, get, projectId, runId)
    return true
  },

  resumeBatchVariations: () => {
    const projectId = get().document.id
    if ([...activeBatchVariationRuns].some((key) => key.startsWith(`${projectId}:`))) return
    const pendingRun = get().document.batchVariationRuns.find((run) => run.status === 'queued' || run.status === 'running')
    if (pendingRun) void executeBatchVariationRun(set, get, projectId, pendingRun.id)
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

  ...createCanvasTemplateHistoryActions({ set, get, commit }),

  runGeneration: async ({ prompt, batchCount, settings, recipe: inputRecipe, rootRecipe: inputRootRecipe, taskLayout, sourceGraphNodeId, agentRun }) => {
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
      if (get().document.id !== document.id) return false
      return setGenerationError(set, error instanceof Error ? error.message : '真实生图服务暂不可用，请稍后重新检查。')
    }
    if (get().document.id !== document.id) return false

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
      agentRun,
      idempotencyKey: createGenerationSubmissionKey(),
    }
    const flow = createTaskFlow(document, request)
    const preparedRequest = { ...request, taskNodeIds: flow.taskNodeIds }
    const submissionRunId = ++generationSubmissionRunId
    // 先将任务节点与可恢复配方落库，再提交真实任务。这样即使用户随后刷新，
    // 也能用已保存的 jobId / 节点关系把服务端结果补回画布。
    await commit(set, flow.document, {
      generationStatus: 'uploading',
      generationProgress: 0,
      generationError: null,
      expectedCandidateCount: normalizedBatchCount,
      generationCandidates: [],
      lastGenerationRequest: preparedRequest,
      assistantMessage: `正在提交真实任务：主商品「${primaryProduct.name}」与 ${recipe.references.length} 个画布参考。`,
    }, { immediate: true })
    if (get().document.id !== document.id) return false

    try {
      const job = await submitGenerationJob({
        projectId: document.id,
        kind: request.kind,
        prompt: request.prompt,
        batchCount: request.batchCount,
        settings: request.settings,
        recipe,
        agentRun,
        idempotencyKey: request.idempotencyKey,
      })
      if (get().document.id !== document.id) return false
      if (submissionRunId !== generationSubmissionRunId) {
        void cancelGenerationJob(job.id)
        return false
      }
      set({ lastGenerationRequest: scrubRevokedGenerationRequest({ ...preparedRequest, jobId: job.id }) })
      syncGenerationJob(set, get, job)
      if (job.status === 'queued' || job.status === 'running') pollGenerationJob(set, get, job.id)
      return true
    } catch (error) {
      if (get().document.id !== document.id || submissionRunId !== generationSubmissionRunId) return false
      return applyGenerationSubmissionFailure(set, get, preparedRequest, error)
    }
  },

  runRefinement: async ({ targetNodeId, prompt, batchCount, settings, recipe: inputRecipe, rootRecipe: inputRootRecipe, taskLayout, sourceGraphNodeId, refinementMode = 'faithful', agentRun }) => {
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
      if (get().document.id !== document.id) return false
      return setGenerationError(set, error instanceof Error ? error.message : '真实生图服务暂不可用，请稍后重新检查。')
    }
    if (get().document.id !== document.id) return false

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
      refinementMode,
      agentRun,
      idempotencyKey: createGenerationSubmissionKey(),
    }
    const flow = createTaskFlow(document, request, target)
    const preparedRequest = { ...request, taskNodeIds: flow.taskNodeIds }
    const submissionRunId = ++generationSubmissionRunId
    // 精修同样先写入父图与任务节点关系，刷新后才能准确恢复为该图的子版本。
    await commit(set, flow.document, {
      generationStatus: 'uploading',
      generationProgress: 0,
      generationError: null,
      expectedCandidateCount: normalizedBatchCount,
      generationCandidates: [],
      lastGenerationRequest: preparedRequest,
      assistantMessage: `正在提交「${parentLabel}」的真实精修任务。`,
    }, { immediate: true })
    if (get().document.id !== document.id) return false

    try {
      const job = await submitGenerationJob({
        projectId: document.id,
        kind: request.kind,
        prompt: request.prompt,
        batchCount: request.batchCount,
        settings: request.settings,
        recipe,
        parent: { nodeId: targetNodeId, name: parentLabel, image: parentImage },
        refinementMode,
        agentRun,
        idempotencyKey: request.idempotencyKey,
      })
      if (get().document.id !== document.id) return false
      if (submissionRunId !== generationSubmissionRunId) {
        void cancelGenerationJob(job.id)
        return false
      }
      set({ lastGenerationRequest: scrubRevokedGenerationRequest({ ...preparedRequest, jobId: job.id }) })
      syncGenerationJob(set, get, job)
      if (job.status === 'queued' || job.status === 'running') pollGenerationJob(set, get, job.id)
      return true
    } catch (error) {
      if (get().document.id !== document.id || submissionRunId !== generationSubmissionRunId) return false
      return applyGenerationSubmissionFailure(set, get, preparedRequest, error)
    }
  },

  cancelGeneration: () => {
    const projectId = get().document.id
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
      .then((job) => {
        if (get().document.id === projectId) syncGenerationJob(set, get, job)
      })
      .catch(() => {
        if (get().document.id === projectId) set({ assistantMessage: '取消请求未能同步到服务端，请在任务面板稍后确认状态。' })
      })
  },

  retryGeneration: async () => {
    const request = get().lastGenerationRequest
    if (!request) return setGenerationError(set, '没有可重试的真实生成任务。')
    const job = request.jobId ? get().document.generationJobs.find((item) => item.id === request.jobId) : undefined
    const retryBatchCount = job?.missingOutputCount || request.batchCount
    if (request.kind === 'refinement' && request.targetNodeId) {
      return get().runRefinement({
        targetNodeId: request.targetNodeId,
        prompt: request.prompt,
        batchCount: retryBatchCount,
        settings: request.settings,
        recipe: request.recipe,
        rootRecipe: request.rootRecipe,
        taskLayout: request.taskLayout,
        sourceGraphNodeId: request.sourceGraphNodeId ?? request.taskNodeIds?.generateNodeId,
        refinementMode: request.refinementMode,
      })
    }
    return get().runGeneration({
      prompt: request.prompt,
      batchCount: retryBatchCount,
      settings: request.settings,
      recipe: request.recipe,
      rootRecipe: request.rootRecipe,
      taskLayout: request.taskLayout,
      sourceGraphNodeId: request.taskNodeIds?.generateNodeId,
    })
  },

  retryMissingGeneration: async (jobId) => {
    const document = get().document
    const job = document.generationJobs.find((item) => item.id === jobId)
    if (!job?.missingOutputCount) return setGenerationError(set, '本任务没有待补生成的候选。')
    const request = requestFromPersistedGenerationJob(document, job)
    if (!request?.recipe) return setGenerationError(set, '无法恢复本次生成配方，请基于任一候选继续生成。')
    if (request.kind === 'refinement' && request.targetNodeId) {
      return get().runRefinement({
        targetNodeId: request.targetNodeId,
        prompt: request.prompt,
        batchCount: job.missingOutputCount,
        settings: request.settings,
        recipe: request.recipe,
        rootRecipe: request.rootRecipe,
        sourceGraphNodeId: request.sourceGraphNodeId,
        refinementMode: request.refinementMode,
      })
    }
    return get().runGeneration({
      prompt: request.prompt,
      batchCount: job.missingOutputCount,
      settings: request.settings,
      recipe: request.recipe,
      rootRecipe: request.rootRecipe,
      sourceGraphNodeId: request.sourceGraphNodeId,
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
