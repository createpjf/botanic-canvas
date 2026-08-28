import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { createAgentRouteHandler } from './agentRoutes.mjs'
import {
  agentTurnExecutionClaimDecision,
  committedAgentTurnExecution,
} from './productStoreContract.mjs'

const config = {
  flockApiBaseUrl: 'https://provider.test/v1',
  flockApiKey: 'provider-test-key',
  flockTextModel: 'deepseek-v4-pro',
  flockAgentModels: ['deepseek-v4-pro'],
  maximumPromptRefinementRequestBytes: 64 * 1024,
  security: {
    agentPlansPerFiveMinutes: 100,
    agentChatsPerFiveMinutes: 100,
  },
}

const projectDocument = {
  id: 'project-compat-runtime',
  name: '兼容 Runtime 测试项目',
  nodes: [],
  edges: [],
  assetGroups: [],
  agentMemory: [],
}

const planBody = {
  projectId: projectDocument.id,
  locale: 'zh-CN',
  plannerModel: 'deepseek-v4-pro',
  instruction: '保持人物身份与服装不变，把场景替换成海边。',
  requestedIntent: 'replace_scene',
  selectedResult: { nodeId: 'result-1', label: '首图 01' },
  settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' },
  references: [],
  contextSnapshot: [],
  assetGroups: [],
  projectMemory: [],
}

const chatBody = {
  projectId: projectDocument.id,
  locale: 'zh-CN',
  plannerModel: 'deepseek-v4-pro',
  mode: 'conversation',
  messages: [{ role: 'user', content: '项目目前是什么状态？' }],
  contextNodeIds: [],
}

const intentBody = {
  projectId: projectDocument.id,
  locale: 'zh-CN',
  plannerModel: 'deepseek-v4-pro',
  messages: [{ role: 'user', content: '项目目前是什么状态？' }],
  contextNodeIds: [],
  hasTarget: false,
  generationModels: [],
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function deferred() {
  let release
  const promise = new Promise((resolve) => { release = resolve })
  return { promise, release }
}

async function waitFor(predicate, message, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(message)
}

function providerStream(chunks) {
  return new Response([
    ...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`),
    'data: [DONE]\n\n',
  ].join(''), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

function chatProviderResponse(answer = '项目尚未生成结果。') {
  return providerStream([
    { choices: [{ delta: { content: answer } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ])
}

function planProviderResponse() {
  return providerStream([{
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: 'call-plan',
          type: 'function',
          function: {
            name: 'generation_create_plan',
            arguments: JSON.stringify({
              intent: 'replace_scene',
              prompt: '保持人物身份与服装不变，替换为夕阳下的海边场景。',
              summary: '保持人物，替换海边场景。',
              constraints: [
                { dimension: 'person', mode: 'preserve' },
                { dimension: 'scene', mode: 'vary' },
              ],
            }),
          },
        }],
      },
      finish_reason: 'tool_calls',
    }],
  }])
}

function clarificationProviderResponse() {
  return providerStream([{
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: 'call-clarification',
          type: 'function',
          function: {
            name: 'generation_ask_clarification',
            arguments: JSON.stringify({
              question: '请确认这次输出的画面比例。',
              fields: [{ id: 'aspect_ratio', label: '画面比例' }],
            }),
          },
        }],
      },
      finish_reason: 'tool_calls',
    }],
  }])
}

function createMemoryProductStore() {
  const turns = new Map()
  const events = []
  const claims = []
  const commits = []
  return {
    turns,
    events,
    claims,
    commits,
    projectAccess: async () => ({ exists: true, role: 'owner' }),
    readProject: async () => ({ document: clone(projectDocument) }),
    listAgentSkills: async () => [],
    readAgentState: async () => ({ memory: [] }),
    readAgentTurn: async (_userId, turnId) => clone(turns.get(turnId)),
    claimAgentTurnExecution: async (userId, claim) => {
      const decision = agentTurnExecutionClaimDecision(turns.get(claim.turn.id), {
        ...claim,
        turn: { ...claim.turn, ownerId: userId },
        observedAt: Date.now(),
      })
      claims.push({ id: claim.turn.id, kind: decision.kind })
      if (decision.changed && decision.turn) turns.set(claim.turn.id, clone(decision.turn))
      return clone({ kind: decision.kind, turn: decision.turn })
    },
    commitAgentTurnExecution: async (userId, command) => {
      const current = turns.get(command.id)
      const decision = committedAgentTurnExecution(current, {
        ...command,
        observedAt: Date.now(),
      })
      let storedEvent
      if (decision.kind === 'committed' && command.event) {
        const sequence = Math.max(
          Number(current?.lastSequence) || 0,
          ...events.filter((event) => event.turnId === command.id).map((event) => event.sequence),
        ) + 1
        storedEvent = { ...clone(command.event), ownerId: userId, sequence }
        events.push(storedEvent)
        decision.turn.lastSequence = sequence
      }
      commits.push({ id: command.id, status: command.status, kind: decision.kind })
      if (decision.changed && decision.turn) turns.set(command.id, clone(decision.turn))
      return clone({
        kind: decision.kind,
        turn: decision.turn,
        ...(storedEvent ? { event: storedEvent } : {}),
      })
    },
    listAgentTurnEvents: async (_userId, _projectId, turnId) => (
      clone(events.filter((event) => event.turnId === turnId))
    ),
  }
}

function createRequest(headers = {}) {
  return Object.assign(new EventEmitter(), {
    method: 'POST',
    headers,
    aborted: false,
  })
}

function createResponse() {
  return Object.assign(new EventEmitter(), {
    writableEnded: false,
    destroyed: false,
  })
}

function createRouteHarness(initialBody, productStore = createMemoryProductStore()) {
  let body = clone(initialBody)
  const responses = []
  const handler = createAgentRouteHandler({
    config,
    productStore,
    json: (response, status, responseBody) => {
      response.writableEnded = true
      responses.push({ status, body: clone(responseBody) })
      return true
    },
    error: (response, status, code, message) => {
      response.writableEnded = true
      responses.push({ status, body: { error: { code, message } } })
      return true
    },
    readJson: async () => clone(body),
    requireUser: async () => ({ id: 'user-1' }),
    enforceRateLimit: async () => true,
  })
  return {
    handler,
    productStore,
    responses,
    setBody(nextBody) { body = clone(nextBody) },
    async post(path, { headers = {}, requestId, response = createResponse() } = {}) {
      const request = createRequest(headers)
      await handler(request, response, new URL(`http://botanic.test${path}`), {}, requestId)
      return { request, response, json: responses.at(-1) }
    },
  }
}

async function withFakeFetch(fetchImpl, run) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = fetchImpl
  try {
    return await run()
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('plan/chat 的 Prefer: respond-async 都在 durable claim 后返回 202 observer', { concurrency: false }, async () => {
  for (const scenario of [
    { operation: 'plan', path: '/api/agent-plans', body: planBody, response: planProviderResponse },
    { operation: 'chat', path: '/api/agent-chat', body: chatBody, response: chatProviderResponse },
  ]) {
    const gate = deferred()
    const fetchCalls = []
    const harness = createRouteHarness(scenario.body)
    await withFakeFetch(async (_url, init) => {
      fetchCalls.push(init)
      await gate.promise
      return scenario.response()
    }, async () => {
      const result = await harness.post(scenario.path, {
        headers: {
          prefer: 'respond-async',
          'idempotency-key': `compat-${scenario.operation}-async-0001`,
        },
        requestId: `request-${scenario.operation}-async`,
      })

      assert.equal(result.json.status, 202)
      assert.equal(result.json.body.runtimeTurn.status, 'running')
      assert.match(result.json.body.observer.url, /\/api\/agent-turns\/turn_.+\?after=0$/)
      const stored = harness.productStore.turns.get(result.json.body.runtimeTurn.id)
      assert.equal(stored.status, 'running')
      assert.equal(stored.request.runtimeOperation, scenario.operation)
      assert.deepEqual(stored.request.input.projectId, projectDocument.id)

      await waitFor(() => fetchCalls.length === 1, `${scenario.operation} Provider 未启动`)
      assert.equal(fetchCalls[0].signal.aborted, false)
      gate.release()
      await waitFor(
        () => harness.productStore.turns.get(stored.id)?.status === 'completed',
        `${scenario.operation} Turn 未完成`,
      )
    })
  }
})

test('显式 key 重试只调用一次 Provider；同 key 改 payload 返回 409', { concurrency: false }, async () => {
  const gate = deferred()
  const fetchCalls = []
  const harness = createRouteHarness(chatBody)
  await withFakeFetch(async (_url, init) => {
    fetchCalls.push(init)
    await gate.promise
    return chatProviderResponse('同一 Turn 的稳定回答。')
  }, async () => {
    const headers = {
      prefer: 'respond-async',
      'idempotency-key': 'compat-chat-retry-0001',
    }
    const first = await harness.post('/api/agent-chat', { headers, requestId: 'request-retry-1' })
    await waitFor(() => fetchCalls.length === 1, '首次 Provider 未启动')
    const replay = await harness.post('/api/agent-chat', { headers, requestId: 'request-retry-2' })

    assert.equal(first.json.status, 202)
    assert.equal(replay.json.status, 202)
    assert.equal(first.json.body.runtimeTurn.id, replay.json.body.runtimeTurn.id)
    assert.equal(fetchCalls.length, 1)
    assert.equal(harness.productStore.turns.size, 1)

    harness.setBody({
      ...chatBody,
      messages: [{ role: 'user', content: '同一个 key 下偷换成另一份请求。' }],
    })
    await assert.rejects(
      () => harness.post('/api/agent-chat', { headers, requestId: 'request-retry-conflict' }),
      (caught) => caught?.code === 'AGENT_TURN_INTENT_CONFLICT' && caught?.statusCode === 409,
    )
    assert.equal(fetchCalls.length, 1)

    gate.release()
    const turnId = first.json.body.runtimeTurn.id
    await waitFor(
      () => harness.productStore.turns.get(turnId)?.status === 'completed',
      '重试 Turn 未完成',
    )
  })
})

test('plan clarification 以 waiting_user 终态持久化并恢复旧响应形状', { concurrency: false }, async () => {
  const fetchCalls = []
  const harness = createRouteHarness(planBody)
  await withFakeFetch(async (_url, init) => {
    fetchCalls.push(init)
    return clarificationProviderResponse()
  }, async () => {
    const result = await harness.post('/api/agent-plans', {
      headers: { 'idempotency-key': 'compat-plan-clarify-0001' },
      requestId: 'request-plan-clarification',
    })

    assert.equal(result.json.status, 200)
    assert.equal(result.json.body.clarification.question, '请确认这次输出的画面比例。')
    assert.equal(result.json.body.runtimeTurn.status, 'waiting_user')
    const stored = harness.productStore.turns.get(result.json.body.runtimeTurn.id)
    assert.equal(stored.status, 'waiting_user')
    assert.equal(stored.result.kind, 'clarification')
    assert.equal(stored.result.runtimeOperation, 'plan')
    assert.equal(fetchCalls.length, 1)
  })
})

test('SSE accepted 是 durable claim 后第一条业务事件；HTTP detach 不 abort Provider', { concurrency: false }, async () => {
  const gate = deferred()
  const fetchCalls = []
  const harness = createRouteHarness(chatBody)
  const chunks = []
  let acceptedSnapshot
  let request
  const response = Object.assign(createResponse(), {
    writeHead() {},
    flushHeaders() {},
    flush() {},
    write(chunk) {
      chunks.push(String(chunk))
      if (String(chunk).includes('"type":"accepted"')) {
        const event = JSON.parse(String(chunk).trim().slice('data: '.length))
        acceptedSnapshot = clone(harness.productStore.turns.get(event.turnId))
        this.destroyed = true
        request.aborted = true
        request.emit('aborted')
        this.emit('close')
      }
      return true
    },
    end() { this.writableEnded = true },
  })

  await withFakeFetch(async (_url, init) => {
    fetchCalls.push(init)
    await gate.promise
    return chatProviderResponse('断开观察者后仍完成。')
  }, async () => {
    request = createRequest({ 'idempotency-key': 'compat-chat-detach-0001' })
    await harness.handler(
      request,
      response,
      new URL('http://botanic.test/api/agent-chat/stream'),
      {},
      'request-chat-detach',
    )

    const dataEvents = chunks
      .flatMap((chunk) => chunk.split('\n'))
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)))
    assert.equal(dataEvents[0].type, 'accepted')
    assert.equal(acceptedSnapshot?.status, 'running')
    assert.equal(acceptedSnapshot?.request.runtimeOperation, 'chat')
    assert.equal(dataEvents.some((event) => event.type === 'done'), false)

    await waitFor(() => fetchCalls.length === 1, 'detach 后 Provider 未启动')
    assert.equal(fetchCalls[0].signal.aborted, false)
    gate.release()
    await waitFor(
      () => harness.productStore.turns.get(acceptedSnapshot.id)?.status === 'completed',
      'HTTP detach 后后台 Turn 未完成',
    )
    assert.equal(fetchCalls[0].signal.aborted, false)
  })
})

test('旧客户端无 key 的两次相同 plan POST 使用 requestId 创建两个 Turn', { concurrency: false }, async () => {
  const gate = deferred()
  const fetchCalls = []
  const harness = createRouteHarness(planBody)
  await withFakeFetch(async (_url, init) => {
    fetchCalls.push(init)
    await gate.promise
    return planProviderResponse()
  }, async () => {
    const headers = { prefer: 'respond-async' }
    const first = await harness.post('/api/agent-plans', { headers, requestId: 'legacy-plan-request-1' })
    const second = await harness.post('/api/agent-plans', { headers, requestId: 'legacy-plan-request-2' })

    assert.equal(first.json.status, 202)
    assert.equal(second.json.status, 202)
    assert.notEqual(first.json.body.runtimeTurn.id, second.json.body.runtimeTurn.id)
    assert.equal(harness.productStore.turns.size, 2)
    await waitFor(() => fetchCalls.length === 2, '两个无 key Turn 未分别调用 Provider')

    gate.release()
    await waitFor(
      () => [...harness.productStore.turns.values()].every((turn) => turn.status === 'completed'),
      '两个无 key Turn 未完成',
    )
  })
})

test('intent 兼容入口写入可供 Worker 恢复的 operation envelope', { concurrency: false }, async () => {
  const gate = deferred()
  const fetchCalls = []
  const harness = createRouteHarness(intentBody)
  await withFakeFetch(async (_url, init) => {
    fetchCalls.push(init)
    await gate.promise
    return chatProviderResponse('意图入口已进入统一 Runtime。')
  }, async () => {
    const result = await harness.post('/api/agent-intent', {
      headers: {
        prefer: 'respond-async',
        'idempotency-key': 'compat-intent-envelope-0001',
      },
      requestId: 'request-intent-envelope',
    })
    assert.equal(result.json.status, 202)
    const stored = harness.productStore.turns.get(result.json.body.runtimeTurn.id)
    assert.deepEqual(
      { runtimeOperation: stored.request.runtimeOperation, projectId: stored.request.input.projectId },
      { runtimeOperation: 'intent', projectId: projectDocument.id },
    )

    await waitFor(() => fetchCalls.length === 1, 'intent Provider 未启动')
    gate.release()
    await waitFor(
      () => harness.productStore.turns.get(stored.id)?.status === 'completed',
      'intent Turn 未完成',
    )
  })
})
