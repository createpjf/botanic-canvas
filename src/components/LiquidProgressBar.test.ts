import assert from 'node:assert/strict'
import { test } from 'node:test'
import { liquidIndeterminateTravel, liquidProgressBarDebugState } from './liquidProgressBarRuntime.ts'

test('LiquidProgressBar 运行时默认无订阅', () => {
  const state = liquidProgressBarDebugState()
  assert.equal(state.subscriberCount, 0)
  assert.equal(state.rafActive, false)
})

test('不定进度 travel 不输出业务百分比语义，reduced-motion 为静态中位', () => {
  const reduced = liquidIndeterminateTravel(1.2, true)
  assert.equal(reduced, 0.58)
  const a = liquidIndeterminateTravel(0, false)
  const b = liquidIndeterminateTravel(1.8, false)
  assert.ok(a > 0.35 && a < 0.8)
  assert.ok(b > 0.35 && b < 0.8)
  assert.notEqual(a, b)
})
