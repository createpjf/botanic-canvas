import assert from 'node:assert/strict'
import test from 'node:test'
import { accountMenuPlacement } from './accountCenterPresentation.ts'

test('账户菜单在顶部入口下方展开并锚定入口', () => {
  const result = accountMenuPlacement(
    { left: 20, right: 84, top: 20, bottom: 84 },
    { width: 1280, height: 900 },
  )

  assert.equal(result.placement, 'below')
  assert.equal(result.left, 96)
  assert.equal(result.top, 96)
  assert.equal(result.originY, 0)
})

test('账户菜单在底部入口上方展开且不会越出视口', () => {
  const result = accountMenuPlacement(
    { left: 20, right: 84, top: 720, bottom: 784 },
    { width: 800, height: 800 },
  )

  assert.equal(result.placement, 'above')
  assert.equal(result.top, 354)
  assert.equal(result.originY, 430)
})

test('账户菜单在窄视口内保持安全边距', () => {
  const result = accountMenuPlacement(
    { left: 290, right: 330, top: 20, bottom: 60 },
    { width: 360, height: 700 },
    { width: 336, height: 430, gap: 12, margin: 12 },
  )

  assert.equal(result.left, 12)
  assert.ok(result.originX <= 312)
})
