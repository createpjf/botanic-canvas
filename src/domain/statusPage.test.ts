import assert from 'node:assert/strict'
import test from 'node:test'
import {
  emptyStatusSnapshot,
  isProductStatusPath,
  mapStatusSnapshot,
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
      ends_at: 'ends_at' in extra ? extra.ends_at : '2026-08-29T11:00:00.000Z',
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
