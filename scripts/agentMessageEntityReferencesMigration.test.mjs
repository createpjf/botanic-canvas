import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const migration = readFileSync(
  new URL('../supabase/migrations/20260828180000_agent_message_entity_references.sql', import.meta.url),
  'utf8',
)
const previous = readFileSync(
  new URL('../supabase/migrations/20260827180000_agent_thread_summary_cas.sql', import.meta.url),
  'utf8',
)

function overload(source, name, marker) {
  const declaration = `create or replace function public.${name}(`
  let start = source.indexOf(declaration)
  while (start !== -1) {
    const signatureEnd = source.indexOf('\n)', start)
    if (signatureEnd !== -1 && source.slice(start, signatureEnd).includes(marker)) {
      const end = source.indexOf('\n$$;', signatureEnd)
      assert.notEqual(end, -1, `无法定位 ${name} 结尾`)
      return source.slice(start, end + 4)
    }
    start = source.indexOf(declaration, start + declaration.length)
  }
  assert.fail(`缺少 ${name}(${marker})`)
}

test('3 参 Message helper 仅对稳定 Turn 投影 sticky 合并 entityReferences', () => {
  const helper = overload(
    migration,
    'botanic_merge_agent_message_sticky_fields',
    'p_apply_body boolean',
  )
  assert.match(helper, /is_turn_projection :=[\s\S]*'agent-turn-result-' \|\| effective_turn_id[\s\S]*'assistant'/u)

  const referenceRuleAt = helper.indexOf('-- Entity References')
  assert.notEqual(referenceRuleAt, -1)
  const referenceRule = helper.slice(referenceRuleAt)
  assert.match(referenceRule, /if is_turn_projection then/u)
  assert.match(referenceRule, /p_current \? 'entityReferences'[\s\S]*p_incoming \? 'entityReferences'[\s\S]*is distinct from/u)
  assert.match(referenceRule, /AGENT_MESSAGE_ENTITY_REFERENCES_CONFLICT[\s\S]*errcode = '23514'/u)
  assert.match(referenceRule, /merged := merged - 'entityReferences'/u)
  assert.match(referenceRule, /if p_current \? 'entityReferences'[\s\S]*p_current->'entityReferences'[\s\S]*elsif p_incoming \? 'entityReferences'[\s\S]*p_incoming->'entityReferences'/u)
  assert.doesNotMatch(helper.slice(0, referenceRuleAt), /merged := merged - 'entityReferences'/u)
})

test('direct PUT 与 Canvas sync 共用 helper：遗漏保留、旧/等时权威回填、冲突同样 fail closed', () => {
  const direct = overload(previous, 'botanic_put_agent_message', 'p_updated_at timestamptz')
  const sync = overload(previous, 'botanic_sync_agent_entities', 'p_preserve_thread_summary boolean')
  assert.match(direct, /botanic_merge_agent_message_sticky_fields\([\s\S]*existing\.payload,[\s\S]*p_message,[\s\S]*existing\.id is null or existing\.updated_at < p_updated_at/u)
  assert.match(sync, /botanic_merge_agent_message_sticky_fields\(null, incoming\.payload, true\)/u)
  assert.match(sync, /botanic_merge_agent_message_sticky_fields\([\s\S]*agent_messages\.payload,[\s\S]*excluded\.payload,[\s\S]*agent_messages\.updated_at < excluded\.updated_at/u)

  const putCapability = overload(migration, 'botanic_put_agent_message', 'p_preserve_entity_references boolean')
  assert.match(putCapability, /p_preserve_entity_references is distinct from true[\s\S]*errcode = '22023'/u)
  assert.match(putCapability, /return public\.botanic_put_agent_message\([\s\S]*p_actor_id,[\s\S]*p_project_id,[\s\S]*p_session_id,[\s\S]*p_message,[\s\S]*p_updated_at[\s\S]*\)/u)
})

test('9 参 sync 同时要求 Summary/References marker，并原样转发完整 Session payload', () => {
  const syncCapability = overload(
    migration,
    'botanic_sync_agent_entities',
    'p_preserve_entity_references boolean',
  )
  assert.match(syncCapability, /p_preserve_thread_summary is distinct from true[\s\S]*p_preserve_entity_references is distinct from true[\s\S]*errcode = '22023'/u)
  assert.match(syncCapability, /perform public\.botanic_sync_agent_entities\([\s\S]*p_owner_id,[\s\S]*p_project_id,[\s\S]*p_sessions,[\s\S]*p_messages,[\s\S]*p_memory,[\s\S]*p_runs,[\s\S]*p_deleted_memory,[\s\S]*p_preserve_thread_summary[\s\S]*\)/u)
  assert.doesNotMatch(syncCapability, /p_sessions\s*->|threadSummary|jsonb_build_object|jsonb_set/u)
})

test('新旧 helper/PUT/sync 签名都仅授权 service_role，兼容签名不删除', () => {
  const signatures = [
    'botanic_merge_agent_message_sticky_fields(jsonb, jsonb)',
    'botanic_merge_agent_message_sticky_fields(jsonb, jsonb, boolean)',
    'botanic_put_agent_message(uuid, text, text, jsonb, timestamptz)',
    'botanic_put_agent_message(uuid, text, text, jsonb, timestamptz, boolean)',
    'botanic_sync_agent_entities(uuid, text, jsonb, jsonb, jsonb, jsonb, jsonb)',
    'botanic_sync_agent_entities(uuid, text, jsonb, jsonb, jsonb, jsonb, jsonb, boolean)',
    'botanic_sync_agent_entities(uuid, text, jsonb, jsonb, jsonb, jsonb, jsonb, boolean, boolean)',
  ]
  for (const signature of signatures) {
    const escaped = signature.replace(/[()]/gu, '\\$&')
    assert.match(migration, new RegExp(`revoke all on function public\\.${escaped}[\\s\\S]*?from public, anon, authenticated`, 'iu'))
    assert.match(migration, new RegExp(`grant execute on function public\\.${escaped}[\\s\\S]*?to service_role`, 'iu'))
  }
  assert.doesNotMatch(migration, /drop function/iu)
})
