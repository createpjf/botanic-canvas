import assert from 'node:assert/strict'
import test from 'node:test'
import {
  fetchPublishedRelease,
  formatReleaseLabel,
  isStaleRelease,
  parseRelease,
} from './releaseGate.ts'

test('revision 不同才判定过期，缺字段或拉取失败不拦截', () => {
  const local = { version: '0.1.0', revision: 'aaa1111' }
  assert.equal(isStaleRelease(local, { version: '0.2.0', revision: 'bbb2222' }), true)
  assert.equal(isStaleRelease(local, { version: '0.2.0', revision: 'aaa1111' }), false)
  assert.equal(isStaleRelease(local, { version: '0.1.0', revision: '' }), false)
  assert.equal(isStaleRelease(local, null), false)
  assert.equal(isStaleRelease({ version: '0.1.0', revision: '' }, { version: '0.2.0', revision: 'bbb2222' }), false)
  assert.deepEqual(parseRelease({ version: ' 0.1.0 ', revision: ' abc ' }), { version: '0.1.0', revision: 'abc' })
  assert.equal(parseRelease({ foo: 1 }), null)
  assert.equal(formatReleaseLabel(local), 'v0.1.0 · aaa1111')
})

test('发布清单非 200 或网络错误时 fail-open', async () => {
  assert.equal(await fetchPublishedRelease({
    fetch: async () => new Response('nope', { status: 404 }),
  }), null)
  assert.equal(await fetchPublishedRelease({
    fetch: async () => { throw new Error('offline') },
  }), null)
  assert.deepEqual(await fetchPublishedRelease({
    now: () => 99,
    fetch: async (input) => {
      assert.equal(String(input), '/release.json?t=99')
      return new Response(JSON.stringify({ version: '0.1.0', revision: 'abc1234' }), { status: 200 })
    },
  }), { version: '0.1.0', revision: 'abc1234' })
})
