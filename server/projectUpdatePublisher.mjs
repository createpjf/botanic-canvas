import { captureException } from './sentry.mjs'

/**
 * 项目文档已经持久化成功后，实时广播只是一条可恢复的旁路。
 * 广播失败必须记录但不能改变 HTTP 保存成功的事实。
 */
const expectedRealtimeConflictCodes = new Set(['CANVAS_GRAPH_CONFLICT', 'CANVAS_MUTATION_CONFLICT', 'CANVAS_SYNC_EPOCH_STALE', 'PROJECT_CONFLICT'])

function logRealtimeFailure(logger, prefix, caught, { projectId, mutationId }) {
  const code = typeof caught?.code === 'string' ? caught.code : undefined
  const expectedConflict = expectedRealtimeConflictCodes.has(code)
  if (!expectedConflict) {
    captureException(caught, {
      level: 'warning',
      tags: { component: 'realtime', error_code: code ?? 'UNSPECIFIED_ERROR' },
    })
  }
  const message = `${prefix}: ${caught instanceof Error ? caught.message : String(caught)}${code ? ` [${code}]` : ''} projectId=${projectId}${mutationId ? ` mutationId=${mutationId}` : ''}`
  const log = logger?.[expectedConflict ? 'warn' : 'error'] ?? logger?.error
  log?.(message)
}

export async function publishProjectUpdatedSafely(realtimeHub, saved, actorId, logger = console, graphCommit) {
  let published = true
  if (graphCommit?.changed && graphCommit.update) {
    try {
      await realtimeHub?.publishCanvasGraphCommitted({
        projectId: saved.document.id,
        update: graphCommit.update,
        mutationId: graphCommit.mutationId,
        actorId,
        graphRevision: graphCommit.graphRevision,
        updatedAt: graphCommit.updatedAt,
        ...(graphCommit.duplicate ? { duplicate: true } : {}),
      })
    } catch (caught) {
      published = false
      logRealtimeFailure(logger, '[realtime] canvas publish deferred', caught, { projectId: saved.document.id, mutationId: graphCommit.mutationId })
    }
  }
  try {
    await realtimeHub?.publishProjectUpdated({
      projectId: saved.document.id,
      revision: saved.revision,
      graphRevision: saved.graphRevision,
      updatedAt: saved.document.updatedAt,
      ...(!graphCommit && (saved.syncProtocolEpoch ?? 1) < 2
        ? { graph: { nodes: saved.document.nodes ?? [], edges: saved.document.edges ?? [] } }
        : {}),
      actorId,
    })
    return published
  } catch (caught) {
    logRealtimeFailure(logger, '[realtime] publish deferred', caught, { projectId: saved.document.id, mutationId: graphCommit?.mutationId })
    return false
  }
}
