import { reconcileAgentSessionsAfterDocumentSync } from './agentCollaboration.ts'
import type { CanvasDocument } from './canvas.ts'

export type RemoteDocumentConflict = {
  status?: number
  code?: string
}

/**
 * 画布写入可能经过旧版 API（412）或当前 API（409），并且项目版本与
 * graph 版本会分别报告不同 code。所有入口必须使用同一判定，避免某条
 * 同步路径把冲突当成普通错误而继续重试，形成请求风暴。
 */
export function isRemoteDocumentConflict(error: unknown): error is RemoteDocumentConflict {
  if (!error || typeof error !== 'object') return false
  const candidate = error as RemoteDocumentConflict
  if (candidate.code === 'CANVAS_SYNC_EPOCH_STALE') return false
  return candidate.status === 409
    || candidate.status === 412
    || candidate.code === 'PROJECT_CONFLICT'
    || candidate.code === 'CANVAS_GRAPH_CONFLICT'
}

export function pendingCanvasSyncOutcome(
  result: { pending: number; conflictIds: readonly string[] },
  projectId: string,
): 'conflict' | 'synced' | 'pending' {
  if (result.conflictIds.includes(projectId)) return 'conflict'
  return result.pending === 0 ? 'synced' : 'pending'
}

export type RemoteCanvasRefreshInput = {
  current: CanvasDocument
  remote: CanvasDocument
  baselineUpdatedAt: number
  hasPendingDraft: boolean
  /** 本次读到的服务端 revision；与 appliedRevision 成对提供时按单调版本判新旧。 */
  remoteRevision?: number
  /** 本地画布已完整反映的服务端 revision。 */
  appliedRevision?: number
}

/**
 * 服务器文档是权威来源，但绝不能覆盖请求发出后产生的本地编辑。
 * pending draft 由持久化层确认；updatedAt baseline 用来拦截请求飞行期间的编辑。
 * 新旧判断优先用服务端 revision：本地写会用本机挂钟推高 `updatedAt`，
 * 挂钟比较会把确实更新的服务端文档（如 Agent 生成中的状态回写）当旧版拒收。
 */
export function resolveRemoteCanvasRefresh({
  current,
  remote,
  baselineUpdatedAt,
  hasPendingDraft,
  remoteRevision,
  appliedRevision,
}: RemoteCanvasRefreshInput): { document: CanvasDocument; applied: boolean } {
  // appliedRevision 只活在内存，刷新页面即丢。此时若继续比挂钟，本机写过的
  // updatedAt（挂钟领先）会永久拒收更新的服务端文档——事件也永远走不出这个死锁。
  // 服务端 revision 已知而本地基线未知时，以服务端为权威；本地未同步编辑仍由
  // hasPendingDraft 与 baselineUpdatedAt 两道防线保护。
  const remoteIsNewer = typeof remoteRevision === 'number'
    ? typeof appliedRevision === 'number' ? remoteRevision > appliedRevision : true
    : remote.updatedAt > current.updatedAt
  if (hasPendingDraft
    || current.id !== remote.id
    || current.updatedAt !== baselineUpdatedAt
    || !remoteIsNewer) {
    return { document: current, applied: false }
  }
  return {
    document: {
      ...remote,
      agentSessions: reconcileAgentSessionsAfterDocumentSync(current.agentSessions, remote.agentSessions),
    },
    applied: true,
  }
}
