export type TimelineWebSource = {
  hostname: string
  url?: string
  title?: string
}

const MAX_MERGED_WEB_SOURCES = 30
const MAX_PRESENTATION_WEB_SOURCES = 5
const MAX_SOURCE_CANDIDATES = 30
const MAX_SOURCE_HOSTNAME = 253
const MAX_SOURCE_URL = 2048
const MAX_SOURCE_TITLE = 160

function safeSourceText(value: unknown, maximumLength: number) {
  if (typeof value !== 'string') return undefined
  const clean = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim()
  return clean && clean.length <= maximumLength ? clean : undefined
}

function safeSourceUrl(value: unknown) {
  const raw = safeSourceText(value, MAX_SOURCE_URL)
  if (!raw) return undefined
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return undefined
    if (parsed.port && parsed.port !== '443') return undefined
    return parsed.href
  } catch {
    return undefined
  }
}

function safeSourceHostname(value: unknown) {
  const hostname = safeSourceText(value, MAX_SOURCE_HOSTNAME)
  if (!hostname) return undefined
  try {
    const parsed = new URL(`https://${hostname}/`)
    return sourceKey(parsed.hostname) === sourceKey(hostname) ? hostname : undefined
  } catch {
    return undefined
  }
}

function safeTimelineWebSource(value: unknown): TimelineWebSource | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const hostname = safeSourceHostname(raw.hostname)
  if (!hostname) return undefined
  const source: TimelineWebSource = { hostname }
  if (raw.url !== undefined) {
    const url = safeSourceUrl(raw.url)
    if (!url) return undefined
    if (sourceKey(new URL(url).hostname) !== sourceKey(hostname)) return undefined
    source.url = url
  }
  const title = safeSourceText(raw.title, MAX_SOURCE_TITLE)
  if (title) source.title = title
  return source
}

/** 网络/恢复数据只接受有界展示形状；公开地址判定仍由服务端出网边界负责。 */
export function safeTimelineWebSources(
  value: unknown,
  maximumSources = MAX_PRESENTATION_WEB_SOURCES,
): TimelineWebSource[] | undefined {
  if (!Array.isArray(value)) return undefined
  const cap = Number.isInteger(maximumSources) && maximumSources > 0
    ? Math.min(maximumSources, MAX_MERGED_WEB_SOURCES)
    : MAX_PRESENTATION_WEB_SOURCES
  const sources: TimelineWebSource[] = []
  const seen = new Set<string>()
  for (const item of value.slice(0, MAX_SOURCE_CANDIDATES)) {
    const source = safeTimelineWebSource(item)
    if (!source) continue
    const key = sourceKey(source.hostname)
    if (!key || seen.has(key)) continue
    seen.add(key)
    sources.push(source)
    if (sources.length >= cap) break
  }
  return sources.length ? sources : undefined
}

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
  const candidates = [
    ...(existing ?? []).slice(0, MAX_MERGED_WEB_SOURCES),
    ...(incoming ?? []).slice(0, MAX_MERGED_WEB_SOURCES),
  ]
  for (const source of safeTimelineWebSources(candidates, MAX_MERGED_WEB_SOURCES) ?? []) {
    const key = sourceKey(source.hostname)
    if (!key || seen.has(key)) continue
    seen.add(key)
    merged.push(source)
    if (merged.length >= MAX_MERGED_WEB_SOURCES) break
  }
  return merged.length ? merged : undefined
}

/** 点 pill 只打开有界 HTTPS；公网/私网判定由服务端权威校验，不在浏览器复制安全规则。 */
export function timelineWebSourceHref(source: TimelineWebSource): string | null {
  return safeSourceUrl(source.url) ?? null
}
