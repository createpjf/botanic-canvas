type MediaFetchDependencies = {
  fetch?: typeof globalThis.fetch
  location?: Pick<Location, 'href' | 'origin'>
  refreshSession?: () => Promise<void>
  authorizationHeader?: () => Promise<Record<string, string>>
}

export async function fetchMediaBlob(source: string, dependencies: MediaFetchDependencies = {}) {
  const currentLocation = dependencies.location ?? (typeof window === 'undefined' ? undefined : window.location)
  const sourceUrl = new URL(source, currentLocation?.href ?? 'http://localhost')
  const protectedMedia = Boolean(currentLocation)
    && sourceUrl.origin === currentLocation!.origin
    && sourceUrl.pathname.startsWith('/api/media/')
  const fetcher = dependencies.fetch ?? globalThis.fetch
  const session = protectedMedia && (!dependencies.refreshSession || !dependencies.authorizationHeader)
    ? await import('./productSession')
    : undefined
  const refreshSession = dependencies.refreshSession ?? session?.refreshProductMediaSession
  const authorizationHeader = dependencies.authorizationHeader ?? session?.productAuthorizationHeader

  const request = async () => fetcher(source, {
    credentials: protectedMedia ? 'include' : 'omit',
    headers: protectedMedia && authorizationHeader ? await authorizationHeader() : undefined,
  })

  let response = await request()
  if (protectedMedia && (response.status === 401 || response.status === 403) && refreshSession) {
    await refreshSession()
    response = await request()
  }
  if (!response.ok) throw new Error(`媒体下载失败（HTTP ${response.status}），请重新登录后重试。`)
  return response.blob()
}
