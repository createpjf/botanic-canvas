// @ts-check

import { AgentToolRuntimeError } from '../agent/tools/agentToolRuntime.mjs'
import { applyCanvasActionSet, normalizeCanvasActionSet } from './canvasAgentActionSet.mjs'
import { resolveCanvasAgentArtifacts } from './canvasAgentArtifactProjection.mjs'
import { AGENT_SEMANTIC_EVENT_NAMES, writeAgentSemanticEvent } from '../observability/agentSemanticEvent.mjs'
import {
  applyBotanicAgentCanvasNodeDeletion,
  applyBotanicAgentCanvasTextUpdate,
  applyBotanicAgentGenerateSettingsUpdate,
} from './canvasAgentEditRules.mjs'
import {
  canvasProjectMutationId,
  commitCanvasProjectMutation,
  supportsDurableCanvasGraphMutation,
} from './canvasGraphCommitService.mjs'

function editError(code, message, statusCode = 422) {
  return new AgentToolRuntimeError(code, message, statusCode)
}

export {
  applyBotanicAgentCanvasNodeDeletion,
  applyBotanicAgentCanvasTextUpdate,
  applyBotanicAgentGenerateSettingsUpdate,
  CANVAS_DELETE_BATCH_LIMIT,
  CANVAS_NODE_LABEL_LIMIT,
  CANVAS_TEXT_CONTENT_LIMIT,
} from './canvasAgentEditRules.mjs'


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
    executeCanvasActionSet: async (input) => {
      const startedAt = Date.now()
      const normalized = normalizeCanvasActionSet(input)
      const artifactIds = [...new Set(normalized.operations.filter((item) => item.kind === 'project_artifact').map((item) => item.artifactId))]
      try {
        const artifacts = artifactIds.length ? await resolveCanvasAgentArtifacts(productStore, userId, projectId, artifactIds) : new Map()
        const { saved, edited, baseRevision, revision, baseGraphRevision, graphRevision } = await editDocument((document) => (
          applyCanvasActionSet(document, normalized, models, Date.now(), artifacts)
        ))
        writeAgentSemanticEvent(AGENT_SEMANTIC_EVENT_NAMES.CANVAS_LIFECYCLE, {
          kind: 'execution', outcome: 'completed', durationMs: Date.now() - startedAt,
          operationCount: normalized.operations.length, artifactCount: artifactIds.length,
          changeCount: edited.createdNodeIds.length + edited.updatedNodeIds.length + edited.removedNodeIds.length + edited.createdEdgeIds.length,
        })
        return {
          message: `已原子执行 ${edited.actionSet.operations.length} 项画布操作。`,
          canvasNodeIds: [...edited.createdNodeIds, ...edited.updatedNodeIds],
          canvasRemovedNodeIds: edited.removedNodeIds,
          canvasPatch: {
            nodes: saved.document.nodes.filter((node) => [...edited.createdNodeIds, ...edited.updatedNodeIds].includes(node.id)),
            edges: saved.document.edges.filter((edge) => edited.createdEdgeIds.includes(edge.id)),
            positionNodeIds: edited.movedNodeIds,
            updatedAt: saved.document.updatedAt, baseRevision, revision, baseGraphRevision, graphRevision,
          },
        }
      } catch (caught) {
        const code = /** @type {any} */ (caught)?.code
        writeAgentSemanticEvent(AGENT_SEMANTIC_EVENT_NAMES.CANVAS_LIFECYCLE, {
          kind: 'execution', outcome: code === 'CANVAS_EDIT_CONFLICT' ? 'conflict' : 'failed',
          reason: code === 'CANVAS_EDIT_CONFLICT' ? 'CANVAS_EDIT_CONFLICT' : 'CANVAS_EXECUTION_FAILED',
          durationMs: Date.now() - startedAt, operationCount: normalized.operations.length, artifactCount: artifactIds.length,
        })
        throw caught
      }
    },
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
