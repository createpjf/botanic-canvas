export type AccountMenuAnchor = { left: number; right: number; top: number; bottom: number }

export type AccountMenuPlacement = {
  left: number
  top: number
  originX: number
  originY: number
  placement: 'above' | 'below'
}

export function accountMenuPlacement(
  anchor: AccountMenuAnchor,
  viewport: { width: number; height: number },
  surface = { width: 336, height: 430, gap: 12, margin: 12 },
): AccountMenuPlacement {
  const roomBelow = viewport.height - anchor.bottom
  const placement = roomBelow >= surface.height + surface.gap + surface.margin ? 'below' : 'above'
  const preferredLeft = anchor.right + surface.gap
  const left = Math.min(
    Math.max(surface.margin, viewport.width - surface.width - surface.margin),
    Math.max(surface.margin, preferredLeft),
  )
  const preferredTop = placement === 'below'
    ? anchor.bottom + surface.gap
    : anchor.bottom - surface.height
  const top = Math.min(
    Math.max(surface.margin, viewport.height - surface.height - surface.margin),
    Math.max(surface.margin, preferredTop),
  )

  return {
    left,
    top,
    originX: Math.min(surface.width - 24, Math.max(24, (anchor.left + anchor.right) / 2 - left)),
    originY: placement === 'below' ? 0 : surface.height,
    placement,
  }
}
