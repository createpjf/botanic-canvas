import Redis from 'ioredis'
import { createHmac, timingSafeEqual } from 'node:crypto'

const canvasUpdateChannel = 'botanic-canvas-updates'
const canvasPresenceChannel = 'botanic-canvas-presence'
const maximumUpdateLength = 700_000

function nonEmptyText(value) {
  return typeof value === 'string' && Boolean(value.trim())
}

function exactKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key))
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
  return value
}

function eventSignature(event, secret) {
  return createHmac('sha256', secret).update(JSON.stringify(canonicalize({ ...event, signature: undefined }))).digest('base64url')
}

function signedEvent(event, secret) {
  return secret ? { ...event, signature: eventSignature(event, secret) } : event
}

function hasValidSignature(event, secret) {
  if (!secret || typeof event?.signature !== 'string') return false
  const expected = eventSignature(event, secret)
  return event.signature.length === expected.length
    && timingSafeEqual(Buffer.from(event.signature), Buffer.from(expected))
}

function validCanvasUpdateEvent(event) {
  return Boolean(
    event
    && exactKeys(event, new Set([
      'eventId', 'sourceInstanceId', 'projectId', 'update', 'actorId', 'actorName',
      'mutationId', 'graphRevision', 'updatedAt', 'activity', 'duplicate', 'signature',
    ]))
    && nonEmptyText(event.eventId)
    && nonEmptyText(event.sourceInstanceId)
    && nonEmptyText(event.projectId)
    && nonEmptyText(event.update)
    && event.update.length <= maximumUpdateLength
    && /^[A-Za-z0-9+/]*={0,2}$/.test(event.update)
    && (event.mutationId === undefined || (nonEmptyText(event.mutationId) && /^[A-Za-z0-9._:-]{1,200}$/.test(event.mutationId)))
    && nonEmptyText(event.actorId)
    && (!event.actorName || nonEmptyText(event.actorName))
    && (!event.activity || nonEmptyText(event.activity.id))
    && (event.duplicate === undefined || typeof event.duplicate === 'boolean')
  )
}

function validPresenceMember(member) {
  return Boolean(
    member
    && exactKeys(member, new Set(['userId', 'actorName', 'connectionCount']))
    && nonEmptyText(member.userId)
    && (!member.actorName || nonEmptyText(member.actorName))
    && Number.isInteger(member.connectionCount)
    && member.connectionCount > 0
    && member.connectionCount <= 100,
  )
}

function validPresenceEvent(event) {
  return Boolean(
    event
    && exactKeys(event, new Set(['eventId', 'sourceInstanceId', 'projectId', 'members', 'sentAt', 'signature']))
    && nonEmptyText(event.eventId)
    && nonEmptyText(event.sourceInstanceId)
    && nonEmptyText(event.projectId)
    && Array.isArray(event.members)
    && event.members.length <= 1_000
    && event.members.every(validPresenceMember)
    && Number.isFinite(event.sentAt),
  )
}

export function createCanvasRealtimeEventPublisher(redisUrl, { RedisClass = Redis, eventSecret } = {}) {
  if (!redisUrl) return {
    publishCanvasUpdate: async () => undefined,
    publishPresence: async () => undefined,
    close: async () => undefined,
  }
  const redis = new RedisClass(redisUrl, { maxRetriesPerRequest: null })
  return {
    async publishCanvasUpdate(event) {
      const payload = signedEvent(event, eventSecret)
      if (validCanvasUpdateEvent(payload) && (!eventSecret || hasValidSignature(payload, eventSecret))) await redis.publish(canvasUpdateChannel, JSON.stringify(payload))
    },
    async publishPresence(event) {
      const payload = signedEvent(event, eventSecret)
      if (validPresenceEvent(payload) && (!eventSecret || hasValidSignature(payload, eventSecret))) await redis.publish(canvasPresenceChannel, JSON.stringify(payload))
    },
    async close() { await redis.quit() },
  }
}

export async function createCanvasRealtimeEventSubscriber(redisUrl, handlers = {}, { RedisClass = Redis, eventSecret } = {}) {
  if (!redisUrl) return { close: async () => undefined }
  const redis = new RedisClass(redisUrl, { maxRetriesPerRequest: null })
  redis.on('message', (channel, payload) => {
    try {
      const event = JSON.parse(payload)
      if (channel === canvasUpdateChannel && validCanvasUpdateEvent(event) && (!eventSecret || hasValidSignature(event, eventSecret))) {
        Promise.resolve(handlers.onCanvasUpdate?.(event)).catch(() => undefined)
      }
      if (channel === canvasPresenceChannel && validPresenceEvent(event) && (!eventSecret || hasValidSignature(event, eventSecret))) {
        Promise.resolve(handlers.onPresence?.(event)).catch(() => undefined)
      }
    } catch {
      // 单条损坏消息不能中断后续画布协作。
    }
  })
  await redis.subscribe(canvasUpdateChannel, canvasPresenceChannel)
  return { async close() { await redis.quit() } }
}
