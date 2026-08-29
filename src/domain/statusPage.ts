export type StatusLevel = 'operational' | 'degraded' | 'outage' | 'maintenance' | 'unknown'
export type StatusLoadState = 'unconfigured' | 'unavailable' | 'ready'

export type StatusHourCell = {
  start: string
  end: string
  level: StatusLevel
  incidentTitle?: string
}

export type StatusDayCell = {
  day: string
  level: StatusLevel
  downtimeSeconds: number
  maintenanceSeconds: number
}

export type StatusComponent = {
  id: string
  name: string
  level: StatusLevel
  hours24: StatusHourCell[]
  days30: StatusDayCell[]
  uptime24h: number | null
  uptime30d: number | null
}

export type StatusIncidentUpdate = { at: string; body: string }

export type StatusIncident = {
  id: string
  title: string
  level: StatusLevel
  startedAt: string
  resolvedAt: string | null
  updates: StatusIncidentUpdate[]
}

export type StatusSnapshot = {
  loadState: StatusLoadState
  fetchedAt: string
  updatedAt: string | null
  overall: StatusLevel | null
  components: StatusComponent[]
  incidents: StatusIncident[]
  subscribeUrl: string | null
}

export const STATUS_INCIDENT_LIMIT = 20
export const STATUS_SAMPLE_INTERVAL_SECONDS = 900
export const DEFAULT_STATUS_COMPONENT_IDS = ['web', 'api'] as const

export type StatusComponentId = 'web' | 'api' | 'auth'
export type StatusCheckLevel = 'operational' | 'outage'

export type StatusSample = {
  at: string
  checks: Partial<Record<StatusComponentId, StatusCheckLevel>>
}

export type StatusSampleFile = {
  version: 1
  updatedAt: string
  samples: StatusSample[]
}

const LEVEL_RANK: Record<StatusLevel, number> = {
  outage: 4,
  degraded: 3,
  maintenance: 2,
  unknown: 1,
  operational: 0,
}

export function isProductStatusPath(pathname: string) {
  return (pathname.replace(/\/+$/, '') || '/') === '/status'
}

export function mapVendorStatusLevel(value: unknown): StatusLevel {
  const key = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (key === 'operational') return 'operational'
  if (key === 'degraded') return 'degraded'
  if (key === 'outage' || key === 'downtime') return 'outage'
  if (key === 'maintenance') return 'maintenance'
  if (key === 'not_monitored') return 'unknown'
  return 'unknown'
}

export function worseStatusLevel(left: StatusLevel, right: StatusLevel): StatusLevel {
  return LEVEL_RANK[left] >= LEVEL_RANK[right] ? left : right
}

export function emptyStatusSnapshot(
  loadState: Exclude<StatusLoadState, 'ready'>,
  fetchedAt: string,
  subscribeUrl: string | null = null,
): StatusSnapshot {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asList(value: unknown) {
  return Array.isArray(value) ? value : []
}

function utcDay(iso: string) {
  return new Date(iso).toISOString().slice(0, 10)
}

function addUtcDays(day: string, delta: number) {
  const date = new Date(`${day}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + delta)
  return date.toISOString().slice(0, 10)
}

function dayWindow30(fetchedAt: string) {
  const end = utcDay(fetchedAt)
  return Array.from({ length: 30 }, (_, index) => addUtcDays(end, index - 29))
}

function hourWindow(fetchedAt: string) {
  const end = Date.parse(fetchedAt)
  const start = end - 24 * 60 * 60 * 1000
  return Array.from({ length: 24 }, (_, index) => ({
    start: new Date(start + index * 3_600_000).toISOString(),
    end: new Date(start + (index + 1) * 3_600_000).toISOString(),
  }))
}

function clampPercent(value: number) {
  return Math.min(100, Math.max(0, value))
}

function mergeDownMinutes(ranges: Array<{ start: number; end: number }>, windowStart: number, windowEnd: number) {
  const clipped = ranges
    .map((range) => ({ start: Math.max(range.start, windowStart), end: Math.min(range.end, windowEnd) }))
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start)
  const merged: Array<{ start: number; end: number }> = []
  for (const range of clipped) {
    const last = merged.at(-1)
    if (!last || range.start > last.end) merged.push({ ...range })
    else last.end = Math.max(last.end, range.end)
  }
  return Math.floor(merged.reduce((sum, range) => sum + (range.end - range.start), 0) / 60_000)
}

function sampleCheck(sample: StatusSample, id: string): StatusCheckLevel | undefined {
  const level = sample.checks[id as StatusComponentId]
  return level === 'operational' || level === 'outage' ? level : undefined
}

function parseSample(value: unknown): StatusSample[] {
  if (!isRecord(value) || typeof value.at !== 'string' || Number.isNaN(Date.parse(value.at))) return []
  if (!isRecord(value.checks)) return []
  const checks: StatusSample['checks'] = {}
  for (const id of ['web', 'api', 'auth'] as const) {
    const level = value.checks[id]
    if (level === 'operational' || level === 'outage') checks[id] = level
  }
  return [{ at: value.at, checks }]
}

function parseIncidentRecords(value: unknown) {
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
    const affected = asList(row.affected).filter((item): item is StatusComponentId => (
      item === 'web' || item === 'api' || item === 'auth'
    ))
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

export function parseStatusSampleFile(value: unknown): StatusSampleFile | null {
  if (!isRecord(value) || value.version !== 1) return null
  const updatedAt = typeof value.updatedAt === 'string' && !Number.isNaN(Date.parse(value.updatedAt))
    ? value.updatedAt
    : ''
  if (!updatedAt) return null
  return {
    version: 1,
    updatedAt,
    samples: asList(value.samples).flatMap(parseSample),
  }
}

export function pruneStatusSamples(samples: StatusSample[], fetchedAt: string) {
  const firstDay = dayWindow30(fetchedAt)[0]!
  return samples
    .flatMap(parseSample)
    .filter((sample) => utcDay(sample.at) >= firstDay)
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
}

export function asClientStatusSnapshot(value: unknown, fetchedAt: string): StatusSnapshot {
  if (!isRecord(value)) return emptyStatusSnapshot('unavailable', fetchedAt)
  if (value.loadState === 'unconfigured' || value.loadState === 'unavailable') {
    return emptyStatusSnapshot(value.loadState, fetchedAt)
  }
  if (value.loadState !== 'ready' || !Array.isArray(value.components) || !Array.isArray(value.incidents)) {
    return emptyStatusSnapshot('unavailable', fetchedAt)
  }
  const overall = value.overall == null ? 'unknown' : mapVendorStatusLevel(value.overall)
  return {
    loadState: 'ready',
    fetchedAt: typeof value.fetchedAt === 'string' ? value.fetchedAt : fetchedAt,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
    overall,
    components: value.components as StatusComponent[],
    incidents: value.incidents as StatusIncident[],
    subscribeUrl: null,
  }
}

export function mapSelfHostedStatusSnapshot(input: {
  samples: StatusSample[]
  incidents: unknown
  fetchedAt: string
  componentIds: string[]
  updatedAt?: string | null
}): StatusSnapshot {
  const samples = pruneStatusSamples(input.samples, input.fetchedAt)
  const allIncidents = parseIncidentRecords(input.incidents)
  const days = dayWindow30(input.fetchedAt)
  const hours = hourWindow(input.fetchedAt)
  const windowStart = Date.parse(hours[0]!.start)
  const windowEnd = Date.parse(input.fetchedAt)

  const components = input.componentIds.map((id) => {
    const componentSamples = samples.filter((sample) => sampleCheck(sample, id))
    const last = componentSamples.at(-1)
    const level: StatusLevel = last ? sampleCheck(last, id) ?? 'unknown' : 'unknown'
    const relevantIncidents = allIncidents
      .filter((incident) => incident.affected.length === 0 || incident.affected.includes(id as StatusComponentId))
      .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt))

    const days30 = days.map((day) => {
      const daySamples = componentSamples.filter((sample) => utcDay(sample.at) === day)
      if (!daySamples.length) {
        return { day, level: 'unknown' as const, downtimeSeconds: 0, maintenanceSeconds: 0 }
      }
      const outages = daySamples.filter((sample) => sampleCheck(sample, id) === 'outage').length
      return {
        day,
        level: outages ? 'outage' as const : 'operational' as const,
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
      let cellLevel: StatusLevel | null = sampleLevel
      let incidentTitle: string | undefined
      for (const incident of relevantIncidents) {
        const incidentStart = Date.parse(incident.startedAt)
        const incidentEnd = Date.parse(incident.resolvedAt ?? input.fetchedAt)
        if (incidentStart < bucketEnd && incidentEnd > bucketStart) {
          const next = worseStatusLevel(cellLevel ?? 'unknown', incident.level)
          if (!cellLevel || LEVEL_RANK[incident.level] >= LEVEL_RANK[cellLevel]) incidentTitle = incident.title
          cellLevel = next
        }
      }
      if (!cellLevel) return { start: bucket.start, end: bucket.end, level: 'unknown' as const }
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

    return {
      id,
      name: id,
      level,
      hours24,
      days30,
      uptime24h,
      uptime30d,
    }
  })

  const overall = components.reduce<StatusLevel | null>(
    (current, component) => (current ? worseStatusLevel(current, component.level) : component.level),
    null,
  )

  return {
    loadState: 'ready',
    fetchedAt: input.fetchedAt,
    updatedAt: input.updatedAt ?? null,
    overall: overall ?? 'unknown',
    components,
    incidents: allIncidents.slice(0, STATUS_INCIDENT_LIMIT).map(({ affected: _affected, ...incident }) => incident),
    subscribeUrl: null,
  }
}
