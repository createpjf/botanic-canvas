import {
  DEFAULT_STATUS_COMPONENT_IDS,
  emptyStatusSnapshot,
  mapSelfHostedStatusSnapshot,
  parseStatusSampleFile,
  pruneStatusSamples,
  type StatusComponentId,
  type StatusSample,
  type StatusSampleFile,
  type StatusSnapshot,
} from '../domain/statusPage.ts'

export const DEFAULT_STATUS_PROBE_WEB_URL = 'https://botanic-canvas.vercel.app/'
export const DEFAULT_STATUS_PROBE_API_URL = 'https://api-production-cc46.up.railway.app/api/health'

export type StatusBlobRead =
  | { ok: true; value: unknown }
  | { ok: false; missing: boolean }

export function isSelfReferentialStatusUrl(url: string) {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, '') || '/'
    return path === '/status' || path === '/status.json'
  } catch {
    return false
  }
}

export function defaultProbeTargets(env: Record<string, string | undefined> = {}): Record<string, string> {
  const web = env.STATUS_PROBE_WEB_URL?.trim() || DEFAULT_STATUS_PROBE_WEB_URL
  const api = env.STATUS_PROBE_API_URL?.trim() || DEFAULT_STATUS_PROBE_API_URL
  const auth = env.STATUS_PROBE_AUTH_URL?.trim() || ''
  return auth ? { web, api, auth } : { web, api }
}

export function componentIdsFromTargets(targets: Record<string, string>) {
  return targets.auth ? [...DEFAULT_STATUS_COMPONENT_IDS, 'auth'] : [...DEFAULT_STATUS_COMPONENT_IDS]
}

export async function probeStatusUrl(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs = 8_000,
): Promise<'operational' | 'outage'> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await Promise.race([
      fetchImpl(url, { method: 'GET', signal: controller.signal }),
      new Promise<Response>((_, reject) => {
        const rejectAbort = () => reject(controller.signal.reason ?? new Error('aborted'))
        if (controller.signal.aborted) rejectAbort()
        else controller.signal.addEventListener('abort', rejectAbort, { once: true })
      }),
    ])
    return response.ok ? 'operational' : 'outage'
  } catch {
    return 'outage'
  } finally {
    clearTimeout(timer)
  }
}

export async function collectStatusSample(input: {
  env?: Record<string, string | undefined>
  fetchImpl?: typeof fetch
  now?: () => number
  timeoutMs?: number
} = {}): Promise<StatusSample> {
  const at = new Date((input.now ?? Date.now)()).toISOString()
  const targets = defaultProbeTargets(input.env)
  const fetchImpl = input.fetchImpl ?? fetch
  const checks: StatusSample['checks'] = {}
  await Promise.all(Object.entries(targets).map(async ([id, url]) => {
    if (isSelfReferentialStatusUrl(url)) return
    checks[id as StatusComponentId] = await probeStatusUrl(url, fetchImpl, input.timeoutMs)
  }))
  return { at, checks }
}

export function mergeStatusSampleFile(
  existing: unknown,
  sample: StatusSample,
  fetchedAt: string,
): StatusSampleFile {
  const parsed = parseStatusSampleFile(existing)
  return {
    version: 1,
    updatedAt: fetchedAt,
    samples: pruneStatusSamples([...(parsed?.samples ?? []), sample], fetchedAt),
  }
}

export async function runStatusCollect(input: {
  authorization?: string | null
  cronSecret?: string
  env?: Record<string, string | undefined>
  fetchImpl?: typeof fetch
  now?: () => number
  timeoutMs?: number
  readSamples: () => Promise<StatusBlobRead>
  writeSamples: (file: StatusSampleFile) => Promise<void>
}): Promise<{ status: number; body: unknown }> {
  const secret = input.cronSecret ?? ''
  if (!secret || input.authorization !== `Bearer ${secret}`) {
    return { status: 401, body: { error: 'unauthorized' } }
  }
  const fetchedAt = new Date((input.now ?? Date.now)()).toISOString()
  const sample = await collectStatusSample({
    env: input.env,
    fetchImpl: input.fetchImpl,
    now: input.now,
    timeoutMs: input.timeoutMs,
  })
  const read = await input.readSamples()
  if (!read.ok && !read.missing) return { status: 503, body: { error: 'unavailable' } }
  const existing = read.ok ? read.value : { version: 1, updatedAt: fetchedAt, samples: [] }
  const file = mergeStatusSampleFile(existing, sample, fetchedAt)
  await input.writeSamples(file)
  return { status: 200, body: { ok: true, at: sample.at } }
}

export async function runStatusSnapshot(input: {
  env?: Record<string, string | undefined>
  now?: () => number
  incidents: unknown
  readSamples: () => Promise<StatusBlobRead>
  fetchImpl?: typeof fetch
}): Promise<StatusSnapshot> {
  const fetchedAt = new Date((input.now ?? Date.now)()).toISOString()
  const componentIds = componentIdsFromTargets(defaultProbeTargets(input.env))
  const read = await input.readSamples()
  if (!read.ok && read.missing) {
    return mapSelfHostedStatusSnapshot({
      samples: [],
      incidents: input.incidents,
      fetchedAt,
      componentIds,
      updatedAt: null,
    })
  }
  if (!read.ok) return emptyStatusSnapshot('unavailable', fetchedAt)
  const file = parseStatusSampleFile(read.value)
  if (!file) return emptyStatusSnapshot('unavailable', fetchedAt)
  return mapSelfHostedStatusSnapshot({
    samples: file.samples,
    incidents: input.incidents,
    fetchedAt,
    componentIds,
    updatedAt: file.updatedAt,
  })
}
