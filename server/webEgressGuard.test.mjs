import assert from 'node:assert/strict'
import test from 'node:test'
import { assertPublicHttpsUrl } from './webEgressGuard.mjs'

test('出口守卫拒绝解析到私网的主机名', async () => {
  const blocked = await assertPublicHttpsUrl('https://evil.example/', {
    lookup: async () => ['10.0.0.8'],
  })
  assert.equal(blocked.ok, false)

  const allowed = await assertPublicHttpsUrl('https://www.andlight.cn/', {
    lookup: async () => ['1.1.1.1'],
  })
  assert.equal(allowed.ok, true)
  assert.equal(allowed.hostname, 'www.andlight.cn')
})

test('出口守卫拒绝带括号的 IPv6 字面量，且不以 fc/fd 误杀公网域名', async () => {
  const loopback = await assertPublicHttpsUrl('https://[::1]/')
  assert.equal(loopback.ok, false)
  const uniqueLocal = await assertPublicHttpsUrl('https://[fd00::5]/admin')
  assert.equal(uniqueLocal.ok, false)
  const mapped = await assertPublicHttpsUrl('https://[::ffff:127.0.0.1]/')
  assert.equal(mapped.ok, false)

  const publicFc = await assertPublicHttpsUrl('https://fcbarcelona.com/', {
    lookup: async () => ['1.1.1.1'],
  })
  assert.equal(publicFc.ok, true)
  assert.equal(publicFc.hostname, 'fcbarcelona.com')
})
