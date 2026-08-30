import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const supabase = readFileSync(new URL('./supabaseProductStore.mjs', import.meta.url), 'utf8')
const postgres = readFileSync(new URL('./postgresProductStore.mjs', import.meta.url), 'utf8')
const local = readFileSync(new URL('./productStore.mjs', import.meta.url), 'utf8')
const migration = readFileSync(new URL('../supabase/migrations/20260830052440_agent_artifact_monotonic_upsert.sql', import.meta.url), 'utf8')

test('三套 Artifact Adapter 都以 updatedAt 单调写，并保留最早 createdAt', () => {
  assert.match(local, /existing && Number\(existing\.updatedAt \?\? 0\) > Number\(artifact\.updatedAt \?\? 0\)[\s\S]*Math\.min\(existing\.createdAt, artifact\.createdAt\)/u)
  assert.match(postgres, /created_at = least\(agent_artifacts\.created_at, excluded\.created_at\)[\s\S]*where agent_artifacts\.updated_at <= excluded\.updated_at/u)

  assert.match(supabase, /rpc\('botanic_upsert_agent_artifacts_monotonic'/u)
  assert.doesNotMatch(supabase, /from\('agent_artifacts'\)[\s\S]{0,180}select\('id,owner_id,created_at,updated_at'\)/u)
  assert.match(migration, /on conflict \(project_id, id\) do update/u)
  assert.match(migration, /created_at = least\(agent_artifacts\.created_at, excluded\.created_at\)/u)
  assert.match(migration, /where agent_artifacts\.updated_at <= excluded\.updated_at/u)
  assert.match(migration, /jsonb_set\([\s\S]*'\{createdAt\}'[\s\S]*least\(agent_artifacts\.created_at, excluded\.created_at\)/u)
})

test('三套 Adapter 的当前 Job refresh 都消费 rejected 对账报告', () => {
  for (const source of [local, postgres, supabase]) {
    assert.match(source, /generationArtifactsFromJobReport/u)
    assert.match(source, /generationArtifactRefreshReport/u)
  }
})
