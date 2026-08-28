import test from 'node:test'
import assert from 'node:assert/strict'
import { agentTurnIdForIdempotency, createAgentTurnRecord, createBotanicAgentTurnRuntime } from './botanicAgentTurnRuntime.mjs'
import {
  agentTurnExecutionClaimDecision,
  committedAgentTurnExecution,
  finalizedAgentTurnCancellation,
  requestedAgentTurnCancellation,
} from './productStoreContract.mjs'
import { createLocalCancelRegistry } from './localCancelRegistry.mjs'

function fakeStore() {
  const turns = new Map()
  const events = new Map()
  let clock = 1_000
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
    async claimAgentTurnExecution(userId, claim) {
      const existing = turns.get(claim.turn.id)
      const decision = agentTurnExecutionClaimDecision(existing, {
        ...structuredClone(claim),
        turn: { ...structuredClone(claim.turn), ownerId: userId, lastSequence: existing?.lastSequence ?? 0 },
        observedAt: ++clock,
      })
      if (decision.changed) turns.set(claim.turn.id, structuredClone(decision.turn))
      return structuredClone({ kind: decision.kind, turn: decision.turn })
    },
    async commitAgentTurnExecution(userId, command) {
      const existing = turns.get(command.id)
      if (!existing || existing.ownerId !== userId || existing.projectId !== command.projectId) {
        throw Object.assign(new Error('missing'), { code: 'AGENT_TURN_NOT_FOUND' })
      }
      const decision = committedAgentTurnExecution(existing, { ...structuredClone(command), observedAt: ++clock })
      let storedEvent
      if (['committed', 'replay'].includes(decision.kind) && command.event) {
        const list = events.get(command.id) ?? []
        storedEvent = list.find((item) => item.id === command.event.id)
        if (!storedEvent) {
          storedEvent = {
            ...structuredClone(command.event), ownerId: userId,
            sequence: Math.max(existing.lastSequence ?? 0, ...list.map((event) => event.sequence), 0) + 1,
            executionGeneration: command.executionGeneration,
          }
          list.push(storedEvent)
          events.set(command.id, list)
          decision.turn.lastSequence = storedEvent.sequence
        }
      }
      if (decision.changed) turns.set(command.id, structuredClone(decision.turn))
      return structuredClone({ kind: decision.kind, turn: decision.turn, ...(storedEvent ? { event: storedEvent } : {}) })
    },
    async requestAgentTurnCancellation(userId, request) {
      const existing = turns.get(request.id)
      if (!existing || existing.ownerId !== userId || existing.projectId !== request.projectId) return undefined
      const decision = requestedAgentTurnCancellation(existing, { ...structuredClone(request), observedAt: ++clock })
      let storedEvent
      if (decision.changed && request.event) {
        const list = events.get(request.id) ?? []
        storedEvent = {
          ...structuredClone(request.event), ownerId: userId,
          sequence: Math.max(existing.lastSequence ?? 0, ...list.map((event) => event.sequence), 0) + 1,
        }
        list.push(storedEvent)
        events.set(request.id, list)
        decision.turn.lastSequence = storedEvent.sequence
      }
      if (decision.changed) turns.set(request.id, structuredClone(decision.turn))
      return structuredClone({ kind: decision.kind, turn: decision.turn, ...(storedEvent ? { event: storedEvent } : {}) })
    },
    async finalizeAgentTurnCancellation(userId, request) {
      const existing = turns.get(request.id)
      if (!existing || existing.ownerId !== userId || existing.projectId !== request.projectId) return undefined
      const decision = finalizedAgentTurnCancellation(existing, {
        ...structuredClone(request), observedAt: ++clock,
      })
      let storedEvent
      if (decision.kind === 'finalized' && request.event) {
        const list = events.get(request.id) ?? []
        storedEvent = {
          ...structuredClone(request.event), ownerId: userId,
          sequence: Math.max(existing.lastSequence ?? 0, ...list.map((event) => event.sequence), 0) + 1,
        }
        list.push(storedEvent)
        events.set(request.id, list)
        decision.turn.lastSequence = storedEvent.sequence
      }
      if (decision.changed) turns.set(request.id, structuredClone(decision.turn))
      return structuredClone({
        kind: decision.kind,
        turn: decision.turn,
        ...(storedEvent ? { event: storedEvent } : {}),
      })
    },
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
      return {
        kind: 'chat', answer: '完成',
        entityReferences: [{ type: 'agent_run', id: 'run-1' }],
        reasoning: [{ source: 'raw', text: 'secret chain' }],
      }
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
  assert.deepEqual(store.turns.get(id).result.entityReferences, [{ type: 'agent_run', id: 'run-1' }])
  assert.deepEqual(first.turn.result.entityReferences, [{ type: 'agent_run', id: 'run-1' }])
  assert.equal(store.events.get(id).some((event) => event.type === 'turn.tool'), true)
  assert.equal(store.events.get(id).some((event) => JSON.stringify(event).includes('secret chain')), false)
  assert.equal(toolEventWasPersistedBeforeDelivery, true)
  assert.equal(events[0].type, 'reasoning')
})

test('Turn Runtime 持久化边界拒绝 URL/未知类型业务引用，不把恶意 refs 写入结果', async () => {
  const store = fakeStore()
  const runtime = createBotanicAgentTurnRuntime({ productStore: store })
  const id = 'turn-invalid-entity-reference'
  let failure
  await assert.rejects(
    () => runtime.execute({
      userId: 'u', projectId: 'p', id, idempotencyKey: 'invalid-entity-reference',
      resolve: async () => ({
        kind: 'chat', answer: '不应完成',
        entityReferences: [{ type: 'artifact', id: 'https://evil.test/private.png' }],
      }),
    }),
    (caught) => {
      failure = caught
      return caught?.code === 'AGENT_ENTITY_REFERENCES_INVALID'
    },
  )

  assert.equal(failure.turn.status, 'failed')
  assert.equal(failure.turn.error.code, 'AGENT_ENTITY_REFERENCES_INVALID')
  assert.equal(store.turns.get(id).result, undefined)
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

test('SSE 推送失败不回滚已持久化事件，续读也不重跑 Provider', async () => {
  const store = fakeStore()
  const runtime = createBotanicAgentTurnRuntime({ productStore: store })
  const id = 'turn-delivery-failure'
  let resolverCalls = 0
  const input = {
    userId: 'u', projectId: 'p', id, idempotencyKey: 'delivery-failure',
    resolve: async ({ onEvent }) => {
      resolverCalls += 1
      onEvent({ type: 'tool', step: 0, toolCall: { id: 'tool-1', name: 'project_read', status: 'succeeded' } })
      return { kind: 'chat', answer: '完成' }
    },
    onEvent: () => { throw new Error('观察通道已断开') },
  }

  const first = await runtime.execute(input)
  const replay = await runtime.execute(input)

  assert.equal(first.turn.status, 'completed')
  assert.equal(replay.turn.status, 'completed')
  assert.equal(resolverCalls, 1)
  assert.equal(store.events.get(id).filter((entry) => entry.type === 'turn.tool').length, 1)
})

test('持久化工具事件只保留可 reattach 的人话展示字段，不带参数、输出或 reasoning', async () => {
  const store = fakeStore()
  const runtime = createBotanicAgentTurnRuntime({ productStore: store })
  const id = 'turn-safe-tool-presentation'
  await runtime.execute({
    userId: 'u', projectId: 'p', id, idempotencyKey: 'safe-presentation',
    resolve: async ({ onEvent }) => {
      onEvent({
        type: 'tool', step: 0,
        toolCall: {
          id: 'tool-search', name: 'web_search', label: '搜索品牌参考', risk: 'read', status: 'succeeded',
          summary: `核对公开品牌资料${'。'.repeat(150)}`,
          arguments: { query: '机密检索词' },
          output: { url: 'https://private.example/result' },
          reasoning: '完整隐藏推理',
        },
        presentation: {
          kind: 'search', title: '已搜索 3 个网站', count: 3,
          sources: [
            { hostname: 'www.andlight.cn', url: 'https://www.andlight.cn/', title: '和光' },
            { hostname: 'private', url: 'https://127.0.0.1/secret', title: '不得持久化' },
            { hostname: 'oversized', url: `https://example.com/${'a'.repeat(2048)}` },
          ],
          url: 'https://private.example/presentation', output: '不得持久化',
        },
      })
      return { kind: 'chat', answer: '完成' }
    },
  })

  const payload = store.events.get(id).find((entry) => entry.type === 'turn.tool').payload
  assert.equal(payload.label, '搜索品牌参考')
  assert.equal(payload.summary.length, 120)
  assert.deepEqual(payload.presentation, {
    kind: 'search',
    title: '已搜索 3 个网站',
    count: 3,
    sources: [{ hostname: 'www.andlight.cn', url: 'https://www.andlight.cn/', title: '和光' }],
  })
  assert.doesNotMatch(JSON.stringify(payload), /机密检索词|private\.example|完整隐藏推理|不得持久化/u)
  assert.equal('arguments' in payload, false)
  assert.equal('output' in payload, false)
  assert.equal('reasoning' in payload, false)
})

test('resolver 自报取消不能越过 durable fence 伪造 cancelled 终态', async () => {
  const store = fakeStore()
  const runtime = createBotanicAgentTurnRuntime({ productStore: store })
  const id = 'turn-cancel'
  const result = await runtime.execute({
    userId: 'u', projectId: 'p', id, idempotencyKey: 'k',
    resolve: async () => { throw Object.assign(new Error('请求已取消'), { code: 'REQUEST_CANCELLED', statusCode: 499 }) },
  }).catch((error) => error)
  assert.equal(result.turn.status, 'failed')
  assert.equal(store.turns.get(id).status, 'failed')
  assert.equal(store.events.get(id).at(-1).type, 'turn.failed')
})

test('权威复读失败时 executor 也不能把 durable cancelling 直接提交为 cancelled', async () => {
  const store = fakeStore()
  const readAgentTurn = store.readAgentTurn.bind(store)
  let reads = 0
  store.readAgentTurn = async (userId, id) => {
    reads += 1
    if (reads === 1) return readAgentTurn(userId, id)
    const stored = store.turns.get(id)
    store.turns.set(id, {
      ...stored,
      status: 'cancelling',
      error: { code: 'AGENT_TURN_CANCELLED', message: '跨实例取消已落库' },
    })
    throw Object.assign(new Error('authoritative read unavailable'), { code: 'WORKSPACE_STORE_TIMEOUT' })
  }
  const runtime = createBotanicAgentTurnRuntime({ productStore: store })

  await assert.rejects(
    runtime.execute({
      userId: 'u', projectId: 'p', id: 'turn-cancelling-read-failure', idempotencyKey: 'same',
      request: { instruction: '继续' },
      resolve: async () => {
        throw Object.assign(new Error('provider aborted'), { code: 'AGENT_TURN_CANCELLED', statusCode: 499 })
      },
    }),
    (caught) => caught?.code === 'AGENT_TURN_CANCELLED',
  )
  assert.equal(store.turns.get('turn-cancelling-read-failure').status, 'cancelling')
  assert.equal(store.events.get('turn-cancelling-read-failure').some((event) => event.type === 'turn.cancelled'), false)
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

test('深取消完成后 Runtime 用原子 finalize 把无活动执行者的 Turn 收口为 cancelled', async () => {
  const store = fakeStore()
  const runtime = createBotanicAgentTurnRuntime({ productStore: store })
  await store.putAgentTurn('u', {
    id: 'turn-finalize-cancel', version: 2, ownerId: 'u', projectId: 'p',
    idempotencyKey: 'k', status: 'running', createdAt: 1, updatedAt: 1,
  })
  await runtime.cancel({ userId: 'u', projectId: 'p', turnId: 'turn-finalize-cancel' })
  const finalized = await runtime.finalizeCancellation({
    userId: 'u', projectId: 'p', turnId: 'turn-finalize-cancel',
  })
  assert.equal(finalized.status, 'cancelled')
  assert.equal(store.turns.get('turn-finalize-cancel').status, 'cancelled')
  assert.equal(store.events.get('turn-finalize-cancel').at(-1).type, 'turn.cancelled')
})

test('cancel 允许 completed Turn 进入深取消，failed/cancelled 才是无副作用终态', async () => {
  const store = fakeStore()
  const runtime = createBotanicAgentTurnRuntime({ productStore: store, now: () => 500 })
  const id = 'turn-completed-with-linked-work'
  await store.putAgentTurn('u', {
    id, version: 2, ownerId: 'u', projectId: 'p', idempotencyKey: 'k', status: 'completed', createdAt: 1, updatedAt: 9,
  })
  const result = await runtime.cancel({ userId: 'u', projectId: 'p', turnId: id })
  assert.equal(result.status, 'cancelling')
  assert.equal(store.events.get(id).at(-1).type, 'turn.cancelling')

  for (const status of ['failed', 'cancelled']) {
    const terminalId = `turn-${status}`
    await store.putAgentTurn('u', {
      id: terminalId, version: 2, ownerId: 'u', projectId: 'p', idempotencyKey: terminalId,
      status, createdAt: 1, updatedAt: 9,
    })
    const terminal = await runtime.cancel({ userId: 'u', projectId: 'p', turnId: terminalId })
    assert.equal(terminal.status, status)
    assert.equal(store.turns.get(terminalId).updatedAt, 9)
    assert.equal(store.events.has(terminalId), false)
  }
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

test('durable cancel fence 写入失败时不 abort 本地 Provider，避免权威 running 被 Sweep 误恢复', async () => {
  const store = fakeStore()
  await store.putAgentTurn('u', {
    id: 'turn-cancel-store-failed', version: 2, ownerId: 'u', projectId: 'p',
    idempotencyKey: 'k', status: 'running', createdAt: 1, updatedAt: 1,
  })
  store.requestAgentTurnCancellation = async () => {
    throw Object.assign(new Error('store unavailable'), { code: 'WORKSPACE_STORE_TIMEOUT' })
  }
  let aborts = 0
  const registry = createLocalCancelRegistry()
  registry.register('turn-cancel-store-failed', { abort: () => { aborts += 1 } })
  const runtime = createBotanicAgentTurnRuntime({ productStore: store, localCancelRegistry: registry })

  await assert.rejects(
    runtime.cancel({ userId: 'u', projectId: 'p', turnId: 'turn-cancel-store-failed' }),
    (caught) => caught?.code === 'WORKSPACE_STORE_TIMEOUT',
  )
  assert.equal(aborts, 0)
  assert.equal(store.turns.get('turn-cancel-store-failed').status, 'running')
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

test('新会话协议只从请求摘要排除服务端派生 messages，并保留首次窗口供恢复', async () => {
  const store = fakeStore()
  const firstWindow = Array.from({ length: 16 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `历史-${index}`,
  }))
  // 模拟会话超过 16 条以后，有界模型窗口因后续消息整体滑动。
  const laterWindow = Array.from({ length: 24 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `历史-${index}`,
  })).slice(-16)
  const stableIntent = {
    projectId: 'p',
    sessionId: 'session-1',
    inputMessage: { id: 'input-1', content: '生成海边主视觉' },
    locale: 'zh-CN',
    plannerModel: 'planner-a',
    contextNodeIds: ['node-1'],
    hasTarget: true,
    selectedResultLabel: '主视觉 A',
  }
  const firstRecord = createAgentTurnRecord({
    id: 'turn-thread-replay', ownerId: 'u', projectId: 'p', idempotencyKey: 'same',
    request: { ...stableIntent, messages: firstWindow }, now: 100,
  })
  const laterRecord = createAgentTurnRecord({
    id: 'turn-thread-replay', ownerId: 'u', projectId: 'p', idempotencyKey: 'same',
    request: { ...stableIntent, messages: laterWindow }, now: 200,
  })
  assert.equal(firstRecord.requestHash, laterRecord.requestHash)
  assert.notDeepEqual(firstRecord.request.messages, laterRecord.request.messages)

  const runtime = createBotanicAgentTurnRuntime({ productStore: store })
  let resolverCalls = 0
  const first = await runtime.execute({
    userId: 'u', projectId: 'p', id: 'turn-thread-replay', idempotencyKey: 'same',
    sessionId: 'session-1', request: { ...stableIntent, messages: firstWindow },
    resolve: async () => { resolverCalls += 1; return { kind: 'chat', answer: '完成' } },
  })
  const replay = await runtime.execute({
    userId: 'u', projectId: 'p', id: 'turn-thread-replay', idempotencyKey: 'same',
    sessionId: 'session-1', request: { ...stableIntent, messages: laterWindow },
    resolve: async () => { resolverCalls += 1; return { kind: 'chat', answer: '不得重跑' } },
  })

  assert.equal(first.turn.status, 'completed')
  assert.equal(replay.turn.status, 'completed')
  assert.equal(resolverCalls, 1)
  assert.deepEqual(store.turns.get('turn-thread-replay').request.messages, firstWindow)
})

test('新会话请求摘要仍绑定 inputMessage、模型与选择上下文，旧协议仍绑定 messages', () => {
  const base = {
    projectId: 'p',
    sessionId: 'session-1',
    inputMessage: { id: 'input-1', content: '生成海边主视觉' },
    messages: [{ role: 'user', content: '派生窗口' }],
    locale: 'zh-CN',
    plannerModel: 'planner-a',
    contextNodeIds: ['node-1'],
    hasTarget: true,
    selectedResultLabel: '主视觉 A',
  }
  const record = (request) => createAgentTurnRecord({
    id: 'turn-intent-hash', ownerId: 'u', projectId: 'p', idempotencyKey: 'same', request, now: 100,
  })
  const baseline = record(base).requestHash
  for (const changed of [
    { ...base, inputMessage: { ...base.inputMessage, content: '生成山间主视觉' } },
    { ...base, plannerModel: 'planner-b' },
    { ...base, contextNodeIds: ['node-2'] },
    { ...base, selectedResultLabel: '主视觉 B' },
  ]) {
    assert.notEqual(record(changed).requestHash, baseline)
  }

  const legacyFirst = record({ projectId: 'p', messages: [{ role: 'user', content: '第一条' }] })
  const legacyChanged = record({ projectId: 'p', messages: [{ role: 'user', content: '另一条' }] })
  assert.notEqual(legacyFirst.requestHash, legacyChanged.requestHash)
})

test('新 Turn 的 thread context snapshot 纳入 request hash，顶层兼容窗口不再决定恢复上下文', () => {
  const snapshot = {
    version: 1,
    messages: [{ role: 'user', content: '首次权威窗口' }],
    threadSummary: { version: 1, goals: ['首次目标'], updatedAt: 10 },
  }
  const base = {
    projectId: 'p', sessionId: 'session-1',
    inputMessage: { id: 'input-1', content: '继续' },
    messages: [{ role: 'user', content: '顶层兼容窗口' }],
    threadContextSnapshot: snapshot,
  }
  const record = (request) => createAgentTurnRecord({
    id: 'turn-thread-context-hash', ownerId: 'u', projectId: 'p', idempotencyKey: 'same', request, now: 100,
  })

  const baseline = record(base).requestHash
  assert.equal(record({ ...base, messages: [{ role: 'assistant', content: '滑动后的兼容窗口' }] }).requestHash, baseline)
  assert.notEqual(record({
    ...base,
    threadContextSnapshot: {
      ...snapshot,
      threadSummary: { ...snapshot.threadSummary, goals: ['恢复时的新目标'], updatedAt: 20 },
    },
  }).requestHash, baseline)
})

test('legacy Turn 缺摘要时只恢复已存请求，不执行冲突的新 input', async () => {
  const store = fakeStore()
  const stableRequest = {
    projectId: 'p', sessionId: 'session-1',
    inputMessage: { id: 'message-1', content: '生成海边主视觉' },
    messages: [{ role: 'user', content: '首次权威窗口' }],
  }
  store.turns.set('turn-legacy-runtime', {
    id: 'turn-legacy-runtime', version: 2, ownerId: 'u', projectId: 'p',
    idempotencyKey: 'same', request: structuredClone(stableRequest),
    status: 'queued', createdAt: 100, updatedAt: 100,
  })
  const runtime = createBotanicAgentTurnRuntime({ productStore: store })
  let resolverCalls = 0
  await runtime.execute({
    userId: 'u', projectId: 'p', id: 'turn-legacy-runtime', idempotencyKey: 'same',
    request: { ...stableRequest, messages: [{ role: 'assistant', content: '滑动后窗口' }] },
    resolve: async () => { resolverCalls += 1; return { kind: 'chat', answer: '完成' } },
  })
  assert.equal(resolverCalls, 1)
  assert.equal(typeof store.turns.get('turn-legacy-runtime').requestHash, 'string')
  assert.deepEqual(store.turns.get('turn-legacy-runtime').request, stableRequest)

  store.turns.set('turn-legacy-conflicting-input', {
    id: 'turn-legacy-conflicting-input', version: 2, ownerId: 'u', projectId: 'p',
    idempotencyKey: 'same-conflict', request: structuredClone(stableRequest),
    status: 'queued', createdAt: 100, updatedAt: 100,
  })
  await assert.rejects(
    runtime.execute({
      userId: 'u', projectId: 'p', id: 'turn-legacy-conflicting-input', idempotencyKey: 'same-conflict',
      request: {
        ...stableRequest,
        inputMessage: { ...stableRequest.inputMessage, content: '改成山间主视觉' },
      },
      resolve: async () => { resolverCalls += 1; return { kind: 'chat', answer: '不应执行' } },
    }),
    (caught) => caught?.code === 'AGENT_TURN_INTENT_CONFLICT',
  )
  assert.equal(resolverCalls, 1)
  assert.equal(store.turns.get('turn-legacy-conflicting-input').requestHash, undefined)
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

test('两个 Runtime 实例竞争同一 Turn 时只有原子 claim 胜者调用 resolver', async () => {
  const store = fakeStore()
  const firstRuntime = createBotanicAgentTurnRuntime({ productStore: store })
  const secondRuntime = createBotanicAgentTurnRuntime({ productStore: store })
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let calls = 0
  const input = {
    userId: 'u', projectId: 'p', id: 'turn-race', idempotencyKey: 'same', request: { instruction: 'x' },
  }
  const first = firstRuntime.execute({
    ...input,
    resolve: async () => { calls += 1; await gate; return { kind: 'chat', answer: '完成' } },
  })
  await new Promise((resolve) => setImmediate(resolve))
  const observed = await secondRuntime.execute({
    ...input,
    resolve: async () => { calls += 1; return { kind: 'chat', answer: '重复' } },
  })
  assert.equal(observed.turn.status, 'running')
  assert.equal(observed.inProgress, true)
  assert.equal(calls, 1)
  release()
  assert.equal((await first).turn.status, 'completed')
  assert.equal(calls, 1)
})

test('同幂等键绑定请求摘要，不允许换请求借用原 Turn', async () => {
  const store = fakeStore()
  const firstRuntime = createBotanicAgentTurnRuntime({ productStore: store })
  const secondRuntime = createBotanicAgentTurnRuntime({ productStore: store })
  await firstRuntime.execute({
    userId: 'u', projectId: 'p', id: 'turn-intent-conflict', idempotencyKey: 'same',
    request: { instruction: '第一条' }, resolve: async () => ({ kind: 'chat', answer: '完成' }),
  })
  await assert.rejects(
    secondRuntime.execute({
      userId: 'u', projectId: 'p', id: 'turn-intent-conflict', idempotencyKey: 'same',
      request: { instruction: '另一条' }, resolve: async () => ({ kind: 'chat', answer: '不应执行' }),
    }),
    (caught) => caught?.code === 'AGENT_TURN_INTENT_CONFLICT' && caught?.statusCode === 409,
  )
})

test('同一 Runtime 活动 Turn 也先比较请求摘要，不把不同请求并到首个 Promise', async () => {
  const store = fakeStore()
  const runtime = createBotanicAgentTurnRuntime({ productStore: store })
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const first = runtime.execute({
    userId: 'u', projectId: 'p', id: 'turn-local-intent-conflict', idempotencyKey: 'same',
    request: { instruction: '第一条' },
    resolve: async () => { await gate; return { kind: 'chat', answer: '完成' } },
  })
  await new Promise((resolve) => setImmediate(resolve))
  await assert.rejects(
    runtime.execute({
      userId: 'u', projectId: 'p', id: 'turn-local-intent-conflict', idempotencyKey: 'same',
      request: { instruction: '另一条' },
      resolve: async () => ({ kind: 'chat', answer: '不应合并' }),
    }),
    (caught) => caught?.code === 'AGENT_TURN_INTENT_CONFLICT',
  )
  release()
  await first
})

test('public Turn 不暴露执行租约、请求快照与私有 checkpoint', async () => {
  const store = fakeStore()
  const runtime = createBotanicAgentTurnRuntime({ productStore: store })
  const execution = await runtime.execute({
    userId: 'u', projectId: 'p', id: 'turn-private-runtime', idempotencyKey: 'private',
    request: { instruction: '内部请求' }, resolve: async () => ({ kind: 'chat', answer: '完成' }),
  })
  assert.equal('execution' in execution.turn, false)
  assert.equal('checkpoint' in execution.turn, false)
  assert.equal('request' in execution.turn, false)
  assert.equal(store.turns.get('turn-private-runtime').execution.generation, 1)
})

test('新 generation 接管后，旧实例迟到的 completed 会被 fencing 拒绝', async () => {
  const store = fakeStore()
  const firstRuntime = createBotanicAgentTurnRuntime({ productStore: store })
  const secondRuntime = createBotanicAgentTurnRuntime({ productStore: store })
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const input = {
    userId: 'u', projectId: 'p', id: 'turn-takeover', idempotencyKey: 'same', request: { instruction: 'x' },
  }
  const first = firstRuntime.execute({
    ...input,
    resolve: async () => { await gate; return { kind: 'chat', answer: '旧结果' } },
  })
  await new Promise((resolve) => setImmediate(resolve))
  const stale = store.turns.get(input.id)
  stale.execution.leaseExpiresAt = 0
  store.turns.set(input.id, stale)

  const second = await secondRuntime.execute({
    ...input,
    allowTakeover: true,
    resolve: async () => ({ kind: 'chat', answer: '新结果' }),
  })
  assert.equal(second.turn.result.answer, '新结果')
  assert.equal(store.turns.get(input.id).execution.generation, 2)
  release()
  await assert.rejects(first, (caught) => caught?.code === 'AGENT_TURN_LEASE_STALE')
  assert.equal(store.turns.get(input.id).result.answer, '新结果')
})

test('显式取消压过忽略 Abort 的迟到 Provider 结果，executor 不越过深取消收口', async () => {
  const store = fakeStore()
  const runtime = createBotanicAgentTurnRuntime({ productStore: store })
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const execution = runtime.execute({
    userId: 'u', projectId: 'p', id: 'turn-cancel-race', idempotencyKey: 'same', request: { instruction: 'x' },
    resolve: async () => { await gate; return { kind: 'chat', answer: '迟到结果' } },
  })
  await new Promise((resolve) => setImmediate(resolve))
  const cancelling = await runtime.cancel({ userId: 'u', projectId: 'p', turnId: 'turn-cancel-race' })
  assert.equal(cancelling.status, 'cancelling')
  release()
  await assert.rejects(execution, (caught) => caught?.code === 'AGENT_TURN_CANCELLED')
  assert.equal(store.turns.get('turn-cancel-race').status, 'cancelling')
  assert.equal(store.turns.get('turn-cancel-race').result, undefined)
  assert.equal(store.events.get('turn-cancel-race').some((event) => event.type === 'turn.cancelled'), false)

  await runtime.finalizeCancellation({ userId: 'u', projectId: 'p', turnId: 'turn-cancel-race' })
  assert.equal(store.turns.get('turn-cancel-race').status, 'cancelled')
  assert.equal(store.events.get('turn-cancel-race').at(-1).type, 'turn.cancelled')
})

test('Runtime 拥有 AbortController，durable cancel 会真正中止 Provider 并释放本地句柄', async () => {
  const store = fakeStore()
  const registry = createLocalCancelRegistry()
  const runtime = createBotanicAgentTurnRuntime({ productStore: store, localCancelRegistry: registry })
  let providerSignal
  let providerStarted
  const started = new Promise((resolve) => { providerStarted = resolve })
  const execution = runtime.execute({
    userId: 'u', projectId: 'p', id: 'turn-owned-abort', idempotencyKey: 'same',
    resolveOptions: { signal: AbortSignal.abort('HTTP 连接信号不得接管 Turn') },
    resolve: ({ signal }) => new Promise((_resolve, reject) => {
      providerSignal = signal
      providerStarted()
      signal.addEventListener('abort', () => reject(Object.assign(new Error('provider aborted'), { code: 'ABORT_ERR' })), { once: true })
    }),
  })
  await started
  assert.equal(providerSignal.aborted, false, 'Runtime 必须覆盖传输层 signal')
  assert.equal(registry.has('turn-owned-abort'), true)

  await runtime.cancel({ userId: 'u', projectId: 'p', turnId: 'turn-owned-abort' })
  await assert.rejects(execution, (caught) => caught?.code === 'AGENT_TURN_CANCELLED')
  assert.equal(providerSignal.aborted, true)
  assert.equal(registry.has('turn-owned-abort'), false)
  assert.equal(store.turns.get('turn-owned-abort').status, 'cancelling')
  assert.equal(store.turns.get('turn-owned-abort').error.code, 'AGENT_TURN_CANCELLED')
  assert.equal(store.events.get('turn-owned-abort').some((event) => event.type === 'turn.cancelled'), false)
})

test('Runtime 覆盖外部伪造的 root identity，并把当前 executor fence 只读注入 Resolver', async () => {
  const store = fakeStore()
  const runtime = createBotanicAgentTurnRuntime({ productStore: store })
  let observed

  await runtime.execute({
    userId: 'user-authoritative',
    projectId: 'project-authoritative',
    sessionId: 'session-authoritative',
    id: 'turn-authoritative',
    idempotencyKey: 'identity-fence',
    resolveOptions: {
      runtimeIdentity: {
        userId: 'attacker', projectId: 'attacker', turnId: 'attacker',
        executionGeneration: 999, leaseToken: 'attacker-lease',
      },
    },
    resolve: async ({ runtimeIdentity }) => {
      observed = runtimeIdentity
      assert.equal(Object.isFrozen(runtimeIdentity), true)
      assert.throws(() => { runtimeIdentity.turnId = 'forged-after-injection' }, TypeError)
      return { kind: 'chat', answer: '完成' }
    },
  })

  assert.equal(observed.userId, 'user-authoritative')
  assert.equal(observed.projectId, 'project-authoritative')
  assert.equal(observed.turnId, 'turn-authoritative')
  assert.equal(observed.sessionId, 'session-authoritative')
  assert.equal(observed.executionGeneration, 1)
  assert.match(observed.leaseToken, /^agent_turn_lease_/u)
})

test('Redis cancel 早于句柄登记到达时，Runtime 补读 durable fence 后仍会中止 Provider', async () => {
  const store = fakeStore()
  const registry = createLocalCancelRegistry()
  const commit = store.commitAgentTurnExecution.bind(store)
  store.commitAgentTurnExecution = async (userId, command) => {
    const result = await commit(userId, command)
    if (command.event?.type === 'turn.started') {
      const stored = store.turns.get(command.id)
      store.turns.set(command.id, {
        ...stored,
        status: 'cancelling',
        error: { code: 'AGENT_TURN_CANCELLED', message: '跨实例取消' },
      })
      assert.equal(registry.abort(command.id), false, '信号到达时句柄尚未登记')
    }
    return result
  }
  const runtime = createBotanicAgentTurnRuntime({ productStore: store, localCancelRegistry: registry })
  let providerSignal

  await assert.rejects(
    runtime.execute({
      userId: 'u', projectId: 'p', id: 'turn-register-race', idempotencyKey: 'same',
      resolve: async ({ signal }) => {
        providerSignal = signal
        assert.equal(signal.aborted, true)
        throw Object.assign(new Error('provider aborted'), { code: 'ABORT_ERR' })
      },
    }),
    (caught) => caught?.code === 'AGENT_TURN_CANCELLED',
  )
  assert.equal(providerSignal.aborted, true)
  assert.equal(registry.has('turn-register-race'), false)
  assert.equal(store.turns.get('turn-register-race').status, 'cancelling')
  assert.equal(store.events.get('turn-register-race').some((event) => event.type === 'turn.cancelled'), false)
})

test('Turn 句柄登记后首次权威复读失败也会释放本地 cancel handle', async () => {
  const store = fakeStore()
  const registry = createLocalCancelRegistry()
  store.readAgentTurn = async () => {
    throw Object.assign(new Error('authoritative read unavailable'), {
      code: 'WORKSPACE_STORE_TIMEOUT',
    })
  }
  const runtime = createBotanicAgentTurnRuntime({ productStore: store, localCancelRegistry: registry })

  await assert.rejects(
    runtime.execute({
      userId: 'u', projectId: 'p', id: 'turn-register-read-failure', idempotencyKey: 'same',
      request: { instruction: '继续' },
      resolve: async () => ({ kind: 'chat', answer: '不应执行' }),
    }),
    (caught) => caught?.code === 'WORKSPACE_STORE_TIMEOUT',
  )
  assert.equal(registry.has('turn-register-read-failure'), false)
})

test('clarification 以 waiting_user 持久化，公开结果保留且后续显式取消可压过', async () => {
  const store = fakeStore()
  const runtime = createBotanicAgentTurnRuntime({ productStore: store })
  const execution = await runtime.execute({
    userId: 'u', projectId: 'p', id: 'turn-waiting-user', idempotencyKey: 'clarify',
    resolve: async () => ({ kind: 'clarification', question: '需要保留人物还是场景？' }),
  })
  assert.equal(execution.turn.status, 'waiting_user')
  assert.equal(execution.result.question, '需要保留人物还是场景？')
  assert.equal(execution.turn.result.question, '需要保留人物还是场景？')
  assert.equal(store.events.get('turn-waiting-user').at(-1).type, 'turn.waiting_user')

  const cancelling = await runtime.cancel({ userId: 'u', projectId: 'p', turnId: 'turn-waiting-user' })
  assert.equal(cancelling.status, 'cancelling')
  assert.equal(store.turns.get('turn-waiting-user').status, 'cancelling')
})

test('慢模型期间 heartbeat 持续续租，避免被 Sweep 误判为孤儿', async () => {
  const store = fakeStore()
  const runtime = createBotanicAgentTurnRuntime({ productStore: store, heartbeatMs: 10 })
  await runtime.execute({
    userId: 'u', projectId: 'p', id: 'turn-heartbeat', idempotencyKey: 'same', request: { instruction: 'x' },
    resolve: async () => {
      await new Promise((resolve) => setTimeout(resolve, 35))
      return { kind: 'chat', answer: '完成' }
    },
  })
  const stored = store.turns.get('turn-heartbeat')
  assert.ok(stored.execution.lastHeartbeatAt > stored.execution.claimedAt)
})

test('Turn 取消后 resolver 即使忽略 AbortSignal，原执行者仍续 cancellation lease，真实退出后才 ack', async () => {
  const store = fakeStore()
  const runtime = createBotanicAgentTurnRuntime({
    productStore: store,
    leaseMs: 30_000,
    heartbeatMs: 10,
  })
  let releaseResolver
  let resolverStarted
  const started = new Promise((resolve) => { resolverStarted = resolve })
  const gate = new Promise((resolve) => { releaseResolver = resolve })
  const execution = runtime.execute({
    userId: 'u', projectId: 'p', id: 'turn-cancel-heartbeat', idempotencyKey: 'cancel-heartbeat',
    request: { instruction: '慢请求' },
    resolve: async () => {
      resolverStarted()
      await gate // 故意不监听 AbortSignal，模拟无法及时退出的 Provider。
      return { kind: 'chat', answer: '迟到结果' }
    },
  })

  await started
  await runtime.cancel({ userId: 'u', projectId: 'p', turnId: 'turn-cancel-heartbeat' })
  const requested = structuredClone(store.turns.get('turn-cancel-heartbeat'))
  assert.equal(requested.status, 'cancelling')
  assert.equal(requested.cancellation.signalRequired, true)

  await new Promise((resolve) => setTimeout(resolve, 35))
  const stillRunning = store.turns.get('turn-cancel-heartbeat')
  assert.equal(stillRunning.cancellation.workerReleased, false)
  assert.ok(stillRunning.execution.leaseExpiresAt > requested.execution.leaseExpiresAt)
  assert.ok(stillRunning.cancellation.lastHeartbeatAt > requested.cancellation.requestedAt)

  const premature = await runtime.finalizeCancellation({
    userId: 'u', projectId: 'p', turnId: 'turn-cancel-heartbeat',
  })
  assert.equal(premature.status, 'cancelling')

  releaseResolver()
  await assert.rejects(execution, (caught) => caught?.code === 'AGENT_TURN_CANCELLED')
  const exited = store.turns.get('turn-cancel-heartbeat')
  assert.equal(exited.cancellation.workerReleased, true)
  assert.equal(exited.cancellation.releaseBasis, 'worker_exit')
  assert.ok(exited.execution.settledAt >= exited.cancellation.signalAcknowledgedAt)

  const finalized = await runtime.finalizeCancellation({
    userId: 'u', projectId: 'p', turnId: 'turn-cancel-heartbeat',
  })
  assert.equal(finalized.status, 'cancelled')
})

test('heartbeat 提交失败会立即中止旧执行者，且不误记为用户取消', async () => {
  const store = fakeStore()
  const commit = store.commitAgentTurnExecution.bind(store)
  let heartbeatAttempts = 0
  store.commitAgentTurnExecution = async (userId, command) => {
    if (command.status === 'running'
      && !command.event
      && !Object.hasOwn(command, 'checkpoint')) {
      heartbeatAttempts += 1
      if (heartbeatAttempts === 1) {
        throw Object.assign(new Error('heartbeat storage unavailable'), {
          code: 'AGENT_TURN_HEARTBEAT_COMMIT_FAILED',
          statusCode: 503,
        })
      }
    }
    return commit(userId, command)
  }

  const runtime = createBotanicAgentTurnRuntime({ productStore: store, heartbeatMs: 10 })
  let providerSignal
  let providerAborted = false
  const execution = runtime.execute({
    userId: 'u', projectId: 'p', id: 'turn-heartbeat-failure', idempotencyKey: 'same',
    request: { instruction: 'x' },
    resolve: ({ signal }) => new Promise((_resolve, reject) => {
      providerSignal = signal
      const timeout = setTimeout(() => {
        reject(Object.assign(new Error('resolver was not aborted'), { code: 'RESOLVER_ABORT_TIMEOUT' }))
      }, 200)
      signal.addEventListener('abort', () => {
        clearTimeout(timeout)
        providerAborted = true
        reject(Object.assign(new Error('provider aborted'), { code: 'ABORT_ERR' }))
      }, { once: true })
    }),
  })

  await assert.rejects(execution, (caught) => {
    assert.equal(caught?.code, 'AGENT_TURN_HEARTBEAT_COMMIT_FAILED')
    assert.equal(caught?.statusCode, 503)
    return true
  })
  assert.equal(heartbeatAttempts, 1)
  assert.equal(providerAborted, true)
  assert.equal(providerSignal.aborted, true)
  assert.equal(store.turns.get('turn-heartbeat-failure').status, 'failed')
  assert.equal(store.turns.get('turn-heartbeat-failure').error.code, 'AGENT_TURN_HEARTBEAT_COMMIT_FAILED')
  assert.notEqual(store.events.get('turn-heartbeat-failure').at(-1).type, 'turn.cancelled')
})

test('heartbeat 发现 lease 已被接管时立即中止旧执行者，不覆盖新 generation', async () => {
  const store = fakeStore()
  const commit = store.commitAgentTurnExecution.bind(store)
  let heartbeatAttempts = 0
  store.commitAgentTurnExecution = async (userId, command) => {
    if (command.status === 'running'
      && !command.event
      && !Object.hasOwn(command, 'checkpoint')) {
      heartbeatAttempts += 1
      if (heartbeatAttempts === 1) {
        const current = store.turns.get(command.id)
        const takenOver = {
          ...current,
          execution: {
            ...current.execution,
            generation: current.execution.generation + 1,
            leaseToken: 'new-owner-lease',
          },
        }
        store.turns.set(command.id, structuredClone(takenOver))
        return { kind: 'stale', turn: structuredClone(takenOver) }
      }
    }
    return commit(userId, command)
  }

  const runtime = createBotanicAgentTurnRuntime({ productStore: store, heartbeatMs: 10 })
  let providerAborted = false
  const execution = runtime.execute({
    userId: 'u', projectId: 'p', id: 'turn-heartbeat-stale', idempotencyKey: 'same',
    request: { instruction: 'x' },
    resolve: ({ signal }) => new Promise((_resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(Object.assign(new Error('resolver was not aborted'), { code: 'RESOLVER_ABORT_TIMEOUT' }))
      }, 200)
      signal.addEventListener('abort', () => {
        clearTimeout(timeout)
        providerAborted = true
        reject(Object.assign(new Error('provider aborted'), { code: 'ABORT_ERR' }))
      }, { once: true })
    }),
  })

  await assert.rejects(execution, (caught) => caught?.code === 'AGENT_TURN_LEASE_STALE')
  assert.equal(heartbeatAttempts, 1)
  assert.equal(providerAborted, true)
  assert.equal(store.turns.get('turn-heartbeat-stale').execution.generation, 2)
  assert.equal(store.turns.get('turn-heartbeat-stale').status, 'running')
  assert.equal(store.events.get('turn-heartbeat-stale').some((entry) => (
    ['turn.failed', 'turn.cancelled'].includes(entry.type)
  )), false)
})

test('Runtime 用 fenced commit 保存私有 checkpoint，并在接管时只交给 resolver 恢复', async () => {
  const store = fakeStore()
  const runtime = createBotanicAgentTurnRuntime({ productStore: store })
  const request = { instruction: '继续' }
  const source = createAgentTurnRecord({
    id: 'turn-checkpoint-runtime', ownerId: 'u', projectId: 'p', idempotencyKey: 'same', request, now: 100,
  })
  source.status = 'running'
  source.execution = {
    generation: 1, leaseToken: 'old', leaseDurationMs: 30_000,
    leaseExpiresAt: 0, claimedAt: 100, lastHeartbeatAt: 100,
  }
  source.checkpoint = {
    version: 1,
    attempt: { id: 'attempt-1', model: 'model-a', snapshotHash: 'hash-a' },
    completedSteps: [],
    pendingStep: { step: 0, phase: 'prepared', calls: [] },
  }
  store.turns.set(source.id, structuredClone(source))
  let received
  const execution = await runtime.execute({
    userId: 'u', projectId: 'p', id: source.id, idempotencyKey: 'same', request, allowTakeover: true,
    resolve: async ({ resumeCheckpoint, saveCheckpoint }) => {
      received = resumeCheckpoint
      await saveCheckpoint({
        ...resumeCheckpoint,
        pendingStep: undefined,
        completedSteps: [{ step: 0, calls: [] }],
      })
      return { kind: 'chat', answer: '完成' }
    },
  })
  assert.equal(received.pendingStep.step, 0)
  assert.equal(store.turns.get(source.id).checkpoint.completedSteps.length, 1)
  assert.equal('checkpoint' in execution.turn, false)
  assert.equal(store.events.get(source.id).some((event) => JSON.stringify(event).includes('snapshotHash')), false)
})

test('resolver fire-and-forget checkpoint 仍先完成 durable commit，再允许 Turn 终态化', async () => {
  const store = fakeStore()
  const commit = store.commitAgentTurnExecution.bind(store)
  const order = []
  let checkpointStarted
  const started = new Promise((resolve) => { checkpointStarted = resolve })
  let releaseCheckpoint
  const checkpointGate = new Promise((resolve) => { releaseCheckpoint = resolve })
  store.commitAgentTurnExecution = async (userId, command) => {
    if (Object.hasOwn(command, 'checkpoint')) {
      order.push('checkpoint:start')
      checkpointStarted()
      await checkpointGate
      const result = await commit(userId, command)
      order.push('checkpoint:committed')
      return result
    }
    if (command.status === 'completed') order.push('turn:completed')
    return commit(userId, command)
  }

  const runtime = createBotanicAgentTurnRuntime({ productStore: store })
  const execution = runtime.execute({
    userId: 'u', projectId: 'p', id: 'turn-fire-and-forget-checkpoint', idempotencyKey: 'same',
    resolve: async ({ saveCheckpoint }) => {
      void saveCheckpoint({ version: 1, marker: 'durable-before-terminal' })
      return { kind: 'chat', answer: '完成' }
    },
  })

  await started
  await new Promise((resolve) => setImmediate(resolve))
  const terminalStartedBeforeCheckpoint = order.includes('turn:completed')
  releaseCheckpoint()
  const result = await execution

  assert.equal(terminalStartedBeforeCheckpoint, false)
  assert.deepEqual(order, ['checkpoint:start', 'checkpoint:committed', 'turn:completed'])
  assert.equal(result.turn.status, 'completed')
  assert.equal(store.turns.get('turn-fire-and-forget-checkpoint').checkpoint.marker, 'durable-before-terminal')
})

test('fire-and-forget checkpoint 拒绝会阻止 completed，且 rejection 已被 Runtime 观察', async () => {
  const store = fakeStore()
  const commit = store.commitAgentTurnExecution.bind(store)
  store.commitAgentTurnExecution = async (userId, command) => {
    if (Object.hasOwn(command, 'checkpoint')) {
      throw Object.assign(new Error('checkpoint store unavailable'), {
        code: 'AGENT_TURN_CHECKPOINT_COMMIT_FAILED',
        statusCode: 503,
      })
    }
    return commit(userId, command)
  }
  const unhandled = []
  const observeUnhandled = (caught) => { unhandled.push(caught) }
  process.on('unhandledRejection', observeUnhandled)
  try {
    const runtime = createBotanicAgentTurnRuntime({ productStore: store })
    await assert.rejects(
      runtime.execute({
        userId: 'u', projectId: 'p', id: 'turn-checkpoint-rejected', idempotencyKey: 'same',
        resolve: async ({ saveCheckpoint }) => {
          void saveCheckpoint({ version: 1, marker: 'must-fail-turn' })
          return { kind: 'chat', answer: '不得提交' }
        },
      }),
      (caught) => caught?.code === 'AGENT_TURN_CHECKPOINT_COMMIT_FAILED' && caught?.statusCode === 503,
    )
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(store.turns.get('turn-checkpoint-rejected').status, 'failed')
    assert.equal(store.events.get('turn-checkpoint-rejected').at(-1).type, 'turn.failed')
    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', observeUnhandled)
  }
})

test('Sweep 失败收口从已存 immutable request 派生 binding，并在 claim 锁内回填', async () => {
  const store = fakeStore()
  const request = {
    sessionId: 'session-legacy',
    inputMessage: { id: 'message-legacy', content: '继续完成主视觉' },
    messages: [{ role: 'user', content: '旧上下文窗口' }],
  }
  const legacy = {
    id: 'turn-legacy-settle', version: 2, ownerId: 'u', projectId: 'p',
    idempotencyKey: 'legacy-key', request: structuredClone(request), status: 'running',
    createdAt: 1, updatedAt: 1,
    execution: {
      generation: 1, leaseToken: 'expired-lease', leaseDurationMs: 30_000,
      leaseExpiresAt: 2, claimedAt: 1, lastHeartbeatAt: 1,
    },
  }
  store.turns.set(legacy.id, structuredClone(legacy))
  const runtime = createBotanicAgentTurnRuntime({ productStore: store })

  const settled = await runtime.fail({
    turn: legacy,
    error: { stage: 'turn', code: 'AGENT_TURN_NOT_REPLAYABLE', message: '不可安全重放。' },
  })

  assert.equal(settled.status, 'failed')
  assert.equal(typeof store.turns.get(legacy.id).requestHash, 'string')
  assert.equal(store.turns.get(legacy.id).requestHashVersion, 2)
  assert.deepEqual(store.turns.get(legacy.id).request, request, 'claim-lock 回填不能替换 immutable request')
})

test('缺 request 的 legacy Turn 只使用持久化 fence 安全失败，不信任调用方补入的新请求', async () => {
  const store = fakeStore()
  const legacy = {
    id: 'turn-legacy-request-missing', version: 2, ownerId: 'u', projectId: 'p',
    idempotencyKey: 'legacy-missing-key', status: 'running', createdAt: 1, updatedAt: 1,
    execution: {
      generation: 3, leaseToken: 'persisted-lease', leaseDurationMs: 30_000,
      leaseExpiresAt: 2, claimedAt: 1, lastHeartbeatAt: 1,
    },
  }
  store.turns.set(legacy.id, structuredClone(legacy))
  const runtime = createBotanicAgentTurnRuntime({ productStore: store })

  const settled = await runtime.fail({
    turn: {
      ...legacy,
      request: { instruction: '攻击者补入的新输入' },
      requestHash: 'forged-request-hash',
      requestHashVersion: 2,
    },
    error: { stage: 'turn', code: 'AGENT_TURN_REQUEST_MISSING', message: '请求快照缺失。' },
  })

  assert.equal(settled.status, 'failed')
  const stored = store.turns.get(legacy.id)
  assert.equal(stored.error.code, 'AGENT_TURN_REQUEST_MISSING')
  assert.equal(stored.request, undefined)
  assert.equal(stored.requestHash, undefined)
  assert.equal(stored.execution.generation, 3, '专用失败路径不伪造一次 takeover')
})

test('claim 前时代且无 execution 的 missing-request Turn 复读权威记录后一次收敛', async () => {
  const store = fakeStore()
  const legacy = {
    id: 'turn-pre-claim-request-missing', ownerId: 'u', projectId: 'p',
    idempotencyKey: 'pre-claim-key', status: 'running', createdAt: 1, updatedAt: 1,
  }
  store.turns.set(legacy.id, structuredClone(legacy))
  const runtime = createBotanicAgentTurnRuntime({ productStore: store })

  const settled = await runtime.fail({
    turn: { ...legacy, request: { instruction: '不得作为历史快照' } },
    error: { stage: 'turn', code: 'AGENT_TURN_REQUEST_MISSING', message: '请求快照缺失。' },
  })

  assert.equal(settled.status, 'failed')
  assert.equal(store.turns.get(legacy.id).request, undefined)
  assert.equal(store.turns.get(legacy.id).requestHash, undefined)
  assert.equal(store.turns.get(legacy.id).error.code, 'AGENT_TURN_REQUEST_MISSING')
})
