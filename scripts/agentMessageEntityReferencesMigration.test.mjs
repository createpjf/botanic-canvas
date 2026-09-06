import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import postgres from 'postgres'
import { mergeAgentMessageForWrite } from '../server/agent/thread/agentMessageMerge.mjs'

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

test('确认一致性 SQL 与实际 JS 合并一致：重放、不同答案、后续计划和失败终态', {
  skip: !process.env.AGENT_TEST_PG_SOCKET,
}, async () => {
  const socket = process.env.AGENT_TEST_PG_SOCKET
  assert.match(socket, /^\/private\/tmp\/botanic-agent-sql-[^/]+$/u, '只允许隔离测试数据库 socket')
  const sql = postgres({ host: socket, port: 55479, database: 'postgres', max: 1 })
  const source = readFileSync(new URL('../supabase/migrations/20260904234954_agent_clarification_answer_consistency.sql', import.meta.url), 'utf8')
  const helper = overload(source, 'botanic_merge_agent_message_sticky_fields', 'p_apply_body boolean')
  const pending = { id: 'agent-turn-result-t', turnId: 't', role: 'assistant', kind: 'question', status: 'pending', createdAt: 1, updatedAt: 900,
    question: { id: 'q', originalInstruction: '生成图片', fields: [{ id: 'resolution', defaultValue: '2K' }] } }
  const answered = { ...pending, status: 'answered', updatedAt: 20 }
  const plan = { ...pending, kind: 'plan', status: 'pending', question: undefined, plan: { turnId: 't' }, updatedAt: 30 }
  const promptQuestion = { ...answered, id: 'prompt-question', turnId: undefined }
  const prompt = { ...promptQuestion, kind: 'text', question: undefined, prompt: '香水广告', updatedAt: 10 }
  try {
    await sql.begin(async (tx) => {
      await tx`create temporary table clarification_sql_test (id integer)`
      await tx.unsafe(helper.replace('public.botanic_merge_agent_message_sticky_fields(', 'pg_temp.botanic_merge_agent_message_sticky_fields('))
      for (const [current, incoming] of [[pending, answered], [answered, { ...pending, updatedAt: 1000 }], [answered, { ...answered, content: '旧正文', updatedAt: 1000 }], [answered, plan], [plan, answered], [{ ...answered, status: 'failed' }, plan], [promptQuestion, prompt], [prompt, promptQuestion]]) {
        const [row] = await tx`select pg_temp.botanic_merge_agent_message_sticky_fields(${tx.json(current)}, ${tx.json(incoming)}, ${incoming.updatedAt > current.updatedAt}) as message`
        assert.deepEqual(row.message, JSON.parse(JSON.stringify(mergeAgentMessageForWrite(current, incoming).message)))
      }
      await assert.rejects(() => tx.savepoint(async (nested) => {
        await nested`select pg_temp.botanic_merge_agent_message_sticky_fields(${nested.json(answered)}, ${nested.json({ ...answered, updatedAt: 1000, question: { ...answered.question, fields: [{ id: 'resolution', defaultValue: '1K' }] } })}, true)`
      }), { code: '23514', message: 'AGENT_MESSAGE_ANSWER_CONFLICT' })
      await assert.rejects(() => tx.savepoint(async (nested) => {
        const next = { ...pending, question: { ...pending.question, id: 'next-question' } }
        await nested`select pg_temp.botanic_merge_agent_message_sticky_fields(${nested.json(next)}, ${nested.json({ ...answered, updatedAt: 9000 })}, true)`
      }), { code: '23514', message: 'AGENT_MESSAGE_ANSWER_CONFLICT' })
    })
  } finally { await sql.end() }
})

test('确认 RPC 完整调用链保留答案、拒绝冲突并限制执行权限', {
  skip: !process.env.AGENT_TEST_PG_SOCKET,
}, async () => {
  const socket = process.env.AGENT_TEST_PG_SOCKET
  assert.match(socket, /^\/private\/tmp\/botanic-agent-sql-[^/]+$/u, '只允许隔离测试数据库 socket')
  const sql = postgres({ host: socket, port: 55479, database: 'postgres', max: 1 })
  const sources = [previous, migration,
    readFileSync(new URL('../supabase/migrations/20260830052434_agent_session_settings_cas.sql', import.meta.url), 'utf8'),
    readFileSync(new URL('../supabase/migrations/20260904234954_agent_clarification_answer_consistency.sql', import.meta.url), 'utf8'),
    readFileSync(new URL('../supabase/migrations/20260905004125_agent_entity_sync_jsonb_precedence.sql', import.meta.url), 'utf8'),
  ]
  const rollback = new Error('ROLLBACK_AGENT_RPC_TEST')
  try {
    await assert.rejects(sql.begin(async (tx) => {
      // 只用连接级临时表/函数跑迁移中的真实函数体，不依赖或修改 public 数据。
      await tx.unsafe(`
        create temporary table agent_sessions (id text primary key, owner_id uuid, project_id text, updated_at timestamptz, payload jsonb);
        create temporary table agent_messages (id text primary key, owner_id uuid, project_id text, session_id text, updated_at timestamptz, payload jsonb);
        create type pg_temp.botanic_project_role as enum ('owner', 'editor', 'viewer');
        create temporary table project_members (project_id text, user_id uuid, role pg_temp.botanic_project_role);
        create temporary table agent_memory_items (id text primary key, owner_id uuid, project_id text, updated_at timestamptz, deleted_at timestamptz, payload jsonb);
        create temporary table agent_runs (id text primary key, owner_id uuid, project_id text, status text, updated_at timestamptz, payload jsonb);
      `)
      for (const role of ['anon', 'authenticated', 'service_role']) {
        if (!(await tx`select 1 from pg_roles where rolname = ${role}`).length) await tx.unsafe(`create role ${role}`)
      }
      for (const source of sources) {
        for (const [definition] of source.matchAll(/create or replace function public\.botanic_(?:merge_agent_message_sticky_fields|put_agent_message|sync_agent_entities)\([\s\S]*?\n\$\$;/gu)) {
          await tx.unsafe(definition.replaceAll('public.', 'pg_temp.'))
        }
        for (const [grant] of source.matchAll(/(?:revoke all|grant execute) on function public\.botanic_(?:merge_agent_message_sticky_fields|put_agent_message|sync_agent_entities)\([\s\S]*?;/gu)) {
          await tx.unsafe(grant.replaceAll('public.', 'pg_temp.'))
        }
      }
      const actor = '00000000-0000-4000-8000-000000000001'
      const viewer = '00000000-0000-4000-8000-000000000002'
      await tx`insert into pg_temp.project_members values ('p', ${actor}, 'editor'), ('p', ${viewer}, 'viewer')`
      await tx`insert into pg_temp.agent_sessions values ('s', ${actor}, 'p', to_timestamp(0), '{"id":"s","updatedAt":0}')`
      const pending = { id: 'agent-turn-result-rpc', turnId: 'rpc', role: 'assistant', kind: 'question', status: 'pending', content: '清晰度', createdAt: 1, updatedAt: 900,
        question: { id: 'q-rpc', originalInstruction: '生成图片', fields: [{ id: 'resolution', defaultValue: '2K' }] } }
      const answered = { ...pending, status: 'answered', updatedAt: 20 }
      const put = async (message, user = actor, capability = true, query = tx) => (await query`select pg_temp.botanic_put_agent_message(${user}::uuid, 'p', 's', ${query.json(message)}, ${new Date(message.updatedAt)}, true, ${capability}) as result`)[0].result.payload
      const sync = async (message, query = tx) => query`select pg_temp.botanic_sync_agent_entities(${actor}::uuid, 'p', '[]'::jsonb, ${query.json([{ id: message.id, project_id: 'p', session_id: 's', updated_at: new Date(message.updatedAt).toISOString(), payload: message }])}, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, true, true, true, true)`
      await put(pending)
      assert.equal((await put(answered)).status, 'answered', '较早时间的确认仍可推进状态')
      await sync({ ...pending, updatedAt: 1000 })
      assert.equal((await tx`select payload from pg_temp.agent_messages where id = ${pending.id}`)[0].payload.status, 'answered')
      const conflicting = { ...answered, updatedAt: 1001, question: { ...answered.question, fields: [{ id: 'resolution', defaultValue: '1K' }] } }
      await assert.rejects(() => tx.savepoint((nested) => put(conflicting, actor, true, nested)), { code: '23514', message: 'AGENT_MESSAGE_ANSWER_CONFLICT' })
      await assert.rejects(() => tx.savepoint((nested) => sync(conflicting, nested)), { code: '23514', message: 'AGENT_MESSAGE_ANSWER_CONFLICT' })
      await put({ ...pending, updatedAt: 1002, question: { ...pending.question, id: 'next-question' } })
      await assert.rejects(() => tx.savepoint((nested) => put({ ...answered, updatedAt: 9000 }, actor, true, nested)), { code: '23514', message: 'AGENT_MESSAGE_ANSWER_CONFLICT' })
      await assert.rejects(() => tx.savepoint((nested) => sync({ ...answered, updatedAt: 9000 }, nested)), { code: '23514', message: 'AGENT_MESSAGE_ANSWER_CONFLICT' })
      await assert.rejects(() => tx.savepoint((nested) => put(answered, viewer, true, nested)), { code: '42501' })
      await assert.rejects(() => tx.savepoint((nested) => put(answered, actor, false, nested)), { code: '22023' })
      const functions = ['pg_temp.botanic_put_agent_message(uuid,text,text,jsonb,timestamptz,boolean,boolean)', 'pg_temp.botanic_sync_agent_entities(uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,boolean,boolean,boolean,boolean)']
      for (const signature of functions) {
        const [rights] = await tx`select has_function_privilege('anon', ${signature}, 'execute') as anon, has_function_privilege('authenticated', ${signature}, 'execute') as authenticated, has_function_privilege('service_role', ${signature}, 'execute') as service`
        assert.deepEqual(rights, { anon: false, authenticated: false, service: true })
      }
      // 临时角色也随事务回滚；测试不留下共享角色或数据库对象。
      throw rollback
    }), (error) => error === rollback)
  } finally { await sql.end() }
})
