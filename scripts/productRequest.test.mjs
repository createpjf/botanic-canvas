import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { build } from 'esbuild'

// 通过真实 productRequest 边界测试，只替换网络和时钟；不连接账号或服务。
const bundle = await build({
  entryPoints: ['src/lib/productSession.ts'], bundle: true, write: false,
  format: 'cjs', platform: 'node', packages: 'external',
  define: { 'import.meta.env': JSON.stringify({ VITE_AUTH_PROVIDER: 'access-token' }) },
})
const compiled = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports)
const { productRequest } = compiled.exports

test('消息 API 已返回响应头但响应体挂起时，仍按请求截止时间失败', async (t) => {
  globalThis.window = { setTimeout: fn => setTimeout(fn, 20), clearTimeout }
  t.after(() => { delete globalThis.window })
  let body
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => new Response(new ReadableStream({
    start(controller) {
      body = controller
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true })
    },
  }), { headers: { 'Content-Type': 'application/json', 'X-Request-ID': 'body-timeout' } }))
  const caller = new AbortController()
  const pending = productRequest('/api/test/messages', { signal: caller.signal }).catch(error => error)
  const result = await Promise.race([pending, delay(80, 'still-waiting')])
  if (result === 'still-waiting') { caller.abort(); body.error(new Error('test cleanup')) }
  await pending
  assert.equal(result.code, 'REQUEST_TIMEOUT')
  assert.equal(result.requestId, 'body-timeout')
})

test('取消响应体读取保持 AbortError，不重放请求', async (t) => {
  globalThis.window = { setTimeout, clearTimeout }
  t.after(() => { delete globalThis.window })
  const caller = new AbortController()
  let ready
  const started = new Promise(resolve => { ready = resolve })
  const network = t.mock.method(globalThis, 'fetch', async (_url, { signal }) => new Response(new ReadableStream({
    start(controller) {
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true })
      ready()
    },
  }), { headers: { 'Content-Type': 'application/json' } }))
  const pending = productRequest('/api/test/messages', { signal: caller.signal })
  await started
  caller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(network.mock.callCount(), 1)
})

test('成功响应的非法 JSON 不重试；真实网关故障沿用有限重试并保留状态码', async (t) => {
  globalThis.window = { setTimeout: (fn, ms) => setTimeout(fn, ms >= 1000 ? ms : 0), clearTimeout }
  t.after(() => { delete globalThis.window })
  const network = t.mock.method(globalThis, 'fetch', async () => new Response('{broken', { headers: { 'Content-Type': 'application/json' } }))
  await assert.rejects(productRequest('/api/test/messages'), error => error.status === 200 && error.code === 'INVALID_API_RESPONSE')
  assert.equal(network.mock.callCount(), 1)
  network.mock.mockImplementation(async () => new Response('Bad gateway', { status: 502 }))
  await assert.rejects(productRequest('/api/test/messages'), error => error.status === 502 && error.code === 'WORKSPACE_UNAVAILABLE')
  assert.equal(network.mock.callCount(), 4)
  network.mock.mockImplementation(async () => { throw new TypeError('Failed to fetch') })
  await assert.rejects(productRequest('/api/test/write', { method: 'POST' }), error => error.code === 'NETWORK_ERROR')
  assert.equal(network.mock.callCount(), 5, '未带幂等键的写请求不能自动重放')
})
