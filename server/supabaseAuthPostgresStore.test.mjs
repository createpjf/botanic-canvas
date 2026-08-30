import assert from 'node:assert/strict'
import test from 'node:test'
import { createSupabaseAuthPostgresStore } from './supabaseAuthPostgresStore.mjs'

test('Supabase 登录仅校验 Auth，并把用户同步到 PostgreSQL 存储', async () => {
  const calls = []
  const store = createSupabaseAuthPostgresStore({
    productStore: {
      async ensureAuthenticatedUser(user) { calls.push(user); return { ...user, role: 'owner' } },
      async readUser() { return undefined },
    },
    bootstrapEmail: 'owner@botanic.test',
    client: { auth: { async getUser(token) {
      assert.equal(token, 'jwt-token')
      return { data: { user: { id: 'user-1', email: 'owner@botanic.test', user_metadata: { display_name: 'Leo' } } }, error: null }
    } } },
  })

  const user = await store.authenticate('jwt-token')
  assert.deepEqual(calls, [{ id: 'user-1', email: 'owner@botanic.test', name: 'Leo', roleHint: 'owner', statusHint: 'active', createIfMissing: true }])
  assert.equal(user?.id, 'user-1')
})

test('无效登录不会写入 PostgreSQL', async () => {
  let writes = 0
  const store = createSupabaseAuthPostgresStore({
    productStore: { async ensureAuthenticatedUser() { writes += 1 }, async readUser() { return undefined } },
    client: { auth: { async getUser() { return { data: { user: null }, error: new Error('invalid token') } } } },
  })
  assert.equal(await store.authenticate('expired'), undefined)
  assert.equal(writes, 0)
})

test('Hybrid 模式在 Supabase 无法识别令牌时兼容旧访问令牌', async () => {
  const store = createSupabaseAuthPostgresStore({
    productStore: {
      async ensureAuthenticatedUser() { throw new Error('不应同步用户') },
      async authenticate(token) { return token === 'legacy-token' ? { id: 'legacy-owner', role: 'owner' } : undefined },
    },
    allowLegacyTokens: true,
    client: { auth: { async getUser() { return { data: { user: null }, error: new Error('not a Supabase JWT') } } } },
  })

  assert.deepEqual(await store.authenticate('legacy-token'), { id: 'legacy-owner', role: 'owner' })
})

test('Hybrid 模式优先采用有效 Supabase 身份，不把未授权账号降级为旧令牌', async () => {
  let legacyAttempts = 0
  const store = createSupabaseAuthPostgresStore({
    productStore: {
      async ensureAuthenticatedUser(input) {
        assert.equal(input.createIfMissing, false)
        return undefined
      },
      async authenticate() { legacyAttempts += 1; return { id: 'unexpected' } },
    },
    allowLegacyTokens: true,
    bootstrapEmail: 'owner@botanic.test',
    client: { auth: { async getUser() {
      return { data: { user: { id: 'stranger', email: 'stranger@example.com', user_metadata: {} } }, error: null }
    } } },
  })

  assert.equal(await store.authenticate('valid-supabase-jwt'), undefined)
  assert.equal(legacyAttempts, 0)
})

test('未邀请的 Supabase 用户不会自动加入工作区', async () => {
  let writes = 0
  const store = createSupabaseAuthPostgresStore({
    productStore: {
      async ensureAuthenticatedUser(input) {
        assert.equal(input.createIfMissing, false)
        return undefined
      },
    },
    bootstrapEmail: 'owner@botanic.test',
    client: { auth: { async getUser() {
      return { data: { user: { id: 'unknown-user', email: 'stranger@example.com', user_metadata: {} } }, error: null }
    } } },
  })

  assert.equal(await store.authenticate('valid-jwt'), undefined)
  assert.equal(writes, 0)
})

test('Owner 邀请成员时在 Auth 发送邮件，并以待接受状态写入 PostgreSQL', async () => {
  const ensured = []
  const store = createSupabaseAuthPostgresStore({
    productStore: {
      async readUser() { return { id: 'owner-1', role: 'owner' } },
      async ensureAuthenticatedUser(user) { ensured.push(user); return { ...user, role: 'member', status: user.statusHint } },
    },
    inviteRedirectTo: 'https://botanic.test/auth/callback',
    client: { auth: { admin: { async inviteUserByEmail(email, options) {
      assert.equal(email, 'member@botanic.test')
      assert.equal(options.redirectTo, 'https://botanic.test/auth/callback')
      return { data: { user: { id: 'user-2' } }, error: null }
    } } } },
  })

  const invited = await store.createUser('owner-1', { email: 'member@botanic.test', name: 'Member' })
  assert.equal(invited.status, 'invited')
  assert.deepEqual(ensured, [{ id: 'user-2', email: 'member@botanic.test', name: 'Member', roleHint: 'member', statusHint: 'invited' }])
})

test('配置 Resend 后用 Supabase generateLink 生成验证链接，并发送欢迎与验证邮件', async () => {
  const calls = []
  const generated = []
  const target = { id: 'user-2', email: 'member@botanic.test', name: 'Member', role: 'member', status: 'invited' }
  const store = createSupabaseAuthPostgresStore({
    productStore: {
      async readUser(userId) {
        return userId === 'owner-1' ? { id: 'owner-1', role: 'owner', status: 'active' } : target
      },
      async ensureAuthenticatedUser(input) { return { ...target, ...input, status: input.statusHint } },
    },
    inviteRedirectTo: 'https://botanic.test/auth/callback',
    emailService: {
      async sendVerificationEmail(input) { calls.push(['verification', input]) },
      async sendWelcomeEmail(input) { calls.push(['welcome', input]) },
    },
    client: { auth: { admin: { async generateLink(input) {
      generated.push(input)
      return { data: { user: { id: 'user-2' }, properties: { action_link: 'https://botanic.test/auth/callback?code=generated' } }, error: null }
    } } } },
  })

  const invited = await store.createUser('owner-1', { email: target.email, name: target.name })
  assert.equal(invited.status, 'invited')
  assert.deepEqual(generated, [{
    type: 'invite', email: target.email,
    options: { data: { display_name: target.name }, redirectTo: 'https://botanic.test/auth/callback' },
  }])
  assert.deepEqual(calls, [
    ['verification', { userId: 'user-2', to: target.email, actionLink: 'https://botanic.test/auth/callback?code=generated' }],
    ['welcome', { userId: 'user-2', to: target.email, name: target.name }],
  ])

  await store.resendUserInvite('owner-1', target.id)
  assert.equal(calls.filter(([type]) => type === 'welcome').length, 1)
  assert.equal(calls.filter(([type]) => type === 'verification').length, 2)
})

test('Owner 可为待接受成员重新发送邀请且保留原用户身份', async () => {
  const invites = []
  const target = { id: 'user-2', email: 'member@botanic.test', name: 'Member', role: 'member', status: 'invited' }
  const store = createSupabaseAuthPostgresStore({
    productStore: {
      async ensureAuthenticatedUser() { return target },
      async readUser(userId) {
        if (userId === 'owner-1') return { id: 'owner-1', role: 'owner', status: 'active' }
        if (userId === target.id) return target
        return undefined
      },
    },
    inviteRedirectTo: 'https://botanic.test/auth/callback',
    client: { auth: { admin: { async inviteUserByEmail(email, options) {
      invites.push({ email, options })
      return { data: { user: { id: target.id } }, error: null }
    } } } },
  })

  const resent = await store.resendUserInvite('owner-1', target.id)
  assert.equal(resent.id, target.id)
  assert.deepEqual(invites, [{
    email: target.email,
    options: { data: { display_name: target.name }, redirectTo: 'https://botanic.test/auth/callback' },
  }])
})

test('已启用成员不能走重新发送邀请流程', async () => {
  const store = createSupabaseAuthPostgresStore({
    productStore: {
      async ensureAuthenticatedUser() { return undefined },
      async readUser(userId) {
        return userId === 'owner-1'
          ? { id: 'owner-1', role: 'owner', status: 'active' }
          : { id: userId, email: 'active@botanic.test', name: 'Active', role: 'member', status: 'active' }
      },
    },
    client: { auth: { admin: { async inviteUserByEmail() { throw new Error('不应发送') } } } },
  })

  await assert.rejects(() => store.resendUserInvite('owner-1', 'user-2'), (error) => error?.code === 'USER_INVITE_NOT_PENDING')
})

test('Owner 停用成员时同时禁用 Auth 身份与工作区权限', async () => {
  const calls = []
  const store = createSupabaseAuthPostgresStore({
    productStore: {
      async ensureAuthenticatedUser() { return undefined },
      async readUser() { return { id: 'owner-1', role: 'owner' } },
      async updateUser(actorId, userId, updates) {
        calls.push(['store', actorId, userId, updates])
        return { id: userId, role: 'member', status: updates.status }
      },
    },
    client: { auth: { admin: { async updateUserById(userId, updates) {
      calls.push(['auth', userId, updates])
      return { data: { user: { id: userId } }, error: null }
    } } } },
  })

  const disabled = await store.updateUser('owner-1', 'user-2', { status: 'disabled' })
  assert.equal(disabled.status, 'disabled')
  assert.deepEqual(calls, [
    ['store', 'owner-1', 'user-2', { status: 'disabled' }],
    ['auth', 'user-2', { ban_duration: '876000h' }],
  ])
})

test('敏感操作只接受已由 Supabase 验证且达到 AAL2 的会话', async () => {
  const payload = Buffer.from(JSON.stringify({ aal: 'aal2', session_id: 'session-1' })).toString('base64url')
  const token = `header.${payload}.signature`
  const store = createSupabaseAuthPostgresStore({
    productStore: { async ensureAuthenticatedUser() {}, async readUser() {} },
    client: { auth: { async getUser(received) {
      assert.equal(received, token)
      return { data: { user: { id: 'owner-1' } }, error: null }
    } } },
  })

  assert.deepEqual(await store.authAssurance(token), { aal: 'aal2', sessionId: 'session-1' })
})

test('伪造或无效会话不能获得敏感操作认证上下文', async () => {
  const store = createSupabaseAuthPostgresStore({
    productStore: { async ensureAuthenticatedUser() {}, async readUser() {} },
    client: { auth: { async getUser() { return { data: { user: null }, error: new Error('invalid') } } } },
  })

  assert.equal(await store.authAssurance('header.payload.signature'), undefined)
})
