import assert from 'node:assert/strict'
import test from 'node:test'
import { loadStatusSnapshot, readStatusPageConfig } from './statusPage.ts'

test('未配置 JSON URL 时不发请求', async () => {
  let calls = 0
  const snapshot = await loadStatusSnapshot({
    jsonUrl: null,
    subscribeUrl: null,
    fetchImpl: async () => {
      calls += 1
      return new Response('{}')
    },
  })
  assert.equal(calls, 0)
  assert.equal(snapshot.loadState, 'unconfigured')
})

test('非 2xx 与非法 JSON 都是无法探测', async () => {
  const failed = await loadStatusSnapshot({
    jsonUrl: 'https://status.example.test/index.json',
    fetchImpl: async () => new Response('nope', { status: 503 }),
  })
  assert.equal(failed.loadState, 'unavailable')

  const invalid = await loadStatusSnapshot({
    jsonUrl: 'https://status.example.test/index.json',
    fetchImpl: async () => new Response('{', { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  assert.equal(invalid.loadState, 'unavailable')
})

test('超时视为无法探测', async () => {
  const snapshot = await loadStatusSnapshot({
    jsonUrl: 'https://status.example.test/index.json',
    timeoutMs: 20,
    fetchImpl: () => new Promise(() => {}),
  })
  assert.equal(snapshot.loadState, 'unavailable')
})

test('配置读取：override 优先，空字符串当未配置', () => {
  assert.deepEqual(readStatusPageConfig({
    VITE_STATUS_PAGE_JSON_URL: ' https://botanic.betteruptime.com/index.json ',
    VITE_STATUS_PAGE_SUBSCRIBE_URL: ' https://status.botanic.example ',
    VITE_UNRELATED: 'ignored',
  }), {
    jsonUrl: 'https://botanic.betteruptime.com/index.json',
    subscribeUrl: 'https://status.botanic.example',
  })
  assert.deepEqual(readStatusPageConfig({
    VITE_STATUS_PAGE_JSON_URL: '',
  }), { jsonUrl: null, subscribeUrl: null })
})
