import type {
  DeliveryArtifact,
  DeliveryPresetId,
  GenerationMediaKind,
} from './canvas.ts'

export type DeliveryPanelTarget = {
  nodeId: string
  versionId?: string
  image: string
  label: string
}

export type DeliveryDraft = {
  title: string
  subtitle: string
  safeZone: boolean
}

export function canUseForImageDelivery(mediaKind?: GenerationMediaKind) {
  return (mediaKind ?? 'image') !== 'video'
}

export function resolveDeliveryDraft(targetNodeId: string, deliveries: DeliveryArtifact[]): DeliveryDraft {
  const existing = deliveries.find((item) => item.targetNodeId === targetNodeId)
  return existing
    ? { title: existing.title, subtitle: existing.subtitle, safeZone: existing.safeZone }
    : { title: '', subtitle: '', safeZone: true }
}

export function buildDeliveryPreviewArtifacts({
  target,
  presets,
  draft,
  createdAt = Date.now(),
}: {
  target: DeliveryPanelTarget
  presets: DeliveryPresetId[]
  draft: DeliveryDraft
  createdAt?: number
}): DeliveryArtifact[] {
  return presets.map((presetId) => ({
    id: `delivery-preview-${target.nodeId}-${presetId}`,
    targetNodeId: target.nodeId,
    targetVersionId: target.versionId,
    targetLabel: target.label,
    image: target.image,
    presetId,
    title: draft.title.trim(),
    subtitle: draft.subtitle.trim(),
    safeZone: draft.safeZone,
    createdAt,
  }))
}
