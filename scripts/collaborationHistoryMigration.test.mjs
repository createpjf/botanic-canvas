import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const migration = readFileSync(new URL('../supabase/migrations/20260807150000_collaboration_history.sql', import.meta.url), 'utf8')

test('Supabase 协作历史按项目持久化，成员回执按用户隔离', () => {
  assert.match(migration, /create table if not exists public\.collaboration_activities/i)
  assert.match(migration, /primary key \(project_id, id\)/i)
  assert.match(migration, /create table if not exists public\.collaboration_activity_receipts/i)
  assert.match(migration, /primary key \(user_id, project_id\)/i)
  assert.match(migration, /user_id = auth\.uid\(\)/i)
})

test('Supabase 协作回执用原子 RPC 保证多设备时间只向前', () => {
  assert.match(migration, /create or replace function public\.botanic_put_collaboration_activity_receipt/i)
  assert.match(migration, /read_at = greatest\(public\.collaboration_activity_receipts\.read_at, excluded\.read_at\)/i)
  assert.match(migration, /cleared_at = greatest\(public\.collaboration_activity_receipts\.cleared_at, excluded\.cleared_at\)/i)
  assert.match(migration, /revoke all on function public\.botanic_put_collaboration_activity_receipt[\s\S]*from public, anon, authenticated/i)
})
