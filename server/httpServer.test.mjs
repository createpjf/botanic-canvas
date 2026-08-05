import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createBotanicHttpServer } from './httpServer.mjs'

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
    agentRunEvents: { async publish() {}, async close() {} },
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
