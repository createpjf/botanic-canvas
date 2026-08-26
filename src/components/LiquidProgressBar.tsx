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
  /** 矮节点（如 16:9）降低 grain 密度。 */
  compact?: boolean
  className?: string
  'aria-hidden'?: boolean | 'true' | 'false'
}

/**
 * 铺满结果节点媒体区的不定进度画面。
 * 父级 `.result-node__task-state` 需 `position: relative`；本组件绝对定位 inset 0。
 */
export function LiquidProgressBar({
  compact = false,
  className,
  'aria-hidden': ariaHidden = true,
}: LiquidProgressBarProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const hostRef = useRef<HTMLSpanElement | null>(null)
  const subRef = useRef<LiquidSubscriber | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const host = hostRef.current
    if (!canvas || !host) return

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
    observer?.observe(host)

    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
        if (!sub.visible) return
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
        paintLiquidProgressFrame(sub, now)
      })
      : null
    resizeObserver?.observe(host)

    const onVisibility = () => ensureLiquidProgressLoop()
    document.addEventListener('visibilitychange', onVisibility)

    const unregister = registerLiquidProgressSubscriber(sub)

    return () => {
      unregister()
      observer?.disconnect()
      resizeObserver?.disconnect()
      media?.removeEventListener?.('change', onMotion)
      document.removeEventListener('visibilitychange', onVisibility)
      subRef.current = null
    }
  }, [compact])

  useEffect(() => {
    if (subRef.current) subRef.current.compact = compact
  }, [compact])

  return (
    <span
      ref={hostRef}
      className={['liquid-progress-fill', compact ? 'is-compact' : '', className].filter(Boolean).join(' ')}
      aria-hidden={ariaHidden}
    >
      <canvas ref={canvasRef} className="liquid-progress-fill__canvas" />
    </span>
  )
}
