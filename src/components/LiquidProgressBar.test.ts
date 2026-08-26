import assert from 'node:assert/strict'
import { test } from 'node:test'
import { liquidProgressBarDebugState } from './LiquidProgressBar.tsx'

test('LiquidProgressBar 导出调试态且默认无订阅', () => {
  const state = liquidProgressBarDebugState()
  assert.equal(state.subscriberCount, 0)
  assert.equal(state.rafActive, false)
})

test('LiquidProgressBar 模块不暴露业务百分比 API', async () => {
  const mod = await import('./LiquidProgressBar.tsx')
  assert.equal(typeof mod.LiquidProgressBar, 'function')
  assert.equal('progress' in mod.LiquidProgressBar, false)
  const propsKeys = Object.keys(mod)
  assert.ok(!propsKeys.includes('setProgress'))
})
