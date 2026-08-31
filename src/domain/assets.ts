import type { AssetRecord, GenerationMediaKind } from './canvas'

export function createUploadedAssetId(timestamp: number, index: number) {
  return `upload-${timestamp}-${index}-${crypto.randomUUID()}`
}

/** 兼容旧资产：V21 之前没有 mediaKind 与 collection。 */
export function normalizeAssetMediaKind(value: GenerationMediaKind | undefined): GenerationMediaKind {
  return value === 'video' ? 'video' : 'image'
}

export function normalizeAssetCollection(value: string | undefined) {
  const segments = (value ?? '').split(/[\\/]+/).map((segment) => segment.trim()).filter(Boolean)
  return segments.length ? segments.join(' / ').slice(0, 120) : undefined
}

export function normalizeAssetRecord(asset: AssetRecord, inferredMediaKind?: GenerationMediaKind): AssetRecord {
  return {
    ...asset,
    mediaKind: normalizeAssetMediaKind(asset.mediaKind ?? inferredMediaKind),
    collection: normalizeAssetCollection(asset.collection),
    tags: Array.isArray(asset.tags) ? [...asset.tags] : [],
  }
}
