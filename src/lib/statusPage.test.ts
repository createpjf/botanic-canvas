import assert from 'node:assert/strict'
import test from 'node:test'
import { emptyStatusSnapshot } from '../domain/statusPage.ts'
import { loadStatusSnapshot, readStatusPageConfig } from './statusPage.ts'

const readySnapshot = {
  loadState: 'ready',
  fetchedAt: '2026-08-29T11:00:00.000Z',
  updatedAt: '2026-08-29T10:45:00.000Z',
  overall: 'operational',
  components: [{
    id: 'web',
    name: 'web',
    level: 'operational',
    hours24: [],
    days30: [],
    uptime24h: null,
    uptime30d: null,
  }],
  incidents: [],
  subscribeUrl: 'https://should-not-keep.example',
}

test('未配置 JSON URL 时不发请求', async () => {
  let calls = 0
  const snapshot = await loadStatusSnapshot({
    jsonUrl: null,
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
    jsonUrl: '/status.json',
    fetchImpl: async () => new Response('nope', { status: 503 }),
  })
  assert.equal(failed.loadState, 'unavailable')

  const invalid = await loadStatusSnapshot({
    jsonUrl: '/status.json',
    fetchImpl: async () => new Response('{', { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  assert.equal(invalid.loadState, 'unavailable')
})

test('超时视为无法探测', async () => {
  const snapshot = await loadStatusSnapshot({
    jsonUrl: '/status.json',
    timeoutMs: 20,
    fetchImpl: () => new Promise(() => {}),
  })
  assert.equal(snapshot.loadState, 'unavailable')
})

test('同源快照透传，丢掉订阅链接', async () => {
  const snapshot = await loadStatusSnapshot({
    jsonUrl: '/status.json',
    now: () => Date.parse('2026-08-29T12:00:00.000Z'),
    fetchImpl: async () => new Response(JSON.stringify(readySnapshot), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  })
  assert.equal(snapshot.loadState, 'ready')
  assert.equal(snapshot.overall, 'operational')
  assert.equal(snapshot.components[0]?.id, 'web')
  assert.equal(snapshot.updatedAt, '2026-08-29T10:45:00.000Z')
  assert.equal(snapshot.subscribeUrl, null)
})

test('配置读取：未设默认 /status.json，空字符串当未配置', () => {
  assert.deepEqual(readStatusPageConfig({}), {
    jsonUrl: '/status.json',
    subscribeUrl: null,
  })
  assert.deepEqual(readStatusPageConfig({
    VITE_STATUS_PAGE_JSON_URL: ' https://status.example.test/status.json ',
  }), {
    jsonUrl: 'https://status.example.test/status.json',
    subscribeUrl: null,
  })
  assert.deepEqual(readStatusPageConfig({
    VITE_STATUS_PAGE_JSON_URL: '',
  }), { jsonUrl: null, subscribeUrl: null })
})

test('空快照形状未变', () => {
  const snapshot = emptyStatusSnapshot('unavailable', '2026-08-29T12:00:00.000Z')
  assert.equal(snapshot.components.length, 0)
})
