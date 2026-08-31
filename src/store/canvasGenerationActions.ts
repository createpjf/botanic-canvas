import { generationSubmissionFailureDisposition } from '../domain/generationSubmission'
import { withRegionEditOverlayReferences } from '../domain/generationComposition'
import {
  buildGenerationRecipe,
  buildGraphGenerationRecipe,
  clampBatchCount,
  cloneGenerationRecipe,
  cloneGenerationSettings,
  maximumReferencesForModel,
  primaryGenerationReference,
  settingsForRegionEdit,
} from '../domain/generationRecipe'
import { matchUnresolvedGenerationTaskJobs } from '../domain/generationRecovery'
import { assignVideoInputRoles } from '../domain/videoGeneration'
import type { CanvasDocument, CanvasNode, GenerateNodeData, GenerationJob, GenerationRecipe, ResultNodeData } from '../domain/canvas'
import {
  assertGenerationServiceReady,
  cancelGenerationJob,
  GenerationApiError,
  getGenerationJob,
  listProjectGenerationJobs,
  reconcileProjectGenerationResults,
  submitGenerationJob,
} from '../lib/generationApi'
import { serverPersistenceEnabled } from '../lib/productSession'
import {
  requestFromGenerationTaskNode,
  requestFromPersistedGenerationJob,
  restoreGenerationLifecycleState,
} from './canvasGenerationLifecycle'
import {
  candidatesFromJob,
  createTaskFlow,
  materializeGenerationOutputs,
  recordGenerationJob,
  updateTaskNodes,
} from './canvasGenerationProjection'
import { hasRecoveredGenerationDelta, mergeRecoveredGenerationJobs } from './canvasGenerationRecovery'
import type { CanvasStore, GenerationRequest, TaskNodeIds } from './canvasStore.types'
import { generationCancelAssistantMessage, type GenerationCancelOutcome } from '../domain/generationCancelCopy'
import { readProductLocale } from '../i18n/core'

type GenerationActions = Pick<CanvasStore,
  | 'runGeneration'
  | 'runRefinement'
  | 'cancelGeneration'
  | 'retryGeneration'
  | 'retryMissingGeneration'
  | 'clearGenerationError'
  | 'recoverUnknownGenerationSubmission'
  | 'recoverGenerationResultsFromRemote'
  | 'runGraphGeneration'
>

type CommitDocument = (
  document: CanvasDocument,
  extra?: Partial<CanvasStore>,
  options?: { immediate?: boolean; rejectOnFailure?: boolean },
) => Promise<void>

type CanvasGenerationDependencies = {
  set: (next: Partial<CanvasStore>) => void
  get: () => CanvasStore
  commitDocument: CommitDocument
  normalizeDocument: (document: CanvasDocument | undefined) => CanvasDocument
  scrubGenerationRequest: (request: GenerationRequest | null) => GenerationRequest | null
  editingBlocked: () => boolean
}

export type CanvasGenerationController = {
  actions: GenerationActions
  stopPolling: () => void
  pollJob: (jobId: string, boundRequest?: GenerationRequest) => void
  recoverTaskNodeJobs: (documentId: string) => void
  recoverResults: (documentId: string) => Promise<boolean>
  createSubmissionKey: () => string
}

function createGenerationSubmissionKey() {
  const uuid = globalThis.crypto?.randomUUID?.()
  return `gen_${(uuid ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`).replaceAll('-', '')}`
}

const generationReconnectMessage = '实时连接中断，已保留生成请求；连接恢复后会继续提交。'

/** Owns the regular generation submission, polling, retry and recovery lifecycle. */
export function createCanvasGenerationActions({
  set,
  get,
  commitDocument,
  normalizeDocument,
  scrubGenerationRequest,
  editingBlocked,
}: CanvasGenerationDependencies): CanvasGenerationController {
  const pollTimers = new Map<string, number>()
  let pollEpoch = 0
  let submissionRunId = 0

  const pauseGenerationSubmission = async (request: GenerationRequest & { taskNodeIds: TaskNodeIds }) => {
    await commitDocument(updateTaskNodes(get().document, request.taskNodeIds, 'submission_unknown'), {
      generationStatus: 'recovering',
      generationProgress: 0,
      generationError: null,
      expectedCandidateCount: request.batchCount,
      generationCandidates: [],
      lastGenerationRequest: request,
      assistantMessage: generationReconnectMessage,
    }, { immediate: true })
    return false
  }

  const stopPolling = () => {
    for (const timer of pollTimers.values()) window.clearTimeout(timer)
    pollTimers.clear()
    pollEpoch += 1
  }

  const clearPollTimer = (jobId: string) => {
    const timer = pollTimers.get(jobId)
    if (timer !== undefined) window.clearTimeout(timer)
    pollTimers.delete(jobId)
  }

  const setGenerationError = (message: string, preserveLastRequest = false) => {
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

  const applySubmissionFailure = async (
    request: GenerationRequest & { taskNodeIds: TaskNodeIds },
    error: unknown,
  ) => {
    const disposition = generationSubmissionFailureDisposition(error)
    const fallbackMessage = request.kind === 'refinement'
      ? '精修任务提交失败，请重试。'
      : '生成任务提交失败，请重试。'
    const message = disposition.message ?? fallbackMessage
    const nextDocument = updateTaskNodes(get().document, request.taskNodeIds, disposition.taskStatus, undefined, message)
    if (disposition.kind === 'recovering') {
      await commitDocument(nextDocument, {
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
    void commitDocument(nextDocument, {
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

  // `cancelOutcome` 只由取消接口返回；轮询与恢复路径拿不到它，因此是可选的。
  // 恢复已终结的历史任务时通过 `requestOverride` 传入请求，不改写 `lastGenerationRequest`：
  // 那是当前活动任务的专属状态，被历史任务覆盖会让正在轮询的任务因请求不匹配而丢结果。
  const syncJob = (
    job: GenerationJob & { cancelOutcome?: GenerationCancelOutcome },
    requestOverride?: GenerationRequest,
  ) => {
    const request = requestOverride ?? get().lastGenerationRequest
    if (!request?.taskNodeIds || request.jobId !== job.id) return
    const recordedDocument = recordGenerationJob(get().document, job, request.taskNodeIds)
    const existingJob = get().document.generationJobs.find((item) => item.id === job.id)
    if (job.status === 'succeeded') {
      const recordedJob = recordedDocument.generationJobs.find((item) => item.id === job.id) ?? job
      if (recordedJob.projectionDismissedAt) {
        void commitDocument(recordedDocument, {
          generationStatus: 'idle', generationProgress: 0, generationError: null,
          expectedCandidateCount: 0, generationCandidates: [],
          assistantMessage: '任务已完成，已按你的删除保留在结果面板。',
        }, { immediate: true })
        return
      }
      const candidates = candidatesFromJob(recordedJob, request)
      const document = candidates.length
        ? materializeGenerationOutputs(recordedDocument, recordedJob, request)
        : updateTaskNodes(recordedDocument, request.taskNodeIds, 'failed', job.id, '生成服务没有返回结果，请重试。')
      void commitDocument(document, {
        generationStatus: 'idle',
        generationProgress: 0,
        generationError: candidates.length ? null : '生成未返回结果，请重试。',
        expectedCandidateCount: job.missingOutputCount ? job.batchCount : 0,
        generationCandidates: job.missingOutputCount ? candidates : [],
        assistantMessage: candidates.length
          ? job.missingOutputCount
            ? `生成已完成 ${candidates.length}/${job.batchCount} 个；缺少的 ${job.missingOutputCount} 个可单独补生成。`
            : `生成已完成：${candidates.length} 个结果已作为独立节点写入画布；不需要的可直接删除。`
          : '生成没有返回结果，请重试。',
      }, { immediate: true })
      return
    }
    if (job.status === 'failed') {
      void commitDocument(recordedDocument, {
        generationStatus: 'error', generationProgress: 0,
        generationError: job.error ?? '生成任务失败，请重试。',
        expectedCandidateCount: 0, generationCandidates: [],
        assistantMessage: job.error ?? '生成任务失败，请重试。',
      }, { immediate: true })
      return
    }
    if (job.status === 'cancelled') {
      // 照实说明费用是否可能已产生：当前 Provider 都不支持提交后停止计费，
      // 只说「已取消」会让用户以为省下了生成额度。两者都拿不到（旧服务端取消的
      // 历史任务）时退到中性表述，不臆测计费情况。
      void commitDocument(recordedDocument, {
        generationStatus: 'idle', generationProgress: 0, generationError: null,
        expectedCandidateCount: 0, generationCandidates: [],
        // 取消接口会返回本次判定；轮询与刷新后只剩任务上的持久回执，两者同构。
        assistantMessage: generationCancelAssistantMessage(job.cancelOutcome ?? job.cancel, readProductLocale()),
      }, { immediate: true })
      return
    }
    const transientState = {
      generationStatus: job.status,
      generationProgress: 0,
      generationError: null,
      expectedCandidateCount: job.batchCount,
      assistantMessage: job.status === 'queued' ? '生成任务已入队，等待生成服务处理。' : '生成服务正在处理，请保留此页面或稍后返回查看结果。',
    }
    if (!existingJob || existingJob.status !== job.status) {
      void commitDocument(recordedDocument, transientState, { immediate: true })
      return
    }
    set(transientState)
  }

  const pollJob = (jobId: string, boundRequest?: GenerationRequest) => {
    clearPollTimer(jobId)
    const runEpoch = pollEpoch
    let retryDelay = 1_500
    const requestForJob = () => {
      if (boundRequest?.jobId === jobId) return boundRequest
      const latest = get().lastGenerationRequest
      return latest?.jobId === jobId ? latest : boundRequest
    }
    const schedulePoll = (delay: number) => {
      pollTimers.set(jobId, window.setTimeout(() => void poll(), delay))
    }
    const poll = async () => {
      if (runEpoch !== pollEpoch) return
      try {
        const job = await getGenerationJob(jobId)
        if (runEpoch !== pollEpoch) return
        syncJob(job, requestForJob())
        if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') {
          clearPollTimer(jobId)
          return
        }
        const nextDelay = window.document.hidden ? 10_000 : retryDelay
        retryDelay = Math.min(5_000, Math.round(retryDelay * 1.5))
        schedulePoll(nextDelay)
      } catch (error) {
        if (runEpoch !== pollEpoch) return
        if (error instanceof GenerationApiError && error.code === 'JOB_NOT_FOUND') {
          clearPollTimer(jobId)
          const request = get().lastGenerationRequest
          if (request?.jobId !== jobId) return
          const message = '生成服务已重启，无法恢复本次任务。请重试。'
          const failedDocument = request.taskNodeIds
            ? updateTaskNodes(get().document, request.taskNodeIds, 'failed', request.jobId, message)
            : get().document
          void commitDocument({
            ...failedDocument,
            generationJobs: failedDocument.generationJobs.map((job) => job.id === jobId
              ? { ...job, status: 'failed' as const, error: message, updatedAt: Date.now() }
              : job),
          }, {
            generationStatus: 'error', generationProgress: 0,
            generationError: message, generationCandidates: [], assistantMessage: message,
          })
          return
        }
        set({ assistantMessage: error instanceof Error ? `${error.message} 任务仍可能在服务端执行。` : '任务状态同步失败，任务仍可能在服务端执行。' })
        retryDelay = Math.min(10_000, Math.max(2_000, Math.round(retryDelay * 2)))
        schedulePoll(window.document.hidden ? 15_000 : retryDelay)
      }
    }
    void poll()
  }

  const recoverTaskNodeJobs = (documentId: string) => {
    const document = get().document
    const requests = new Map<string, GenerationRequest>()
    for (const node of document.nodes) {
      if (node.type !== 'result') continue
      const result = node.data as ResultNodeData
      if (result.image || !result.jobId || (result.taskGroupId && node.id !== result.taskGroupId)) continue
      const request = requestFromGenerationTaskNode(document, node)
      if (request?.jobId) requests.set(request.jobId, request)
    }
    for (const node of document.nodes) {
      if (node.type !== 'generate') continue
      const generate = node.data as GenerateNodeData
      if (!generate.jobId || requests.has(generate.jobId)) continue
      const taskResultNode = document.nodes.find((candidate) => {
        if (candidate.type !== 'result') return false
        const result = candidate.data as ResultNodeData
        return result.outputOf === node.id && !result.image && (!result.taskGroupId || candidate.id === result.taskGroupId)
      })
      if (!taskResultNode || taskResultNode.type !== 'result') continue
      const request = requestFromGenerationTaskNode(document, {
        ...taskResultNode,
        data: { ...(taskResultNode.data as ResultNodeData), jobId: generate.jobId },
      } as CanvasNode)
      if (request?.jobId) requests.set(request.jobId, request)
    }
    for (const request of requests.values()) {
      void getGenerationJob(request.jobId!).then((job) => {
        if (get().document.id !== documentId) return
        if (job.status === 'queued' || job.status === 'running') {
          // 只有仍在执行、需要接管轮询的任务才成为“当前任务”。
          set({ lastGenerationRequest: request })
          syncJob(job, request)
          pollJob(job.id, request)
          return
        }
        // 已终结的任务只补投影，不改写 lastGenerationRequest。
        syncJob(job, request)
      }).catch(() => undefined)
    }
    const hasUnresolvedTaskNodes = document.nodes.some((node) => {
      if (node.type !== 'result') return false
      const result = node.data as ResultNodeData
      return !result.image && !result.jobId && (!result.taskGroupId || node.id === result.taskGroupId)
    })
    if (!hasUnresolvedTaskNodes) return
    void listProjectGenerationJobs(documentId).then((jobs) => {
      if (get().document.id !== documentId) return
      // 匹配规则（含「已落图任务不得再错配」的历史保护）由领域函数统一持有。
      const matches = matchUnresolvedGenerationTaskJobs({
        nodes: get().document.nodes,
        jobs,
        reservedJobIds: requests.keys(),
      })
      for (const [taskNodeId, matching] of matches) {
        const currentDocument = get().document
        const taskResultNode = currentDocument.nodes.find((node) => node.id === taskNodeId && node.type === 'result')
        if (!taskResultNode) continue
        const request = requestFromGenerationTaskNode(currentDocument, {
          ...taskResultNode,
          data: { ...(taskResultNode.data as ResultNodeData), jobId: matching.id },
        } as CanvasNode)
        if (!request?.jobId) continue
        syncJob(matching, request)
      }
    }).catch(() => undefined)
  }

  const resultImageCount = (document: CanvasDocument) => document.nodes
    .filter((node) => node.type === 'result' && Boolean((node.data as ResultNodeData).image)).length

  const recoverResults = async (documentId: string) => {
    if (!serverPersistenceEnabled) return false
    try {
      const recovered = await reconcileProjectGenerationResults(documentId)
      const current = get().document
      if (current.id !== documentId) return false
      const reconciledDocument = normalizeDocument(mergeRecoveredGenerationJobs(current, recovered.document))
      if (!hasRecoveredGenerationDelta(current, reconciledDocument)
        && resultImageCount(reconciledDocument) <= resultImageCount(current)) {
        recoverTaskNodeJobs(documentId)
        return false
      }
      const selected = [...reconciledDocument.nodes].reverse().find(
        (node) => node.selected || (node.type === 'result' && Boolean((node.data as ResultNodeData).selected)),
      )
      const state = restoreGenerationLifecycleState(reconciledDocument, '已从服务端补回生成结果。')
      // 复用统一提交门禁，使这份权威恢复结果同时压住更早的整画布保存响应。
      await commitDocument(state.document, { selectedNodeId: selected?.id ?? null, ...state.state }, { immediate: true })
      return true
    } catch {
      recoverTaskNodeJobs(documentId)
      return false
    }
  }

  const actions: GenerationActions = {
    runGraphGeneration: async (nodeId, agentRun) => {
      if (editingBlocked()) return false
      const graphRecipe = buildGraphGenerationRecipe(get().document, nodeId)
      if (!graphRecipe) return setGenerationError('未找到要执行的生成节点。')
      if (!graphRecipe.prompt.trim()) return setGenerationError('请填写生成描述。')
      if (graphRecipe.hasUnselectedResultInput) return setGenerationError('上游结果尚未选图；请先在结果中选中一张首图，再继续生成。')
      if (!graphRecipe.recipe.references.length && !graphRecipe.parent) return setGenerationError('请至少连接一张商品图片、参考素材或已选首图。')
      const selectedModel = get().availableModels.find((model) => model.id === graphRecipe.recipe.settings.model)
      if (!selectedModel) return setGenerationError('当前生成模型未配置或不可用，请重新选择。')
      const maximumReferences = maximumReferencesForModel(selectedModel)
      const inputImageCount = graphRecipe.recipe.references.length + (graphRecipe.parent ? 1 : 0)
      if (inputImageCount > maximumReferences) {
        return setGenerationError(`单个生成节点最多使用 ${maximumReferences} 个参考素材（含父图）。`)
      }
      const isVideoModel = selectedModel?.mediaKind === 'video'
      let preparedRecipe: GenerationRecipe = graphRecipe.recipe
      if (isVideoModel) {
        const defaultMode = preparedRecipe.references.some((reference) => reference.mediaKind === 'video')
          ? 'reference'
          : preparedRecipe.references.length === 2 ? 'first_last' : 'first_frame'
        const assignment = assignVideoInputRoles(preparedRecipe.references, preparedRecipe.videoInputMode ?? defaultMode)
        if (assignment.error) return setGenerationError(assignment.error)
        preparedRecipe = { ...preparedRecipe, videoInputMode: preparedRecipe.videoInputMode ?? defaultMode, references: assignment.references }
      } else if (preparedRecipe.references.some((reference) => reference.mediaKind === 'video')) {
        return setGenerationError('视频素材只能连接到视频生成模型。')
      }
      if (!isVideoModel && !primaryGenerationReference(preparedRecipe) && !graphRecipe.parent) {
        return setGenerationError('请在当前生成节点至少连接一张图片作为主参考。')
      }
      if (graphRecipe.parent) {
        const generateNode = get().document.nodes.find((node) => node.id === nodeId && node.type === 'generate')
        const generate = generateNode?.type === 'generate' ? generateNode.data as GenerateNodeData : undefined
        const refinementMode = generate?.refinementMode ?? 'faithful'
        return get().runRefinement({
          targetNodeId: graphRecipe.parent.nodeId,
          prompt: graphRecipe.prompt,
          batchCount: preparedRecipe.batchCount,
          settings: preparedRecipe.settings,
          recipe: preparedRecipe,
          sourceGraphNodeId: nodeId,
          title: generate?.label,
          refinementMode,
          agentRun,
        })
      }
      const generateNode = get().document.nodes.find((node) => node.id === nodeId && node.type === 'generate')
      return get().runGeneration({
        prompt: graphRecipe.prompt,
        batchCount: preparedRecipe.batchCount,
        settings: preparedRecipe.settings,
        recipe: preparedRecipe,
        sourceGraphNodeId: nodeId,
        title: generateNode?.type === 'generate' ? (generateNode.data as GenerateNodeData).label : undefined,
        agentRun,
      })
    },

    recoverGenerationResultsFromRemote: async () => {
      const documentId = get().document.id
      return recoverResults(documentId)
    },

    recoverUnknownGenerationSubmission: async () => {
      if (editingBlocked()) return false
      const projectId = get().document.id
      const request = get().lastGenerationRequest
      if (get().generationStatus !== 'recovering' || !request?.taskNodeIds || !request.recipe || !request.idempotencyKey) return false
      const recoverableRequest: GenerationRequest & { taskNodeIds: TaskNodeIds; recipe: GenerationRecipe; idempotencyKey: string } = {
        ...request,
        taskNodeIds: request.taskNodeIds,
        recipe: request.recipe,
        idempotencyKey: request.idempotencyKey,
      }
      const runId = ++submissionRunId
      set({ generationError: null, assistantMessage: '正在用原幂等键确认任务，不会重复生成。' })
      try {
        const job = await submitGenerationJob({
          projectId, kind: recoverableRequest.kind, prompt: recoverableRequest.prompt,
          batchCount: recoverableRequest.batchCount, settings: recoverableRequest.settings,
          recipe: recoverableRequest.recipe,
          parent: recoverableRequest.kind === 'refinement' && recoverableRequest.targetNodeId && recoverableRequest.parentImage
            ? { nodeId: recoverableRequest.targetNodeId, name: recoverableRequest.parentLabel ?? '已选首图', image: recoverableRequest.parentImage }
            : undefined,
          refinementMode: recoverableRequest.refinementMode,
          agentRun: recoverableRequest.agentRun,
          idempotencyKey: recoverableRequest.idempotencyKey,
        })
        if (get().document.id !== projectId || runId !== submissionRunId) return false
        const recoveredRequest = { ...recoverableRequest, jobId: job.id }
        set({ lastGenerationRequest: recoveredRequest })
        syncJob(job)
        if (job.status === 'queued' || job.status === 'running') pollJob(job.id)
        return true
      } catch (error) {
        if (get().document.id !== projectId || runId !== submissionRunId) return false
        return applySubmissionFailure(recoverableRequest, error)
      }
    },

    runGeneration: async ({ prompt, batchCount, settings, recipe: inputRecipe, rootRecipe: inputRootRecipe, taskLayout, sourceGraphNodeId, title, agentRun }) => {
      if (editingBlocked()) return false
      if (get().generationStatus !== 'idle' && get().generationStatus !== 'error') return false
      const cleanPrompt = prompt.trim()
      if (!cleanPrompt) return setGenerationError('请先描述你想生成的首图。')
      const document = get().document
      const normalizedBatchCount = clampBatchCount(batchCount)
      const recipe = inputRecipe
        ? cloneGenerationRecipe({ ...inputRecipe, prompt: cleanPrompt, batchCount: normalizedBatchCount, settings: cloneGenerationSettings(settings) })
        : buildGenerationRecipe(document, cleanPrompt, normalizedBatchCount, settings)
      const primaryProduct = primaryGenerationReference(recipe)
      if (recipe.references.length > 0 && !primaryProduct) return setGenerationError('请在当前生成节点至少连接一张图片作为主参考。')
      try {
        await assertGenerationServiceReady()
      } catch (error) {
        if (get().document.id !== document.id) return false
        return setGenerationError(error instanceof Error ? error.message : '生成服务暂不可用，请稍后重新检查。')
      }
      if (get().document.id !== document.id) return false
      const request: GenerationRequest = {
        kind: 'generation', prompt: cleanPrompt, batchCount: normalizedBatchCount,
        settings: cloneGenerationSettings(settings), recipe: cloneGenerationRecipe(recipe),
        rootRecipe: cloneGenerationRecipe(inputRootRecipe ?? recipe), parentVersionId: document.activeVersionId,
        taskLayout, sourceGraphNodeId, title, agentRun, idempotencyKey: createGenerationSubmissionKey(),
      }
      const flow = createTaskFlow(document, request)
      const preparedRequest = { ...request, taskNodeIds: flow.taskNodeIds }
      const runId = ++submissionRunId
      await commitDocument(flow.document, {
        generationStatus: 'uploading', generationProgress: 0, generationError: null,
        expectedCandidateCount: normalizedBatchCount, generationCandidates: [], lastGenerationRequest: preparedRequest,
        assistantMessage: primaryProduct
          ? `正在提交生成任务：主商品「${primaryProduct.name}」与 ${recipe.references.length} 个画布参考。`
          : '正在提交生成任务：根据文字描述直接生成。',
      }, { immediate: true })
      if (get().document.id !== document.id) return false
      if (editingBlocked()) return pauseGenerationSubmission(preparedRequest)
      try {
        const job = await submitGenerationJob({
          projectId: document.id, kind: request.kind, prompt: request.prompt,
          batchCount: request.batchCount, settings: request.settings, recipe, agentRun,
          idempotencyKey: request.idempotencyKey,
        })
        if (get().document.id !== document.id) return false
        if (runId !== submissionRunId) {
          void cancelGenerationJob(job.id)
          return false
        }
        set({ lastGenerationRequest: scrubGenerationRequest({ ...preparedRequest, jobId: job.id }) })
        syncJob(job)
        if (job.status === 'queued' || job.status === 'running') pollJob(job.id)
        return true
      } catch (error) {
        if (get().document.id !== document.id || runId !== submissionRunId) return false
        return applySubmissionFailure(preparedRequest, error)
      }
    },

    runRefinement: async ({ targetNodeId, prompt, batchCount, settings, recipe: inputRecipe, rootRecipe: inputRootRecipe, taskLayout, sourceGraphNodeId, title, refinementMode = 'faithful', agentRun }) => {
      if (editingBlocked()) return false
      if (get().generationStatus !== 'idle' && get().generationStatus !== 'error') return false
      const cleanPrompt = prompt.trim()
      if (!cleanPrompt) return setGenerationError('请先描述要如何精修这张首图。')
      const document = get().document
      const target = document.nodes.find((node) => node.id === targetNodeId)
      if (!target || target.type !== 'result') return setGenerationError('未找到要精修的首图，请重新选择。')
      const result = target.data as ResultNodeData
      if (!result.image) return setGenerationError('请先从这次生成的结果中选中一张首图，再进行定向精修。')
      const parentVersionId = result.versionId ?? document.activeVersionId
      const parentLabel = result.label ?? '已选首图'
      const parentImage = result.image
      const normalizedBatchCount = clampBatchCount(batchCount)
      const regionEditRequested = Boolean(inputRecipe?.maskImage || inputRecipe?.maskRegion)
      const persistedSettings = result.generationSettings
        ?? result.generationRecipe?.settings
        ?? result.rootRecipe?.settings
      const effectiveSettings = regionEditRequested
        ? settingsForRegionEdit(persistedSettings ?? settings, get().availableModels)
        : cloneGenerationSettings(settings)
      if (!effectiveSettings) return setGenerationError('当前没有支持局部重绘的图片模型，请先配置可用模型。')
      const builtRecipe = inputRecipe
        ? cloneGenerationRecipe({ ...inputRecipe, prompt: cleanPrompt, batchCount: normalizedBatchCount, settings: effectiveSettings })
        : result.generationRecipe
          ? cloneGenerationRecipe({ ...result.generationRecipe, prompt: cleanPrompt, batchCount: normalizedBatchCount, settings: effectiveSettings })
          : buildGenerationRecipe(document, cleanPrompt, normalizedBatchCount, effectiveSettings)
      const recipe = withRegionEditOverlayReferences(builtRecipe, result.generationRecipe ?? result.rootRecipe)
      const rootRecipe = cloneGenerationRecipe(inputRootRecipe ?? result.rootRecipe ?? result.generationRecipe ?? recipe)
      try {
        await assertGenerationServiceReady()
      } catch (error) {
        if (get().document.id !== document.id) return false
        return setGenerationError(error instanceof Error ? error.message : '生成服务暂不可用，请稍后重新检查。')
      }
      if (get().document.id !== document.id) return false
      const request: GenerationRequest = {
        kind: 'refinement', prompt: cleanPrompt, batchCount: normalizedBatchCount,
        settings: cloneGenerationSettings(effectiveSettings), recipe: cloneGenerationRecipe(recipe), rootRecipe,
        targetNodeId, parentVersionId, parentImage, parentLabel, taskLayout, sourceGraphNodeId, title,
        refinementMode, agentRun, idempotencyKey: createGenerationSubmissionKey(),
      }
      const flow = createTaskFlow(document, request, target)
      const preparedRequest = { ...request, taskNodeIds: flow.taskNodeIds }
      const runId = ++submissionRunId
      await commitDocument(flow.document, {
        generationStatus: 'uploading', generationProgress: 0, generationError: null,
        expectedCandidateCount: normalizedBatchCount, generationCandidates: [], lastGenerationRequest: preparedRequest,
        assistantMessage: `正在提交「${parentLabel}」的精修任务。`,
      }, { immediate: true })
      if (get().document.id !== document.id) return false
      if (editingBlocked()) return pauseGenerationSubmission(preparedRequest)
      try {
        const job = await submitGenerationJob({
          projectId: document.id, kind: request.kind, prompt: request.prompt,
          batchCount: request.batchCount, settings: request.settings, recipe,
          parent: { nodeId: targetNodeId, name: parentLabel, image: parentImage },
          refinementMode, agentRun, idempotencyKey: request.idempotencyKey,
        })
        if (get().document.id !== document.id) return false
        if (runId !== submissionRunId) {
          void cancelGenerationJob(job.id)
          return false
        }
        set({ lastGenerationRequest: scrubGenerationRequest({ ...preparedRequest, jobId: job.id }) })
        syncJob(job)
        if (job.status === 'queued' || job.status === 'running') pollJob(job.id)
        return true
      } catch (error) {
        if (get().document.id !== document.id || runId !== submissionRunId) return false
        return applySubmissionFailure(preparedRequest, error)
      }
    },

    cancelGeneration: () => {
      const projectId = get().document.id
      const request = get().lastGenerationRequest
      if (!request?.taskNodeIds || !['uploading', 'queued', 'running'].includes(get().generationStatus)) return
      submissionRunId += 1
      stopPolling()
      const cancelledDocument = updateTaskNodes(get().document, request.taskNodeIds, 'cancelled', request.jobId)
      void commitDocument(cancelledDocument, {
        generationStatus: 'idle', generationProgress: 0, generationError: null,
        expectedCandidateCount: 0, generationCandidates: [],
        assistantMessage: request.jobId ? '正在取消生成任务…' : '已取消本地素材提交。',
      })
      if (!request.jobId) return
      void cancelGenerationJob(request.jobId).then((job) => {
        if (get().document.id === projectId) syncJob(job)
      }).catch(() => {
        if (get().document.id === projectId) set({ assistantMessage: '取消请求未能同步到服务端，请在任务面板稍后确认状态。' })
      })
    },

    retryGeneration: async () => {
      const request = get().lastGenerationRequest
      if (!request) return setGenerationError('没有可重试的生成任务。')
      const job = request.jobId ? get().document.generationJobs.find((item) => item.id === request.jobId) : undefined
      const retryBatchCount = job?.missingOutputCount || request.batchCount
      if (request.kind === 'refinement' && request.targetNodeId) {
        return get().runRefinement({
          targetNodeId: request.targetNodeId, prompt: request.prompt, batchCount: retryBatchCount,
          settings: request.settings, recipe: request.recipe, rootRecipe: request.rootRecipe,
          taskLayout: request.taskLayout, sourceGraphNodeId: request.sourceGraphNodeId ?? request.taskNodeIds?.generateNodeId,
          refinementMode: request.refinementMode,
        })
      }
      return get().runGeneration({
        prompt: request.prompt, batchCount: retryBatchCount, settings: request.settings,
        recipe: request.recipe, rootRecipe: request.rootRecipe, taskLayout: request.taskLayout,
        sourceGraphNodeId: request.taskNodeIds?.generateNodeId,
      })
    },

    retryMissingGeneration: async (jobId) => {
      const document = get().document
      const job = document.generationJobs.find((item) => item.id === jobId)
      if (!job?.missingOutputCount) return setGenerationError('本任务没有待补生成的图。')
      const request = requestFromPersistedGenerationJob(document, job)
      if (!request?.recipe) return setGenerationError('无法恢复本次生成参数，请基于任一结果继续生成。')
      if (request.kind === 'refinement' && request.targetNodeId) {
        return get().runRefinement({
          targetNodeId: request.targetNodeId, prompt: request.prompt, batchCount: job.missingOutputCount,
          settings: request.settings, recipe: request.recipe, rootRecipe: request.rootRecipe,
          sourceGraphNodeId: request.sourceGraphNodeId, refinementMode: request.refinementMode,
        })
      }
      return get().runGeneration({
        prompt: request.prompt, batchCount: job.missingOutputCount, settings: request.settings,
        recipe: request.recipe, rootRecipe: request.rootRecipe, sourceGraphNodeId: request.sourceGraphNodeId,
      })
    },

    clearGenerationError: () => {
      if (get().generationStatus !== 'error') return
      set({ generationStatus: 'idle', generationError: null })
    },
  }

  return { actions, stopPolling, pollJob, recoverTaskNodeJobs, recoverResults, createSubmissionKey: createGenerationSubmissionKey }
}
