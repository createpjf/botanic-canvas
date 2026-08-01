import type { AssetGroup, AssetRecord, AssetRole } from './canvas'

const groupRoles: Array<Exclude<AssetRole, '首图'>> = ['商品', '模特', '场景', '调性']

export function normalizeAssetGroupName(value: string) {
  return value.trim().replace(/\s+/g, ' ').slice(0, 40)
}

export function normalizeAssetGroups(groups: AssetGroup[] | undefined, assets?: AssetRecord[]): AssetGroup[] {
  const availableIds = assets ? new Set(assets.map((asset) => asset.id)) : null
  const seenIds = new Set<string>()
  return (Array.isArray(groups) ? groups : []).flatMap((group) => {
    const name = normalizeAssetGroupName(group?.name ?? '')
    if (!group?.id || seenIds.has(group.id) || !name) return []
    seenIds.add(group.id)
    const role = groupRoles.includes(group.role) ? group.role : '场景'
    const assetIds = [...new Set(Array.isArray(group.assetIds) ? group.assetIds : [])]
      .filter((assetId) => !availableIds || availableIds.has(assetId))
    const coverAssetId = group.coverAssetId && assetIds.includes(group.coverAssetId)
      ? group.coverAssetId
      : assetIds[0]
    return [{
      ...group,
      name,
      role,
      assetIds,
      coverAssetId,
      createdAt: Number(group.createdAt) || Date.now(),
      updatedAt: Number(group.updatedAt) || Number(group.createdAt) || Date.now(),
    }]
  })
}

export function upsertCollectionGroups(
  groups: AssetGroup[],
  assets: AssetRecord[],
  now = Date.now(),
): AssetGroup[] {
  const next = groups.map((group) => ({ ...group, assetIds: [...group.assetIds] }))
  const grouped = new Map<string, AssetRecord[]>()
  assets.forEach((asset) => {
    if (!asset.collection || asset.role === '首图') return
    grouped.set(asset.collection, [...(grouped.get(asset.collection) ?? []), asset])
  })
  grouped.forEach((collectionAssets, collection) => {
    const existing = next.find((group) => group.name === collection)
    if (existing) {
      existing.assetIds = [...new Set([...existing.assetIds, ...collectionAssets.map((asset) => asset.id)])]
      existing.coverAssetId = existing.coverAssetId ?? existing.assetIds[0]
      existing.updatedAt = now
      return
    }
    const roleCounts = groupRoles.map((role) => ({
      role,
      count: collectionAssets.filter((asset) => asset.role === role).length,
    }))
    const role = roleCounts.sort((left, right) => right.count - left.count)[0]?.role ?? '场景'
    const assetIds = collectionAssets.map((asset) => asset.id)
    next.push({
      id: `asset-group-${now}-${next.length}`,
      name: collection,
      role,
      assetIds,
      coverAssetId: assetIds[0],
      createdAt: now,
      updatedAt: now,
    })
  })
  return next
}

export function removeAssetFromGroups(groups: AssetGroup[], assetId: string, now = Date.now()) {
  return groups.map((group) => {
    if (!group.assetIds.includes(assetId)) return group
    const assetIds = group.assetIds.filter((id) => id !== assetId)
    return {
      ...group,
      assetIds,
      coverAssetId: group.coverAssetId === assetId ? assetIds[0] : group.coverAssetId,
      updatedAt: now,
    }
  })
}
