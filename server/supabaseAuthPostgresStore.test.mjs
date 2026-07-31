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
  assert.deepEqual(calls, [{ id: 'user-1', email: 'owner@botanic.test', name: 'Leo', roleHint: 'owner' }])
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
