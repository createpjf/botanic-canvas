import assert from 'node:assert/strict'
import test from 'node:test'
import { clampRegionRect, describeRegionRect, regionRectFromPoints } from './regionMask.ts'

test('选区夹取：越界回到画面内，误触级别的小选区不成立', () => {
  assert.deepEqual(clampRegionRect({ x: -0.2, y: 0.5, width: 0.6, height: 0.8 }), { x: 0, y: 0.5, width: 0.6, height: 0.5 })
  assert.equal(clampRegionRect({ x: 0.5, y: 0.5, width: 0.01, height: 0.4 }), null)
  assert.equal(clampRegionRect({ x: Number.NaN, y: 0, width: 1, height: 1 }), null)
})

test('拖拽两点转选区：方向无关，反向拖拽同样成立', () => {
  assert.deepEqual(
    regionRectFromPoints({ x: 0.8, y: 0.6 }, { x: 0.2, y: 0.1 }),
    { x: 0.2, y: 0.1, width: 0.6000000000000001, height: 0.5 },
  )
})

test('选区中文描述：位置分带、面积分档，几乎全图按整体处理', () => {
  assert.equal(describeRegionRect({ x: 0, y: 0, width: 1, height: 1 }), '整个画面')
  assert.match(describeRegionRect({ x: 0.7, y: 0, width: 0.25, height: 0.25 }), /上右.*小块区域/)
  assert.match(describeRegionRect({ x: 0.35, y: 0.4, width: 0.3, height: 0.3 }), /画面中部/)
  assert.match(describeRegionRect({ x: 0, y: 0.6, width: 0.6, height: 0.4 }), /区域/)
})

test('英文选区描述不泄漏中文位置标签', () => {
  const description = describeRegionRect({ x: 0.7, y: 0, width: 0.25, height: 0.25 }, 'en')
  assert.match(description, /small upper-right area/)
  assert.doesNotMatch(description, /[一-龥]/)
})
