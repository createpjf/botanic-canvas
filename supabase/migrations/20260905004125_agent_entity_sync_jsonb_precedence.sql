begin;

-- 完整 Message 同步 RPC 回归暴露了两处 PostgreSQL 运算符优先级错误。
-- 仅给 JSON 提取结果加括号；保持原子锁、权限、正文合并和 provenance 保护不变。
-- 不修改已经发布的历史迁移；CREATE OR REPLACE 保留同签名调用方。

create or replace function public.botanic_sync_agent_entities(
  p_owner_id uuid,
  p_project_id text,
  p_sessions jsonb,
  p_messages jsonb,
  p_memory jsonb,
  p_runs jsonb,
  p_deleted_memory jsonb,
  p_preserve_thread_summary boolean
)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if p_preserve_thread_summary is distinct from true then
    raise exception 'derived field preservation capability required' using errcode = '22023';
  end if;

  -- 可能缺失的首次创建也必须串行化。按稳定 key 排序取锁避免批量间死锁。
  perform pg_advisory_xact_lock(hashtextextended(lock_key, 0))
  from (
    select 'agent-session:' || (item->>'id') as lock_key
    from jsonb_array_elements(coalesce(p_sessions, '[]'::jsonb)) as item
    union
    select 'agent-message:' || (item->>'id') as lock_key
    from jsonb_array_elements(coalesce(p_messages, '[]'::jsonb)) as item
  ) as locks
  where nullif(lock_key, '') is not null
  order by lock_key;

  if exists (
    select 1
    from public.agent_sessions existing
    join jsonb_to_recordset(coalesce(p_sessions, '[]'::jsonb))
      as incoming(id text, project_id text)
      on incoming.id = existing.id
    where existing.project_id <> p_project_id or incoming.project_id <> p_project_id
  ) then
    raise exception 'Agent session id belongs to another project' using errcode = '23505';
  end if;

  if exists (
    select 1
    from public.agent_messages existing
    join jsonb_to_recordset(coalesce(p_messages, '[]'::jsonb))
      as incoming(id text, project_id text, session_id text)
      on incoming.id = existing.id
    where existing.project_id <> p_project_id
      or incoming.project_id <> p_project_id
      or existing.session_id <> incoming.session_id
  ) then
    raise exception 'Agent message id belongs to another project or session' using errcode = '23505';
  end if;

  if exists (
    select 1
    from public.agent_messages existing
    join jsonb_to_recordset(coalesce(p_messages, '[]'::jsonb))
      as incoming(id text, payload jsonb)
      on incoming.id = existing.id
    where existing.payload ? 'turnId'
      and incoming.payload ? 'turnId'
      and existing.payload->>'turnId' is distinct from incoming.payload->>'turnId'
  ) then
    raise exception 'AGENT_MESSAGE_TURN_ID_CONFLICT' using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.agent_messages existing
    join jsonb_to_recordset(coalesce(p_messages, '[]'::jsonb))
      as incoming(id text, payload jsonb)
      on incoming.id = existing.id
    where existing.payload ? 'role'
      and incoming.payload ? 'role'
      and existing.payload->>'role' is distinct from incoming.payload->>'role'
  ) then
    raise exception 'AGENT_MESSAGE_ROLE_CONFLICT' using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.agent_messages existing
    join jsonb_to_recordset(coalesce(p_messages, '[]'::jsonb))
      as incoming(id text, payload jsonb)
      on incoming.id = existing.id
    where (existing.payload ? 'turnRequestSnapshot' or incoming.payload ? 'turnRequestSnapshot')
      and (
        existing.payload->>'kind' is distinct from incoming.payload->>'kind'
        or existing.payload->>'content' is distinct from incoming.payload->>'content'
        or existing.payload->'mentions' is distinct from incoming.payload->'mentions'
        or existing.payload->'createdAt' is distinct from incoming.payload->'createdAt'
      )
  ) then
    raise exception 'AGENT_MESSAGE_TURN_REQUEST_CONFLICT' using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.agent_messages existing
    join jsonb_to_recordset(coalesce(p_messages, '[]'::jsonb))
      as incoming(id text, payload jsonb)
      on incoming.id = existing.id
    where existing.payload ? 'turnRequestSnapshot'
      and incoming.payload ? 'turnRequestSnapshot'
      and existing.payload->'turnRequestSnapshot' is distinct from incoming.payload->'turnRequestSnapshot'
  ) then
    raise exception 'AGENT_MESSAGE_TURN_REQUEST_CONFLICT' using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.agent_memory_items existing
    join jsonb_to_recordset(coalesce(p_memory, '[]'::jsonb))
      as incoming(id text, project_id text)
      on incoming.id = existing.id
    where existing.project_id <> p_project_id or incoming.project_id <> p_project_id
  ) then
    raise exception 'Agent memory id belongs to another project' using errcode = '23505';
  end if;

  if exists (
    select 1
    from public.agent_runs existing
    join jsonb_to_recordset(coalesce(p_runs, '[]'::jsonb))
      as incoming(id text, project_id text)
      on incoming.id = existing.id
    where existing.project_id <> p_project_id or incoming.project_id <> p_project_id
  ) then
    raise exception 'Agent run id belongs to another project' using errcode = '23505';
  end if;

  insert into public.agent_sessions (id, owner_id, project_id, updated_at, payload)
  select incoming.id, p_owner_id, p_project_id, incoming.updated_at, incoming.payload
  from jsonb_to_recordset(coalesce(p_sessions, '[]'::jsonb))
    as incoming(id text, project_id text, updated_at timestamptz, payload jsonb)
  on conflict (id) do update set
    updated_at = excluded.updated_at,
    payload = case
      when agent_sessions.payload ? 'threadSummary'
        then jsonb_set(excluded.payload, '{threadSummary}', agent_sessions.payload->'threadSummary', true)
      else excluded.payload
    end
  where agent_sessions.project_id = excluded.project_id
    and agent_sessions.updated_at <= excluded.updated_at;

  insert into public.agent_messages (id, owner_id, project_id, session_id, updated_at, payload)
  select incoming.id, p_owner_id, p_project_id, incoming.session_id, incoming.updated_at,
    public.botanic_merge_agent_message_sticky_fields(null, incoming.payload, true)
  from jsonb_to_recordset(coalesce(p_messages, '[]'::jsonb))
    as incoming(id text, project_id text, session_id text, updated_at timestamptz, payload jsonb)
  on conflict (id) do update set
    updated_at = greatest(agent_messages.updated_at, excluded.updated_at),
    payload = public.botanic_merge_agent_message_sticky_fields(
      agent_messages.payload,
      excluded.payload,
      agent_messages.updated_at < excluded.updated_at
    )
  where agent_messages.project_id = excluded.project_id
    and agent_messages.session_id = excluded.session_id;

  update public.agent_memory_items existing
  set deleted_at = incoming.deleted_at,
      updated_at = incoming.deleted_at
  from jsonb_to_recordset(coalesce(p_deleted_memory, '[]'::jsonb))
    as incoming(id text, deleted_at timestamptz)
  where existing.id = incoming.id
    and existing.project_id = p_project_id
    and existing.updated_at <= incoming.deleted_at;

  insert into public.agent_memory_items (id, owner_id, project_id, updated_at, deleted_at, payload)
  select incoming.id, p_owner_id, p_project_id, incoming.updated_at, null, incoming.payload
  from jsonb_to_recordset(coalesce(p_memory, '[]'::jsonb))
    as incoming(id text, project_id text, updated_at timestamptz, payload jsonb)
  on conflict (id) do update set
    updated_at = excluded.updated_at,
    deleted_at = null,
    payload = excluded.payload
  where agent_memory_items.project_id = excluded.project_id
    and (
      agent_memory_items.updated_at < excluded.updated_at
      or (
        agent_memory_items.updated_at = excluded.updated_at
        and agent_memory_items.deleted_at is null
      )
    );

  insert into public.agent_runs (id, owner_id, project_id, status, updated_at, payload)
  select incoming.id, p_owner_id, p_project_id, incoming.status, incoming.updated_at, incoming.payload
  from jsonb_to_recordset(coalesce(p_runs, '[]'::jsonb))
    as incoming(id text, project_id text, status text, updated_at timestamptz, payload jsonb)
  on conflict (id) do nothing;
end;
$$;

create or replace function public.botanic_sync_agent_entities(
  p_owner_id uuid,
  p_project_id text,
  p_sessions jsonb,
  p_messages jsonb,
  p_memory jsonb,
  p_runs jsonb,
  p_deleted_memory jsonb,
  p_preserve_thread_summary boolean,
  p_preserve_entity_references boolean,
  p_insert_sessions_only boolean
)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  bound_messages jsonb;
  authoritative_messages jsonb;
begin
  if p_preserve_thread_summary is distinct from true
    or p_preserve_entity_references is distinct from true
    or p_insert_sessions_only is distinct from true then
    raise exception 'Agent entity sync capabilities required' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('agent-session:' || incoming.id, 0))
  from jsonb_to_recordset(coalesce(p_sessions, '[]'::jsonb)) as incoming(id text)
  where nullif(incoming.id, '') is not null
  order by incoming.id;

  if exists (
    select 1
    from public.agent_sessions existing
    join jsonb_to_recordset(coalesce(p_sessions, '[]'::jsonb))
      as incoming(id text, project_id text)
      on incoming.id = existing.id
    where existing.project_id <> p_project_id or incoming.project_id <> p_project_id
  ) then
    raise exception 'Agent session id belongs to another project' using errcode = '23505';
  end if;

  insert into public.agent_sessions (id, owner_id, project_id, updated_at, payload)
  select incoming.id, p_owner_id, p_project_id, incoming.updated_at, incoming.payload
  from jsonb_to_recordset(coalesce(p_sessions, '[]'::jsonb))
    as incoming(id text, project_id text, updated_at timestamptz, payload jsonb)
  on conflict (id) do nothing;

  -- targetBinding 由 Message HTTP 入口按项目媒体字节生成；CanvasDocument 只能遗漏，
  -- 不能首次写入或改绑。旧客户端重放无 binding 的同一 snapshot 时补回当前权威值。
  select coalesce(jsonb_agg(
    case
      when jsonb_typeof(incoming.value->'payload'->'turnRequestSnapshot') = 'object' then
        jsonb_set(
          incoming.value,
          '{payload,turnRequestSnapshot}',
          case
            when existing.payload #> '{turnRequestSnapshot,targetBinding}' is not null then
              jsonb_set(
                incoming.value->'payload'->'turnRequestSnapshot',
                '{targetBinding}',
                existing.payload #> '{turnRequestSnapshot,targetBinding}',
                true
              )
            else (incoming.value->'payload'->'turnRequestSnapshot') - 'targetBinding'
          end,
          true
        )
      else incoming.value
    end
    order by incoming.ordinality
  ), '[]'::jsonb)
  into bound_messages
  from jsonb_array_elements(coalesce(p_messages, '[]'::jsonb)) with ordinality as incoming(value, ordinality)
  left join public.agent_messages existing
    on existing.id = incoming.value->>'id' and existing.project_id = p_project_id;

  -- Assistant provenance 与 entityReferences 一样只由独立 Message HTTP 入口绑定。
  -- CanvasDocument 重放只能保留已存在值，不能首次伪造或用旧正文清空。
  select coalesce(jsonb_agg(
    jsonb_set(
      incoming.value,
      '{payload}',
      (
        (incoming.value->'payload')
        - 'sourceMessageId' - 'sourceNodeIds' - 'targetArtifactVersionId' - 'planFingerprint'
      ) || jsonb_strip_nulls(jsonb_build_object(
        'sourceMessageId', existing.payload->'sourceMessageId',
        'sourceNodeIds', existing.payload->'sourceNodeIds',
        'targetArtifactVersionId', existing.payload->'targetArtifactVersionId',
        'planFingerprint', existing.payload->'planFingerprint'
      )),
      true
    )
    order by incoming.ordinality
  ), '[]'::jsonb)
  into authoritative_messages
  from jsonb_array_elements(bound_messages) with ordinality as incoming(value, ordinality)
  left join public.agent_messages existing
    on existing.id = incoming.value->>'id' and existing.project_id = p_project_id;

  perform public.botanic_sync_agent_entities(
    p_owner_id,
    p_project_id,
    '[]'::jsonb,
    authoritative_messages,
    p_memory,
    p_runs,
    p_deleted_memory,
    true,
    true
  );
end;
$$;

revoke all on function public.botanic_sync_agent_entities(uuid, text, jsonb, jsonb, jsonb, jsonb, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.botanic_sync_agent_entities(uuid, text, jsonb, jsonb, jsonb, jsonb, jsonb, boolean) to service_role;
revoke all on function public.botanic_sync_agent_entities(uuid, text, jsonb, jsonb, jsonb, jsonb, jsonb, boolean, boolean, boolean) from public, anon, authenticated;
grant execute on function public.botanic_sync_agent_entities(uuid, text, jsonb, jsonb, jsonb, jsonb, jsonb, boolean, boolean, boolean) to service_role;
notify pgrst, 'reload schema';
commit;
