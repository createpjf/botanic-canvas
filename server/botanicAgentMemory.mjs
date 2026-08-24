/**
 * Memory V2 选择器：模型只能看到本轮最相关、已确认的项目记忆。
 * 选择器不负责写入；显式的人类保存/评审闭环仍是唯一写入入口。
 */
function normalized(value) {
  return typeof value === 'string' ? value.trim().toLocaleLowerCase('zh-CN') : ''
}

function score(item, query, contextNodeIds) {
  const text = normalized(`${item.id} ${item.kind} ${item.content}`)
  let value = item.confidence === 'confirmed' ? 4 : 1
  if (item.source === 'human') value += 2
  if (query && text.includes(query)) value += 8
  if (contextNodeIds.some((id) => item.sourceNodeIds?.includes(id))) value += 5
  if (item.scope === 'project') value += 1
  return value
}

export function selectBotanicAgentMemory(memory = [], { query = '', contextNodeIds = [], limit = 12 } = {}) {
  const normalizedQuery = normalized(query)
  const nodeIds = [...new Set((contextNodeIds ?? []).filter((id) => typeof id === 'string'))]
  const candidates = (Array.isArray(memory) ? memory : [])
    .filter((item) => item && typeof item.id === 'string' && typeof item.content === 'string')
    // provisional 只作为人工审核候选保留，不可被 Planner/执行层当成品牌事实。
    .filter((item) => item.confidence !== 'provisional')
    .map((item) => ({ item, score: score(item, normalizedQuery, nodeIds) }))
    .filter(({ item, score: value }) => !normalizedQuery || value >= (normalizedQuery ? 8 : 0))
    .sort((left, right) => right.score - left.score || String(left.item.id).localeCompare(String(right.item.id)))
    .slice(0, Math.max(1, Math.min(Number(limit) || 12, 30)))
    .map(({ item }) => item)
  return {
    total: candidates.length,
    items: candidates,
    zeroHit: candidates.length === 0,
  }
}

export function memoryBindingSnapshot(memory = [], options = {}) {
  return selectBotanicAgentMemory(memory, options).items.map((item) => ({
    id: item.id,
    ...(item.version ? { version: item.version } : {}),
    ...(item.contentHash ? { contentHash: item.contentHash } : {}),
    selectionReason: options.query ? `匹配本轮检索「${options.query}」` : '本轮确认的项目记忆',
  }))
}
