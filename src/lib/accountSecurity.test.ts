import assert from 'node:assert/strict'
import test from 'node:test'
import { createAccountSecurityService } from './accountSecurity.ts'

test('账户安全状态只把已验证 TOTP 视为已启用', async () => {
  const service = createAccountSecurityService({
    mfa: {
      async listFactors() {
        return { data: { totp: [
          { id: 'verified', status: 'verified', friendly_name: 'Botanic' },
          { id: 'pending', status: 'unverified', friendly_name: 'Pending' },
        ] }, error: null }
      },
      async getAuthenticatorAssuranceLevel() {
        return { data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null }
      },
    },
  } as never)

  assert.deepEqual(await service.status(), {
    currentLevel: 'aal2',
    enabled: true,
    factors: [{ id: 'verified', name: 'Botanic' }],
  })
})

test('完成 TOTP 验证后刷新会话，敏感 API 可取得 AAL2 token', async () => {
  const calls: unknown[] = []
  const service = createAccountSecurityService({
    mfa: {
      async challengeAndVerify(input: unknown) { calls.push(input); return { data: {}, error: null } },
    },
    async refreshSession() { calls.push('refresh'); return { data: {}, error: null } },
  } as never)

  await service.verify('factor-1', '123456')
  assert.deepEqual(calls, [{ factorId: 'factor-1', code: '123456' }, 'refresh'])
})

test('退出其他设备不会结束当前浏览器会话', async () => {
  let scope
  const service = createAccountSecurityService({
    mfa: {},
    async signOut(input: unknown) { scope = input; return { error: null } },
  } as never)
  await service.signOutOtherSessions()
  assert.deepEqual(scope, { scope: 'others' })
})
