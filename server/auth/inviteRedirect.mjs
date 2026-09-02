const DEFAULT_PRODUCTION_APP_URL = 'https://botanic-canvas.vercel.app/'

function normalizeUrl(value) {
  if (!value || typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  try {
    const url = new URL(trimmed)
    if (!['http:', 'https:'].includes(url.protocol)) return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

function isLoopback(hostname) {
  const host = hostname.toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
}

/**
 * 邀请邮件必须回到可访问的 Web 应用；生产环境禁止把用户带回 Railway/本机地址。
 * 显式配置的正式域名优先，未配置时使用 Botanic 的生产域名。
 */
export function resolveInviteRedirectTo({ configured, publicAppUrl, production = false } = {}) {
  const configuredFallback = normalizeUrl(publicAppUrl)
  const fallback = configuredFallback && (!production || !isLoopback(new URL(configuredFallback).hostname))
    ? configuredFallback
    : (production ? DEFAULT_PRODUCTION_APP_URL : undefined)
  const candidate = normalizeUrl(configured)
  if (!candidate) return fallback
  if (production && isLoopback(new URL(candidate).hostname)) return fallback
  return candidate
}

export { DEFAULT_PRODUCTION_APP_URL }
