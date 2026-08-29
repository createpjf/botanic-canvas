import assert from 'node:assert/strict'
import test from 'node:test'
import {
  emptyStatusSnapshot,
  isProductStatusPath,
  mapSelfHostedStatusSnapshot,
  mapVendorStatusLevel,
  pruneStatusSamples,
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
  assert.equal(mapVendorStatusLevel('outage'), 'outage')
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

test('空快照在未接入或无法探测时不带组件', () => {
  const snapshot = emptyStatusSnapshot('unavailable', '2026-08-29T12:00:00.000Z')
  assert.equal(snapshot.loadState, 'unavailable')
  assert.equal(snapshot.overall, null)
  assert.deepEqual(snapshot.components, [])
  assert.deepEqual(snapshot.incidents, [])
  assert.equal(snapshot.subscribeUrl, null)
})

const fetchedAt = '2026-08-29T12:00:00.000Z'

test('空样本仍是 ready，组件在，格子为 unknown，uptime 为 null', () => {
  const snapshot = mapSelfHostedStatusSnapshot({
    samples: [],
    incidents: [],
    fetchedAt,
    componentIds: ['web', 'api'],
    updatedAt: null,
  })
  assert.equal(snapshot.loadState, 'ready')
  assert.equal(snapshot.overall, 'unknown')
  assert.equal(snapshot.components.length, 2)
  assert.equal(snapshot.components[0]?.level, 'unknown')
  assert.equal(snapshot.components[0]?.days30.length, 30)
  assert.equal(snapshot.components[0]?.days30[0]?.day, '2026-07-31')
  assert.equal(snapshot.components[0]?.days30[0]?.level, 'unknown')
  assert.equal(snapshot.components[0]?.days30.at(-1)?.day, '2026-08-29')
  assert.equal(snapshot.components[0]?.hours24.every((cell) => cell.level === 'unknown'), true)
  assert.equal(snapshot.components[0]?.uptime24h, null)
  assert.equal(snapshot.components[0]?.uptime30d, null)
  assert.equal(snapshot.subscribeUrl, null)
})

test('30 天有样本才计入 uptime，缺日 unknown，outage 秒数按间隔累加', () => {
  const snapshot = mapSelfHostedStatusSnapshot({
    samples: [
      { at: '2026-08-01T10:00:00.000Z', checks: { web: 'outage', api: 'outage' } },
      { at: '2026-08-29T11:00:00.000Z', checks: { web: 'operational', api: 'operational' } },
    ],
    incidents: [],
    fetchedAt,
    componentIds: ['api'],
  })
  const api = snapshot.components[0]
  assert.equal(api?.days30.find((cell) => cell.day === '2026-08-01')?.level, 'outage')
  assert.equal(api?.days30.find((cell) => cell.day === '2026-08-01')?.downtimeSeconds, 900)
  assert.equal(api?.days30.find((cell) => cell.day === '2026-08-15')?.level, 'unknown')
  assert.equal(api?.days30.at(-1)?.level, 'operational')
  assert.equal(api?.uptime30d, (1 - 900 / (2 * 86400)) * 100)
  assert.equal(api?.level, 'operational')
  assert.equal(snapshot.overall, 'operational')
})

test('24 小时无样本为 unknown；样本 outage 与事故取更差；维护上色不单独当样本宕机', () => {
  const snapshot = mapSelfHostedStatusSnapshot({
    samples: [
      { at: '2026-08-29T10:10:00.000Z', checks: { web: 'operational', api: 'outage' } },
    ],
    incidents: [
      {
        id: 'overlap',
        title: '重叠中断',
        level: 'outage',
        startedAt: '2026-08-29T10:15:00.000Z',
        resolvedAt: '2026-08-29T10:45:00.000Z',
        affected: ['api'],
        updates: [],
      },
      {
        id: 'maint',
        title: '夜间维护',
        level: 'maintenance',
        startedAt: '2026-08-29T08:00:00.000Z',
        resolvedAt: '2026-08-29T09:00:00.000Z',
        affected: [],
        updates: [],
      },
    ],
    fetchedAt,
    componentIds: ['web', 'api'],
  })
  const web = snapshot.components.find((item) => item.id === 'web')
  const api = snapshot.components.find((item) => item.id === 'api')
  const quietHour = web?.hours24.find((cell) => cell.start === '2026-08-29T07:00:00.000Z')
  const maintHour = web?.hours24.find((cell) => cell.start === '2026-08-29T08:00:00.000Z')
  const apiHour = api?.hours24.find((cell) => cell.start === '2026-08-29T10:00:00.000Z')
  const webHour = web?.hours24.find((cell) => cell.start === '2026-08-29T10:00:00.000Z')
  assert.equal(quietHour?.level, 'unknown')
  assert.equal(maintHour?.level, 'maintenance')
  assert.equal(apiHour?.level, 'outage')
  assert.equal(apiHour?.incidentTitle, '重叠中断')
  assert.equal(webHour?.level, 'operational')
  assert.equal(api?.uptime24h, (1 - 30 / 1440) * 100)
})

test('非法事故丢掉；进行中置顶并截 20；超过 20 的窗口内事故仍涂格子', () => {
  const incidents = [
    { id: 'bad', title: 'x', level: 'operational', startedAt: '2026-08-29T01:00:00.000Z', resolvedAt: null, affected: [], updates: [] },
    {
      id: 'open',
      title: '进行中',
      level: 'degraded',
      startedAt: '2026-08-29T11:30:00.000Z',
      resolvedAt: null,
      affected: ['api'],
      updates: [{ at: '2026-08-29T11:40:00.000Z', body: '正在看' }],
    },
    {
      id: 'oldest',
      title: '最早窗口内中断',
      level: 'outage',
      startedAt: '2026-08-28T12:00:00.000Z',
      resolvedAt: '2026-08-28T12:30:00.000Z',
      affected: ['api'],
      updates: [],
    },
    ...Array.from({ length: 20 }, (_, index) => ({
      id: `newer-${index}`,
      title: `较新 ${index}`,
      level: 'outage' as const,
      startedAt: `2026-08-29T${String((index % 10) + 2).padStart(2, '0')}:00:00.000Z`,
      resolvedAt: `2026-08-29T${String((index % 10) + 2).padStart(2, '0')}:15:00.000Z`,
      affected: ['api' as const],
      updates: [],
    })),
  ]
  const snapshot = mapSelfHostedStatusSnapshot({
    samples: [{ at: '2026-08-29T11:50:00.000Z', checks: { api: 'operational' } }],
    incidents,
    fetchedAt,
    componentIds: ['api'],
  })
  assert.equal(snapshot.incidents.some((item) => item.id === 'bad'), false)
  assert.equal(snapshot.incidents.length, 20)
  assert.equal(snapshot.incidents[0]?.title, '进行中')
  assert.equal(snapshot.incidents[0]?.updates[0]?.body, '正在看')
  assert.equal(snapshot.incidents.some((item) => item.id === 'oldest'), false)
  const oldestHour = snapshot.components[0]?.hours24.find((cell) => cell.start === '2026-08-28T12:00:00.000Z')
  assert.equal(oldestHour?.level, 'outage')
  assert.equal(oldestHour?.incidentTitle, '最早窗口内中断')
})

test('剪枝丢掉 30 个历日窗口之前的样本', () => {
  const kept = pruneStatusSamples([
    { at: '2026-07-30T23:00:00.000Z', checks: { api: 'outage' } },
    { at: '2026-07-31T00:00:00.000Z', checks: { api: 'operational' } },
    { at: '2026-08-29T11:00:00.000Z', checks: { api: 'operational' } },
  ], fetchedAt)
  assert.equal(kept.length, 2)
  assert.equal(kept[0]?.at, '2026-07-31T00:00:00.000Z')
})
