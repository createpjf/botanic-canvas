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
  if (key === 'downtime') return 'outage'
  if (key === 'maintenance') return 'maintenance'
  if (key === 'not_monitored') return 'unknown'
  return 'unknown'
}

export function worseStatusLevel(left: StatusLevel, right: StatusLevel): StatusLevel {
  return LEVEL_RANK[left] >= LEVEL_RANK[right] ? left : right
}

export function subscribeUrlFromJsonUrl(jsonUrl: string, override?: string | null) {
  const trimmedOverride = override?.trim()
  if (trimmedOverride) return trimmedOverride
  const trimmed = jsonUrl.trim()
  if (!trimmed) return null
  return trimmed.replace(/\/index\.json$/i, '')
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

function readAffectedIds(attributes: Record<string, unknown>) {
  const rows = asList(attributes.affected_resources)
    .filter(isRecord)
    .map((row) => String(row.status_page_resource_id ?? ''))
    .filter(Boolean)
  return rows
}

export function mapStatusSnapshot(payload: unknown, fetchedAt: string, subscribeUrl: string | null): StatusSnapshot {
  if (!isRecord(payload) || !isRecord(payload.data)) {
    return emptyStatusSnapshot('unavailable', fetchedAt, subscribeUrl)
  }

  const included = asList(payload.included).filter(isRecord)
  const resources = included.filter((item) => item.type === 'status_page_resource')
  const reports = included.filter((item) => item.type === 'status_report')
  const updatesById = new Map(
    included.filter((item) => item.type === 'status_update').map((item) => [String(item.id), item]),
  )

  const sectionOrder = new Map(
    asList(isRecord(payload.data.relationships) ? (payload.data.relationships.sections as { data?: unknown })?.data : [])
      .filter(isRecord)
      .map((item, index) => [String(item.id), index]),
  )

  const incidents: Array<StatusIncident & { affectedIds: string[] }> = reports.flatMap((report) => {
    const attributes = isRecord(report.attributes) ? report.attributes : {}
    const startedAt = typeof attributes.starts_at === 'string' ? attributes.starts_at : ''
    if (!startedAt) return []
    const reportType = typeof attributes.report_type === 'string' ? attributes.report_type : ''
    let level = mapVendorStatusLevel(attributes.aggregate_state)
    if (level === 'unknown' && reportType === 'maintenance') level = 'maintenance'
    const updateRefs = asList(isRecord(report.relationships) ? (report.relationships.status_updates as { data?: unknown })?.data : [])
    const updates = updateRefs.flatMap((ref) => {
      if (!isRecord(ref)) return []
      const update = updatesById.get(String(ref.id))
      const updateAttributes = isRecord(update?.attributes) ? update.attributes : {}
      if (typeof updateAttributes.message !== 'string' || typeof updateAttributes.published_at !== 'string') return []
      return [{ at: updateAttributes.published_at, body: updateAttributes.message }]
    }).sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
    return [{
      id: String(report.id),
      title: typeof attributes.title === 'string' && attributes.title.trim() ? attributes.title : String(report.id),
      level,
      startedAt,
      resolvedAt: typeof attributes.ends_at === 'string' ? attributes.ends_at : null,
      updates,
      affectedIds: readAffectedIds(attributes),
    }]
  }).sort((left, right) => {
    const leftOpen = left.resolvedAt ? 1 : 0
    const rightOpen = right.resolvedAt ? 1 : 0
    if (leftOpen !== rightOpen) return leftOpen - rightOpen
    return Date.parse(right.startedAt) - Date.parse(left.startedAt)
  }).slice(0, STATUS_INCIDENT_LIMIT)

  const days = dayWindow30(fetchedAt)
  const hours = hourWindow(fetchedAt)
  const windowStart = Date.parse(hours[0]!.start)
  const windowEnd = Date.parse(fetchedAt)

  const sortedResources = [...resources].sort((left, right) => {
    const leftAttributes = isRecord(left.attributes) ? left.attributes : {}
    const rightAttributes = isRecord(right.attributes) ? right.attributes : {}
    const leftSection = sectionOrder.get(String(leftAttributes.status_page_section_id ?? '')) ?? Number.MAX_SAFE_INTEGER
    const rightSection = sectionOrder.get(String(rightAttributes.status_page_section_id ?? '')) ?? Number.MAX_SAFE_INTEGER
    if (leftSection !== rightSection) return leftSection - rightSection
    const leftPosition = typeof leftAttributes.position === 'number' ? leftAttributes.position : 0
    const rightPosition = typeof rightAttributes.position === 'number' ? rightAttributes.position : 0
    if (leftPosition !== rightPosition) return leftPosition - rightPosition
    return String(left.id).localeCompare(String(right.id))
  })

  const components: StatusComponent[] = sortedResources.map((resource) => {
    const attributes = isRecord(resource.attributes) ? resource.attributes : {}
    const id = String(resource.id)
    const history = new Map<string, StatusDayCell>()
    for (const row of asList(attributes.status_history)) {
      if (!isRecord(row) || typeof row.day !== 'string') continue
      history.set(row.day, {
        day: row.day,
        level: mapVendorStatusLevel(row.status),
        downtimeSeconds: typeof row.downtime_duration === 'number' ? row.downtime_duration : 0,
        maintenanceSeconds: typeof row.maintenance_duration === 'number' ? row.maintenance_duration : 0,
      })
    }
    const days30 = days.map((day) => history.get(day) ?? {
      day,
      level: 'unknown' as const,
      downtimeSeconds: 0,
      maintenanceSeconds: 0,
    })
    const recorded = days30.filter((cell) => history.has(cell.day))
    const uptime30d = recorded.length
      ? clampPercent((1 - recorded.reduce((sum, cell) => sum + cell.downtimeSeconds, 0) / (recorded.length * 86400)) * 100)
      : null

    const relevantIncidents = incidents
      .filter((incident) => incident.affectedIds.length === 0 || incident.affectedIds.includes(id))
      .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt))
    const hours24 = hours.map((bucket) => {
      const bucketStart = Date.parse(bucket.start)
      const bucketEnd = Date.parse(bucket.end)
      let level: StatusLevel = 'operational'
      let incidentTitle: string | undefined
      for (const incident of relevantIncidents) {
        const incidentEnd = Date.parse(incident.resolvedAt ?? fetchedAt)
        const incidentStart = Date.parse(incident.startedAt)
        if (incidentStart < bucketEnd && incidentEnd > bucketStart) {
          const next = worseStatusLevel(level, incident.level)
          if (LEVEL_RANK[incident.level] >= LEVEL_RANK[level]) incidentTitle = incident.title
          level = next
        }
      }
      return { start: bucket.start, end: bucket.end, level, ...(incidentTitle ? { incidentTitle } : {}) }
    })

    const downRanges = relevantIncidents
      .filter((incident) => incident.level === 'outage' || incident.level === 'degraded')
      .map((incident) => ({
        start: Date.parse(incident.startedAt),
        end: Date.parse(incident.resolvedAt ?? fetchedAt),
      }))

    return {
      id,
      name: typeof attributes.public_name === 'string' && attributes.public_name.trim()
        ? attributes.public_name
        : id,
      level: mapVendorStatusLevel(attributes.status),
      hours24,
      days30,
      uptime24h: clampPercent((1 - mergeDownMinutes(downRanges, windowStart, windowEnd) / 1440) * 100),
      uptime30d,
    }
  })

  const attributes = isRecord(payload.data.attributes) ? payload.data.attributes : {}
  const mappedOverall = typeof attributes.aggregate_state === 'string'
    ? mapVendorStatusLevel(attributes.aggregate_state)
    : components.reduce<StatusLevel | null>((current, component) => (
      current ? worseStatusLevel(current, component.level) : component.level
    ), null)

  return {
    loadState: 'ready',
    fetchedAt,
    updatedAt: typeof attributes.updated_at === 'string' ? attributes.updated_at : null,
    overall: mappedOverall ?? 'unknown',
    components,
    incidents: incidents.map(({ affectedIds: _affectedIds, ...incident }) => incident),
    subscribeUrl,
  }
}
