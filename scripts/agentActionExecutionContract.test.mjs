import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const migration = readFileSync(new URL('../supabase/migrations/20260827130000_agent_action_execution_claim.sql', import.meta.url), 'utf8')
const supabaseStore = readFileSync(new URL('../server/store/supabaseProductStore.mjs', import.meta.url), 'utf8')
const postgresStore = readFileSync(new URL('../server/store/postgresProductStore.mjs', import.meta.url), 'utf8')

test('Supabase 用事务 RPC 在副作用前 claim，并以 lease token 条件收口', () => {
  assert.match(migration, /create or replace function public\.botanic_claim_agent_action_receipt/iu)
  assert.match(migration, /create or replace function public\.botanic_settle_agent_action_receipt/iu)
  assert.match(migration, /pg_advisory_xact_lock/iu)
  assert.match(migration, /from public\.project_members[\s\S]*for share[\s\S]*member_role not in \('owner', 'editor'\)/u)
  assert.match(migration, /observed_at := floor\(extract\(epoch from clock_timestamp\(\)\) \* 1000\)/u)
  assert.match(migration, /existing\.payload->>'leaseToken' = p_claim->>'leaseToken'[\s\S]*'kind', 'claimed'/u)
  assert.match(migration, /current_status = 'failed'[\s\S]*replayPolicy'[\s\S]*= 'safe'[\s\S]*'kind', 'claimed'/u)
  assert.match(migration, /existing\.payload->>'leaseToken' is distinct from p_settlement->>'leaseToken'/iu)
  assert.match(migration, /nullif\(p_settlement->>'leaseToken', ''\) is null/u)
  assert.match(migration, /coalesce\(p_settlement->>'status', ''\) not in \('succeeded', 'failed', 'uncertain'\)/u)
  assert.match(migration, /current_status = p_settlement->>'status'[\s\S]*return existing\.payload/u)
  assert.doesNotMatch(migration, /current_status = p_settlement->>'status'[\s\S]{0,320}p_settlement->'result'/u)
  assert.doesNotMatch(migration, /existing\.payload \|\| p_(?:claim|settlement)/u)
  assert.match(migration, /incoming_binding := nullif\(btrim\(p_claim->>'actionBindingHash'\)[\s\S]*existing_binding := nullif\(btrim\(existing\.payload->>'actionBindingHash'\)[\s\S]*existing_binding is distinct from incoming_binding/u)
  assert.match(migration, /'actionBindingHash', incoming_binding/u)
  assert.match(migration, /insert into public\.agent_artifacts[\s\S]*distinct on \(candidate\.payload->>'id'\)[\s\S]*insert into public\.audit_events/u)
  assert.match(migration, /using errcode = 'PAA01'/u)
  assert.match(migration, /grant execute[\s\S]*to service_role/iu)
  assert.match(supabaseStore, /supabase\.rpc\('botanic_claim_agent_action_receipt'/u)
  assert.match(supabaseStore, /supabase\.rpc\('botanic_settle_agent_action_receipt'/u)
  assert.match(supabaseStore, /error\.code === 'PAA01'[\s\S]*AGENT_ACTION_LEASE_STALE/u)
  assert.match(supabaseStore, /error\.code === '42501'[\s\S]*PROJECT_WRITE_FORBIDDEN/u)
  assert.match(supabaseStore, /from\('agent_action_receipts'\)\.insert/u)
})

test('PostgreSQL 缺失行首次 claim 也通过 advisory lock 串行化', () => {
  assert.match(postgresStore, /claimAgentActionReceipt[\s\S]*pg_advisory_xact_lock\(hashtextextended\(\$\{claim\.id\}, 2\)\)/u)
  assert.match(postgresStore, /claimAgentActionReceipt[\s\S]*select role from project_members[\s\S]*for share[\s\S]*clock_timestamp/u)
  assert.match(postgresStore, /settleAgentActionReceipt[\s\S]*AGENT_ACTION_LEASE_STALE/u)
  assert.match(postgresStore, /putAgentActionReceipt[\s\S]*pg_advisory_xact_lock[\s\S]*if \(existing\) return clone\(asPayload\(existing\)\)/u)
})
