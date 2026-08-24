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
