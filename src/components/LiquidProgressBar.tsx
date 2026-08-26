import { useEffect, useRef } from 'react'
import type { CanvasGenerationTaskStatus, GenerationMediaKind } from '../domain/canvas'
import { isGenerationLiquidRunningStatus } from '../domain/generationLiquidTravel'
import {
  applyLiquidProgressDrive,
  ensureLiquidProgressLoop,
  prefersLiquidReducedMotion,
  paintLiquidProgressFrame,
  registerLiquidProgressSubscriber,
  type LiquidSubscriber,
} from './liquidProgressBarRuntime'

export { liquidProgressBarDebugState } from './liquidProgressBarRuntime'
export { generationLiquidTravel } from '../domain/generationLiquidTravel'

export type LiquidProgressBarProps = {
  /** 矮节点降低着色缓冲像素上限。 */
  compact?: boolean
  taskStatus?: CanvasGenerationTaskStatus
  submittedAt?: number
  mediaKind?: GenerationMediaKind
  className?: string
  'aria-hidden'?: boolean | 'true' | 'false'
}

/**
 * 铺满结果节点媒体区（跟卡片原比例），液面单次从左到右推进。
 * 推进量跟任务阶段和 submittedAt 对齐，不循环，不显示百分比。
 */
export function LiquidProgressBar({
  compact = false,
  taskStatus,
  submittedAt,
  mediaKind,
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

    const now = Date.now()
    const sub: LiquidSubscriber = {
      canvas,
      visible: true,
      reducedMotion: prefersLiquidReducedMotion(),
      compact,
      taskStatus,
      submittedAt,
      mediaKind,
      mountAt: now,
      runClockStart: isGenerationLiquidRunningStatus(taskStatus) ? (submittedAt ?? now) : undefined,
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
        paintLiquidProgressFrame(sub)
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
    const sub = subRef.current
    if (!sub) return
    sub.compact = compact
    applyLiquidProgressDrive(sub, { taskStatus, submittedAt, mediaKind })
  }, [compact, mediaKind, submittedAt, taskStatus])

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
