// ponytail: Function runtime cannot import src/*.ts. Keep in sync with
// src/domain/statusPage.ts and src/lib/statusPageRuntime.ts.

export const STATUS_INCIDENT_LIMIT = 20
export const STATUS_SAMPLE_INTERVAL_SECONDS = 900
export const DEFAULT_STATUS_COMPONENT_IDS = ['web', 'api']
export const DEFAULT_STATUS_PROBE_WEB_URL = 'https://botanic-canvas.vercel.app/'
export const DEFAULT_STATUS_PROBE_API_URL = 'https://api-production-cc46.up.railway.app/api/health'

const LEVEL_RANK = {
  outage: 4,
  degraded: 3,
  maintenance: 2,
  unknown: 1,
  operational: 0,
}

export function mapVendorStatusLevel(value) {
  const key = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (key === 'operational') return 'operational'
  if (key === 'degraded') return 'degraded'
  if (key === 'outage' || key === 'downtime') return 'outage'
  if (key === 'maintenance') return 'maintenance'
  if (key === 'not_monitored') return 'unknown'
  return 'unknown'
}

export function worseStatusLevel(left, right) {
  return LEVEL_RANK[left] >= LEVEL_RANK[right] ? left : right
}

export function emptyStatusSnapshot(loadState, fetchedAt, subscribeUrl = null) {
  return {
    loadState,
    fetchedAt,
    updatedAt: null,
    overall: null,
    components: [],
    incidents: [],
    subscribeUrl,
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asList(value) {
  return Array.isArray(value) ? value : []
}

function utcDay(iso) {
  return new Date(iso).toISOString().slice(0, 10)
}

function addUtcDays(day, delta) {
  const date = new Date(`${day}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + delta)
  return date.toISOString().slice(0, 10)
}

function dayWindow30(fetchedAt) {
  const end = utcDay(fetchedAt)
  return Array.from({ length: 30 }, (_, index) => addUtcDays(end, index - 29))
}

function hourWindow(fetchedAt) {
  const end = Date.parse(fetchedAt)
  const start = end - 24 * 60 * 60 * 1000
  return Array.from({ length: 24 }, (_, index) => ({
    start: new Date(start + index * 3_600_000).toISOString(),
    end: new Date(start + (index + 1) * 3_600_000).toISOString(),
  }))
}

function clampPercent(value) {
  return Math.min(100, Math.max(0, value))
}

function mergeDownMinutes(ranges, windowStart, windowEnd) {
  const clipped = ranges
    .map((range) => ({ start: Math.max(range.start, windowStart), end: Math.min(range.end, windowEnd) }))
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start)
  const merged = []
  for (const range of clipped) {
    const last = merged.at(-1)
    if (!last || range.start > last.end) merged.push({ ...range })
    else last.end = Math.max(last.end, range.end)
  }
  return Math.floor(merged.reduce((sum, range) => sum + (range.end - range.start), 0) / 60_000)
}

function sampleCheck(sample, id) {
  const level = sample.checks[id]
  return level === 'operational' || level === 'outage' ? level : undefined
}

function parseSample(value) {
  if (!isRecord(value) || typeof value.at !== 'string' || Number.isNaN(Date.parse(value.at))) return []
  if (!isRecord(value.checks)) return []
  const checks = {}
  for (const id of ['web', 'api', 'auth']) {
    const level = value.checks[id]
    if (level === 'operational' || level === 'outage') checks[id] = level
  }
  return [{ at: value.at, checks }]
}

function parseIncidentRecords(value) {
  return asList(value).flatMap((row) => {
    if (!isRecord(row)) return []
    const id = typeof row.id === 'string' ? row.id.trim() : ''
    const title = typeof row.title === 'string' ? row.title.trim() : ''
    const startedAt = typeof row.startedAt === 'string' && !Number.isNaN(Date.parse(row.startedAt)) ? row.startedAt : ''
    const level = mapVendorStatusLevel(row.level)
    if (!id || !title || !startedAt || level === 'operational' || level === 'unknown') return []
    const resolvedAt = typeof row.resolvedAt === 'string' && !Number.isNaN(Date.parse(row.resolvedAt))
      ? row.resolvedAt
      : null
    const affected = asList(row.affected).filter((item) => item === 'web' || item === 'api' || item === 'auth')
    const updates = asList(row.updates).flatMap((update) => {
      if (!isRecord(update) || typeof update.at !== 'string' || typeof update.body !== 'string') return []
      if (Number.isNaN(Date.parse(update.at)) || !update.body.trim()) return []
      return [{ at: update.at, body: update.body }]
    }).sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
    return [{ id, title, level, startedAt, resolvedAt, affected, updates }]
  }).sort((left, right) => {
    const leftOpen = left.resolvedAt ? 1 : 0
    const rightOpen = right.resolvedAt ? 1 : 0
    if (leftOpen !== rightOpen) return leftOpen - rightOpen
    return Date.parse(right.startedAt) - Date.parse(left.startedAt)
  })
}

export function parseStatusSampleFile(value) {
  if (!isRecord(value) || value.version !== 1) return null
  const updatedAt = typeof value.updatedAt === 'string' && !Number.isNaN(Date.parse(value.updatedAt))
    ? value.updatedAt
    : ''
  if (!updatedAt) return null
  return { version: 1, updatedAt, samples: asList(value.samples).flatMap(parseSample) }
}

export function pruneStatusSamples(samples, fetchedAt) {
  const firstDay = dayWindow30(fetchedAt)[0]
  return samples
    .flatMap(parseSample)
    .filter((sample) => utcDay(sample.at) >= firstDay)
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
}

export function mapSelfHostedStatusSnapshot(input) {
  const samples = pruneStatusSamples(input.samples, input.fetchedAt)
  const allIncidents = parseIncidentRecords(input.incidents)
  const days = dayWindow30(input.fetchedAt)
  const hours = hourWindow(input.fetchedAt)
  const windowStart = Date.parse(hours[0].start)
  const windowEnd = Date.parse(input.fetchedAt)

  const components = input.componentIds.map((id) => {
    const componentSamples = samples.filter((sample) => sampleCheck(sample, id))
    const last = componentSamples.at(-1)
    const level = last ? sampleCheck(last, id) ?? 'unknown' : 'unknown'
    const relevantIncidents = allIncidents
      .filter((incident) => incident.affected.length === 0 || incident.affected.includes(id))
      .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt))

    const days30 = days.map((day) => {
      const daySamples = componentSamples.filter((sample) => utcDay(sample.at) === day)
      if (!daySamples.length) return { day, level: 'unknown', downtimeSeconds: 0, maintenanceSeconds: 0 }
      const outages = daySamples.filter((sample) => sampleCheck(sample, id) === 'outage').length
      return {
        day,
        level: outages ? 'outage' : 'operational',
        downtimeSeconds: outages * STATUS_SAMPLE_INTERVAL_SECONDS,
        maintenanceSeconds: 0,
      }
    })
    const recorded = days30.filter((cell) => cell.level !== 'unknown')
    const uptime30d = recorded.length
      ? clampPercent((1 - recorded.reduce((sum, cell) => sum + cell.downtimeSeconds, 0) / (recorded.length * 86400)) * 100)
      : null

    const hours24 = hours.map((bucket) => {
      const bucketStart = Date.parse(bucket.start)
      const bucketEnd = Date.parse(bucket.end)
      const bucketSamples = componentSamples.filter((sample) => {
        const at = Date.parse(sample.at)
        return at >= bucketStart && at < bucketEnd
      })
      const sampleLevel = bucketSamples.length
        ? (bucketSamples.some((sample) => sampleCheck(sample, id) === 'outage') ? 'outage' : 'operational')
        : null
      let cellLevel = sampleLevel
      let incidentTitle
      for (const incident of relevantIncidents) {
        const incidentStart = Date.parse(incident.startedAt)
        const incidentEnd = Date.parse(incident.resolvedAt ?? input.fetchedAt)
        if (incidentStart < bucketEnd && incidentEnd > bucketStart) {
          const next = worseStatusLevel(cellLevel ?? 'unknown', incident.level)
          if (!cellLevel || LEVEL_RANK[incident.level] >= LEVEL_RANK[cellLevel]) incidentTitle = incident.title
          cellLevel = next
        }
      }
      if (!cellLevel) return { start: bucket.start, end: bucket.end, level: 'unknown' }
      return { start: bucket.start, end: bucket.end, level: cellLevel, ...(incidentTitle ? { incidentTitle } : {}) }
    })

    const windowSamples = componentSamples.filter((sample) => {
      const at = Date.parse(sample.at)
      return at >= windowStart && at < windowEnd
    })
    const sampleDownMinutes = windowSamples.filter((sample) => sampleCheck(sample, id) === 'outage').length
      * (STATUS_SAMPLE_INTERVAL_SECONDS / 60)
    const incidentDownMinutes = mergeDownMinutes(
      relevantIncidents
        .filter((incident) => incident.level === 'outage' || incident.level === 'degraded')
        .map((incident) => ({
          start: Date.parse(incident.startedAt),
          end: Date.parse(incident.resolvedAt ?? input.fetchedAt),
        })),
      windowStart,
      windowEnd,
    )
    const uptime24h = windowSamples.length
      ? clampPercent((1 - Math.max(sampleDownMinutes, incidentDownMinutes) / 1440) * 100)
      : incidentDownMinutes > 0
        ? clampPercent((1 - incidentDownMinutes / 1440) * 100)
        : null

    return { id, name: id, level, hours24, days30, uptime24h, uptime30d }
  })

  const overall = components.reduce(
    (current, component) => (current ? worseStatusLevel(current, component.level) : component.level),
    null,
  )

  return {
    loadState: 'ready',
    fetchedAt: input.fetchedAt,
    updatedAt: input.updatedAt ?? null,
    overall: overall ?? 'unknown',
    components,
    incidents: allIncidents.slice(0, STATUS_INCIDENT_LIMIT).map(({ affected, ...incident }) => incident),
    subscribeUrl: null,
  }
}

export function isSelfReferentialStatusUrl(url) {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, '') || '/'
    return path === '/status' || path === '/status.json'
  } catch {
    return false
  }
}

export function defaultProbeTargets(env = {}) {
  const web = env.STATUS_PROBE_WEB_URL?.trim() || DEFAULT_STATUS_PROBE_WEB_URL
  const api = env.STATUS_PROBE_API_URL?.trim() || DEFAULT_STATUS_PROBE_API_URL
  const auth = env.STATUS_PROBE_AUTH_URL?.trim() || ''
  return auth ? { web, api, auth } : { web, api }
}

export function componentIdsFromTargets(targets) {
  return targets.auth ? [...DEFAULT_STATUS_COMPONENT_IDS, 'auth'] : [...DEFAULT_STATUS_COMPONENT_IDS]
}

export async function probeStatusUrl(url, fetchImpl, timeoutMs = 8_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await Promise.race([
      fetchImpl(url, { method: 'GET', signal: controller.signal }),
      new Promise((_, reject) => {
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

export async function collectStatusSample(input = {}) {
  const at = new Date((input.now ?? Date.now)()).toISOString()
  const targets = defaultProbeTargets(input.env)
  const fetchImpl = input.fetchImpl ?? fetch
  const checks = {}
  await Promise.all(Object.entries(targets).map(async ([id, url]) => {
    if (isSelfReferentialStatusUrl(url)) return
    checks[id] = await probeStatusUrl(url, fetchImpl, input.timeoutMs)
  }))
  return { at, checks }
}

export function mergeStatusSampleFile(existing, sample, fetchedAt) {
  const parsed = parseStatusSampleFile(existing)
  return {
    version: 1,
    updatedAt: fetchedAt,
    samples: pruneStatusSamples([...(parsed?.samples ?? []), sample], fetchedAt),
  }
}

export async function runStatusCollect(input) {
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

export async function runStatusSnapshot(input) {
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
