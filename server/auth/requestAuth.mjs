function parseCookies(request) {
  return Object.fromEntries((request.headers.cookie ?? '').split(';').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const divider = entry.indexOf('=')
    return divider === -1 ? [entry, ''] : [entry.slice(0, divider), decodeURIComponent(entry.slice(divider + 1))]
  }))
}

export function accessTokenFromRequest(request, { allowMediaCookie = false } = {}) {
  const authorization = request.headers.authorization
  if (authorization?.startsWith('Bearer ')) return authorization.slice('Bearer '.length).trim()
  return allowMediaCookie ? parseCookies(request).botanic_session : undefined
}
