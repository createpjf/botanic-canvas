export async function discardLocalDraftAndRefreshRemote<T>(
  discardDraft: () => Promise<unknown>,
  readRemote: () => Promise<T | undefined>,
  persistRemote: (document: T) => Promise<unknown>,
) {
  await discardDraft()
  const remote = await readRemote()
  if (!remote) return undefined
  await persistRemote(remote)
  return remote
}

export async function persistAcceptedRemoteRefresh<T>(
  refresh: { cachedDocument: T; remoteDocument: T },
  accept: ((refresh: { cachedDocument: T; remoteDocument: T }) => boolean) | undefined,
  persist: (document: T) => Promise<unknown>,
) {
  const accepted = accept?.(refresh) ?? false
  if (!accepted) return false
  await persist(refresh.remoteDocument)
  return true
}
