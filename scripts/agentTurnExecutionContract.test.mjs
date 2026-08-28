import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const migration = readFileSync(new URL('../supabase/migrations/20260827140000_agent_turn_execution_claim.sql', import.meta.url), 'utf8')
const supabaseAdapter = readFileSync(new URL('../server/supabaseProductStore.mjs', import.meta.url), 'utf8')
const reconciliationMigration = readFileSync(new URL('../supabase/migrations/20260827150000_agent_action_reconciliation.sql', import.meta.url), 'utf8')

test('Supabase Turn 执行 claim 使用数据库时钟、行锁与 execution version', () => {
  assert.match(migration, /create or replace function public\.botanic_claim_agent_turn_execution/iu)
  assert.match(migration, /pg_advisory_xact_lock/iu)
  assert.match(migration, /clock_timestamp\(\)/iu)
  assert.match(migration, /execution_version/iu)
  assert.match(migration, /lease_expires_at/iu)
  assert.match(migration, /allowTakeover/iu)
})

test('Supabase legacy Turn 只从已存 request 按版本比较后回填摘要', () => {
  assert.match(migration, /add column if not exists request_hash_version/iu)
  assert.match(migration, /source_hash_version not in \(1, 2\)/iu)
  assert.match(migration, /jsonb_typeof\(existing\.payload->'request'\) <> 'object'/iu)
  assert.match(migration, /stored_request_intent[\s\S]*source_request_intent[\s\S]*is distinct from/iu)
  assert.match(migration, /existing\.payload \|\| jsonb_build_object\([\s\S]*'requestHash'[\s\S]*'requestHashVersion'/iu)
  assert.doesNotMatch(
    migration,
    /request_hash\s*=\s*coalesce\(request_hash,\s*nullif\(source_turn->>'requestHash'/iu,
  )
})

test('Supabase Turn fenced commit 在同一事务分配事件序号并拒绝旧租约', () => {
  assert.match(migration, /create or replace function public\.botanic_commit_agent_turn_execution/iu)
  assert.match(migration, /last_sequence\s*\+\s*1/iu)
  assert.match(migration, /AGENT_TURN_LEASE_STALE|PAT01/iu)
  assert.match(migration, /insert into public\.agent_turn_events/iu)
  assert.match(migration, /update public\.agent_turns/iu)
  assert.match(migration, /grant execute on function public\.botanic_commit_agent_turn_execution/iu)
})

test('Supabase 普通 Turn commit 不接受 cancelled，取消终态只由 finalize RPC 写入', () => {
  assert.match(
    migration,
    /requested_status not in \('running', 'waiting_user', 'completed', 'failed'\)/iu,
  )
  assert.match(
    migration,
    /existing\.status = 'cancelling' then[\s\S]*jsonb_build_object\('kind', 'cancelling'/iu,
  )
  assert.doesNotMatch(
    migration,
    /requested_status not in \([^)]*'cancelled'/iu,
  )
})

test('Supabase Turn 取消在同一行锁内压过完成提交并持久化 cancelling 事件', () => {
  assert.match(migration, /create or replace function public\.botanic_request_agent_turn_cancellation/iu)
  assert.match(migration, /status = 'cancelling'[\s\S]*insert into public\.agent_turn_events/iu)
  assert.match(migration, /grant execute on function public\.botanic_request_agent_turn_cancellation/iu)
  assert.match(supabaseAdapter, /requestAgentTurnCancellation\(userId, request\)/u)
})

test('Supabase Turn 取消收口原子写 cancelled、顺序事件与 Audit', () => {
  assert.match(reconciliationMigration, /create or replace function public\.botanic_finalize_agent_turn_cancellation/iu)
  assert.match(reconciliationMigration, /pg_advisory_xact_lock[\s\S]*for update[\s\S]*clock_timestamp/iu)
  assert.match(reconciliationMigration, /insert into public\.agent_turn_events[\s\S]*update public\.agent_turns[\s\S]*agent-turn\.cancelled/iu)
  assert.match(reconciliationMigration, /grant execute on function public\.botanic_finalize_agent_turn_cancellation[\s\S]*service_role/iu)
  assert.match(supabaseAdapter, /finalizeAgentTurnCancellation\(userId, command\)[\s\S]*botanic_finalize_agent_turn_cancellation/u)
})

test('Supabase Adapter 不会在缺失原子 RPC 时退回 read-then-upsert', () => {
  assert.match(supabaseAdapter, /claimAgentTurnExecution\(userId, claim\)/u)
  assert.match(supabaseAdapter, /botanic_claim_agent_turn_execution/u)
  assert.match(supabaseAdapter, /commitAgentTurnExecution\(userId, command\)/u)
  assert.match(supabaseAdapter, /botanic_commit_agent_turn_execution/u)
  assert.match(supabaseAdapter, /AGENT_TURN_ATOMIC_CLAIM_REQUIRED/u)
})
