import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./store/postgresProductStore.mjs', import.meta.url), 'utf8')

test('PostgreSQL 行动调和在同一事务锁内用数据库时钟写回执与安全 Audit', () => {
  assert.match(source, /resolveAgentActionReceipt[\s\S]*pg_advisory_xact_lock\(hashtextextended[\s\S]*for update/iu)
  assert.match(source, /resolveAgentActionReceipt[\s\S]*clock_timestamp[\s\S]*agentActionReceiptResolutionDecision/iu)
  assert.match(source, /resolveAgentActionReceipt[\s\S]*authoritativeAgentActionManualRetryAuthorization/iu)
  assert.match(source, /resolveAgentActionReceipt[\s\S]*update agent_action_receipts[\s\S]*agent-action\.reconciled/iu)
})

test('PostgreSQL 手动重试授权按 retryReceiptId 原子消费且 Audit 不写 tokenHash', () => {
  const method = source.slice(
    source.indexOf('async consumeAgentActionManualRetryAuthorization'),
    source.indexOf('async putGenerationJob', source.indexOf('async consumeAgentActionManualRetryAuthorization')),
  )
  assert.match(method, /pg_advisory_xact_lock\(hashtextextended[\s\S]*for update/iu)
  assert.match(method, /clock_timestamp[\s\S]*agentActionManualRetryConsumptionDecision/iu)
  assert.match(method, /update agent_action_receipts[\s\S]*agent-action\.manual-retry-consumed/iu)
  assert.match(method, /retryReceiptId/iu)
  assert.doesNotMatch(method.slice(method.indexOf('detail:')), /tokenHash/iu)
})
