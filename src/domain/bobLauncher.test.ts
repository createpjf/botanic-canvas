import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BOB_LAUNCHER_CHROME,
  BOB_LAUNCHER_SIZE,
  bobLauncherDragCommitted,
  bobLauncherLookAt,
  bobLauncherPointerDistance,
  clampBobLauncherPoint,
  defaultBobLauncherPoint,
  parseBobLauncherPoint,
} from './bobLauncher.ts'

test('默认折叠 Bob 在右侧垂直居中，并避开顶栏与缩放条', () => {
  const point = defaultBobLauncherPoint({ width: 1440, height: 900 })

  assert.equal(point.x, 1440 - BOB_LAUNCHER_SIZE - BOB_LAUNCHER_CHROME.right)
  assert.equal(point.y, (900 - BOB_LAUNCHER_SIZE) / 2)
  assert.ok(point.y >= BOB_LAUNCHER_CHROME.top)
  assert.ok(point.y + BOB_LAUNCHER_SIZE <= 900 - BOB_LAUNCHER_CHROME.bottom)
})

test('折叠 Bob 不会压住顶栏、左侧 dock 或底部缩放条', () => {
  const point = clampBobLauncherPoint(
    { x: 0, y: 0 },
    { width: 1280, height: 800 },
  )

  assert.deepEqual(point, { x: BOB_LAUNCHER_CHROME.left, y: BOB_LAUNCHER_CHROME.top })

  const bottomRight = clampBobLauncherPoint(
    { x: 4000, y: 4000 },
    { width: 1280, height: 800 },
  )
  assert.equal(bottomRight.x, 1280 - BOB_LAUNCHER_SIZE - BOB_LAUNCHER_CHROME.right)
  assert.equal(bottomRight.y, 800 - BOB_LAUNCHER_SIZE - BOB_LAUNCHER_CHROME.bottom)
})

test('视口过窄时仍把 Bob 夹在可用矩形内', () => {
  const point = clampBobLauncherPoint(
    { x: 10, y: 10 },
    { width: 80, height: 90 },
  )

  assert.equal(point.x, BOB_LAUNCHER_CHROME.left)
  assert.equal(point.y, BOB_LAUNCHER_CHROME.top)
})

test('移动超过 6px 才算拖动，否则仍是点击', () => {
  assert.equal(bobLauncherDragCommitted(5.9), false)
  assert.equal(bobLauncherDragCommitted(6), true)
  assert.equal(bobLauncherPointerDistance({ x: 10, y: 10 }, { x: 14, y: 13 }), 5)
})

test('hover lookAt 把指针映射到相对中心的 -1..1', () => {
  const point = { x: 100, y: 100 }
  assert.deepEqual(bobLauncherLookAt(point, { x: 128, y: 128 }), { x: 0, y: 0 })
  assert.deepEqual(bobLauncherLookAt(point, { x: 156, y: 100 }), { x: 1, y: -1 })
  assert.deepEqual(bobLauncherLookAt(point, { x: 100, y: 200 }), { x: -1, y: 1 })
})

test('本机位置只接受有限数字，坏数据回落到默认', () => {
  assert.deepEqual(parseBobLauncherPoint({ x: 80, y: 120 }), { x: 80, y: 120 })
  assert.equal(parseBobLauncherPoint({ x: '80', y: 120 }), null)
  assert.equal(parseBobLauncherPoint(null), null)
})
