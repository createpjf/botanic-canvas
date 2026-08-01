import type { CanvasDocument } from './canvas.ts'

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
