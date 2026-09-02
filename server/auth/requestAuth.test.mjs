import assert from 'node:assert/strict'
import test from 'node:test'
import { accessTokenFromRequest } from './requestAuth.mjs'

test('业务 API 只接受 Bearer Token，不把媒体 Cookie 当作写权限', () => {
  const request = { headers: { cookie: 'botanic_session=media-token' } }
  assert.equal(accessTokenFromRequest(request), undefined)
  assert.equal(accessTokenFromRequest(request, { allowMediaCookie: true }), 'media-token')
})

test('Bearer Token 始终优先于媒体 Cookie', () => {
  const request = { headers: { authorization: 'Bearer user-token', cookie: 'botanic_session=media-token' } }
  assert.equal(accessTokenFromRequest(request, { allowMediaCookie: true }), 'user-token')
})
