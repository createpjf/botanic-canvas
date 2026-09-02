import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const migrationUrl = new URL('../supabase/migrations/20260804140000_agent_artifact_index.sql', import.meta.url)
const migration = readFileSync(migrationUrl, 'utf8')
const postgresStoreUrl = new URL('../server/store/postgresProductStore.mjs', import.meta.url)
const postgresSchemaUrl = new URL('../server/store/postgresSchema.mjs', import.meta.url)
// schema DDL 已拆至 postgresSchema.mjs;契约继续覆盖 Adapter+Schema 的合并文本。
const postgresStore = readFileSync(postgresStoreUrl, 'utf8') + readFileSync(postgresSchemaUrl, 'utf8')

test('Artifact Index 迁移在全部三类来源回填后执行事务内对账', () => {
  const insertPositions = [...migration.matchAll(/insert into public\.agent_artifacts/giu)].map((match) => match.index)
  const reconciliationPosition = migration.indexOf('Artifact Index migration reconciliation failed')

  assert.equal(insertPositions.length, 3)
  assert.ok(reconciliationPosition > insertPositions.at(-1))
  assert.match(migration, /from public\.agent_messages message/iu)
  assert.match(migration, /from public\.agent_action_receipts receipt/iu)
  assert.match(migration, /from public\.generation_jobs job/iu)
  assert.match(migration, /where indexed\.id is null/iu)
  assert.match(migration, /raise exception 'Artifact Index migration reconciliation failed/iu)
})

test('Railway PostgreSQL 启动迁移也在三类来源回填后执行事务内对账', () => {
  const insertPositions = [...postgresStore.matchAll(/insert into agent_artifacts/giu)].map((match) => match.index)
  const reconciliationPosition = postgresStore.indexOf('Artifact Index migration reconciliation failed')

  assert.ok(insertPositions.length >= 3)
  assert.ok(reconciliationPosition > insertPositions[2])
  assert.match(postgresStore, /from agent_messages message/iu)
  assert.match(postgresStore, /from agent_action_receipts receipt/iu)
  assert.match(postgresStore, /from generation_jobs job/iu)
  assert.match(postgresStore, /where indexed\.id is null/iu)
  assert.match(postgresStore, /malformed_count/iu)
  assert.match(postgresStore, /raise exception 'Artifact Index migration reconciliation failed/iu)
})

test('Artifact Index 迁移保留项目级主键与成员只读策略', () => {
  assert.match(migration, /primary key \(project_id, id\)/iu)
  assert.match(migration, /project members can read agent artifacts/iu)
  assert.match(migration, /array\['owner', 'editor', 'viewer'\]/iu)
})

test('生成 Artifact ID 在拼接前先提取 JSONB 字段，避免被解析为 text ->> unknown', () => {
  const safeExpression = /'generation:' \|\| job\.id \|\| ':' \|\| \(output->>'id'\)/u
  const unsafeExpression = /'generation:' \|\| job\.id \|\| ':' \|\| output->>'id'/u

  assert.match(migration, safeExpression)
  assert.doesNotMatch(migration, unsafeExpression)
  assert.match(postgresStore, safeExpression)
  assert.doesNotMatch(postgresStore, unsafeExpression)
})

test('PostgreSQL 与 Supabase 历史生成回填从项目文档保留结果节点血缘', () => {
  for (const source of [migration, postgresStore]) {
    assert.match(source, /jsonb_array_elements\(coalesce\(project\.document->'nodes', '\[\]'::jsonb\)\)/iu)
    assert.match(source, /node->'data'->>'jobId' = job\.id/iu)
    assert.match(source, /node->'data'->>'candidateId' = output->>'id'/iu)
  }
})
