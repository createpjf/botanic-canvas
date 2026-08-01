/**
 * 项目文档已经持久化成功后，实时广播只是一条可恢复的旁路。
 * 广播失败必须记录但不能改变 HTTP 保存成功的事实。
 */
export async function publishProjectUpdatedSafely(realtimeHub, saved, actorId, logger = console) {
  try {
    await realtimeHub?.publishProjectUpdated({
      projectId: saved.document.id,
      revision: saved.revision,
      graphRevision: saved.graphRevision,
      updatedAt: saved.document.updatedAt,
      graph: { nodes: saved.document.nodes ?? [], edges: saved.document.edges ?? [] },
      actorId,
    })
    return true
  } catch (caught) {
    logger.error(`[realtime] publish deferred: ${caught instanceof Error ? caught.message : String(caught)}`)
    return false
  }
}
