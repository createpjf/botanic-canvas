export type ProductAuthFlow = 'invite' | 'recovery' | null

export type ProductAuthLocation = {
  hash?: string
  search?: string
  pathname?: string
}

function paramsFromHash(hash = '') {
  const value = hash.replace(/^#/, '')
  const queryStart = value.indexOf('?')
  return new URLSearchParams(queryStart >= 0 ? value.slice(queryStart + 1) : value)
}

/**
 * Supabase 可能用 implicit hash（type=invite）或 PKCE query（code）回调。
 * 这里只判断进入密码设置页所需的 URL 信号，不读取或记录 token 内容。
 */
export function detectProductAuthFlow(location: ProductAuthLocation): ProductAuthFlow {
  const hashParams = paramsFromHash(location.hash)
  const searchParams = new URLSearchParams(location.search ?? '')
  const type = hashParams.get('type') ?? searchParams.get('type')
  if (type === 'invite' || type === 'recovery') return type

  // Botanic 目前只提供邮箱密码登录，没有 OAuth callback；因此 callback code
  // 只可能来自邀请/恢复链接，兼容 Supabase PKCE 不带 type 的回调。
  const code = hashParams.get('code') ?? searchParams.get('code')
  if (code) return 'invite'
  return null
}

export function cleanProductAuthUrl(input: string) {
  const url = new URL(input)
  for (const key of ['code', 'type', 'access_token', 'refresh_token', 'expires_at', 'expires_in', 'token_type', 'error', 'error_code', 'error_description', 'state']) {
    url.searchParams.delete(key)
  }
  url.hash = ''
  return `${url.pathname}${url.search}`
}
