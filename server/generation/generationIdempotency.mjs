import { createHash } from 'node:crypto'

const keyPattern = /^[A-Za-z0-9_-]{16,128}$/

export function generationIdempotencyKey(value) {
  if (Array.isArray(value)) value = value[0]
  if (typeof value !== 'string' || !keyPattern.test(value)) return undefined
  return value
}

export function generationJobIdForIdempotency(ownerId, idempotencyKey) {
  const digest = createHash('sha256').update(`${ownerId}:${idempotencyKey}`).digest('base64url')
  return `job_${digest}`
}
