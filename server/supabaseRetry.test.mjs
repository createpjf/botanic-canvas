import assert from 'node:assert/strict'
import test from 'node:test'
import { retrySupabaseOperation } from './supabaseRetry.mjs'

test('Supabase 超时按指数退避重试，并在恢复后返回结果', async () => {
  const delays = []
  let calls = 0
  const result = await retrySupabaseOperation(async () => {
    calls += 1
    if (calls < 3) {
      const error = new Error('timed out')
      error.code = 'WORKSPACE_STORE_TIMEOUT'
      throw error
    }
    return 'recovered'
  }, { sleep: async (delay) => delays.push(delay) })

  assert.equal(result, 'recovered')
  assert.equal(calls, 3)
  assert.deepEqual(delays, [250, 500])
})

test('Supabase 非可恢复错误不会重试', async () => {
  let calls = 0
  await assert.rejects(() => retrySupabaseOperation(async () => {
    calls += 1
    const error = new Error('permission denied')
    error.code = '42501'
    throw error
  }, { sleep: async () => undefined }), /permission denied/)
  assert.equal(calls, 1)
})
