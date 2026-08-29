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
