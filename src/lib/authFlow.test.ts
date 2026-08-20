import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanProductAuthUrl, detectProductAuthFlow, hasProductAuthCallbackError } from './authFlow.ts'

test('Supabase 邀请回调的 type=invite 会进入设置密码流程', () => {
  assert.equal(detectProductAuthFlow({ hash: '#access_token=token&type=invite', search: '', pathname: '/' }), 'invite')
})

test('PKCE 邀请回调 code 会进入设置密码流程', () => {
  assert.equal(detectProductAuthFlow({ hash: '', search: '?code=invite-code', pathname: '/auth/callback' }), 'invite')
})

test('普通工作区 URL 不会误触发设置密码流程', () => {
  assert.equal(detectProductAuthFlow({ hash: '#/canvas/project-1', search: '', pathname: '/canvas/project-1' }), null)
})

test('Supabase 失败回调会被识别并可清理', () => {
  const url = 'https://botanic.test/#error=access_denied&error_code=otp_expired&error_description=expired'
  assert.equal(hasProductAuthCallbackError({ hash: '#error=access_denied&error_code=otp_expired&error_description=expired' }), true)
  assert.equal(cleanProductAuthUrl(url), '/')
})

test('完成设置密码后会清理 PKCE code 和隐式 token，不重复进入设置页', () => {
  assert.equal(cleanProductAuthUrl('https://botanic.test/auth/callback?code=invite-code&next=%2Fprojects#access_token=secret&type=invite'), '/auth/callback?next=%2Fprojects')
})
