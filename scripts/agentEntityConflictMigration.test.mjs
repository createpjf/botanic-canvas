import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const migrationUrl = new URL('../supabase/migrations/20260806120000_agent_run_authority.sql', import.meta.url)
const migration = readFileSync(migrationUrl, 'utf8')
const derivedFieldMigration = readFileSync(new URL('../supabase/migrations/20260827180000_agent_thread_summary_cas.sql', import.meta.url), 'utf8')
const readReceiptMigration = readFileSync(new URL('../supabase/migrations/20260807120000_agent_session_read_receipts.sql', import.meta.url), 'utf8')
const postgresStore = readFileSync(new URL('../server/store/postgresProductStore.mjs', import.meta.url), 'utf8')
const supabaseStore = readFileSync(new URL('../server/store/supabaseProductStore.mjs', import.meta.url), 'utf8')

test('Supabase RPC 原子合并 Agent 实体并校验项目/会话归属', () => {
  assert.match(migration, /create or replace function public\.botanic_sync_agent_entities/iu)
  assert.match(migration, /agent_sessions[\s\S]*project_id <> p_project_id/iu)
  assert.match(migration, /agent_messages[\s\S]*session_id <> incoming\.session_id/iu)
  assert.match(migration, /on conflict \(id\) do update/iu)
  assert.match(supabaseStore, /\.rpc\('botanic_sync_agent_entities'/u)
})

test('Postgres 历史实体回填遇到跨项目 ID 冲突时中止而非静默丢失', () => {
  assert.match(postgresStore, /Agent entity migration reconciliation failed/iu)
  assert.match(postgresStore, /agent_sessions[\s\S]*indexed\.project_id = expected\.project_id/iu)
  assert.match(postgresStore, /agent_messages[\s\S]*indexed\.session_id = expected\.session_id/iu)
  assert.match(postgresStore, /agent_memory_items[\s\S]*indexed\.project_id = expected\.project_id/iu)
  assert.match(postgresStore, /agent_runs[\s\S]*indexed\.project_id = expected\.project_id/iu)
})

test('Postgres 与 Supabase 都使 Memory 墓碑在同时戳冲突时胜出', () => {
  const tombstoneRule = /updated_at < excluded\.updated_at[\s\S]*updated_at = excluded\.updated_at[\s\S]*deleted_at is null/iu
  assert.match(migration, tombstoneRule)
  assert.match(postgresStore, tombstoneRule)
  assert.match(derivedFieldMigration, tombstoneRule)
})

test('CanvasDocument 只迁移缺失 Agent Run，独立实体状态保持权威', () => {
  assert.match(migration, /insert into public\.agent_runs[\s\S]*on conflict \(id\) do nothing/iu)
  assert.match(derivedFieldMigration, /insert into public\.agent_runs[\s\S]*on conflict \(id\) do nothing/iu)
  assert.match(postgresStore, /insert into agent_runs[\s\S]*on conflict \(id\) do nothing/iu)
  assert.match(supabaseStore, /p_preserve_thread_summary:\s*true/u)
  assert.match(supabaseStore, /AGENT_DERIVED_FIELDS_ATOMIC_WRITE_REQUIRED/u)
})

test('Supabase 显式 Agent Run 写入原子拒绝旧快照和待确认回退', () => {
  assert.match(migration, /create or replace function public\.botanic_put_agent_run/iu)
  assert.match(migration, /existing\.updated_at > incoming\.updated_at/iu)
  assert.match(migration, /existing\.status <> 'awaiting_confirmation'[\s\S]*incoming\.status = 'awaiting_confirmation'/iu)
  assert.match(migration, /select \* into existing from public\.agent_runs where id = incoming\.id[\s\S]*return existing\.payload/iu)
  assert.match(postgresStore, /agent_runs\.updated_at <= excluded\.updated_at[\s\S]*select owner_id as "ownerId", project_id as "projectId", payload/iu)
  assert.match(supabaseStore, /\.rpc\('botanic_put_agent_run'/u)
})

test('Postgres 与 Supabase 在缺失行首次创建前按 runId 串行化', () => {
  const advisoryLock = /pg_advisory_xact_lock\(hashtextextended\([^,]+,\s*0\)\)/iu
  assert.match(migration, advisoryLock)
  assert.match(postgresStore, advisoryLock)
  assert.ok(
    migration.indexOf('pg_advisory_xact_lock') < migration.indexOf('from public.agent_runs where id = incoming.id for update'),
    'Supabase RPC 必须在读取可能缺失的 Agent Run 前取得咨询锁',
  )
  assert.ok(
    postgresStore.indexOf('pg_advisory_xact_lock') < postgresStore.indexOf('from agent_runs where id = ${run.id} for update'),
    'Postgres Adapter 必须在读取可能缺失的 Agent Run 前取得咨询锁',
  )
  assert.match(supabaseStore, /AGENT_RUN_ATOMIC_WRITE_REQUIRED/u)
  assert.doesNotMatch(
    supabaseStore.slice(supabaseStore.indexOf("async putAgentRun(userId, run)"), supabaseStore.indexOf("async readAgentRun(userId, runId)")),
    /from\('agent_runs'\)\.upsert/u,
    'Supabase 缺少原子 RPC 时不得退回非原子 upsert',
  )
})

test('Postgres 与 Supabase 都以成员级阅读回执恢复对话位置', () => {
  assert.match(readReceiptMigration, /create table if not exists public\.agent_session_read_receipts/iu)
  assert.match(readReceiptMigration, /primary key \(user_id, project_id, session_id\)/iu)
  assert.match(readReceiptMigration, /user_id = auth\.uid\(\)[\s\S]*array\['owner', 'editor', 'viewer'\]/iu)
  assert.match(readReceiptMigration, /create or replace function public\.botanic_put_agent_session_read_receipt/iu)
  assert.match(readReceiptMigration, /agent_session_read_receipts\.updated_at < excluded\.updated_at/iu)
  assert.match(postgresStore, /async putAgentSessionReadReceipt\(userId, projectId, sessionId, input\)/u)
  assert.match(postgresStore, /where user_id = \$\{userId\} and project_id = \$\{projectId\} and session_id = \$\{sessionId\}/u)
  assert.match(supabaseStore, /\.rpc\('botanic_put_agent_session_read_receipt'/u)
})
