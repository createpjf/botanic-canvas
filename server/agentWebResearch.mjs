import { BlockList, isIP } from 'node:net'

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

// SSRF 边界按「真正的 global-unicast」放行；RFC1918 之外，云元数据常用的
// 100.64/10、基准测试、文档、组播与保留地址同样不能成为服务端出口目标。
const nonPublicIpv4Ranges = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) nonPublicIpv4Ranges.addSubnet(network, prefix, 'ipv4')
const nonPublicIpv6Ranges = new BlockList()
const globalUnicastIpv6Ranges = new BlockList()
globalUnicastIpv6Ranges.addSubnet('2000::', 3, 'ipv6')
for (const [network, prefix] of [
  ['::', 96],
  ['::', 128],
  ['::1', 128],
  ['::ffff:0.0.0.0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['5f00::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
]) nonPublicIpv6Ranges.addSubnet(network, prefix, 'ipv6')

export function clampWebSearchQuery(value) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, MAX_QUERY)
}

export function hostnameFromUrl(value) {
  try {
    return new URL(value).hostname
  } catch {
    return undefined
  }
}

export function resolveTavilySearchUrl(raw) {
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

export function resolveTavilyExtractUrl(searchUrl) {
  const resolved = resolveTavilySearchUrl(searchUrl)
  return resolved.endsWith('/search') ? resolved.replace(/\/search$/u, '/extract') : DEFAULT_TAVILY_EXTRACT_URL
}

function ipv4FromHostname(hostname) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)
  if (!match) return undefined
  const octets = match.slice(1).map(Number)
  if (octets.some((part) => part > 255)) return undefined
  return octets
}

function canonicalHost(value) {
  const lowered = String(value).trim().toLocaleLowerCase()
  return lowered.startsWith('[') && lowered.endsWith(']') ? lowered.slice(1, -1) : lowered
}

export function isPrivateIpv4(octets) {
  if (!Array.isArray(octets) || octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true
  return nonPublicIpv4Ranges.check(octets.join('.'), 'ipv4')
}

export function isPrivateIpAddress(value) {
  const host = canonicalHost(value)
  const family = isIP(host)
  if (family === 4) return nonPublicIpv4Ranges.check(host, 'ipv4')
  if (family === 6) {
    // IPv6 地址空间仍有大量尚未分配或仅供特殊用途的前缀。denylist 很容易在
    // IANA 分配变化时漏放，因此先限定当前公网单播总段 2000::/3，再排除其中
    // 文档、隧道等特殊用途子段。
    return !globalUnicastIpv6Ranges.check(host, 'ipv6')
      || nonPublicIpv6Ranges.check(host, 'ipv6')
  }
  return false
}

export function classifyPublicHttpUrl(raw, { allowLocal = false } = {}) {
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

export function normalizeWebSearchHits(results, limit = MAX_SEARCH_HITS) {
  if (!Array.isArray(results)) return []
  const hits = []
  for (const item of results) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const classified = classifyPublicHttpUrl(typeof item.url === 'string' ? item.url : '')
    if (!classified.ok) continue
    const title = typeof item.title === 'string' ? item.title.trim().slice(0, MAX_TITLE) : ''
    const snippet = typeof item.content === 'string'
      ? item.content.trim().slice(0, MAX_SNIPPET)
      : typeof item.snippet === 'string' ? item.snippet.trim().slice(0, MAX_SNIPPET) : ''
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

export function clipFetchedText(value, limit = MAX_FETCH_TEXT) {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

export function extractTextFromHtml(html, limit = MAX_FETCH_TEXT) {
  const withoutScripts = String(html ?? '')
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
