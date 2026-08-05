import type { AssetNodeData, AssetRecord, CanvasNode, CanvasSnapshot } from '../domain/canvas.ts'

export function cloneTemplateSnapshot(snapshotValue: CanvasSnapshot, prefix: string, timestamp: number) {
  const idMap = new Map<string, string>()
  const nodes = snapshotValue.nodes.map((node, index) => {
    const id = `${prefix}-node-${timestamp}-${index}`
    idMap.set(node.id, id)
    const data = node.type === 'result'
      ? { ...node.data, selected: false, versionId: undefined, parentVersionId: undefined }
      : { ...node.data }
    return {
      ...node,
      id,
      selected: false,
      position: { ...node.position },
      data,
    }
  }) as CanvasNode[]

  const edges = snapshotValue.edges.map((edge, index) => ({
    ...edge,
    id: `${prefix}-edge-${timestamp}-${index}`,
    source: idMap.get(edge.source) ?? edge.source,
    target: idMap.get(edge.target) ?? edge.target,
    style: edge.style ? { ...edge.style } : undefined,
  }))
  return { nodes, edges }
}

export function projectAssetsForTemplate(currentAssets: AssetRecord[], nodes: CanvasNode[], shared: boolean) {
  if (shared) return []
  const referencedAssetIds = new Set(nodes.flatMap((node) => node.type === 'asset'
    ? [(node.data as AssetNodeData).assetId]
    : []))
  return currentAssets
    .filter((asset) => referencedAssetIds.has(asset.id))
    .map((asset) => ({ ...asset, tags: [...asset.tags] }))
}
