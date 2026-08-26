export const BOB_LAUNCHER_SIZE = 56
export const BOB_LAUNCHER_DRAG_THRESHOLD = 6

/** 画布 chrome 避让：顶栏、左侧 dock、底部缩放条、右边距。Bob 不是画布节点。 */
export const BOB_LAUNCHER_CHROME = {
  top: 57,
  left: 72,
  right: 10,
  bottom: 50,
}

export type BobLauncherPoint = {
  x: number
  y: number
}

export type BobLauncherViewport = {
  width: number
  height: number
}

export type BobLauncherLookAt = {
  x: number
  y: number
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export function defaultBobLauncherPoint(
  viewport: BobLauncherViewport,
  chrome = BOB_LAUNCHER_CHROME,
  size = BOB_LAUNCHER_SIZE,
): BobLauncherPoint {
  return clampBobLauncherPoint({
    x: viewport.width - size - chrome.right,
    y: (viewport.height - size) / 2,
  }, viewport, chrome, size)
}

export function clampBobLauncherPoint(
  point: BobLauncherPoint,
  viewport: BobLauncherViewport,
  chrome = BOB_LAUNCHER_CHROME,
  size = BOB_LAUNCHER_SIZE,
): BobLauncherPoint {
  const maxX = Math.max(chrome.left, viewport.width - size - chrome.right)
  const maxY = Math.max(chrome.top, viewport.height - size - chrome.bottom)
  return {
    x: clamp(point.x, chrome.left, maxX),
    y: clamp(point.y, chrome.top, maxY),
  }
}

export function bobLauncherDragCommitted(
  distance: number,
  threshold = BOB_LAUNCHER_DRAG_THRESHOLD,
) {
  return distance >= threshold
}

export function bobLauncherPointerDistance(
  start: BobLauncherPoint,
  current: BobLauncherPoint,
) {
  return Math.hypot(current.x - start.x, current.y - start.y)
}

export function bobLauncherLookAt(
  point: BobLauncherPoint,
  pointer: BobLauncherPoint,
  size = BOB_LAUNCHER_SIZE,
): BobLauncherLookAt {
  const radius = Math.max(size / 2, 1)
  return {
    x: clamp((pointer.x - (point.x + size / 2)) / radius, -1, 1),
    y: clamp((pointer.y - (point.y + size / 2)) / radius, -1, 1),
  }
}

export function parseBobLauncherPoint(value: unknown): BobLauncherPoint | null {
  if (!value || typeof value !== 'object') return null
  const record = value as { x?: unknown; y?: unknown }
  if (!Number.isFinite(record.x) || !Number.isFinite(record.y)) return null
  return { x: record.x as number, y: record.y as number }
}
