import { createClient } from '@supabase/supabase-js'
import { decodeAuthAssurance } from './authAssurance.mjs'
import { assertWorkspacePermission } from './authorization.mjs'
import { sendResendInviteEmails } from './resendEmailService.mjs'

function productError(message, code = 'PRODUCT_STORE_ERROR') {
  const error = new Error(message)
  error.code = code
  return error
}

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
export function createSupabaseAuthPostgresStore({ productStore, url, secretKey, bootstrapEmail, inviteRedirectTo, allowLegacyTokens = false, emailService, client }) {
  if (!productStore?.ensureAuthenticatedUser) throw new Error('PostgreSQL 存储缺少登录用户同步能力。')
  const supabase = authClient({ url, secretKey, client })
  const isBootstrapOwner = (email) => Boolean(bootstrapEmail && email && email.toLowerCase() === bootstrapEmail.toLowerCase())

  async function inviteUser(email, name, welcome = true) {
    const options = {
      data: { display_name: name || email },
      ...(inviteRedirectTo ? { redirectTo: inviteRedirectTo } : {}),
    }
    if (!emailService) {
      const { data, error } = await supabase.auth.admin.inviteUserByEmail(email, options)
      if (error || !data?.user) throw error ?? new Error('邀请成员失败。')
      return data.user
    }

    const { data, error } = await supabase.auth.admin.generateLink({ type: 'invite', email, options })
    if (error || !data?.user?.id || typeof data.properties?.action_link !== 'string') {
      throw error ?? productError('验证链接生成失败。', 'USER_INVITE_LINK_FAILED')
    }
    try {
      await sendResendInviteEmails({
        emailService,
        userId: data.user.id,
        email,
        name,
        actionLink: data.properties.action_link,
        welcome,
      })
    } catch (caught) {
      const failure = productError('邀请邮件发送失败，请稍后重试。', 'USER_INVITE_EMAIL_FAILED')
      failure.cause = caught
      throw failure
    }
    return data.user
  }

  return {
    ...productStore,
    authProvider: allowLegacyTokens ? 'hybrid' : 'supabase',

    async authenticate(accessToken) {
      if (!accessToken) return undefined
      const { data, error } = await supabase.auth.getUser(accessToken)
      if (error || !data?.user) {
        return allowLegacyTokens ? productStore.authenticate(accessToken) : undefined
      }
      // Supabase 只证明身份，不代表已获得 Botanic 工作区权限。
      // 除首位 Bootstrap Owner 外，新用户必须先由 Owner 邀请并写入成员表。
      return productStore.ensureAuthenticatedUser({
        id: data.user.id,
        email: data.user.email,
        name: displayName(data.user),
        roleHint: isBootstrapOwner(data.user.email) ? 'owner' : 'member',
        statusHint: 'active',
        createIfMissing: isBootstrapOwner(data.user.email),
      })
    },

    async authAssurance(accessToken) {
      if (!accessToken) return undefined
      const { data, error } = await supabase.auth.getUser(accessToken)
      if (error || !data?.user) return undefined
      return decodeAuthAssurance(accessToken)
    },

    async createUser(actorId, { email, name, role = 'member' }) {
      const actor = await productStore.readUser(actorId)
      assertWorkspacePermission(actor, 'manage-members', 'USER_CREATE_FORBIDDEN')
      const authUser = await inviteUser(email, name)
      return productStore.ensureAuthenticatedUser({
        id: authUser.id,
        email,
        name: name || email,
        roleHint: role,
        statusHint: 'invited',
      })
    },

    async resendUserInvite(actorId, userId) {
      const actor = await productStore.readUser(actorId)
      assertWorkspacePermission(actor, 'manage-members', 'USER_MANAGE_FORBIDDEN')
      const target = await productStore.readUser(userId)
      if (!target) throw productError('未找到该工作区成员。', 'USER_NOT_FOUND')
      if (target.status !== 'invited') throw productError('只有待接受成员可以重新发送邀请。', 'USER_INVITE_NOT_PENDING')

      await inviteUser(target.email, target.name, false)
      return target
    },

    async updateUser(actorId, userId, updates) {
      const saved = await productStore.updateUser(actorId, userId, updates)
      if (updates?.status) {
        const { error } = await supabase.auth.admin.updateUserById(userId, {
          ban_duration: updates.status === 'disabled' ? '876000h' : 'none',
        })
        if (error) throw error
      }
      return saved
    },
  }
}
