// @ts-check

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const local = readFileSync(new URL('./productStore.mjs', import.meta.url), 'utf8')
const postgres = readFileSync(new URL('./postgresProductStore.mjs', import.meta.url), 'utf8')
const supabase = readFileSync(new URL('./supabaseProductStore.mjs', import.meta.url), 'utf8')
const persistence = readFileSync(new URL('./agentSubagentPersistence.mjs', import.meta.url), 'utf8')
const migration = readFileSync(new URL(
  '../supabase/migrations/20260828200000_agent_subagent_runtime.sql',
  import.meta.url,
), 'utf8')

const methods = [
  'enqueueAgentSubagentActivation',
  'claimAgentSubagentActivation',
  'settleAgentSubagentActivation',
  'readAgentSubagent',
  'readAgentSubagentForWorker',
  'listAgentSubagentsForRootTurnPage',
  'listAgentSubagentActivations',
  'listAgentSubagentActivationsForWorker',
  'listRunnableAgentSubagents',
  'requestAgentSubagentCancellation',
  'finalizeAgentSubagentCancellation',
]

function methodSource(source, name, nextName) {
  const start = source.indexOf(`async ${name}(`)
  const end = nextName ? source.indexOf(`async ${nextName}(`, start + 1) : source.length
  assert.ok(start >= 0, `${name} missing`)
  return source.slice(start, end > start ? end : source.length)
}

test('AgentSubagent ProductStore 三 Adapter 暴露同一深接口', () => {
  for (const method of methods) {
    assert.match(local, new RegExp(`(?:async )?${method}\\(`), `Local ${method}`)
    assert.match(postgres, new RegExp(`async ${method}\\(`), `PostgreSQL ${method}`)
    assert.match(supabase, new RegExp(`async ${method}\\(`), `Supabase ${method}`)
  }
  assert.match(postgres, /agent_subagents[\s\S]*agent_subagent_activations/u)
  assert.match(supabase, /materializeAgentSubagentEnqueueCommand/u)
})

test('迁移建立 descriptor/activation 权威列、gapless FIFO 与恢复索引', () => {
  assert.match(migration, /create table if not exists public\.agent_subagents/u)
  assert.match(migration, /create table if not exists public\.agent_subagent_activations/u)
  assert.match(migration, /primary key \(subagent_id, sequence\)/u)
  assert.match(migration, /unique \(subagent_id, idempotency_key\)/u)
  assert.match(migration, /unique \(owner_id, project_id, idempotency_key\)/u)
  assert.match(migration, /settled_through_sequence <= last_enqueued_sequence/u)
  assert.match(migration, /dispatch_activation_sequence = settled_through_sequence \+ 1/u)
  assert.match(migration, /agent_subagents_runnable_idx[\s\S]*id collate "C" asc/u)
  assert.match(migration, /agent_subagents_root_turn_idx[\s\S]*root_turn_id, id collate "C" asc/u)
  assert.match(migration, /agent_subagent_activations_unsettled_idx/u)
  assert.match(migration, /execution_generation bigint[\s\S]*execution_lease_token text/u)
})

test('Subagent 原始表对 Data API fail closed，仅 service_role 可见', () => {
  assert.match(migration, /alter table public\.agent_subagents enable row level security/u)
  assert.match(migration, /revoke all on table public\.agent_subagents from public, anon, authenticated/u)
  assert.match(migration, /revoke all on table public\.agent_subagent_activations from public, anon, authenticated/u)
  assert.doesNotMatch(migration, /on table public\.agent_subagents to authenticated/u)
  assert.doesNotMatch(migration, /on table public\.agent_subagent_activations to authenticated/u)
  assert.match(migration, /grant select, insert, update, delete on table public\.agent_subagents to service_role/u)
  assert.match(migration, /grant select, insert, update, delete on table public\.agent_subagent_activations to service_role/u)
})

test('Supabase 六个 RPC 全部 fail-closed 为 service_role，写路径不拼 REST upsert', () => {
  const rpcs = [
    'botanic_enqueue_agent_subagent_activation',
    'botanic_claim_agent_subagent_activation',
    'botanic_settle_agent_subagent_activation',
    'botanic_request_agent_subagent_cancellation',
    'botanic_finalize_agent_subagent_cancellation',
    'botanic_list_runnable_agent_subagents',
  ]
  for (const rpc of rpcs) {
    assert.match(migration, new RegExp(`create or replace function public\\.${rpc}\\(`), rpc)
    assert.match(migration, new RegExp(`revoke all on function public\\.${rpc}[\\s\\S]*from public, anon, authenticated`), rpc)
    assert.match(migration, new RegExp(`grant execute on function public\\.${rpc}[\\s\\S]*to service_role`), rpc)
    assert.match(supabase, new RegExp(`'${rpc}'`), rpc)
  }
  for (const [name, next] of [
    ['enqueueAgentSubagentActivation', 'claimAgentSubagentActivation'],
    ['claimAgentSubagentActivation', 'settleAgentSubagentActivation'],
    ['settleAgentSubagentActivation', 'readAgentSubagent'],
    ['requestAgentSubagentCancellation', 'finalizeAgentSubagentCancellation'],
  ]) {
    assert.doesNotMatch(methodSource(supabase, name, next), /\.upsert\(/u, `${name} 不得非原子 upsert`)
  }
})

test('enqueue 在一笔数据库事务创建 Session、输入 Message、queued Turn、descriptor 与 activation', () => {
  const rpc = migration.slice(
    migration.indexOf('create or replace function public.botanic_enqueue_agent_subagent_activation'),
    migration.indexOf('create or replace function public.botanic_claim_agent_subagent_activation'),
  )
  assert.match(rpc, /pg_advisory_xact_lock[\s\S]*for update/u)
  assert.match(rpc, /insert into public\.agent_sessions/u)
  assert.match(rpc, /insert into public\.agent_messages/u)
  assert.match(rpc, /insert into public\.agent_turns/u)
  assert.match(rpc, /insert into public\.agent_subagents/u)
  assert.match(rpc, /insert into public\.agent_subagent_activations/u)
  assert.match(rpc, /last_enqueued_sequence \+ 1/u)
  assert.match(rpc, /maxActivations[\s\S]*> 8/u)
  assert.match(rpc, /request_hash is distinct from/u)
  assert.doesNotMatch(rpc, /p_command->'observedAt'/u)
  assert.match(rpc, /select \* into root_turn from public\.agent_turns[\s\S]*for update/u)
  assert.match(rpc, /root_turn\.status in \('failed', 'cancelling', 'cancelled'\)/u)
  assert.match(rpc, /updated_at = greatest\(updated_at, observed_at\)/u)

  const pg = methodSource(postgres, 'enqueueAgentSubagentActivation', 'readAgentSubagent')
  assert.match(pg, /sql\.begin/u)
  assert.match(pg, /pg_advisory_xact_lock/u)
  assert.match(pg, /agentSubagentEnqueueDecision/u)
  assert.match(pg, /from agent_turns where id[\s\S]*for update/u)
  assert.match(pg, /assertAgentSubagentRootTurnFence/u)
  assert.match(persistence, /AGENT_TURN_DELEGATION_CANCELLED/u)
  assert.match(persistence, /AGENT_SUBAGENT_ROOT_EXECUTION_STALE/u)
  assert.match(persistence, /AGENT_SUBAGENT_ROOT_TURN_NOT_READY/u)
  assert.match(rpc, /root_turn\.status = 'running'[\s\S]*root_turn\.payload->'execution'->>'generation'/u)
  assert.match(rpc, /root_turn\.payload->'execution'->>'leaseToken'[\s\S]*PSS07/u)
  assert.match(rpc, /root_turn\.status in \('completed', 'waiting_user'\)[\s\S]*p_command \? 'rootExecution'/u)
  assert.match(supabase, /PSS07[\s\S]*AGENT_SUBAGENT_ROOT_EXECUTION_STALE/u)
  assert.match(supabase, /PSS08[\s\S]*AGENT_SUBAGENT_ROOT_TURN_NOT_READY/u)
  assert.match(pg, /insert into agent_sessions/u)
  assert.match(pg, /insert into agent_messages/u)
  assert.match(pg, /insert into agent_turns/u)
  assert.match(pg, /persistAgentSubagent/u)
  assert.match(pg, /persistAgentSubagentActivation/u)
})

test('root Turn 反向边是 member-read、C collation id keyset，并由 service-only RPC 投影', () => {
  const rpcName = 'botanic_list_agent_subagents_for_root_turn'
  assert.match(migration, new RegExp(`create or replace function public\\.${rpcName}\\(`))
  assert.match(migration, /root_turn_id = p_root_turn_id[\s\S]*id collate "C" > p_after_id collate "C"/u)
  assert.match(migration, new RegExp(`revoke all on function public\\.${rpcName}[\\s\\S]*from public, anon, authenticated`))
  assert.match(migration, new RegExp(`grant execute on function public\\.${rpcName}[\\s\\S]*to service_role`))
  assert.match(postgres, /listAgentSubagentsForRootTurnPage[\s\S]*root_turn_id = \$\{rootTurnId\}[\s\S]*order by id collate "C" asc/u)
  assert.match(supabase, /listAgentSubagentsForRootTurnPage[\s\S]*botanic_list_agent_subagents_for_root_turn/u)
})

test('claim/settle 使用 head、generation、lease 与 terminal Turn fence，结果 Message 和 cursor 同事务', () => {
  const claim = migration.slice(
    migration.indexOf('create or replace function public.botanic_claim_agent_subagent_activation'),
    migration.indexOf('create or replace function public.botanic_settle_agent_subagent_activation'),
  )
  const settle = migration.slice(
    migration.indexOf('create or replace function public.botanic_settle_agent_subagent_activation'),
    migration.indexOf('create or replace function public.botanic_request_agent_subagent_cancellation'),
  )
  assert.match(claim, /head_sequence := subagent\.settled_through_sequence \+ 1/u)
  assert.match(claim, /dispatch_lease_expires_at > observed_at/u)
  assert.match(claim, /allowTakeover/u)
  assert.match(claim, /dispatch_generation = next_generation/u)
  assert.match(settle, /turn\.status not in \('completed', 'failed', 'cancelled'\)/u)
  assert.match(settle, /dispatch_lease_token is distinct from lease_token/u)
  assert.match(settle, /insert into public\.agent_messages/u)
  assert.match(settle, /settled_through_sequence = head_sequence/u)
  assert.match(settle, /nextActivation/u)

  const pgSettle = methodSource(postgres, 'settleAgentSubagentActivation', 'requestAgentSubagentCancellation')
  assert.match(pgSettle, /for update/u)
  assert.match(pgSettle, /agentSubagentActivationSettleDecision/u)
  assert.ok(pgSettle.indexOf('insert into agent_messages') < pgSettle.indexOf('persistAgentSubagent(tx'))
  assert.match(pgSettle, /nextActivation/u)
})

test('取消 generation fence 可冷恢复 cancelling，finalize 按 sequence 投影所有结果', () => {
  const request = migration.slice(
    migration.indexOf('create or replace function public.botanic_request_agent_subagent_cancellation'),
    migration.indexOf('create or replace function public.botanic_finalize_agent_subagent_cancellation'),
  )
  const finalize = migration.slice(
    migration.indexOf('create or replace function public.botanic_finalize_agent_subagent_cancellation'),
    migration.indexOf('create or replace function public.botanic_list_runnable_agent_subagents'),
  )
  const runnable = migration.slice(
    migration.indexOf('create or replace function public.botanic_list_runnable_agent_subagents'),
    migration.indexOf('revoke all on function public.botanic_public_agent_subagent_payload'),
  )
  assert.match(request, /cancel_generation = next_generation/u)
  assert.match(request, /dispatch_lease_token = null/u)
  assert.match(request, /settled_through_sequence = subagent\.last_enqueued_sequence then 'cancelled'/u)
  assert.match(request, /finalizedAt'[\s\S]*requested_status = 'cancelled'/u)
  assert.match(finalize, /status not in \('completed', 'failed', 'cancelled'\)/u)
  assert.match(finalize, /order by sequence asc[\s\S]*for update/u)
  assert.match(finalize, /insert into public\.agent_messages/u)
  assert.match(finalize, /settled_through_sequence = last_enqueued_sequence/u)
  assert.match(runnable, /status in \('active', 'cancelling'\)/u)
  assert.match(runnable, /status = 'cancelling'[\s\S]*activation\.payload->>'status' = 'queued'/u)
  assert.match(runnable, /activation\.payload->>'status' = 'running'[\s\S]*execution_lease_expires_at <= observed_at/u)
  assert.match(runnable, /id collate "C" asc/u)
})

test('普通 Agent Session 默认排除 subagent，会话显式 opt-in 才返回', () => {
  for (const source of [postgres, supabase]) {
    assert.match(source, /includeSubagents = options\.includeSubagents === true/u)
    assert.match(source, /kind[\s\S]*subagent/u)
  }
  assert.match(postgres, /coalesce\(payload->>'kind', 'primary'\) <> 'subagent'/u)
  assert.match(supabase, /payload->>kind\.is\.null,payload->>kind\.neq\.subagent/u)
})
