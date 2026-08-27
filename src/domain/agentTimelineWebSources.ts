export type TimelineWebSource = {
  hostname: string
  url?: string
  title?: string
}

const MAX_MERGED_WEB_SOURCES = 30

function sourceKey(hostname: string) {
  return displayWebSourceHostname(hostname).toLocaleLowerCase()
}

/** 展示用主机名：去掉前导 www.，不改其余大小写。 */
export function displayWebSourceHostname(hostname: string) {
  return hostname.trim().replace(/^www\./iu, '')
}

/** 站点 pill 只属于联网工具，项目记忆/素材检索即使 kind=search 也不算。 */
export function isWebSourceToolName(name: string | undefined) {
  const normalized = name?.trim().toLocaleLowerCase() ?? ''
  return normalized === 'web_search' || normalized === 'web_fetch' || normalized.startsWith('search_')
}

/** raw 列表里重复的网页搜索行；web_fetch 仍保留。 */
export function isCollapsedWebSearchToolName(name: string | undefined) {
  const normalized = name?.trim().toLocaleLowerCase() ?? ''
  return normalized === 'web_search' || normalized.startsWith('search_')
}

export function mergeTimelineWebSources(
  existing: TimelineWebSource[] | undefined,
  incoming: TimelineWebSource[] | undefined,
): TimelineWebSource[] | undefined {
  if (!existing?.length && !incoming?.length) return undefined
  const merged: TimelineWebSource[] = []
  const seen = new Set<string>()
  for (const source of [...(existing ?? []), ...(incoming ?? [])]) {
    const hostname = source.hostname?.trim()
    if (!hostname) continue
    const key = sourceKey(hostname)
    if (!key || seen.has(key)) continue
    seen.add(key)
    const next: TimelineWebSource = { hostname }
    const url = source.url?.trim()
    if (url) next.url = url
    const title = source.title?.trim()
    if (title) next.title = title
    merged.push(next)
    if (merged.length >= MAX_MERGED_WEB_SOURCES) break
  }
  return merged.length ? merged : undefined
}

function ipv4FromHostname(hostname: string) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)
  if (!match) return undefined
  const octets = match.slice(1).map(Number)
  if (octets.some((part) => part > 255)) return undefined
  return octets
}

function isPrivateIpv4(octets: number[]) {
  const [first, second] = octets
  if (first === 0 || first === 10 || first === 127) return true
  if (first === 169 && second === 254) return true
  if (first === 172 && second >= 16 && second <= 31) return true
  if (first === 192 && second === 168) return true
  return false
}

function isBlockedHost(host: string) {
  if (
    host === 'localhost'
    || host === 'localhost.localdomain'
    || host === 'metadata.google.internal'
    || host === 'metadata.internal'
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || host.endsWith('.localhost')
  ) {
    return true
  }
  const ipv4 = ipv4FromHostname(host)
  if (ipv4 && isPrivateIpv4(ipv4)) return true
  if (!host.includes(':')) return false
  if (host === '::1' || host === '::' || host === '0:0:0:0:0:0:0:1' || host === '0:0:0:0:0:0:0:0') return true
  if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('ff')) return true
  if (/^::ffff:/iu.test(host)) return true
  return false
}

/** 点 pill 只打开已校验的公开 HTTPS；http、凭据、内网一律拒绝。 */
export function timelineWebSourceHref(source: TimelineWebSource): string | null {
  const raw = source.url?.trim() ?? ''
  if (!raw) return null
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'https:') return null
    if (parsed.username || parsed.password) return null
    if (parsed.port && parsed.port !== '443') return null
    const host = parsed.hostname.replace(/^\[|\]$/g, '').toLocaleLowerCase()
    if (!host || isBlockedHost(host)) return null
    return parsed.href
  } catch {
    return null
  }
}
