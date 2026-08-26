import { useEffect, useRef } from 'react'
import {
  ensureGenerationDotsLoop,
  paintGenerationDotsFrame,
  prefersGenerationDotsReducedMotion,
  registerGenerationDotsSubscriber,
  type DotsSubscriber,
} from './generationDotsFieldRuntime'

export { generationDotsFieldDebugState } from './generationDotsFieldRuntime'

export type GenerationDotsFieldProps = {
  /** 矮节点降低着色缓冲像素上限。 */
  compact?: boolean
  className?: string
  'aria-hidden'?: boolean | 'true' | 'false'
}

/**
 * 铺满结果节点媒体区的 snake 点阵场。
 * 父级 `.result-node__task-state` 需铺满节点内容区。
 */
export function GenerationDotsField({
  compact = false,
  className,
  'aria-hidden': ariaHidden = true,
}: GenerationDotsFieldProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const hostRef = useRef<HTMLSpanElement | null>(null)
  const subRef = useRef<DotsSubscriber | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const host = hostRef.current
    if (!canvas || !host) return

    const sub: DotsSubscriber = {
      canvas,
      visible: true,
      reducedMotion: prefersGenerationDotsReducedMotion(),
      compact,
      startedAt: Date.now(),
    }
    subRef.current = sub

    const media = typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null
    const onMotion = () => {
      sub.reducedMotion = prefersGenerationDotsReducedMotion()
      ensureGenerationDotsLoop()
    }
    media?.addEventListener?.('change', onMotion)

    const observer = typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver((entries) => {
        const entry = entries[0]
        sub.visible = entry?.isIntersecting ?? true
        ensureGenerationDotsLoop()
      }, { threshold: 0.05 })
      : null
    observer?.observe(host)

    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
        if (!sub.visible) return
        paintGenerationDotsFrame(sub)
      })
      : null
    resizeObserver?.observe(host)

    const onVisibility = () => ensureGenerationDotsLoop()
    document.addEventListener('visibilitychange', onVisibility)

    const unregister = registerGenerationDotsSubscriber(sub)

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
      className={['generation-dots-fill', compact ? 'is-compact' : '', className].filter(Boolean).join(' ')}
      aria-hidden={ariaHidden}
    >
      <canvas ref={canvasRef} className="generation-dots-fill__canvas" />
    </span>
  )
}
