// @ts-check

import { AgentToolRuntimeError } from '../agent/tools/agentToolRuntime.mjs'
import { catalogAspectRatiosForModel } from '../generation/generationOutputSize.mjs'

export const CANVAS_TEXT_CONTENT_LIMIT = 4_000
export const CANVAS_NODE_LABEL_LIMIT = 60
export const CANVAS_DELETE_BATCH_LIMIT = 12

const LABELABLE_NODE_TYPES = new Set(['text', 'generate', 'result'])
const ACTIVE_NODE_STATUSES = new Set(['generating', 'queued', 'uploading'])
const ACTIVE_TASK_STATUSES = new Set(['queued', 'running', 'submission_unknown'])
const ACTIVE_JOB_STATUSES = new Set(['queued', 'running'])

function editError(code, message, statusCode = 422) {
  return new AgentToolRuntimeError(code, message, statusCode)
}
function findNode(document, nodeId) {
  const node = (document.nodes ?? []).find((item) => item.id === nodeId)
  if (!node) throw editError('CANVAS_NODE_NOT_FOUND', `未找到画布节点：${nodeId}。`, 404)
  return node
}
function nodeIsBusy(document, node) {
  const data = node.data ?? {}
  if (ACTIVE_NODE_STATUSES.has(data.status) || ACTIVE_TASK_STATUSES.has(data.taskStatus)) return true
  return (document.generationJobs ?? []).some((job) => ACTIVE_JOB_STATUSES.has(job.status)
    && (job.id === data.jobId || job.promptNodeId === node.id || job.generateNodeId === node.id
      || job.resultNodeId === node.id || job.parentNodeId === node.id))
}
function assertCompatibleGenerateSettings(merged, models) {
  const model = (models ?? []).find((item) => item.id === merged.model)
  if (!model) throw editError('CANVAS_MODEL_NOT_ALLOWED', '目标模型不在可用目录中。')
  const aspectRatios = model.aspectRatios ?? catalogAspectRatiosForModel(model)
  if (merged.aspectRatio && !aspectRatios.includes(merged.aspectRatio)) throw editError('CANVAS_SETTINGS_NOT_ALLOWED', '该模型不支持这个画面比例。')
  const resolutions = model.resolutions ?? ['1K', '2K']
  if (merged.resolution && !resolutions.includes(merged.resolution)) throw editError('CANVAS_SETTINGS_NOT_ALLOWED', '该模型不支持这个清晰度。')
}
function replacedNode(document, next, now) {
  return { ...document, nodes: document.nodes.map((node) => (node.id === next.id ? next : node)), updatedAt: now }
}
function generationJobsAfterNodeDeletion(document, removedNodes, now) {
  return (document.generationJobs ?? []).map((job) => {
    const related = removedNodes.filter((node) => node.data?.jobId === job.id || job.promptNodeId === node.id
      || job.generateNodeId === node.id || job.resultNodeId === node.id)
    if (!related.length) return job
    const dismissedOutputIds = new Set(job.dismissedOutputIds ?? [])
    let projectionDismissedAt = Number(job.projectionDismissedAt) || undefined
    for (const node of related) {
      const candidateId = node.type === 'result'
        ? node.data?.candidateId ?? ((job.outputs ?? []).length === 1 ? job.outputs[0]?.id : undefined) : undefined
      if (candidateId) dismissedOutputIds.add(candidateId)
      else projectionDismissedAt = Math.max(projectionDismissedAt ?? 0, now)
    }
    const outputs = (job.outputs ?? []).filter((output) => !dismissedOutputIds.has(output.id))
    return { ...job, outputs, outputCount: outputs.length,
      dismissedOutputIds: dismissedOutputIds.size ? [...dismissedOutputIds] : undefined, projectionDismissedAt }
  })
}

export function applyBotanicAgentCanvasTextUpdate(document, { nodeId, content, label }, now = Date.now()) {
  const node = findNode(document, nodeId)
  if (nodeIsBusy(document, node)) throw editError('CANVAS_NODE_BUSY', '该节点的任务正在进行，不能修改。', 409)
  if (content !== undefined && node.type !== 'text') throw editError('CANVAS_EDIT_NOT_ALLOWED', '只有文字节点可以改写正文。')
  if (label !== undefined && !LABELABLE_NODE_TYPES.has(node.type)) throw editError('CANVAS_EDIT_NOT_ALLOWED', '该节点类型不支持重命名。')
  const next = { ...node, data: { ...node.data, ...(content === undefined ? {} : { content }), ...(label === undefined ? {} : { label }) } }
  return { document: replacedNode(document, next, now), node: next }
}

export function applyBotanicAgentGenerateSettingsUpdate(document, { nodeId, settings, batchCount }, models, now = Date.now()) {
  const node = findNode(document, nodeId)
  if (node.type !== 'generate') throw editError('CANVAS_EDIT_NOT_ALLOWED', '只能调整生成节点的参数。')
  if (nodeIsBusy(document, node)) throw editError('CANVAS_NODE_BUSY', '该节点的任务正在进行，不能修改参数。', 409)
  const merged = { ...node.data?.settings, ...settings }
  if (settings && Object.keys(settings).length) assertCompatibleGenerateSettings(merged, models)
  const next = { ...node, data: { ...node.data, ...(batchCount === undefined ? {} : { batchCount }),
    ...(settings ? { settings: { ...node.data?.settings, ...settings } } : {}) } }
  return { document: replacedNode(document, next, now), node: next }
}

export function applyBotanicAgentCanvasOrganization(document, { placements }, now = Date.now()) {
  const byId = new Map()
  for (const placement of placements) {
    const current = findNode(document, placement.nodeId)
    if (placement.label !== undefined && !LABELABLE_NODE_TYPES.has(current.type)) throw editError('CANVAS_EDIT_NOT_ALLOWED', '该节点类型不支持重命名。')
    if (placement.label !== undefined && nodeIsBusy(document, current)) throw editError('CANVAS_NODE_BUSY', '任务进行中的节点不能重命名。', 409)
    byId.set(current.id, { ...current, position: placement.position, data: { ...current.data, ...(placement.label === undefined ? {} : { label: placement.label }) } })
  }
  return { document: { ...document, nodes: document.nodes.map((node) => byId.get(node.id) ?? node), updatedAt: now }, updatedNodeIds: [...byId.keys()] }
}

export function applyBotanicAgentCanvasNodeDeletion(document, { nodeIds }, now = Date.now()) {
  const ids = new Set(nodeIds)
  const removedNodes = []
  for (const nodeId of ids) {
    const node = findNode(document, nodeId)
    if (nodeIsBusy(document, node)) throw editError('CANVAS_NODE_BUSY', `节点「${node.data?.label ?? node.id}」的任务正在进行，不能删除。`, 409)
    removedNodes.push(node)
  }
  const ungroupedNodeIds = document.nodes.filter((node) => !ids.has(node.id) && ids.has(node.data?.frameId)).map((node) => node.id)
  return {
    document: { ...document, nodes: document.nodes.filter((node) => !ids.has(node.id)).map((node) => {
        if (!ids.has(node.data?.frameId)) return node
        const data = { ...node.data }; delete data.frameId
        return { ...node, data }
      }),
      edges: (document.edges ?? []).filter((edge) => !ids.has(edge.source) && !ids.has(edge.target)),
      generationJobs: generationJobsAfterNodeDeletion(document, removedNodes, now), updatedAt: now },
    removedNodeIds: [...ids],
    updatedNodeIds: ungroupedNodeIds,
  }
}
