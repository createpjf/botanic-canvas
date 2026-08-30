// @ts-check

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const postgres = readFileSync(new URL('./postgresProductStore.mjs', import.meta.url), 'utf8')
const supabase = readFileSync(new URL('./supabaseProductStore.mjs', import.meta.url), 'utf8')
const local = readFileSync(new URL('./productStore.mjs', import.meta.url), 'utf8')
const persistence = readFileSync(new URL('./botanicAgentPersistence.mjs', import.meta.url), 'utf8')
const productStoreContract = readFileSync(new URL('./productStoreContract.mjs', import.meta.url), 'utf8')
const migration = readFileSync(new URL('../supabase/migrations/20260827180000_agent_thread_summary_cas.sql', import.meta.url), 'utf8')
const sessionSettingsMigration = readFileSync(new URL('../supabase/migrations/20260830052434_agent_session_settings_cas.sql', import.meta.url), 'utf8')

function slice(source, startText, endText) {
  const start = source.indexOf(startText)
  const end = source.indexOf(endText, start)
  assert.ok(start >= 0 && end > start, `${startText} 区段不存在`)
  return source.slice(start, end)
}

test('三个 Adapter 的 CanvasDocument 同步共用不信任 entityReferences 的兼容提取边界', () => {
  const extraction = slice(
    persistence,
    'export function agentStateFromDocument(document',
    'export function mergeAgentStateIntoDocument(',
  )
  const syncs = [
    slice(local, 'function syncAgentStateFromDocument(', 'function publicProject('),
    slice(postgres, 'async function syncAgentState(', 'async function generationObservedAt('),
    slice(supabase, 'async function syncAgentStateFromDocument(', 'async function assertAgentDerivedFieldWriterAvailable('),
  ]

  assert.match(extraction, /delete compatibilityMessage\.entityReferences/u)
  for (const sync of syncs) assert.match(sync, /agentStateFromDocument\(document\)/u)
})

test('PostgreSQL Canvas 兼容 Session 只插入，显式非 CAS writer 仍保留当前 Thread Summary', () => {
  const sync = slice(postgres, 'async function syncAgentState(', 'async function generationObservedAt(')
  const sessionSync = slice(sync, 'for (const session of changedSessions)', 'for (const entry of changedMessages)')
  const putSession = slice(
    postgres,
    'async putAgentSession(userId, projectId, input)',
    'async compareAndSetAgentThreadSummary(userId, command)',
  )
  const putMessage = slice(
    postgres,
    'async putAgentMessage(userId, projectId, sessionId, input)',
    'async putAgentMemoryItem(userId, projectId, input)',
  )
  assert.match(sessionSync, /pg_advisory_xact_lock\(hashtextextended\([\s\S]*agent-session:/u)
  assert.match(sessionSync, /from agent_sessions where id = \$\{session\.id\} for update/u)
  assert.match(sessionSync, /insert into agent_sessions[\s\S]*on conflict \(id\) do nothing/u)
  assert.doesNotMatch(sessionSync, /on conflict \(id\) do update/u)
  assert.match(putSession, /for update/u)
  assert.match(putSession, /preserveAgentThreadSummary\(previous, session\)/u)
  assert.match(putMessage, /from agent_sessions[\s\S]*for update/u)
  assert.match(putMessage, /jsonb_set\(payload, '\{updatedAt\}'/u)
})

test('PostgreSQL Message writer 在锁内共用单调生命周期与 sticky 请求绑定合并器', () => {
  const sync = slice(postgres, 'async function syncAgentState(', 'async function generationObservedAt(')
  const putMessage = slice(
    postgres,
    'async putAgentMessage(userId, projectId, sessionId, input)',
    'async putAgentMemoryItem(userId, projectId, input)',
  )
  assert.match(postgres, /import \{ mergeAgentMessageForWrite \} from '\.\/agentMessageMerge\.mjs'/u)
  for (const writer of [sync, putMessage]) {
    assert.match(writer, /mergeAgentMessageForWrite/u)
    assert.match(writer, /for update/u)
    assert.match(writer, /currentUpdatedAt/u)
    assert.match(writer, /incomingUpdatedAt/u)
  }
})

test('PostgreSQL 协作活动 Adapter 导入所有活动持久化辅助函数', () => {
  const header = postgres.slice(0, postgres.indexOf('const now ='))
  const activityMethods = postgres.slice(
    postgres.indexOf('async listCollaborationActivities'),
    postgres.indexOf('async putAgentSessionReadReceipt'),
  )
  assert.match(header, /from '\.\/collaborationActivityPersistence\.mjs'/u)
  for (const helper of [
    'collaborationActivitiesForMember',
    'collaborationActivityListOptions',
    'nextCollaborationReceipt',
    'validateCollaborationActivity',
  ]) {
    assert.match(header, new RegExp(`\\b${helper}\\b`, 'u'), helper)
    assert.match(activityMethods, new RegExp(`\\b${helper}\\b`, 'u'), helper)
  }
})

test('Supabase Session Message 与 Canvas 同步只走新原子 RPC，缺迁移 fail-closed', () => {
  const sync = slice(supabase, 'async function syncAgentStateFromDocument(', 'async function generationFenceRpc(')
  const putSession = slice(
    supabase,
    'async putAgentSession(userId, projectId, input)',
    'async compareAndSetAgentThreadSummary(userId, command)',
  )
  const putMessage = slice(
    supabase,
    'async putAgentMessage(userId, projectId, sessionId, input)',
    'async putAgentMemoryItem(userId, projectId, input)',
  )
  assert.match(sync, /botanic_sync_agent_entities/u)
  assert.match(sync, /p_preserve_thread_summary:\s*true/u)
  assert.match(sync, /p_insert_sessions_only:\s*true/u)
  assert.match(sync, /AGENT_DERIVED_FIELDS_ATOMIC_WRITE_REQUIRED/u)
  assert.doesNotMatch(sync, /from\(table\)|\.upsert\(safeRows/u)
  assert.match(putSession, /botanic_put_agent_session/u)
  assert.match(putMessage, /botanic_put_agent_message/u)
  for (const writer of [putSession, putMessage]) {
    assert.match(writer, /AGENT_DERIVED_FIELDS_ATOMIC_WRITE_REQUIRED/u)
    assert.doesNotMatch(writer, /from\('agent_sessions'\)|from\('agent_messages'\)|\.upsert\(/u)
  }
  for (const writer of [sync, putMessage]) {
    assert.match(writer, /AGENT_MESSAGE_ROLE_CONFLICT/u)
    assert.match(writer, /AGENT_MESSAGE_TURN_REQUEST_CONFLICT/u)
  }
  const projectWrite = slice(
    supabase,
    'async writeProject(userId, document, expectedRevision, expectedGraphRevision)',
    'async deleteProject(userId, projectId)',
  )
  assert.match(projectWrite, /assertAgentDerivedFieldWriterAvailable\(userId, document\.id\)/u)
  assert.ok(
    projectWrite.indexOf('assertAgentDerivedFieldWriterAvailable') < projectWrite.indexOf('botanic_write_project_document'),
    '缺迁移必须在项目文档落库前 fail-closed',
  )
})

test('三个 Adapter 共用 revision CAS，Canvas 兼容同步不能覆盖既有 Session', () => {
  const helper = slice(
    persistence,
    'export function compareAndSetAgentSessionSettings(',
    'export function validateAgentSessionReadReceipt(',
  )
  const localCas = slice(
    local,
    'compareAndSetAgentSessionSettings(userId, projectId, command)',
    'putAgentSession(userId, projectId, input)',
  )
  const postgresCas = slice(
    postgres,
    'async compareAndSetAgentSessionSettings(userId, projectId, command)',
    'async putAgentSession(userId, projectId, input)',
  )
  const supabaseCas = slice(
    supabase,
    'async compareAndSetAgentSessionSettings(userId, projectId, command)',
    'async putAgentSession(userId, projectId, input)',
  )

  assert.match(helper, /expectedRevision[\s\S]*currentRevision[\s\S]*kind: 'conflict'/u)
  assert.match(helper, /revision: currentRevision \+ 1/u)
  assert.match(productStoreContract, /'compareAndSetAgentSessionSettings'/u)
  assert.match(localCas, /compareAndSetAgentSessionSettings\(conflict\?\.payload, command/u)
  assert.match(postgresCas, /pg_advisory_xact_lock[\s\S]*for update[\s\S]*compareAndSetAgentSessionSettings\(asPayload\(existing\), command/u)
  assert.match(supabaseCas, /rpc\('botanic_compare_and_set_agent_session_settings'/u)
  assert.match(supabaseCas, /normalizeAgentSessionSettingsCommand\(command[\s\S]*p_changes: normalized\.changes/u)
  assert.match(supabaseCas, /AGENT_SESSION_SETTINGS_CAS_REQUIRED/u)

  assert.match(sessionSettingsMigration, /create or replace function public\.botanic_compare_and_set_agent_session_settings/u)
  assert.match(sessionSettingsMigration, /pg_advisory_xact_lock[\s\S]*from public\.agent_sessions where id = p_session_id for update/u)
  assert.match(sessionSettingsMigration, /p_expected_revision <> current_revision[\s\S]*'kind', 'conflict'/u)
  assert.match(sessionSettingsMigration, /jsonb_set\(stored_payload, '\{revision\}', to_jsonb\(next_revision\)/u)
  assert.match(sessionSettingsMigration, /p_insert_sessions_only is distinct from true/u)
  assert.match(sessionSettingsMigration, /insert into public\.agent_sessions[\s\S]*on conflict \(id\) do nothing/u)
  assert.match(sessionSettingsMigration, /turnRequestSnapshot,targetBinding[\s\S]*existing\.payload[\s\S]*- 'targetBinding'/u)
  assert.match(sessionSettingsMigration, /sourceMessageId[\s\S]*sourceNodeIds[\s\S]*existing\.payload->'sourceMessageId'/u)
  assert.match(sessionSettingsMigration, /grant execute on function public\.botanic_compare_and_set_agent_session_settings[\s\S]*to service_role/u)
})

test('Supabase 迁移在单事务锁内保留 Summary、终态与 sticky 请求绑定', () => {
  assert.match(migration, /create or replace function public\.botanic_put_agent_session/u)
  assert.match(migration, /create or replace function public\.botanic_put_agent_message/u)
  assert.match(migration, /create or replace function public\.botanic_sync_agent_entities\([\s\S]*p_preserve_thread_summary boolean/u)
  assert.match(migration, /perform public\.botanic_sync_agent_entities\([\s\S]*p_deleted_memory,[\s\S]*true/u)
  assert.match(migration, /pg_advisory_xact_lock/u)
  assert.match(migration, /existing\.payload \? 'threadSummary'[\s\S]*existing\.payload->'threadSummary'/u)
  assert.match(migration, /agent_sessions\.payload \? 'threadSummary'[\s\S]*agent_sessions\.payload->'threadSummary'/u)
  assert.match(migration, /AGENT_MESSAGE_TURN_ID_CONFLICT/u)
  assert.match(migration, /AGENT_MESSAGE_ROLE_CONFLICT/u)
  assert.match(migration, /AGENT_MESSAGE_TURN_REQUEST_CONFLICT/u)
  assert.match(migration, /botanic_merge_agent_message_sticky_fields/u)
  assert.match(migration, /turnRequestSnapshot/u)
  assert.match(migration, /p_current->>'kind' is distinct from p_incoming->>'kind'/u)
  assert.match(migration, /p_current->>'content' is distinct from p_incoming->>'content'/u)
  assert.match(migration, /p_current->'mentions' is distinct from p_incoming->'mentions'/u)
  assert.match(migration, /p_current->'createdAt' is distinct from p_incoming->'createdAt'/u)
  assert.match(migration, /jsonb_set\(merged, '\{role\}', p_current->'role', true\)/u)
  assert.match(migration, /jsonb_set\(merged, '\{createdAt\}', p_current->'createdAt', true\)/u)
  assert.match(migration, /agent-turn-result-/u)
  assert.match(migration, /current_status = 'failed'[\s\S]*incoming_status is distinct from 'failed'/u)
  assert.match(migration, /incoming_status = 'failed'[\s\S]*current_status is distinct from 'failed'/u)
  assert.match(migration, /jsonb_set\([\s\S]*'\{updatedAt\}'[\s\S]*greatest/u)
  assert.match(migration, /turnCancellationRequestedAt/u)
  assert.match(migration, /least\(current_cancel, incoming_cancel\)/u)
  assert.match(migration, /p_apply_body boolean/u)
  assert.match(migration, /greatest\(agent_messages\.updated_at, excluded\.updated_at\)/u)
  assert.match(migration, /public\.botanic_merge_agent_message_sticky_fields\([\s\S]*agent_messages\.payload,[\s\S]*excluded\.payload,[\s\S]*agent_messages\.updated_at < excluded\.updated_at/u)
  assert.match(migration, /revoke all on function public\.botanic_put_agent_session/u)
  assert.match(migration, /revoke all on function public\.botanic_put_agent_message/u)
})
