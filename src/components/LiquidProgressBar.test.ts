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
  assert.equal(reduced, 0.42)
  const a = liquidIndeterminateTravel(0, false)
  const b = liquidIndeterminateTravel(1.2, false)
  assert.ok(a >= 0.12 && a <= 0.78)
  assert.ok(b >= 0.12 && b <= 0.78)
  assert.notEqual(a, b)
  // 起点靠近左侧，体现从左到右
  assert.ok(a < 0.25)
})
