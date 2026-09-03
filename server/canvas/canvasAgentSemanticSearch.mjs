// @ts-check

import { CanvasAgentQueryError, queryCanvasForAgent } from './canvasAgentQuery.mjs'

function safeSearchText(node) {
  return [node.id, node.type, node.label, node.content, node.status, node.stage].filter(Boolean).join(' ').slice(0, 1400)
}
function cosine(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || !left.length) return undefined
  let dot = 0, leftNorm = 0, rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    const a = Number(left[index]), b = Number(right[index])
    if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined
    dot += a * b; leftNorm += a * a; rightNorm += b * b
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : undefined
}
function fallback(document, raw, reason) {
  return { ...queryCanvasForAgent(document, { ...raw, mode: 'keyword', afterId: undefined, edgeAfterId: undefined }), search: { requestedMode: raw.mode, effectiveMode: 'keyword', degraded: true, reason, ...(raw.afterId ? { cursorReset: true } : {}) } }
}

export async function queryCanvasWithSemanticSearch(document, raw, config = {}, fetchImpl = globalThis.fetch) {
  if (!['semantic', 'hybrid'].includes(raw?.mode)) return queryCanvasForAgent(document, raw)
  if (!raw.query || typeof raw.query !== 'string') throw new CanvasAgentQueryError('CANVAS_QUERY_INVALID', '语义检索必须提供 query。')
  if (!config.enabled || !config.apiKey || !config.model || !config.apiBaseUrl || typeof fetchImpl !== 'function') return fallback(document, raw, 'SEMANTIC_SEARCH_DISABLED')
  const base = queryCanvasForAgent(document, { ...raw, mode: 'nodes', afterId: undefined, edgeAfterId: undefined, limit: 50 })
  try {
    const response = await fetchImpl(`${config.apiBaseUrl}/embeddings`, { method: 'POST', headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: config.model, input: [raw.query.slice(0, 120), ...base.nodes.map(safeSearchText)] }), signal: AbortSignal.timeout(Math.min(Number(config.timeoutMs) || 5000, 15000)) })
    if (!response.ok) return fallback(document, raw, 'SEMANTIC_PROVIDER_FAILED')
    /** @type {any} */
    const payload = await response.json()
    const vectors = payload?.data?.map((item) => item?.embedding)
    if (!Array.isArray(vectors) || vectors.length !== base.nodes.length + 1) return fallback(document, raw, 'SEMANTIC_RESPONSE_INVALID')
    const keyword = raw.mode === 'hybrid' ? queryCanvasForAgent(document, { ...raw, mode: 'keyword', afterId: undefined, limit: 50 }) : { nodes: [] }
    const keywordById = new Map(keyword.nodes.map((node) => [node.id, Number(node.match?.score) || 0]))
    const ranked = base.nodes.map((node, index) => ({ node, semantic: cosine(vectors[0], vectors[index + 1]) })).filter((item) => item.semantic !== undefined)
      .map((item) => ({ ...item, score: item.semantic + (raw.mode === 'hybrid' ? Math.min(keywordById.get(item.node.id) ?? 0, 100) / 100 : 0) }))
      .sort((left, right) => right.score - left.score || left.node.id.localeCompare(right.node.id))
    const afterIndex = raw.afterId ? ranked.findIndex((item) => item.node.id === raw.afterId) : -1
    if (raw.afterId && afterIndex < 0) throw new CanvasAgentQueryError('CANVAS_QUERY_CURSOR_INVALID', '画布查询游标不属于当前结果集。')
    const limit = Math.max(1, Math.min(Math.floor(Number(raw.limit) || 20), 50)), selected = ranked.slice(afterIndex + 1, afterIndex + 1 + limit)
    const hasMore = afterIndex + 1 + selected.length < ranked.length
    return { nodes: selected.map(({ node, semantic, score }) => ({ ...node, match: { score, semantic } })), edges: [], page: { returned: selected.length, hasMore, ...(hasMore ? { afterId: selected.at(-1)?.node.id } : {}), edgesTruncated: false, searchTruncated: base.page.hasMore }, search: { requestedMode: raw.mode, effectiveMode: raw.mode, degraded: false } }
  } catch (error) {
    if (error instanceof CanvasAgentQueryError) throw error
    return fallback(document, raw, 'SEMANTIC_PROVIDER_FAILED')
  }
}
