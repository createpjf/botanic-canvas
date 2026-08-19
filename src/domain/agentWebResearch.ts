const DEFAULT_TAVILY_SEARCH_URL = 'https://api.tavily.com/search'
const DEFAULT_TAVILY_EXTRACT_URL = 'https://api.tavily.com/extract'
const MAX_SEARCH_HITS = 5
const MAX_SNIPPET = 400
const MAX_TITLE = 160
const MAX_FETCH_TEXT = 4000
const MAX_QUERY = 200

const blockedHostnames = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata.internal',
])

export type PublicHttpUrlResult =
  | { ok: true; href: string; hostname: string; ipLiteral?: string }
  | { ok: false; message: string }

export type WebSearchHit = {
  title: string
  url: string
  snippet: string
  hostname: string
}

export function clampWebSearchQuery(value: unknown) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, MAX_QUERY)
}

export function hostnameFromUrl(value: string) {
  try {
    return new URL(value).hostname
  } catch {
    return undefined
  }
}

export function resolveTavilySearchUrl(raw: string | undefined) {
  if (typeof raw !== 'string' || !raw.trim()) return DEFAULT_TAVILY_SEARCH_URL
  try {
    const url = new URL(raw.trim())
    if (url.protocol !== 'https:') return DEFAULT_TAVILY_SEARCH_URL
    if (url.hostname === 'mcp.tavily.com' || url.pathname.includes('/mcp')) return DEFAULT_TAVILY_SEARCH_URL
    return `${url.origin}${url.pathname}`.replace(/\/$/, '') || DEFAULT_TAVILY_SEARCH_URL
  } catch {
    return DEFAULT_TAVILY_SEARCH_URL
  }
}

export function resolveTavilyExtractUrl(searchUrl: string | undefined) {
  const resolved = resolveTavilySearchUrl(searchUrl)
  return resolved.endsWith('/search') ? resolved.replace(/\/search$/u, '/extract') : DEFAULT_TAVILY_EXTRACT_URL
}

function ipv4FromHostname(hostname: string) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)
  if (!match) return undefined
  const octets = match.slice(1).map(Number)
  if (octets.some((part) => part > 255)) return undefined
  return octets as [number, number, number, number]
}

function canonicalHost(value: string) {
  const lowered = value.trim().toLocaleLowerCase()
  return lowered.startsWith('[') && lowered.endsWith(']') ? lowered.slice(1, -1) : lowered
}

function ipv4MappedFromIpv6(host: string) {
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(host)
  if (dotted) return ipv4FromHostname(dotted[1])
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host)
  if (!hex) return undefined
  const high = Number.parseInt(hex[1], 16)
  const low = Number.parseInt(hex[2], 16)
  return [(high >> 8) & 255, high & 255, (low >> 8) & 255, low & 255] as [number, number, number, number]
}

export function isPrivateIpv4(octets: [number, number, number, number]) {
  const [first, second] = octets
  if (first === 0 || first === 10 || first === 127) return true
  if (first === 169 && second === 254) return true
  if (first === 172 && second >= 16 && second <= 31) return true
  if (first === 192 && second === 168) return true
  return false
}

export function isPrivateIpAddress(value: string) {
  const host = canonicalHost(value)
  const ipv4 = ipv4FromHostname(host)
  if (ipv4) return isPrivateIpv4(ipv4)
  if (!host.includes(':')) return false
  if (host === '::1' || host === '::' || host === '0:0:0:0:0:0:0:1' || host === '0:0:0:0:0:0:0:0') return true
  if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('ff')) return true
  const mapped = ipv4MappedFromIpv6(host)
  return mapped ? isPrivateIpv4(mapped) : false
}

export function classifyPublicHttpUrl(raw: string, { allowLocal = false }: { allowLocal?: boolean } = {}): PublicHttpUrlResult {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, message: '网页地址无效。' }
  let url
  try {
    url = new URL(raw.trim())
  } catch {
    return { ok: false, message: '网页地址无效。' }
  }
  const hostname = canonicalHost(url.hostname)
  const localHost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  if (url.protocol === 'http:') {
    if (!allowLocal || !localHost) return { ok: false, message: '只允许抓取公开 HTTPS 网页。' }
  } else if (url.protocol !== 'https:') {
    return { ok: false, message: '只允许抓取公开 HTTPS 网页。' }
  }
  if (url.username || url.password) return { ok: false, message: '网页地址不能包含用户名或密码。' }
  if (url.port && url.port !== '443' && !(allowLocal && localHost && (url.port === '80' || url.port === '8787'))) {
    return { ok: false, message: '网页地址端口不受支持。' }
  }
  if (!allowLocal && (blockedHostnames.has(hostname) || hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname.endsWith('.localhost'))) {
    return { ok: false, message: '不能抓取内网或本机地址。' }
  }
  const ipv4 = ipv4FromHostname(hostname)
  if (ipv4 && isPrivateIpv4(ipv4) && !allowLocal) return { ok: false, message: '不能抓取内网或本机地址。' }
  if (isPrivateIpAddress(hostname) && !allowLocal) return { ok: false, message: '不能抓取内网或本机地址。' }
  return {
    ok: true,
    href: url.toString(),
    hostname: url.hostname,
    ...(ipv4 || hostname.includes(':') ? { ipLiteral: hostname } : {}),
  }
}

export function normalizeWebSearchHits(results: unknown, limit = MAX_SEARCH_HITS): WebSearchHit[] {
  if (!Array.isArray(results)) return []
  const hits: WebSearchHit[] = []
  for (const item of results) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as { url?: unknown; title?: unknown; content?: unknown; snippet?: unknown }
    const classified = classifyPublicHttpUrl(typeof record.url === 'string' ? record.url : '')
    if (!classified.ok) continue
    const title = typeof record.title === 'string' ? record.title.trim().slice(0, MAX_TITLE) : ''
    const snippet = typeof record.content === 'string'
      ? record.content.trim().slice(0, MAX_SNIPPET)
      : typeof record.snippet === 'string' ? record.snippet.trim().slice(0, MAX_SNIPPET) : ''
    hits.push({
      title: title || classified.hostname,
      url: classified.href,
      snippet,
      hostname: classified.hostname,
    })
    if (hits.length >= limit) break
  }
  return hits
}

export function clipFetchedText(value: unknown, limit = MAX_FETCH_TEXT) {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

export function extractTextFromHtml(html: string, limit = MAX_FETCH_TEXT) {
  const withoutScripts = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/giu, ' ')
  const text = withoutScripts
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
  return clipFetchedText(text, limit)
}
