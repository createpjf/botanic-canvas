export type OverlayLayer = 'agent' | 'account' | 'preview' | 'confirmation'

const overlayPriority: OverlayLayer[] = ['agent', 'account', 'preview', 'confirmation']

export function topOverlayLayer(openLayers: readonly OverlayLayer[]): OverlayLayer | null {
  const open = new Set(openLayers)
  for (let index = overlayPriority.length - 1; index >= 0; index -= 1) {
    const layer = overlayPriority[index]
    if (open.has(layer)) return layer
  }
  return null
}
