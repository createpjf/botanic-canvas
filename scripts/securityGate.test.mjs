import assert from 'node:assert/strict'
import test from 'node:test'
import { securityGateFindings } from './securityGate.mjs'

test('安全门禁允许根目录与子目录中的示例环境文件', () => {
  const findings = securityGateFindings(['.env.example', 'deploy/.env.example'], () => 'MINIMAX_API_KEY=sk-api-example')
  assert.deepEqual(findings, [])
})

test('安全门禁拒绝环境文件、私钥和常见生产凭据', () => {
  const content = new Map([
    ['.env.production', 'MINIMAX_API_KEY=hidden'],
    ['server/.env.production', 'REALTIME_TICKET_SECRET=hidden'],
    ['cert.pem', 'certificate'],
    ['src/config.ts', `const key = "${'sb_' + 'secret_' + 'abcdefghijklmnopqrstuvwxyz123456'}"`],
    ['docs/private.txt', `DATABASE_URL=${'postgresql://user:' + 'private-password@db.example.com:5432/app'}`],
  ])
  const findings = securityGateFindings([...content.keys()], (file) => content.get(file) ?? '')
  assert.equal(findings.length, 5)
})
