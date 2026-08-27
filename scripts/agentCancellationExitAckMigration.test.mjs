import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

let migration = ''
try {
  migration = readFileSync(
    new URL('../supabase/migrations/20260828170000_agent_cancellation_exit_ack.sql', import.meta.url),
    'utf8',
  )
} catch {
  // 首轮 TDD 需要以缺 migration 的明确契约失败，而不是在模块加载时退出。
}

function rpc(name) {
  const match = migration.match(new RegExp(
    `create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`,
    'iu',
  ))
  assert.ok(match, `缺少 ${name} RPC`)
  return match[0]
}

test('Turn cancellation request 只为真实 running executor 建立 durable signal，且请求时不伪造 settledAt', () => {
  const sql = rpc('botanic_request_agent_turn_cancellation')
  assert.match(sql, /\(\s*p_owner_id uuid,[\s\S]*p_turn_id text,[\s\S]*p_project_id text,[\s\S]*p_request jsonb\s*\)/iu)
  assert.match(sql, /pg_advisory_xact_lock[\s\S]*select \* into existing from public\.agent_turns[\s\S]*for update/iu)
  assert.match(sql, /observed_at := clock_timestamp\(\)/iu)
  assert.match(sql, /active_executor := existing\.status = 'running'[\s\S]*existing\.execution_version > 0[\s\S]*existing\.lease_token is not null[\s\S]*existing\.lease_expires_at is not null[\s\S]*extract\(epoch from existing\.lease_expires_at\) > 0/iu)
  assert.match(sql, /'signalId',[\s\S]*'agent-turn-cancel:' \|\| p_turn_id \|\| ':' \|\| existing\.execution_version::text \|\| ':' \|\| observed_ms::text/iu)
  assert.match(sql, /'executionGeneration',[\s\S]*existing\.execution_version[\s\S]*'workerReleased',[\s\S]*false/iu)
  assert.doesNotMatch(sql, /'settledAt'/iu)
  assert.match(sql, /existing\.status in \('failed', 'cancelled', 'cancelling'\)[\s\S]*'kind', 'replay'/iu)
})

test('Turn commit 以 signalId + generation + leaseToken 续 cancellation heartbeat，并只接受 worker_exit ack', () => {
  const sql = rpc('botanic_commit_agent_turn_execution')
  assert.match(sql, /\(\s*p_owner_id uuid,[\s\S]*p_turn_id text,[\s\S]*p_project_id text,[\s\S]*p_command jsonb\s*\)/iu)
  assert.match(sql, /existing\.execution_version <> requested_generation[\s\S]*existing\.lease_token is distinct from p_command->>'leaseToken'[\s\S]*'AGENT_TURN_LEASE_STALE'/iu)
  assert.match(sql, /requested_status = 'cancelled'[\s\S]*existing\.status = 'cancelling'[\s\S]*'kind', 'cancelling'[\s\S]*'kind', 'conflict'/iu)
  assert.match(sql, /existing\.status = 'cancelling'[\s\S]*signalRequired'[\s\S]*is not true[\s\S]*'kind', 'cancelling'/iu)
  assert.match(sql, /p_command->>'signalId' is distinct from stored_payload->'cancellation'->>'signalId'[\s\S]*executionGeneration'[\s\S]*requested_generation[\s\S]*'kind', 'stale'/iu)
  assert.match(sql, /p_command->>'releaseBasis' = 'worker_exit'[\s\S]*workerReleased'[\s\S]*true[\s\S]*'kind', 'replay'/iu)
  assert.match(sql, /'settledAt', observed_ms[\s\S]*'signalAcknowledgedAt', observed_ms[\s\S]*'releaseBasis', 'worker_exit'[\s\S]*'kind', 'cancellation_acknowledged'/iu)
  assert.match(sql, /'leaseExpiresAt', observed_ms \+ lease_duration_ms[\s\S]*'lastHeartbeatAt', observed_ms[\s\S]*'lastHeartbeatAt', observed_ms[\s\S]*lease_expires_at = observed_at \+ \(lease_duration_ms::double precision \* interval '1 millisecond'\)[\s\S]*'kind', 'cancellation_heartbeat'/iu)
})

test('Turn finalizer 只用 DB clock 的真实 lease expiry 替代 exit ack，无活跃执行者则不等待', () => {
  const sql = rpc('botanic_finalize_agent_turn_cancellation')
  assert.match(sql, /\(\s*p_owner_id uuid,[\s\S]*p_turn_id text,[\s\S]*p_project_id text,[\s\S]*p_command jsonb\s*\)/iu)
  assert.match(sql, /pg_advisory_xact_lock[\s\S]*select \* into existing from public\.agent_turns[\s\S]*for update/iu)
  assert.match(sql, /observed_at := clock_timestamp\(\)/iu)
  assert.match(sql, /signalRequired'[\s\S]*is true[\s\S]*workerReleased'[\s\S]*is not true/iu)
  assert.match(sql, /existing\.lease_expires_at is null or existing\.lease_expires_at > observed_at[\s\S]*'kind', 'pending'/iu)
  assert.match(sql, /'workerReleased', true[\s\S]*'signalAcknowledgedAt', observed_ms[\s\S]*'releaseBasis', 'lease_expired'/iu)
  assert.match(sql, /'settledAt', observed_ms[\s\S]*'status', 'cancelled'[\s\S]*'kind', 'finalized'/iu)
  assert.match(sql, /existing\.status = 'cancelled'[\s\S]*'kind', 'replay'/iu)
})

test('Generation cancellation 对 running 只写 signal fence，不在 Provider 退出前伪造 settledAt', () => {
  const sql = rpc('botanic_cancel_generation_job_execution')
  assert.match(sql, /\(\s*p_owner_id uuid,[\s\S]*p_job_id text,[\s\S]*p_project_id text,[\s\S]*p_command jsonb\s*\)/iu)
  assert.match(sql, /pg_advisory_xact_lock[\s\S]*select \* into existing from public\.generation_jobs[\s\S]*for update/iu)
  assert.match(sql, /observed_at := clock_timestamp\(\)/iu)
  assert.match(sql, /'workerReleased', case[\s\S]*when prior_status = 'running' then false/iu)
  assert.match(sql, /'signalRequired', case when prior_status = 'running' then true else null end/iu)
  assert.match(sql, /'signalId',[\s\S]*'generation-cancel:' \|\| p_job_id \|\| ':' \|\| generation::text \|\| ':' \|\| requested_ms::text/iu)
  assert.match(sql, /if prior_status <> 'running'[\s\S]*'settledAt', observed_ms[\s\S]*end if/iu)
  assert.match(sql, /existing\.status in \('succeeded', 'failed', 'cancelled'\)[\s\S]*'kind', 'replay'[\s\S]*'changed', false/iu)
})

test('Generation commit 只允许原 fence 为 ignored-Abort Provider 续租，迟到成功仍被 cancelled 压住', () => {
  const sql = rpc('botanic_commit_generation_job_execution')
  assert.match(sql, /\(\s*p_owner_id uuid,[\s\S]*p_job_id text,[\s\S]*p_project_id text,[\s\S]*p_command jsonb\s*\)/iu)
  assert.match(sql, /next_status not in \('running', 'succeeded', 'failed', 'cancelled'\)/iu)
  assert.match(sql, /existing\.lease_token is distinct from token[\s\S]*existing\.execution_version <> generation[\s\S]*execution'->>'leaseToken'[\s\S]*execution'->>'generation'[\s\S]*'kind', 'stale'/iu)
  assert.match(sql, /existing\.status = 'cancelled'[\s\S]*next_status = 'running'[\s\S]*nullif\(p_command->>'signalId', ''\) is null[\s\S]*'kind', 'cancellation_required'/iu)
  assert.match(sql, /signalRequired'[\s\S]*is not true[\s\S]*workerReleased'[\s\S]*is true[\s\S]*next_status <> 'cancelled'[\s\S]*signalId'[\s\S]*p_command->>'signalId'[\s\S]*'kind', 'stale'/iu)
  assert.match(sql, /observed_at := clock_timestamp\(\)[\s\S]*'leaseExpiresAt', observed_ms \+ lease_duration_ms[\s\S]*'lastHeartbeatAt', observed_ms[\s\S]*'lastHeartbeatAt', observed_ms/iu)
  assert.match(sql, /lease_expires_at = observed_at \+ \(lease_duration_ms::double precision \* interval '1 millisecond'\)[\s\S]*'kind', 'cancellation_heartbeat'[\s\S]*'changed', true/iu)
})

test('Generation cancellation ack 校验 signal/generation/token，且 lease_expired 只由 DB clock 裁决并可 replay', () => {
  const sql = rpc('botanic_acknowledge_generation_job_cancellation')
  assert.match(sql, /\(\s*p_owner_id uuid,[\s\S]*p_job_id text,[\s\S]*p_project_id text,[\s\S]*p_command jsonb\s*\)/iu)
  assert.match(sql, /pg_advisory_xact_lock[\s\S]*select \* into existing from public\.generation_jobs[\s\S]*for update/iu)
  assert.match(sql, /signalId'[\s\S]*is distinct from p_command->>'signalId'[\s\S]*existing\.execution_version <> generation[\s\S]*'kind', 'stale'/iu)
  assert.match(sql, /release_basis = 'worker_exit'[\s\S]*p_command->>'leaseToken'[\s\S]*existing\.lease_token[\s\S]*'kind', 'stale'/iu)
  assert.match(sql, /signalAcknowledgedAt'[\s\S]*> 0[\s\S]*'kind', 'replay'[\s\S]*'changed', false/iu)
  assert.match(sql, /observed_at := clock_timestamp\(\)[\s\S]*release_basis = 'lease_expired'[\s\S]*existing\.lease_expires_at is null or existing\.lease_expires_at > observed_at[\s\S]*'kind', 'pending'/iu)
  assert.match(sql, /'settledAt', coalesce\([\s\S]*observed_ms\s*\)[\s\S]*'workerReleased', true[\s\S]*'signalAcknowledgedAt', observed_ms[\s\S]*'releaseBasis', release_basis/iu)
  assert.match(sql, /'kind', 'acknowledged'[\s\S]*'changed', true[\s\S]*'job', stored_payload/iu)
})

test('六个原签名 RPC 均保持 service_role-only，并在行锁内使用 DB clock', () => {
  const signatures = [
    'botanic_request_agent_turn_cancellation(uuid, text, text, jsonb)',
    'botanic_commit_agent_turn_execution(uuid, text, text, jsonb)',
    'botanic_finalize_agent_turn_cancellation(uuid, text, text, jsonb)',
    'botanic_cancel_generation_job_execution(uuid, text, text, jsonb)',
    'botanic_commit_generation_job_execution(uuid, text, text, jsonb)',
    'botanic_acknowledge_generation_job_cancellation(uuid, text, text, jsonb)',
  ]
  for (const signature of signatures) {
    const escaped = signature.replace(/[()]/gu, '\\$&')
    assert.match(migration, new RegExp(`revoke all on function public\\.${escaped}[\\s\\S]*?from public, anon, authenticated`, 'iu'))
    assert.match(migration, new RegExp(`grant execute on function public\\.${escaped}[\\s\\S]*?to service_role`, 'iu'))
  }
})
