import assert from 'node:assert/strict'
import test from 'node:test'
import {
  collectStatusSample,
  defaultProbeTargets,
  isSelfReferentialStatusUrl,
  mergeStatusSampleFile,
  probeStatusUrl,
  runStatusCollect,
  runStatusSnapshot,
} from './statusPageRuntime.ts'

test('默认探针含 web/api，空 auth 不出现；自指状态路径拒绝', () => {
  assert.deepEqual(defaultProbeTargets({}), {
    web: 'https://botanic-canvas.vercel.app/',
    api: 'https://api-production-cc46.up.railway.app/api/health',
  })
  assert.equal(defaultProbeTargets({ STATUS_PROBE_AUTH_URL: ' https://id.example/health ' }).auth, 'https://id.example/health')
  assert.equal(isSelfReferentialStatusUrl('https://botanic-canvas.vercel.app/status'), true)
  assert.equal(isSelfReferentialStatusUrl('https://botanic-canvas.vercel.app/status.json'), true)
  assert.equal(isSelfReferentialStatusUrl('https://botanic-canvas.vercel.app/'), false)
})

test('探活：2xx 为 operational，失败与超时为 outage', async () => {
  assert.equal(await probeStatusUrl('https://web.example/', async () => new Response('ok')), 'operational')
  assert.equal(await probeStatusUrl('https://web.example/', async () => new Response('nope', { status: 503 })), 'outage')
  assert.equal(await probeStatusUrl('https://web.example/', () => new Promise(() => {}), 20), 'outage')
})

test('采集跳过自指 URL，未配 auth 不写 auth 键', async () => {
  const sample = await collectStatusSample({
    env: {
      STATUS_PROBE_WEB_URL: 'https://botanic-canvas.vercel.app/status',
      STATUS_PROBE_API_URL: 'https://api.example/api/health',
    },
    now: () => Date.parse('2026-08-29T12:00:00.000Z'),
    fetchImpl: async () => new Response('ok'),
  })
  assert.equal(sample.at, '2026-08-29T12:00:00.000Z')
  assert.equal(sample.checks.web, undefined)
  assert.equal(sample.checks.api, 'operational')
  assert.equal('auth' in sample.checks, false)
})

test('合并样本会剪枝并覆盖写回 version 1', () => {
  const file = mergeStatusSampleFile({
    version: 1,
    updatedAt: '2026-07-01T00:00:00.000Z',
    samples: [{ at: '2026-07-30T23:00:00.000Z', checks: { api: 'outage' } }],
  }, { at: '2026-08-29T12:00:00.000Z', checks: { web: 'operational', api: 'operational' } }, '2026-08-29T12:00:00.000Z')
  assert.equal(file.version, 1)
  assert.equal(file.samples.length, 1)
  assert.equal(file.samples[0]?.at, '2026-08-29T12:00:00.000Z')
})

test('非法旧文件从头开始，不把坏 version 续写进去', () => {
  const file = mergeStatusSampleFile({ version: 2 }, {
    at: '2026-08-29T12:00:00.000Z',
    checks: { api: 'operational' },
  }, '2026-08-29T12:00:00.000Z')
  assert.equal(file.version, 1)
  assert.equal(file.samples.length, 1)
})

test('collect 无密钥或错密钥 401，不探活', async () => {
  let calls = 0
  const denied = await runStatusCollect({
    authorization: 'Bearer wrong',
    cronSecret: 'secret',
    fetchImpl: async () => {
      calls += 1
      return new Response('ok')
    },
    readSamples: async () => ({ ok: true, value: null }),
    writeSamples: async () => {
      throw new Error('should not write')
    },
  })
  assert.equal(denied.status, 401)
  assert.equal(calls, 0)

  const missing = await runStatusCollect({
    authorization: 'Bearer secret',
    cronSecret: '',
    fetchImpl: async () => new Response('ok'),
    readSamples: async () => ({ ok: true, value: null }),
    writeSamples: async () => {},
  })
  assert.equal(missing.status, 401)
})

test('collect 鉴权后探活并写回', async () => {
  let written = null
  const result = await runStatusCollect({
    authorization: 'Bearer secret',
    cronSecret: 'secret',
    env: { STATUS_PROBE_WEB_URL: 'https://web.example/', STATUS_PROBE_API_URL: 'https://api.example/health' },
    now: () => Date.parse('2026-08-29T12:00:00.000Z'),
    fetchImpl: async () => new Response('ok'),
    readSamples: async () => ({ ok: true, value: { version: 1, updatedAt: '2026-08-29T11:45:00.000Z', samples: [] } }),
    writeSamples: async (file) => {
      written = file
    },
  })
  assert.equal(result.status, 200)
  assert.equal(written?.samples.length, 1)
  assert.equal(written?.samples[0]?.checks.web, 'operational')
})

test('snapshot 缺文件仍 ready；坏 version 为 unavailable；不探活', async () => {
  let calls = 0
  const empty = await runStatusSnapshot({
    env: {},
    now: () => Date.parse('2026-08-29T12:00:00.000Z'),
    incidents: [],
    readSamples: async () => ({ ok: false, missing: true }),
    fetchImpl: async () => {
      calls += 1
      return new Response('ok')
    },
  })
  assert.equal(empty.loadState, 'ready')
  assert.equal(empty.components.length, 2)
  assert.equal(empty.overall, 'unknown')
  assert.equal(calls, 0)

  const bad = await runStatusSnapshot({
    now: () => Date.parse('2026-08-29T12:00:00.000Z'),
    incidents: [],
    readSamples: async () => ({ ok: true, value: { version: 9 } }),
  })
  assert.equal(bad.loadState, 'unavailable')
  assert.equal(bad.components.length, 0)

  const failed = await runStatusSnapshot({
    now: () => Date.parse('2026-08-29T12:00:00.000Z'),
    incidents: [],
    readSamples: async () => ({ ok: false, missing: false }),
  })
  assert.equal(failed.loadState, 'unavailable')
})
