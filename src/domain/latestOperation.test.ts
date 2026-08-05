import assert from 'node:assert/strict'
import test from 'node:test'
import { createLatestOperation } from './latestOperation.ts'

test('较新的异步操作会使旧操作失效', () => {
  const operation = createLatestOperation()
  const first = operation.begin()
  const second = operation.begin()

  assert.equal(operation.isCurrent(first), false)
  assert.equal(operation.isCurrent(second), true)
})

test('切换项目时可以一次性使当前操作失效', () => {
  const operation = createLatestOperation()
  const current = operation.begin()

  operation.invalidate()

  assert.equal(operation.isCurrent(current), false)
})
