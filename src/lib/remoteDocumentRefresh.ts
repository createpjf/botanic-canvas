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
