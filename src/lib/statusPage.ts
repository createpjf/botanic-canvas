import {
  emptyStatusSnapshot,
  mapStatusSnapshot,
  subscribeUrlFromJsonUrl,
  type StatusSnapshot,
} from '../domain/statusPage.ts'

export function readStatusPageConfig(env: Record<string, string | undefined> = import.meta.env ?? {}) {
  const jsonUrl = env.VITE_STATUS_PAGE_JSON_URL?.trim() || null
  return {
    jsonUrl,
    subscribeUrl: subscribeUrlFromJsonUrl(jsonUrl ?? '', env.VITE_STATUS_PAGE_SUBSCRIBE_URL),
  }
}

export async function loadStatusSnapshot(input: {
  fetchImpl?: typeof fetch
  now?: () => number
  timeoutMs?: number
  jsonUrl?: string | null
  subscribeUrl?: string | null
} = {}): Promise<StatusSnapshot> {
  const fetchedAt = new Date((input.now ?? Date.now)()).toISOString()
  const configured = readStatusPageConfig()
  const jsonUrl = input.jsonUrl !== undefined ? input.jsonUrl : configured.jsonUrl
  const subscribeUrl = input.subscribeUrl !== undefined ? input.subscribeUrl : configured.subscribeUrl
  if (!jsonUrl) return emptyStatusSnapshot('unconfigured', fetchedAt, subscribeUrl)

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
    if (!response.ok) return emptyStatusSnapshot('unavailable', fetchedAt, subscribeUrl)
    return mapStatusSnapshot(await response.json(), fetchedAt, subscribeUrl)
  } catch {
    return emptyStatusSnapshot('unavailable', fetchedAt, subscribeUrl)
  } finally {
    clearTimeout(timer)
  }
}
