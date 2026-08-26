/**
 * 结果节点媒体区全幅 liquid：跟卡片原比例铺满。
 * 推进量由 generationLiquidTravel 决定：单次从左到右，跟任务阶段对齐，不循环。
 */

import type { CanvasGenerationTaskStatus, GenerationMediaKind } from '../domain/canvas.ts'
import {
  generationLiquidTravel,
  isGenerationLiquidRunningStatus,
} from '../domain/generationLiquidTravel.ts'
import {
  LIQUID_PROGRESS_BACKGROUND,
  fillLiquidProgressPixels,
  liquidProgressBufferSize,
} from './liquidProgressShader.ts'

export { LIQUID_PROGRESS_BACKGROUND } from './liquidProgressShader.ts'
export { generationLiquidTravel } from '../domain/generationLiquidTravel.ts'

/** 与 .result-node 圆角一致 */
export const LIQUID_PROGRESS_NODE_RADIUS = 10

export type LiquidProgressDrive = {
  taskStatus?: CanvasGenerationTaskStatus
  submittedAt?: number
  mediaKind?: GenerationMediaKind
}

export type LiquidSubscriber = LiquidProgressDrive & {
  canvas: HTMLCanvasElement
  visible: boolean
  reducedMotion: boolean
  compact: boolean
  image?: ImageData
  mountAt: number
  runClockStart?: number
}

const subscribers = new Set<LiquidSubscriber>()
let rafId = 0

export function prefersLiquidReducedMotion() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function applyLiquidProgressDrive(
  sub: LiquidSubscriber,
  drive: LiquidProgressDrive,
  now = Date.now(),
) {
  const previous = sub.taskStatus
  const next = drive.taskStatus
  if (
    isGenerationLiquidRunningStatus(next)
    && previous !== undefined
    && !isGenerationLiquidRunningStatus(previous)
  ) {
    sub.runClockStart = now
  } else if (sub.runClockStart == null && isGenerationLiquidRunningStatus(next)) {
    sub.runClockStart = drive.submittedAt ?? sub.mountAt
  } else if (!isGenerationLiquidRunningStatus(next)) {
    sub.runClockStart = undefined
  }
  sub.taskStatus = next
  sub.submittedAt = drive.submittedAt
  sub.mediaKind = drive.mediaKind
}

export function liquidRunningElapsedSeconds(sub: LiquidSubscriber, now = Date.now()) {
  if (!isGenerationLiquidRunningStatus(sub.taskStatus)) return 0
  const origin = sub.runClockStart ?? sub.submittedAt ?? sub.mountAt
  return Math.max(0, (now - origin) / 1000)
}

export function liquidWaveClockSeconds(sub: LiquidSubscriber, now = Date.now()) {
  const origin = sub.submittedAt ?? sub.mountAt
  return Math.max(0, (now - origin) / 1000)
}

export function paintLiquidProgressFrame(sub: LiquidSubscriber, nowMs = Date.now()) {
  const canvas = sub.canvas
  const host = canvas.parentElement
  if (!host) return

  const cssWidth = Math.max(1, host.clientWidth)
  const cssHeight = Math.max(1, host.clientHeight)
  const { width, height } = liquidProgressBufferSize(cssWidth, cssHeight, sub.compact)
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
  canvas.style.width = '100%'
  canvas.style.height = '100%'

  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) return

  if (!sub.image || sub.image.width !== width || sub.image.height !== height) {
    sub.image = ctx.createImageData(width, height)
  }

  const elapsed = liquidRunningElapsedSeconds(sub, nowMs)
  const warp = sub.reducedMotion ? 1.2 : liquidWaveClockSeconds(sub, nowMs)
  fillLiquidProgressPixels(sub.image.data, width, height, {
    progress: generationLiquidTravel({
      taskStatus: sub.taskStatus,
      elapsedSeconds: elapsed,
      mediaKind: sub.mediaKind,
    }),
    warp,
    alive: sub.reducedMotion ? 0 : 1,
  })
  ctx.putImageData(sub.image, 0, 0)
}

function anyShouldAnimate() {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false
  for (const sub of subscribers) {
    if (sub.visible && !sub.reducedMotion) return true
  }
  return false
}

function tick() {
  const now = Date.now()
  for (const sub of subscribers) {
    if (!sub.visible) continue
    paintLiquidProgressFrame(sub, now)
  }
  if (anyShouldAnimate()) {
    rafId = window.requestAnimationFrame(tick)
  } else {
    rafId = 0
  }
}

export function ensureLiquidProgressLoop() {
  if (rafId || !anyShouldAnimate()) {
    if (!rafId) {
      const now = Date.now()
      for (const sub of subscribers) {
        if (sub.visible) paintLiquidProgressFrame(sub, now)
      }
    }
    return
  }
  rafId = window.requestAnimationFrame(tick)
}

export function registerLiquidProgressSubscriber(sub: LiquidSubscriber) {
  subscribers.add(sub)
  ensureLiquidProgressLoop()
  return () => {
    subscribers.delete(sub)
    if (subscribers.size === 0 && rafId) {
      window.cancelAnimationFrame(rafId)
      rafId = 0
    }
  }
}

export function liquidProgressBarDebugState() {
  return { subscriberCount: subscribers.size, rafActive: rafId !== 0 }
}
