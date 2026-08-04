export type CanvasFileDragState = {
  depth: number
  active: boolean
}

export function hasFileDragPayload(types: readonly string[]): boolean {
  return types.includes('Files')
}

export function resetCanvasFileDrag(): CanvasFileDragState {
  return { depth: 0, active: false }
}

export function beginCanvasFileDrag(
  state: CanvasFileDragState,
  types: readonly string[],
  isCanvasTarget: boolean,
): CanvasFileDragState {
  if (!hasFileDragPayload(types) || !isCanvasTarget) return state
  const depth = state.depth + 1
  return { depth, active: true }
}

export function endCanvasFileDrag(
  state: CanvasFileDragState,
): CanvasFileDragState {
  const depth = Math.max(0, state.depth - 1)
  return { depth, active: depth > 0 }
}
