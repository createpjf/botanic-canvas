import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyLiquidProgressDrive,
  liquidProgressBarDebugState,
  liquidRunningElapsedSeconds,
} from './liquidProgressBarRuntime.ts'
import { generationLiquidTravel } from '../domain/generationLiquidTravel.ts'
import {
  fillLiquidProgressPixels,
  liquidFrontAxis,
  liquidProgressLuma,
  liquidWaveOffset,
  shadeLiquidProgressPixel,
} from './liquidProgressShader.ts'

function subscriberStub(now: number) {
  return {
    canvas: {} as HTMLCanvasElement,
    visible: true,
    reducedMotion: false,
    compact: false,
    mountAt: now,
  }
}

test('LiquidProgressBar 运行时默认无订阅', () => {
  const state = liquidProgressBarDebugState()
  assert.equal(state.subscriberCount, 0)
  assert.equal(state.rafActive, false)
})

test('排队转 running 从当前时刻起算，不把排队时长算进液面', () => {
  const sub = subscriberStub(1_000)
  applyLiquidProgressDrive(sub, { taskStatus: 'queued', submittedAt: 1_000 }, 1_000)
  assert.equal(liquidRunningElapsedSeconds(sub, 4_000), 0)
  applyLiquidProgressDrive(sub, { taskStatus: 'running', submittedAt: 1_000 }, 5_000)
  assert.equal(liquidRunningElapsedSeconds(sub, 5_000), 0)
  assert.ok(liquidRunningElapsedSeconds(sub, 7_200) > 2)
  const queued = generationLiquidTravel({ taskStatus: 'queued', elapsedSeconds: 40 })
  const started = generationLiquidTravel({
    taskStatus: 'running',
    elapsedSeconds: liquidRunningElapsedSeconds(sub, 5_000),
  })
  assert.ok(started > queued)
})

test('刷新时已在 running 则从 submittedAt 续算，且不循环', () => {
  const sub = subscriberStub(20_000)
  applyLiquidProgressDrive(sub, { taskStatus: 'running', submittedAt: 1_000 }, 20_000)
  const elapsed = liquidRunningElapsedSeconds(sub, 20_000)
  assert.ok(elapsed > 18)
  const later = generationLiquidTravel({ taskStatus: 'running', elapsedSeconds: elapsed + 12 })
  const earlier = generationLiquidTravel({ taskStatus: 'running', elapsedSeconds: elapsed })
  assert.ok(later > earlier)
  assert.ok(later < 0.87)
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
