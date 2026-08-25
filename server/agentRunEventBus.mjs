import Redis from 'ioredis'

const agentRunChannel = 'botanic-agent-runs'
const collaborationActivityChannel = 'botanic-collaboration-activities'
const projectUpdateChannel = 'botanic-project-updates'
const cancelChannel = 'botanic-agent-cancels'

/**
 * 取消信号必须跨实例：多实例部署下取消请求可能落在非执行实例，而仅靠进程内的
 * AbortController 表只能中断本实例 —— 其余实例会一路跑到结束才发现已取消，
 * 那是事后丢弃而不是中止（ADR 0004）。
 *
 * 只传标识，不传业务内容：接收方按标识去权威存储读状态，避免把过期快照当事实。
 */
const cancelScopes = new Set(['turn', 'run', 'job'])

function validCancelEvent(event) {
  return Boolean(
    event
    && cancelScopes.has(event.scope)
    && typeof event.id === 'string'
    && event.id.trim()
    && typeof event.projectId === 'string'
    && event.projectId.trim(),
  )
}

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
    && typeof event.actorId === 'string'
    && event.actorId.trim()
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
    publishCancel: async () => undefined,
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
    async publishCancel(event) {
      if (!validCancelEvent(event)) return
      await redis.publish(cancelChannel, JSON.stringify(event))
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
  onCancel = () => {},
} = {}) {
  if (!redisUrl) return { close: async () => undefined }
  const redis = new RedisClass(redisUrl, { maxRetriesPerRequest: null })
  redis.on('message', (messageChannel, payload) => {
    try {
      const event = JSON.parse(payload)
      if (messageChannel === agentRunChannel && validAgentRunEvent(event)) onEvent(event)
      if (messageChannel === collaborationActivityChannel && validCollaborationActivityEvent(event)) onCollaborationActivity(event)
      if (messageChannel === projectUpdateChannel && validProjectUpdateEvent(event)) onProjectUpdated(event)
      if (messageChannel === cancelChannel && validCancelEvent(event)) onCancel(event)
    } catch {
      // 单条损坏消息不能中断后续实时进度。
    }
  })
  await redis.subscribe(agentRunChannel, collaborationActivityChannel, projectUpdateChannel, cancelChannel)

  return {
    async close() {
      await redis.quit()
    },
  }
}
