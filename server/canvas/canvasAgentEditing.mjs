// @ts-check

import { AgentToolRuntimeError } from '../agentToolRuntime.mjs'
import { catalogAspectRatiosForModel } from '../generation/generationOutputSize.mjs'
import {
  canvasProjectMutationId,
  commitCanvasProjectMutation,
  supportsDurableCanvasGraphMutation,
} from './canvasGraphCommitService.mjs'

/**
 * Agent 画布编辑的领域规则：提案-确认制的「改文字 / 调生成参数 / 删节点」。
 * 白名单之外一律拒绝——`jobId`、`agentRun` 血缘、`submissionKey`、配方快照、
 * 结果图片与系统连线永不可改；活跃任务绑定的节点不可动，任务恢复语义不受影响。
 * 历史 Artifact 不级联删除：Artifact Index 是血缘目录，删节点后结果仍可在面板找回。
 */

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
  return (document.generationJobs ?? []).some((job) => (
    ACTIVE_JOB_STATUSES.has(job.status)
    && (job.id === data.jobId
      || job.promptNodeId === node.id
      || job.generateNodeId === node.id
      || job.resultNodeId === node.id
      || job.parentNodeId === node.id)
  ))
}

function assertCompatibleGenerateSettings(merged, models) {
  const model = (models ?? []).find((item) => item.id === merged.model)
  if (!model) throw editError('CANVAS_MODEL_NOT_ALLOWED', '目标模型不在可用目录中。')
  const aspectRatios = model.aspectRatios ?? catalogAspectRatiosForModel(model)
  if (merged.aspectRatio && !aspectRatios.includes(merged.aspectRatio)) {
    throw editError('CANVAS_SETTINGS_NOT_ALLOWED', '该模型不支持这个画面比例。')
  }
  const resolutions = model.resolutions ?? ['1K', '2K']
  if (merged.resolution && !resolutions.includes(merged.resolution)) {
    throw editError('CANVAS_SETTINGS_NOT_ALLOWED', '该模型不支持这个清晰度。')
  }
}

function replacedNode(document, next, now) {
  return {
    ...document,
    nodes: document.nodes.map((node) => (node.id === next.id ? next : node)),
    updatedAt: now,
  }
}

function generationJobsAfterNodeDeletion(document, removedNodes, now) {
  return (document.generationJobs ?? []).map((job) => {
    const related = removedNodes.filter((node) => (
      node.data?.jobId === job.id
      || job.promptNodeId === node.id
      || job.generateNodeId === node.id
      || job.resultNodeId === node.id
    ))
    if (!related.length) return job
    const dismissedOutputIds = new Set(job.dismissedOutputIds ?? [])
    let projectionDismissedAt = Number(job.projectionDismissedAt) || undefined
    for (const node of related) {
      const candidateId = node.type === 'result'
        ? node.data?.candidateId ?? ((job.outputs ?? []).length === 1 ? job.outputs[0]?.id : undefined)
        : undefined
      if (candidateId) dismissedOutputIds.add(candidateId)
      else projectionDismissedAt = Math.max(projectionDismissedAt ?? 0, now)
    }
    const outputs = (job.outputs ?? []).filter((output) => !dismissedOutputIds.has(output.id))
    return {
      ...job,
      outputs,
      outputCount: outputs.length,
      dismissedOutputIds: dismissedOutputIds.size ? [...dismissedOutputIds] : undefined,
      projectionDismissedAt,
    }
  })
}

export function applyBotanicAgentCanvasTextUpdate(document, { nodeId, content, label }, now = Date.now()) {
  const node = findNode(document, nodeId)
  if (nodeIsBusy(document, node)) throw editError('CANVAS_NODE_BUSY', '该节点的任务正在进行，不能修改。', 409)
  if (content !== undefined && node.type !== 'text') {
    throw editError('CANVAS_EDIT_NOT_ALLOWED', '只有文字节点可以改写正文。')
  }
  if (label !== undefined && !LABELABLE_NODE_TYPES.has(node.type)) {
    throw editError('CANVAS_EDIT_NOT_ALLOWED', '该节点类型不支持重命名。')
  }
  const next = {
    ...node,
    data: {
      ...node.data,
      ...(content === undefined ? {} : { content }),
      ...(label === undefined ? {} : { label }),
    },
  }
  return { document: replacedNode(document, next, now), node: next }
}

export function applyBotanicAgentGenerateSettingsUpdate(document, { nodeId, settings, batchCount }, models, now = Date.now()) {
  const node = findNode(document, nodeId)
  if (node.type !== 'generate') throw editError('CANVAS_EDIT_NOT_ALLOWED', '只能调整生成节点的参数。')
  if (nodeIsBusy(document, node)) throw editError('CANVAS_NODE_BUSY', '该节点的任务正在进行，不能修改参数。', 409)
  const merged = { ...node.data?.settings, ...settings }
  if (settings && Object.keys(settings).length) assertCompatibleGenerateSettings(merged, models)
  const next = {
    ...node,
    data: {
      ...node.data,
      ...(batchCount === undefined ? {} : { batchCount }),
      ...(settings ? { settings: { ...node.data?.settings, ...settings } } : {}),
    },
  }
  return { document: replacedNode(document, next, now), node: next }
}

export function applyBotanicAgentCanvasNodeDeletion(document, { nodeIds }, now = Date.now()) {
  const ids = new Set(nodeIds)
  const removedNodes = []
  for (const nodeId of ids) {
    const node = findNode(document, nodeId)
    if (nodeIsBusy(document, node)) {
      throw editError('CANVAS_NODE_BUSY', `节点「${node.data?.label ?? node.id}」的任务正在进行，不能删除。`, 409)
    }
    removedNodes.push(node)
  }
  return {
    document: {
      ...document,
      nodes: document.nodes.filter((node) => !ids.has(node.id)),
      edges: (document.edges ?? []).filter((edge) => !ids.has(edge.source) && !ids.has(edge.target)),
      generationJobs: generationJobsAfterNodeDeletion(document, removedNodes, now),
      updatedAt: now,
    },
    removedNodeIds: [...ids],
  }
}

/**
 * 三个编辑动作的执行器：经 Store 原子文档更新落库并广播；
 * 旧 Store 无原子通道时回退单次 CAS 写（确认动作有幂等收据，失败可安全重试）。
 */
export function createCanvasAgentEditExecutors({ productStore, publishProjectUpdated, models, userId, projectId, mutationId }) {
  const editDocument = async (mutate) => {
    /** @type {any} */
    let edited
    const mutateDocument = (document) => {
      edited = mutate(document)
      return edited.document
    }
    let saved
    let graphCommit
    let baseRevision
    let revision
    let baseGraphRevision
    let graphRevision
    try {
      if (mutationId && supportsDurableCanvasGraphMutation(productStore)) {
        const committed = await commitCanvasProjectMutation({
          productStore,
          userId,
          projectId,
          mutationId: canvasProjectMutationId('agent-action', mutationId),
          mutate: mutateDocument,
        })
        saved = committed?.saved
        graphCommit = committed?.graphCommit
        baseRevision = committed?.baseRevision
        revision = committed?.revision
        baseGraphRevision = committed?.baseGraphRevision
        graphRevision = committed?.graphRevision
      } else if (typeof productStore.updateProjectDocument === 'function') {
        saved = await productStore.updateProjectDocument(userId, projectId, mutateDocument)
      } else {
        const project = await productStore.readProject(userId, projectId)
        if (!project) throw editError('PROJECT_NOT_FOUND', '未找到当前项目。', 404)
        baseRevision = project.revision
        baseGraphRevision = project.graphRevision
        saved = await productStore.writeProject(userId, mutateDocument(project.document), project.revision, project.graphRevision)
      }
    } catch (caught) {
      const failure = /** @type {any} */ (caught)
      if (failure?.code === 'PROJECT_CONFLICT' || failure?.code === 'CANVAS_GRAPH_CONFLICT') {
        throw editError('CANVAS_EDIT_CONFLICT', '画布刚被其他改动更新，请重试本次修改。', 409)
      }
      throw caught
    }
    if (!saved || !edited) throw editError('PROJECT_NOT_FOUND', '未找到当前项目。', 404)
    baseRevision ??= Math.max(1, Number(saved.revision) - 1)
    revision ??= saved.revision
    baseGraphRevision ??= Math.max(1, Number(saved.graphRevision) - 1)
    graphRevision ??= saved.graphRevision
    await publishProjectUpdated(saved, userId, graphCommit)
    return { saved, edited, baseRevision, revision, baseGraphRevision, graphRevision }
  }
  const nodePatch = (saved, node, baseRevision, revision, baseGraphRevision, graphRevision) => ({
    nodes: [node],
    edges: [],
    updatedAt: saved.document.updatedAt,
    baseRevision,
    revision,
    baseGraphRevision,
    graphRevision,
  })
  return {
    updateCanvasText: async ({ nodeId, content, label }) => {
      const { saved, edited, baseRevision, revision, baseGraphRevision, graphRevision } = await editDocument((document) => (
        applyBotanicAgentCanvasTextUpdate(document, { nodeId, content, label })
      ))
      return {
        message: `已更新节点「${edited.node.data?.label ?? nodeId}」。`,
        canvasNodeIds: [nodeId],
        canvasPatch: nodePatch(saved, edited.node, baseRevision, revision, baseGraphRevision, graphRevision),
      }
    },
    updateGenerateSettings: async ({ nodeId, settings, batchCount }) => {
      const { saved, edited, baseRevision, revision, baseGraphRevision, graphRevision } = await editDocument((document) => (
        applyBotanicAgentGenerateSettingsUpdate(document, { nodeId, settings, batchCount }, models)
      ))
      return {
        message: `已调整「${edited.node.data?.label ?? nodeId}」的生成参数。`,
        canvasNodeIds: [nodeId],
        canvasPatch: nodePatch(saved, edited.node, baseRevision, revision, baseGraphRevision, graphRevision),
      }
    },
    deleteCanvasNodes: async ({ nodeIds }) => {
      const { edited } = await editDocument((document) => (
        applyBotanicAgentCanvasNodeDeletion(document, { nodeIds })
      ))
      return {
        message: `已删除 ${edited.removedNodeIds.length} 个节点；历史结果仍保留在结果面板。`,
        canvasRemovedNodeIds: edited.removedNodeIds,
      }
    },
  }
}
