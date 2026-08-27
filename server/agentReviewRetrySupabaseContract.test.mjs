import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

const migrationUrl = new URL(
  '../supabase/migrations/20260828160000_agent_review_retry_atomic.sql',
  import.meta.url,
)

function migrationSource() {
  return readFileSync(migrationUrl, 'utf8')
}

function reviewRetryRpc(migration) {
  const start = migration.indexOf(
    'create or replace function public.botanic_commit_agent_review_human_decisions',
  )
  const end = migration.indexOf(
    '\nrevoke all on function public.botanic_commit_agent_review_human_decisions',
    start,
  )
  return migration.slice(start, end)
}

test('Supabase Review retry 使用带版本门禁的原子 RPC，旧函数不会先写 Decision', () => {
  assert.equal(existsSync(migrationUrl), true)
  const migration = migrationSource()
  assert.match(
    migration,
    /drop function if exists public\.botanic_commit_agent_review_human_decisions\(uuid, text, text, jsonb\)/u,
  )
  assert.match(
    migration,
    /create or replace function public\.botanic_commit_agent_review_human_decisions\([\s\S]*p_contract_version integer/u,
  )
  assert.match(migration, /p_contract_version is distinct from 2/u)
})

test('RPC 用 DB 时钟与 Task + 稳定排序 Run 锁裁决，并按 edit/create-generation 分权', () => {
  const rpc = reviewRetryRpc(migrationSource())

  assert.match(rpc, /pg_advisory_xact_lock\(hashtextextended\(p_task_id, 5\)\)/u)
  assert.match(rpc, /from public\.agent_review_tasks[\s\S]*for update/u)
  assert.match(
    rpc,
    /select[\s\S]*rows\.run_id[\s\S]*order by rows\.run_id collate "C"[\s\S]*pg_advisory_xact_lock\(hashtextextended\(locked_run_id, 0\)\)/u,
  )
  assert.match(rpc, /from public\.agent_runs[\s\S]*order by id[\s\S]*for update/u)
  assert.match(rpc, /clock_timestamp\(\)/u)
  assert.doesNotMatch(rpc, /p_command->>'observedAt'/u)
  assert.match(rpc, /required_permission := case when has_retry then 'create-generation' else 'edit' end/u)
  assert.match(rpc, /role::text in \('owner', 'editor'\)/u)
})

test('SQL declare 无重复标识符，canonical hash 与 JS 键序/数值阈值及安全 search_path 对齐', () => {
  const migration = migrationSource()
  const rpc = reviewRetryRpc(migration)
  const declaration = rpc.slice(rpc.indexOf('\ndeclare\n') + 9, rpc.indexOf('\nbegin\n'))
  const identifiers = declaration.split('\n').flatMap((line) => {
    const match = /^\s{2}([a-z][a-z0-9_]*)\s+/u.exec(line)
    return match ? [match[1]] : []
  })

  assert.equal(identifiers.length, new Set(identifiers).size)
  assert.equal(identifiers.filter((name) => name === 'changed').length, 1)
  assert.match(migration, /order by entry\.key collate "C"[\s\S]*from jsonb_each\(p_value\)/u)
  assert.match(migration, /order by entry\.ordinal[\s\S]*from jsonb_array_elements\(p_value\)/u)
  assert.match(migration, /absolute_value >= 0\.000001[\s\S]*absolute_value < 1000000000000000000000/u)
  assert.match(migration, /regexp_replace\(exponent_value, 'e\(\[\+-\]\?\)0\+/u)
  assert.match(migration, /pg_catalog\.sha256\(pg_catalog\.convert_to/u)
  assert.doesNotMatch(migration, /\bdigest\(/u)
  assert.match(
    migration,
    /botanic_canonical_json_hash\(\s*'\{"z":1e-7,"a":\{"b":1e\+21,"c":0\.000001,"d":1\.0000000000000002\}\}'::jsonb\s*\)[\s\S]*SJehkqRQqU8R4gPzIXi6Ll4ps7wlhVGnlJhGncNCFdo/u,
  )
  assert.match(
    migration,
    /botanic_canonical_json_hash\(\s*'\{"Z":1,"a":2,"_":3,"A":4\}'::jsonb\s*\)[\s\S]*-gr8vMCWEzhTn5TGLoPEUDhTSGrMzTwpW0knX_4q5Dw/u,
  )
  assert.equal(
    (migration.match(/set search_path = ''/gu) ?? []).length,
    (migration.match(/create or replace function public\./gu) ?? []).length,
  )
  assert.match(migration, /revoke all on function public\.botanic_js_number_text\(jsonb\)/u)
  assert.match(rpc, /security definer[\s\S]*set search_path = ''/u)
})

test('RPC 复刻 retry helper 的稳定身份、binding、legacy 与整批零写约束', () => {
  const migration = migrationSource()
  const rpc = reviewRetryRpc(migration)

  assert.match(migration, /create or replace function public\.botanic_canonical_json_text\(/u)
  assert.match(migration, /create or replace function public\.botanic_canonical_json_hash\(/u)
  assert.match(migration, /create or replace function public\.botanic_agent_review_retry_run_id\(/u)
  assert.match(migration, /agent_run_review_retry_/u)
  assert.match(rpc, /'agent-review\.retry'/u)
  assert.match(rpc, /'agent-run\.create'/u)
  assert.match(rpc, /'generation:' \|\| source_job_id \|\| ':' \|\| source_output_id/u)
  assert.match(rpc, /retryMaterialization/u)
  assert.match(rpc, /requestBinding/u)
  assert.match(rpc, /legacy_unknown/u)
  assert.match(rpc, /run_payload \? 'execution'/u)
  assert.match(rpc, /jsonb_array_length\(run_payload->'branches'\) <> 1/u)
  assert.match(rpc, /existing_run\.payload->'idempotencyBinding'/u)
  assert.match(rpc, /public\.botanic_agent_review_run_submission_hash\(existing_run_payload\)/u)
  assert.match(
    rpc,
    /run_payload->'idempotencyBinding'[\s\S]*public\.botanic_agent_review_run_submission_request\(run_payload\)/u,
  )

  const legacyCheck = rpc.indexOf("'legacy_unknown'")
  const writesBoundary = rpc.indexOf('-- 所有 fail-closed 验证完成后才允许写入')
  const firstInsert = rpc.indexOf('insert into public.agent_runs')
  const taskUpdate = rpc.indexOf('update public.agent_review_tasks')
  assert.ok(legacyCheck > 0 && writesBoundary > legacyCheck)
  assert.ok(firstInsert > writesBoundary && taskUpdate > writesBoundary)
  assert.match(rpc, /'retryRuns', retry_runs/u)
  assert.match(rpc, /exception when[\s\S]*unique_violation[\s\S]*'kind', 'conflict'/u)
})

test('Supabase Adapter 用 v2 RPC fail-fast，映射权限/契约错误并校验 retryRuns 响应', () => {
  const source = readFileSync(new URL('./supabaseProductStore.mjs', import.meta.url), 'utf8')
  const helperStart = source.indexOf('async function agentReviewHumanDecisionRpc')
  const helperEnd = source.indexOf('\n  async function recoveryKeysetRpc', helperStart)
  const helper = source.slice(helperStart, helperEnd)
  const methodStart = source.indexOf('async commitAgentReviewHumanDecisions')
  const methodEnd = source.indexOf('\n    async readAgentReviewTask', methodStart)
  const method = source.slice(methodStart, methodEnd)

  assert.ok(helperStart > 0 && helperEnd > helperStart)
  assert.match(helper, /AGENT_REVIEW_RETRY_ATOMIC_REQUIRED/u)
  assert.match(helper, /error\.code === '42501'[\s\S]*PROJECT_WRITE_FORBIDDEN/u)
  assert.match(helper, /error\.code === '22023'[\s\S]*AGENT_REVIEW_TRANSITION_INVALID/u)
  assert.match(helper, /Array\.isArray\(data\.retryRuns\)/u)
  assert.match(helper, /AGENT_REVIEW_RETRY_ATOMIC_RESPONSE_INVALID/u)
  assert.match(method, /agentReviewHumanDecisionRpc\('botanic_commit_agent_review_human_decisions'/u)
  assert.match(method, /p_contract_version: 2/u)
  assert.doesNotMatch(method, /agentReviewFenceRpc/u)
})
