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

test('Supabase SECURITY DEFINER 只保留 RLS 所需权限', () => {
  assert.match(migration, /botanic_handle_new_user\(\) from public, anon, authenticated/u)
  assert.match(migration, /botanic_has_project_role[\s\S]*from public, anon/u)
  assert.match(migration, /botanic_has_project_role[\s\S]*to authenticated/u)
  assert.match(artifactMigration, /botanic_upsert_agent_artifacts_monotonic[\s\S]*from anon/u)
})
