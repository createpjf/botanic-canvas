// @ts-check

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { productStoreCoreMethods } from '../../store/productStoreContract.mjs'

const adapters = [
  ['Local', readFileSync(new URL('../../store/productStore.mjs', import.meta.url), 'utf8')],
  ['PostgreSQL', readFileSync(new URL('../../store/postgresProductStore.mjs', import.meta.url), 'utf8')],
  ['Supabase', readFileSync(new URL('../../store/supabaseProductStore.mjs', import.meta.url), 'utf8')],
]
const skillMigration = readFileSync(new URL(
  '../../../supabase/migrations/20260828220000_agent_skill_atomic_persistence.sql',
  import.meta.url,
), 'utf8')

function methodSource(source, name, nextName) {
  const signatures = [`async ${name}(`, `${name}(`]
  const starts = signatures.map((signature) => source.indexOf(signature)).filter((value) => value >= 0)
  assert.ok(starts.length, `${name} missing`)
  const start = Math.min(...starts)
  const nextSignatures = [`async ${nextName}(`, `${nextName}(`]
  const ends = nextSignatures.map((signature) => source.indexOf(signature, start + 1)).filter((value) => value > start)
  assert.ok(ends.length, `${nextName} missing after ${name}`)
  return source.slice(start, Math.min(...ends))
}

test('Skill 历史版本读取是三个 ProductStore Adapter 的核心契约', () => {
  assert.equal(productStoreCoreMethods.includes('readAgentSkillVersion'), true)
  for (const [name, source] of adapters) {
    assert.match(source, /persistedAgentSkillVersion/u, name)
    assert.match(source, /(?:async )?readAgentSkillVersion\(/u, name)
  }
})

test('Skill 写入只持久化领域快照，Adapter 不增版本、不截断历史', () => {
  for (const [name, source] of adapters.slice(0, 2)) {
    const put = methodSource(source, 'putAgentSkill', 'listAgentSkills')
    assert.match(put, /agentSkillPersistenceDecision\(/u, name)
    assert.match(put, /decision\.kind === 'replay'/u, name)
    assert.doesNotMatch(put, /createHash|slice\(-20\)|const\s+version\s*=|const\s+contentHash\s*=|const\s+versions\s*=/u, name)
  }
  const supabasePut = methodSource(adapters[2][1], 'putAgentSkill', 'listAgentSkills')
  assert.match(supabasePut, /supabase\.rpc\('botanic_put_agent_skill'/u)
  assert.match(supabasePut, /AGENT_SKILL_ATOMIC_PERSISTENCE_REQUIRED/u)
  assert.doesNotMatch(supabasePut, /\.from\('agent_skills'\)\.upsert|agentSkillPersistenceDecision\(/u)
})

test('PostgreSQL Skill 写入在同一事务锁内完成权限、决策、写入与审计', () => {
  const put = methodSource(adapters[1][1], 'putAgentSkill', 'listAgentSkills')
  assert.match(put, /return sql\.begin\(async \(tx\) =>/u)
  assert.match(put, /pg_advisory_xact_lock\(hashtextextended/u)
  assert.match(put, /project_members[\s\S]*for share/u)
  assert.match(put, /from agent_skills[\s\S]*for update/u)
  assert.match(put, /agentSkillPersistenceDecision\([\s\S]*await tx`[\s\S]*insert into agent_skills/u)
  assert.match(put, /insertAudit\(tx,/u)
})

test('Supabase Skill RPC 串行化同一 ID，并在数据库重算 hash 与完整历史', () => {
  assert.match(skillMigration, /create or replace function public\.botanic_put_agent_skill\(/u)
  assert.match(skillMigration, /pg_advisory_xact_lock\(hashtextextended\(command_skill_id/u)
  assert.match(skillMigration, /from public\.agent_skills as skill[\s\S]*for update/u)
  assert.match(skillMigration, /public\.botanic_agent_skill_execution_hash\(snapshot\)/u)
  assert.match(skillMigration, /public\.botanic_canonical_json_hash\(jsonb_build_object\(/u)
  assert.match(skillMigration, /douzsE2vbVirbUKvqk0jC-RqoLtvoMGD7H4CcNonFQg/u)
  assert.match(skillMigration, /wN5FAvyktMi6n5aB9hL1l-KSLTorNJXjp4z-IhadQCY/u)
  assert.match(skillMigration, /botanic_agent_skill_schema_keys_are_ascii\(output_schema\)/u)
  assert.ok(skillMigration.includes("'^[A-Za-z_][A-Za-z0-9_.-]{0,79}$'"))
  assert.match(skillMigration, /\(dependency->>'version'\)::numeric > 9007199254740991/u)
  assert.match(skillMigration, /\(p_skill->>'version'\)::numeric > 9007199254740991/u)
  assert.match(skillMigration, /NiNG1eDcG9QAKjDUCnrmhBoTqCwaBBWllOhXqqO2Lqc/u)
  assert.match(skillMigration, /"properties":\{"说明":\{"type":"string"\}\}/u)
  assert.match(skillMigration, /evaluator schema accepted a Unicode object key/u)
  assert.match(skillMigration, /incoming_version = existing_version[\s\S]*AGENT_SKILL_VERSION_CONFLICT/u)
  assert.match(skillMigration, /incoming_version <> existing_version \+ 1[\s\S]*AGENT_SKILL_HISTORY_CONFLICT/u)
  assert.match(skillMigration, /incoming_snapshot - 'publishedBy' - 'publishedAt'/u)
  assert.match(skillMigration, /previous_snapshot_version is distinct from incoming_version/u)
  assert.match(skillMigration, /existing_count = 0[\s\S]*snapshot_version = existing_version/u)
  assert.match(skillMigration, /snapshot->'updatedAt' = legacy_updated_at/u)
  assert.match(skillMigration, /botanic_agent_skill_execution_hash\(existing_row\.payload\)[\s\S]*existing_row\.payload->>'contentHash'/u)
  assert.match(skillMigration, /stored_payload - 'versions'\) = \(existing_row\.payload - 'versions'/u)
  assert.match(skillMigration, /incoming_updated_at <= existing_updated_at[\s\S]*AGENT_SKILL_VERSION_STALE/u)
  assert.doesNotMatch(skillMigration, /incoming_count is distinct from incoming_version/u)
  assert.match(skillMigration, /insert into public\.audit_events/u)
  assert.match(skillMigration, /revoke all on function public\.botanic_put_agent_skill\(uuid, jsonb\)[\s\S]*grant execute[\s\S]*service_role/u)
})

test('同基线 v1 的两个 v2 候选不能互相覆盖，跨项目 ID 明确冲突', () => {
  // 锁必须先于权威行读取：第二个 v2 只会在第一个提交后读到新前缀。
  const lockAt = skillMigration.indexOf('pg_advisory_xact_lock(hashtextextended(command_skill_id')
  const readAt = skillMigration.indexOf('from public.agent_skills as skill')
  const compareAt = skillMigration.indexOf("incoming_snapshot - 'publishedBy' - 'publishedAt'")
  const writeAt = skillMigration.indexOf('insert into public.agent_skills')
  assert.ok(lockAt >= 0 && lockAt < readAt && readAt < compareAt && compareAt < writeAt)
  assert.match(skillMigration, /existing_row\.project_id is distinct from command_project_id[\s\S]*AGENT_SKILL_ID_CONFLICT/u)
  assert.match(methodSource(adapters[2][1], 'putAgentSkill', 'listAgentSkills'), /AGENT_SKILL_ID_CONFLICT/u)
})

test('历史版本读取绕过 active 目录过滤，仍按项目成员边界鉴权', () => {
  for (const [name, source] of adapters) {
    const read = methodSource(source, 'readAgentSkillVersion', 'putAgentActionReceipt')
    assert.match(read, /persistedAgentSkillVersion\(/u, name)
    assert.doesNotMatch(read, /status\s*=\s*'active'|status\s*!==\s*'archived'/u, name)
  }

  const localRead = methodSource(adapters[0][1], 'readAgentSkillVersion', 'putAgentActionReceipt')
  assert.match(localRead, /canAccess\(project, userId\)/u)
  for (const [, source] of adapters.slice(1)) {
    const read = methodSource(source, 'readAgentSkillVersion', 'putAgentActionReceipt')
    assert.match(read, /memberRole\(projectId, userId\)/u)
    assert.match(read, /project_id/u)
  }
})
