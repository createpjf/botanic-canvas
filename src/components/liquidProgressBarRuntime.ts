/**
 * LiquidProgressBar 共享渲染时钟。多节点生成时共用一个 rAF，不伪造业务百分比。
 */

export const LIQUID_PROGRESS_PALETTE = ['#0B194A', '#0E4FC7', '#338FE0', '#42B8FA', '#A3EDFF'] as const
export const LIQUID_PROGRESS_BACKGROUND = '#212124'
export const LIQUID_PROGRESS_ASPECT = 3.6
export const LIQUID_PROGRESS_CORNER_RATIO = 0.144

export type LiquidSubscriber = {
  canvas: HTMLCanvasElement
  visible: boolean
  reducedMotion: boolean
  compact: boolean
}

const subscribers = new Set<LiquidSubscriber>()
let rafId = 0
let startedAt = 0

export function prefersLiquidReducedMotion() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function hexToRgb(hex: string) {
  const value = hex.replace('#', '')
  const n = Number.parseInt(value, 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

function mixRgb(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }, t: number) {
  const u = Math.min(1, Math.max(0, t))
  return {
    r: Math.round(a.r + (b.r - a.r) * u),
    g: Math.round(a.g + (b.g - a.g) * u),
    b: Math.round(a.b + (b.b - a.b) * u),
  }
}

function paletteAt(t: number) {
  const clamped = ((t % 1) + 1) % 1
  const scaled = clamped * (LIQUID_PROGRESS_PALETTE.length - 1)
  const i = Math.floor(scaled)
  const f = scaled - i
  const a = hexToRgb(LIQUID_PROGRESS_PALETTE[i]!)
  const b = hexToRgb(LIQUID_PROGRESS_PALETTE[Math.min(i + 1, LIQUID_PROGRESS_PALETTE.length - 1)]!)
  return mixRgb(a, b, f)
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

export function paintLiquidProgressFrame(sub: LiquidSubscriber, elapsedMs: number) {
  const canvas = sub.canvas
  const parent = canvas.parentElement
  if (!parent) return

  const cssWidth = Math.max(1, parent.clientWidth)
  const cssHeight = Math.max(1, Math.round(cssWidth / LIQUID_PROGRESS_ASPECT))
  const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2)
  const pixelW = Math.round(cssWidth * dpr)
  const pixelH = Math.round(cssHeight * dpr)
  if (canvas.width !== pixelW || canvas.height !== pixelH) {
    canvas.width = pixelW
    canvas.height = pixelH
  }
  canvas.style.width = `${cssWidth}px`
  canvas.style.height = `${cssHeight}px`

  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssWidth, cssHeight)

  const radius = Math.min(cssHeight * LIQUID_PROGRESS_CORNER_RATIO * 2.2, cssHeight / 2)
  roundRectPath(ctx, 0, 0, cssWidth, cssHeight, radius)
  ctx.fillStyle = LIQUID_PROGRESS_BACKGROUND
  ctx.fill()
  ctx.save()
  roundRectPath(ctx, 0, 0, cssWidth, cssHeight, radius)
  ctx.clip()

  const time = sub.reducedMotion ? 0.42 : elapsedMs / 1000
  // 不定进度：液面前沿在轨道上往返，不映射业务百分比。
  const travel = sub.reducedMotion ? 0.62 : 0.58 + 0.28 * Math.sin(time * 1.15)
  const pulse = sub.reducedMotion ? 0.34 : 0.32 + 0.1 * Math.sin(time * 2.8)
  const bandWidth = cssWidth * (0.52 + pulse)
  const liquidLeft = travel * cssWidth - bandWidth / 2

  // 左侧暗蓝 → 右侧亮青，保证不定进度条在浅色节点底上仍可读。
  const gradient = ctx.createLinearGradient(liquidLeft, 0, liquidLeft + bandWidth, 0)
  for (let i = 0; i < LIQUID_PROGRESS_PALETTE.length; i += 1) {
    const stop = i / (LIQUID_PROGRESS_PALETTE.length - 1)
    const rgb = paletteAt(stop)
    gradient.addColorStop(stop, `rgb(${rgb.r},${rgb.g},${rgb.b})`)
  }

  ctx.globalAlpha = 1
  ctx.fillStyle = gradient
  roundRectPath(ctx, liquidLeft, 1, bandWidth, cssHeight - 2, Math.max(2, radius - 1))
  ctx.fill()

  // 前沿高光，强化 liquid 边缘
  const tip = liquidLeft + bandWidth * 0.82
  const tipGlow = ctx.createRadialGradient(tip, cssHeight / 2, 0, tip, cssHeight / 2, cssHeight * 0.9)
  tipGlow.addColorStop(0, 'rgba(163,237,255,0.55)')
  tipGlow.addColorStop(1, 'rgba(163,237,255,0)')
  ctx.globalAlpha = 0.85
  ctx.fillStyle = tipGlow
  ctx.fillRect(liquidLeft, 0, bandWidth, cssHeight)

  if (!sub.reducedMotion && !sub.compact) {
    ctx.globalAlpha = 0.04
    for (let i = 0; i < 18; i += 1) {
      const x = ((i * 47 + time * 30) % cssWidth + cssWidth) % cssWidth
      const y = ((i * 19 + time * 11) % cssHeight + cssHeight) % cssHeight
      ctx.fillStyle = i % 2 ? '#A3EDFF' : '#090B16'
      ctx.fillRect(x, y, 1, 1)
    }
  }

  ctx.restore()
  ctx.globalAlpha = 1
}

function anyShouldAnimate() {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false
  for (const sub of subscribers) {
    if (sub.visible && !sub.reducedMotion) return true
  }
  return false
}

function tick(now: number) {
  if (!startedAt) startedAt = now
  const elapsed = now - startedAt
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
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
      for (const sub of subscribers) {
        if (sub.visible) paintLiquidProgressFrame(sub, now - (startedAt || now))
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

/** 测试用：当前订阅数与是否有活跃 rAF。 */
export function liquidProgressBarDebugState() {
  return { subscriberCount: subscribers.size, rafActive: rafId !== 0 }
}

/** 不定进度液面位置（0–1），不映射业务百分比。 */
export function liquidIndeterminateTravel(elapsedSeconds: number, reducedMotion: boolean) {
  if (reducedMotion) return 0.62
  return 0.58 + 0.28 * Math.sin(elapsedSeconds * 1.15)
}
