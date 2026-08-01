import assert from 'node:assert/strict'
import test from 'node:test'
import { securityGateFindings } from './securityGate.mjs'

test('安全门禁允许示例环境文件与占位符', () => {
  const findings = securityGateFindings(['.env.example'], () => 'MINIMAX_API_KEY=sk-api-example')
  assert.deepEqual(findings, [])
})

test('安全门禁拒绝环境文件、私钥和常见生产凭据', () => {
  const content = new Map([
    ['.env.production', 'MINIMAX_API_KEY=hidden'],
    ['cert.pem', 'certificate'],
    ['src/config.ts', `const key = "${'sb_' + 'secret_' + 'abcdefghijklmnopqrstuvwxyz123456'}"`],
    ['docs/private.txt', `DATABASE_URL=${'postgresql://user:' + 'private-password@db.example.com:5432/app'}`],
  ])
  const findings = securityGateFindings([...content.keys()], (file) => content.get(file) ?? '')
  assert.equal(findings.length, 4)
})
