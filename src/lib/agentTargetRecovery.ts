import { canvasDb, enqueuePersistence } from './canvasDb'
import { lastKnownCanvasGraphRevision, lastKnownCanvasSyncProtocolEpoch, lastKnownRemoteRevision, previewRemoteCanvasDocument } from './db'
import { previewAgentTargetDocument } from './remoteDocumentRefresh'

/** 只读恢复用的快照；既不接受待提交的本地删除，也不使用落后于 ACK 的服务器版本。 */
export async function readAgentTargetDocument(projectId: string, signal?: AbortSignal) {
  const hasPending = () => enqueuePersistence(async () => Boolean(await canvasDb.pendingSync.get(projectId))
    || await canvasDb.canvasGraphOutbox.where('projectId').equals(projectId).count() > 0)
  // ponytail: 沿用现有只读 GET 和超时；取消丢弃迟到快照，不启动后续 Agent 请求。
  const remote = await previewAgentTargetDocument(() => previewRemoteCanvasDocument(projectId), hasPending, (snapshot) => {
    const { remoteRevision, remoteGraphRevision } = snapshot.conflictRevision
    return snapshot.document.id === projectId && remoteRevision >= (lastKnownRemoteRevision(projectId) ?? 0)
      && ((lastKnownCanvasSyncProtocolEpoch(projectId) ?? 1) < 2
        || remoteGraphRevision !== undefined && remoteGraphRevision >= (lastKnownCanvasGraphRevision(projectId) ?? 0))
  }, signal)
  return remote?.document
}
