import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchMediaBlob } from './mediaFetch.ts'

test('受保护媒体下载会携带鉴权，并在 401 后刷新一次会话再重试', async () => {
  const requests: RequestInit[] = []
  let refreshed = 0
  const blob = await fetchMediaBlob('/api/media/project-1/result.png', {
    location: { href: 'https://botanic.test/workbench', origin: 'https://botanic.test' },
    authorizationHeader: async () => ({ Authorization: 'Bearer test-token' }),
    refreshSession: async () => { refreshed += 1 },
    fetch: async (_source, init) => {
      requests.push(init ?? {})
      return requests.length === 1
        ? new Response(null, { status: 401 })
        : new Response(new Blob(['image'], { type: 'image/png' }), { status: 200 })
    },
  })

  assert.equal(refreshed, 1)
  assert.equal(requests.length, 2)
  assert.equal(requests[0]?.credentials, 'include')
  assert.deepEqual(requests[1]?.headers, { Authorization: 'Bearer test-token' })
  assert.equal(blob.type, 'image/png')
})

test('媒体服务失败会保留 HTTP 状态，供界面给出可操作反馈', async () => {
  await assert.rejects(fetchMediaBlob('/api/media/missing.mp4', {
    location: { href: 'https://botanic.test/workbench', origin: 'https://botanic.test' },
    authorizationHeader: async () => ({}),
    refreshSession: async () => {},
    fetch: async () => new Response(null, { status: 404 }),
  }), /HTTP 404/u)
})
