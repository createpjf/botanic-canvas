/**
 * 结果节点生成占位的全幅 liquid 画面。
 * 铺满媒体区，不定进度液面在整幅里流动；不伪造业务百分比。
 */

export const LIQUID_PROGRESS_PALETTE = ['#090B16', '#0B194A', '#0E4FC7', '#42B8FA', '#A3EDFF', '#1354C2', '#338FE0'] as const
export const LIQUID_PROGRESS_BACKGROUND = '#212124'
/** 相对短边的圆角比例，贴近 MetalForge corner=0.144，同时不超过节点 10px 观感。 */
export const LIQUID_PROGRESS_CORNER_RATIO = 0.144

export type LiquidSubscriber = {
  canvas: HTMLCanvasElement
  visible: boolean
  reducedMotion: boolean
  /** 矮节点降低 grain / churn 密度。 */
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

/** 不定进度填充量（0–1），在轨道上往返，不映射业务百分比。 */
export function liquidIndeterminateTravel(elapsedSeconds: number, reducedMotion: boolean) {
  if (reducedMotion) return 0.58
  return 0.42 + 0.28 * (0.5 + 0.5 * Math.sin(elapsedSeconds * 0.85))
}

function frontWaveX(baseX: number, y: number, height: number, time: number, amount: number) {
  const n1 = Math.sin(y / height * Math.PI * 2.2 + time * 2.1) * amount * 18
  const n2 = Math.sin(y / height * Math.PI * 5.1 - time * 1.4) * amount * 8
  return baseX + n1 + n2
}

export function paintLiquidProgressFrame(sub: LiquidSubscriber, elapsedMs: number) {
  const canvas = sub.canvas
  const host = canvas.parentElement
  if (!host) return

  const cssWidth = Math.max(1, host.clientWidth)
  const cssHeight = Math.max(1, host.clientHeight)
  const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2)
  const pixelW = Math.round(cssWidth * dpr)
  const pixelH = Math.round(cssHeight * dpr)
  if (canvas.width !== pixelW || canvas.height !== pixelH) {
    canvas.width = pixelW
    canvas.height = pixelH
  }
  canvas.style.width = '100%'
  canvas.style.height = '100%'

  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssWidth, cssHeight)

  const radius = Math.min(
    Math.min(cssWidth, cssHeight) * LIQUID_PROGRESS_CORNER_RATIO,
    10,
  )
  roundRectPath(ctx, 0, 0, cssWidth, cssHeight, radius)
  ctx.fillStyle = LIQUID_PROGRESS_BACKGROUND
  ctx.fill()
  ctx.save()
  roundRectPath(ctx, 0, 0, cssWidth, cssHeight, radius)
  ctx.clip()

  const time = sub.reducedMotion ? 0.8 : elapsedMs / 1000
  const fill = liquidIndeterminateTravel(time, sub.reducedMotion)
  const frontBase = cssWidth * fill
  const amount = 0.085

  // 整幅液面：从左侧铺到波浪前沿
  const body = ctx.createLinearGradient(0, 0, frontBase, 0)
  for (let i = 0; i < LIQUID_PROGRESS_PALETTE.length; i += 1) {
    const stop = i / (LIQUID_PROGRESS_PALETTE.length - 1)
    const rgb = paletteAt(stop * 0.85 + (sub.reducedMotion ? 0 : (time * 0.04) % 0.15))
    body.addColorStop(stop, `rgb(${rgb.r},${rgb.g},${rgb.b})`)
  }

  ctx.beginPath()
  ctx.moveTo(0, 0)
  const steps = Math.max(24, Math.floor(cssHeight / 4))
  for (let i = 0; i <= steps; i += 1) {
    const y = (i / steps) * cssHeight
    const x = sub.reducedMotion
      ? frontBase
      : frontWaveX(frontBase, y, cssHeight, time, amount)
    if (i === 0) ctx.lineTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.lineTo(0, cssHeight)
  ctx.closePath()
  ctx.globalAlpha = 1
  ctx.fillStyle = body
  ctx.fill()

  // lag / echo：滞后半透明前沿
  if (!sub.reducedMotion) {
    const lagFront = frontBase - cssWidth * 0.06
    ctx.beginPath()
    ctx.moveTo(0, 0)
    for (let i = 0; i <= steps; i += 1) {
      const y = (i / steps) * cssHeight
      const x = frontWaveX(lagFront, y, cssHeight, time * 0.9 - 0.4, amount * 1.2)
      ctx.lineTo(Math.max(0, x), y)
    }
    ctx.lineTo(0, cssHeight)
    ctx.closePath()
    ctx.globalAlpha = 0.22
    ctx.fillStyle = body
    ctx.fill()
  }

  // 垂直色带微扰（churn）
  if (!sub.reducedMotion) {
    const churn = ctx.createLinearGradient(0, 0, 0, cssHeight)
    churn.addColorStop(0, 'rgba(163,237,255,0.08)')
    churn.addColorStop(0.45 + 0.1 * Math.sin(time * 1.7), 'rgba(14,79,199,0)')
    churn.addColorStop(1, 'rgba(9,11,22,0.18)')
    ctx.globalAlpha = 0.55
    ctx.fillStyle = churn
    ctx.fillRect(0, 0, frontBase + 12, cssHeight)
  }

  // 前沿 bloom
  const bloomX = frontBase
  const bloom = ctx.createRadialGradient(bloomX, cssHeight * 0.5, 0, bloomX, cssHeight * 0.5, cssHeight * 0.55)
  bloom.addColorStop(0, 'rgba(163,237,255,0.42)')
  bloom.addColorStop(0.45, 'rgba(66,184,250,0.16)')
  bloom.addColorStop(1, 'rgba(66,184,250,0)')
  ctx.globalAlpha = 0.9
  ctx.fillStyle = bloom
  ctx.fillRect(bloomX - cssWidth * 0.12, 0, cssWidth * 0.24, cssHeight)

  // 轻 vignette，压住四角，文案更易读
  const vignette = ctx.createRadialGradient(
    cssWidth * 0.5, cssHeight * 0.45, Math.min(cssWidth, cssHeight) * 0.2,
    cssWidth * 0.5, cssHeight * 0.5, Math.max(cssWidth, cssHeight) * 0.72,
  )
  vignette.addColorStop(0, 'rgba(0,0,0,0)')
  vignette.addColorStop(1, 'rgba(9,11,22,0.38)')
  ctx.globalAlpha = 1
  ctx.fillStyle = vignette
  ctx.fillRect(0, 0, cssWidth, cssHeight)

  // grain
  if (!sub.reducedMotion) {
    const grains = sub.compact ? 28 : 56
    ctx.globalAlpha = 0.035
    for (let i = 0; i < grains; i += 1) {
      const x = ((i * 47 + time * 40) % cssWidth + cssWidth) % cssWidth
      const y = ((i * 19 + time * 17) % cssHeight + cssHeight) % cssHeight
      ctx.fillStyle = i % 2 ? '#A3EDFF' : '#090B16'
      ctx.fillRect(x, y, 1.2, 1.2)
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
