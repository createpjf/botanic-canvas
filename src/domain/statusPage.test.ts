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
