import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const migrationUrl = new URL('../supabase/migrations/20260804150000_agent_entity_conflict_rules.sql', import.meta.url)
const migration = readFileSync(migrationUrl, 'utf8')
const postgresStore = readFileSync(new URL('../server/postgresProductStore.mjs', import.meta.url), 'utf8')
const supabaseStore = readFileSync(new URL('../server/supabaseProductStore.mjs', import.meta.url), 'utf8')

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
  assert.match(supabaseStore, /tombstoneWinsTie:\s*table === 'agent_memory_items'/u)
})
