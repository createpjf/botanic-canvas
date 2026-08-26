/**
 * 结果节点媒体区全幅 liquid：跟卡片原比例铺满，液面从左到右波浪推进。
 * 不定进度，不伪造业务百分比。逐像素着色在 liquidProgressShader。
 */

import {
  LIQUID_PROGRESS_BACKGROUND,
  fillLiquidProgressPixels,
  liquidProgressBufferSize,
} from './liquidProgressShader.ts'

export { LIQUID_PROGRESS_BACKGROUND } from './liquidProgressShader.ts'

/** 与 .result-node 圆角一致 */
export const LIQUID_PROGRESS_NODE_RADIUS = 10

export type LiquidSubscriber = {
  canvas: HTMLCanvasElement
  visible: boolean
  reducedMotion: boolean
  compact: boolean
  image?: ImageData
}

const subscribers = new Set<LiquidSubscriber>()
let rafId = 0
let startedAt = 0

export function prefersLiquidReducedMotion() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * 不定进度：只从左往右单向推进，到近右端后复位再来一轮。
 * 不映射业务百分比，也不回扫。
 */
export function liquidIndeterminateTravel(elapsedSeconds: number, reducedMotion: boolean) {
  if (reducedMotion) return 0.55
  // 约 5.5s 走完一轮（0.12 → 0.92），再瞬间回到左侧。
  const cycle = (elapsedSeconds * 0.18) % 1
  return 0.12 + cycle * 0.8
}

export function liquidProgressElapsedMs(now = typeof performance !== 'undefined' ? performance.now() : Date.now()) {
  if (!startedAt) startedAt = now
  return now - startedAt
}

export function paintLiquidProgressFrame(sub: LiquidSubscriber, elapsedMs: number) {
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

  const time = sub.reducedMotion ? 1.2 : elapsedMs / 1000
  fillLiquidProgressPixels(sub.image.data, width, height, {
    progress: liquidIndeterminateTravel(time, sub.reducedMotion),
    warp: time,
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

function tick(now: number) {
  const elapsed = liquidProgressElapsedMs(now)
  for (const sub of subscribers) {
    if (!sub.visible) continue
    paintLiquidProgressFrame(sub, elapsed)
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
      const elapsed = liquidProgressElapsedMs()
      for (const sub of subscribers) {
        if (sub.visible) paintLiquidProgressFrame(sub, elapsed)
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
      startedAt = 0
    }
  }
}

export function liquidProgressBarDebugState() {
  return { subscriberCount: subscribers.size, rafActive: rafId !== 0 }
}
