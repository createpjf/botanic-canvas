import assert from 'node:assert/strict'
import { test } from 'node:test'
import { liquidIndeterminateTravel, liquidProgressBarDebugState } from './liquidProgressBarRuntime.ts'
import {
  fillLiquidProgressPixels,
  liquidFrontAxis,
  liquidProgressLuma,
  liquidWaveOffset,
  shadeLiquidProgressPixel,
} from './liquidProgressShader.ts'

test('LiquidProgressBar 运行时默认无订阅', () => {
  const state = liquidProgressBarDebugState()
  assert.equal(state.subscriberCount, 0)
  assert.equal(state.rafActive, false)
})

test('不定进度从左到右单向推进，不回扫、不伪造百分比', () => {
  const reduced = liquidIndeterminateTravel(1.2, true)
  assert.equal(reduced, 0.55)
  const a = liquidIndeterminateTravel(0, false)
  const b = liquidIndeterminateTravel(1.5, false)
  const c = liquidIndeterminateTravel(3.0, false)
  assert.ok(a >= 0.12 && a < 0.2)
  assert.ok(b > a)
  assert.ok(c > b)
  assert.ok(c <= 0.92)
})

test('液面前沿按宽高比落在画面内，核比深处更亮', () => {
  const width = 96
  const height = 32
  const progress = 0.6
  const input = { progress, warp: 1.4, alive: 1 }
  const aspect = width / height
  const frontUv = liquidFrontAxis(progress, aspect) / aspect
  const midY = 16
  const samples = []
  for (let x = 0; x < width; x += 1) {
    samples.push(shadeLiquidProgressPixel(x, midY, width, height, input))
  }
  const lumas = samples.map((rgb) => liquidProgressLuma(...rgb))
  const edgeX = lumas.indexOf(Math.max(...lumas))
  const body = samples[8]
  const empty = samples[width - 4]

  assert.ok(frontUv > 0.35 && frontUv < 0.8)
  assert.ok(Math.abs(edgeX / width - frontUv) < 0.12)
  assert.ok(lumas[edgeX] > liquidProgressLuma(...body) + 0.2)
  assert.ok(liquidProgressLuma(...empty) < 0.2)
  assert.ok(body[1] > body[2])
})

test('减少动效时波面静止，不同行的前沿对齐', () => {
  assert.equal(liquidWaveOffset(0.2, 1.4, 0), 0)
  const still = { progress: 0.55, warp: 4, alive: 0 }
  const a = shadeLiquidProgressPixel(40, 6, 80, 24, still)
  const b = shadeLiquidProgressPixel(40, 18, 80, 24, still)
  const delta = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])
  assert.ok(delta < 0.12)
})

test('整帧缓冲写出不透明像素，左侧已填充右侧仍是底', () => {
  const width = 48
  const height = 16
  const pixels = new Uint8Array(width * height * 4)
  fillLiquidProgressPixels(pixels, width, height, { progress: 0.35, warp: 0.8, alive: 1 })
  const midLeft = ((height >> 1) * width + 3) * 4
  const midRight = ((height >> 1) * width + width - 2) * 4
  assert.equal(pixels[3], 255)
  assert.ok(pixels[midLeft + 1] > pixels[midLeft])
  assert.ok(pixels[midLeft + 1] < 80)
  assert.ok(Math.abs(pixels[midRight] - 33) < 12)
  assert.ok(Math.abs(pixels[midRight + 1] - 33) < 12)
})
