export type BotanicRelease = {
  version: string
  revision: string
}

type ReleaseFetcher = (input: string, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'json'>>

export function parseRelease(value: unknown): BotanicRelease | null {
  if (!value || typeof value !== 'object') return null
  const record = value as { version?: unknown; revision?: unknown }
  const version = typeof record.version === 'string' ? record.version.trim() : ''
  const revision = typeof record.revision === 'string' ? record.revision.trim() : ''
  if (!version && !revision) return null
  return { version, revision }
}

export function isStaleRelease(local: BotanicRelease | null | undefined, published: BotanicRelease | null | undefined) {
  const localRevision = local?.revision?.trim()
  const publishedRevision = published?.revision?.trim()
  return Boolean(localRevision && publishedRevision && localRevision !== publishedRevision)
}

export function formatReleaseLabel(release: BotanicRelease | null | undefined) {
  if (!release) return ''
  if (release.version && release.revision) return `v${release.version} · ${release.revision}`
  if (release.version) return `v${release.version}`
  return release.revision
}

export function readLocalRelease() {
  return parseRelease(__BOTANIC_RELEASE__)
}

export async function fetchPublishedRelease(input: {
  fetch?: ReleaseFetcher
  href?: string
  now?: () => number
} = {}) {
  const fetchImpl = input.fetch ?? globalThis.fetch
  const now = input.now ?? Date.now
  try {
    const response = await fetchImpl(`${input.href ?? '/release.json'}?t=${now()}`, { cache: 'no-store' })
    if (!response.ok) return null
    return parseRelease(await response.json())
  } catch {
    return null
  }
}

export function subscribePublishedRelease(input: {
  enabled: boolean
  onRelease: (release: BotanicRelease | null) => void
  intervalMs?: number
  fetchPublished?: typeof fetchPublishedRelease
  addEventListener?: (type: 'visibilitychange', listener: () => void) => void
  removeEventListener?: (type: 'visibilitychange', listener: () => void) => void
  document?: { visibilityState?: string }
}) {
  if (!input.enabled) return () => {}
  const fetchPublished = input.fetchPublished ?? fetchPublishedRelease
  let cancelled = false
  const check = () => {
    void fetchPublished().then((release) => {
      if (!cancelled) input.onRelease(release)
    })
  }
  check()
  const timer = setInterval(check, input.intervalMs ?? 60_000)
  const onVisible = () => {
    if ((input.document ?? globalThis.document)?.visibilityState === 'visible') check()
  }
  input.addEventListener?.('visibilitychange', onVisible)
  return () => {
    cancelled = true
    clearInterval(timer)
    input.removeEventListener?.('visibilitychange', onVisible)
  }
}
