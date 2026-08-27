// @ts-check

function text(value, maximum) {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : ''
}

/**
 * Agent 消息分页参数。游标为 `(updatedAt, messageId)`，只返回该点**之前**的更旧消息。
 */
export function agentMessageListOptions(input = {}) {
  const raw = input ?? {}
  const limit = Math.max(1, Math.min(Number(raw.limit) || 50, 200))
  const updatedAt = Number(raw.before?.updatedAt)
  const id = text(raw.before?.id, 200)
  return {
    limit,
    ...(Number.isFinite(updatedAt) && updatedAt >= 0 && id ? { before: { updatedAt, id } } : {}),
  }
}

export function encodeAgentMessageCursor(message) {
  const updatedAt = Number(message?.updatedAt ?? message?.createdAt)
  const id = text(message?.id, 200)
  if (!Number.isFinite(updatedAt) || updatedAt < 0 || !id) return undefined
  return Buffer.from(JSON.stringify([updatedAt, id]), 'utf8').toString('base64url')
}

export function decodeAgentMessageCursor(value) {
  if (value === undefined || value === null || value === '') return undefined
  try {
    const [updatedAt, id] = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'))
    if (Number.isFinite(Number(updatedAt)) && Number(updatedAt) >= 0 && typeof id === 'string' && id) {
      return { updatedAt: Number(updatedAt), id: id.slice(0, 200) }
    }
  } catch {}
  throw new TypeError('Agent 消息分页游标无效。')
}

export function normalizeAgentSessionListLimit(limit) {
  return Math.max(1, Math.min(Number(limit) || 80, 80))
}
