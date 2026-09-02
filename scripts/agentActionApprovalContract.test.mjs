import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const serverRoutes = readFileSync(new URL('../server/http/agentRoutes.mjs', import.meta.url), 'utf8')
const clientApi = readFileSync(new URL('../src/lib/agentApi.ts', import.meta.url), 'utf8')
const skillRegistry = readFileSync(new URL('../src/features/agent/useAgentSkillRegistry.ts', import.meta.url), 'utf8')

function approvalNames(source, declaration) {
  const match = source.match(new RegExp(`const ${declaration} = new Set\\(\\[([\\s\\S]*?)\\]\\)`))
  assert.ok(match, `找不到 ${declaration}`)
  return [...match[1].matchAll(/'([a-z_]+)'/gu)].map((item) => item[1]).sort()
}

test('客户端与服务端共用同一组需要签名审批的 Agent 行动', () => {
  assert.deepEqual(
    approvalNames(clientApi, 'agentActionsRequiringApproval'),
    approvalNames(serverRoutes, 'approvalRequired'),
  )
})

test('Skill 创建失败重试复用同一逻辑提交身份，成功后才清除', () => {
  assert.match(clientApi, /submissionKey\?: string[\s\S]*toolCallId\?: string/u)
  assert.match(clientApi, /'Idempotency-Key': submissionKey/u)
  assert.match(skillRegistry, /pendingSubmissionRef\.current\?\.fingerprint !== fingerprint[\s\S]*crypto\.randomUUID\(\)/u)
  assert.match(skillRegistry, /submissionKey: pendingSubmissionRef\.current\.submissionKey/u)
  assert.match(skillRegistry, /pendingSubmissionRef\.current = null[\s\S]*submitSucceeded/u)
})
