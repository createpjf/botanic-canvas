import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildRegionMaskPng,
  imagePixelSize,
  normalizeRegionRect,
  regionMaskAlphaAt,
} from './regionMaskPng.mjs'

test('选区归一化：越界被夹取、过小与非法输入返回 null', () => {
  assert.deepEqual(normalizeRegionRect({ x: -0.2, y: 0.5, width: 0.6, height: 0.8 }), { x: 0, y: 0.5, width: 0.6, height: 0.5 })
  assert.equal(normalizeRegionRect({ x: 0.5, y: 0.5, width: 0.01, height: 0.4 }), null)
  assert.equal(normalizeRegionRect({ x: Number.NaN, y: 0, width: 1, height: 1 }), null)
  assert.equal(normalizeRegionRect(undefined), null)
})

test('生成的蒙版与基准图同尺寸：选区内透明、选区外不透明', () => {
  const png = buildRegionMaskPng({ width: 10, height: 8 }, { x: 0.5, y: 0.5, width: 0.5, height: 0.5 })
  assert.deepEqual(imagePixelSize(png), { width: 10, height: 8 })
  assert.equal(regionMaskAlphaAt(png, 7, 6), 0)
  assert.equal(regionMaskAlphaAt(png, 2, 2), 255)
  assert.equal(regionMaskAlphaAt(png, 4, 6), 255)
  assert.equal(regionMaskAlphaAt(png, 7, 3), 255)
})

test('尺寸解析支持 PNG/JPEG/WebP，垃圾字节返回 null', () => {
  const png = buildRegionMaskPng({ width: 3, height: 2 }, { x: 0, y: 0, width: 1, height: 1 })
  assert.deepEqual(imagePixelSize(png), { width: 3, height: 2 })

  // 最小 JPEG 头：SOI + SOF0（高 5、宽 7）。
  const jpeg = Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x05, 0x00, 0x07, 0x01, 0x11, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ])
  assert.deepEqual(imagePixelSize(jpeg), { width: 7, height: 5 })

  // WebP VP8X 扩展头：canvas 4x6。
  const webp = Buffer.concat([
    Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.from('VP8X'),
    Buffer.alloc(4), Buffer.alloc(4),
    Buffer.from([0x03, 0x00, 0x00]), Buffer.from([0x05, 0x00, 0x00]),
  ])
  assert.deepEqual(imagePixelSize(webp), { width: 4, height: 6 })

  assert.equal(imagePixelSize(Buffer.from('not an image, definitely')), null)
})
