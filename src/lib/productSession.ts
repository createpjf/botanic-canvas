import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createAccountSecurityService, type AccountMfaEnrollment, type AccountMfaStatus } from './accountSecurity'
import { createSecurityAuditReporter } from './securityAudit'
import type { WorkspaceAuditEvent } from '../domain/auditEvents'
import { invalidateProductSessionIfRequired, subscribeProductSessionInvalidated } from './productSessionInvalidation'
import { cleanProductAuthUrl, detectProductAuthFlow } from './authFlow'

export type ProductUser = {
  id: string
  email: string
  name: string
  role: 'owner' | 'member'
  status?: 'invited' | 'active' | 'disabled'
  createdAt?: number
}

export type WorkspaceMember = ProductUser & {
  status: 'invited' | 'active' | 'disabled'
  createdAt?: number
}

type ApiErrorPayload = { error?: { code?: string; message?: string } }

export class ProductApiError extends Error {
  status: number
  code?: string

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'ProductApiError'
    this.status = status
    this.code = code
  }
}

/** 生产默认服务端持久化；local 时维持 IndexedDB 原型。 */
export const serverPersistenceEnabled = import.meta.env.VITE_PERSISTENCE_MODE === 'server'
  || (import.meta.env.PROD && import.meta.env.VITE_PERSISTENCE_MODE !== 'local')

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY
// Railway 全量部署时，访问码只发给同源 API，浏览器不再连接 Supabase。
const configuredAuthProvider = import.meta.env.VITE_AUTH_PROVIDER
const localAccessTokenAuth = configuredAuthProvider === 'access-token'
export const hybridAuthEnabled = configuredAuthProvider === 'hybrid'
export const supabaseAuthEnabled = !localAccessTokenAuth && serverPersistenceEnabled && Boolean(supabaseUrl && supabasePublishableKey)
const supabase: SupabaseClient | undefined = supabaseAuthEnabled
  ? createClient(supabaseUrl, supabasePublishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : undefined
const accountSecurity = supabase ? createAccountSecurityService(supabase.auth) : undefined

let invalidatedSessionCleanup: Promise<void> | undefined
subscribeProductSessionInvalidated(() => {
  if (!supabase || invalidatedSessionCleanup) return
  invalidatedSessionCleanup = (async () => {
    await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined)
    await clearMediaSessionCookie()
  })().finally(() => {
    invalidatedSessionCleanup = undefined
  })
})

const mediaSessionSyncs = new Map<string, Promise<ProductUser | undefined>>()
const productRequestTimeoutMs = 15_000
const authSessionTimeoutMs = 6_000
const mediaSessionAttemptTimeoutMs = 10_000
const mediaSessionRetryDelayMs = 700
const mediaSessionMaxAttempts = 3
type ProductRequestInit = RequestInit & {
  /** 长链路（Agent 规划 / 对话）可覆盖普通工作区请求的 15 秒超时。 */
  timeoutMs?: number
  timeoutMessage?: string
}

function withAuthTimeout<T>(request: Promise<T>, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timeoutId = window.setTimeout(() => {
      if (settled) return
      settled = true
      reject(new ProductApiError(message, 0, 'REQUEST_TIMEOUT'))
    }, authSessionTimeoutMs)

    void request.then(
      (value) => {
        if (settled) return
        settled = true
        window.clearTimeout(timeoutId)
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        window.clearTimeout(timeoutId)
        reject(error)
      },
    )
  })
}

/**
 * Supabase 会话已经证明用户身份；媒体 Cookie 仅用于 <img> 同源鉴权。
 * 绝不能因为这项便利同步暂时失败而阻断用户进入工作台，真实权限仍由每个 API
 * 请求携带的 Bearer Token 在服务端校验。
 */
function sessionUserFallback(user: { id: string; email?: string; user_metadata?: Record<string, unknown> }): ProductUser {
  const email = user.email ?? ''
  const displayName = typeof user.user_metadata?.display_name === 'string' && user.user_metadata.display_name.trim()
    ? user.user_metadata.display_name.trim()
    : email.split('@')[0] || 'Botanic Member'
  return { id: user.id, email, name: displayName, role: 'member' }
}

async function authorizationHeader() {
  if (!supabase) return {}
  const { data } = await withAuthTimeout(
    supabase.auth.getSession(),
    '登录状态读取超时，请重新登录。',
  )
  return data.session ? { Authorization: `Bearer ${data.session.access_token}` } : {}
}

/**
 * 业务 API 使用 Bearer Token；但浏览器加载 <img> 时不能附带该请求头。
 * 将当前 Supabase 会话同步为同源 HttpOnly Cookie，媒体仍由服务端按项目权限校验。
 */
async function syncMediaSessionCookie(accessToken?: string): Promise<ProductUser | undefined> {
  if (!supabase) return undefined
  const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : await authorizationHeader()
  const token = headers.Authorization?.slice('Bearer '.length)
  if (!token) return undefined

  const inFlight = mediaSessionSyncs.get(token)
  if (inFlight) return inFlight

  const sync = (async () => {
    const requestHeaders = new Headers({ Accept: 'application/json' })
    if (headers.Authorization) requestHeaders.set('Authorization', headers.Authorization)
    let lastError: ProductApiError | undefined
    for (let attempt = 1; attempt <= mediaSessionMaxAttempts; attempt += 1) {
      const controller = new AbortController()
      const timeoutId = window.setTimeout(() => controller.abort(), mediaSessionAttemptTimeoutMs)
      try {
        const response = await fetch('/api/session', {
          method: 'POST',
          credentials: 'include',
          headers: requestHeaders,
          signal: controller.signal,
        })
        const payload = await response.json().catch(() => null) as { user?: ProductUser | null } | ApiErrorPayload | null
        if (response.ok) return (payload as { user?: ProductUser | null } | null)?.user ?? undefined
        const error = payload as ApiErrorPayload | null
        // 前端先于 API 发布时，旧服务会拒绝 Supabase 的 Cookie 同步；
        // 此时仍可继续使用 Bearer 登录，不应阻断进入工作台。
        if (response.status === 410 && error?.error?.code === 'SUPABASE_AUTH_REQUIRED') return undefined
        lastError = new ProductApiError(error?.error?.message ?? '媒体登录状态同步失败。', response.status, error?.error?.code)
      } catch {
        lastError = new ProductApiError(
          controller.signal.aborted ? '工作区数据库响应超时，请稍后重试。' : '无法连接工作区服务，请稍后重试。',
          0,
          controller.signal.aborted ? 'REQUEST_TIMEOUT' : undefined,
        )
      } finally {
        window.clearTimeout(timeoutId)
      }

      // 只重试部署切换、连接抖动与 Supabase 的临时 5xx；账号或权限错误应立即提示。
      const retryable = lastError.status === 0 || lastError.status >= 500
      if (!retryable || attempt === mediaSessionMaxAttempts) throw lastError
      await new Promise<void>((resolve) => window.setTimeout(resolve, mediaSessionRetryDelayMs * attempt))
    }
    throw lastError ?? new ProductApiError('媒体登录状态同步失败。', 0)
  })()

  mediaSessionSyncs.set(token, sync)
  void sync.finally(() => {
    if (mediaSessionSyncs.get(token) === sync) mediaSessionSyncs.delete(token)
  }).catch(() => undefined)
  return sync
}

/** 媒体标签读取失败时，重新同步当前登录态后再加载原媒体。 */
export async function refreshProductMediaSession() {
  if (!supabase) return
  const { data } = await withAuthTimeout(
    supabase.auth.getSession(),
    '媒体登录状态读取超时，请重新登录。',
  )
  if (!data.session?.access_token) throw new ProductApiError('登录状态已失效，请重新登录。', 401, 'AUTH_REQUIRED')
  await syncMediaSessionCookie(data.session.access_token)
}

async function clearMediaSessionCookie() {
  await fetch('/api/session', { method: 'DELETE', credentials: 'include' }).catch(() => undefined)
}

if (supabase) {
  supabase.auth.onAuthStateChange((_event, session) => {
    if (session?.access_token) {
      void syncMediaSessionCookie(session.access_token).catch(() => undefined)
      return
    }
    void clearMediaSessionCookie()
  })
}

export async function productAuthorizationHeader() {
  return authorizationHeader()
}

export async function productRequest<T>(path: string, init: ProductRequestInit = {}): Promise<T> {
  const { timeoutMs: requestedTimeoutMs, timeoutMessage, ...requestInit } = init
  const requestTimeoutMs = Number.isFinite(requestedTimeoutMs)
    ? Math.min(120_000, Math.max(1_000, requestedTimeoutMs!))
    : productRequestTimeoutMs
  let response: Response
  const controller = new AbortController()
  const abortFromCaller = () => controller.abort()
  if (requestInit.signal?.aborted) controller.abort()
  else requestInit.signal?.addEventListener('abort', abortFromCaller, { once: true })
  const timeoutId = window.setTimeout(() => controller.abort(), requestTimeoutMs)
  try {
    const headers = new Headers(requestInit.headers)
    headers.set('Accept', 'application/json')
    for (const [key, value] of Object.entries(await authorizationHeader())) headers.set(key, value)
    response = await fetch(path, {
      ...requestInit,
      credentials: 'include',
      headers,
      signal: controller.signal,
    })
  } catch {
    const message = !requestInit.signal?.aborted && controller.signal.aborted
      ? (timeoutMessage ?? '工作区服务响应超时，请稍后重试。')
      : '无法连接工作区服务，请检查网络或稍后重试。'
    throw new ProductApiError(message, 0, controller.signal.aborted ? 'REQUEST_TIMEOUT' : undefined)
  } finally {
    window.clearTimeout(timeoutId)
    requestInit.signal?.removeEventListener('abort', abortFromCaller)
  }
  const payload = await response.json().catch(() => null) as T | ApiErrorPayload | null
  if (!response.ok) {
    const error = payload as ApiErrorPayload | null
    invalidateProductSessionIfRequired({ status: response.status, code: error?.error?.code })
    throw new ProductApiError(error?.error?.message ?? '工作区服务返回异常。', response.status, error?.error?.code)
  }
  return payload as T
}

const reportAccountSecurityEvent = createSecurityAuditReporter(async (action) => {
  await productRequest<void>('/api/account/security-events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  })
})

export async function readProductSession() {
  if (!serverPersistenceEnabled) return undefined
  if (supabase) {
    const { data } = await withAuthTimeout(
      supabase.auth.getSession(),
      '登录恢复超时，请重新登录。',
    )
    if (!data.session) {
      if (!hybridAuthEnabled) return undefined
      try {
        const response = await productRequest<{ user: ProductUser | null }>('/api/session')
        return response.user ?? undefined
      } catch (error) {
        if (error instanceof ProductApiError && error.status === 401) return undefined
        throw error
      }
    }
    // POST 只负责补齐 <img> 的同源 Cookie；失败时不应把已登录用户踢回登录页。
    const fallbackUser = sessionUserFallback(data.session.user)
    void syncMediaSessionCookie(data.session.access_token).catch(() => undefined)
    try {
      const profile = await withAuthTimeout(
        productRequest<{ user: ProductUser | null }>('/api/session'),
        '工作区身份读取超时。',
      )
      return profile.user ?? fallbackUser
    } catch (error) {
      // 服务端用户状态是工作区访问的权威来源；被停用时不能回退到本地 Supabase 资料。
      if (error instanceof ProductApiError && (error.status === 401 || error.status === 403)) return undefined
      return fallbackUser
    }
  }
  try {
    const response = await productRequest<{ user: ProductUser | null }>('/api/session')
    return response.user ?? undefined
  } catch (error) {
    if (error instanceof ProductApiError && error.status === 401) return undefined
    throw error
  }
}

export async function createProductSession(input: string | { email: string; password: string } | { accessToken: string }) {
  if (typeof input === 'object' && 'accessToken' in input) {
    if (!hybridAuthEnabled) throw new ProductApiError('当前环境未启用迁移登录。', 400, 'HYBRID_AUTH_REQUIRED')
    await supabase?.auth.signOut().catch(() => undefined)
    const response = await productRequest<{ user: ProductUser }>('/api/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken: input.accessToken }),
    })
    return response.user
  }
  if (supabase) {
    if (typeof input === 'string') throw new ProductApiError('请使用邮箱和密码登录。', 400, 'SUPABASE_AUTH_REQUIRED')
    const { data, error } = await supabase.auth.signInWithPassword({ email: input.email, password: input.password })
    if (error) throw new ProductApiError(error.message, 401, 'SUPABASE_SIGN_IN_FAILED')
    const user = data.user
    if (!user) throw new ProductApiError('登录成功，但未返回工作区身份。', 401, 'PROFILE_UNAVAILABLE')
    const profile = await productRequest<{ user: ProductUser | null }>('/api/session')
    if (!profile.user) throw new ProductApiError('该账号尚未加入 Botanic 工作区。', 403, 'WORKSPACE_ACCESS_REQUIRED')
    if (data.session?.access_token) void syncMediaSessionCookie(data.session.access_token).catch(() => undefined)
    return profile.user
  }
  const response = await productRequest<{ user: ProductUser }>('/api/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken: input }),
  })
  return response.user
}

export async function clearProductSession() {
  if (!serverPersistenceEnabled) return
  if (supabase) {
    const { error } = await supabase.auth.signOut()
    await clearMediaSessionCookie()
    if (error) throw new ProductApiError(error.message, 500, 'SUPABASE_SIGN_OUT_FAILED')
    return
  }
  await productRequest<void>('/api/session', { method: 'DELETE' })
}

export function productPasswordSetupRequired() {
  return supabaseAuthEnabled
    && typeof window !== 'undefined'
    && detectProductAuthFlow(window.location) !== null
}

export async function completeProductPasswordSetup(password: string) {
  await updateProductPassword(password)
  // 移除邀请 / 恢复链接中的敏感片段；否则 PKCE 的 ?code 会在刷新后再次触发设置密码页。
  window.history.replaceState(null, '', cleanProductAuthUrl(window.location.href))
}

export async function updateProductPassword(password: string) {
  if (!supabase) throw new ProductApiError('当前环境未启用账号密码。', 400, 'SUPABASE_AUTH_REQUIRED')
  if (password.length < 8) throw new ProductApiError('密码至少需要 8 个字符。', 400, 'PASSWORD_TOO_SHORT')
  const { error } = await supabase.auth.updateUser({ password })
  if (error) throw new ProductApiError(error.message, 400, 'PASSWORD_SETUP_FAILED')
  await reportAccountSecurityEvent('security.password.changed')
}

function requireAccountSecurity() {
  if (!accountSecurity) throw new ProductApiError('当前环境未启用正式账户安全。', 400, 'SUPABASE_AUTH_REQUIRED')
  return accountSecurity
}

export async function readProductMfaStatus(): Promise<AccountMfaStatus> {
  return requireAccountSecurity().status()
}

export async function enrollProductMfa(): Promise<AccountMfaEnrollment> {
  return requireAccountSecurity().enroll()
}

export async function verifyProductMfa(factorId: string, code: string, enabling = false) {
  await requireAccountSecurity().verify(factorId, code)
  if (enabling) await reportAccountSecurityEvent('security.mfa.enabled')
}

export async function removeProductMfa(factorId: string) {
  await requireAccountSecurity().remove(factorId)
  await reportAccountSecurityEvent('security.mfa.disabled')
}

export async function signOutOtherProductSessions() {
  await requireAccountSecurity().signOutOtherSessions()
  await reportAccountSecurityEvent('security.sessions.revoked')
}

export async function listWorkspaceMembers() {
  const response = await productRequest<{ users: WorkspaceMember[] }>('/api/users')
  return response.users
}

export async function listWorkspaceAuditEvents(limit = 100) {
  const response = await productRequest<{ events: WorkspaceAuditEvent[] }>(`/api/audit?limit=${Math.max(1, Math.min(limit, 500))}`)
  return response.events
}

export async function inviteWorkspaceMember(input: { email: string; name?: string; role: 'owner' | 'member' }) {
  const response = await productRequest<{ user: WorkspaceMember }>('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  return response.user
}

export async function updateWorkspaceMember(userId: string, updates: { role?: 'owner' | 'member'; status?: 'active' | 'disabled' }) {
  const response = await productRequest<{ user: WorkspaceMember }>(`/api/users/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  })
  return response.user
}
