import Redis from 'ioredis'

const channel = 'botanic-agent-runs'

function validEvent(event) {
  return Boolean(
    event
    && typeof event.projectId === 'string'
    && event.projectId.trim()
    && event.run
    && typeof event.run.id === 'string'
    && event.run.id.trim(),
  )
}

export function createAgentRunEventPublisher(redisUrl, { RedisClass = Redis } = {}) {
  if (!redisUrl) return { publish: async () => undefined, close: async () => undefined }
  const redis = new RedisClass(redisUrl, { maxRetriesPerRequest: null })

  return {
    async publish(event) {
      if (!validEvent(event)) return
      await redis.publish(channel, JSON.stringify(event))
    },
    async close() {
      await redis.quit()
    },
  }
}

export async function createAgentRunEventSubscriber(redisUrl, onEvent, { RedisClass = Redis } = {}) {
  if (!redisUrl) return { close: async () => undefined }
  const redis = new RedisClass(redisUrl, { maxRetriesPerRequest: null })
  redis.on('message', (messageChannel, payload) => {
    if (messageChannel !== channel) return
    try {
      const event = JSON.parse(payload)
      if (validEvent(event)) onEvent(event)
    } catch {
      // 单条损坏消息不能中断后续实时进度。
    }
  })
  await redis.subscribe(channel)

  return {
    async close() {
      await redis.quit()
    },
  }
}
