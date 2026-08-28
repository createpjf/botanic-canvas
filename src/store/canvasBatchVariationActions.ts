import { createBatchVariationRun, mapBatchVariationWithConcurrency, nextResumableBatchVariationRun, summarizeBatchVariationRun } from '../domain/batchVariations'
import type { BatchVariationRun, CanvasDocument, ResultNodeData } from '../domain/canvas'
import { buildGraphGenerationRecipe, cloneGenerationRecipe, cloneGenerationSettings } from '../domain/generationRecipe'
import { getGenerationJob, submitGenerationJob } from '../lib/generationApi'
import { availableAssets, findAvailableAsset } from './canvasDocumentAssets'
import { requestFromPersistedGenerationJob } from './canvasGenerationLifecycle'
import {
  applyGenerationJobToDocument,
  createTaskFlow,
  recordGenerationJob,
  updateBatchVariationItemDocument,
  updateTaskNodes,
} from './canvasGenerationProjection'
import type { CanvasStore, GenerationRequest } from './canvasStore.types'

type BatchVariationActions = Pick<CanvasStore,
  | 'runBatchVariation'
  | 'retryBatchVariationItem'
  | 'resumeBatchVariations'
>

type CommitCanvasDocument = (
  document: CanvasDocument,
  extra?: Partial<CanvasStore>,
  options?: { immediate?: boolean; rejectOnFailure?: boolean },
) => Promise<void>

type CanvasBatchVariationDependencies = {
  set: (next: Partial<CanvasStore>) => void
  get: () => CanvasStore
  commitDocument: CommitCanvasDocument
  stopGenerationPolling: () => void
  createGenerationSubmissionKey: () => string
}

const activeBatchVariationRuns = new Set<string>()
const batchVariationConcurrency = 3

/**
 * 批量变体父任务、独立子任务、恢复与重试的单一协调器。
 * Store 根模块只负责注入持久化与生成生命周期端口。
 */
export function createCanvasBatchVariationActions({
  set,
  get,
  commitDocument,
  stopGenerationPolling,
  createGenerationSubmissionKey,
}: CanvasBatchVariationDependencies): BatchVariationActions {
  const setGenerationError = (message: string) => {
    set({
      generationStatus: 'error',
      generationProgress: 0,
      generationError: message,
      generationCandidates: [],
      lastGenerationRequest: null,
      assistantMessage: message,
    })
    return false
  }

  const updateBatchVariationRun = (
    projectId: string,
    runId: string,
    updater: (run: BatchVariationRun) => BatchVariationRun,
    assistantMessage?: string,
  ) => {
    const document = get().document
    if (document.id !== projectId) return
    if (!document.batchVariationRuns.some((run) => run.id === runId)) return
    void commitDocument({
      ...document,
      batchVariationRuns: document.batchVariationRuns.map((run) => run.id === runId ? updater(run) : run),
    }, assistantMessage ? { assistantMessage } : {}, { immediate: true })
  }

  const waitForBatchGenerationJob = async (
    jobId: string,
    timeoutMs = 300_000,
    shouldContinue: () => boolean = () => true,
  ) => {
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

  const executeBatchVariationItem = async (
    projectId: string,
    runId: string,
    itemId: string,
  ) => {
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
        await commitDocument(flow.document, {}, { immediate: true })
        if (get().document.id !== projectId) return
        item = { ...item, generateNodeId: branchId }
        run = get().document.batchVariationRuns.find((candidate) => candidate.id === runId) ?? run
        await commitDocument(updateBatchVariationItemDocument(get().document, runId, itemId, {
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
        await commitDocument(updateBatchVariationItemDocument(persisted, runId, itemId, {
          status: job.status === 'succeeded' ? 'succeeded' : 'running',
          jobId,
          generateNodeId: item.generateNodeId,
        }), {}, { immediate: true })
        if (get().document.id !== projectId) return
      }

      if (!jobId || !request) throw new Error('无法恢复批量子任务参数。')
      const finalJob = await waitForBatchGenerationJob(jobId, 300_000, () => get().document.id === projectId)
      if (!finalJob || get().document.id !== projectId) return
      const nextDocument = applyGenerationJobToDocument(get().document, finalJob, request)
      const status = finalJob.status === 'succeeded' ? 'succeeded' : finalJob.status === 'cancelled' ? 'cancelled' : 'failed'
      await commitDocument(updateBatchVariationItemDocument(nextDocument, runId, itemId, {
        status,
        jobId,
        error: finalJob.error,
      }), {}, { immediate: true })
    } catch (error) {
      if (get().document.id !== projectId) return
      const message = error instanceof Error ? error.message : '批量子任务执行失败。'
      // 子任务失败也要收敛画布节点与 GenerationJob，否则刷新后会被误判为可恢复任务。
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
        await commitDocument(updateBatchVariationItemDocument(failedDocument, runId, itemId, {
          status: 'failed',
          jobId,
          error: message,
        }), { assistantMessage: message }, { immediate: true })
      } catch {
        // 持久化异常不掩盖子任务错误；父任务仍能收敛到失败状态。
        updateBatchVariationRun(projectId, runId, (current) => ({
          ...current,
          items: current.items.map((candidate) => candidate.id === itemId
            ? { ...candidate, status: 'failed', error: message }
            : candidate),
          updatedAt: Date.now(),
        }), message)
      }
    }
  }

  const executeBatchVariationRun = async (projectId: string, runId: string) => {
    if (get().document.id !== projectId) return
    const scopedRunId = `${projectId}:${runId}`
    if (activeBatchVariationRuns.has(scopedRunId)) return
    activeBatchVariationRuns.add(scopedRunId)
    try {
      stopGenerationPolling()
      updateBatchVariationRun(projectId, runId, (run) => ({ ...run, status: 'running', updatedAt: Date.now() }))
      const run = get().document.batchVariationRuns.find((item) => item.id === runId)
      if (!run || run.status === 'cancelled') return
      const pendingItems = run.items.filter((item) => item.status === 'queued' || item.status === 'running')
      // 父任务只负责编排；每个素材对应一个可恢复子任务，最多同时运行 3 个。
      await mapBatchVariationWithConcurrency(pendingItems, batchVariationConcurrency, (item) => executeBatchVariationItem(projectId, runId, item.id))

      if (get().document.id !== projectId) return
      const completed = get().document.batchVariationRuns.find((item) => item.id === runId)
      if (!completed) return
      const { status, succeeded, failed } = summarizeBatchVariationRun(completed.items)
      updateBatchVariationRun(projectId, runId, (current) => ({ ...current, status, updatedAt: Date.now() }),
        failed ? `批量变体完成 ${succeeded}/${completed.items.length} 项；失败项可保留节点后单独重试。` : `批量变体已完成 ${succeeded} 项。`)
    } finally {
      activeBatchVariationRuns.delete(scopedRunId)
      if (get().document.id === projectId) window.setTimeout(() => get().resumeBatchVariations(), 0)
    }
  }

  return {
    runBatchVariation: async ({ sourceResultNodeId, groupId, prompt, candidatesPerAsset, settings, agentRunId, agentBranches }) => {
      const cleanPrompt = prompt.trim()
      if (!cleanPrompt) return setGenerationError('请先描述这批图片要如何变化。')
      if (get().generationStatus !== 'idle' && get().generationStatus !== 'error') {
        return setGenerationError('当前已有生成任务，请等待完成后再发起批量变体。')
      }
      const document = get().document
      const projectId = document.id
      if (nextResumableBatchVariationRun(document.batchVariationRuns)) {
        return setGenerationError('当前已有一组批量变体正在执行。')
      }
      const source = document.nodes.find((node) => node.id === sourceResultNodeId && node.type === 'result')
      const sourceData = source?.type === 'result' ? source.data as ResultNodeData : undefined
      if (!sourceData?.image) return setGenerationError('请选择一张已完成的结果图作为批量变体父图。')
      const group = document.assetGroups.find((item) => item.id === groupId)
      if (!group) return setGenerationError('请选择一个素材组。')
      const availableIds = new Set(availableAssets(document, get().globalAssets).filter((asset) => (asset.mediaKind ?? 'image') === 'image').map((asset) => asset.id))
      const assetIds = group.assetIds.filter((assetId) => availableIds.has(assetId))
      if (!assetIds.length) return setGenerationError('这个素材组暂无可用图片。')
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
        return setGenerationError(error instanceof Error ? error.message : '批量变体计划无效。')
      }
      await commitDocument({ ...document, batchVariationRuns: [run, ...document.batchVariationRuns] }, {
        generationError: null,
        assistantMessage: `已创建批量变体：${assetIds.length} 个${group.role} × ${run.candidatesPerAsset} 张候选。`,
      }, { immediate: true })
      if (get().document.id !== projectId) return false
      void executeBatchVariationRun(projectId, run.id)
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
      await commitDocument(nextDocument, { assistantMessage: `已重新排队「${item.assetName}」子任务。` }, { immediate: true })
      if (get().document.id !== projectId) return false
      void executeBatchVariationRun(projectId, runId)
      return true
    },

    resumeBatchVariations: () => {
      const projectId = get().document.id
      if ([...activeBatchVariationRuns].some((key) => key.startsWith(`${projectId}:`))) return
      const pendingRun = nextResumableBatchVariationRun(get().document.batchVariationRuns)
      if (pendingRun) void executeBatchVariationRun(projectId, pendingRun.id)
    },
  }
}
