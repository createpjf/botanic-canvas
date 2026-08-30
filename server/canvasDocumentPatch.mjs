function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

const serverOwnedFields = new Set(['productionWorkflows', 'productionWorkflowRuns'])

function mergeCollection(current, change, label) {
  if (!isRecord(change)) throw new TypeError(`${label} 补丁格式无效。`)
  const upsert = change.upsert ?? []
  const remove = change.remove ?? []
  if (!Array.isArray(upsert) || !Array.isArray(remove)) throw new TypeError(`${label} 补丁格式无效。`)
  if (!upsert.every((item) => isRecord(item) && typeof item.id === 'string' && item.id)) {
    throw new TypeError(`${label} 补丁包含无效项目。`)
  }
  if (!remove.every((id) => typeof id === 'string' && id)) throw new TypeError(`${label} 补丁包含无效删除项。`)

  const removed = new Set(remove)
  const currentById = new Map(current.map((item) => [item.id, item]))
  const preserveMedia = (item) => {
    const existing = currentById.get(item.id)
    if ((item.type === 'asset' || item.type === 'result')
      && existing?.data?.image
      && !item.data?.image) {
      return { ...item, data: { ...item.data, image: existing.data.image } }
    }
    return item
  }
  const replacements = new Map(upsert.map((item) => [item.id, preserveMedia(item)]))
  const merged = current
    .filter((item) => !removed.has(item.id))
    .map((item) => replacements.get(item.id) ?? item)
  const existing = new Set(current.map((item) => item.id))
  for (const item of upsert) {
    if (!existing.has(item.id) && !removed.has(item.id)) merged.push(preserveMedia(item))
  }
  return merged
}

/**
 * 将客户端的最小画布变更合并到当前持久化文档。节点/连线保持原有顺序，
 * 新项目追加到末尾；其余画布字段使用 fields 作为原子替换。
 */
export function applyCanvasDocumentPatch(document, patch) {
  if (!isRecord(document) || !isRecord(patch)) throw new TypeError('画布补丁格式无效。')
  const fields = patch.fields ?? {}
  if (!isRecord(fields) || 'id' in fields || 'nodes' in fields || 'edges' in fields) {
    throw new TypeError('画布补丁字段无效。')
  }

  // 生产工作流由专用发布/运行端点写入。旧画布快照若能在冲突重试时覆盖这两个字段，
  // 刚发布的工作流会被无声删掉；兼容旧客户端时直接忽略，而不是让整次画布保存失败。
  const mutableFields = Object.fromEntries(Object.entries(fields).filter(([key]) => !serverOwnedFields.has(key)))
  const next = { ...document, ...mutableFields }
  if (patch.nodes !== undefined) next.nodes = mergeCollection(document.nodes ?? [], patch.nodes, '节点')
  if (patch.edges !== undefined) next.edges = mergeCollection(document.edges ?? [], patch.edges, '连线')
  return next
}
