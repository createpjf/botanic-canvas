export type ExclusiveSurfaceAction = boolean | ((open: boolean) => boolean)

export function nextExclusiveSurface<T extends string>(
  current: T | null,
  surface: T,
  action: ExclusiveSurfaceAction,
): T | null {
  const isOpen = current === surface
  const shouldOpen = typeof action === 'function' ? action(isOpen) : action
  if (shouldOpen) return surface
  return isOpen ? null : current
}
