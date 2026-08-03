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
  return candidate.status === 409
    || candidate.status === 412
    || candidate.code === 'PROJECT_CONFLICT'
    || candidate.code === 'CANVAS_GRAPH_CONFLICT'
}

export type RemoteCanvasRefreshInput = {
  current: CanvasDocument
  remote: CanvasDocument
  baselineUpdatedAt: number
  hasPendingDraft: boolean
}

/**
 * 服务器文档是权威来源，但绝不能覆盖请求发出后产生的本地编辑。
 * pending draft 由持久化层确认；updatedAt baseline 用来拦截请求飞行期间的编辑。
 */
export function resolveRemoteCanvasRefresh({
  current,
  remote,
  baselineUpdatedAt,
  hasPendingDraft,
}: RemoteCanvasRefreshInput): { document: CanvasDocument; applied: boolean } {
  if (hasPendingDraft
    || current.id !== remote.id
    || current.updatedAt !== baselineUpdatedAt
    || remote.updatedAt <= current.updatedAt) {
    return { document: current, applied: false }
  }
  return { document: remote, applied: true }
}
