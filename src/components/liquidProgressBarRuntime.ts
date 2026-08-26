/**
 * 结果节点媒体区全幅 liquid：跟卡片原比例铺满，液面从左到右波浪推进。
 * 不定进度，不伪造业务百分比。
 */

export const LIQUID_PROGRESS_BACKGROUND = '#212124'
/** 与 .result-node 圆角一致 */
export const LIQUID_PROGRESS_NODE_RADIUS = 10

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
 * 不定进度：从左到右缓慢推进后回扫，约 18%–82%。
 * 不映射业务百分比。
 */
export function liquidIndeterminateTravel(elapsedSeconds: number, reducedMotion: boolean) {
  if (reducedMotion) return 0.55
  const cycle = (elapsedSeconds * 0.18) % 1
  const tri = cycle < 0.5 ? cycle * 2 : (1 - cycle) * 2
  return 0.18 + tri * 0.64
}

function frontWaveX(baseX: number, y: number, height: number, time: number, amount: number) {
  const n1 = Math.sin(y / height * Math.PI * 1.8 + time * 2.4) * amount * height * 0.14
  const n2 = Math.sin(y / height * Math.PI * 4.6 - time * 1.7) * amount * height * 0.07
  const n3 = Math.sin(y / height * Math.PI * 0.7 + time * 0.9) * amount * height * 0.04
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

  const radius = LIQUID_PROGRESS_NODE_RADIUS
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
  const steps = Math.max(36, Math.floor(cssHeight / 3))

  // 从左到右铺满高度的液面
  const body = ctx.createLinearGradient(0, 0, Math.max(frontBase, 1), 0)
  body.addColorStop(0, '#090B16')
  body.addColorStop(0.18, '#0B194A')
  body.addColorStop(0.45, '#0E4FC7')
  body.addColorStop(0.72, '#338FE0')
  body.addColorStop(0.9, '#42B8FA')
  body.addColorStop(1, '#A3EDFF')

  ctx.beginPath()
  ctx.moveTo(0, 0)
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

  if (!sub.reducedMotion) {
    const haze = ctx.createRadialGradient(
      frontBase * 0.55, cssHeight * 0.45, 0,
      frontBase * 0.55, cssHeight * 0.5, Math.max(frontBase, cssHeight) * 0.65,
    )
    haze.addColorStop(0, 'rgba(163,237,255,0.26)')
    haze.addColorStop(0.4, 'rgba(66,184,250,0.1)')
    haze.addColorStop(1, 'rgba(14,79,199,0)')
    ctx.globalAlpha = 0.9
    ctx.fillStyle = haze
    ctx.fillRect(0, 0, frontBase + 8, cssHeight)

    const lagFront = frontBase - cssWidth * 0.04
    ctx.beginPath()
    ctx.moveTo(0, 0)
    for (let i = 0; i <= steps; i += 1) {
      const y = (i / steps) * cssHeight
      ctx.lineTo(Math.max(0, frontWaveX(lagFront, y, cssHeight, time * 0.92 - 0.35, amount * 1.15)), y)
    }
    ctx.lineTo(0, cssHeight)
    ctx.closePath()
    ctx.globalAlpha = 0.18
    ctx.fillStyle = '#42B8FA'
    ctx.fill()
  }

  // 前沿 bloom
  const bloom = ctx.createRadialGradient(
    frontBase, cssHeight * 0.5, 0,
    frontBase, cssHeight * 0.5, Math.min(cssWidth, cssHeight) * 0.55,
  )
  bloom.addColorStop(0, 'rgba(163,237,255,0.55)')
  bloom.addColorStop(0.35, 'rgba(66,184,250,0.22)')
  bloom.addColorStop(1, 'rgba(66,184,250,0)')
  ctx.globalAlpha = 1
  ctx.fillStyle = bloom
  ctx.fillRect(frontBase - cssWidth * 0.12, 0, cssWidth * 0.24, cssHeight)

  if (!sub.reducedMotion) {
    const sheenX = ((time * 0.32) % 1.15) * frontBase
    const sheen = ctx.createLinearGradient(sheenX - 14, 0, sheenX + 20, 0)
    sheen.addColorStop(0, 'rgba(255,255,255,0)')
    sheen.addColorStop(0.5, 'rgba(163,237,255,0.2)')
    sheen.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.globalAlpha = 0.75
    ctx.fillStyle = sheen
    ctx.fillRect(0, 0, frontBase, cssHeight)
  }

  // vignette：压角，叠字更清晰
  const vignette = ctx.createRadialGradient(
    cssWidth * 0.5, cssHeight * 0.42, Math.min(cssWidth, cssHeight) * 0.18,
    cssWidth * 0.5, cssHeight * 0.5, Math.max(cssWidth, cssHeight) * 0.7,
  )
  vignette.addColorStop(0, 'rgba(0,0,0,0)')
  vignette.addColorStop(1, 'rgba(9,11,22,0.32)')
  ctx.globalAlpha = 1
  ctx.fillStyle = vignette
  ctx.fillRect(0, 0, cssWidth, cssHeight)

  if (!sub.reducedMotion) {
    const grains = sub.compact ? 36 : 72
    ctx.globalAlpha = 0.03
    for (let i = 0; i < grains; i += 1) {
      const x = ((i * 47 + time * 36) % cssWidth + cssWidth) % cssWidth
      const y = ((i * 19 + time * 15) % cssHeight + cssHeight) % cssHeight
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

export function liquidProgressBarDebugState() {
  return { subscriberCount: subscribers.size, rafActive: rafId !== 0 }
}
