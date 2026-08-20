import type { BotanicAgentMessage, BotanicAgentSession } from './agent'

function isPendingLocalMessage(message: BotanicAgentMessage) {
  return message.deliveryStatus !== undefined && message.deliveryStatus !== 'synced'
}

function messageTime(message: BotanicAgentMessage) {
  return Number(message.updatedAt ?? message.createdAt ?? 0)
}

function isSettledMessageStatus(status: BotanicAgentMessage['status']) {
  return status === 'answered' || status === 'submitted'
}

/**
 * 确认卡/计划卡的 answered、submitted 是本机已发生的终态。
 * 远端实体刷新常仍带着创建时的 pending；若整卡覆盖，面板会收起后再弹开。
 */
function selectCollaborativeMessage(local: BotanicAgentMessage | undefined, remote: BotanicAgentMessage) {
  if (!local) return remote
  if (isSettledMessageStatus(local.status) && !isSettledMessageStatus(remote.status)) return local
  if (isSettledMessageStatus(remote.status) && !isSettledMessageStatus(local.status)) return remote
  return messageTime(local) > messageTime(remote) ? local : remote
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
      const localMessage = localMessages.get(message.id)
      const selected = selectCollaborativeMessage(localMessage, message)
      const deliveryStatus = localMessage?.deliveryStatus
      return deliveryStatus ? { ...selected, deliveryStatus } : selected
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
