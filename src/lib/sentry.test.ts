import assert from 'node:assert/strict'
import test from 'node:test'
import { isModuleLoadError, scrubSentryBreadcrumb, scrubSentryEvent } from './sentry.ts'

test('浏览器 Sentry 事件不携带身份、请求参数、额外数据或 console 面包屑', () => {
  const event = scrubSentryEvent({
    user: { id: 'user-1', email: 'owner@example.com' },
    extra: { prompt: 'private prompt' },
    message: 'provider https://provider.example/private?token=secret Bearer abcdefghijklmnopqrst',
    exception: { values: [{ type: 'Error', value: 'data:image/png;base64,privatecontent' }] },
    request: {
      method: 'GET',
      url: 'https://botanic.example/auth/callback?code=secret#workspace',
      headers: { authorization: 'Bearer secret' },
      data: 'private body',
    },
    breadcrumbs: [
      { category: 'console', message: 'private prompt' },
      { category: 'fetch', data: { url: '/api/projects?access_token=secret', method: 'GET' } },
    ],
  })

  assert.equal(event.user, undefined)
  assert.equal(event.extra, undefined)
  assert.equal(event.message, 'provider [redacted-url] [redacted-token]')
  assert.equal(event.exception?.values?.[0]?.value, '[redacted-inline-media]')
  assert.deepEqual(event.request, { method: 'GET', url: 'https://botanic.example/auth/callback' })
  assert.deepEqual(event.breadcrumbs, [{
    category: 'fetch',
    data: { url: '/api/projects', method: 'GET' },
  }])
  assert.equal(scrubSentryBreadcrumb({ category: 'console' }), null)
})

test('浏览器中断与断网不上报 Sentry', () => {
  assert.equal(scrubSentryEvent({
    exception: { values: [{ type: 'AbortError', value: 'signal is aborted without reason' }] },
  }), null)
  assert.equal(scrubSentryEvent({
    exception: { values: [{ type: 'TypeError', value: 'Failed to fetch' }] },
  }), null)
})

test('模块加载失败保留错误事件，不被普通断网过滤规则吞掉', () => {
  const message = 'Failed to fetch dynamically imported module: https://example.com/assets/panel.js?secret=private'
  assert.equal(isModuleLoadError(message), true)
  assert.equal(isModuleLoadError('Cannot read properties of undefined'), false)
  const event = scrubSentryEvent({ exception: { values: [{ type: 'TypeError', value: message }] } })
  assert.equal(event?.exception?.values?.[0]?.value, 'Failed to fetch dynamically imported module: [redacted-url]')
})
