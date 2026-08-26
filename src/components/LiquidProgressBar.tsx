import { useEffect, useRef } from 'react'

/**
 * 画布结果节点生成占位的不定进度胶囊。
 * 视觉贴近 MetalForge liquid progress（深色底 + 蓝青色带），不接收、不展示业务百分比。
 */

const PALETTE = ['#090B16', '#0B194A', '#0E4FC7', '#42B8FA', '#A3EDFF'] as const
const BACKGROUND = '#212124'
const DEFAULT_ASPECT = 3.6
const CORNER_RATIO = 0.144

type LiquidSubscriber = {
  canvas: HTMLCanvasElement
  visible: boolean
  reducedMotion: boolean
  compact: boolean
}

const subscribers = new Set<LiquidSubscriber>()
let rafId = 0
let startedAt = 0

function prefersReducedMotion() {
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
  const scaled = clamped * (PALETTE.length - 1)
  const i = Math.floor(scaled)
  const f = scaled - i
  const a = hexToRgb(PALETTE[i]!)
  const b = hexToRgb(PALETTE[Math.min(i + 1, PALETTE.length - 1)]!)
  return mixRgb(a, b, f)
}

function paintFrame(sub: LiquidSubscriber, elapsedMs: number) {
  const canvas = sub.canvas
  const parent = canvas.parentElement
  if (!parent) return

  const cssWidth = Math.max(1, parent.clientWidth)
  const cssHeight = Math.max(1, Math.round(cssWidth / DEFAULT_ASPECT))
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

  const radius = Math.min(cssHeight * CORNER_RATIO * 2.2, cssHeight / 2)
  roundRectPath(ctx, 0, 0, cssWidth, cssHeight, radius)
  ctx.fillStyle = BACKGROUND
  ctx.fill()
  ctx.save()
  roundRectPath(ctx, 0, 0, cssWidth, cssHeight, radius)
  ctx.clip()

  const time = sub.reducedMotion ? 0.42 : elapsedMs / 1000
  // 不定进度：液面中心在 0.18–0.82 间往返，不映射业务百分比。
  const travel = sub.reducedMotion ? 0.55 : 0.5 + 0.32 * Math.sin(time * 1.15)
  const pulse = sub.reducedMotion ? 0.22 : 0.18 + 0.1 * Math.sin(time * 2.8)
  const bandWidth = cssWidth * (0.34 + pulse)

  const gradient = ctx.createLinearGradient(0, 0, cssWidth, 0)
  for (let i = 0; i < PALETTE.length; i += 1) {
    const stop = i / (PALETTE.length - 1)
    const rgb = paletteAt(stop + (sub.reducedMotion ? 0 : time * 0.08))
    gradient.addColorStop(stop, `rgb(${rgb.r},${rgb.g},${rgb.b})`)
  }

  const liquidLeft = travel * cssWidth - bandWidth / 2
  ctx.globalAlpha = 0.92
  ctx.fillStyle = gradient
  roundRectPath(ctx, liquidLeft, 1, bandWidth, cssHeight - 2, Math.max(2, radius - 1))
  ctx.fill()

  // lag / echo：滞后半透明拖影
  if (!sub.reducedMotion) {
    const lag = 0.55
    const echoLeft = liquidLeft - bandWidth * 0.22 * lag
    ctx.globalAlpha = 0.28
    ctx.fillStyle = gradient
    roundRectPath(ctx, echoLeft, 2, bandWidth * 0.72, cssHeight - 4, Math.max(2, radius - 2))
    ctx.fill()
  }

  // 高光扫过
  const sheenX = sub.reducedMotion
    ? cssWidth * 0.45
    : ((time * 0.35) % 1.4) * cssWidth - cssWidth * 0.2
  const sheen = ctx.createLinearGradient(sheenX, 0, sheenX + cssWidth * 0.28, 0)
  sheen.addColorStop(0, 'rgba(255,255,255,0)')
  sheen.addColorStop(0.5, 'rgba(163,237,255,0.35)')
  sheen.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.globalAlpha = 0.55
  ctx.fillStyle = sheen
  ctx.fillRect(0, 0, cssWidth, cssHeight)

  // 极轻 grain
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
    paintFrame(sub, elapsed)
  }
  if (anyShouldAnimate()) {
    rafId = window.requestAnimationFrame(tick)
  } else {
    rafId = 0
  }
}

function ensureLoop() {
  if (rafId || !anyShouldAnimate()) {
    // 静止态也至少画一帧（含 reduced-motion）
    if (!rafId) {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
      for (const sub of subscribers) {
        if (sub.visible) paintFrame(sub, now - (startedAt || now))
      }
    }
    return
  }
  rafId = window.requestAnimationFrame(tick)
}

function register(sub: LiquidSubscriber) {
  subscribers.add(sub)
  ensureLoop()
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

export type LiquidProgressBarProps = {
  /** 矮节点（如 16:9）用更窄胶囊，避免挤掉标题与取消。 */
  compact?: boolean
  className?: string
  'aria-hidden'?: boolean | 'true' | 'false'
}

export function LiquidProgressBar({
  compact = false,
  className,
  'aria-hidden': ariaHidden = true,
}: LiquidProgressBarProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const subRef = useRef<LiquidSubscriber | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const sub: LiquidSubscriber = {
      canvas,
      visible: true,
      reducedMotion: prefersReducedMotion(),
      compact,
    }
    subRef.current = sub

    const media = typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null
    const onMotion = () => {
      sub.reducedMotion = prefersReducedMotion()
      ensureLoop()
    }
    media?.addEventListener?.('change', onMotion)

    const observer = typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver((entries) => {
        const entry = entries[0]
        sub.visible = entry?.isIntersecting ?? true
        ensureLoop()
      }, { threshold: 0.05 })
      : null
    observer?.observe(canvas)

    const onVisibility = () => ensureLoop()
    document.addEventListener('visibilitychange', onVisibility)

    const onResize = () => {
      if (sub.visible) {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
        paintFrame(sub, now - (startedAt || now))
      }
    }
    window.addEventListener('resize', onResize)

    const unregister = register(sub)

    return () => {
      unregister()
      observer?.disconnect()
      media?.removeEventListener?.('change', onMotion)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('resize', onResize)
      subRef.current = null
    }
  }, [compact])

  useEffect(() => {
    if (subRef.current) subRef.current.compact = compact
  }, [compact])

  return (
    <span
      className={['liquid-progress-bar', compact ? 'is-compact' : '', className].filter(Boolean).join(' ')}
      aria-hidden={ariaHidden}
    >
      <canvas ref={canvasRef} className="liquid-progress-bar__canvas" />
    </span>
  )
}
