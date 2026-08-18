import Redis from 'ioredis'

const agentRunChannel = 'botanic-agent-runs'
const collaborationActivityChannel = 'botanic-collaboration-activities'
const projectUpdateChannel = 'botanic-project-updates'

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

function validProjectUpdateEvent(event) {
  return Boolean(
    event
    && typeof event.projectId === 'string'
    && event.projectId.trim()
    && Number.isFinite(Number(event.revision))
    && Number.isFinite(Number(event.graphRevision))
    && Number.isFinite(Number(event.updatedAt))
    && event.graph
    && Array.isArray(event.graph.nodes)
    && Array.isArray(event.graph.edges),
  )
}

export function createAgentRunEventPublisher(redisUrl, { RedisClass = Redis } = {}) {
  if (!redisUrl) return {
    publish: async () => undefined,
    publishCollaborationActivity: async () => undefined,
    publishProjectUpdated: async () => undefined,
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
    async publishProjectUpdated(event) {
      if (!validProjectUpdateEvent(event)) return
      await redis.publish(projectUpdateChannel, JSON.stringify(event))
    },
    async close() {
      await redis.quit()
    },
  }
}

export async function createAgentRunEventSubscriber(redisUrl, onEvent, {
  RedisClass = Redis,
  onCollaborationActivity = () => {},
  onProjectUpdated = () => {},
} = {}) {
  if (!redisUrl) return { close: async () => undefined }
  const redis = new RedisClass(redisUrl, { maxRetriesPerRequest: null })
  redis.on('message', (messageChannel, payload) => {
    try {
      const event = JSON.parse(payload)
      if (messageChannel === agentRunChannel && validAgentRunEvent(event)) onEvent(event)
      if (messageChannel === collaborationActivityChannel && validCollaborationActivityEvent(event)) onCollaborationActivity(event)
      if (messageChannel === projectUpdateChannel && validProjectUpdateEvent(event)) onProjectUpdated(event)
    } catch {
      // 单条损坏消息不能中断后续实时进度。
    }
  })
  await redis.subscribe(agentRunChannel, collaborationActivityChannel, projectUpdateChannel)

  return {
    async close() {
      await redis.quit()
    },
  }
}
