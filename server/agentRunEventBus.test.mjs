import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentRunEventPublisher, createAgentRunEventSubscriber } from './agentRunEventBus.mjs'

class FakeRedis {
  static subscribers = new Map()
  constructor() { this.handlers = new Map() }
  on(type, handler) { this.handlers.set(type, handler) }
  async subscribe(channel) { FakeRedis.subscribers.set(channel, this) }
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
