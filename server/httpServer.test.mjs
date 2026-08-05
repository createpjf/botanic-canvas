import assert from 'node:assert/strict'
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

test('可注入 HTTP Server 无需启动生产运行时即可响应健康检查', async () => {
  const application = createBotanicHttpServer(testDependencies())
  const headers = {}
  const response = {
    statusCode: 0,
    body: '',
    setHeader(name, value) { headers[name] = value },
    writeHead(statusCode, nextHeaders) { this.statusCode = statusCode; Object.assign(headers, nextHeaders) },
    end(body = '') { this.body = String(body) },
  }
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
