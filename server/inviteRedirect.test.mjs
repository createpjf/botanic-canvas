import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_PRODUCTION_APP_URL, resolveInviteRedirectTo } from './inviteRedirect.mjs'

test('生产环境不会把 Supabase 邀请带回 localhost', () => {
  assert.equal(resolveInviteRedirectTo({ configured: 'http://localhost:8080', production: true }), DEFAULT_PRODUCTION_APP_URL)
})

test('生产环境不会把公共地址配置中的 localhost 作为回调', () => {
  assert.equal(resolveInviteRedirectTo({ publicAppUrl: 'http://localhost:8080', production: true }), DEFAULT_PRODUCTION_APP_URL)
})

test('生产环境保留显式正式域名邀请回调', () => {
  assert.equal(resolveInviteRedirectTo({ configured: 'https://botanic.example/auth/callback', production: true }), 'https://botanic.example/auth/callback')
})

test('本地开发允许使用本机邀请回调', () => {
  assert.equal(resolveInviteRedirectTo({ configured: 'http://localhost:8080', production: false }), 'http://localhost:8080/')
})
