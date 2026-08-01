import assert from 'node:assert/strict'
import test from 'node:test'
import { persistAcceptedRemoteRefresh } from './remoteDocumentRefresh.ts'

test('后台接受服务器新版后刷新本地缓存，拒绝的版本不落盘', async () => {
  const persisted: string[] = []
  const refresh = { cachedDocument: 'cached', remoteDocument: 'remote' }

  assert.equal(await persistAcceptedRemoteRefresh(
    refresh,
    () => true,
    async (document) => { persisted.push(document) },
  ), true)
  assert.deepEqual(persisted, ['remote'])

  assert.equal(await persistAcceptedRemoteRefresh(
    refresh,
    () => false,
    async (document) => { persisted.push(document) },
  ), false)
  assert.deepEqual(persisted, ['remote'])
})
