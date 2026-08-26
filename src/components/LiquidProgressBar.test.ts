import assert from 'node:assert/strict'
import { test } from 'node:test'
import { liquidIndeterminateTravel, liquidProgressBarDebugState } from './liquidProgressBarRuntime.ts'

test('LiquidProgressBar 运行时默认无订阅', () => {
  const state = liquidProgressBarDebugState()
  assert.equal(state.subscriberCount, 0)
  assert.equal(state.rafActive, false)
})

test('不定进度从左到右推进，不输出业务百分比语义', () => {
  const reduced = liquidIndeterminateTravel(1.2, true)
  assert.equal(reduced, 0.55)
  const a = liquidIndeterminateTravel(0, false)
  const b = liquidIndeterminateTravel(1.4, false)
  assert.ok(a >= 0.18 && a <= 0.82)
  assert.ok(b >= 0.18 && b <= 0.82)
  assert.notEqual(a, b)
  assert.ok(a < 0.3)
})
