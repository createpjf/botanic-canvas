import assert from 'node:assert/strict'
import test from 'node:test'
import { discardLocalDraftAndRefreshRemote, persistAcceptedRemoteRefresh, previewAgentTargetDocument } from './remoteDocumentRefresh.ts'

test('Agent 原图恢复只返回已确认版本，前后检查 pending 且不落盘', async () => {
  const steps: string[] = []
  const remote = { id: 'original', revision: 7 }
  assert.equal(await previewAgentTargetDocument(
    async () => { steps.push('read'); return remote },
    async () => { steps.push('pending'); return false },
    (value) => value.id === 'original' && value.revision >= 7,
  ), remote)
  assert.deepEqual(steps, ['pending', 'read', 'pending'])
  await assert.rejects(previewAgentTargetDocument(async () => remote, async () => false, () => false), { code: 'AGENT_TARGET_SYNC_PENDING' })
})

test('Agent 原图读期间出现待同步删除或取消时，不交出旧快照', async () => {
  let pending = false
  await assert.rejects(previewAgentTargetDocument(
    async () => { pending = true; return 'remote' },
    async () => pending, () => true,
  ), { code: 'AGENT_TARGET_SYNC_PENDING' })
  const controller = new AbortController()
  await assert.rejects(previewAgentTargetDocument(
    async () => { controller.abort(); return 'remote' },
    async () => false, () => true, controller.signal,
  ), { name: 'AbortError' })
})

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
