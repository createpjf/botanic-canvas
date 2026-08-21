import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  botanicMotion,
  captureFlipState,
  clamp01,
  composeMotionValue,
  isFollowingLatest,
  mapPointerShift,
  motionDuration,
  normalizePointerAxis,
  playSurfaceFlip,
  prefersReducedMotion,
  readScrollDestination,
  remainingScroll,
  sendArrowPath,
  sendStopPath,
  snapPixel,
} from './gsapMotion.ts'

test('跟随最新消息的阈值用剩余滚动距离判断', () => {
  assert.equal(remainingScroll({ scrollHeight: 800, scrollTop: 680, clientHeight: 100 }), 20)
  assert.equal(isFollowingLatest({ scrollHeight: 800, scrollTop: 680, clientHeight: 100 }), true)
  assert.equal(isFollowingLatest({ scrollHeight: 800, scrollTop: 400, clientHeight: 100 }), false)
  assert.equal(isFollowingLatest({ scrollHeight: 800, scrollTop: 700, clientHeight: 100 }, 50), true)
})

test('滚动落点按 start/center/end 计算，不读 DOM', () => {
  const base = {
    scrollTop: 200,
    clientHeight: 400,
    scrollHeight: 1200,
    scrollerTop: 80,
    targetTop: 280,
    targetHeight: 80,
  }
  assert.equal(readScrollDestination({ ...base, block: 'start' }), 400)
  assert.equal(readScrollDestination({ ...base, block: 'center' }), 240)
  assert.equal(readScrollDestination({ ...base, block: 'end' }), 800)
  assert.equal(readScrollDestination({ ...base, block: 'end', offsetY: 40 }), 760)
})

test('utils 把指针进度夹紧、映射并吸附到整像素', () => {
  assert.equal(clamp01(1.4), 1)
  assert.equal(clamp01(-0.2), 0)
  assert.equal(mapPointerShift(0.5, -8, 8), 0)
  assert.equal(mapPointerShift(2, -8, 8), 8)
  assert.equal(normalizePointerAxis(100, 200, 150), 0.5)
  assert.equal(snapPixel(12.4), 12)
  const shift = composeMotionValue(clamp01, (value) => mapPointerShift(value, -6, 6))
  assert.equal(shift(0.5), 0)
  assert.equal(shift(3), 6)
})

test('工具面板 Flip 在没有根节点时不取状态', () => {
  assert.equal(captureFlipState(null), null)
  assert.equal(playSurfaceFlip(null, null), undefined)
})

test('发送/停止 path 是可变形的填充图形，reduced-motion 把时长归零', () => {
  assert.match(sendArrowPath, /^M/)
  assert.match(sendStopPath, /^M/)
  assert.notEqual(sendArrowPath, sendStopPath)
  assert.equal(botanicMotion.followLatestPx, 96)
  assert.equal(prefersReducedMotion(), false)
  assert.equal(motionDuration(0.28), 0.28)
})
