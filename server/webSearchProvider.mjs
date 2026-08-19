import { AgentToolRuntimeError } from './agentToolRuntime.mjs'
import {
  clampWebSearchQuery,
  clipFetchedText,
  extractTextFromHtml,
  hostnameFromUrl,
  normalizeWebSearchHits,
  resolveTavilyExtractUrl,
  resolveTavilySearchUrl,
} from './agentWebResearch.mjs'
import { assertPublicHttpsUrl } from './webEgressGuard.mjs'

function searchHeaders(apiKey) {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }
}

async function readJson(response) {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

export function createTavilyWebResearch({
  apiKey,
  searchUrl,
  extractUrl,
  fetchImpl = fetch,
  lookup,
  allowLocal = false,
  timeoutMs = 12_000,
} = {}) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : ''
  const resolvedSearchUrl = resolveTavilySearchUrl(searchUrl)
  const resolvedExtractUrl = extractUrl ? resolveTavilySearchUrl(extractUrl) : resolveTavilyExtractUrl(searchUrl)

  async function request(url, body) {
    const signal = AbortSignal.timeout(timeoutMs)
    let response
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: searchHeaders(key),
        body: JSON.stringify(body),
        signal,
      })
    } catch (caught) {
      if (signal.aborted) throw new AgentToolRuntimeError('WEB_SEARCH_TIMEOUT', '联网搜索超时，请稍后重试。', 504)
      throw new AgentToolRuntimeError('WEB_SEARCH_UNAVAILABLE', '联网搜索暂时不可用。', 502)
    }
    const payload = await readJson(response)
    if (!response.ok) throw new AgentToolRuntimeError('WEB_SEARCH_FAILED', '联网搜索失败。', response.status >= 400 ? response.status : 502)
    return payload
  }

  return {
    get enabled() {
      return Boolean(key)
    },
    async search(query) {
      if (!key) throw new AgentToolRuntimeError('WEB_SEARCH_NOT_CONFIGURED', '尚未配置联网搜索。', 503)
      const normalizedQuery = clampWebSearchQuery(query)
      if (!normalizedQuery) throw new AgentToolRuntimeError('INVALID_TOOL_ARGUMENTS', '搜索词无效。')
      const payload = await request(resolvedSearchUrl, {
        query: normalizedQuery,
        max_results: 5,
        include_answer: false,
        search_depth: 'basic',
      })
      const hits = normalizeWebSearchHits(payload?.results)
      return { query: normalizedQuery, hitCount: hits.length, hits }
    },
    async extract(url) {
      const classified = await assertPublicHttpsUrl(url, { lookup, allowLocal })
      if (!classified.ok) throw new AgentToolRuntimeError('WEB_URL_NOT_ALLOWED', classified.message, 400)
      if (key) {
        const payload = await request(resolvedExtractUrl, { urls: [classified.href] })
        const page = Array.isArray(payload?.results) ? payload.results[0] : undefined
        const text = clipFetchedText(page?.raw_content ?? page?.text ?? '')
        if (!text) throw new AgentToolRuntimeError('WEB_FETCH_EMPTY', '该网页没有可读取的正文。', 502)
        return {
          url: classified.href,
          hostname: classified.hostname,
          title: typeof page?.title === 'string' ? page.title.trim().slice(0, 160) : classified.hostname,
          text,
        }
      }
      const signal = AbortSignal.timeout(timeoutMs)
      let response
      try {
        response = await fetchImpl(classified.href, {
          method: 'GET',
          headers: { Accept: 'text/html,text/plain;q=0.9' },
          redirect: 'manual',
          signal,
        })
      } catch (caught) {
        if (signal.aborted) throw new AgentToolRuntimeError('WEB_FETCH_TIMEOUT', '网页获取超时，请稍后重试。', 504)
        throw new AgentToolRuntimeError('WEB_FETCH_UNAVAILABLE', '网页暂时不可用。', 502)
      }
      if (response.status >= 300 && response.status < 400) {
        throw new AgentToolRuntimeError('WEB_FETCH_REDIRECT', '不跟随网页跳转。', 400)
      }
      if (!response.ok) throw new AgentToolRuntimeError('WEB_FETCH_FAILED', '网页获取失败。', 502)
      const contentType = String(response.headers.get('content-type') ?? '')
      if (!/text\/(html|plain)|application\/xhtml/i.test(contentType)) {
        throw new AgentToolRuntimeError('WEB_FETCH_UNSUPPORTED', '只读取公开 HTML 或纯文本网页。', 400)
      }
      const html = await response.text()
      if (html.length > 1_000_000) throw new AgentToolRuntimeError('WEB_FETCH_TOO_LARGE', '网页过大，已拒绝读取。', 400)
      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
      const text = extractTextFromHtml(html)
      if (!text) throw new AgentToolRuntimeError('WEB_FETCH_EMPTY', '该网页没有可读取的正文。', 502)
      return {
        url: classified.href,
        hostname: classified.hostname,
        title: titleMatch ? clipFetchedText(titleMatch[1], 160) : classified.hostname,
        text,
      }
    },
    hostnameFromUrl,
  }
}
