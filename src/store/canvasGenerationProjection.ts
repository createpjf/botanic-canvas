import type { Edge, XYPosition } from '@xyflow/react'
import { generationResultNodeLabel, generationTaskResultLabel } from '../domain/canvasPresentation.ts'
import { planGenerationOutputPlacement } from '../domain/generationOutputPlacement.ts'
import { cloneGenerationRecipe, cloneGenerationSettings } from '../domain/generationRecipe.ts'
import type { BatchVariationRun, CanvasDocument, CanvasGenerationTaskStatus, CanvasNode, GenerationCandidate, GenerationJob, GenerationSettings, GenerateNodeData, ResultNodeData } from '../domain/canvas.ts'
import { migrationInputEdge, nextTaskFlowStartX } from './canvasDocumentMigration.ts'
import type { GenerationRequest, TaskNodeIds } from './canvasStore.types.ts'

let taskFlowSequence = 0

function taskResultStatus(status: CanvasGenerationTaskStatus): ResultNodeData['status'] {
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'succeeded') return 'ready'
  return 'generating'
}

function taskFlowLabel(kind: GenerationRequest['kind']) {
  return kind === 'refinement' ? '定向精修' : '图像生成'
}

/** 输出名保持可读且稳定：优先短标题，不用 Prompt 原文。 */
function generationCandidateName(request: GenerationRequest, variant: number, generateLabel?: string) {
  return generationResultNodeLabel({
    kind: request.kind,
    title: request.title ?? generateLabel,
    generateLabel,
    parentLabel: request.parentLabel,
    variant,
    batchCount: request.batchCount,
  })
}

export function createTaskFlow(
  document: CanvasDocument,
  request: GenerationRequest,
  parentNode?: CanvasNode,
): { document: CanvasDocument; taskNodeIds: TaskNodeIds } {
  const timestamp = Date.now()
  // 批量父任务会在同一帧创建多个子工作流；仅用 Date.now() 会让同毫秒
  // 创建的节点互相覆盖，因此追加会话内单调序号保持 ID 唯一。
  const flowKey = `${timestamp}-${++taskFlowSequence}`
  const sourceGenerateNode = request.sourceGraphNodeId
    ? document.nodes.find((node) => node.id === request.sourceGraphNodeId && node.type === 'generate')
    : undefined
  const generateLabel = sourceGenerateNode
    ? (sourceGenerateNode.data as GenerateNodeData).label
    : request.title
  const taskNodeIds: TaskNodeIds = {
    generateNodeId: sourceGenerateNode?.id ?? `generate-task-${flowKey}`,
    resultNodeId: `result-task-${flowKey}`,
    resultNodeIds: Array.from({ length: request.batchCount }, (_, index) => index
      ? `result-task-${flowKey}-${index + 1}`
      : `result-task-${flowKey}`),
  }
  const x = nextTaskFlowStartX(document.nodes)
  const y = 160
  const existingOutputCount = sourceGenerateNode
    ? document.edges
      .filter((edge) => edge.source === sourceGenerateNode.id)
      .map((edge) => document.nodes.find((node) => node.id === edge.target && node.type === 'result'))
      .filter((node): node is CanvasNode => Boolean(node))
      .reduce((offset, node) => offset + resultNodeBlockHeight((node.data as ResultNodeData).generationSettings ?? request.settings) + 32, 0)
    : 0
  const layout = request.taskLayout ?? (sourceGenerateNode
    ? {
        generate: { ...sourceGenerateNode.position },
        result: { x: sourceGenerateNode.position.x + 372, y: sourceGenerateNode.position.y + 28 + existingOutputCount },
      }
    : {
        generate: { x, y },
        result: { x: x + 378, y: y + 48 },
      })
  const recipe = request.recipe ? cloneGenerationRecipe(request.recipe) : undefined

  if (!recipe) throw new Error('生成参数缺失。')
  const parentRootRecipe = parentNode?.type === 'result'
    ? (parentNode.data as ResultNodeData).rootRecipe ?? (parentNode.data as ResultNodeData).generationRecipe
    : undefined
  const rootRecipe = cloneGenerationRecipe(request.rootRecipe ?? parentRootRecipe ?? recipe)

  const textNodeId = sourceGenerateNode ? undefined : `text-task-${flowKey}`
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
          refinementMode: request.refinementMode,
          submissionKey: request.idempotencyKey,
          agentRun: request.agentRun,
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
          submissionKey: request.idempotencyKey,
          agentRun: request.agentRun,
        },
      }
  const resultNodes: CanvasNode[] = (taskNodeIds.resultNodeIds ?? [taskNodeIds.resultNodeId]).map((resultNodeId, variant) => ({
    id: resultNodeId,
    type: 'result',
    position: resultGridPosition(layout.result, { variant, settings: request.settings }),
    draggable: true,
    data: {
      kind: 'result',
      outputOf: taskNodeIds.generateNodeId,
      status: 'generating',
      taskStatus: 'uploading',
      submittedAt: timestamp,
      label: generationCandidateName(request, variant, generateLabel),
      generationKind: request.kind,
      refinementMode: request.refinementMode,
      generationSettings: cloneGenerationSettings(request.settings),
      generationRecipe: recipe,
      rootRecipe,
      variant,
      taskGroupId: taskNodeIds.resultNodeId,
      taskNodeId: taskNodeIds.resultNodeId,
      submissionKey: request.idempotencyKey,
      agentRun: request.agentRun,
    },
  }))
  const taskEdges: Edge[] = []
  const nodeIds = new Set(document.nodes.map((node) => node.id))
  if (!sourceGenerateNode) {
    for (const reference of recipe.references) {
      if (!nodeIds.has(reference.nodeId)) continue
      taskEdges.push({
        ...migrationInputEdge(`task-asset-generate-${flowKey}-${reference.nodeId}`, reference.nodeId, taskNodeIds.generateNodeId, undefined, 'asset-output'),
        className: 'task-edge',
      })
    }
    if (textNodeId) {
      taskEdges.push({
        ...migrationInputEdge(`task-text-generate-${flowKey}`, textNodeId, taskNodeIds.generateNodeId),
        className: 'task-edge',
      })
    }
  }

  if (parentNode && !document.edges.some((edge) => edge.source === parentNode.id && edge.target === taskNodeIds.generateNodeId)) {
    taskEdges.push({
      id: `task-parent-generate-${flowKey}`,
      source: parentNode.id,
      target: taskNodeIds.generateNodeId,
      targetHandle: 'input',
      type: 'default',
      style: { stroke: '#7e9785', strokeWidth: 1.2, strokeDasharray: '4 3' },
      className: 'task-edge',
    })
  }

  for (const resultNode of resultNodes) {
    taskEdges.push({
      id: `task-generate-result-${flowKey}-${resultNode.id}`,
      source: taskNodeIds.generateNodeId,
      sourceHandle: 'output',
      target: resultNode.id,
      type: 'default',
      style: { stroke: '#2a5238', strokeWidth: 1.7 },
      className: 'task-edge',
      data: { system: true, role: 'output' },
      reconnectable: false,
    })
  }

  const baseNodes = document.nodes
    .map((node) => node.id === taskNodeIds.generateNodeId
      ? generateNode
      : { ...node, selected: false }) as CanvasNode[]
  if (!sourceGenerateNode) baseNodes.push(generateNode)
  if (textNode) baseNodes.push(textNode)
  baseNodes.push(...resultNodes)

  return {
    document: {
      ...document,
      nodes: baseNodes,
      edges: [...document.edges, ...taskEdges],
    },
    taskNodeIds,
  }
}
export function updateTaskNodes(
  document: CanvasDocument,
  taskNodeIds: TaskNodeIds,
  status: CanvasGenerationTaskStatus,
  jobId?: string,
  error?: string,
  errorCode?: string,
) {
  const nodes = document.nodes.map((node) => {
    if (node.id === taskNodeIds.generateNodeId && node.type === 'generate') {
      return {
        ...node,
        data: { ...(node.data as GenerateNodeData), status, jobId, error, errorCode },
      }
    }
    if (node.type === 'result') {
      const result = node.data as ResultNodeData
      const belongsToTask = node.id === taskNodeIds.resultNodeId
        || result.taskGroupId === taskNodeIds.resultNodeId
        || result.taskNodeId === taskNodeIds.resultNodeId
      if (!belongsToTask) return node
      return {
        ...node,
        data: {
          ...result,
          status: taskResultStatus(status),
          taskStatus: status,
          jobId,
          taskGroupId: taskNodeIds.resultNodeId,
          taskNodeId: taskNodeIds.resultNodeId,
          error,
          errorCode,
          label: generationTaskResultLabel({
            generationKind: result.generationKind,
            status,
            previousTaskStatus: result.taskStatus,
            error,
            currentLabel: result.label,
          }),
        },
      }
    }
    return node
  }) as CanvasNode[]
  return { ...document, nodes }
}


const generationSubmissionTimeoutMs = 5 * 60_000

/**
 * 提交请求在写入服务端 jobId 前中断时，旧版本会把占位结果永久恢复为 uploading。
 * 打开画布时把超过时限的占位任务变为可重试失败状态；恢复场景可立即收口无 jobId 占位。
 */
export function settleExpiredGenerationSubmissions(
  document: CanvasDocument,
  options?: { immediate?: boolean },
) {
  const now = Date.now()
  let nextDocument = document
  let changed = false
  for (const node of document.nodes) {
    if (node.type !== 'result') continue
    const result = node.data as ResultNodeData
    if (result.taskGroupId && result.taskGroupId !== node.id) continue
    if (
      result.taskStatus !== 'uploading'
      || result.jobId
      || !result.outputOf
    ) continue
    const generateNode = nextDocument.nodes.find((node) => node.id === result.outputOf && node.type === 'generate')
    const generate = generateNode?.type === 'generate' ? generateNode.data as GenerateNodeData : undefined
    const submissionKey = result.submissionKey ?? generate?.submissionKey
    // 有幂等键的 uploading 占位应走 recovering 确认，不能刷新即标 failed 诱发重复提交。
    if (options?.immediate && submissionKey) continue
    if (!options?.immediate) {
      if (!result.submittedAt || now - result.submittedAt < generationSubmissionTimeoutMs) continue
    }
    nextDocument = updateTaskNodes(
      nextDocument,
      { generateNodeId: result.outputOf, resultNodeId: node.id },
      'failed',
      undefined,
      options?.immediate
        ? '任务提交已中断，请重试。'
        : '任务提交超过 5 分钟，未进入生成队列。请重试。',
    )
    changed = true
  }
  return { document: nextDocument, changed }
}

function jobForDocument(
  job: GenerationJob,
  taskNodeIds: TaskNodeIds,
  dismissedOutputIds: string[] = [],
  projectionDismissedAt?: number,
): GenerationJob {
  // `cancelOutcome` 是取消接口对**那一次调用**的计费判定，不是任务的持久事实：
  // 落进文档后每次读取都会把它当成历史重放，轮询同一任务却又拿不到它。
  const {
    promptNodeId: _promptNodeId,
    referenceNodeId: _referenceNodeId,
    cancelOutcome: _cancelOutcome,
    ...persistedJob
  } = job as GenerationJob & { cancelOutcome?: unknown }
  const outputs = job.status === 'succeeded' && !projectionDismissedAt
    ? job.outputs?.filter((output) => !dismissedOutputIds.includes(output.id)).map((output) => ({ ...output }))
    : undefined
  return {
    ...persistedJob,
    // 已完成任务的每张输出都随项目持久化；被用户移除的候选不再恢复。
    outputs,
    outputCount: outputs?.length ?? job.outputCount,
    dismissedOutputIds: dismissedOutputIds.length ? [...dismissedOutputIds] : undefined,
    projectionDismissedAt,
    generateNodeId: taskNodeIds.generateNodeId,
    resultNodeId: taskNodeIds.resultNodeId,
  }
}

export function recordGenerationJob(document: CanvasDocument, job: GenerationJob, taskNodeIds: TaskNodeIds) {
  const taskDocument = updateTaskNodes(document, taskNodeIds, job.status, job.id, job.error, job.errorCode)
  const priorJob = document.generationJobs.find((item) => item.id === job.id)
  const dismissedOutputIds = [...new Set([...(priorJob?.dismissedOutputIds ?? []), ...(job.dismissedOutputIds ?? [])])]
  const projectionDismissedAt = Math.max(
    priorJob?.projectionDismissedAt ?? 0,
    job.projectionDismissedAt ?? 0,
  ) || undefined
  const persistedJob = jobForDocument(job, taskNodeIds, dismissedOutputIds, projectionDismissedAt)
  return {
    ...taskDocument,
    generationJobs: [
      persistedJob,
      ...taskDocument.generationJobs.filter((item) => item.id !== job.id),
    ].slice(0, 60),
  }
}

export function generationJobsAfterNodeRemoval(
  document: CanvasDocument,
  removed: CanvasNode,
  now = Date.now(),
): GenerationJob[] {
  const data = removed.data as { jobId?: string; candidateId?: string }
  return document.generationJobs.map((job) => {
    if (data.jobId !== job.id
      && job.promptNodeId !== removed.id
      && job.generateNodeId !== removed.id
      && job.resultNodeId !== removed.id) return job
    const dismissedOutputIds = new Set(job.dismissedOutputIds ?? [])
    const candidateId = removed.type === 'result'
      ? data.candidateId ?? (job.outputs?.length === 1 ? job.outputs[0]?.id : undefined)
      : undefined
    if (candidateId) dismissedOutputIds.add(candidateId)
    const outputs = job.outputs?.filter((output) => !dismissedOutputIds.has(output.id))
    return {
      ...job,
      outputs,
      outputCount: outputs?.length ?? job.outputCount,
      dismissedOutputIds: dismissedOutputIds.size ? [...dismissedOutputIds] : undefined,
      projectionDismissedAt: candidateId
        ? job.projectionDismissedAt
        : Math.max(job.projectionDismissedAt ?? 0, now),
    }
  })
}


export function candidatesFromJob(job: GenerationJob, request: GenerationRequest): GenerationCandidate[] {
  const recipe = request.recipe
  if (!recipe) return []
  return (job.outputs ?? []).map((output, index) => ({
    id: output.id,
    name: generationCandidateName(request, index, request.title),
    image: output.image,
    mediaKind: output.mediaKind ?? 'image',
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
    refinementMode: request.refinementMode,
    settings: cloneGenerationSettings(request.settings),
    recipe: cloneGenerationRecipe(recipe),
    rootRecipe: request.rootRecipe ? cloneGenerationRecipe(request.rootRecipe) : cloneGenerationRecipe(recipe),
    jobId: job.id,
    resultNodeId: request.taskNodeIds?.resultNodeId,
    provider: job.provider,
    revisedPrompt: output.revisedPrompt,
  }))
}

function resultNodeBlockHeight(settings: GenerationSettings) {
  return settings.aspectRatio === '16:9'
    ? 207
    : settings.aspectRatio === '4:3'
      ? 263
      : settings.aspectRatio === '9:16'
    ? 570
    : settings.aspectRatio === '4:5'
      ? 412
      : settings.aspectRatio === '1:1'
        ? 338
        : 436
}

function resultGridPosition(origin: XYPosition, candidate: Pick<GenerationCandidate, 'variant' | 'settings'>) {
  const height = resultNodeBlockHeight(candidate.settings)
  return {
    // 同一次生成的多张结果沿同一输出列纵向展开，避免节点边框与端口挤在一起。
    x: origin.x,
    y: origin.y + candidate.variant * (height + 32),
  }
}

/** 将一次任务的全部输出展开为同级结果节点；不再把候选藏在临时面板里。 */
export function materializeGenerationOutputs(document: CanvasDocument, job: GenerationJob, request: GenerationRequest): CanvasDocument {
  if (document.generationJobs.find((item) => item.id === job.id)?.projectionDismissedAt) return document
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
  const reusableTaskNodeIds = document.nodes
    .filter((node) => node.type === 'result')
    .filter((node) => {
      const result = node.data as ResultNodeData
      return !result.image
        && !result.candidateId
        && (node.id === taskResultNodeId || result.taskGroupId === taskResultNodeId || result.taskNodeId === taskResultNodeId)
    })
    .sort((left, right) => ((left.data as ResultNodeData).variant ?? 0) - ((right.data as ResultNodeData).variant ?? 0))
    .map((node) => node.id)
  const placements = planGenerationOutputPlacement({
    jobId: job.id,
    outputIds: candidates.map((candidate) => candidate.id),
    resultNodes: document.nodes
      .filter((node) => node.type === 'result')
      .map((node) => {
        const result = node.data as ResultNodeData
        return {
          id: node.id,
          jobId: result.jobId,
          candidateId: result.candidateId,
          hasImage: Boolean(result.image),
        }
      }),
    reusableTaskNodeIds,
  })
  const placementByOutputId = new Map(placements.map((placement) => [placement.outputId, placement]))

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
      mediaKind: candidate.mediaKind ?? 'image',
      selected: false,
      status: 'ready',
      taskStatus: 'succeeded',
      submittedAt: taskResult?.submittedAt ?? job.createdAt,
      label: candidate.name,
      jobId: job.id,
      taskGroupId: taskResultNodeId,
      taskNodeId: nodeId,
      error: undefined,
      candidateId: candidate.id,
      versionId: undefined,
      parentVersionId: candidate.parentVersionId,
      generationKind: candidate.kind,
      refinementMode: candidate.refinementMode,
      refinementInstruction: candidate.refinementInstruction,
      generationSettings: cloneGenerationSettings(candidate.settings),
      generationRecipe: cloneGenerationRecipe(candidate.recipe),
      rootRecipe: cloneGenerationRecipe(candidate.rootRecipe ?? candidate.recipe),
      variant: candidate.variant,
    },
  })

  const reusableCandidateByNodeId = new Map<string, GenerationCandidate>()
  for (const candidate of candidates) {
    const placement = placementByOutputId.get(candidate.id)
    if (placement?.action === 'replace' && placement.nodeId) {
      reusableCandidateByNodeId.set(placement.nodeId, candidate)
    }
  }
  const nodes = document.nodes.map((node) => {
    const candidate = reusableCandidateByNodeId.get(node.id)
    return candidate ? createResultNode(candidate, node.id, node.position) : node
  }) as CanvasNode[]
  const extraNodes: CanvasNode[] = []
  const extraEdges: Edge[] = []
  for (const candidate of candidates) {
    if (placementByOutputId.get(candidate.id)?.action !== 'create') continue
    const nodeId = `result-${job.id}-${candidate.id}`
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
  if (!reusableCandidateByNodeId.size && !extraNodes.length) return document
  return { ...document, nodes: [...nodes, ...extraNodes], edges: [...document.edges, ...extraEdges] }
}


export function applyGenerationJobToDocument(document: CanvasDocument, job: GenerationJob, request: GenerationRequest) {
  if (!request.taskNodeIds) return document
  const recordedDocument = recordGenerationJob(document, job, request.taskNodeIds)
  if (job.status === 'succeeded') {
    const recordedJob = recordedDocument.generationJobs.find((item) => item.id === job.id) ?? job
    if (recordedJob.projectionDismissedAt) return recordedDocument
    const candidates = candidatesFromJob(recordedJob, request)
    return candidates.length
      ? materializeGenerationOutputs(recordedDocument, recordedJob, request)
      : updateTaskNodes(recordedDocument, request.taskNodeIds, 'failed', job.id, '生成服务没有返回结果，请重试。')
  }
  if (job.status === 'failed') {
    return updateTaskNodes(recordedDocument, request.taskNodeIds, 'failed', job.id, job.error ?? '生成任务失败，请重试。', job.errorCode)
  }
  if (job.status === 'cancelled') {
    return updateTaskNodes(recordedDocument, request.taskNodeIds, 'cancelled', job.id, job.error)
  }
  return recordedDocument
}

export function updateBatchVariationItemDocument(
  document: CanvasDocument,
  runId: string,
  itemId: string,
  patch: Partial<BatchVariationRun['items'][number]>,
) {
  return {
    ...document,
    batchVariationRuns: document.batchVariationRuns.map((run) => run.id === runId
      ? {
          ...run,
          items: run.items.map((item) => item.id === itemId ? { ...item, ...patch } : item),
          updatedAt: Date.now(),
        }
      : run),
  }
}
