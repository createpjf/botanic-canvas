import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const migration = readFileSync(
  new URL('../supabase/migrations/20260828150000_agent_recovery_keyset.sql', import.meta.url),
  'utf8',
)

function rpc(name) {
  const match = migration.match(new RegExp(
    `create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`,
    'iu',
  ))
  assert.ok(match, `缺少 ${name} RPC`)
  return match[0]
}

function assertRecoveryCursorStorage(sql, table) {
  assert.match(sql, new RegExp(
    `alter table public\\.${table}\\s+add column if not exists recovery_updated_at_ms bigint`,
    'iu',
  ))
  assert.match(sql, new RegExp(
    `update public\\.${table}[\\s\\S]*?set recovery_updated_at_ms\\s*=[\\s\\S]*?updated_at[\\s\\S]*?where recovery_updated_at_ms is null`,
    'iu',
  ))
  assert.match(sql, new RegExp(
    `alter table public\\.${table}\\s+alter column recovery_updated_at_ms set not null`,
    'iu',
  ))
  assert.match(sql, new RegExp(
    `create trigger [a-z0-9_]+[\\s\\S]*?before insert or update\\s+on public\\.${table}[\\s\\S]*?execute function public\\.botanic_set_recovery_updated_at_ms\\(\\)`,
    'iu',
  ))
}

function assertUpdatedAtIdKeyset(sql, alias) {
  assert.match(sql, /normalized_limit integer := greatest\(1, least\(coalesce\(p_limit, 25\), 200\)\)/iu)
  assert.match(sql, /\(p_after_updated_at_ms is null\) <> \(p_after_id is null\)/iu)
  assert.match(sql, /if p_after_updated_at_ms is null then[\s\S]*?else[\s\S]*?end if;/iu)
  assert.doesNotMatch(sql, /p_after_updated_at_ms is null\s+or/iu)
  assert.match(sql, new RegExp(
    `\\(\\s*${alias}\\.recovery_updated_at_ms\\s*,\\s*${alias}\\.id\\s+collate\\s+"C"\\s*\\)\\s*>\\s*\\(\\s*p_after_updated_at_ms\\s*,\\s*p_after_id\\s+collate\\s+"C"\\s*\\)`,
    'iu',
  ))
  assert.match(sql, new RegExp(
    `order by ${alias}\\.recovery_updated_at_ms asc, ${alias}\\.id\\s+collate\\s+"C" asc[\\s\\S]*limit normalized_limit`,
    'iu',
  ))
  assert.match(sql, new RegExp(
    `${alias}\\.recovery_updated_at_ms as updated_at_ms`,
    'iu',
  ))
  assert.doesNotMatch(sql, new RegExp(
    `floor\\(extract\\(epoch from ${alias}\\.updated_at\\)`,
    'iu',
  ))
}

test('Recovery 三类表持久化毫秒游标并由 updated_at 触发器维护', () => {
  for (const table of ['agent_runs', 'agent_review_tasks', 'generation_jobs']) {
    assertRecoveryCursorStorage(migration, table)
  }
})

test('Recovery 三类扫描都有与过滤条件一致的毫秒 partial keyset 索引', () => {
  assert.match(migration, /agent_runs_failed_branch_recovery_updated_id_idx[\s\S]*on public\.agent_runs \(recovery_updated_at_ms asc, id collate "C" asc\)[\s\S]*where status in \('partial', 'failed'\)[\s\S]*payload @> '\{"branches":\[\{"status":"failed"\}\]\}'::jsonb/iu)
  assert.match(migration, /drop index if exists public\.agent_review_tasks_pending_idx[\s\S]*agent_review_tasks_pending_idx[\s\S]*on public\.agent_review_tasks \(recovery_updated_at_ms asc, id collate "C" asc\)[\s\S]*where status in \('queued', 'running'\)/iu)
  assert.match(migration, /generation_jobs_recoverable_updated_id_idx[\s\S]*on public\.generation_jobs \(recovery_updated_at_ms asc, id collate "C" asc\)[\s\S]*where \(status = 'queued' or payload->>'projectWritebackPending' = 'true'\)/iu)
})

test('失败 Branch Run RPC 以同毫秒 id tie 稳定续页并返回权威 cursor 身份', () => {
  const sql = rpc('botanic_list_runs_with_failed_branches')
  assertUpdatedAtIdKeyset(sql, 'run')
  assert.match(sql, /run\.status in \('partial', 'failed'\)/iu)
  assert.match(sql, /run\.payload @> '\{"branches":\[\{"status":"failed"\}\]\}'::jsonb/iu)
  for (const field of [
    /'id', run\.id/iu,
    /'runId', run\.id/iu,
    /'ownerId', run\.owner_id/iu,
    /'projectId', run\.project_id/iu,
    /'updatedAt', run\.recovery_updated_at_ms/iu,
  ]) assert.match(sql, field)
})

test('pending ReviewTask RPC 应用 olderThan 且由列覆盖 payload 的 id/updatedAt', () => {
  const sql = rpc('botanic_list_pending_agent_review_tasks')
  assertUpdatedAtIdKeyset(sql, 'task')
  assert.match(sql, /p_older_than_ms bigint/iu)
  assert.match(sql, /task\.status in \('queued', 'running'\)/iu)
  assert.match(sql, /task\.recovery_updated_at_ms <= p_older_than_ms/iu)
  assert.match(sql, /task\.payload \|\| jsonb_build_object\([\s\S]*'id', task\.id,[\s\S]*'updatedAt', task\.recovery_updated_at_ms/iu)
})

test('recoverable GenerationJob RPC 同时覆盖 queued 与 writeback pending，并返回权威 cursor', () => {
  const sql = rpc('botanic_list_recoverable_generation_jobs')
  assertUpdatedAtIdKeyset(sql, 'job')
  assert.match(sql, /job\.status = 'queued' or job\.payload->>'projectWritebackPending' = 'true'/iu)
  assert.match(sql, /job\.payload \|\| jsonb_build_object\([\s\S]*'id', job\.id,[\s\S]*'updatedAt', job\.recovery_updated_at_ms/iu)
})

test('Recovery RPC 只授予 service_role', () => {
  const signatures = [
    'botanic_list_runs_with_failed_branches(bigint, text, integer)',
    'botanic_list_pending_agent_review_tasks(bigint, bigint, text, integer)',
    'botanic_list_recoverable_generation_jobs(bigint, text, integer)',
  ]
  for (const signature of signatures) {
    const escaped = signature.replace(/[()]/gu, '\\$&')
    assert.match(migration, new RegExp(`revoke all on function public\\.${escaped}[\\s\\S]*?from public, anon, authenticated`, 'iu'))
    assert.match(migration, new RegExp(`grant execute on function public\\.${escaped}[\\s\\S]*?to service_role`, 'iu'))
  }
})
