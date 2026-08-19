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
