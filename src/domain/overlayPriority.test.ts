import test from 'node:test'
import assert from 'node:assert/strict'
import { topOverlayLayer } from './overlayPriority.ts'

test('账户浮层优先于 Agent 处理 Escape', () => {
  assert.equal(topOverlayLayer(['agent', 'account']), 'account')
})

test('预览与确认框优先于 Agent 处理 Escape', () => {
  assert.equal(topOverlayLayer(['agent', 'preview']), 'preview')
  assert.equal(topOverlayLayer(['agent', 'confirmation']), 'confirmation')
})

test('没有更高层浮层时由 Agent 处理 Escape', () => {
  assert.equal(topOverlayLayer(['agent']), 'agent')
  assert.equal(topOverlayLayer([]), null)
})
