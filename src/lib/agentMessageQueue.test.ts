import assert from 'node:assert/strict'
import test from 'node:test'
import type { BotanicAgentMessage, BotanicAgentSession } from '../domain/agent.ts'
import {
  assertAgentMessageQueueItemDelivered,
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

test('同一消息再次入队时用最新内容覆盖尚未发送的快照', async () => {
  const delivered: Array<{ id: string; status?: string }> = []
  const queue = createAgentMessageQueue({
    storage: createMemoryStorage(),
    deliver: async (item) => { delivered.push({ id: item.message.id, status: item.message.status }) },
  })
  queue.enqueue(fixture('m-1', 10))
  const updated = fixture('m-1', 10)
  updated.message = { ...updated.message, role: 'assistant', kind: 'question', status: 'answered', updatedAt: 40, content: '确认创作设置' }
  queue.enqueue(updated)

  await queue.flush()

  assert.deepEqual(delivered, [{ id: 'm-1', status: 'answered' }])
  assert.deepEqual(queue.list(), [])
})

test('行动 Message 发送中收到新状态时保留新版，刷新恢复并继续提交终态', async () => {
  const storage = createMemoryStorage()
  let releaseFirstDelivery: (() => void) | undefined
  const firstDelivery = new Promise<void>((resolve) => { releaseFirstDelivery = resolve })
  const deliveredStatuses: string[] = []
  const queue = createAgentMessageQueue({
    storage,
    deliver: async (item) => {
      deliveredStatuses.push(item.message.plan?.actions?.[0].status ?? '')
      if (deliveredStatuses.length === 1) await firstDelivery
    },
  })
  const running = fixture('m-action', 10)
  running.message = {
    ...running.message,
    role: 'assistant',
    kind: 'plan',
    updatedAt: 20,
    plan: {
      intent: 'continue_generation',
      instruction: '发布内容',
      summary: '确认后发布。',
      references: [],
      constraints: [],
      prompt: '发布内容',
      settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
      output: { mode: 'single', count: 1, candidatesPerItem: 1 },
      actions: [{
        id: 'call-mcp-1', kind: 'mcp', toolName: 'mcp_call', label: '发布', summary: '发布内容',
        risk: 'external', arguments: {}, status: 'running',
      }],
    },
  }
  const uncertain = structuredClone(running)
  uncertain.message.updatedAt = 21
  uncertain.message.plan!.actions![0] = {
    ...uncertain.message.plan!.actions![0],
    status: 'uncertain',
    error: '行动结果未知，请人工核对。',
  }

  queue.enqueue(running)
  const flushing = queue.flush()
  queue.enqueue(uncertain)

  const restored = createAgentMessageQueue({ storage, deliver: async () => undefined })
  assert.equal(restored.list()[0]?.message.plan?.actions?.[0].status, 'uncertain')
  releaseFirstDelivery?.()
  const result = await flushing

  assert.deepEqual(deliveredStatuses, ['running', 'uncertain'])
  assert.deepEqual(result, { delivered: ['m-action'], failed: [], pending: [] })
  assert.deepEqual(queue.list(), [])
})

test('初始 Message 发送中收到 accepted 时保留 turnId 并补交链接快照', async () => {
  const storage = createMemoryStorage()
  let releaseFirstDelivery: (() => void) | undefined
  const firstDelivery = new Promise<void>((resolve) => { releaseFirstDelivery = resolve })
  const deliveredTurnIds: Array<string | undefined> = []
  const queue = createAgentMessageQueue({
    storage,
    deliver: async (item) => {
      deliveredTurnIds.push(item.message.turnId)
      if (deliveredTurnIds.length === 1) await firstDelivery
    },
  })
  const initial = fixture('m-turn', 10)
  const linked = structuredClone(initial)
  linked.message = { ...linked.message, turnId: 'turn-durable', updatedAt: 20 }

  queue.enqueue(initial)
  const flushing = queue.flush()
  queue.enqueue(linked)

  const restored = createAgentMessageQueue({ storage, deliver: async () => undefined })
  assert.equal(restored.list()[0]?.message.turnId, 'turn-durable')
  releaseFirstDelivery?.()
  await flushing

  assert.deepEqual(deliveredTurnIds, [undefined, 'turn-durable'])
  assert.deepEqual(queue.list(), [])
})

test('auto plan 的 pending PUT 发送中收到 submitted/runId 时补交最终状态', async () => {
  const storage = createMemoryStorage()
  let releasePendingDelivery: (() => void) | undefined
  const pendingDelivery = new Promise<void>((resolve) => { releasePendingDelivery = resolve })
  const delivered: Array<{ status?: string; runId?: string; turnId?: string }> = []
  const queue = createAgentMessageQueue({
    storage,
    deliver: async (item) => {
      delivered.push({
        status: item.message.status,
        runId: item.message.runId,
        turnId: item.message.turnId,
      })
      if (delivered.length === 1) await pendingDelivery
    },
  })
  const pending = fixture('agent-turn-result-turn-auto', 10)
  pending.message = {
    ...pending.message,
    role: 'assistant',
    kind: 'plan',
    status: 'pending',
    turnId: 'turn-auto',
    updatedAt: 20,
    plan: {
      turnId: 'turn-auto',
      intent: 'continue_generation',
      instruction: '生成海报',
      summary: '生成一张海报。',
      references: [], constraints: [], prompt: '海报',
      settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '1K' },
      output: { mode: 'single', count: 1, candidatesPerItem: 1 },
    },
  }
  const submitted = structuredClone(pending)
  submitted.message = {
    ...submitted.message,
    status: 'submitted',
    runId: 'run-auto',
    updatedAt: 21,
  }

  queue.enqueue(pending)
  const flushing = queue.flush()
  queue.enqueue(submitted)

  const restored = createAgentMessageQueue({ storage, deliver: async () => undefined })
  assert.deepEqual({
    status: restored.list()[0]?.message.status,
    runId: restored.list()[0]?.message.runId,
    turnId: restored.list()[0]?.message.turnId,
  }, { status: 'submitted', runId: 'run-auto', turnId: 'turn-auto' })

  releasePendingDelivery?.()
  await flushing
  assert.deepEqual(delivered, [
    { status: 'pending', runId: undefined, turnId: 'turn-auto' },
    { status: 'submitted', runId: 'run-auto', turnId: 'turn-auto' },
  ])
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

test('snapshot PUT 未 durable 时 Turn POST 为 0，重连 PUT 成功后同 key 只 POST 一次', async () => {
  let online = false
  let putCount = 0
  let postCount = 0
  const queue = createAgentMessageQueue({
    storage: createMemoryStorage(),
    deliver: async () => {
      putCount += 1
      if (!online) throw Object.assign(new Error('offline'), { status: 0, code: 'NETWORK_OFFLINE' })
    },
  })
  const pending = fixture('m-turn-snapshot', 10)
  pending.message = {
    ...pending.message,
    status: 'pending',
    turnRequestSnapshot: {
      locale: 'zh-CN', contextNodeIds: ['result-b'], hasTarget: true,
      selectedResultNodeId: 'result-b', executionMode: 'manual',
    },
  }
  queue.enqueue(pending)
  const submit = async () => {
    await queue.flush()
    assertAgentMessageQueueItemDelivered(queue, pending.message.id)
    postCount += 1
  }

  await assert.rejects(submit(), (error: unknown) => (
    (error as { status?: number }).status === 0
      && (error as { code?: string }).code === 'AGENT_MESSAGE_NOT_DURABLE'
  ))
  assert.equal(postCount, 0)
  online = true
  await submit()
  assert.equal(putCount, 2)
  assert.equal(postCount, 1)
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

test('失败消息可由用户手动重新排队，并沿用原幂等键只提交一次', async () => {
  let allowed = false
  const delivered: string[] = []
  const queue = createAgentMessageQueue({
    storage: createMemoryStorage(),
    deliver: async (item) => {
      if (!allowed) throw Object.assign(new Error('无权限'), { status: 403, code: 'PROJECT_WRITE_FORBIDDEN' })
      delivered.push(item.idempotencyKey)
    },
  })
  queue.enqueue(fixture('m-retry', 10))

  assert.deepEqual(await queue.flush(), { delivered: [], failed: ['m-retry'], pending: [] })
  allowed = true
  assert.equal(queue.retry('m-retry')?.status, 'queued')
  assert.equal(queue.retry('m-retry')?.status, 'queued')
  assert.deepEqual(await queue.flush(), { delivered: ['m-retry'], failed: [], pending: [] })
  assert.deepEqual(delivered, ['agent-message-m-retry'])
  assert.deepEqual(queue.list(), [])
})
