export async function discardLocalDraftAndRefreshRemote<T>(
  discardDraft: () => Promise<unknown>,
  readRemote: () => Promise<T | undefined>,
  persistRemote: (document: T) => Promise<unknown>,
) {
  const remote = await readRemote()
  if (!remote) return undefined
  await persistRemote(remote)
  await discardDraft()
  return remote
}

export async function persistAcceptedRemoteRefresh<T>(
  refresh: { cachedDocument: T; remoteDocument: T },
  accept: ((refresh: { cachedDocument: T; remoteDocument: T }) => boolean | T) | undefined,
  persist: (document: T) => Promise<unknown>,
) {
  const accepted = accept?.(refresh) ?? false
  if (!accepted) return false
  await persist(accepted === true ? refresh.remoteDocument : accepted)
  return true
}

/** Agent 恢复只读：前后都没有待确认修改，且返回版本满足当前 ACK，才交给目标解析。 */
export async function previewAgentTargetDocument<T>(
  readRemote: () => Promise<T | undefined>,
  hasPending: () => Promise<boolean>,
  acceptsRevision: (remote: T) => boolean,
  signal?: AbortSignal,
) {
  const assertReady = async () => {
    signal?.throwIfAborted()
    if (await hasPending()) throw Object.assign(new Error('请先完成画布同步，再恢复原图。'), { code: 'AGENT_TARGET_SYNC_PENDING' })
    signal?.throwIfAborted()
  }
  await assertReady()
  const remote = await readRemote()
  await assertReady()
  if (remote && !acceptsRevision(remote)) throw Object.assign(new Error('画布版本已变化，请重新核对原图。'), { code: 'AGENT_TARGET_SYNC_PENDING' })
  return remote
}
