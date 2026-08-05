import { buildGraphGenerationRecipe, cloneGenerationRecipe, cloneGenerationSettings } from '../domain/generationRecipe.ts'
import { findUnknownSubmissionAnchor } from '../domain/generationRecovery.ts'
import type { CanvasDocument, CanvasNode, GenerationJob, GenerateNodeData, ResultNodeData } from '../domain/canvas.ts'
import type { GenerationRequest, PersistedGenerationState } from './canvasStore.types.ts'

export function requestFromPersistedGenerationJob(document: CanvasDocument, job: GenerationJob): GenerationRequest | null {
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
    idempotencyKey: job.idempotencyKey,
    taskNodeIds: { generateNodeId: generateNode.id, resultNodeId: job.resultNodeId },
    refinementMode: generate.refinementMode,
  }
}

export function requestFromGenerationTaskNode(document: CanvasDocument, taskResultNode: CanvasNode): GenerationRequest | null {
  if (taskResultNode.type !== 'result') return null
  const result = taskResultNode.data as ResultNodeData
  const jobId = result.jobId
  const generateNodeId = result.outputOf
  if (!jobId || !generateNodeId) return null
  const generateNode = document.nodes.find((node) => node.id === generateNodeId && node.type === 'generate')
  if (!generateNode || generateNode.type !== 'generate') return null
  const generate = generateNode.data as GenerateNodeData
  const recipe = result.generationRecipe
    ? cloneGenerationRecipe(result.generationRecipe)
    : buildGraphGenerationRecipe(document, generateNode.id)?.recipe
  if (!recipe) return null

  const kind = result.generationKind ?? generate.generationKind ?? 'generation'
  const parentNodeId = kind === 'refinement'
    ? document.edges.find((edge) => edge.target === generateNode.id && document.nodes.some((node) => node.id === edge.source && node.type === 'result'))?.source
    : undefined
  const parentNode = parentNodeId
    ? document.nodes.find((node) => node.id === parentNodeId && node.type === 'result')
    : undefined
  const parent = parentNode?.type === 'result' ? parentNode.data as ResultNodeData : undefined
  return {
    kind,
    prompt: recipe.prompt || generate.prompt,
    batchCount: recipe.batchCount,
    settings: cloneGenerationSettings(recipe.settings),
    recipe,
    rootRecipe: result.rootRecipe ? cloneGenerationRecipe(result.rootRecipe) : cloneGenerationRecipe(recipe),
    targetNodeId: parentNodeId,
    parentVersionId: parent?.versionId,
    parentImage: parent?.image,
    parentLabel: parent?.label,
    jobId,
    idempotencyKey: document.generationJobs.find((item) => item.id === jobId)?.idempotencyKey,
    taskNodeIds: { generateNodeId: generateNode.id, resultNodeId: result.taskGroupId ?? taskResultNode.id },
    refinementMode: result.refinementMode ?? generate.refinementMode,
  }
}

export function requestFromUnknownGenerationSubmission(document: CanvasDocument): GenerationRequest | null {
  const anchor = findUnknownSubmissionAnchor(document.nodes)
  if (!anchor) return null
  const { generateNode, resultNode: taskResultNode, resultNodeIds, submissionKey: idempotencyKey } = anchor
  const generate = generateNode.data as GenerateNodeData
  const result = taskResultNode.data as ResultNodeData
  const recipe = result.generationRecipe
    ? cloneGenerationRecipe(result.generationRecipe)
    : buildGraphGenerationRecipe(document, generateNode.id)?.recipe
  if (!idempotencyKey || !recipe) return null

  const kind = result.generationKind ?? generate.generationKind ?? 'generation'
  const parentNodeId = kind === 'refinement'
    ? document.edges.find((edge) => edge.target === generateNode.id && document.nodes.some((node) => node.id === edge.source && node.type === 'result'))?.source
    : undefined
  const parentNode = parentNodeId
    ? document.nodes.find((node) => node.id === parentNodeId && node.type === 'result')
    : undefined
  const parent = parentNode?.type === 'result' ? parentNode.data as ResultNodeData : undefined
  return {
    kind,
    prompt: recipe.prompt || generate.prompt,
    batchCount: recipe.batchCount,
    settings: cloneGenerationSettings(recipe.settings),
    recipe,
    rootRecipe: result.rootRecipe ? cloneGenerationRecipe(result.rootRecipe) : cloneGenerationRecipe(recipe),
    targetNodeId: parentNodeId,
    parentVersionId: parent?.versionId,
    parentImage: parent?.image,
    parentLabel: parent?.label,
    idempotencyKey,
    taskNodeIds: {
      generateNodeId: generateNode.id,
      resultNodeId: result.taskGroupId ?? taskResultNode.id,
      resultNodeIds,
    },
    refinementMode: result.refinementMode ?? generate.refinementMode,
    agentRun: result.agentRun ?? generate.agentRun,
  }
}

/** 从持久化任务恢复 UI 状态；任务记录而非本地 loading 是权威。 */
export function restoreGenerationLifecycleState(
  document: CanvasDocument,
  fallbackMessage: string,
): { state: PersistedGenerationState; pollJobId?: string } {
  const idleState: PersistedGenerationState = {
    assistantMessage: fallbackMessage,
    generationStatus: 'idle',
    generationProgress: 0,
    generationError: null,
    expectedCandidateCount: 0,
    generationCandidates: [],
    lastGenerationRequest: null,
  }
  const unknownSubmissionRequest = requestFromUnknownGenerationSubmission(document)
  if (unknownSubmissionRequest) {
    return {
      state: {
        ...idleState,
        lastGenerationRequest: unknownSubmissionRequest,
        generationStatus: 'recovering',
        expectedCandidateCount: unknownSubmissionRequest.batchCount,
        assistantMessage: '已恢复一个提交状态未知的任务；正在用原幂等键确认，请勿重复提交。',
      },
    }
  }
  const latestJob = [...document.generationJobs].sort((left, right) => right.updatedAt - left.updatedAt)[0]
  const request = latestJob ? requestFromPersistedGenerationJob(document, latestJob) : null
  if (!latestJob || !request) return { state: idleState }

  if (latestJob.status === 'queued' || latestJob.status === 'running') {
    return {
      state: {
        ...idleState,
        lastGenerationRequest: request,
        generationStatus: latestJob.status,
        expectedCandidateCount: latestJob.batchCount,
        assistantMessage: '已恢复真实生成任务，正在同步生成服务状态。',
      },
      pollJobId: latestJob.id,
    }
  }
  if (latestJob.status === 'succeeded' && latestJob.outputs?.length) {
    return {
      state: {
        ...idleState,
        lastGenerationRequest: { ...request, jobId: latestJob.id },
        assistantMessage: `已恢复 ${latestJob.outputs.length} 个生成结果；每个结果都保留在画布中。`,
      },
    }
  }
  if (latestJob.status === 'failed') {
    const message = latestJob.error ?? '真实生成任务失败，请重试。'
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
    return { state: { ...idleState, assistantMessage: '上一次真实生成任务已取消；提示词、参考组和节点记录仍可继续使用。' } }
  }
  return { state: idleState }
}
