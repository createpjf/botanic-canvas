# Botanic 系统状态页 Implementation Plan（历史初版）

> ⚠️ 本文仅归档最初的 Better Stack 直连方案，已被[自建数据源规格](../specs/2026-08-29-status-page-self-host-design.md)和现行实现取代，不作为当前实现或执行指令。

**Goal:** 产品内公开 `/status` 画出 Better Stack 驱动的 24 小时 / 30 天状态页，Landing 顶栏给出入口。

**Architecture:** 浏览器直拉 Better Stack `index.json`。`src/domain/statusPage.ts` 收成产品快照；`src/lib/statusPage.ts` 只负责超时与 env；`src/features/status/StatusWorkspace.tsx` 只渲染快照。不经过 Railway，不新建 `/api/status`。

**Tech Stack:** 现有 SPA、`node:test`、Playwright。不新增依赖。

**Spec:** `docs/superpowers/specs/2026-08-29-status-page-design.md`

## Global Constraints

- 不改变幂等键、任务恢复、项目版本冲突、媒体授权、Artifact 级联删除。
- 不把 `/api/health` 的配置倾倒暴露给状态页。
- `src/components/` 不直接访问 Store、网络或服务端。Landing 只加 `<a href="/status">`。
- 普通开发测试不得调用真实 Better Stack；用夹具 JSON 与注入的 `fetchImpl`。
- 只报有广泛影响的事故。产品里不做事故发布台。
- 24 小时格只由事故/维护相交着色，不把组件当前探针态涂进小时桶。
- 30 天格以 `fetchedAt` 的 UTC 日历日为终点，固定 30 个历日；缺日为 `unknown`，不补绿。
- 中英双语，`{ 'zh-CN', en }`。组件名用供应商 `public_name`。
- 注释用中文，只写为什么。

---

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `src/domain/statusPage.ts` | 词表、路径判定、订阅 URL、映射、uptime |
| `src/domain/statusPage.test.ts` | 领域夹具，不发网 |
| `src/lib/statusPage.ts` | 读 `VITE_*`、8s 超时、`fetchImpl` |
| `src/lib/statusPage.test.ts` | 未配置 / 超时 / 非 2xx |
| `src/features/status/StatusWorkspace.tsx` | `/status` 页面 |
| `src/App.tsx` | pathname 门闩；进工作台时离开 `/status` |
| `src/components/ProductLanding.tsx` | 导航链接 |
| `src/styles.css` | `.product-status*` |
| `src/vite-env.d.ts` | env 类型 |
| `.env.example` | 两个 `VITE_STATUS_*` |
| `vercel.json` | CSP |
| `docs/CODEMAP.md` | 一行入口 |
| `playwright.config.ts` | e2e 指向假 JSON URL |
| `e2e/status-page.spec.ts` | 导航 + 夹具 |

不要改 `src/lib/authFlow.ts` 的 `cleanProductAuthUrl`：它已经保留 `pathname`。不要改 `server/`。

---

### Task 1: 路径、级别与空快照

**Files:**
- Create: `src/domain/statusPage.ts`
- Test: `src/domain/statusPage.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `StatusLevel`、`StatusLoadState`、`StatusHourCell`、`StatusDayCell`、`StatusComponent`、`StatusIncidentUpdate`、`StatusIncident`、`StatusSnapshot`
  - `STATUS_INCIDENT_LIMIT = 20`
  - `isProductStatusPath(pathname: string): boolean`
  - `mapVendorStatusLevel(value: unknown): StatusLevel`
  - `worseStatusLevel(left: StatusLevel, right: StatusLevel): StatusLevel`
  - `subscribeUrlFromJsonUrl(jsonUrl: string, override?: string | null): string | null`
  - `emptyStatusSnapshot(loadState: Exclude<StatusLoadState, 'ready'>, fetchedAt: string, subscribeUrl?: string | null): StatusSnapshot`

- [ ] **Step 1: Write the failing test**

创建 `src/domain/statusPage.test.ts`：

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  emptyStatusSnapshot,
  isProductStatusPath,
  mapVendorStatusLevel,
  subscribeUrlFromJsonUrl,
  worseStatusLevel,
} from './statusPage.ts'

test('状态路径只认 /status，忽略尾斜杠', () => {
  assert.equal(isProductStatusPath('/status'), true)
  assert.equal(isProductStatusPath('/status/'), true)
  assert.equal(isProductStatusPath('/'), false)
  assert.equal(isProductStatusPath('/status-page'), false)
  assert.equal(isProductStatusPath('/status/extra'), false)
})

test('供应商状态先 trim 再小写，downtime 映射为 outage', () => {
  assert.equal(mapVendorStatusLevel(' OPERATIONAL '), 'operational')
  assert.equal(mapVendorStatusLevel('Downtime'), 'outage')
  assert.equal(mapVendorStatusLevel('degraded'), 'degraded')
  assert.equal(mapVendorStatusLevel('maintenance'), 'maintenance')
  assert.equal(mapVendorStatusLevel('not_monitored'), 'unknown')
  assert.equal(mapVendorStatusLevel('weird'), 'unknown')
  assert.equal(mapVendorStatusLevel(null), 'unknown')
})

test('更差状态按 outage > degraded > maintenance > unknown > operational', () => {
  assert.equal(worseStatusLevel('operational', 'degraded'), 'degraded')
  assert.equal(worseStatusLevel('degraded', 'outage'), 'outage')
  assert.equal(worseStatusLevel('unknown', 'maintenance'), 'maintenance')
  assert.equal(worseStatusLevel('unknown', 'operational'), 'unknown')
})

test('订阅 URL 优先 override，否则去掉 index.json', () => {
  assert.equal(
    subscribeUrlFromJsonUrl('https://botanic.betteruptime.com/index.json'),
    'https://botanic.betteruptime.com',
  )
  assert.equal(
    subscribeUrlFromJsonUrl('https://botanic.betteruptime.com/index.json', ' https://status.example/ '),
    'https://status.example/',
  )
  assert.equal(subscribeUrlFromJsonUrl(''), null)
})

test('空快照在未接入或无法探测时不带组件', () => {
  const snapshot = emptyStatusSnapshot('unavailable', '2026-08-29T12:00:00.000Z', 'https://status.example')
  assert.equal(snapshot.loadState, 'unavailable')
  assert.equal(snapshot.overall, null)
  assert.deepEqual(snapshot.components, [])
  assert.deepEqual(snapshot.incidents, [])
  assert.equal(snapshot.subscribeUrl, 'https://status.example')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test src/domain/statusPage.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: Write minimal implementation**

创建 `src/domain/statusPage.ts`：

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test src/domain/statusPage.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/domain/statusPage.ts src/domain/statusPage.test.ts
git commit -m "$(cat <<'EOF'
领域：先收状态页的级别与路径判定。

后面的 JSON 映射和 /status 门闩都要共用这一份词表，避免 UI 自己解释 downtime。
EOF
)"
```

---

### Task 2: Better Stack JSON → 快照

**Files:**
- Modify: `src/domain/statusPage.ts`
- Modify: `src/domain/statusPage.test.ts`

**Interfaces:**
- Consumes: Task 1 的类型与 `emptyStatusSnapshot` / `mapVendorStatusLevel` / `worseStatusLevel` / `STATUS_INCIDENT_LIMIT`
- Produces: `mapStatusSnapshot(payload: unknown, fetchedAt: string, subscribeUrl: string | null): StatusSnapshot`

- [ ] **Step 1: Write the failing tests**

把下面追加进 `src/domain/statusPage.test.ts`，并增加 `import { mapStatusSnapshot } from './statusPage.ts'`。

```ts
const fetchedAt = '2026-08-29T12:00:00.000Z'

function resource(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: 'status_page_resource',
    attributes: {
      status_page_section_id: 1,
      public_name: name,
      position: extra.position ?? 0,
      status: extra.status ?? 'operational',
      availability: 12.34,
      status_history: extra.status_history ?? [],
    },
  }
}

function report(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: 'status_report',
    attributes: {
      title: extra.title ?? `Report ${id}`,
      report_type: extra.report_type ?? 'manual',
      starts_at: extra.starts_at ?? '2026-08-29T10:00:00.000Z',
      ends_at: extra.ends_at ?? '2026-08-29T11:00:00.000Z',
      aggregate_state: extra.aggregate_state ?? 'downtime',
      affected_resources: extra.affected_resources ?? [],
    },
    relationships: {
      status_updates: { data: extra.updateRefs ?? [] },
    },
  }
}

test('缺 data 的 payload 是无法探测，不抛错', () => {
  const snapshot = mapStatusSnapshot({ included: [] }, fetchedAt, null)
  assert.equal(snapshot.loadState, 'unavailable')
  assert.equal(snapshot.overall, null)
})

test('30 个历日窗口缺日记 unknown，维护不扣 30 天 uptime，不用供应商 availability', () => {
  const snapshot = mapStatusSnapshot({
    data: {
      type: 'status_page',
      attributes: { aggregate_state: 'Operational', updated_at: '2026-08-29T11:00:00.000Z' },
      relationships: { sections: { data: [{ id: '1', type: 'status_page_section' }] } },
    },
    included: [
      resource('api', 'API', {
        status_history: [
          { day: '2026-08-29', status: 'operational', downtime_duration: 0, maintenance_duration: 0 },
          { day: '2026-08-01', status: 'downtime', downtime_duration: 120, maintenance_duration: 3600 },
        ],
      }),
    ],
  }, fetchedAt, null)

  assert.equal(snapshot.loadState, 'ready')
  assert.equal(snapshot.overall, 'operational')
  assert.equal(snapshot.updatedAt, '2026-08-29T11:00:00.000Z')
  assert.equal(snapshot.components[0]?.days30.length, 30)
  assert.equal(snapshot.components[0]?.days30[0]?.day, '2026-07-31')
  assert.equal(snapshot.components[0]?.days30[0]?.level, 'unknown')
  assert.equal(snapshot.components[0]?.days30.at(-1)?.day, '2026-08-29')
  const first = snapshot.components[0]?.days30.find((cell) => cell.day === '2026-08-01')
  assert.equal(first?.level, 'outage')
  assert.equal(snapshot.components[0]?.uptime30d, (1 - 120 / (2 * 86400)) * 100)
})

test('24 小时格按受影响组件涂色；空 affected 涂全部；维护上色不扣 uptime', () => {
  const snapshot = mapStatusSnapshot({
    data: {
      type: 'status_page',
      attributes: { aggregate_state: 'degraded' },
      relationships: { sections: { data: [{ id: '1', type: 'status_page_section' }] } },
    },
    included: [
      resource('web', 'Web', { position: 0 }),
      resource('api', 'API', { position: 1 }),
      report('outage-api', {
        starts_at: '2026-08-29T10:00:00.000Z',
        ends_at: '2026-08-29T10:30:00.000Z',
        aggregate_state: 'downtime',
        affected_resources: [{ status_page_resource_id: 'api', status: 'downtime' }],
      }),
      report('overlap', {
        title: '重叠中断',
        starts_at: '2026-08-29T10:15:00.000Z',
        ends_at: '2026-08-29T10:45:00.000Z',
        aggregate_state: 'downtime',
        affected_resources: [{ status_page_resource_id: 'api', status: 'downtime' }],
      }),
      report('maint', {
        title: '夜间维护',
        report_type: 'maintenance',
        aggregate_state: 'weird',
        starts_at: '2026-08-29T08:00:00.000Z',
        ends_at: '2026-08-29T09:00:00.000Z',
        affected_resources: [],
      }),
    ],
  }, fetchedAt, null)

  const web = snapshot.components.find((item) => item.id === 'web')
  const api = snapshot.components.find((item) => item.id === 'api')
  const outageHour = api?.hours24.find((cell) => cell.start === '2026-08-29T10:00:00.000Z')
  const maintHour = web?.hours24.find((cell) => cell.start === '2026-08-29T08:00:00.000Z')
  const webOutageHour = web?.hours24.find((cell) => cell.start === '2026-08-29T10:00:00.000Z')
  assert.equal(outageHour?.level, 'outage')
  assert.equal(outageHour?.incidentTitle, '重叠中断')
  assert.equal(webOutageHour?.level, 'operational')
  assert.equal(maintHour?.level, 'maintenance')
  assert.equal(api?.uptime24h, (1 - 45 / 1440) * 100)
  assert.equal(web?.uptime24h, 100)
})

test('进行中事故用 fetchedAt 收口，列表进行中置顶并截 20 条', () => {
  const included = [
    resource('api', 'API'),
    report('open', {
      title: '进行中',
      starts_at: '2026-08-29T11:30:00.000Z',
      ends_at: null,
      aggregate_state: 'degraded',
      updateRefs: [{ id: 'u1', type: 'status_update' }],
    }),
    {
      id: 'u1',
      type: 'status_update',
      attributes: { message: '正在看', published_at: '2026-08-29T11:40:00.000Z' },
    },
    ...Array.from({ length: 21 }, (_, index) => report(`old-${index}`, {
      title: `旧 ${index}`,
      starts_at: `2026-08-28T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
      ends_at: `2026-08-28T${String(index % 24).padStart(2, '0')}:30:00.000Z`,
    })),
  ]
  const snapshot = mapStatusSnapshot({
    data: { type: 'status_page', attributes: { aggregate_state: 'degraded' }, relationships: { sections: { data: [] } } },
    included,
  }, fetchedAt, 'https://status.example')

  assert.equal(snapshot.incidents.length, 20)
  assert.equal(snapshot.incidents[0]?.title, '进行中')
  assert.equal(snapshot.incidents[0]?.resolvedAt, null)
  assert.equal(snapshot.incidents[0]?.updates[0]?.body, '正在看')
  const openHour = snapshot.components[0]?.hours24.find((cell) => cell.start === '2026-08-29T11:00:00.000Z')
  assert.equal(openHour?.level, 'degraded')
  assert.equal(snapshot.subscribeUrl, 'https://status.example')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test src/domain/statusPage.test.ts`

Expected: FAIL，`mapStatusSnapshot` 未导出。

- [ ] **Step 3: Write the mapper**

在 `src/domain/statusPage.ts` 追加。小时桶默认 `operational`：当前探针态不进 24 小时格。

```ts
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

  const incidents: StatusIncident[] = reports.flatMap((report) => {
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

    const relevantIncidents = incidents.filter((incident) => (
      incident.affectedIds.length === 0 || incident.affectedIds.includes(id)
    ))
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
          if (next !== level || !incidentTitle) incidentTitle = incident.title
          if (LEVEL_RANK[incident.level] > LEVEL_RANK[level]) incidentTitle = incident.title
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
```

`affectedIds` 只在映射内部用。若 TypeScript 抱怨对象多了字段，把内部事故类型写成 `StatusIncident & { affectedIds: string[] }`，返回前剥掉。

`incidentTitle` 取该桶内级别最差的那条；同级保留先遇到的即可，但重叠测试里 10:00–10:30 与 10:15–10:45 同为 outage，后一条标题是「重叠中断」。实现时同级也用后出现的更差比较：按 `worseStatusLevel` 后若新事故级别不低于当前，更新标题。上面循环里「同级也换成新标题」才能过「重叠中断」断言。按这段逻辑写：

```ts
if (incidentStart < bucketEnd && incidentEnd > bucketStart) {
  const next = worseStatusLevel(level, incident.level)
  if (LEVEL_RANK[incident.level] >= LEVEL_RANK[level]) incidentTitle = incident.title
  level = next
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test src/domain/statusPage.test.ts`

Expected: PASS。若 `uptime30d` 浮点对不上，用 `assert.ok(Math.abs((snapshot.components[0]?.uptime30d ?? 0) - (1 - 120 / (2 * 86400)) * 100) < 1e-12)`。

- [ ] **Step 5: Commit**

```bash
git add src/domain/statusPage.ts src/domain/statusPage.test.ts
git commit -m "$(cat <<'EOF'
领域：把 Better Stack JSON 收成状态页快照。

30 天用官方日历史，24 小时只用事故相交，避免把探针当前态涂进小时桶。
EOF
)"
```

---

### Task 3: 浏览器拉取

**Files:**
- Create: `src/lib/statusPage.ts`
- Test: `src/lib/statusPage.test.ts`
- Modify: `src/vite-env.d.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `mapStatusSnapshot`、`emptyStatusSnapshot`、`subscribeUrlFromJsonUrl`
- Produces:
  - `readStatusPageConfig(env?: Record<string, string | undefined>): { jsonUrl: string | null; subscribeUrl: string | null }`
  - `loadStatusSnapshot(input?: { fetchImpl?: typeof fetch; now?: () => number; timeoutMs?: number; jsonUrl?: string | null; subscribeUrl?: string | null }): Promise<StatusSnapshot>`

- [ ] **Step 1: Write the failing test**

创建 `src/lib/statusPage.test.ts`：

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadStatusSnapshot, readStatusPageConfig } from './statusPage.ts'

test('未配置 JSON URL 时不发请求', async () => {
  let calls = 0
  const snapshot = await loadStatusSnapshot({
    jsonUrl: null,
    subscribeUrl: null,
    fetchImpl: async () => {
      calls += 1
      return new Response('{}')
    },
  })
  assert.equal(calls, 0)
  assert.equal(snapshot.loadState, 'unconfigured')
})

test('非 2xx 与非法 JSON 都是无法探测', async () => {
  const failed = await loadStatusSnapshot({
    jsonUrl: 'https://status.example.test/index.json',
    fetchImpl: async () => new Response('nope', { status: 503 }),
  })
  assert.equal(failed.loadState, 'unavailable')

  const invalid = await loadStatusSnapshot({
    jsonUrl: 'https://status.example.test/index.json',
    fetchImpl: async () => new Response('{', { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  assert.equal(invalid.loadState, 'unavailable')
})

test('超时视为无法探测', async () => {
  const snapshot = await loadStatusSnapshot({
    jsonUrl: 'https://status.example.test/index.json',
    timeoutMs: 20,
    fetchImpl: () => new Promise(() => {}),
  })
  assert.equal(snapshot.loadState, 'unavailable')
})

test('配置读取：override 优先，空字符串当未配置', () => {
  assert.deepEqual(readStatusPageConfig({
    VITE_STATUS_PAGE_JSON_URL: ' https://botanic.betteruptime.com/index.json ',
    VITE_STATUS_PAGE_SUBSCRIBE_URL: ' https://status.botanic.example ',
  }), {
    jsonUrl: 'https://botanic.betteruptime.com/index.json',
    subscribeUrl: 'https://status.botanic.example',
  })
  assert.deepEqual(readStatusPageConfig({
    VITE_STATUS_PAGE_JSON_URL: '',
  }), { jsonUrl: null, subscribeUrl: null })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test src/lib/statusPage.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: Write the loader**

`src/lib/statusPage.ts`：

```ts
import {
  emptyStatusSnapshot,
  mapStatusSnapshot,
  subscribeUrlFromJsonUrl,
  type StatusSnapshot,
} from '../domain/statusPage.ts'

type StatusPageEnv = {
  VITE_STATUS_PAGE_JSON_URL?: string
  VITE_STATUS_PAGE_SUBSCRIBE_URL?: string
}

export function readStatusPageConfig(env: StatusPageEnv = import.meta.env) {
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
    const response = await fetchImpl(jsonUrl, { signal: controller.signal })
    if (!response.ok) return emptyStatusSnapshot('unavailable', fetchedAt, subscribeUrl)
    return mapStatusSnapshot(await response.json(), fetchedAt, subscribeUrl)
  } catch {
    return emptyStatusSnapshot('unavailable', fetchedAt, subscribeUrl)
  } finally {
    clearTimeout(timer)
  }
}
```

`src/vite-env.d.ts` 追加：

```ts
interface ImportMetaEnv {
  readonly VITE_STATUS_PAGE_JSON_URL?: string
  readonly VITE_STATUS_PAGE_SUBSCRIBE_URL?: string
}
```

`.env.example` 在 `VITE_PERSISTENCE_MODE` 附近追加：

```bash
# 公开状态页。空 = /status 显示未接入。不要把 Better Stack API token 放进 VITE_*。
# VITE_STATUS_PAGE_JSON_URL=https://your-page.betteruptime.com/index.json
# VITE_STATUS_PAGE_SUBSCRIBE_URL=https://your-page.betteruptime.com
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test src/lib/statusPage.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/lib/statusPage.ts src/lib/statusPage.test.ts src/vite-env.d.ts .env.example
git commit -m "$(cat <<'EOF'
前端：状态页只拉公开 JSON，失败当无法探测。

未配置不发网，避免本地和 e2e 误打真实 Better Stack。
EOF
)"
```

---

### Task 4: `/status` 页面、Landing 入口、进工作台离开路径

**Files:**
- Create: `src/features/status/StatusWorkspace.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/ProductLanding.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `isProductStatusPath`、`loadStatusSnapshot`、`StatusSnapshot`、`StatusLevel`
- Produces: `StatusWorkspace` 组件；Landing `href="/status"`；`openIntendedWorkspace` 在 `/status` 上改 pathname 为 `/`

- [ ] **Step 1: 先改会红的路由断言（领域已有路径测试，本步直接落地 UI，用 e2e 在 Task 5 锁行为）**

本任务没有新的 `node:test` 文件：页面是 React，契约由 Task 5 的 Playwright 锁。先写页面和门闩，再在同一次提交前用 `npm run check:architecture` 确认 `ProductLanding.tsx` 没有 import `src/lib/statusPage`。

- [ ] **Step 2: Landing 文案与链接**

`productLandingCopy` 两个语言都加 `statusNav`：`状态` / `Status`。

导航里，工作方式后面加：

```tsx
<a href="/status">{copy.statusNav}</a>
```

不要走 `handleHashNav`。窄屏继续用现有 `.product-landing__nav nav { display: none }`，不单开移动入口。

- [ ] **Step 3: StatusWorkspace**

创建 `src/features/status/StatusWorkspace.tsx`。Props：`isAuthenticated: boolean`、`onEnterWorkspace: () => void`、`ariaHidden?: boolean`。顶栏复用 Landing 的品牌 / 语言 / 登录结构，品牌 `href="/"`，状态链接 `aria-current="page"`。

文案（写在本文件，形状与 `ProductLanding` 相同）：

| key | zh-CN | en |
| --- | --- | --- |
| title | 系统状态 | System status |
| checking | 正在检查系统状态 | Checking system status |
| disclaimer | 这里只列出有广泛影响的事故。个别项目或单次生成问题不会出现。 | This page lists incidents with widespread impact. Isolated project or generation issues do not appear here. |
| noIncidents | 近期没有公开事故 | No public incidents recently |
| subscribe | 订阅通知 | Subscribe to updates |
| updated | 更新于 | Updated |
| ongoing | 进行中 | Ongoing |
| hours | 过去 24 小时 | Last 24 hours |
| days | 过去 30 天 | Last 30 days |
| unconfigured / levels | 与 spec §4.1 表一致 | 与 spec §4.1 表一致 |

`useEffect` 调 `loadStatusSnapshot()`，卸载后丢弃结果。未配置可同步初值：`readStatusPageConfig().jsonUrl` 为空则 `emptyStatusSnapshot('unconfigured', ...)`。已配置时 `snapshot === null` 只显示 `checking`，不要先闪「无法探测」。

结构：`h1` 用 `title`；总状态用 `role="status"`；组件是 `<ul>`，每行名称、当前态、两排格子、两段 `toFixed(2)+'%'`（`null` 显示 `—`）。格子是 `<ol>` 里的 `<li tabIndex={0}>`，`aria-label` 含时间、状态、可选事故名、可选宕机秒数。事故列表进行中标 `ongoing`。页脚：`updatedAt ?? fetchedAt` 本地格式化；有 `subscribeUrl` 才渲染外链，`target="_blank"` `rel="noreferrer"`。

不要 import `src/store` 或 `server/`。

- [ ] **Step 4: App 门闩**

`src/App.tsx`：

1. `import { isProductStatusPath } from './domain/statusPage'`
2. `const StatusWorkspace = lazy(() => import('./features/status/StatusWorkspace'))`
3. 所有 `workspaceRouteRequested(window.location.hash)` 判定在 pathname 为 `/status` 时视为 false。初始 state 不要因为 `/status#/projects` 变成 `ready` / `checking`。
4. `openIntendedWorkspace`：若当前是状态路径，`replaceState` 的 pathname 用 `/`，再拼 search 与目标 hash。不要改 `replaceBrowserHash` 本身，否则只是规范化 hash 也会把人带离 `/status`。
5. 渲染最前：`const statusPage = typeof window !== 'undefined' && isProductStatusPath(window.location.pathname)`。若 `statusPage` 且当前不是必须全屏的 `password-setup`：

```tsx
if (statusPage && state !== 'password-setup') {
  const accessIsDialog = accessOverlayOpen && (state === 'sign-in' || state === 'password-reset' || state === 'checking' || state === 'error')
  return (
    <ProductAppFrame>
      <Suspense fallback={<main className="product-status" aria-busy="true" />}>
        <StatusWorkspace
          isAuthenticated={Boolean(user)}
          onEnterWorkspace={enterWorkspace}
          ariaHidden={accessIsDialog}
        />
      </Suspense>
      {accessIsDialog ? /* 复用现有登录 overlay 那段 main.product-access--overlay，不要在 overlay 后渲染 Landing */ : null}
      <Analytics />
    </ProductAppFrame>
  )
}
```

登录 overlay 从现有 JSX 抽出复用，避免复制整份表单。最小做法：把现在 `return (` 里的 overlay `main` 提成变量 `accessOverlay`，landing 分支与 status 分支共用。

`returnToLanding` 若在 `/status`：`window.history.replaceState(..., '/')` 再 `setState('landing')`，否则关掉 overlay 仍停在状态页也可以；优先「返回产品介绍」回 `/`。

- [ ] **Step 5: CSS**

在 `src/styles.css` 的 `.product-landing` 块附近加 `.product-status`。复用纸色 `#f1f2ed`、品牌绿 `#2a5238`、细线 `#dce1d9`。状态色：

- operational `#2a5238`
- degraded `#9a7b24`
- outage `#8f2d2d`
- maintenance `#3c5d8a`
- unknown `#7a7f76`

格子 `flex` 等高细条，`min-height: 28px`。窄屏组件行改为单列，格子可横向滚动但整页不出现横向溢出。`prefers-reduced-motion` 不要加位移动画。

- [ ] **Step 6: Architecture check**

Run: `npm run check:architecture`

Expected: PASS。`ProductLanding.tsx` 不得出现 `statusPage` 的 lib import。

- [ ] **Step 7: Commit**

```bash
git add src/features/status/StatusWorkspace.tsx src/App.tsx src/components/ProductLanding.tsx src/styles.css
git commit -m "$(cat <<'EOF'
产品：公开 /status，Landing 给出入口。

进工作台时把 pathname 从 /status 换回 /，避免 /status#/projects 被规格判成仍停在状态页。
EOF
)"
```

---

### Task 5: CSP、CODEMAP、e2e

**Files:**
- Modify: `vercel.json`
- Modify: `docs/CODEMAP.md`
- Modify: `playwright.config.ts`
- Create: `e2e/status-page.spec.ts`

**Interfaces:**
- Consumes: Task 4 的 `/status` 与 Landing 链接；假 URL `https://status.example.test/index.json`
- Produces: e2e 覆盖导航 + 夹具渲染

- [ ] **Step 1: Write the failing e2e**

`playwright.config.ts` 的 `webServer.command` 改为：

```ts
command: 'VITE_PERSISTENCE_MODE=local VITE_STATUS_PAGE_JSON_URL=https://status.example.test/index.json npm run dev -- --host 127.0.0.1',
```

创建 `e2e/status-page.spec.ts`：

```ts
import { expect, test, type Page } from '@playwright/test'

const fixture = {
  data: {
    type: 'status_page',
    attributes: {
      aggregate_state: 'operational',
      updated_at: '2026-08-29T11:00:00.000Z',
    },
    relationships: { sections: { data: [{ id: '1', type: 'status_page_section' }] } },
  },
  included: [
    {
      id: 'web',
      type: 'status_page_resource',
      attributes: {
        status_page_section_id: 1,
        public_name: '工作台',
        position: 0,
        status: 'operational',
        status_history: [
          { day: '2026-08-29', status: 'operational', downtime_duration: 0, maintenance_duration: 0 },
        ],
      },
    },
    {
      id: 'inc-1',
      type: 'status_report',
      attributes: {
        title: 'API 短暂中断',
        report_type: 'manual',
        starts_at: '2026-08-28T10:00:00.000Z',
        ends_at: '2026-08-28T10:10:00.000Z',
        aggregate_state: 'downtime',
        affected_resources: [],
      },
      relationships: { status_updates: { data: [] } },
    },
  ],
}

async function stubStatus(page: Page) {
  await page.route('https://status.example.test/index.json', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) })
  })
  await page.route('**/api/health', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"ok"}' })
  })
}

test('Landing 状态导航进入 /status 并展示夹具组件', async ({ page }) => {
  await stubStatus(page)
  await page.goto('/')
  await page.getByRole('link', { name: '状态' }).click()
  await expect(page).toHaveURL(/\/status\/?$/)
  await expect(page.getByRole('heading', { name: '系统状态' })).toBeVisible()
  await expect(page.getByRole('status')).toContainText('全部正常')
  await expect(page.getByText('工作台')).toBeVisible()
  await expect(page.getByText('API 短暂中断')).toBeVisible()
  await expect(page.getByRole('link', { name: '订阅通知' })).toHaveAttribute('href', 'https://status.example.test')
})

test('/status#/projects 仍是状态页，不打开项目库', async ({ page }) => {
  await stubStatus(page)
  await page.goto('/status#/projects')
  await expect(page.getByRole('heading', { name: '系统状态' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '创意项目', exact: true })).toHaveCount(0)
})
```

- [ ] **Step 2: Run e2e to see it fail or pass**

Run: `npx playwright test e2e/status-page.spec.ts`

若 Task 4 已正确，应变绿。若导航或夹具未接上，按失败信息补。

- [ ] **Step 3: CSP 与 CODEMAP**

`vercel.json` 的 `connect-src` 在 Railway 项后追加 `https://*.betteruptime.com https://*.betterstack.com`。自定义域名上线时再加具体 origin，本任务不编造域名。

`docs/CODEMAP.md` 快速定位表在「应用登录与入口」下加一行：

| 需求/行为 | 首要入口 | 相关实现 | 聚焦测试与不变量 |
| --- | --- | --- | --- |
| 公开系统状态页 | `src/features/status/StatusWorkspace.tsx` | `src/domain/statusPage.ts`、`src/lib/statusPage.ts`、`src/App.tsx` pathname 门闩、`ProductLanding.tsx` 导航 | `src/domain/statusPage.test.ts`、`src/lib/statusPage.test.ts`、`e2e/status-page.spec.ts`；直拉 Better Stack 公开 JSON；`/api/health` 不进页面；`/status#/projects` 不当工作台 |

- [ ] **Step 4: Re-run e2e**

Run: `npx playwright test e2e/status-page.spec.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add vercel.json docs/CODEMAP.md playwright.config.ts e2e/status-page.spec.ts
git commit -m "$(cat <<'EOF'
状态页补上 CSP、代码地图和公开页 e2e。

e2e 只打 status.example.test，并用路由喂夹具，避免 CI 依赖真实供应商。
EOF
)"
```

---

### Task 6: 门禁

**Files:** 无新文件。

**Interfaces:**
- Consumes: Task 1–5 的全部提交
- Produces: 仓库门禁绿

- [ ] **Step 1: 聚焦测试**

Run:

```bash
node --experimental-strip-types --test src/domain/statusPage.test.ts src/lib/statusPage.test.ts
npx playwright test e2e/status-page.spec.ts
```

Expected: PASS。

- [ ] **Step 2: 全量门禁**

Run:

```bash
npm test
npm run check:architecture
npm run check:security
npm run build
git diff --check
```

Expected: 全绿。`check:architecture` 不得出现 `ui-cannot-import-infrastructure` 指向 `ProductLanding.tsx`。

- [ ] **Step 3: 若门禁改了文件，另开 commit；否则不空提交**

---

## 代码外（本计划不做）

Better Stack 建页、探针、人工发事故。上线前把生产 `VITE_STATUS_PAGE_JSON_URL` 配到 Vercel。`/api/health` 恒 200 只表示 API 进程在。

---

## 自检

| Spec | Task |
| --- | --- |
| `/status` 未登录可开、hash 不当工作台 | 4, 5 |
| Landing 导航、工作台无入口 | 4 |
| Better Stack JSON、不经 Railway、无 `/api/status` | 2, 3 |
| 30 历日 / 缺日 unknown / 维护不扣 30 天 | 2 |
| 24h 事故相交、空 affected 涂全部、重叠不双计 | 2 |
| 未配置 / 超时 / 非 2xx | 3 |
| 进工作台离开 `/status` | 4 |
| CSP、CODEMAP、e2e 夹具 | 5 |
| 运营建页 | 明确不做 |
