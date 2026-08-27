import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const migration = readFileSync(new URL('../supabase/migrations/20260827120000_agent_turn_runtime_statuses.sql', import.meta.url), 'utf8')
const recoveryPaginationMigration = readFileSync(new URL('../supabase/migrations/20260827160000_agent_recovery_pagination.sql', import.meta.url), 'utf8')
const supabaseStore = readFileSync(new URL('../server/supabaseProductStore.mjs', import.meta.url), 'utf8')

test('Supabase Agent Turn 状态词表与 ProductStore Runtime 保持一致', () => {
  assert.match(migration, /drop constraint if exists agent_turns_status_check/iu)
  for (const status of ['queued', 'running', 'waiting_user', 'cancelling', 'completed', 'failed', 'cancelled']) {
    assert.match(migration, new RegExp(`'${status}'`, 'u'))
  }
})

test('Supabase Agent Turn 陈旧扫描最终使用持久化毫秒游标的 partial 索引', () => {
  assert.match(recoveryPaginationMigration, /drop index if exists public\.agent_turns_reclaimable_updated_id_idx/iu)
  assert.match(recoveryPaginationMigration, /create index (?:if not exists )?agent_turns_reclaimable_updated_id_idx/iu)
  assert.match(recoveryPaginationMigration, /on public\.agent_turns \(recovery_updated_at_ms asc, id collate "C" asc\)/iu)
  assert.match(recoveryPaginationMigration, /where status in \('queued', 'running', 'cancelling'\)/iu)
  assert.doesNotMatch(recoveryPaginationMigration, /where status in \([^)]*'waiting_user'/iu)
})

test('Supabase 陈旧 Turn 扫描经 160000 RPC 复用持久化毫秒时间并稳定续页', () => {
  assert.match(recoveryPaginationMigration, /create or replace function public\.botanic_list_stale_agent_turns/iu)
  assert.match(recoveryPaginationMigration, /turn\.recovery_updated_at_ms < p_older_than_ms/iu)
  assert.match(recoveryPaginationMigration, /if p_after_updated_at_ms is null then[\s\S]*?else[\s\S]*?end if;/iu)
  assert.doesNotMatch(recoveryPaginationMigration, /p_after_updated_at_ms is null\s+or/iu)
  assert.match(recoveryPaginationMigration, /\(\s*turn\.recovery_updated_at_ms\s*,\s*turn\.id\s+collate\s+"C"\s*\)\s*>\s*\(\s*p_after_updated_at_ms\s*,\s*p_after_id\s+collate\s+"C"\s*\)/iu)
  assert.match(recoveryPaginationMigration, /order by turn\.recovery_updated_at_ms asc, turn\.id\s+collate\s+"C" asc/iu)
  assert.match(recoveryPaginationMigration, /'updatedAt', turn\.recovery_updated_at_ms/iu)
  assert.doesNotMatch(recoveryPaginationMigration, /floor\(extract\(epoch from turn\.updated_at\)/iu)
  assert.match(supabaseStore, /supabase\.rpc\('botanic_list_stale_agent_turns'/u)
  assert.match(supabaseStore, /p_after_updated_at_ms: after\?\.updatedAt \?\? null/u)
  assert.doesNotMatch(supabaseStore, /\.lt\('updated_at', new Date\(olderThan\)\.toISOString\(\)\)/u)
})
