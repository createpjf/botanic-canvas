// @ts-check

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { productStoreCoreMethods } from './store/productStoreContract.mjs'

const local = readFileSync(new URL('./store/productStore.mjs', import.meta.url), 'utf8')
const postgres = readFileSync(new URL('./store/postgresProductStore.mjs', import.meta.url), 'utf8')
const supabase = readFileSync(new URL('./store/supabaseProductStore.mjs', import.meta.url), 'utf8')
const migration = readFileSync(new URL(
  '../supabase/migrations/20260828210000_agent_context_compaction_v2.sql', import.meta.url,
), 'utf8')

const methods = [
  'readAgentContextState',
  'listAgentContextCompactions',
  'compareAndSetAgentContextState',
]

function methodSource(source, name, nextName) {
  const variants = [`async ${name}(`, `${name}(`]
  const start = Math.max(...variants.map((signature) => source.indexOf(signature)))
  const nextVariants = nextName ? [`async ${nextName}(`, `${nextName}(`] : []
  const ends = nextVariants.map((signature) => source.indexOf(signature, start + 1)).filter((value) => value > start)
  assert.ok(start >= 0, `${name} missing`)
  return source.slice(start, ends.length ? Math.min(...ends) : source.length)
}

test('Agent Context V2 是三个 ProductStore Adapter 的核心深接口', () => {
  for (const method of methods) {
    assert.equal(productStoreCoreMethods.includes(method), true, `${method} core contract`)
    for (const adapter of [local, postgres, supabase]) {
      assert.match(adapter, new RegExp(`(?:async )?${method}\\(`), method)
    }
  }
})

test('Local Adapter 保留 owner、过滤 usage-only ledger 且项目删除同步清理', () => {
  assert.match(local, /agentContextStates: \[\]/u)
  assert.match(local, /agentContextCompactions: \[\]/u)
  assert.match(local, /stateRecord\?\.ownerId \?\? session\.ownerId/u)
  assert.match(local, /item\.payload\?\.compaction/u)
  assert.match(local, /state\.agentContextStates = state\.agentContextStates\.filter/u)
  assert.match(local, /state\.agentContextCompactions = state\.agentContextCompactions\.filter/u)
})

test('PostgreSQL Adapter 在 Session 行锁事务中使用数据库时钟 CAS，ledger 只 append', () => {
  const method = methodSource(postgres, 'compareAndSetAgentContextState', 'putAgentMessage')
  assert.match(postgres, /create table if not exists agent_context_states/u)
  assert.match(postgres, /create table if not exists agent_context_compactions/u)
  assert.match(postgres, /head_compaction_sequence bigint/u)
  assert.match(postgres, /agent_context_states_head_shape/u)
  assert.match(postgres, /unique \(session_id, idempotency_key\)/u)
  assert.match(method, /sql\.begin/u)
  assert.match(method, /from agent_sessions[\s\S]*for update/u)
  assert.match(method, /clock_timestamp\(\)/u)
  assert.match(method, /insert into agent_context_compactions/u)
  assert.match(method, /on conflict \(session_id\) do update/u)
  assert.doesNotMatch(method, /update agent_context_compactions|delete from agent_context_compactions/u)
})

test('Supabase 迁移是两表、RLS、service-role-only 的原子 CAS', () => {
  assert.match(migration, /create table if not exists public\.agent_context_states/u)
  assert.match(migration, /create table if not exists public\.agent_context_compactions/u)
  assert.match(migration, /primary key \(session_id, sequence\)/u)
  assert.match(migration, /unique \(session_id, idempotency_key\)/u)
  assert.match(migration, /head_compaction_sequence bigint/u)
  assert.match(migration, /head_compaction_sequence > 0 and head_compaction_sequence <= revision/u)
  assert.match(migration, /where compaction_id is not null/u)
  assert.match(migration, /alter table public\.agent_context_states enable row level security/u)
  assert.match(migration, /alter table public\.agent_context_compactions enable row level security/u)
  assert.match(migration, /project members can read agent context states/u)
  assert.match(migration, /project members can read agent context compactions/u)
  assert.match(migration, /revoke all on table public\.agent_context_states from public, anon, authenticated/u)
  assert.match(migration, /revoke all on table public\.agent_context_compactions from public, anon, authenticated/u)
  assert.match(migration, /grant select, insert, update on table public\.agent_context_states to service_role/u)
  assert.match(migration, /grant select, insert on table public\.agent_context_compactions to service_role/u)
})

test('Supabase CAS 锁 Session、使用 DB clock、重算 request hash 并保留 owner', () => {
  const rpc = migration.slice(
    migration.indexOf('create or replace function public.botanic_compare_and_set_agent_context_state'),
    migration.indexOf('revoke all on function public.botanic_compare_and_set_agent_context_state'),
  )
  assert.match(rpc, /from public\.agent_sessions as session[\s\S]*for update/u)
  assert.match(rpc, /from public\.project_members as member[\s\S]*for share/u)
  assert.match(rpc, /public\.botanic_canonical_json_hash\(request_payload\)/u)
  const binding = rpc.slice(rpc.indexOf('request_payload :='), rpc.indexOf('computed_hash :='))
  assert.doesNotMatch(binding, /expectedRevision/u, 'CAS 观测水位不得污染语义幂等 hash')
  assert.match(rpc, /replay_row\.request_hash is distinct from computed_hash/u)
  assert.match(rpc, /current_revision is distinct from expected_revision/u)
  assert.match(rpc, /observed_at := clock_timestamp\(\)/u)
  assert.match(rpc, /next_head_compaction_sequence := case[\s\S]*next_revision[\s\S]*state_row\.head_compaction_sequence/u)
  assert.match(rpc, /coalesce\(state_row\.owner_id, session_row\.owner_id\)/u)
  assert.match(rpc, /insert into public\.agent_context_compactions/u)
  assert.doesNotMatch(rpc, /update public\.agent_context_compactions|delete from public\.agent_context_compactions/u)
  assert.doesNotMatch(rpc, /(?:update|delete from) public\.agent_messages/u, 'compaction 不得改写或删除 raw Message')
  assert.match(migration, /revoke all on function public\.botanic_compare_and_set_agent_context_state[\s\S]*from public, anon, authenticated/u)
  assert.match(migration, /grant execute on function public\.botanic_compare_and_set_agent_context_state[\s\S]*to service_role/u)
})

test('Supabase Adapter 写路径只走 CAS RPC，缺迁移 fail closed', () => {
  const method = methodSource(supabase, 'compareAndSetAgentContextState', 'putAgentMessage')
  assert.match(method, /botanic_compare_and_set_agent_context_state/u)
  assert.match(method, /AGENT_CONTEXT_PERSISTENCE_REQUIRED/u)
  assert.doesNotMatch(method, /\.from\('agent_context_states'\)[\s\S]*\.(?:upsert|update|insert)\(/u)
})
