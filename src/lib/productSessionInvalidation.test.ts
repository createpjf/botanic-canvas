import assert from 'node:assert/strict'
import test from 'node:test'
import {
  invalidateProductSessionIfRequired,
  productSessionInvalidationMessage,
  subscribeProductSessionInvalidated,
} from './productSessionInvalidation.ts'

test('AUTH_REQUIRED invalidates the active product session', () => {
  const notifications: string[] = []
  const unsubscribe = subscribeProductSessionInvalidated((message) => notifications.push(message))
  try {
    assert.equal(invalidateProductSessionIfRequired({ status: 401, code: 'AUTH_REQUIRED' }), true)
    assert.deepEqual(notifications, [productSessionInvalidationMessage])
  } finally {
    unsubscribe()
  }
})

test('unrelated API failures keep the current product session', () => {
  const notifications: string[] = []
  const unsubscribe = subscribeProductSessionInvalidated((message) => notifications.push(message))
  try {
    assert.equal(invalidateProductSessionIfRequired({ status: 503, code: 'WORKSPACE_STORE_TIMEOUT' }), false)
    assert.equal(invalidateProductSessionIfRequired({ status: 403, code: 'PROJECT_WRITE_FORBIDDEN' }), false)
    assert.deepEqual(notifications, [])
  } finally {
    unsubscribe()
  }
})
