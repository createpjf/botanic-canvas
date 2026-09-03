// @ts-check
import { publicAgentRun } from '../agent/semantic/botanicAgentRun.mjs'
import { publicAgentReviewTask } from '../agent/review/agentReviewTask.mjs'
import { queryCanvasForAgent } from '../canvas/canvasAgentQuery.mjs'
import { normalizeCanvasActionSet, prepareCanvasActionSetProposal } from '../canvas/canvasAgentActionSet.mjs'
import { resolveCanvasAgentArtifacts } from '../canvas/canvasAgentArtifactProjection.mjs'
import { AGENT_SEMANTIC_EVENT_NAMES, writeAgentSemanticEvent } from './agentSemanticEvent.mjs'

/**
 * Agent 运维只读工具的单一数据源。API 首次执行与 Worker 恢复必须复用同一实现，
 * 否则断点恢复后可用工具会漂移；所有读取都重新校验项目归属且不返回受控媒体地址。
 */
export function createAgentOperationalReaders({ productStore, userId, projectId, document, models = [] }) {
  return {
    queryCanvas: async (query) => {
      const startedAt = Date.now()
      try {
        const project = await productStore.readProject(userId, projectId)
        if (!project?.document) return undefined
        const result = queryCanvasForAgent(project.document, query)
        writeAgentSemanticEvent(AGENT_SEMANTIC_EVENT_NAMES.CANVAS_LIFECYCLE, {
          kind: 'query', outcome: 'completed', mode: 'nodes',
          completeness: result.page?.hasMore || result.page?.edgesTruncated ? 'truncated' : 'complete',
          durationMs: Date.now() - startedAt, returnedCount: result.page?.returned ?? result.nodes?.length ?? 0,
        })
        return result
      } catch (caught) {
        writeAgentSemanticEvent(AGENT_SEMANTIC_EVENT_NAMES.CANVAS_LIFECYCLE, {
          kind: 'query', outcome: 'failed', mode: 'nodes', reason: 'CANVAS_QUERY_FAILED', durationMs: Date.now() - startedAt,
        })
        throw caught
      }
    },
    prepareCanvasActionSet: async (actionId, input) => {
      const startedAt = Date.now()
      let operationCount = 0
      let artifactCount = 0
      try {
        const normalized = normalizeCanvasActionSet({ ...input, actionId })
        operationCount = normalized.operations.length
        const artifactIds = [...new Set(normalized.operations.filter((item) => item.kind === 'project_artifact').map((item) => item.artifactId))]
        artifactCount = artifactIds.length
        const [project, artifacts] = await Promise.all([
          productStore.readProject(userId, projectId),
          artifactIds.length ? resolveCanvasAgentArtifacts(productStore, userId, projectId, artifactIds) : new Map(),
        ])
        if (!project?.document) return undefined
        const proposal = prepareCanvasActionSetProposal(project.document, normalized, models, actionId, artifacts)
        const summary = proposal.preview?.summary ?? {}
        writeAgentSemanticEvent(AGENT_SEMANTIC_EVENT_NAMES.CANVAS_LIFECYCLE, {
          kind: 'proposal', outcome: 'completed', durationMs: Date.now() - startedAt,
          operationCount, artifactCount,
          changeCount: Number(summary.created ?? 0) + Number(summary.updated ?? 0) + Number(summary.removed ?? 0) + Number(summary.connected ?? 0),
        })
        return proposal
      } catch (caught) {
        writeAgentSemanticEvent(AGENT_SEMANTIC_EVENT_NAMES.CANVAS_LIFECYCLE, {
          kind: 'proposal', outcome: 'failed', reason: 'CANVAS_PROPOSAL_FAILED', durationMs: Date.now() - startedAt,
          operationCount, artifactCount,
        })
        throw caught
      }
    },
    readRun: async (runId) => {
      const run = await productStore.readAgentRun(userId, runId)
      return run && run.projectId === projectId ? publicAgentRun(run) : undefined
    },
    readJob: async (jobId) => {
      const job = await productStore.readGenerationJob(userId, jobId)
      return job && job.projectId === projectId ? job : undefined
    },
    searchArtifacts: async ({ query, kind, limit }) => {
      const artifacts = await productStore.listAgentArtifacts(userId, projectId, {
        limit: Math.min(limit * 4, 200),
      }) ?? []
      const needle = String(query ?? '').trim().toLocaleLowerCase('zh-CN')
      return artifacts
        .filter((artifact) => (!kind || artifact.kind === kind)
          && (!needle || `${artifact.label ?? ''} ${artifact.id ?? ''}`.toLocaleLowerCase('zh-CN').includes(needle)))
        .slice(0, limit)
    },
    readReviews: async (runId) => {
      const run = await productStore.readAgentRun(userId, runId)
      if (!run || run.projectId !== projectId) return []
      return ((await productStore.listAgentReviewTasksForRun(userId, projectId, runId)) ?? [])
        .map(publicAgentReviewTask)
    },
    readWorkflowRun: async (runId) => (document?.productionWorkflowRuns ?? []).find((entry) => entry?.id === runId),
    readDeliveries: async () => document?.deliveries ?? [],
  }
}
