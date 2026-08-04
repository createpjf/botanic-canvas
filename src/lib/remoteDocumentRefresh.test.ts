import assert from 'node:assert/strict'
import test from 'node:test'
import { discardLocalDraftAndRefreshRemote, persistAcceptedRemoteRefresh } from './remoteDocumentRefresh.ts'

test('选择云端版本时先丢弃本地草稿，再读取并缓存云端文档', async () => {
  const steps: string[] = []
  const document = await discardLocalDraftAndRefreshRemote(
    async () => { steps.push('discard') },
    async () => { steps.push('read'); return 'cloud-version' },
    async (remote) => { steps.push(`persist:${remote}`) },
  )

  assert.equal(document, 'cloud-version')
  assert.deepEqual(steps, ['discard', 'read', 'persist:cloud-version'])
})

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

test('未提供接受回调时保持本地缓存，不默认覆盖离线副本', async () => {
  const persisted: string[] = []
  const accepted = await persistAcceptedRemoteRefresh(
    { cachedDocument: 'cached', remoteDocument: 'remote' },
    undefined,
    async (document) => { persisted.push(document) },
  )

  assert.equal(accepted, false)
  assert.deepEqual(persisted, [])
})
