import assert from 'node:assert/strict'
import { test } from 'node:test'
import { liquidIndeterminateTravel, liquidProgressBarDebugState } from './liquidProgressBarRuntime.ts'

test('LiquidProgressBar 运行时默认无订阅', () => {
  const state = liquidProgressBarDebugState()
  assert.equal(state.subscriberCount, 0)
  assert.equal(state.rafActive, false)
})

test('不定进度从左到右单向推进，不回扫、不伪造百分比', () => {
  const reduced = liquidIndeterminateTravel(1.2, true)
  assert.equal(reduced, 0.55)
  const a = liquidIndeterminateTravel(0, false)
  const b = liquidIndeterminateTravel(1.5, false)
  const c = liquidIndeterminateTravel(3.0, false)
  assert.ok(a >= 0.12 && a < 0.2)
  assert.ok(b > a)
  assert.ok(c > b)
  assert.ok(c <= 0.92)
})
