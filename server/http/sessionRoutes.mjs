import { accessTokenFromRequest } from '../requestAuth.mjs'

/**
 * 会话资源的完整 HTTP 模块。调用方只需要判断是否已处理，无需了解
 * Access Token、媒体 Cookie 和混合鉴权的差异。
 */
export function createSessionRouteHandler({
  runtime,
  productStore,
  json,
  error,
  readJson,
  text,
  sessionCookie,
}) {
  return async function handleSessionRoute(request, response, url) {
    if (url.pathname !== '/api/session') return false

    if (request.method === 'POST') {
      const bearerToken = accessTokenFromRequest(request)
      if (runtime.authProvider === 'supabase' || (runtime.authProvider === 'hybrid' && bearerToken)) {
        const accessToken = bearerToken
        const user = await productStore.authenticate(accessToken)
        if (!user) {
          error(response, 401, 'INVALID_ACCESS_TOKEN', '登录状态无效，请重新登录。')
          return true
        }
        json(response, 200, { user }, { 'Set-Cookie': sessionCookie(accessToken, request, 60 * 60) })
        return true
      }
      const body = await readJson(request)
      const accessToken = text(body?.accessToken, '访问令牌', 512)
      const user = await productStore.authenticate(accessToken)
      if (!user) {
        error(response, 401, 'INVALID_ACCESS_TOKEN', '访问令牌无效。')
        return true
      }
      json(response, 200, { user }, { 'Set-Cookie': sessionCookie(accessToken, request, 60 * 60 * 12) })
      return true
    }

    if (request.method === 'GET') {
      json(response, 200, {
        user: await productStore.authenticate(accessTokenFromRequest(request, {
          allowMediaCookie: runtime.authProvider !== 'supabase',
        })) ?? null,
      })
      return true
    }

    if (request.method === 'DELETE') {
      json(response, 204, undefined, { 'Set-Cookie': sessionCookie('', request, 0) })
      return true
    }

    json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '会话接口不支持该请求方法。' } }, {
      Allow: 'GET, POST, DELETE',
    })
    return true
  }
}
