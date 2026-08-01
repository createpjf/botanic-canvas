type AuthFailure = { message?: string } | null

type MfaFactor = { id: string; status?: string; friendly_name?: string }

export type AccountMfaStatus = {
  currentLevel: 'aal1' | 'aal2' | null
  enabled: boolean
  factors: Array<{ id: string; name: string }>
}

export type AccountMfaEnrollment = {
  factorId: string
  qrCode: string
  secret: string
  uri: string
}

type AccountSecurityClient = {
  mfa: {
    listFactors?: () => Promise<{ data: { totp?: MfaFactor[] } | null; error: AuthFailure }>
    getAuthenticatorAssuranceLevel?: () => Promise<{ data: { currentLevel?: string | null; nextLevel?: string | null } | null; error: AuthFailure }>
    enroll?: (input: { factorType: 'totp'; friendlyName: string }) => Promise<{ data: { id: string; totp: { qr_code: string; secret: string; uri: string } } | null; error: AuthFailure }>
    challengeAndVerify?: (input: { factorId: string; code: string }) => Promise<{ data: unknown; error: AuthFailure }>
    unenroll?: (input: { factorId: string }) => Promise<{ data: unknown; error: AuthFailure }>
  }
  refreshSession?: () => Promise<{ data: unknown; error: AuthFailure }>
  signOut?: (input: { scope: 'others' }) => Promise<{ error: AuthFailure }>
}

function failure(error: AuthFailure, fallback: string) {
  if (error) throw new Error(error.message || fallback)
}

export function createAccountSecurityService(client: AccountSecurityClient) {
  return {
    async status(): Promise<AccountMfaStatus> {
      if (!client.mfa.listFactors || !client.mfa.getAuthenticatorAssuranceLevel) throw new Error('当前登录服务不支持二步验证。')
      const [factorResult, levelResult] = await Promise.all([
        client.mfa.listFactors(),
        client.mfa.getAuthenticatorAssuranceLevel(),
      ])
      failure(factorResult.error, '无法读取二步验证状态。')
      failure(levelResult.error, '无法读取当前会话安全等级。')
      const factors = (factorResult.data?.totp ?? [])
        .filter((factor) => factor.status === 'verified')
        .map((factor) => ({ id: factor.id, name: factor.friendly_name || '身份验证器' }))
      const currentLevel = levelResult.data?.currentLevel
      return {
        currentLevel: currentLevel === 'aal1' || currentLevel === 'aal2' ? currentLevel : null,
        enabled: factors.length > 0,
        factors,
      }
    },

    async enroll(): Promise<AccountMfaEnrollment> {
      if (!client.mfa.enroll) throw new Error('当前登录服务不支持二步验证。')
      const result = await client.mfa.enroll({ factorType: 'totp', friendlyName: 'Botanic Authenticator' })
      failure(result.error, '无法开始二步验证设置。')
      if (!result.data?.id || !result.data.totp) throw new Error('登录服务未返回二步验证信息。')
      return {
        factorId: result.data.id,
        qrCode: result.data.totp.qr_code,
        secret: result.data.totp.secret,
        uri: result.data.totp.uri,
      }
    },

    async verify(factorId: string, code: string) {
      if (!client.mfa.challengeAndVerify || !client.refreshSession) throw new Error('当前登录服务不支持二步验证。')
      if (!/^\d{6}$/.test(code)) throw new Error('请输入 6 位验证码。')
      const result = await client.mfa.challengeAndVerify({ factorId, code })
      failure(result.error, '验证码无效。')
      const refreshed = await client.refreshSession()
      failure(refreshed.error, '二步验证成功，但会话刷新失败。')
    },

    async remove(factorId: string) {
      if (!client.mfa.unenroll) throw new Error('当前登录服务不支持二步验证。')
      const result = await client.mfa.unenroll({ factorId })
      failure(result.error, '无法移除二步验证。')
    },

    async signOutOtherSessions() {
      if (!client.signOut) throw new Error('当前登录服务不支持设备管理。')
      const result = await client.signOut({ scope: 'others' })
      failure(result.error, '无法退出其他设备。')
    },
  }
}
