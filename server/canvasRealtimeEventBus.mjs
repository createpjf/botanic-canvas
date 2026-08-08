import Redis from 'ioredis'

const canvasUpdateChannel = 'botanic-canvas-updates'
const canvasPresenceChannel = 'botanic-canvas-presence'
const maximumUpdateLength = 700_000

function nonEmptyText(value) {
  return typeof value === 'string' && Boolean(value.trim())
}

function exactKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key))
}

function validCanvasUpdateEvent(event) {
  return Boolean(
    event
    && exactKeys(event, new Set([
      'eventId', 'sourceInstanceId', 'projectId', 'update', 'actorId', 'actorName',
      'graphRevision', 'updatedAt', 'activity',
    ]))
    && nonEmptyText(event.eventId)
    && nonEmptyText(event.sourceInstanceId)
    && nonEmptyText(event.projectId)
    && nonEmptyText(event.update)
    && event.update.length <= maximumUpdateLength
    && /^[A-Za-z0-9+/]*={0,2}$/.test(event.update)
    && nonEmptyText(event.actorId)
    && (!event.actorName || nonEmptyText(event.actorName))
    && (!event.activity || nonEmptyText(event.activity.id))
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
    && exactKeys(event, new Set(['eventId', 'sourceInstanceId', 'projectId', 'members', 'sentAt']))
    && nonEmptyText(event.eventId)
    && nonEmptyText(event.sourceInstanceId)
    && nonEmptyText(event.projectId)
    && Array.isArray(event.members)
    && event.members.length <= 1_000
    && event.members.every(validPresenceMember)
    && Number.isFinite(event.sentAt),
  )
}

export function createCanvasRealtimeEventPublisher(redisUrl, { RedisClass = Redis } = {}) {
  if (!redisUrl) return {
    publishCanvasUpdate: async () => undefined,
    publishPresence: async () => undefined,
    close: async () => undefined,
  }
  const redis = new RedisClass(redisUrl, { maxRetriesPerRequest: null })
  return {
    async publishCanvasUpdate(event) {
      if (validCanvasUpdateEvent(event)) await redis.publish(canvasUpdateChannel, JSON.stringify(event))
    },
    async publishPresence(event) {
      if (validPresenceEvent(event)) await redis.publish(canvasPresenceChannel, JSON.stringify(event))
    },
    async close() { await redis.quit() },
  }
}

export async function createCanvasRealtimeEventSubscriber(redisUrl, handlers = {}, { RedisClass = Redis } = {}) {
  if (!redisUrl) return { close: async () => undefined }
  const redis = new RedisClass(redisUrl, { maxRetriesPerRequest: null })
  redis.on('message', (channel, payload) => {
    try {
      const event = JSON.parse(payload)
      if (channel === canvasUpdateChannel && validCanvasUpdateEvent(event)) handlers.onCanvasUpdate?.(event)
      if (channel === canvasPresenceChannel && validPresenceEvent(event)) handlers.onPresence?.(event)
    } catch {
      // 单条损坏消息不能中断后续画布协作。
    }
  })
  await redis.subscribe(canvasUpdateChannel, canvasPresenceChannel)
  return { async close() { await redis.quit() } }
}
