import { useCallback, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { bobLookAtToward, type BobLauncherLookAt, type BobLauncherPoint } from '../../domain/bobLauncher'

export function useBobLookAt(enabled: boolean, restTarget?: BobLauncherPoint) {
  const nodeRef = useRef<HTMLDivElement | null>(null)
  const hoveringRef = useRef(false)
  const restRef = useRef(restTarget)
  restRef.current = restTarget
  const [lookAt, setLookAt] = useState<BobLauncherLookAt | undefined>()

  const lookToward = useCallback((target?: BobLauncherPoint) => {
    const node = nodeRef.current
    if (!enabled || !node || !target) {
      if (!hoveringRef.current) setLookAt(undefined)
      return
    }
    const box = node.getBoundingClientRect()
    setLookAt(bobLookAtToward(
      { x: box.left + box.width / 2, y: box.top + box.height / 2 },
      target,
      Math.max(box.width, box.height, 36) / 2,
    ))
  }, [enabled])

  useLayoutEffect(() => {
    if (!enabled) {
      hoveringRef.current = false
      setLookAt(undefined)
      return
    }
    if (!hoveringRef.current) lookToward(restTarget)
  }, [enabled, restTarget?.x, restTarget?.y, lookToward])

  const setNode = useCallback((node: HTMLDivElement | null) => {
    nodeRef.current = node
  }, [])

  const onPointerEnter = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!enabled) return
    hoveringRef.current = true
    lookToward({ x: event.clientX, y: event.clientY })
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!enabled || !hoveringRef.current) return
    lookToward({ x: event.clientX, y: event.clientY })
  }

  const onPointerLeave = () => {
    hoveringRef.current = false
    lookToward(restRef.current)
  }

  return { ref: setNode, lookAt, onPointerEnter, onPointerMove, onPointerLeave }
}
