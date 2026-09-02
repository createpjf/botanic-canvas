import assert from 'node:assert/strict'
import test from 'node:test'
import {
  composeMarkOverlayPng,
  composeOverlayImages,
  decodeRgbaImage,
  encodeRgbaPng,
  jobRequestsPixelOverlay,
  knockoutMarkBackground,
} from './imageOverlay.mjs'
import { GenerationError } from '../generation/generationProvider.mjs'

function solidPng(width, height, rgba) {
  const pixels = Buffer.alloc(width * height * 4)
  for (let index = 0; index < width * height; index += 1) {
    pixels.set(rgba, index * 4)
  }
  return encodeRgbaPng({ width, height, rgba: pixels })
}

test('白底标识会抠掉衬底，再原样贴进选区', () => {
  const base = decodeRgbaImage(solidPng(10, 10, [10, 20, 30, 255]))
  const markPixels = Buffer.alloc(4 * 4 * 4, 255)
  for (let row = 1; row < 3; row += 1) {
    for (let column = 1; column < 3; column += 1) {
      markPixels.set([200, 0, 0, 255], (row * 4 + column) * 4)
    }
  }
  const markPng = encodeRgbaPng({ width: 4, height: 4, rgba: markPixels })
  const knocked = knockoutMarkBackground(decodeRgbaImage(markPng))
  assert.equal(knocked.rgba[3], 0)

  const composed = composeMarkOverlayPng({
    baseBuffer: encodeRgbaPng(base),
    markBuffer: markPng,
    rect: { x: 0.2, y: 0.2, width: 0.6, height: 0.6 },
  })
  const result = decodeRgbaImage(composed)
  assert.equal(result.width, 10)
  assert.equal(result.height, 10)
  const redPixels = []
  for (let index = 0; index < 10 * 10; index += 1) {
    const offset = index * 4
    if (result.rgba[offset] > 150 && result.rgba[offset + 1] < 20 && result.rgba[offset + 2] < 20) {
      redPixels.push(index)
    }
  }
  assert.ok(redPixels.length >= 4, `标识红色像素过少：${redPixels.length}`)
  // 选区外保持底图。
  assert.deepEqual([...result.rgba.subarray(0, 4)], [10, 20, 30, 255])
})

test('没有选区或没有标识时不走像素贴图', () => {
  assert.equal(jobRequestsPixelOverlay({
    prompt: '添加flock.io的logo',
    references: [{ name: 'logo-full 2' }],
  }), false)
  assert.equal(jobRequestsPixelOverlay({
    prompt: '添加flock.io的logo',
    maskRegion: { x: 0.7, y: 0.3, width: 0.1, height: 0.1 },
    references: [{ name: 'logo-full 2' }],
  }), false)
  assert.equal(jobRequestsPixelOverlay({
    prompt: '添加flock.io的logo',
    composeMode: 'overlay',
    maskRegion: { x: 0.7, y: 0.3, width: 0.1, height: 0.1 },
    references: [{ name: 'logo-full 2' }],
  }), true)
  assert.equal(jobRequestsPixelOverlay({
    prompt: '把右上角换成花丛',
    maskRegion: { x: 0.6, y: 0, width: 0.4, height: 0.4 },
    references: [{ name: 'logo-full 2' }],
  }), false)
})

test('非 PNG 字节喂给 decodeRgbaImage 时报错文案保持不变', () => {
  // 格式判定改走 detectImageFormat 之后，这条错误路径必须还认得出「不是 PNG」，
  // 报错文案也不能变——贴标识功能本身只承诺支持 PNG。
  assert.throws(
    () => decodeRgbaImage(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24])),
    (error) => error instanceof GenerationError
      && error.code === 'INVALID_REFERENCE'
      && error.message === '贴标识无法读取该图片，请使用 PNG。',
  )
})

test('像素贴图任务直接持久化 PNG，不调用供应商', async () => {
  const persisted = []
  const result = await composeOverlayImages({
    prompt: '添加flock.io的logo',
    batchCount: 1,
    maskRegion: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
    parent: { name: '人像', mimeType: 'image/png', buffer: solidPng(8, 8, [8, 8, 8, 255]) },
    references: [{ name: 'logo-full 2', mimeType: 'image/png', buffer: solidPng(4, 4, [0, 180, 0, 255]) }],
  }, {
    jobId: 'job-overlay',
    persistImage: async (image) => {
      persisted.push(image)
      return image.dataUrl
    },
  })
  assert.equal(result.outputs.length, 1)
  assert.equal(result.outputs[0].id, 'job-overlay-output-1')
  assert.equal(persisted[0].mimeType, 'image/png')
  assert.match(persisted[0].dataUrl, /^data:image\/png;base64,/)
})
