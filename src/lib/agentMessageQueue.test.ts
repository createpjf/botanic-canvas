import assert from 'node:assert/strict'
import test from 'node:test'
import type { BotanicAgentMessage, BotanicAgentSession } from '../domain/agent.ts'
import {
  createAgentMessageQueue,
  type AgentMessageQueueStorage,
} from './agentMessageQueue.ts'

function createMemoryStorage(seed = '[]'): AgentMessageQueueStorage & { value: string } {
  return {
    value: seed,
    read() { return this.value },
    write(value) { this.value = value },
  }
}

function fixture(messageId: string, createdAt: number) {
  const session: BotanicAgentSession = {
    id: 'session-a', title: '新建对话', executionMode: 'manual', contextNodeIds: [], messages: [], createdAt: 1, updatedAt: createdAt,
  }
  const message: BotanicAgentMessage = {
    id: messageId, role: 'user', kind: 'text', content: `message ${messageId}`, createdAt,
  }
  return {
    projectId: 'project-a', session, message,
    idempotencyKey: `agent-message-${messageId}`,
  }
}

test('断网消息持久化后，新队列实例可恢复同一条待发消息', () => {
  const storage = createMemoryStorage()
  const first = createAgentMessageQueue({ storage, deliver: async () => undefined })
  first.enqueue(fixture('m-1', 10))

  const restored = createAgentMessageQueue({ storage, deliver: async () => undefined })
  assert.deepEqual(restored.list().map((item) => ({ messageId: item.message.id, status: item.status })), [
    { messageId: 'm-1', status: 'queued' },
  ])
})

test('按创建时间顺序重放，成功后从本地队列移除', async () => {
  const delivered: string[] = []
  let queuedAt = 100
  const queue = createAgentMessageQueue({
    storage: createMemoryStorage(),
    now: () => queuedAt++,
    deliver: async (item) => { delivered.push(item.message.id) },
  })
  queue.enqueue(fixture('m-2', 20))
  queue.enqueue(fixture('m-1', 10))

  const result = await queue.flush()

  assert.deepEqual(delivered, ['m-1', 'm-2'])
  assert.deepEqual(result, { delivered: ['m-1', 'm-2'], failed: [], pending: [] })
  assert.deepEqual(queue.list(), [])
})

test('同一项目、会话和消息不会重复入队或重复提交', async () => {
  const delivered: string[] = []
  const queue = createAgentMessageQueue({
    storage: createMemoryStorage(),
    deliver: async (item) => { delivered.push(item.idempotencyKey) },
  })
  const item = fixture('m-1', 10)
  queue.enqueue(item)
  queue.enqueue(item)

  await Promise.all([queue.flush(), queue.flush()])

  assert.deepEqual(delivered, ['agent-message-m-1'])
})

test('网络错误保留队首并停止本轮重放，online 后可继续', async () => {
  let online = false
  const delivered: string[] = []
  const queue = createAgentMessageQueue({
    storage: createMemoryStorage(),
    deliver: async (item) => {
      if (!online) throw Object.assign(new Error('offline'), { status: 0 })
      delivered.push(item.message.id)
    },
  })
  queue.enqueue(fixture('m-1', 10))
  queue.enqueue(fixture('m-2', 20))

  assert.deepEqual(await queue.flush(), { delivered: [], failed: [], pending: ['m-1', 'm-2'] })
  assert.equal(queue.list()[0]?.attempts, 1)
  online = true
  await queue.flush()

  assert.deepEqual(delivered, ['m-1', 'm-2'])
  assert.deepEqual(queue.list(), [])
})

test('明确业务错误标记失败且不再自动重放，不阻塞后续消息', async () => {
  const delivered: string[] = []
  const queue = createAgentMessageQueue({
    storage: createMemoryStorage(),
    deliver: async (item) => {
      if (item.message.id === 'm-1') throw Object.assign(new Error('无权限'), { status: 403, code: 'PROJECT_WRITE_FORBIDDEN' })
      delivered.push(item.message.id)
    },
  })
  queue.enqueue(fixture('m-1', 10))
  queue.enqueue(fixture('m-2', 20))

  const first = await queue.flush()
  const second = await queue.flush()

  assert.deepEqual(first, { delivered: ['m-2'], failed: ['m-1'], pending: [] })
  assert.deepEqual(second, { delivered: [], failed: ['m-1'], pending: [] })
  assert.deepEqual(delivered, ['m-2'])
  assert.equal(queue.list()[0]?.status, 'failed')
  assert.equal(queue.list()[0]?.attempts, 1)
})
