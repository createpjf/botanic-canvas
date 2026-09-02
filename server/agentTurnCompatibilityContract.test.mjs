// @ts-check

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const adapter = readFileSync(new URL('./store/supabaseProductStore.mjs', import.meta.url), 'utf8')
const migration = readFileSync(new URL('../supabase/migrations/20260827140000_agent_turn_execution_claim.sql', import.meta.url), 'utf8')

function methodSlice(source, signature, nextSignature) {
  const start = source.indexOf(signature)
  const end = source.indexOf(nextSignature, start)
  assert.ok(start >= 0 && end > start, `${signature} 方法区段不存在`)
  return source.slice(start, end)
}

test('Supabase legacy putAgentTurn 只走与 claim 共锁的兼容 RPC，缺迁移时失败关闭', () => {
  const method = methodSlice(
    adapter,
    'async putAgentTurn(userId, turn)',
    'async readAgentTurn(userId, turnId)',
  )
  assert.match(method, /botanic_put_agent_turn_compatible/u)
  assert.match(method, /AGENT_TURN_ATOMIC_WRITE_REQUIRED/u)
  assert.doesNotMatch(method, /from\('agent_turns'\)|\.upsert\(/u)
})

test('兼容 RPC 与 claim 使用同一 advisory lock，并在行锁内保留已建立的 execution fence', () => {
  assert.match(migration, /create or replace function public\.botanic_put_agent_turn_compatible/iu)
  const rpc = migration.slice(migration.indexOf('create or replace function public.botanic_put_agent_turn_compatible'))
  assert.match(rpc, /pg_advisory_xact_lock\(hashtextextended\(p_turn_id,\s*3\)\)/iu)
  assert.match(rpc, /from public\.agent_turns[\s\S]*for update/iu)
  assert.match(rpc, /execution_version\s*>\s*0|lease_token\s+is not null|jsonb_typeof\([^)]*execution/iu)
  assert.match(rpc, /return existing\.payload|return stored_payload/iu)
  assert.match(rpc, /p_turn\s*-\s*'execution'\s*-\s*'executionVersion'/iu)
  assert.match(rpc, /stored_hash\s*:=\s*coalesce\([\s\S]*existing\.request_hash[\s\S]*existing\.payload->>'requestHash'/iu)
  assert.match(rpc, /stored_hash_version\s*:=\s*coalesce\([\s\S]*existing\.request_hash_version[\s\S]*existing\.payload->>'requestHashVersion'/iu)
  assert.match(rpc, /jsonb_build_object\([\s\S]*'requestHash',[\s\S]*stored_hash[\s\S]*'requestHashVersion',[\s\S]*stored_hash_version/iu)
  assert.match(rpc, /request_hash\s*=\s*coalesce\(stored_hash, incoming_hash\)/iu)
  assert.match(rpc, /immutable request conflict/iu)
  assert.match(rpc, /existing\.status in \('completed', 'failed', 'cancelled'\)/iu)
  assert.match(rpc, /revoke all on function public\.botanic_put_agent_turn_compatible[\s\S]*from public, anon, authenticated/iu)
  assert.match(rpc, /grant execute on function public\.botanic_put_agent_turn_compatible[\s\S]*to service_role/iu)
})
