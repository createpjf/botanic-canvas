import { issueRealtimeTicket } from './realtimeTicket.mjs'
import { requireProjectPermission } from './projectAuthorization.mjs'

export function createRealtimeTicketRouteHandler({ config, productStore, json, readJson, text, requireUser, enforceRateLimit, HttpError }) {
  return async function handleRealtimeTicketRoute(request, response, url) {
    if (url.pathname !== '/api/realtime/ticket') return false
    if (request.method !== 'POST') return json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '实时票据资源只接受提交请求。' } }, { Allow: 'POST' })
    const user = await requireUser(request)
    if (!await enforceRateLimit(response, {
      scope: 'realtime-ticket', subject: user.id,
      limit: config.security.realtimeTicketsPerMinute, windowMs: 60_000,
    })) return true
    const body = await readJson(request, 16 * 1024, '实时订阅请求过大。')
    const projectId = text(body?.projectId, '项目', 160)
    await requireProjectPermission(productStore, user.id, projectId, 'read')
    const requestOrigin = Array.isArray(request.headers.origin) ? request.headers.origin[0] : request.headers.origin
    let parsedOrigin
    try { parsedOrigin = requestOrigin ? new URL(requestOrigin) : undefined } catch { parsedOrigin = undefined }
    if (!parsedOrigin || !['http:', 'https:'].includes(parsedOrigin.protocol)) throw new HttpError(403, 'REALTIME_ORIGIN_REQUIRED', '实时连接必须来自受信任的网页来源。')
    const forwardedProtocol = request.headers['x-forwarded-proto']?.split(',')[0]?.trim()
    const protocol = forwardedProtocol || (request.socket.encrypted ? 'https' : 'http')
    const realtimeOrigin = config.realtimePublicUrl || `${protocol}://${request.headers.host}`
    return json(response, 201, {
      ticket: issueRealtimeTicket({ userId: user.id, projectId, origin: parsedOrigin.origin, secret: config.realtimeTicketSecret }),
      expiresIn: 30,
      websocketUrl: new URL('/api/realtime', realtimeOrigin).toString(),
    })
  }
}
