import assert from 'node:assert/strict'
import test from 'node:test'
import { assertPublicHttpsUrl, createPinnedLookup } from './webEgressGuard.mjs'

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
  assert.deepEqual(allowed.addresses, ['1.1.1.1'])
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

test('出口守卫拒绝云元数据、共享、基准、文档、组播和保留网段', async () => {
  for (const address of [
    '100.100.100.200',
    '100.64.0.1',
    '198.18.0.1',
    '192.0.2.1',
    '224.0.0.1',
    '240.0.0.1',
    '2001:db8::1',
    'fe90::1',
    '::127.0.0.1',
    '64:ff9b::7f00:1',
  ]) {
    const result = await assertPublicHttpsUrl('https://untrusted.example/image.png', {
      lookup: async () => [address],
    })
    assert.equal(result.ok, false, address)
  }
})

test('显式开发开关仍允许本机地址，生产默认保持拒绝', async () => {
  const allowed = await assertPublicHttpsUrl('http://localhost:8787/mock', {
    allowLocal: true,
    lookup: async () => ['127.0.0.1'],
  })
  assert.equal(allowed.ok, true)
  assert.deepEqual(allowed.addresses, ['127.0.0.1'])
})

test('固定出口 lookup 同时支持单地址与 all 形态', async () => {
  const lookup = createPinnedLookup('93.184.216.34')
  const one = await new Promise((resolve, reject) => lookup('example.com', {}, (error, address, family) => (
    error ? reject(error) : resolve({ address, family })
  )))
  assert.deepEqual(one, { address: '93.184.216.34', family: 4 })
  const all = await new Promise((resolve, reject) => lookup('example.com', { all: true }, (error, addresses) => (
    error ? reject(error) : resolve(addresses)
  )))
  assert.deepEqual(all, [{ address: '93.184.216.34', family: 4 }])
  assert.throws(() => createPinnedLookup('not-an-ip'), /有效 IP/u)
})
