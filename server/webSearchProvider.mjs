import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
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
import { assertPublicHttpsUrl, createPinnedLookup } from './webEgressGuard.mjs'

const MAX_DIRECT_FETCH_BYTES = 1_000_000

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

function responseHeader(headers, name) {
  const value = headers?.[name]
  return Array.isArray(value) ? value.join(', ') : String(value ?? '')
}

function readPinnedWebPage(classified, { signal, requestImpl }) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error, result) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve(result)
    }
    let request
    try {
      request = requestImpl(classified.href, {
        method: 'GET',
        headers: { Accept: 'text/html,text/plain;q=0.9' },
        lookup: createPinnedLookup(classified.addresses[0]),
        signal,
      }, (response) => {
        const status = Number(response.statusCode ?? 0)
        const contentType = responseHeader(response.headers, 'content-type')
        if (status < 200 || status >= 300 || !/text\/(html|plain)|application\/xhtml/i.test(contentType)) {
          response.destroy()
          finish(undefined, { status, contentType, bytes: Buffer.alloc(0) })
          return
        }
        const declaredLength = Number(responseHeader(response.headers, 'content-length'))
        if (Number.isFinite(declaredLength) && declaredLength > MAX_DIRECT_FETCH_BYTES) {
          response.destroy()
          finish(undefined, { status, contentType, tooLarge: true, bytes: Buffer.alloc(0) })
          return
        }
        const chunks = []
        let total = 0
        response.on('data', (chunk) => {
          if (settled) return
          const bytes = Buffer.from(chunk)
          total += bytes.length
          if (total > MAX_DIRECT_FETCH_BYTES) {
            response.destroy()
            finish(undefined, { status, contentType, tooLarge: true, bytes: Buffer.alloc(0) })
            return
          }
          chunks.push(bytes)
        })
        response.on('end', () => finish(undefined, {
          status,
          contentType,
          bytes: Buffer.concat(chunks, total),
        }))
        response.on('error', (error) => finish(error))
      })
      request.on('error', (error) => finish(error))
      request.end()
    } catch (error) {
      finish(error)
    }
  })
}

export function createTavilyWebResearch({
  apiKey,
  searchUrl,
  extractUrl,
  fetchImpl = fetch,
  lookup,
  allowLocal = false,
  timeoutMs = 12_000,
  pageRequestImpl,
} = {}) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : ''
  const resolvedSearchUrl = resolveTavilySearchUrl(searchUrl)
  const resolvedExtractUrl = extractUrl ? resolveTavilySearchUrl(extractUrl) : resolveTavilyExtractUrl(searchUrl)

  async function request(url, body, rootSignal) {
    // 根 signal 与本工具 12s timeout 合并；根取消优先归因为取消，而不是 web 超时。
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const signal = rootSignal ? AbortSignal.any([rootSignal, timeoutSignal]) : timeoutSignal
    let response
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: searchHeaders(key),
        body: JSON.stringify(body),
        signal,
      })
    } catch (caught) {
      if (rootSignal?.aborted) throw new AgentToolRuntimeError('REQUEST_CANCELLED', '联网搜索已取消。', 499)
      if (timeoutSignal.aborted) throw new AgentToolRuntimeError('WEB_SEARCH_TIMEOUT', '联网搜索超时，请稍后重试。', 504)
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
    async search(query, { signal: rootSignal } = {}) {
      if (!key) throw new AgentToolRuntimeError('WEB_SEARCH_NOT_CONFIGURED', '尚未配置联网搜索。', 503)
      const normalizedQuery = clampWebSearchQuery(query)
      if (!normalizedQuery) throw new AgentToolRuntimeError('INVALID_TOOL_ARGUMENTS', '搜索词无效。')
      const payload = await request(resolvedSearchUrl, {
        query: normalizedQuery,
        max_results: 5,
        include_answer: false,
        search_depth: 'basic',
      }, rootSignal)
      const hits = normalizeWebSearchHits(payload?.results)
      return { query: normalizedQuery, hitCount: hits.length, hits }
    },
    async extract(url, { signal: rootSignal } = {}) {
      const classified = await assertPublicHttpsUrl(url, { lookup, allowLocal })
      if (!classified.ok) throw new AgentToolRuntimeError('WEB_URL_NOT_ALLOWED', classified.message, 400)
      if (key) {
        const payload = await request(resolvedExtractUrl, { urls: [classified.href] }, rootSignal)
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
      const timeoutSignal = AbortSignal.timeout(timeoutMs)
      const signal = rootSignal ? AbortSignal.any([rootSignal, timeoutSignal]) : timeoutSignal
      let response
      try {
        response = await readPinnedWebPage(classified, {
          signal,
          requestImpl: pageRequestImpl ?? (classified.href.startsWith('http:') ? httpRequest : httpsRequest),
        })
      } catch (caught) {
        if (rootSignal?.aborted) throw new AgentToolRuntimeError('REQUEST_CANCELLED', '网页获取已取消。', 499)
        if (timeoutSignal.aborted) throw new AgentToolRuntimeError('WEB_FETCH_TIMEOUT', '网页获取超时，请稍后重试。', 504)
        throw new AgentToolRuntimeError('WEB_FETCH_UNAVAILABLE', '网页暂时不可用。', 502)
      }
      if (response.status >= 300 && response.status < 400) {
        throw new AgentToolRuntimeError('WEB_FETCH_REDIRECT', '不跟随网页跳转。', 400)
      }
      if (response.status < 200 || response.status >= 300) {
        throw new AgentToolRuntimeError('WEB_FETCH_FAILED', '网页获取失败。', 502)
      }
      if (!/text\/(html|plain)|application\/xhtml/i.test(response.contentType)) {
        throw new AgentToolRuntimeError('WEB_FETCH_UNSUPPORTED', '只读取公开 HTML 或纯文本网页。', 400)
      }
      if (response.tooLarge) throw new AgentToolRuntimeError('WEB_FETCH_TOO_LARGE', '网页过大，已拒绝读取。', 400)
      const html = response.bytes.toString('utf8')
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
