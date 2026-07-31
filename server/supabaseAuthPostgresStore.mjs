import { createClient } from '@supabase/supabase-js'

function displayName(user) {
  const candidate = user?.user_metadata?.display_name
  if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  return user?.email?.split('@')[0] || 'Botanic Member'
}

function authClient({ url, secretKey, client }) {
  if (client) return client
  if (!url || !secretKey) throw new Error('SUPABASE_URL 与 SUPABASE_SECRET_KEY 未配置。')
  return createClient(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  })
}

/**
 * 迁移桥接：身份仍由可用的 Supabase Auth 验证，项目、任务与媒体元数据改写入
 * Railway PostgreSQL。这里绝不调用 Supabase 的 PostgREST 数据接口。
 */
export function createSupabaseAuthPostgresStore({ productStore, url, secretKey, bootstrapEmail, inviteRedirectTo, client }) {
  if (!productStore?.ensureAuthenticatedUser) throw new Error('PostgreSQL 存储缺少登录用户同步能力。')
  const supabase = authClient({ url, secretKey, client })
  const isBootstrapOwner = (email) => Boolean(bootstrapEmail && email && email.toLowerCase() === bootstrapEmail.toLowerCase())

  return {
    ...productStore,
    authProvider: 'supabase',

    async authenticate(accessToken) {
      if (!accessToken) return undefined
      const { data, error } = await supabase.auth.getUser(accessToken)
      if (error || !data?.user) return undefined
      return productStore.ensureAuthenticatedUser({
        id: data.user.id,
        email: data.user.email,
        name: displayName(data.user),
        roleHint: isBootstrapOwner(data.user.email) ? 'owner' : 'member',
      })
    },

    async createUser(actorId, { email, name, role = 'member' }) {
      const actor = await productStore.readUser(actorId)
      if (actor?.role !== 'owner') {
        const error = new Error('只有工作区所有者可以邀请成员。')
        error.code = 'USER_CREATE_FORBIDDEN'
        throw error
      }
      const { data, error } = await supabase.auth.admin.inviteUserByEmail(email, {
        data: { display_name: name || email },
        ...(inviteRedirectTo ? { redirectTo: inviteRedirectTo } : {}),
      })
      if (error || !data?.user) throw error ?? new Error('邀请成员失败。')
      return productStore.ensureAuthenticatedUser({
        id: data.user.id,
        email,
        name: name || email,
        roleHint: role,
      })
    },
  }
}
