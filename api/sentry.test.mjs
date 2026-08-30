import assert from 'node:assert/strict'
import test from 'node:test'
import { scrubBreadcrumb, scrubEvent } from './sentry.mjs'

test('Vercel Function Sentry 事件不携带身份、请求凭据或 URL 参数', () => {
  const event = scrubEvent({
    user: { id: 'user-1' },
    extra: { token: 'secret' },
    request: {
      method: 'GET',
      url: 'https://botanic.example/status?token=secret',
      headers: { authorization: 'Bearer secret' },
    },
    breadcrumbs: [
      { category: 'console', message: 'secret' },
      { category: 'http', data: { url: 'https://provider.example/?key=secret' } },
    ],
  })

  assert.equal(event.user, undefined)
  assert.equal(event.extra, undefined)
  assert.deepEqual(event.request, { method: 'GET', url: 'https://botanic.example/status' })
  assert.deepEqual(event.breadcrumbs, [{
    category: 'http',
    data: { url: 'https://provider.example/' },
  }])
  assert.equal(scrubBreadcrumb({ category: 'console' }), null)
})
