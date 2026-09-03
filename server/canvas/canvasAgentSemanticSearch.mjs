// @ts-check

import { CanvasAgentQueryError, queryCanvasForAgent } from './canvasAgentQuery.mjs'

const MAX_SEMANTIC_CANDIDATES = 500
const EMBEDDING_BATCH_SIZE = 50
const MAX_EMBEDDING_CACHE_ENTRIES = 5_000
const embeddingCache = new Map()

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
function cacheKey(config, text) { return JSON.stringify([config.apiBaseUrl, config.model, text]) }
function cachedVector(config, text) {
  const key = cacheKey(config, text), vector = embeddingCache.get(key)
  if (vector !== undefined) { embeddingCache.delete(key); embeddingCache.set(key, vector) }
  return vector
}
function cacheVector(config, text, vector) {
  const key = cacheKey(config, text)
  embeddingCache.delete(key); embeddingCache.set(key, vector)
  while (embeddingCache.size > MAX_EMBEDDING_CACHE_ENTRIES) embeddingCache.delete(embeddingCache.keys().next().value)
}
function fallback(document, raw, reason) {
  const search = { requestedMode: raw.mode, effectiveMode: 'keyword', degraded: true, reason }
  try {
    return { ...queryCanvasForAgent(document, { ...raw, mode: 'keyword', edgeAfterId: undefined }), search }
  } catch (error) {
    if (!(error instanceof CanvasAgentQueryError) || error.code !== 'CANVAS_QUERY_CURSOR_INVALID' || !raw.afterId) throw error
    // 语义游标对 keyword 排序无效。空终页会谎报「已完整」而静默截断剩余结果；
    // 显式重置游标、从 keyword 第一页重来，并在元数据里声明重置。
    return {
      ...queryCanvasForAgent(document, { ...raw, mode: 'keyword', afterId: undefined, edgeAfterId: undefined }),
      search: { ...search, cursorReset: true },
    }
  }
}


export async function queryCanvasWithSemanticSearch(document, raw, config = {}, fetchImpl = globalThis.fetch) {
  if (!['semantic', 'hybrid'].includes(raw?.mode)) return queryCanvasForAgent(document, raw)
  if (!raw.query || typeof raw.query !== 'string') throw new CanvasAgentQueryError('CANVAS_QUERY_INVALID', '语义检索必须提供 query。')
  if (!config.enabled || !config.apiKey || !config.model || !config.apiBaseUrl || typeof fetchImpl !== 'function') return fallback(document, raw, 'SEMANTIC_SEARCH_DISABLED')
  const candidates = []
  let afterId
  let sourceHasMore = false
  do {
    const page = queryCanvasForAgent(document, { ...raw, mode: 'nodes', afterId, edgeAfterId: undefined, limit: 50 })
    candidates.push(...page.nodes)
    /** @type {any} */
    const pageInfo = page.page
    sourceHasMore = pageInfo.hasMore
    afterId = pageInfo.afterId
  } while (sourceHasMore && candidates.length < MAX_SEMANTIC_CANDIDATES)
  const base = { nodes: candidates.slice(0, MAX_SEMANTIC_CANDIDATES), truncated: sourceHasMore }
  try {
    const queryText = raw.query.slice(0, 120), candidateTexts = base.nodes.map(safeSearchText)
    const missingTexts = [...new Set([queryText, ...candidateTexts].filter((text) => cachedVector(config, text) === undefined))]
    for (let start = 0; start < missingTexts.length; start += EMBEDDING_BATCH_SIZE) {
      const input = missingTexts.slice(start, start + EMBEDDING_BATCH_SIZE)
      const response = await fetchImpl(`${config.apiBaseUrl}/embeddings`, { method: 'POST', headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: config.model, input }), signal: AbortSignal.timeout(Math.min(Number(config.timeoutMs) || 5000, 15000)) })
      if (!response.ok) return fallback(document, raw, 'SEMANTIC_PROVIDER_FAILED')
      /** @type {any} */
      const payload = await response.json()
      const vectors = payload?.data?.map((item) => item?.embedding)
      if (!Array.isArray(vectors) || vectors.length !== input.length || vectors.some((vector) => !Array.isArray(vector))) return fallback(document, raw, 'SEMANTIC_RESPONSE_INVALID')
      input.forEach((text, index) => cacheVector(config, text, vectors[index]))
    }
    const queryVector = cachedVector(config, queryText), candidateVectors = candidateTexts.map((text) => cachedVector(config, text))
    const keywordNodes = []
    let keywordAfterId
    let keywordHasMore = raw.mode === 'hybrid'
    while (keywordHasMore && keywordNodes.length < MAX_SEMANTIC_CANDIDATES) {
      const keywordPage = queryCanvasForAgent(document, { ...raw, mode: 'keyword', afterId: keywordAfterId, limit: 50 })
      keywordNodes.push(...keywordPage.nodes)
      /** @type {any} */
      const keywordPageInfo = keywordPage.page
      keywordHasMore = keywordPageInfo.hasMore
      keywordAfterId = keywordPageInfo.afterId
    }
    const keywordById = new Map(keywordNodes.map((node) => [node.id, Number(node.match?.score) || 0]))
    const ranked = base.nodes.map((node, index) => ({ node, semantic: cosine(queryVector, candidateVectors[index]) })).filter((item) => item.semantic !== undefined)
      .map((item) => ({ ...item, semantic: Number(item.semantic), score: Number(item.semantic) + (raw.mode === 'hybrid' ? Math.min(keywordById.get(item.node.id) ?? 0, 100) / 100 : 0) }))
      .sort((left, right) => right.score - left.score || left.node.id.localeCompare(right.node.id))
    const afterIndex = raw.afterId ? ranked.findIndex((item) => item.node.id === raw.afterId) : -1
    if (raw.afterId && afterIndex < 0) throw new CanvasAgentQueryError('CANVAS_QUERY_CURSOR_INVALID', '画布查询游标不属于当前结果集。')
    const limit = Math.max(1, Math.min(Math.floor(Number(raw.limit) || 20), 50)), selected = ranked.slice(afterIndex + 1, afterIndex + 1 + limit)
    const hasMore = afterIndex + 1 + selected.length < ranked.length
    return { nodes: selected.map(({ node, semantic, score }) => ({ ...node, match: { score, semantic } })), edges: [], page: { returned: selected.length, hasMore, ...(hasMore ? { afterId: selected.at(-1)?.node.id } : {}), edgesTruncated: false, searchTruncated: base.truncated }, search: { requestedMode: raw.mode, effectiveMode: raw.mode, degraded: false } }
  } catch (error) {
    if (error instanceof CanvasAgentQueryError) throw error
    return fallback(document, raw, 'SEMANTIC_PROVIDER_FAILED')
  }
}
