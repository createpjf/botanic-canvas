// @ts-check

import { CanvasAgentQueryError, queryCanvasForAgent } from './canvasAgentQuery.mjs'
import { AGENT_SEMANTIC_EVENT_NAMES, writeAgentSemanticEvent } from '../observability/agentSemanticEvent.mjs'

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


export function assertCanvasQueryActive(context) {
  if (Number.isFinite(context?.deadlineAt) && Date.now() >= context.deadlineAt) {
    throw new CanvasAgentQueryError('AGENT_TURN_DEADLINE_EXCEEDED', 'Agent Turn 已超过本轮时限。')
  }
  if (context?.signal?.aborted) throw new CanvasAgentQueryError('REQUEST_CANCELLED', 'Agent 请求已取消。')
}

export async function queryCanvasWithSemanticSearch(document, raw, config = {}, fetchImpl = globalThis.fetch, context = /** @type {{signal?: AbortSignal, deadlineAt?: number}} */ ({})) {
  assertCanvasQueryActive(context)
  if (!['semantic', 'hybrid'].includes(raw?.mode)) return queryCanvasForAgent(document, raw)
  if (!raw.query || typeof raw.query !== 'string') throw new CanvasAgentQueryError('CANVAS_QUERY_INVALID', '语义检索必须提供 query。')
  if (!config.enabled || !config.apiKey || !config.model || !config.apiBaseUrl || typeof fetchImpl !== 'function') return fallback(document, raw, 'SEMANTIC_SEARCH_DISABLED')
  const startedAt = Date.now()
  // 复用已有 timeout 配置，但只给整次检索一份预算，不为每一批重置。
  const budgetMs = Math.max(1, Math.min(Math.floor(Number(config.timeoutMs) || 5000), 15000))
  const expiresAt = startedAt + budgetMs
  let candidateCount = 0, embeddingRequests = 0, cacheHitCount = 0, outcome = 'completed', reason
  const check = () => {
    assertCanvasQueryActive(context)
    if (Date.now() >= expiresAt) throw new CanvasAgentQueryError('SEMANTIC_SEARCH_TIMEOUT', '语义检索已超过预算。')
  }
  const degrade = (code) => {
    assertCanvasQueryActive(context)
    outcome = 'fallback'; reason = code
    const result = fallback(document, raw, code)
    assertCanvasQueryActive(context)
    return result
  }
  try {
    const candidates = []
    let afterId, sourceHasMore = false
    do {
      check()
      const page = queryCanvasForAgent(document, { ...raw, mode: 'nodes', afterId, edgeAfterId: undefined, limit: 50 })
      candidates.push(...page.nodes)
      /** @type {any} */
      const pageInfo = page.page
      sourceHasMore = pageInfo.hasMore
      afterId = pageInfo.afterId
    } while (sourceHasMore && candidates.length < MAX_SEMANTIC_CANDIDATES)
    const base = { nodes: candidates.slice(0, MAX_SEMANTIC_CANDIDATES), truncated: sourceHasMore }
    candidateCount = base.nodes.length
    const queryText = raw.query.slice(0, 120), candidateTexts = base.nodes.map(safeSearchText)
    const uniqueTexts = [...new Set([queryText, ...candidateTexts])]
    const missingTexts = uniqueTexts.filter((text) => cachedVector(config, text) === undefined)
    cacheHitCount = uniqueTexts.length - missingTexts.length
    for (let start = 0; start < missingTexts.length; start += EMBEDDING_BATCH_SIZE) {
      check()
      const input = missingTexts.slice(start, start + EMBEDDING_BATCH_SIZE)
      const remaining = Math.max(1, Math.min(expiresAt, context.deadlineAt ?? Infinity) - Date.now())
      const timeout = AbortSignal.timeout(remaining)
      const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout
      embeddingRequests++
      const response = await fetchImpl(`${config.apiBaseUrl}/embeddings`, { method: 'POST', headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: config.model, input }), signal })
      check()
      if (!response.ok) return degrade('SEMANTIC_PROVIDER_FAILED')
      /** @type {any} */
      const payload = await response.json()
      check()
      const vectors = payload?.data?.map((item) => item?.embedding)
      if (!Array.isArray(vectors) || vectors.length !== input.length || vectors.some((vector) => !Array.isArray(vector))) return degrade('SEMANTIC_RESPONSE_INVALID')
      input.forEach((text, index) => cacheVector(config, text, vectors[index]))
    }
    const queryVector = cachedVector(config, queryText), candidateVectors = candidateTexts.map((text) => cachedVector(config, text))
    const keywordNodes = []
    let keywordAfterId
    let keywordHasMore = raw.mode === 'hybrid'
    while (keywordHasMore && keywordNodes.length < MAX_SEMANTIC_CANDIDATES) {
      check()
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
    check()
    return { nodes: selected.map(({ node, semantic, score }) => ({ ...node, match: { score, semantic } })), edges: [], page: { returned: selected.length, hasMore, ...(hasMore ? { afterId: selected.at(-1)?.node.id } : {}), edgesTruncated: false, searchTruncated: base.truncated }, search: { requestedMode: raw.mode, effectiveMode: raw.mode, degraded: false } }
  } catch (error) {
    outcome = 'failed'
    assertCanvasQueryActive(context)
    if (Date.now() >= expiresAt || (error instanceof CanvasAgentQueryError && error.code === 'SEMANTIC_SEARCH_TIMEOUT')) return degrade('SEMANTIC_SEARCH_TIMEOUT')
    if (error instanceof CanvasAgentQueryError) throw error
    return degrade('SEMANTIC_PROVIDER_FAILED')
  } finally {
    writeAgentSemanticEvent(AGENT_SEMANTIC_EVENT_NAMES.CANVAS_LIFECYCLE, {
      kind: 'semantic_index', outcome, reason, mode: raw.mode, durationMs: Date.now() - startedAt,
      candidateCount, embeddingRequests, cacheHitCount,
    })
  }
}
