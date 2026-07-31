import assert from 'node:assert/strict'
import test from 'node:test'
import { generationIdempotencyKey, generationJobIdForIdempotency } from './generationIdempotency.mjs'

test('同一用户与幂等键始终映射到同一生成任务', () => {
  const key = 'A2jF6rSaV9ZpQ3kM'
  assert.equal(generationIdempotencyKey(key), key)
  assert.equal(generationJobIdForIdempotency('owner-a', key), generationJobIdForIdempotency('owner-a', key))
  assert.notEqual(generationJobIdForIdempotency('owner-a', key), generationJobIdForIdempotency('owner-b', key))
})

test('无效幂等键被拒绝，不进入任务创建流程', () => {
  assert.equal(generationIdempotencyKey('short'), undefined)
  assert.equal(generationIdempotencyKey('../unsafe-key-value'), undefined)
})
