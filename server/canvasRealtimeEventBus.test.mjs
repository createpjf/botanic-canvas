import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createCanvasRealtimeEventPublisher,
  createCanvasRealtimeEventSubscriber,
} from './canvasRealtimeEventBus.mjs'

class FakeRedis {
  static subscribers = new Map()

  constructor() { this.handlers = new Map() }
  on(type, handler) { this.handlers.set(type, handler) }
  async subscribe(...channels) {
    for (const channel of channels) {
      const subscribers = FakeRedis.subscribers.get(channel) ?? new Set()
      subscribers.add(this)
      FakeRedis.subscribers.set(channel, subscribers)
    }
  }
  async publish(channel, payload) {
    for (const subscriber of FakeRedis.subscribers.get(channel) ?? []) {
      subscriber.handlers.get('message')?.(channel, payload)
    }
  }
  async quit() {
    for (const subscribers of FakeRedis.subscribers.values()) subscribers.delete(this)
  }
}

test.beforeEach(() => FakeRedis.subscribers.clear())

test('Redis 画布总线跨 API 实例转发 CRDT 增量与 Presence', async () => {
  const updates = []
  const presences = []
  const subscriber = await createCanvasRealtimeEventSubscriber('redis://test', {
    onCanvasUpdate: (event) => updates.push(event),
    onPresence: (event) => presences.push(event),
  }, { RedisClass: FakeRedis })
  const publisher = createCanvasRealtimeEventPublisher('redis://test', { RedisClass: FakeRedis })
  const update = {
    eventId: 'event-1', sourceInstanceId: 'api-a', projectId: 'project-1',
    update: 'AQ==', actorId: 'member-1', graphRevision: 2, updatedAt: 200,
  }
  const presence = {
    eventId: 'presence-1', sourceInstanceId: 'api-a', projectId: 'project-1',
    members: [{ userId: 'member-1', actorName: 'Mia', connectionCount: 1 }], sentAt: 200,
  }

  await publisher.publishCanvasUpdate(update)
  await publisher.publishPresence(presence)

  assert.deepEqual(updates, [update])
  assert.deepEqual(presences, [presence])
  await publisher.close()
  await subscriber.close()
})

test('Redis 画布总线忽略损坏、越权形状和媒体字节', async () => {
  const updates = []
  const presences = []
  const subscriber = await createCanvasRealtimeEventSubscriber('redis://test', {
    onCanvasUpdate: (event) => updates.push(event),
    onPresence: (event) => presences.push(event),
  }, { RedisClass: FakeRedis })
  const raw = new FakeRedis()

  await raw.publish('botanic-canvas-updates', 'bad-json')
  await raw.publish('botanic-canvas-updates', JSON.stringify({
    eventId: 'event-1', sourceInstanceId: 'api-a', projectId: 'project-1', update: 'not base64',
  }))
  await raw.publish('botanic-canvas-updates', JSON.stringify({
    eventId: 'event-2', sourceInstanceId: 'api-a', projectId: 'project-1', update: 'AQ==', image: 'secret-bytes',
  }))
  await raw.publish('botanic-canvas-presence', JSON.stringify({
    eventId: 'presence-1', sourceInstanceId: 'api-a', projectId: '', members: [], sentAt: 200,
  }))

  assert.deepEqual(updates, [])
  assert.deepEqual(presences, [])
  await subscriber.close()
})
