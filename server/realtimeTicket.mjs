import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

function signature(payload, secret) {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

export function issueRealtimeTicket({ userId, projectId, secret, now = Date.now(), lifetimeMs = 30_000 }) {
  if (!userId || !projectId || !secret) throw new TypeError('实时票据参数不完整。')
  const payload = Buffer.from(JSON.stringify({
    userId,
    projectId,
    expiresAt: now + lifetimeMs,
    nonce: randomUUID(),
  })).toString('base64url')
  return `${payload}.${signature(payload, secret)}`
}

export function verifyRealtimeTicket(ticket, { projectId, secret, now = Date.now() }) {
  try {
    if (!ticket || !projectId || !secret) return undefined
    const [payload, suppliedSignature, extra] = ticket.split('.')
    if (!payload || !suppliedSignature || extra) return undefined
    const expectedSignature = signature(payload, secret)
    const supplied = Buffer.from(suppliedSignature)
    const expected = Buffer.from(expectedSignature)
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return undefined
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (typeof parsed?.userId !== 'string'
      || parsed.projectId !== projectId
      || typeof parsed.expiresAt !== 'number'
      || parsed.expiresAt < now) return undefined
    return { userId: parsed.userId, projectId: parsed.projectId }
  } catch {
    return undefined
  }
}
