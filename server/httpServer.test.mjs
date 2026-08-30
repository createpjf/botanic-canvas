import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createBotanicHttpServer } from './httpServer.mjs'
import { agentActionReconciliationIdentity } from './agentActionReconciliation.mjs'

function testDependencies() {
  return {
    config: {
      port: 0,
      production: false,
      redisUrl: undefined,
      realtimeTicketSecret: 'test-realtime-secret',
      maximumBatchCount: 8,
      maximumReferenceBytes: 8 * 1024 * 1024,
      maximumRequestBytes: 32 * 1024 * 1024,
      maximumPromptRefinementRequestBytes: 64 * 1024,
      models: [],
      modelOptions: [],
      flockAgentModels: [],
      agentMcpTools: [],
      security: { apiRequestsPerMinute: 100 },
    },
    runtime: {
      productStore: {},
      mediaService: { enabled: false },
      persistence: 'test',
      authProvider: 'access-token',
    },
    redisQueue: undefined,
    agentRunEvents: { async publish() {}, async publishCollaborationActivity() {}, async close() {} },
    securityControls: {
      async consume() { return { allowed: true } },
      async close() {},
    },
    configuredMcpTools: {},
  }
}

function testResponse() {
  const headers = {}
  return {
    headers,
    response: {
      statusCode: 0,
      body: '',
      headersSent: false,
      setHeader(name, value) { headers[name] = value },
      writeHead(statusCode, nextHeaders) {
        if (this.headersSent) {
          const error = new Error('Cannot write headers after they are sent to the client')
          error.code = 'ERR_HTTP_HEADERS_SENT'
          throw error
        }
        this.headersSent = true
        this.statusCode = statusCode
        Object.assign(headers, nextHeaders)
      },
      end(body = '') { this.body = String(body) },
    },
  }
}

function testRequest({ method, url, body }) {
  return Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method,
    url,
    headers: { host: 'localhost', authorization: 'Bearer test-token' },
    socket: { encrypted: false, remoteAddress: '127.0.0.1' },
  })
}

function skillApplyAgentState() {
  return { sessions: [{
    id: 'session-action-http',
    messages: [{ id: 'message-action-http', plan: { actions: [{
      id: 'call-1',
      toolName: 'skill_apply',
      arguments: { skillId: 'skill-1' },
      status: 'running',
    }] } }],
  }] }
}

test('可注入 HTTP Server 无需启动生产运行时即可响应健康检查', async () => {
  const application = createBotanicHttpServer(testDependencies())
  const { headers, response } = testResponse()
  await application.handleRequest({
    method: 'GET',
    url: '/api/health',
    headers: { host: 'localhost' },
    socket: { encrypted: false },
  }, response)

  assert.equal(response.statusCode, 200)
  assert.equal(JSON.parse(response.body).status, 'ok')
  assert.equal(headers['Cache-Control'], 'no-store')
})

test('未预期的 API 5xx 会把原始异常和安全请求上下文交给错误上报', async () => {
  const dependencies = testDependencies()
  const original = new Error('database exploded')
  const reported = []
  dependencies.runtime.productStore = {
    async authenticate() { throw original },
  }
  dependencies.reportError = (...input) => reported.push(input)
  const application = createBotanicHttpServer(dependencies)
  const { response } = testResponse()

  await application.handleRequest(testRequest({ method: 'GET', url: '/api/projects' }), response)

  assert.equal(response.statusCode, 500)
  assert.equal(reported.length, 1)
  assert.equal(reported[0][0], original)
  assert.equal(reported[0][1].tags.component, 'api')
  assert.equal(reported[0][1].tags.error_code, 'INTERNAL_ERROR')
  assert.equal(typeof reported[0][1].contexts.request.id, 'string')
})

test('HTTP 启动恢复使用有界 Generation keyset sweep，单个 poison Job 不阻塞同页任务', async () => {
  const dependencies = testDependencies()
  const listed = []
  const enqueued = []
  dependencies.runtime.productStore = {
    async listRecoverableGenerationJobs(input) {
      listed.push(structuredClone(input))
      return [
        { id: 'job-poison', updatedAt: 10 },
        { id: 'job-ok', updatedAt: 20 },
      ]
    },
  }
  dependencies.runtime.mediaService.close = async () => {}
  dependencies.redisQueue = {
    async enqueue(jobId) {
      if (jobId === 'job-poison') throw new Error('poison enqueue')
      enqueued.push(jobId)
    },
    async close() {},
  }
  const application = createBotanicHttpServer(dependencies)
  application.server.listen = (_port, _host, onListening) => {
    onListening()
    return application.server
  }
  const originalConsoleError = console.error
  const errors = []
  console.error = (...args) => { errors.push(args.map(String).join(' ')) }
  try {
    await application.start()
    assert.deepEqual(listed, [{ after: null, limit: 25 }])
    assert.deepEqual(enqueued, ['job-ok'])
    assert.ok(errors.some((line) => /generation\.recovery\.enqueue\.failed/u.test(line)))
  } finally {
    console.error = originalConsoleError
    await application.close()
  }
})

test('会话资源对不支持的方法返回 405 和允许的方法目录', async () => {
  const application = createBotanicHttpServer(testDependencies())
  const { headers, response } = testResponse()

  await application.handleRequest({
    method: 'PUT',
    url: '/api/session',
    headers: { host: 'localhost' },
    socket: { encrypted: false },
  }, response)

  assert.equal(response.statusCode, 405)
  assert.equal(JSON.parse(response.body).error.code, 'METHOD_NOT_ALLOWED')
  assert.equal(headers.Allow, 'GET, POST, DELETE')
})

test('项目集合资源对不支持的方法返回 405 和允许的方法目录', async () => {
  const application = createBotanicHttpServer(testDependencies())
  const { headers, response } = testResponse()

  await application.handleRequest({
    method: 'PUT',
    url: '/api/projects',
    headers: { host: 'localhost' },
    socket: { encrypted: false },
  }, response)

  assert.equal(response.statusCode, 405)
  assert.equal(JSON.parse(response.body).error.code, 'METHOD_NOT_ALLOWED')
  assert.equal(headers.Allow, 'GET, POST')
})

test('项目路由返回业务错误后不会继续写第二次响应', async () => {
  const dependencies = testDependencies()
  dependencies.runtime.productStore = {
    async authenticate() { return { id: 'user-1' } },
  }
  const application = createBotanicHttpServer(dependencies)
  const { response } = testResponse()

  await application.handleRequest(testRequest({
    method: 'POST',
    url: '/api/projects',
    body: {},
  }), response)

  assert.equal(response.statusCode, 400)
  assert.equal(JSON.parse(response.body).error.code, 'INVALID_DOCUMENT')
})

test('Project 文档写入区分 5xx、权限、校验与冲突', async (context) => {
  const run = async ({ method = 'PUT', failure, body = { id: 'project-1', name: 'Demo' } }) => {
    const dependencies = testDependencies()
    const reported = []
    dependencies.reportError = (...input) => reported.push(input)
    dependencies.runtime.mediaService = {
      async normalizeDocument(document) { return document },
    }
    dependencies.runtime.productStore = {
      async authenticate() { return { id: 'user-1' } },
      async projectAccess() { return { exists: true, role: 'owner' } },
      async readProject() { return { revision: 1, graphRevision: 1, document: { id: 'project-1', name: 'Demo', nodes: [], edges: [] } } },
      async writeProject() { throw failure },
    }
    const application = createBotanicHttpServer(dependencies)
    const { response } = testResponse()
    await application.handleRequest(testRequest({
      method,
      url: '/api/projects/project-1/document',
      body,
    }), response)
    return { response, reported }
  }

  await context.test('通用 Store Error 是 500 并上报安全错误码', async () => {
    const original = new Error('database exploded')
    const { response, reported } = await run({ failure: original })
    assert.equal(response.statusCode, 500)
    assert.equal(JSON.parse(response.body).error.code, 'INTERNAL_ERROR')
    assert.equal(reported[0]?.[0], original)
    assert.equal(reported[0]?.[1]?.tags?.error_code, 'INTERNAL_ERROR')
  })

  await context.test('明确权限错误是 403', async () => {
    const failure = Object.assign(new Error('forbidden'), { code: 'PROJECT_WRITE_FORBIDDEN' })
    const { response } = await run({ failure })
    assert.equal(response.statusCode, 403)
    assert.equal(JSON.parse(response.body).error.code, 'PROJECT_WRITE_FORBIDDEN')
  })

  await context.test('补丁 TypeError 是 400', async () => {
    const { response } = await run({ method: 'PATCH', failure: new Error('unused'), body: { fields: { id: 'forbidden' } } })
    assert.equal(response.statusCode, 400)
    assert.equal(JSON.parse(response.body).error.code, 'INVALID_DOCUMENT_PATCH')
  })

  await context.test('版本冲突是 409', async () => {
    const failure = Object.assign(new Error('conflict'), { code: 'PROJECT_CONFLICT' })
    const { response } = await run({ failure })
    assert.equal(response.statusCode, 409)
    assert.equal(JSON.parse(response.body).error.code, 'PROJECT_CONFLICT')
  })
})

test('旧版整文档 PUT 不能覆盖生产工作流权威状态', async () => {
  const dependencies = testDependencies()
  let written
  dependencies.runtime.mediaService = {
    async normalizeDocument(document) { return document },
  }
  dependencies.runtime.productStore = {
    async authenticate() { return { id: 'user-1' } },
    async projectAccess() { return { exists: true, role: 'owner' } },
    async readProject() {
      return {
        revision: 3,
        graphRevision: 2,
        document: {
          id: 'project-1', name: 'Demo', nodes: [], edges: [],
          productionWorkflows: [{ id: 'workflow-1' }],
          productionWorkflowRuns: [{ id: 'run-1' }],
        },
      }
    },
    async writeProject(_userId, document) {
      written = document
      return { created: false, revision: 4, graphRevision: 2, document }
    },
  }
  const application = createBotanicHttpServer(dependencies)
  const { response } = testResponse()
  await application.handleRequest(testRequest({
    method: 'PUT',
    url: '/api/projects/project-1/document',
    body: {
      id: 'project-1', name: 'Demo', nodes: [], edges: [],
      productionWorkflows: [], productionWorkflowRuns: [],
    },
  }), response)

  assert.equal(response.statusCode, 200)
  assert.deepEqual(written.productionWorkflows, [{ id: 'workflow-1' }])
  assert.deepEqual(written.productionWorkflowRuns, [{ id: 'run-1' }])
})

test('Agent 行动执行中冲突经过统一 HTTP 层保留 409 与业务码', async () => {
  const dependencies = testDependencies()
  dependencies.runtime.productStore = {
    async authenticate() { return { id: 'user-1' } },
    async projectAccess() { return { exists: true, role: 'owner' } },
    async readAgentState() { return skillApplyAgentState() },
    async readAgentActionReceipt() { return undefined },
    async claimAgentActionReceipt() { return { kind: 'in_progress', receipt: { status: 'running' } } },
    async settleAgentActionReceipt() { throw new Error('不应结算未取得租约的行动') },
  }
  const application = createBotanicHttpServer(dependencies)
  const { response } = testResponse()

  const request = testRequest({
    method: 'POST',
    url: '/api/agent-actions',
    body: {
      projectId: 'project-1',
      name: 'skill_apply',
      toolCallId: 'call-1',
      confirmed: true,
      arguments: { skillId: 'skill-1' },
    },
  })
  request.headers['idempotency-key'] = 'agent-action-call-1-skill_apply'
  await application.handleRequest(request, response)

  assert.equal(response.statusCode, 409)
  assert.equal(JSON.parse(response.body).error.code, 'AGENT_ACTION_IN_PROGRESS')
})

test('Agent 行动调和错误经过统一 HTTP 层保留状态码与业务码', async () => {
  const action = {
    id: 'action-http-reconciliation',
    toolName: 'skill_apply',
    arguments: { skillId: 'controlled_edit' },
    status: 'running',
  }
  const dependencies = testDependencies()
  dependencies.runtime.productStore = {
    async authenticate() { return { id: 'user-1' } },
    async projectAccess() { return { exists: true, role: 'owner' } },
    async readAgentState() {
      return { sessions: [{ id: 'session-1', messages: [{ id: 'message-1', plan: { actions: [action] } }] }] }
    },
    async readAgentActionReceipt() { return undefined },
    async resolveAgentActionReceipt() { throw new Error('不应写入') },
    async consumeAgentActionManualRetryAuthorization() { throw new Error('不应消费') },
  }
  const application = createBotanicHttpServer(dependencies)
  const { response } = testResponse()
  const request = testRequest({
    method: 'POST',
    url: '/api/agent-actions/status',
    body: {
      projectId: 'project-1',
      sessionId: 'session-1',
      messageId: 'message-1',
      actionId: action.id,
      name: action.toolName,
      toolCallId: action.id,
      arguments: action.arguments,
    },
  })
  request.headers['idempotency-key'] = `agent-action-${action.id}-${action.toolName}`

  await application.handleRequest(request, response)

  assert.equal(response.statusCode, 404)
  assert.equal(JSON.parse(response.body).error.code, 'AGENT_ACTION_RECONCILIATION_NOT_FOUND')
})

test('Action Adapter 的缺 RPC、权限与 invalid 调和错误不得降成 INTERNAL_ERROR', async (context) => {
  const action = {
    id: 'action-http-adapter-error',
    toolName: 'skill_apply',
    arguments: { skillId: 'controlled_edit' },
    status: 'uncertain',
  }
  const requestBody = {
    projectId: 'project-1',
    sessionId: 'session-adapter-error',
    messageId: 'message-adapter-error',
    actionId: action.id,
    name: action.toolName,
    toolCallId: action.id,
    arguments: action.arguments,
    decision: 'confirmed_applied',
  }
  const idempotencyKey = `agent-action-${action.id}-${action.toolName}`
  const identity = agentActionReconciliationIdentity({
    userId: 'user-1',
    ...requestBody,
    idempotencyKey,
  })
  const receipt = {
    id: identity.receiptId,
    ownerId: 'user-1',
    projectId: requestBody.projectId,
    toolCallId: action.id,
    actionName: action.toolName,
    intentHash: identity.intentHash,
    actionBindingHash: identity.actionBindingHash,
    replayPolicy: 'never',
    status: 'uncertain',
    createdAt: 1,
    updatedAt: 1,
  }
  const scenarios = [
    ['AGENT_ACTION_RECONCILIATION_REQUIRED', 503],
    ['PROJECT_WRITE_FORBIDDEN', 403],
    ['AGENT_ACTION_RECONCILIATION_INVALID', 422],
  ]

  await context.test('缺少原子 reconciliation RPC', async () => {
    const dependencies = testDependencies()
    dependencies.runtime.productStore = {
      async authenticate() { return { id: 'user-1' } },
      async projectAccess() { return { exists: true, role: 'owner' } },
      async readAgentState() {
        return { sessions: [{
          id: requestBody.sessionId,
          messages: [{ id: requestBody.messageId, plan: { actions: [action] } }],
        }] }
      },
      async readAgentActionReceipt() { return structuredClone(receipt) },
      async consumeAgentActionManualRetryAuthorization() { throw new Error('不应消费') },
    }
    const application = createBotanicHttpServer(dependencies)
    const { response } = testResponse()
    const request = testRequest({ method: 'POST', url: '/api/agent-actions/resolve', body: requestBody })
    request.headers['idempotency-key'] = idempotencyKey

    await application.handleRequest(request, response)

    assert.equal(response.statusCode, 503)
    assert.equal(JSON.parse(response.body).error.code, 'AGENT_ACTION_RECONCILIATION_REQUIRED')
  })

  for (const [adapterCode, expectedStatus] of scenarios) {
    await context.test(String(adapterCode), async () => {
      const dependencies = testDependencies()
      dependencies.runtime.productStore = {
        async authenticate() { return { id: 'user-1' } },
        async projectAccess() { return { exists: true, role: 'owner' } },
        async readAgentState() {
          return { sessions: [{
            id: requestBody.sessionId,
            messages: [{ id: requestBody.messageId, plan: { actions: [action] } }],
          }] }
        },
        async readAgentActionReceipt() { return structuredClone(receipt) },
        async resolveAgentActionReceipt() {
          throw Object.assign(new Error('adapter failure'), { code: adapterCode })
        },
        async consumeAgentActionManualRetryAuthorization() { throw new Error('不应消费') },
      }
      const application = createBotanicHttpServer(dependencies)
      const { response } = testResponse()
      const request = testRequest({ method: 'POST', url: '/api/agent-actions/resolve', body: requestBody })
      request.headers['idempotency-key'] = idempotencyKey

      await application.handleRequest(request, response)

      assert.equal(response.statusCode, expectedStatus)
      assert.equal(JSON.parse(response.body).error.code, adapterCode)
    })
  }
})

test('Turn delegation cancel fence 经过统一 HTTP 层保留 409 与业务码', async () => {
  const dependencies = testDependencies()
  dependencies.runtime.productStore = {
    async authenticate() { return { id: 'user-1' } },
    async projectAccess() { return { exists: true, role: 'owner' } },
    async readAgentTurn() {
      return { id: 'turn-cancelled', ownerId: 'user-1', projectId: 'project-1', status: 'cancelling' }
    },
  }
  const application = createBotanicHttpServer(dependencies)
  const { response } = testResponse()
  const request = testRequest({
    method: 'POST',
    url: '/api/agent-runs',
    body: {
      projectId: 'project-1',
      turnId: 'turn-cancelled',
      plan: {
        intent: 'initial_generation', instruction: '生成首图', summary: '首图', prompt: '自然光首图',
        settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
        constraints: [], output: { mode: 'single', count: 1, candidatesPerItem: 1 },
        contextSnapshot: [{ nodeId: 'asset-1', label: '商品', kind: '素材', mediaKind: 'image' }],
      },
      branches: [{ id: 'branch-1', label: '首图' }],
    },
  })
  request.headers['idempotency-key'] = 'cancelled-turn-run'

  await application.handleRequest(request, response)

  assert.equal(response.statusCode, 409)
  assert.equal(JSON.parse(response.body).error.code, 'AGENT_TURN_DELEGATION_CANCELLED')
})

test('Agent 行动无法取得执行权时统一 HTTP 层保留 503 与业务码', async () => {
  const dependencies = testDependencies()
  dependencies.runtime.productStore = {
    async authenticate() { return { id: 'user-1' } },
    async projectAccess() { return { exists: true, role: 'owner' } },
    async readAgentState() { return skillApplyAgentState() },
    async readAgentActionReceipt() { return undefined },
    async claimAgentActionReceipt() { return undefined },
    async settleAgentActionReceipt() { throw new Error('不应结算未取得租约的行动') },
  }
  const application = createBotanicHttpServer(dependencies)
  const { response } = testResponse()
  const request = testRequest({
    method: 'POST',
    url: '/api/agent-actions',
    body: {
      projectId: 'project-1',
      name: 'skill_apply',
      toolCallId: 'call-1',
      confirmed: true,
      arguments: { skillId: 'skill-1' },
    },
  })
  request.headers['idempotency-key'] = 'agent-action-call-1-skill_apply'

  await application.handleRequest(request, response)

  assert.equal(response.statusCode, 503)
  assert.equal(JSON.parse(response.body).error.code, 'AGENT_ACTION_CLAIM_FAILED')
})

test('Agent 行动执行超时时统一 HTTP 层保留 504 与业务码', async () => {
  const dependencies = testDependencies()
  dependencies.config.agentActionTimeoutMs = 5
  dependencies.runtime.productStore = {
    async authenticate() { return { id: 'user-1' } },
    async projectAccess() { return { exists: true, role: 'owner' } },
    async readAgentState() { return skillApplyAgentState() },
    async readAgentActionReceipt() { return undefined },
    async claimAgentActionReceipt(_userId, claim) {
      return { kind: 'claimed', receipt: { ...claim, status: 'running' } }
    },
    async settleAgentActionReceipt(_userId, settlement) { return settlement },
    async listAgentSkills() { return new Promise(() => {}) },
  }
  const application = createBotanicHttpServer(dependencies)
  const { response } = testResponse()
  const request = testRequest({
    method: 'POST',
    url: '/api/agent-actions',
    body: {
      projectId: 'project-1',
      name: 'skill_apply',
      toolCallId: 'call-1',
      confirmed: true,
      arguments: { skillId: 'skill-1' },
    },
  })
  request.headers['idempotency-key'] = 'agent-action-call-1-skill_apply'

  await application.handleRequest(request, response)

  assert.equal(response.statusCode, 504)
  assert.equal(JSON.parse(response.body).error.code, 'AGENT_ACTION_TIMEOUT')
})

test('生成任务集合资源对不支持的方法返回 405 和允许的方法目录', async () => {
  const application = createBotanicHttpServer(testDependencies())
  const { headers, response } = testResponse()

  await application.handleRequest({
    method: 'GET',
    url: '/api/generation-jobs',
    headers: { host: 'localhost' },
    socket: { encrypted: false },
  }, response)

  assert.equal(response.statusCode, 405)
  assert.equal(JSON.parse(response.body).error.code, 'METHOD_NOT_ALLOWED')
  assert.equal(headers.Allow, 'POST')
})

for (const route of [
  { name: '工作区成员', method: 'PUT', url: '/api/users', allow: 'GET, POST' },
  { name: '品牌素材库', method: 'POST', url: '/api/global-assets', allow: 'GET, PUT' },
  { name: 'Agent 规划', method: 'GET', url: '/api/agent-plans', allow: 'POST' },
  { name: 'Agent 意图', method: 'GET', url: '/api/agent-intent', allow: 'POST' },
  { name: 'Agent 结果评审', method: 'GET', url: '/api/agent-run-reviews', allow: 'POST' },
  { name: '提示词润色', method: 'GET', url: '/api/prompt-refinements', allow: 'POST' },
  { name: '项目媒体上传', method: 'GET', url: '/api/projects/project-a/media', allow: 'POST' },
  { name: '实时票据', method: 'GET', url: '/api/realtime/ticket', allow: 'POST' },
]) {
  test(`${route.name}资源对不支持的方法返回 405`, async () => {
    const application = createBotanicHttpServer(testDependencies())
    const { headers, response } = testResponse()

    await application.handleRequest({
      method: route.method,
      url: route.url,
      headers: { host: 'localhost' },
      socket: { encrypted: false },
    }, response)

    assert.equal(response.statusCode, 405)
    assert.equal(JSON.parse(response.body).error.code, 'METHOD_NOT_ALLOWED')
    assert.equal(headers.Allow, route.allow)
  })
}
