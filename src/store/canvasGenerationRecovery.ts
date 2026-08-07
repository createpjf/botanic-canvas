import type { Edge } from '@xyflow/react'
import type { CanvasDocument, CanvasNode, GenerationJob, ResultNodeData } from '../domain/canvas.ts'

function mergeGenerationJob(current: GenerationJob | undefined, recovered: GenerationJob) {
  const preferRecovered = !current
    || recovered.updatedAt > current.updatedAt
    || (recovered.outputs?.length ?? 0) > (current.outputs?.length ?? 0)
  const preferred = preferRecovered ? { ...current, ...recovered } : { ...recovered, ...current }
  const dismissedOutputIds = [...new Set([
    ...(current?.dismissedOutputIds ?? []),
    ...(recovered.dismissedOutputIds ?? []),
  ])]
  const outputs = preferred.outputs?.filter((output) => !dismissedOutputIds.includes(output.id))
  return {
    ...preferred,
    outputs,
    outputCount: outputs?.length ?? preferred.outputCount,
    dismissedOutputIds: dismissedOutputIds.length ? dismissedOutputIds : undefined,
  }
}

function resultOutputIdentity(node: CanvasNode) {
  if (node.type !== 'result') return null
  const data = node.data as ResultNodeData
  if (!data.image || !data.jobId || !data.candidateId) return null
  return { jobId: data.jobId, outputId: data.candidateId }
}

function mergeRecoveredResultNode(current: CanvasNode, recovered: CanvasNode): CanvasNode {
  const localData = current.data as ResultNodeData
  const recoveredData = recovered.data as ResultNodeData
  return {
    ...recovered,
    ...current,
    position: { ...current.position },
    selected: current.selected,
    data: {
      ...localData,
      ...recoveredData,
      // 结果媒体与任务状态来自持久化任务；本地布局、选择和可读名称继续保留。
      status: recoveredData.image ? 'ready' : recoveredData.status,
      taskStatus: recoveredData.image ? 'succeeded' : recoveredData.taskStatus,
      error: recoveredData.image ? undefined : recoveredData.error,
      label: localData.label ?? recoveredData.label,
      selected: localData.selected ?? recoveredData.selected,
    },
  } as CanvasNode
}

function edgeIdentity(edge: Edge) {
  return `${edge.source}\u0000${edge.sourceHandle ?? ''}\u0000${edge.target}\u0000${edge.targetHandle ?? ''}`
}

/**
 * 合并服务端生成任务对账结果。当前画布仍拥有本地布局与编辑。
 */
export function mergeRecoveredGenerationJobs(current: CanvasDocument, recovered: CanvasDocument): CanvasDocument {
  const jobsById = new Map(current.generationJobs.map((job) => [job.id, job]))
  for (const job of recovered.generationJobs) {
    jobsById.set(job.id, mergeGenerationJob(jobsById.get(job.id), job))
  }

  const recoverableOutputs = new Map<string, Set<string>>()
  for (const job of jobsById.values()) {
    if (job.status !== 'succeeded' || !job.outputs?.length) continue
    recoverableOutputs.set(job.id, new Set(job.outputs.map((output) => output.id)))
  }

  const recoveredOutputNodes = new Map<string, CanvasNode>()
  for (const node of recovered.nodes) {
    const identity = resultOutputIdentity(node)
    if (!identity || !recoverableOutputs.get(identity.jobId)?.has(identity.outputId)) continue
    recoveredOutputNodes.set(node.id, node)
  }

  const acceptedResultNodeIds = new Set<string>()
  const nodes = current.nodes.map((node) => {
    const recoveredNode = recoveredOutputNodes.get(node.id)
    if (!recoveredNode || node.type !== 'result') return node
    acceptedResultNodeIds.add(node.id)
    return mergeRecoveredResultNode(node, recoveredNode)
  }) as CanvasNode[]
  const currentNodeIds = new Set(nodes.map((node) => node.id))
  for (const node of recovered.nodes) {
    if (!recoveredOutputNodes.has(node.id) || currentNodeIds.has(node.id)) continue
    nodes.push({ ...node, selected: false } as CanvasNode)
    currentNodeIds.add(node.id)
    acceptedResultNodeIds.add(node.id)
  }

  const edges = [...current.edges]
  const edgeIds = new Set(edges.map((edge) => edge.id))
  const edgeIdentities = new Set(edges.map(edgeIdentity))
  for (const edge of recovered.edges) {
    if (!acceptedResultNodeIds.has(edge.source) && !acceptedResultNodeIds.has(edge.target)) continue
    if (!currentNodeIds.has(edge.source) || !currentNodeIds.has(edge.target)) continue
    const identity = edgeIdentity(edge)
    if (edgeIds.has(edge.id) || edgeIdentities.has(identity)) continue
    edges.push(edge)
    edgeIds.add(edge.id)
    edgeIdentities.add(identity)
  }

  return {
    ...current,
    nodes,
    edges,
    generationJobs: [...jobsById.values()].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 60),
  }
}
