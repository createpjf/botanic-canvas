export function decodeAuthAssurance(accessToken) {
  if (typeof accessToken !== 'string') return undefined
  const segments = accessToken.split('.')
  if (segments.length !== 3) return undefined
  try {
    const payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'))
    if (!['aal1', 'aal2'].includes(payload?.aal)) return undefined
    return {
      aal: payload.aal,
      sessionId: typeof payload.session_id === 'string' ? payload.session_id : undefined,
    }
  } catch {
    return undefined
  }
}
