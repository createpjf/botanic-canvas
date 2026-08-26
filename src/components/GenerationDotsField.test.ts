import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generationDotsFieldDebugState } from './generationDotsFieldRuntime.ts'
import {
  fillGenerationDotsPixels,
  generationDotsLuma,
  shadeGenerationDotsPixel,
} from './generationDotsField.ts'

test('GenerationDotsField 运行时默认无订阅', () => {
  const state = generationDotsFieldDebugState()
  assert.equal(state.subscriberCount, 0)
  assert.equal(state.rafActive, false)
})

test('snake 点阵有亮点和近黑底，时间变化会改相位', () => {
  const width = 300
  const height = 400
  let maxChange = 0
  for (let y = 40; y < height - 40; y += 16) {
    for (let x = 40; x < width - 40; x += 16) {
      const a = shadeGenerationDotsPixel(x, y, width, height, 0)
      const b = shadeGenerationDotsPixel(x, y, width, height, 0.4)
      const changed = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])
      if (changed > maxChange) maxChange = changed
    }
  }
  assert.ok(maxChange > 0.2)

  let brightest = 0
  let darkest = 1
  let peak = [0, 0, 0]
  for (let y = 24; y < height - 24; y += 4) {
    for (let x = 24; x < width - 24; x += 4) {
      const rgb = shadeGenerationDotsPixel(x, y, width, height, 0.9)
      const luma = generationDotsLuma(...rgb)
      if (luma > brightest) {
        brightest = luma
        peak = rgb
      }
      if (luma < darkest) darkest = luma
    }
  }
  assert.ok(brightest > 0.35)
  assert.ok(darkest < 0.08)
  assert.ok(Math.abs(peak[0] - peak[1]) < 0.02)
  assert.ok(Math.abs(peak[1] - peak[2]) < 0.02)
})

test('减少动效时同一时刻画面不变', () => {
  const frozen = 1.15
  const a = shadeGenerationDotsPixel(24, 18, 64, 48, frozen)
  const b = shadeGenerationDotsPixel(24, 18, 64, 48, frozen)
  assert.deepEqual(a, b)
})

test('整帧缓冲写出不透明黑底点阵', () => {
  const width = 150
  const height = 200
  const pixels = new Uint8Array(width * height * 4)
  fillGenerationDotsPixels(pixels, width, height, 0.8)
  assert.equal(pixels[3], 255)
  let max = 0
  let min = 255
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] > max) max = pixels[i]
    if (pixels[i] < min) min = pixels[i]
  }
  assert.ok(max > 80)
  assert.ok(min < 12)
})
