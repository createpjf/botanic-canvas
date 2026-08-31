/**
 * 项目文档已经持久化成功后，实时广播只是一条可恢复的旁路。
 * 广播失败必须记录但不能改变 HTTP 保存成功的事实。
 */
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
      logger.error(`[realtime] canvas publish deferred: ${caught instanceof Error ? caught.message : String(caught)}`)
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
    logger.error(`[realtime] publish deferred: ${caught instanceof Error ? caught.message : String(caught)}`)
    return false
  }
}
