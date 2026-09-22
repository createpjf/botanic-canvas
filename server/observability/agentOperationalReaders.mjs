// @ts-check
import { publicAgentRun } from '../agent/semantic/botanicAgentRun.mjs'
import { publicAgentReviewTask } from '../agent/review/agentReviewTask.mjs'
import { artifactIndexLimits } from '../agent/semantic/botanicArtifactIndex.mjs'
import { queryCanvasForAgent } from '../canvas/canvasAgentQuery.mjs'
import { assertCanvasQueryActive, queryCanvasWithSemanticSearch } from '../canvas/canvasAgentSemanticSearch.mjs'
import { normalizeCanvasActionSet, prepareCanvasActionSetProposal } from '../canvas/canvasAgentActionSet.mjs'
import { resolveCanvasAgentArtifacts } from '../canvas/canvasAgentArtifactProjection.mjs'
import { AGENT_SEMANTIC_EVENT_NAMES, writeAgentSemanticEvent } from './agentSemanticEvent.mjs'

/**
 * Agent 运维只读工具的单一数据源。API 首次执行与 Worker 恢复必须复用同一实现，
 * 否则断点恢复后可用工具会漂移；所有读取都重新校验项目归属且不返回受控媒体地址。
 */
export function createAgentOperationalReaders({ productStore, userId, projectId, document, models = [], semanticSearch }) {
  return {
    queryCanvas: async (query, context = {}) => {
      const startedAt = Date.now()
      try {
        assertCanvasQueryActive(context)
        const project = await productStore.readProject(userId, projectId)
        assertCanvasQueryActive(context)
        if (!project?.document) return undefined
        const result = await queryCanvasWithSemanticSearch(project.document, query, semanticSearch, globalThis.fetch, context)
        /** @type {any} */
        const page = result.page ?? {}
        writeAgentSemanticEvent(AGENT_SEMANTIC_EVENT_NAMES.CANVAS_LIFECYCLE, {
          kind: 'query', outcome: result.search?.degraded ? 'fallback' : 'completed', mode: query?.mode ?? 'nodes',
          completeness: page.hasMore || page.edgesTruncated || page.searchTruncated ? 'truncated' : 'complete',
          durationMs: Date.now() - startedAt, returnedCount: result.page?.returned ?? result.nodes?.length ?? 0,
        })
        return result
      } catch (caught) {
        writeAgentSemanticEvent(AGENT_SEMANTIC_EVENT_NAMES.CANVAS_LIFECYCLE, {
          kind: 'query', outcome: 'failed', mode: query?.mode ?? 'nodes', reason: 'CANVAS_QUERY_FAILED', durationMs: Date.now() - startedAt,
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
    /** @param {{ query?: string, kind?: string, limit?: number, before?: { createdAt: number, id: string } }} input */
    searchArtifacts: async ({ query, kind, limit = 20, before }) => {
      const needle = String(query ?? '').trim().toLocaleLowerCase('zh-CN')
      const maximum = Math.max(1, Math.min(Math.floor(Number(limit) || 20), 50))
      const artifacts = []
      let cursor = before, scannedCount = 0, hasMore = true
      const seenIds = new Set(before ? [before.id] : [])
      // ponytail: 每次最多扫描 1000 条，超限返回游标续查；规模需要时再下推数据库过滤。
      scan: while (hasMore && scannedCount < 1000) {
        const rows = await productStore.listAgentArtifacts(userId, projectId, { limit: artifactIndexLimits.page, before: cursor })
        if (!Array.isArray(rows)) throw Object.assign(new Error('历史结果当前不可读取。'), { code: 'ARTIFACT_SEARCH_UNAVAILABLE' })
        hasMore = rows.length === artifactIndexLimits.page
        for (const [index, artifact] of rows.entries()) {
          const next = { createdAt: artifact.createdAt, id: artifact.id }
          if (!Number.isFinite(next.createdAt) || next.createdAt < 0 || next.createdAt > 8.64e15 || typeof next.id !== 'string'
            || !next.id || seenIds.has(next.id) || (cursor && next.createdAt > cursor.createdAt)) {
            throw Object.assign(new Error('历史结果分页游标无效或未前进。'), { code: 'ARTIFACT_SEARCH_CURSOR_INVALID' })
          }
          // 同时间戳的 ID 排序由 Adapter 拥有，不用 JS localeCompare 重解释数据库排序。
          seenIds.add(next.id)
          cursor = next
          scannedCount += 1
          if ((!kind || artifact.kind === kind)
            && (!needle || `${artifact.label ?? ''} ${artifact.id}`.toLocaleLowerCase('zh-CN').includes(needle))) artifacts.push(artifact)
          if (artifacts.length >= maximum) {
            hasMore = hasMore || index < rows.length - 1
            break scan
          }
        }
      }
      return { artifacts, page: { hasMore, searchTruncated: hasMore, scannedCount, ...(hasMore ? { before: cursor } : {}) } }
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
