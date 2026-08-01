import assert from 'node:assert/strict'
import test from 'node:test'
import { createSecurityAuditReporter } from './securityAudit.ts'

test('账户安全操作成功后上报对应审计事件', async () => {
  const actions: string[] = []
  const report = createSecurityAuditReporter(async (action) => { actions.push(action) })

  await report('security.password.changed')
  await report('security.mfa.enabled')

  assert.deepEqual(actions, ['security.password.changed', 'security.mfa.enabled'])
})

test('审计上报失败不会把已完成的安全操作变成失败', async () => {
  const failures: unknown[] = []
  const report = createSecurityAuditReporter(
    async () => { throw new Error('network') },
    (error) => { failures.push(error) },
  )

  await assert.doesNotReject(report('security.sessions.revoked'))
  assert.equal(failures.length, 1)
})
