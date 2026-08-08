import Redis from 'ioredis'

const agentRunChannel = 'botanic-agent-runs'
const collaborationActivityChannel = 'botanic-collaboration-activities'

function validAgentRunEvent(event) {
  return Boolean(
    event
    && typeof event.projectId === 'string'
    && event.projectId.trim()
    && event.run
    && typeof event.run.id === 'string'
    && event.run.id.trim(),
  )
}

function validCollaborationActivityEvent(event) {
  return Boolean(
    event
    && typeof event.projectId === 'string'
    && event.projectId.trim()
    && event.activity
    && typeof event.activity.id === 'string'
    && event.activity.id.trim(),
  )
}

export function createAgentRunEventPublisher(redisUrl, { RedisClass = Redis } = {}) {
  if (!redisUrl) return {
    publish: async () => undefined,
    publishCollaborationActivity: async () => undefined,
    close: async () => undefined,
  }
  const redis = new RedisClass(redisUrl, { maxRetriesPerRequest: null })

  return {
    async publish(event) {
      if (!validAgentRunEvent(event)) return
      await redis.publish(agentRunChannel, JSON.stringify(event))
    },
    async publishCollaborationActivity(event) {
      if (!validCollaborationActivityEvent(event)) return
      await redis.publish(collaborationActivityChannel, JSON.stringify(event))
    },
    async close() {
      await redis.quit()
    },
  }
}

export async function createAgentRunEventSubscriber(redisUrl, onEvent, {
  RedisClass = Redis,
  onCollaborationActivity = () => {},
} = {}) {
  if (!redisUrl) return { close: async () => undefined }
  const redis = new RedisClass(redisUrl, { maxRetriesPerRequest: null })
  redis.on('message', (messageChannel, payload) => {
    try {
      const event = JSON.parse(payload)
      if (messageChannel === agentRunChannel && validAgentRunEvent(event)) onEvent(event)
      if (messageChannel === collaborationActivityChannel && validCollaborationActivityEvent(event)) onCollaborationActivity(event)
    } catch {
      // 单条损坏消息不能中断后续实时进度。
    }
  })
  await redis.subscribe(agentRunChannel, collaborationActivityChannel)

  return {
    async close() {
      await redis.quit()
    },
  }
}
