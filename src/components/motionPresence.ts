import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export type MotionPhase = 'enter' | 'open' | 'exit'

export function useMotionPresence(open: boolean, exitDuration = 140) {
  const [present, setPresent] = useState(open)
  const [phase, setPhase] = useState<MotionPhase>(open ? 'enter' : 'exit')

  useEffect(() => {
    let frame = 0
    let closeTimer = 0
    if (open) {
      setPresent(true)
      setPhase('enter')
      frame = window.requestAnimationFrame(() => setPhase('open'))
    } else if (present) {
      setPhase('exit')
      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
      closeTimer = window.setTimeout(() => setPresent(false), reducedMotion ? 0 : exitDuration)
    }

    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(closeTimer)
    }
  }, [exitDuration, open, present])

  return { present, phase }
}

export function useRetainedValue<T>(value: T | null | undefined) {
  const retained = useRef<T | null>(value ?? null)
  if (value !== null && value !== undefined) retained.current = value
  return value ?? retained.current
}

export function useRestoreFocus(open: boolean, fallbackTarget: HTMLElement | null = null) {
  const returnFocus = useRef<HTMLElement | null>(null)
  const wasOpen = useRef(false)

  useLayoutEffect(() => {
    let frame = 0
    if (open && !wasOpen.current) {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    } else if (!open && wasOpen.current) {
      const target = fallbackTarget?.isConnected ? fallbackTarget : returnFocus.current
      frame = window.requestAnimationFrame(() => {
        if (target?.isConnected) target.focus({ preventScroll: true })
      })
    }
    wasOpen.current = open
    return () => window.cancelAnimationFrame(frame)
  }, [fallbackTarget, open])
}
