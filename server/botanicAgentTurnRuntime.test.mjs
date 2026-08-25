import test from 'node:test'
import assert from 'node:assert/strict'
import { agentTurnIdForIdempotency, createBotanicAgentTurnRuntime } from './botanicAgentTurnRuntime.mjs'

function fakeStore() {
  const turns = new Map()
  const events = new Map()
  return {
    turns,
    events,
    async putAgentTurn(_userId, turn) { turns.set(turn.id, structuredClone(turn)); return structuredClone(turn) },
    async readAgentTurn(_userId, id) { return turns.has(id) ? structuredClone(turns.get(id)) : undefined },
    async appendAgentTurnEvent(_userId, _projectId, event) {
      const list = events.get(event.turnId) ?? []
      if (!list.some((item) => item.sequence === event.sequence)) list.push(structuredClone(event))
      events.set(event.turnId, list)
      return structuredClone(event)
    },
    async listAgentTurnEvents(_userId, _projectId, id) { return (events.get(id) ?? []).map((item) => structuredClone(item)).sort((a, b) => a.sequence - b.sequence) },
  }
}

test('Turn Runtime 为同一幂等键复用结果，并且不持久化 reasoning', async () => {
  const store = fakeStore()
  const runtime = createBotanicAgentTurnRuntime({ productStore: store, now: (() => { let value = 100; return () => ++value })() })
  const id = agentTurnIdForIdempotency('user-1', 'project-1', 'key-1')
  const events = []
  let toolEventWasPersistedBeforeDelivery = false
  const input = {
    userId: 'user-1', projectId: 'project-1', id, idempotencyKey: 'key-1',
    resolve: async ({ onEvent }) => {
      onEvent({ type: 'reasoning', step: 0, delta: 'secret chain' })
      onEvent({ type: 'tool', step: 0, toolCall: { id: 'tool-1', name: 'project_read', status: 'succeeded' } })
      return { kind: 'chat', answer: '完成', reasoning: [{ source: 'raw', text: 'secret chain' }] }
    },
    onEvent: (event) => {
      events.push(event)
      if (event.type === 'tool') toolEventWasPersistedBeforeDelivery = store.events.get(id)?.some((item) => item.type === 'turn.tool') === true
    },
  }
  const first = await runtime.execute(input)
  const second = await runtime.execute(input)
  assert.equal(first.turn.status, 'completed')
  assert.equal(second.turn.status, 'completed')
  assert.deepEqual(second.result, undefined)
  assert.equal(store.turns.get(id).result.reasoning, undefined)
  assert.equal(store.events.get(id).some((event) => event.type === 'turn.tool'), true)
  assert.equal(store.events.get(id).some((event) => JSON.stringify(event).includes('secret chain')), false)
  assert.equal(toolEventWasPersistedBeforeDelivery, true)
  assert.equal(events[0].type, 'reasoning')
})

test('Turn Runtime 为多个工具事件保留各自的持久化顺序', async () => {
  const store = fakeStore()
  const runtime = createBotanicAgentTurnRuntime({ productStore: store })
  const id = 'turn-sequence'
  await runtime.execute({
    userId: 'u', projectId: 'p', id, idempotencyKey: 'sequence',
    resolve: async ({ onEvent }) => {
      onEvent({ type: 'tool', step: 0, toolCall: { id: 'tool-1', name: 'project_read', status: 'succeeded' } })
      onEvent({ type: 'tool', step: 1, toolCall: { id: 'tool-2', name: 'project_memory_search', status: 'succeeded' } })
      return { kind: 'chat', answer: '完成' }
    },
  })
  assert.deepEqual(
    store.events.get(id).filter((event) => event.type === 'turn.tool').map((event) => [event.sequence, event.payload.toolCallId]),
    [[2, 'tool-1'], [3, 'tool-2']],
  )
})

test('Turn Runtime 把取消/失败收口到可恢复终态', async () => {
  const store = fakeStore()
  const runtime = createBotanicAgentTurnRuntime({ productStore: store })
  const id = 'turn-cancel'
  const result = await runtime.execute({
    userId: 'u', projectId: 'p', id, idempotencyKey: 'k',
    resolve: async () => { throw Object.assign(new Error('请求已取消'), { code: 'REQUEST_CANCELLED', statusCode: 499 }) },
  }).catch((error) => error)
  assert.equal(result.turn.status, 'cancelled')
  assert.equal(store.turns.get(id).status, 'cancelled')
  assert.equal(store.events.get(id).at(-1).type, 'turn.cancelled')
})

test('cancel 落中间态 cancelling，终态留给真正的执行实例或孤儿清扫', async () => {
  const store = fakeStore()
  const runtime = createBotanicAgentTurnRuntime({ productStore: store, now: () => 500 })
  const id = 'turn-remote-cancel'
  // 不在本实例执行的非终态 Turn：本实例的 activeTurns 看不到它是否跑在别处。
  await store.putAgentTurn('u', {
    id, version: 2, ownerId: 'u', projectId: 'p', idempotencyKey: 'k', status: 'running', createdAt: 1, updatedAt: 1,
  })
  await store.appendAgentTurnEvent('u', 'p', { id: 'e1', turnId: id, projectId: 'p', sequence: 1, type: 'turn.started', createdAt: 1 })

  const cancelled = await runtime.cancel({ userId: 'u', projectId: 'p', turnId: id })

  // 直接写 cancelled 会让远端实例的结果无处归属。
  assert.equal(cancelled.status, 'cancelling')
  assert.equal(store.turns.get(id).status, 'cancelling')
  assert.equal(cancelled.error.code, 'AGENT_TURN_CANCELLED')
  // 事件如实记录「取消请求」，不宣称尚未达成的终态。
  assert.equal(store.events.get(id).at(-1).type, 'turn.cancelling')
  assert.equal(cancelled.lastSequence, 2, '读模型暴露续读游标')
})

test('cancel 对已终态 Turn 是无副作用读取', async () => {
  const store = fakeStore()
  const runtime = createBotanicAgentTurnRuntime({ productStore: store, now: () => 500 })
  const id = 'turn-done'
  await store.putAgentTurn('u', {
    id, version: 2, ownerId: 'u', projectId: 'p', idempotencyKey: 'k', status: 'completed', createdAt: 1, updatedAt: 9,
  })
  const result = await runtime.cancel({ userId: 'u', projectId: 'p', turnId: id })
  assert.equal(result.status, 'completed', '已完成的回合不得被取消改写')
  assert.equal(store.turns.get(id).updatedAt, 9, '不应发生写入')
  assert.equal(store.events.has(id), false, '不应追加事件')
})

test('cancel 忽略不属于该项目的 Turn，避免跨项目越权取消', async () => {
  const store = fakeStore()
  const runtime = createBotanicAgentTurnRuntime({ productStore: store })
  await store.putAgentTurn('u', {
    id: 'turn-other', version: 2, ownerId: 'u', projectId: 'project-a', idempotencyKey: 'k', status: 'running', createdAt: 1, updatedAt: 1,
  })
  assert.equal(await runtime.cancel({ userId: 'u', projectId: 'project-b', turnId: 'turn-other' }), undefined)
  assert.equal(store.turns.get('turn-other').status, 'running')
})

test('Turn 持久化可重放的请求快照，恢复才有输入可依', async () => {
  const store = fakeStore()
  const runtime = createBotanicAgentTurnRuntime({ productStore: store, now: () => 100 })
  const id = 'turn-with-request'
  await runtime.execute({
    userId: 'u', projectId: 'p', id, idempotencyKey: 'k',
    request: { projectId: 'p', instruction: '换成海边场景', locale: 'zh-CN', contextNodeIds: ['node-1'], mountedSkillIds: ['skill-1'] },
    resolve: async () => ({ kind: 'chat', answer: '好' }),
  })
  const stored = store.turns.get(id)
  assert.deepEqual(stored.request, {
    projectId: 'p', instruction: '换成海边场景', locale: 'zh-CN',
    contextNodeIds: ['node-1'], mountedSkillIds: ['skill-1'],
  })
})

test('请求快照拒绝媒体字节，图片只能以稳定标识进入', async () => {
  const store = fakeStore()
  const runtime = createBotanicAgentTurnRuntime({ productStore: store })
  // 嵌套也要挡住：上下文与 Prompt 结构本身是嵌套的。
  for (const request of [
    { instruction: 'x', image: 'data:image/png;base64,AAAA' },
    { instruction: 'x', context: [{ nodeId: 'n', dataUrl: 'data:image/png;base64,AAAA' }] },
    { instruction: 'x', payload: { nested: { buffer: 'AAAA' } } },
  ]) {
    await assert.rejects(
      () => runtime.execute({ userId: 'u', projectId: 'p', id: `t-${Math.random()}`, idempotencyKey: 'k', request, resolve: async () => ({}) }),
      (caught) => caught.code === 'AGENT_TURN_MEDIA_FORBIDDEN',
    )
  }
})

test('没有请求快照时不写空字段，兼容既有 Turn 记录', async () => {
  const store = fakeStore()
  const runtime = createBotanicAgentTurnRuntime({ productStore: store, now: () => 100 })
  await runtime.execute({
    userId: 'u', projectId: 'p', id: 'turn-no-request', idempotencyKey: 'k',
    resolve: async () => ({ kind: 'chat', answer: '好' }),
  })
  assert.equal('request' in store.turns.get('turn-no-request'), false)
})
