/**
 * 结果节点媒体区全幅 flow 点阵：跟卡片原比例铺满。
 * 共享 rAF；离屏与 reduced-motion 停在静帧。
 */

import {
  GENERATION_DOTS_BACKGROUND,
  fillGenerationDotsPixels,
  generationDotsBufferSize,
} from './generationDotsField.ts'

export { GENERATION_DOTS_BACKGROUND } from './generationDotsField.ts'

export type DotsSubscriber = {
  canvas: HTMLCanvasElement
  visible: boolean
  reducedMotion: boolean
  compact: boolean
  image?: ImageData
  startedAt: number
}

const subscribers = new Set<DotsSubscriber>()
let rafId = 0

export function prefersGenerationDotsReducedMotion() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function paintGenerationDotsFrame(sub: DotsSubscriber, nowMs = Date.now()) {
  const canvas = sub.canvas
  const host = canvas.parentElement
  if (!host) return

  const cssWidth = Math.max(1, host.clientWidth)
  const cssHeight = Math.max(1, host.clientHeight)
  const { width, height } = generationDotsBufferSize(cssWidth, cssHeight, sub.compact)
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

  const time = sub.reducedMotion ? 1.15 : Math.max(0, (nowMs - sub.startedAt) / 1000)
  fillGenerationDotsPixels(sub.image.data, width, height, time)
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
    paintGenerationDotsFrame(sub, now)
  }
  if (anyShouldAnimate()) {
    rafId = window.requestAnimationFrame(tick)
  } else {
    rafId = 0
  }
}

export function ensureGenerationDotsLoop() {
  if (rafId || !anyShouldAnimate()) {
    if (!rafId) {
      const now = Date.now()
      for (const sub of subscribers) {
        if (sub.visible) paintGenerationDotsFrame(sub, now)
      }
    }
    return
  }
  rafId = window.requestAnimationFrame(tick)
}

export function registerGenerationDotsSubscriber(sub: DotsSubscriber) {
  subscribers.add(sub)
  ensureGenerationDotsLoop()
  return () => {
    subscribers.delete(sub)
    if (subscribers.size === 0 && rafId) {
      window.cancelAnimationFrame(rafId)
      rafId = 0
    }
  }
}

export function generationDotsFieldDebugState() {
  return { subscriberCount: subscribers.size, rafActive: rafId !== 0 }
}
