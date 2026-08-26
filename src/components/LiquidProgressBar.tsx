import { useEffect, useRef } from 'react'
import {
  ensureLiquidProgressLoop,
  prefersLiquidReducedMotion,
  paintLiquidProgressFrame,
  registerLiquidProgressSubscriber,
  type LiquidSubscriber,
} from './liquidProgressBarRuntime'

export { liquidProgressBarDebugState, liquidIndeterminateTravel } from './liquidProgressBarRuntime'

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
      reducedMotion: prefersLiquidReducedMotion(),
      compact,
    }
    subRef.current = sub

    const media = typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null
    const onMotion = () => {
      sub.reducedMotion = prefersLiquidReducedMotion()
      ensureLiquidProgressLoop()
    }
    media?.addEventListener?.('change', onMotion)

    const observer = typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver((entries) => {
        const entry = entries[0]
        sub.visible = entry?.isIntersecting ?? true
        ensureLiquidProgressLoop()
      }, { threshold: 0.05 })
      : null
    observer?.observe(canvas)

    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
        if (!sub.visible) return
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
        paintLiquidProgressFrame(sub, now)
      })
      : null
    if (canvas.parentElement) resizeObserver?.observe(canvas.parentElement)

    const onVisibility = () => ensureLiquidProgressLoop()
    document.addEventListener('visibilitychange', onVisibility)

    const onResize = () => {
      if (sub.visible) {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
        paintLiquidProgressFrame(sub, now)
      }
    }
    window.addEventListener('resize', onResize)

    const unregister = registerLiquidProgressSubscriber(sub)

    return () => {
      unregister()
      observer?.disconnect()
      resizeObserver?.disconnect()
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
