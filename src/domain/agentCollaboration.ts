import type { BotanicAgentMessage, BotanicAgentSession } from './agent'

function isPendingLocalMessage(message: BotanicAgentMessage) {
  return message.deliveryStatus !== undefined && message.deliveryStatus !== 'synced'
}

/**
 * 远端 Session 是共享内容权威；本机投递状态与尚未送达的消息仍须保留，
 * 避免协作者更新或同账号另一设备更新时吞掉离线草稿。
 */
export function mergeCollaborativeAgentSessions(
  localSessions: BotanicAgentSession[],
  remoteSessions: BotanicAgentSession[],
) {
  const localById = new Map(localSessions.map((session) => [session.id, session]))
  const merged = remoteSessions.map((remote) => {
    const local = localById.get(remote.id)
    if (!local) return remote
    const localMessages = new Map(local.messages.map((message) => [message.id, message]))
    const remoteIds = new Set(remote.messages.map((message) => message.id))
    const messages = remote.messages.map((message) => {
      const deliveryStatus = localMessages.get(message.id)?.deliveryStatus
      return deliveryStatus ? { ...message, deliveryStatus } : message
    })
    for (const message of local.messages) {
      if (!remoteIds.has(message.id) && isPendingLocalMessage(message)) messages.push(message)
    }
    messages.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    return { ...remote, messages }
  })
  const remoteIds = new Set(remoteSessions.map((session) => session.id))
  for (const session of localSessions) {
    if (!remoteIds.has(session.id) && session.messages.some(isPendingLocalMessage)) merged.push(session)
  }
  return merged.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
}
