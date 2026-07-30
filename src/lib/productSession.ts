import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export type ProductUser = {
  id: string
  email: string
  name: string
  role: 'owner' | 'member'
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
export const supabaseAuthEnabled = serverPersistenceEnabled && Boolean(supabaseUrl && supabasePublishableKey)

const supabase: SupabaseClient | undefined = supabaseAuthEnabled
  ? createClient(supabaseUrl, supabasePublishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : undefined

async function authorizationHeader() {
  if (!supabase) return {}
  const { data } = await supabase.auth.getSession()
  return data.session ? { Authorization: `Bearer ${data.session.access_token}` } : {}
}

export async function productAuthorizationHeader() {
  return authorizationHeader()
}

export async function productRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    const headers = new Headers(init.headers)
    headers.set('Accept', 'application/json')
    for (const [key, value] of Object.entries(await authorizationHeader())) headers.set(key, value)
    response = await fetch(path, {
      ...init,
      credentials: 'include',
      headers,
    })
  } catch {
    throw new ProductApiError('无法连接工作区服务，请检查网络或稍后重试。', 0)
  }
  const payload = await response.json().catch(() => null) as T | ApiErrorPayload | null
  if (!response.ok) {
    const error = payload as ApiErrorPayload | null
    throw new ProductApiError(error?.error?.message ?? '工作区服务返回异常。', response.status, error?.error?.code)
  }
  return payload as T
}

export async function readProductSession() {
  if (!serverPersistenceEnabled) return undefined
  if (supabase) {
    const { data } = await supabase.auth.getSession()
    if (!data.session) return undefined
  }
  try {
    const response = await productRequest<{ user: ProductUser | null }>('/api/session')
    return response.user ?? undefined
  } catch (error) {
    if (error instanceof ProductApiError && error.status === 401) return undefined
    throw error
  }
}

export async function createProductSession(input: string | { email: string; password: string }) {
  if (supabase) {
    if (typeof input === 'string') throw new ProductApiError('请使用邮箱和密码登录。', 400, 'SUPABASE_AUTH_REQUIRED')
    const { error } = await supabase.auth.signInWithPassword({ email: input.email, password: input.password })
    if (error) throw new ProductApiError(error.message, 401, 'SUPABASE_SIGN_IN_FAILED')
    const user = await readProductSession()
    if (!user) throw new ProductApiError('登录成功，但无法初始化工作区身份。', 401, 'PROFILE_UNAVAILABLE')
    return user
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
    if (error) throw new ProductApiError(error.message, 500, 'SUPABASE_SIGN_OUT_FAILED')
    return
  }
  await productRequest<void>('/api/session', { method: 'DELETE' })
}
