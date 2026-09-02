import { productStoreSupports } from './store/productStoreContract.mjs'

const accountSecurityAuditActions = new Set([
  'security.password.changed',
  'security.mfa.enabled',
  'security.mfa.disabled',
  'security.sessions.revoked',
])

export function createAccountRouteHandler({
  config,
  runtime,
  productStore,
  json,
  error,
  readJson,
  text,
  enumValue,
  requireUser,
  requireSensitiveSession,
  enforceRateLimit,
}) {
  return async function handleAccountRoute(request, response, url, routeMatches, requestId) {
    const { user: userMatch, userInviteResend: userInviteResendMatch } = routeMatches

    if (url.pathname === '/api/users') {
      if (request.method === 'GET') {
        const user = await requireUser(request)
        if (!productStoreSupports(productStore, 'workspaceMembers')) return error(response, 503, 'WORKSPACE_MEMBERS_UNAVAILABLE', '当前存储模式不支持成员列表。')
        try {
          return json(response, 200, { users: await productStore.listUsers(user.id) })
        } catch (caught) {
          return error(response, 403, caught?.code ?? 'USER_MANAGE_FORBIDDEN', caught instanceof Error ? caught.message : '无法读取工作区成员。')
        }
      }
      if (request.method === 'POST') {
        const user = await requireUser(request)
        await requireSensitiveSession(request)
        if (!await enforceRateLimit(response, {
          scope: 'member-mutation', subject: user.id,
          limit: config.security.memberMutationsPerHour, windowMs: 60 * 60_000,
        })) return true
        const body = await readJson(request)
        try {
          const member = await productStore.createUser(user.id, {
            email: text(body?.email, '成员邮箱', 320), name: typeof body?.name === 'string' ? body.name.trim() : undefined,
            role: enumValue(body?.role ?? 'member', ['owner', 'member'], '成员角色'),
            ...(runtime.authProvider === 'access-token' ? { accessToken: text(body?.accessToken, '成员访问令牌', 512) } : {}),
          })
          return json(response, 201, { user: member })
        } catch (caught) {
          return error(response, 403, 'USER_CREATE_FORBIDDEN', caught instanceof Error ? caught.message : '成员创建失败。')
        }
      }
      return json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '成员集合接口不支持该请求方法。' } }, { Allow: 'GET, POST' })
    }

    if (userInviteResendMatch) {
      if (request.method !== 'POST') return json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '成员邀请接口只接受提交请求。' } }, { Allow: 'POST' })
      const user = await requireUser(request)
      await requireSensitiveSession(request)
      if (!await enforceRateLimit(response, {
        scope: 'member-mutation', subject: user.id,
        limit: config.security.memberMutationsPerHour, windowMs: 60 * 60_000,
      })) return true
      if (!productStoreSupports(productStore, 'inviteResend')) return error(response, 503, 'USER_INVITE_RESEND_UNAVAILABLE', '当前登录模式不支持重新发送邀请。')
      try {
        const member = await productStore.resendUserInvite(user.id, decodeURIComponent(userInviteResendMatch[1]))
        return json(response, 200, { user: member })
      } catch (caught) {
        const statusCode = caught?.code === 'USER_NOT_FOUND' ? 404 : caught?.code === 'USER_INVITE_NOT_PENDING' ? 409 : 403
        return error(response, statusCode, caught?.code ?? 'USER_INVITE_RESEND_FAILED', caught instanceof Error ? caught.message : '重新发送邀请失败。')
      }
    }

    if (userMatch) {
      if (request.method !== 'PATCH') return json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '成员资源只接受更新请求。' } }, { Allow: 'PATCH' })
      const user = await requireUser(request)
      if (!productStoreSupports(productStore, 'workspaceMembers')) return error(response, 503, 'WORKSPACE_MEMBERS_UNAVAILABLE', '当前存储模式不支持成员管理。')
      await requireSensitiveSession(request)
      if (!await enforceRateLimit(response, {
        scope: 'member-mutation', subject: user.id,
        limit: config.security.memberMutationsPerHour, windowMs: 60 * 60_000,
      })) return true
      const body = await readJson(request, 16 * 1024, '成员更新请求过大。')
      const updates = {
        ...(body?.role === undefined ? {} : { role: enumValue(body.role, ['owner', 'member'], '工作区角色') }),
        ...(body?.status === undefined ? {} : { status: enumValue(body.status, ['active', 'disabled'], '成员状态') }),
      }
      if (!Object.keys(updates).length) return error(response, 400, 'USER_UPDATE_INVALID', '请选择要修改的成员角色或状态。')
      try {
        const saved = await productStore.updateUser(user.id, decodeURIComponent(userMatch[1]), updates)
        return json(response, 200, { user: saved })
      } catch (caught) {
        return error(response, caught?.code === 'USER_NOT_FOUND' ? 404 : 403, caught?.code ?? 'USER_MANAGE_FORBIDDEN', caught instanceof Error ? caught.message : '成员更新失败。')
      }
    }

    if (url.pathname === '/api/audit') {
      if (request.method !== 'GET') return json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '工作区审计资源只支持读取。' } }, { Allow: 'GET' })
      const user = await requireUser(request)
      try {
        return json(response, 200, { events: await productStore.listWorkspaceAuditEvents(user.id, Number(url.searchParams.get('limit') ?? 100)) })
      } catch (caught) {
        return error(response, 403, caught?.code ?? 'WORKSPACE_AUDIT_FORBIDDEN', caught instanceof Error ? caught.message : '无法读取工作区审计日志。')
      }
    }

    if (url.pathname === '/api/account/security-events') {
      if (request.method !== 'POST') return json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '安全审计资源只接受提交请求。' } }, { Allow: 'POST' })
      const user = await requireUser(request)
      const body = await readJson(request, 8 * 1024, '安全审计请求过大。')
      const action = enumValue(body?.action, [...accountSecurityAuditActions], '安全事件')
      await productStore.recordSecurityAuditEvent(user.id, action, { requestId, source: 'client-confirmed' })
      return json(response, 204)
    }
    return false
  }
}
