/**
 * 结果节点生成态的横向 liquid 进度卡（贴近 MetalForge progress / 参考图）。
 * 从左到右填充，波浪前沿；不伪造业务百分比。
 */

export const LIQUID_PROGRESS_PALETTE = ['#090B16', '#0B194A', '#0E4FC7', '#1354C2', '#338FE0', '#42B8FA', '#A3EDFF'] as const
export const LIQUID_PROGRESS_BACKGROUND = '#212124'
/** MetalForge aspect=3.6 */
export const LIQUID_PROGRESS_ASPECT = 3.6
/** MetalForge corner=0.144，相对短边 */
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

/**
 * 不定进度：从左到右缓慢推进后回扫，落在约 12%–78%。
 * 不映射业务百分比。
 */
export function liquidIndeterminateTravel(elapsedSeconds: number, reducedMotion: boolean) {
  if (reducedMotion) return 0.42
  const cycle = (elapsedSeconds * 0.22) % 1
  // 三角波：0→1→0，再映射到可见区间
  const tri = cycle < 0.5 ? cycle * 2 : (1 - cycle) * 2
  return 0.12 + tri * 0.66
}

function frontWaveX(baseX: number, y: number, height: number, time: number, amount: number) {
  // 参考图：竖直有机波浪前沿，多频叠加
  const n1 = Math.sin(y / height * Math.PI * 1.8 + time * 2.4) * amount * height * 0.22
  const n2 = Math.sin(y / height * Math.PI * 4.6 - time * 1.7) * amount * height * 0.1
  const n3 = Math.sin(y / height * Math.PI * 0.7 + time * 0.9) * amount * height * 0.06
  return baseX + n1 + n2 + n3
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

  const radius = cssHeight / 2
  roundRectPath(ctx, 0, 0, cssWidth, cssHeight, radius)
  ctx.fillStyle = LIQUID_PROGRESS_BACKGROUND
  ctx.fill()
  ctx.save()
  roundRectPath(ctx, 0, 0, cssWidth, cssHeight, radius)
  ctx.clip()

  const time = sub.reducedMotion ? 1.2 : elapsedMs / 1000
  const fill = liquidIndeterminateTravel(time, sub.reducedMotion)
  const frontBase = cssWidth * fill
  const amount = 0.085

  // 从左到右的液面主体
  const body = ctx.createLinearGradient(0, 0, Math.max(frontBase, 1), 0)
  body.addColorStop(0, '#090B16')
  body.addColorStop(0.18, '#0B194A')
  body.addColorStop(0.45, '#0E4FC7')
  body.addColorStop(0.72, '#338FE0')
  body.addColorStop(0.9, '#42B8FA')
  body.addColorStop(1, '#A3EDFF')

  ctx.beginPath()
  ctx.moveTo(0, 0)
  const steps = Math.max(32, Math.floor(cssHeight / 2))
  for (let i = 0; i <= steps; i += 1) {
    const y = (i / steps) * cssHeight
    const x = sub.reducedMotion ? frontBase : frontWaveX(frontBase, y, cssHeight, time, amount)
    ctx.lineTo(Math.max(0, x), y)
  }
  ctx.lineTo(0, cssHeight)
  ctx.closePath()
  ctx.globalAlpha = 1
  ctx.fillStyle = body
  ctx.fill()

  // 内部 haze / plasma
  if (!sub.reducedMotion) {
    const haze = ctx.createRadialGradient(
      frontBase * 0.55, cssHeight * 0.45, 0,
      frontBase * 0.55, cssHeight * 0.5, Math.max(frontBase, cssHeight) * 0.7,
    )
    haze.addColorStop(0, 'rgba(163,237,255,0.28)')
    haze.addColorStop(0.4, 'rgba(66,184,250,0.12)')
    haze.addColorStop(1, 'rgba(14,79,199,0)')
    ctx.globalAlpha = 0.9
    ctx.fillStyle = haze
    ctx.fillRect(0, 0, frontBase + 8, cssHeight)

    // lag echo
    const lagFront = frontBase - cssWidth * 0.045
    ctx.beginPath()
    ctx.moveTo(0, 0)
    for (let i = 0; i <= steps; i += 1) {
      const y = (i / steps) * cssHeight
      ctx.lineTo(Math.max(0, frontWaveX(lagFront, y, cssHeight, time * 0.92 - 0.35, amount * 1.15)), y)
    }
    ctx.lineTo(0, cssHeight)
    ctx.closePath()
    ctx.globalAlpha = 0.2
    ctx.fillStyle = '#42B8FA'
    ctx.fill()
  }

  // 前沿 bloom（参考图电青光边）
  const bloom = ctx.createRadialGradient(
    frontBase, cssHeight * 0.5, 0,
    frontBase, cssHeight * 0.5, cssHeight * 0.85,
  )
  bloom.addColorStop(0, 'rgba(163,237,255,0.65)')
  bloom.addColorStop(0.35, 'rgba(66,184,250,0.28)')
  bloom.addColorStop(1, 'rgba(66,184,250,0)')
  ctx.globalAlpha = 1
  ctx.fillStyle = bloom
  ctx.fillRect(frontBase - cssHeight * 0.6, 0, cssHeight * 1.2, cssHeight)

  // 竖直高光带扫过液面
  if (!sub.reducedMotion) {
    const sheenX = ((time * 0.35) % 1.2) * frontBase
    const sheen = ctx.createLinearGradient(sheenX - 12, 0, sheenX + 18, 0)
    sheen.addColorStop(0, 'rgba(255,255,255,0)')
    sheen.addColorStop(0.5, 'rgba(163,237,255,0.22)')
    sheen.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.globalAlpha = 0.8
    ctx.fillStyle = sheen
    ctx.fillRect(0, 0, frontBase, cssHeight)
  }

  // 极轻 grain
  if (!sub.reducedMotion) {
    const grains = sub.compact ? 20 : 40
    ctx.globalAlpha = 0.03
    for (let i = 0; i < grains; i += 1) {
      const x = ((i * 47 + time * 36) % cssWidth + cssWidth) % cssWidth
      const y = ((i * 19 + time * 15) % cssHeight + cssHeight) % cssHeight
      ctx.fillStyle = i % 2 ? '#A3EDFF' : '#090B16'
      ctx.fillRect(x, y, 1, 1)
    }
  }

  // 未填充区微纹理（参考图炭黑底）
  ctx.globalAlpha = 0.04
  ctx.fillStyle = '#090B16'
  for (let i = 0; i < 12; i += 1) {
    const x = frontBase + 6 + ((i * 37) % Math.max(1, cssWidth - frontBase))
    const y = (i * 23 + time * 8) % cssHeight
    ctx.fillRect(x, y, 1, 1)
  }

  ctx.restore()
  ctx.globalAlpha = 1

  // 外沿极轻描边，贴近参考卡
  roundRectPath(ctx, 0.5, 0.5, cssWidth - 1, cssHeight - 1, radius)
  ctx.strokeStyle = 'rgba(255,255,255,0.06)'
  ctx.lineWidth = 1
  ctx.stroke()
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

export function liquidProgressBarDebugState() {
  return { subscriberCount: subscribers.size, rafActive: rafId !== 0 }
}
