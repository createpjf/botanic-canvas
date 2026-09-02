import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const contract = readFileSync(new URL('../server/store/productStoreContract.mjs', import.meta.url), 'utf8')
const local = readFileSync(new URL('../server/store/productStore.mjs', import.meta.url), 'utf8')
const postgres = readFileSync(new URL('../server/store/postgresProductStore.mjs', import.meta.url), 'utf8')
const supabase = readFileSync(new URL('../server/store/supabaseProductStore.mjs', import.meta.url), 'utf8')
const runtimeStatuses = readFileSync(new URL('../supabase/migrations/20260827120000_agent_turn_runtime_statuses.sql', import.meta.url), 'utf8')
const indexes = readFileSync(new URL('../supabase/migrations/20260827160000_agent_recovery_pagination.sql', import.meta.url), 'utf8')

function rpc(name) {
  const match = indexes.match(new RegExp(
    `create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`,
    'iu',
  ))
  assert.ok(match, `缺少 ${name} RPC`)
  return match[0]
}

test('ProductStore 核心契约包含三条完整恢复分页查询', () => {
  for (const method of [
    'listAgentRunsForTurnPage',
    'listQueuedAgentRunsForRecovery',
    'listGenerationJobsForAgentRunPage',
  ]) {
    assert.match(contract, new RegExp(`'${method}'`, 'u'))
    for (const adapter of [local, postgres, supabase]) assert.match(adapter, new RegExp(`${method}\\(`, 'u'))
  }
})

test('陈旧 Turn 回收排除 waiting_user，并按 updatedAt/id 使用稳定游标', () => {
  assert.match(contract, /reclaimableAgentTurnStatuses[\s\S]*'queued', 'running', 'cancelling'/u)
  assert.doesNotMatch(runtimeStatuses, /where status in \([^)]*'waiting_user'/u)
  for (const adapter of [local, postgres]) {
    const method = adapter.slice(adapter.indexOf('listStaleAgentTurns'), adapter.indexOf('listStaleAgentTurns') + 2200)
    assert.match(method, /reclaimableAgentTurnStatuses/u)
    assert.match(method, /after/u)
    assert.match(method, /id/u)
  }
  assert.match(postgres, /listStaleAgentTurns[\s\S]*updated_at > \$\{after\.updatedAt\}[\s\S]*id > \$\{after\.id\}[\s\S]*order by updated_at asc, id asc/u)
  assert.match(supabase, /listStaleAgentTurns[\s\S]*botanic_list_stale_agent_turns[\s\S]*p_after_updated_at_ms[\s\S]*p_after_id/u)
  const sql = rpc('botanic_list_stale_agent_turns')
  assert.match(sql, /turn\.recovery_updated_at_ms < p_older_than_ms/iu)
  assert.match(sql, /if p_after_updated_at_ms is null then[\s\S]*?else[\s\S]*?end if;/iu)
  assert.doesNotMatch(sql, /p_after_updated_at_ms is null\s+or/iu)
  assert.match(sql, /\(\s*turn\.recovery_updated_at_ms\s*,\s*turn\.id\s+collate\s+"C"\s*\)\s*>\s*\(\s*p_after_updated_at_ms\s*,\s*p_after_id\s+collate\s+"C"\s*\)/iu)
  assert.match(sql, /order by turn\.recovery_updated_at_ms asc, turn\.id\s+collate\s+"C" asc/iu)
  assert.match(sql, /turn\.recovery_updated_at_ms as updated_at_ms/iu)
  assert.match(sql, /'updatedAt', turn\.recovery_updated_at_ms/iu)
  assert.doesNotMatch(sql, /floor\(extract\(epoch from turn\.updated_at\)/iu)
  assert.doesNotMatch(sql, /'waiting_user'/u)
})

test('PostgreSQL 与 Supabase 的 Run/Job 查询直接使用权威边和 id keyset', () => {
  for (const adapter of [postgres, supabase]) {
    const queued = adapter.slice(adapter.indexOf('listQueuedAgentRunsForRecovery'), adapter.indexOf('listQueuedAgentRunsForRecovery') + 1400)
    const runPage = adapter.slice(adapter.indexOf('listAgentRunsForTurnPage'), adapter.indexOf('listAgentRunsForTurnPage') + 1600)
    const jobPage = adapter.slice(adapter.indexOf('listGenerationJobsForAgentRunPage'), adapter.indexOf('listGenerationJobsForAgentRunPage') + 1800)
    assert.match(queued, /status[^\n]*queued/iu)
    assert.match(queued, /afterId/iu)
    assert.match(queued, /order[^\n]*id/iu)
    assert.match(runPage, /turnId/iu)
    assert.match(runPage, /afterId/iu)
    assert.match(runPage, /order[^\n]*id/iu)
    assert.match(jobPage, /agentRun[\s\S]*runId|agentRun->>runId/iu)
    assert.match(jobPage, /afterId/iu)
    assert.match(jobPage, /order[^\n]*id/iu)
  }
})

test('Supabase 恢复查询具备对应 partial/expression 索引', () => {
  assert.match(indexes, /drop index if exists public\.agent_turns_reclaimable_updated_id_idx[\s\S]*agent_turns_reclaimable_updated_id_idx[\s\S]*on public\.agent_turns \(recovery_updated_at_ms asc, id collate "C" asc\)[\s\S]*where status in \('queued', 'running', 'cancelling'\)/iu)
  assert.match(indexes, /agent_runs_queued_id_idx[\s\S]*where status = 'queued'/u)
  assert.match(indexes, /agent_runs_turn_id_page_idx[\s\S]*payload->>'turnId'/u)
  assert.match(indexes, /generation_jobs_agent_run_id_page_idx[\s\S]*payload->'agentRun'->>'runId'/u)
})

test('Supabase Turn 持久化 recovery_updated_at_ms 并由 updated_at 触发器维护', () => {
  assert.match(indexes, /alter table public\.agent_turns\s+add column if not exists recovery_updated_at_ms bigint/iu)
  assert.match(indexes, /update public\.agent_turns[\s\S]*?set recovery_updated_at_ms\s*=[\s\S]*?updated_at[\s\S]*?where recovery_updated_at_ms is null/iu)
  assert.match(indexes, /alter table public\.agent_turns\s+alter column recovery_updated_at_ms set not null/iu)
  assert.match(indexes, /create trigger [a-z0-9_]+[\s\S]*?before insert or update\s+on public\.agent_turns[\s\S]*?execute function public\.botanic_set_recovery_updated_at_ms\(\)/iu)

  const triggerFunction = indexes.match(/create or replace function public\.botanic_set_recovery_updated_at_ms\(\)[\s\S]*?\n\$\$;/iu)?.[0]
  assert.ok(triggerFunction, '缺少 recovery_updated_at_ms 触发器函数')
  assert.match(triggerFunction, /new\.recovery_updated_at_ms\s*:=[\s\S]*new\.updated_at/iu)
  assert.doesNotMatch(triggerFunction, /\b(?:now\(\)|current_timestamp|clock_timestamp\(\)|statement_timestamp\(\))\b/iu)
})
