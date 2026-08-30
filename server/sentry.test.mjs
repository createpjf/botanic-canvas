import assert from 'node:assert/strict'
import test from 'node:test'
import { scrubSentryBreadcrumb, scrubSentryEvent } from './sentry.mjs'

test('服务端 Sentry 事件不携带身份、请求凭据、请求体或 console 面包屑', () => {
  const event = scrubSentryEvent({
    user: { id: 'user-1', ip_address: '127.0.0.1' },
    extra: { prompt: 'private prompt' },
    request: {
      method: 'POST',
      url: 'https://api.example.com/api/agent-turns?token=secret',
      headers: { authorization: 'Bearer secret' },
      cookies: { session: 'secret' },
      data: { prompt: 'private prompt' },
    },
    breadcrumbs: [
      { category: 'console', message: 'private provider response' },
      { category: 'http', data: { url: 'https://provider.example/v1?key=secret', method: 'POST' } },
    ],
  })

  assert.equal(event.user, undefined)
  assert.equal(event.extra, undefined)
  assert.deepEqual(event.request, { method: 'POST', url: 'https://api.example.com/api/agent-turns' })
  assert.deepEqual(event.breadcrumbs, [{
    category: 'http',
    data: { url: 'https://provider.example/v1', method: 'POST' },
  }])
  assert.equal(scrubSentryBreadcrumb({ category: 'console' }), null)
})
