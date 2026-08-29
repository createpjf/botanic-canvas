import {
  asClientStatusSnapshot,
  emptyStatusSnapshot,
  type StatusSnapshot,
} from '../domain/statusPage.ts'

const DEFAULT_STATUS_JSON_URL = '/status.json'

export function readStatusPageConfig(env: Record<string, string | undefined> = import.meta.env ?? {}) {
  const raw = env.VITE_STATUS_PAGE_JSON_URL
  return {
    jsonUrl: raw === undefined ? DEFAULT_STATUS_JSON_URL : (raw.trim() || null),
    subscribeUrl: null as string | null,
  }
}

export async function loadStatusSnapshot(input: {
  fetchImpl?: typeof fetch
  now?: () => number
  timeoutMs?: number
  jsonUrl?: string | null
} = {}): Promise<StatusSnapshot> {
  const fetchedAt = new Date((input.now ?? Date.now)()).toISOString()
  const jsonUrl = input.jsonUrl !== undefined ? input.jsonUrl : readStatusPageConfig().jsonUrl
  if (!jsonUrl) return emptyStatusSnapshot('unconfigured', fetchedAt)

  const fetchImpl = input.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 8_000)
  try {
    const response = await Promise.race([
      fetchImpl(jsonUrl, { signal: controller.signal }),
      new Promise<Response>((_, reject) => {
        const rejectAbort = () => reject(controller.signal.reason ?? new Error('aborted'))
        if (controller.signal.aborted) rejectAbort()
        else controller.signal.addEventListener('abort', rejectAbort, { once: true })
      }),
    ])
    if (!response.ok) return emptyStatusSnapshot('unavailable', fetchedAt)
    return asClientStatusSnapshot(await response.json(), fetchedAt)
  } catch {
    return emptyStatusSnapshot('unavailable', fetchedAt)
  } finally {
    clearTimeout(timer)
  }
}
