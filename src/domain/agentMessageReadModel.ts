import type { BotanicAgentMessage } from './agent.ts'

/** API 独立实体与 Canvas 兼容视图按 Message 自身版本合并。 */
export function mergeAgentMessages(
  apiMessages: BotanicAgentMessage[],
  storeMessages: BotanicAgentMessage[],
) {
  const byId = new Map(apiMessages.map((message) => [message.id, message]))
  for (const message of storeMessages) {
    const existing = byId.get(message.id)
    const messageTime = Number(message.updatedAt ?? message.createdAt ?? 0)
    const existingTime = Number(existing?.updatedAt ?? existing?.createdAt ?? 0)
    if (!existing || messageTime >= existingTime) byId.set(message.id, message)
  }
  return [...byId.values()].sort(
    (left, right) => Number(left.createdAt ?? 0) - Number(right.createdAt ?? 0)
      || left.id.localeCompare(right.id),
  )
}
