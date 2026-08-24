import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentRunEventPublisher, createAgentRunEventSubscriber } from './agentRunEventBus.mjs'

class FakeRedis {
  static subscribers = new Map()
  constructor() { this.handlers = new Map() }
  on(type, handler) { this.handlers.set(type, handler) }
  async subscribe(...channels) { channels.forEach((channel) => FakeRedis.subscribers.set(channel, this)) }
  async publish(channel, payload) {
    const subscriber = FakeRedis.subscribers.get(channel)
    subscriber?.handlers.get('message')?.(channel, payload)
  }
  async quit() {}
}

test('Redis 事件总线把 Worker 的 Agent Run 进度交给 API', async () => {
  const events = []
  const subscriber = await createAgentRunEventSubscriber('redis://test', (event) => events.push(event), { RedisClass: FakeRedis })
  const publisher = createAgentRunEventPublisher('redis://test', { RedisClass: FakeRedis })
  await publisher.publish({ projectId: 'project-1', run: { id: 'run-1', status: 'running' } })

  assert.deepEqual(events, [{ projectId: 'project-1', run: { id: 'run-1', status: 'running' } }])
  await publisher.close()
  await subscriber.close()
})

test('Redis 事件总线忽略损坏或越权形状的消息', async () => {
  const events = []
  const subscriber = await createAgentRunEventSubscriber('redis://test', (event) => events.push(event), { RedisClass: FakeRedis })
  const raw = new FakeRedis()
  await raw.publish('botanic-agent-runs', JSON.stringify({ projectId: '', run: { id: 'run-1' } }))
  await raw.publish('botanic-agent-runs', 'bad-json')
  assert.deepEqual(events, [])
  await subscriber.close()
})

test('Redis 事件总线跨 API 实例转发协作动态', async () => {
  const activities = []
  const subscriber = await createAgentRunEventSubscriber('redis://test', () => {}, {
    RedisClass: FakeRedis,
    onCollaborationActivity: (event) => activities.push(event),
  })
  const publisher = createAgentRunEventPublisher('redis://test', { RedisClass: FakeRedis })
  const event = { projectId: 'project-1', activity: { id: 'activity-1', kind: 'conversation' } }
  await publisher.publishCollaborationActivity(event)

  assert.deepEqual(activities, [event])
  await publisher.close()
  await subscriber.close()
})

test('Redis 事件总线把 Worker 的画布投影更新交给 API 广播', async () => {
  const updates = []
  const subscriber = await createAgentRunEventSubscriber('redis://test', () => {}, {
    RedisClass: FakeRedis,
    onProjectUpdated: (event) => updates.push(event),
  })
  const publisher = createAgentRunEventPublisher('redis://test', { RedisClass: FakeRedis })
  const event = {
    projectId: 'project-1', actorId: 'user-1', revision: 4, graphRevision: 7, updatedAt: 200,
    graph: { nodes: [], edges: [] },
  }
  await publisher.publishProjectUpdated(event)

  assert.deepEqual(updates, [event])
  await publisher.close()
  await subscriber.close()
})

test('Redis 事件总线丢弃缺少画布操作人的项目更新', async () => {
  const updates = []
  const subscriber = await createAgentRunEventSubscriber('redis://test', () => {}, {
    RedisClass: FakeRedis,
    onProjectUpdated: (event) => updates.push(event),
  })
  const publisher = createAgentRunEventPublisher('redis://test', { RedisClass: FakeRedis })
  await publisher.publishProjectUpdated({
    projectId: 'project-1', revision: 4, graphRevision: 7, updatedAt: 200,
    graph: { nodes: [], edges: [] },
  })

  assert.deepEqual(updates, [])
  await publisher.close()
  await subscriber.close()
})

test('取消信号跨实例投递，只携带标识不携带业务内容', async () => {
  const cancels = []
  const subscriber = await createAgentRunEventSubscriber('redis://test', () => {}, {
    RedisClass: FakeRedis, onCancel: (event) => cancels.push(event),
  })
  const publisher = createAgentRunEventPublisher('redis://test', { RedisClass: FakeRedis })

  await publisher.publishCancel({ scope: 'turn', id: 'turn-1', projectId: 'project-1', cancelVersion: 2 })
  await publisher.publishCancel({ scope: 'run', id: 'run-1', projectId: 'project-1' })

  assert.deepEqual(cancels, [
    { scope: 'turn', id: 'turn-1', projectId: 'project-1', cancelVersion: 2 },
    { scope: 'run', id: 'run-1', projectId: 'project-1' },
  ])
  await publisher.close()
  await subscriber.close()
})

test('取消信号拒绝无效范围与缺失标识，不误触发中止', async () => {
  const cancels = []
  const subscriber = await createAgentRunEventSubscriber('redis://test', () => {}, {
    RedisClass: FakeRedis, onCancel: (event) => cancels.push(event),
  })
  const publisher = createAgentRunEventPublisher('redis://test', { RedisClass: FakeRedis })

  for (const invalid of [
    { scope: 'job', id: 'x', projectId: 'p' },
    { scope: 'turn', id: '', projectId: 'p' },
    { scope: 'turn', id: 'x', projectId: '' },
    { scope: 'turn', id: 'x' },
    {},
    undefined,
  ]) {
    await publisher.publishCancel(invalid)
  }
  // 一条误触发的中止会打断正在正常执行的回合，因此校验必须比其他频道更严。
  assert.deepEqual(cancels, [])

  const raw = new FakeRedis()
  await raw.publish('botanic-agent-cancels', '{损坏')
  assert.deepEqual(cancels, [])
  await publisher.close()
  await subscriber.close()
})

test('未配置 Redis 时取消发布是安全空操作', async () => {
  const publisher = createAgentRunEventPublisher(undefined)
  assert.equal(await publisher.publishCancel({ scope: 'turn', id: 'turn-1', projectId: 'project-1' }), undefined)
  await publisher.close()
})
