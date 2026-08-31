// @ts-check

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const migration = readFileSync(
  new URL('../supabase/migrations/20260830052444_tighten_security_definer_privileges.sql', import.meta.url),
  'utf8',
)
const artifactMigration = readFileSync(
  new URL('../supabase/migrations/20260830052440_agent_artifact_monotonic_upsert.sql', import.meta.url),
  'utf8',
)
const canvasSyncMigration = readFileSync(
  new URL('../supabase/migrations/20260831120000_canvas_sync_v2_phase1.sql', import.meta.url),
  'utf8',
)
const postgresStore = readFileSync(new URL('./postgresProductStore.mjs', import.meta.url), 'utf8')
const supabaseStore = readFileSync(new URL('./supabaseProductStore.mjs', import.meta.url), 'utf8')

test('Supabase SECURITY DEFINER 只保留 RLS 所需权限', () => {
  assert.match(migration, /botanic_handle_new_user\(\) from public, anon, authenticated/u)
  assert.match(migration, /botanic_has_project_role[\s\S]*from public, anon/u)
  assert.match(migration, /botanic_has_project_role[\s\S]*to authenticated/u)
  assert.match(artifactMigration, /botanic_upsert_agent_artifacts_monotonic[\s\S]*from anon/u)
})

test('画布权威图谱与增量在同一数据库快照中读取', () => {
  const postgresLoad = postgresStore.slice(
    postgresStore.indexOf('async loadCanvasCollaboration'),
    postgresStore.indexOf('async appendCanvasGraphUpdate'),
  )
  const supabaseLoad = supabaseStore.slice(
    supabaseStore.indexOf('async loadCanvasCollaboration'),
    supabaseStore.indexOf('async appendCanvasGraphUpdate'),
  )
  const loadRpc = canvasSyncMigration.slice(
    canvasSyncMigration.indexOf('create or replace function public.botanic_load_canvas_collaboration'),
    canvasSyncMigration.indexOf('create or replace function public.botanic_append_canvas_graph_update'),
  )

  assert.match(postgresLoad, /from canvas_graphs[\s\S]*for share/u)
  assert.match(supabaseLoad, /rpc\('botanic_load_canvas_collaboration'/u)
  assert.match(loadRpc, /from public\.canvas_graphs[\s\S]*for share/u)
  assert.match(loadRpc, /from public\.canvas_graph_updates/u)
  assert.match(loadRpc, /revoke all on function public\.botanic_load_canvas_collaboration[\s\S]*to service_role/u)
})

test('V1 历史增量使用内容哈希绑定幂等身份', () => {
  for (const source of [postgresStore, canvasSyncMigration]) {
    assert.match(source, /row_number\(\)[\s\S]*partition by project_id, payload_hash/u)
    assert.match(source, /'legacy:' \|\| payload_hash/u)
    assert.doesNotMatch(source, /set mutation_id = 'legacy:' \|\| id/u)
  }
})
