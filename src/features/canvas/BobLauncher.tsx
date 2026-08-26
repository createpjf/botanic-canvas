import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type Ref } from 'react'
import { BobCharacter } from '../../components/bob/BobCharacter'
import {
  bobLauncherDragCommitted,
  bobLauncherLookAt,
  bobLauncherPointerDistance,
  clampBobLauncherPoint,
  defaultBobLauncherPoint,
  parseBobLauncherPoint,
  type BobLauncherLookAt,
  type BobLauncherPoint,
} from '../../domain/bobLauncher'

const storagePrefix = 'botanic.bob-launcher.'

function readViewport() {
  return { width: window.innerWidth, height: window.innerHeight }
}

function readStoredPoint(projectId: string): BobLauncherPoint | null {
  try {
    return parseBobLauncherPoint(JSON.parse(window.localStorage.getItem(`${storagePrefix}${projectId}`) ?? ''))
  } catch {
    return null
  }
}

function writeStoredPoint(projectId: string, point: BobLauncherPoint) {
  try {
    window.localStorage.setItem(`${storagePrefix}${projectId}`, JSON.stringify(point))
  } catch {
    // 位置只是本机 UI 记忆，写不进也不影响打开面板。
  }
}

function resolvePoint(projectId: string) {
  const viewport = readViewport()
  return clampBobLauncherPoint(readStoredPoint(projectId) ?? defaultBobLauncherPoint(viewport), viewport)
}

export function BobLauncher({
  projectId,
  buttonRef,
  label,
  onOpen,
}: {
  projectId: string
  buttonRef?: Ref<HTMLButtonElement | null>
  label: string
  onOpen: () => void
}) {
  const [point, setPoint] = useState<BobLauncherPoint>(() => resolvePoint(projectId))
  const [lookAt, setLookAt] = useState<BobLauncherLookAt | undefined>()
  const [hovering, setHovering] = useState(false)
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{
    pointerId: number
    start: BobLauncherPoint
    origin: BobLauncherPoint
    committed: boolean
  } | null>(null)
  const skipClickRef = useRef(false)
  const pointRef = useRef(point)
  pointRef.current = point

  useEffect(() => {
    setPoint(resolvePoint(projectId))
    setLookAt(undefined)
    setHovering(false)
    setDragging(false)
  }, [projectId])

  useEffect(() => {
    const onResize = () => {
      setPoint((current) => {
        const next = clampBobLauncherPoint(current, readViewport())
        writeStoredPoint(projectId, next)
        return next
      })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [projectId])

  const assignLook = useCallback((clientX: number, clientY: number, nextPoint = pointRef.current) => {
    setLookAt(bobLauncherLookAt(nextPoint, { x: clientX, y: clientY }))
  }, [])

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    dragRef.current = {
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      origin: pointRef.current,
      committed: false,
    }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current
    if (drag && drag.pointerId === event.pointerId) {
      const distance = bobLauncherPointerDistance(drag.start, { x: event.clientX, y: event.clientY })
      if (!drag.committed && bobLauncherDragCommitted(distance)) {
        drag.committed = true
        setDragging(true)
        event.currentTarget.setPointerCapture(event.pointerId)
      }
      if (drag.committed) {
        const next = clampBobLauncherPoint({
          x: drag.origin.x + event.clientX - drag.start.x,
          y: drag.origin.y + event.clientY - drag.start.y,
        }, readViewport())
        pointRef.current = next
        setPoint(next)
        assignLook(event.clientX, event.clientY, next)
        return
      }
    }
    if (hovering) assignLook(event.clientX, event.clientY)
  }

  const endPointer = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (drag.committed) {
      skipClickRef.current = true
      writeStoredPoint(projectId, pointRef.current)
      setDragging(false)
    }
  }

  return (
    <button
      ref={buttonRef}
      type="button"
      className={dragging ? 'agent-launcher is-dragging' : 'agent-launcher'}
      style={{ left: point.x, top: point.y }}
      aria-label={label}
      title="Bob"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onPointerEnter={(event) => {
        setHovering(true)
        assignLook(event.clientX, event.clientY)
      }}
      onPointerLeave={() => {
        if (dragRef.current?.committed) return
        setHovering(false)
        setLookAt(undefined)
      }}
      onClick={(event) => {
        if (skipClickRef.current) {
          event.preventDefault()
          skipClickRef.current = false
          return
        }
        onOpen()
      }}
    >
      <BobCharacter mood={hovering || dragging ? 'curious' : 'idle'} lookAt={lookAt} />
    </button>
  )
}
