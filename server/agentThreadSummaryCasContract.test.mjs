// @ts-check

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { productStoreCoreMethods } from './store/productStoreContract.mjs'

const local = readFileSync(new URL('./store/productStore.mjs', import.meta.url), 'utf8')
const postgres = readFileSync(new URL('./store/postgresProductStore.mjs', import.meta.url), 'utf8')
const supabase = readFileSync(new URL('./store/supabaseProductStore.mjs', import.meta.url), 'utf8')
const threadContext = readFileSync(new URL('./agentThreadContext.mjs', import.meta.url), 'utf8')
const agentRoutes = readFileSync(new URL('./agentRoutes.mjs', import.meta.url), 'utf8')
const migration = readFileSync(new URL('../supabase/migrations/20260827180000_agent_thread_summary_cas.sql', import.meta.url), 'utf8')
const casMigration = migration.slice(
  migration.indexOf('create or replace function public.botanic_compare_and_set_agent_thread_summary'),
  migration.indexOf('revoke all on function public.botanic_compare_and_set_agent_thread_summary'),
)

function methodSlice(source, signature, nextSignature) {
  const start = source.indexOf(signature)
  const end = source.indexOf(nextSignature, start)
  assert.ok(start >= 0 && end > start, `${signature} 方法区段不存在`)
  return source.slice(start, end)
}

test('Thread Summary CAS 是三个 ProductStore Adapter 的核心能力', () => {
  assert.equal(productStoreCoreMethods.includes('compareAndSetAgentThreadSummary'), true)
  for (const adapter of [local, postgres, supabase]) {
    assert.match(adapter, /compareAndSetAgentThreadSummary\(userId, command\)/u)
    const method = methodSlice(
      adapter,
      'compareAndSetAgentThreadSummary(userId, command)',
      adapter === local
        ? 'readAgentContextState(userId, projectId, sessionId)'
        : 'async readAgentContextState(userId, projectId, sessionId)',
    )
    assert.match(method, /agentThreadSummaryCompareAndSetDecision\(undefined, command\)/u)
  }
})

test('PostgreSQL CAS 在行锁事务中只 patch threadSummary，不改变 Session 排序时间', () => {
  const method = methodSlice(
    postgres,
    'async compareAndSetAgentThreadSummary(userId, command)',
    'async readAgentContextState(userId, projectId, sessionId)',
  )
  assert.match(method, /sql\.begin/u)
  assert.match(method, /from agent_sessions[\s\S]*for update/u)
  assert.match(method, /from project_members[\s\S]*for share/u)
  assert.match(method, /jsonb_set\(payload, '\{threadSummary\}'/u)
  assert.doesNotMatch(method, /set\s+updated_at/iu)
})

test('Supabase Adapter 只走独立 CAS RPC，缺迁移时 fail-fast', () => {
  const method = methodSlice(
    supabase,
    'async compareAndSetAgentThreadSummary(userId, command)',
    'async readAgentContextState(userId, projectId, sessionId)',
  )
  assert.match(method, /botanic_compare_and_set_agent_thread_summary/u)
  assert.match(method, /AGENT_THREAD_SUMMARY_CAS_REQUIRED/u)
  assert.match(method, /agentThreadSummaryCompareAndSetDecision/u)
  assert.doesNotMatch(method, /from\('agent_sessions'\)|\.upsert\(|\.update\(/u)
})

test('Supabase RPC 锁定 Session、校验成员与版本，并仅更新 payload 子字段', () => {
  assert.match(casMigration, /create or replace function public\.botanic_compare_and_set_agent_thread_summary/u)
  assert.match(casMigration, /from public\.agent_sessions[\s\S]*for update/u)
  assert.match(casMigration, /from public\.project_members[\s\S]*for share/u)
  assert.match(casMigration, /current_updated_at is distinct from p_expected_updated_at/u)
  assert.match(casMigration, /jsonb_set\(existing\.payload, '\{threadSummary\}', p_summary, true\)/u)
  assert.match(casMigration, /update public\.agent_sessions\s+set payload = stored_payload/u)
  assert.doesNotMatch(casMigration, /set\s+updated_at/iu)
  assert.match(migration, /revoke all on function[\s\S]*from public, anon, authenticated/u)
  assert.match(migration, /grant execute on function[\s\S]*to service_role/u)
})

test('权威 Thread Context 与 legacy Route 都经 CAS 写回，缺能力时 fail-fast', () => {
  assert.match(threadContext, /typeof productStore\?\.compareAndSetAgentThreadSummary !== 'function'/u)
  assert.match(threadContext, /compareAndSetDerivedAgentThreadSummary\(\{ productStore, userId, session, summary: derived \}\)/u)
  const legacy = methodSlice(
    agentRoutes,
    'const threadSummaryForSession = async (userId, projectId, sessionId)',
    'const bindAuthoritativeKnowledge = async (userId, input)',
  )
  assert.match(legacy, /typeof productStore\.compareAndSetAgentThreadSummary !== 'function'/u)
  assert.match(legacy, /compareAndSetDerivedAgentThreadSummary/u)
  assert.doesNotMatch(legacy, /putAgentSession/u)
})
