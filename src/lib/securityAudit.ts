export type AccountSecurityAuditAction =
  | 'security.password.changed'
  | 'security.mfa.enabled'
  | 'security.mfa.disabled'
  | 'security.sessions.revoked'

export function createSecurityAuditReporter(
  send: (action: AccountSecurityAuditAction) => Promise<void>,
  onFailure: (error: unknown) => void = (error) => console.warn('账户安全审计上报失败', error),
) {
  return async (action: AccountSecurityAuditAction) => {
    try {
      await send(action)
    } catch (error) {
      // 安全操作已在 Supabase 完成；审计链路故障不应误报操作失败。
      onFailure(error)
    }
  }
}
