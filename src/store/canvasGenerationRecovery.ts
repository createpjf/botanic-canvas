import type { Edge } from '@xyflow/react'
import type { CanvasDocument, CanvasNode, GenerationJob, ResultNodeData } from '../domain/canvas.ts'

function mergeGenerationJob(current: GenerationJob | undefined, recovered: GenerationJob) {
  const preferRecovered = !current
    || recovered.updatedAt >= current.updatedAt
    || (recovered.outputs?.length ?? 0) > (current.outputs?.length ?? 0)
  const preferred = preferRecovered ? { ...current, ...recovered } : { ...recovered, ...current }
  const dismissedOutputIds = [...new Set([
    ...(current?.dismissedOutputIds ?? []),
    ...(recovered.dismissedOutputIds ?? []),
  ])]
  const projectionDismissedAt = Math.max(
    current?.projectionDismissedAt ?? 0,
    recovered.projectionDismissedAt ?? 0,
  ) || undefined
  const outputs = preferred.outputs?.filter((output) => !dismissedOutputIds.includes(output.id))
  return {
    ...preferred,
    outputs,
    outputCount: outputs?.length ?? preferred.outputCount,
    dismissedOutputIds: dismissedOutputIds.length ? dismissedOutputIds : undefined,
    projectionDismissedAt,
  }
}

function resultOutputIdentity(node: CanvasNode) {
  if (node.type !== 'result') return null
  const data = node.data as ResultNodeData
  if (!data.image || !data.jobId) return null
  return { jobId: data.jobId, outputId: data.candidateId ?? '__single__' }
}

function agentWorkflowNodeIds(document: CanvasDocument, jobs: GenerationJob[]) {
  const recoverableJobs = jobs.filter((job) => job.status === 'succeeded' && job.outputs?.length && job.agentRun && !job.projectionDismissedAt)
  const jobIds = new Set(recoverableJobs.map((job) => job.id))
  const nodeIds = new Set<string>()
  for (const job of recoverableJobs) {
    const suffix = `${job.agentRun!.runId}-${job.agentRun!.branchId}`.replace(/[^A-Za-z0-9_-]/g, '-')
    nodeIds.add(job.generateNodeId ?? `agent-generate-${suffix}`)
    nodeIds.add(job.resultNodeId ?? `agent-result-${suffix}`)
    nodeIds.add(job.promptNodeId ?? `agent-prompt-${suffix}`)
  }
  for (const node of document.nodes) {
    const data = node.data as { jobId?: string }
    const jobId = typeof data.jobId === 'string' ? data.jobId : undefined
    if (jobId && jobIds.has(jobId)) nodeIds.add(node.id)
  }
  const generateIds = new Set(document.nodes
    .filter((node) => node.type === 'generate' && nodeIds.has(node.id))
    .map((node) => node.id))
  for (const edge of document.edges) {
    if (generateIds.has(edge.target) && edge.data?.role === 'prompt') nodeIds.add(edge.source)
  }
  return nodeIds
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

function recoverySignature(document: CanvasDocument) {
  const agentNodeIds = agentWorkflowNodeIds(document, document.generationJobs)
  const nodes = document.nodes
    .filter((node) => node.type === 'result' || agentNodeIds.has(node.id))
    .map((node) => {
      const data = node.data as ResultNodeData & { prompt?: string; content?: string }
      return {
        id: node.id,
        type: node.type,
        image: data.image,
        jobId: data.jobId,
        candidateId: data.candidateId,
        status: data.status,
        taskStatus: data.taskStatus,
        outputOf: data.outputOf,
        prompt: data.prompt,
        content: data.content,
      }
    })
    .sort((left, right) => left.id.localeCompare(right.id))
  const edges = document.edges
    .filter((edge) => agentNodeIds.has(edge.source) || agentNodeIds.has(edge.target))
    .map((edge) => ({
      source: edge.source,
      sourceHandle: edge.sourceHandle,
      target: edge.target,
      targetHandle: edge.targetHandle,
      role: edge.data?.role,
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  const jobs = document.generationJobs.map((job) => ({
    id: job.id,
    status: job.status,
    outputs: job.outputs,
    agentRun: job.agentRun,
    generateNodeId: job.generateNodeId,
    resultNodeId: job.resultNodeId,
    projectWritebackPending: job.projectWritebackPending,
    projectionDismissedAt: job.projectionDismissedAt,
    dismissedOutputIds: job.dismissedOutputIds,
    error: job.error,
  })).sort((left, right) => left.id.localeCompare(right.id))
  return JSON.stringify({ nodes, edges, jobs })
}

export function hasRecoveredGenerationDelta(current: CanvasDocument, recovered: CanvasDocument) {
  return recoverySignature(current) !== recoverySignature(recovered)
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
    if (job.status !== 'succeeded' || !job.outputs?.length || job.projectionDismissedAt) continue
    const outputIds = new Set(job.outputs.map((output) => output.id))
    if (job.outputs.length === 1) outputIds.add('__single__')
    recoverableOutputs.set(job.id, outputIds)
  }

  const recoveredOutputNodes = new Map<string, CanvasNode>()
  for (const node of recovered.nodes) {
    const identity = resultOutputIdentity(node)
    if (!identity || !recoverableOutputs.get(identity.jobId)?.has(identity.outputId)) continue
    recoveredOutputNodes.set(node.id, node)
  }

  const recoveredAgentNodeIds = agentWorkflowNodeIds(recovered, recovered.generationJobs)

  const acceptedWorkflowNodeIds = new Set<string>()
  const nodes = current.nodes.map((node) => {
    const recoveredNode = recoveredOutputNodes.get(node.id)
    if (recoveredNode && node.type === 'result') {
      acceptedWorkflowNodeIds.add(node.id)
      return mergeRecoveredResultNode(node, recoveredNode)
    }
    if (!recoveredAgentNodeIds.has(node.id)) return node
    const workflowNode = recovered.nodes.find((candidate) => candidate.id === node.id)
    if (!workflowNode) return node
    acceptedWorkflowNodeIds.add(node.id)
    return {
      ...node,
      ...workflowNode,
      position: { ...node.position },
      selected: node.selected,
      data: { ...node.data, ...workflowNode.data },
    } as CanvasNode
  }) as CanvasNode[]
  const currentNodeIds = new Set(nodes.map((node) => node.id))
  for (const node of recovered.nodes) {
    if ((!recoveredOutputNodes.has(node.id) && !recoveredAgentNodeIds.has(node.id)) || currentNodeIds.has(node.id)) continue
    nodes.push({ ...node, selected: false } as CanvasNode)
    currentNodeIds.add(node.id)
    acceptedWorkflowNodeIds.add(node.id)
  }

  const edges = [...current.edges]
  const edgeIds = new Set(edges.map((edge) => edge.id))
  const edgeIdentities = new Set(edges.map(edgeIdentity))
  for (const edge of recovered.edges) {
    if (!acceptedWorkflowNodeIds.has(edge.source) && !acceptedWorkflowNodeIds.has(edge.target)) continue
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
