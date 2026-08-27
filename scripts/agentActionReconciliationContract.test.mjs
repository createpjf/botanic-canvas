import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const migration = readFileSync(new URL('../supabase/migrations/20260827150000_agent_action_reconciliation.sql', import.meta.url), 'utf8')
const adapter = readFileSync(new URL('../server/supabaseProductStore.mjs', import.meta.url), 'utf8')
const contract = readFileSync(new URL('../server/productStoreContract.mjs', import.meta.url), 'utf8')

test('ProductStore 将行动调和与一次性授权消费列为三 Adapter 核心契约', () => {
  assert.match(contract, /'resolveAgentActionReceipt'/u)
  assert.match(contract, /'consumeAgentActionManualRetryAuthorization'/u)
})

test('Supabase 行动调和 RPC 锁定权威回执并只决议 uncertain', () => {
  assert.match(migration, /create or replace function public\.botanic_resolve_agent_action_receipt/iu)
  assert.match(migration, /pg_advisory_xact_lock[\s\S]*for update[\s\S]*clock_timestamp/iu)
  assert.match(migration, /status' is distinct from 'uncertain'/iu)
  assert.match(migration, /actionBindingHash[\s\S]*confirmed_applied[\s\S]*confirmed_not_applied/iu)
  assert.match(migration, /- 'result' - 'output' - 'artifacts'/iu)
  assert.match(migration, /agent-action\.reconciled/iu)
  assert.match(migration, /grant execute on function public\.botanic_resolve_agent_action_receipt[\s\S]*service_role/iu)
})

test('Supabase 一次性授权兼容 v1 tokenHash，并把 v2 durable reservation 绑定 retryReceiptId', () => {
  assert.match(migration, /create or replace function public\.botanic_consume_agent_action_manual_retry/iu)
  assert.match(migration, /tokenHash[\s\S]*retryReceiptId/iu)
  assert.match(migration, /'version', 2[\s\S]*'boundRetryReceiptId'[\s\S]*'reservedAt'/u)
  assert.match(migration, /authorization->>'version' = '2'[\s\S]*boundRetryReceiptId'[\s\S]*p_command->>'retryReceiptId'/u)
  assert.match(migration, /consumedByReceiptId[\s\S]*already_consumed/iu)
  assert.match(migration, /clock_timestamp[\s\S]*expiresAt/iu)
  assert.match(migration, /agent-action\.manual-retry-consumed/iu)
  assert.match(migration, /grant execute on function public\.botanic_consume_agent_action_manual_retry[\s\S]*service_role/iu)
})

test('Supabase 对授权时间字段显式拒绝 NULL，v2 consume 不要求 raw token', () => {
  assert.match(migration, /nullif\(requested_authorization->>'issuedAt', ''\) is null/u)
  assert.match(migration, /nullif\(requested_authorization->>'reservedAt', ''\) is null/u)
  assert.match(migration, /nullif\(requested_authorization->>'expiresAt', ''\) is null/u)
  assert.match(migration, /jsonb_typeof\(requested_authorization->'version'\) is distinct from 'number'/u)
  assert.match(migration, /nullif\(authorization->>'consumedAt', ''\) is null/u)
  const consumeValidation = migration.slice(
    migration.indexOf('create or replace function public.botanic_consume_agent_action_manual_retry'),
    migration.indexOf('perform pg_advisory_xact_lock', migration.indexOf('create or replace function public.botanic_consume_agent_action_manual_retry')),
  )
  assert.doesNotMatch(consumeValidation, /nullif\(p_command->>'tokenHash', ''\) is null/u)
})

test('已消费手动重试的新回执只能 exhausted 失败，不能再签第二份授权', () => {
  assert.match(migration, /manualRetryExhausted[\s\S]*AGENT_ACTION_MANUAL_RETRY_EXHAUSTED/iu)
  assert.match(migration, /manual_retry_exhausted[\s\S]*- 'manualRetryAuthorization'/iu)
})

test('Supabase Adapter 只调用原子 RPC，缺迁移时不会 read-then-upsert', () => {
  assert.match(adapter, /resolveAgentActionReceipt\(userId, command\)[\s\S]*botanic_resolve_agent_action_receipt/u)
  assert.match(adapter, /consumeAgentActionManualRetryAuthorization\(userId, command\)[\s\S]*botanic_consume_agent_action_manual_retry/u)
  assert.match(adapter, /AGENT_ACTION_RECONCILIATION_REQUIRED/u)
})
