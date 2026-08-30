begin;

-- Session 设置与 Message/CanvasDocument 解耦：只有显式 CAS 可修改已存在的 Session。
create or replace function public.botanic_compare_and_set_agent_session_settings(
  p_actor_id uuid,
  p_project_id text,
  p_session_id text,
  p_expected_revision bigint,
  p_changes jsonb,
  p_created_at bigint
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  existing public.agent_sessions%rowtype;
  member_role public.botanic_project_role;
  current_revision bigint;
  next_revision bigint;
  now_ms bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  stored_payload jsonb;
  normalized_current jsonb;
  normalized_next jsonb;
  was_created boolean;
begin
  if p_actor_id is null
    or nullif(btrim(p_project_id), '') is null
    or nullif(btrim(p_session_id), '') is null
    or p_expected_revision is null or p_expected_revision < 0
    or jsonb_typeof(p_changes) is distinct from 'object'
    or p_created_at is null or p_created_at < 0
    or (p_changes - array[
      'title', 'executionMode', 'confirmationWaivers', 'plannerModel',
      'mountedSkillIds', 'contextNodeIds'
    ]::text[]) <> '{}'::jsonb then
    raise exception 'invalid Agent Session settings command' using errcode = '22023';
  end if;

  if p_changes ? 'title' and (
    jsonb_typeof(p_changes->'title') is distinct from 'string'
    or length(btrim(p_changes->>'title')) = 0
    or length(p_changes->>'title') > 160
  ) then
    raise exception 'invalid Agent Session title' using errcode = '22023';
  end if;
  if p_changes ? 'executionMode' and coalesce(p_changes->>'executionMode', '') not in ('manual', 'auto') then
    raise exception 'invalid Agent Session execution mode' using errcode = '22023';
  end if;
  if p_changes ? 'plannerModel'
    and jsonb_typeof(p_changes->'plannerModel') not in ('string', 'null') then
    raise exception 'invalid Agent Session planner model' using errcode = '22023';
  end if;
  if p_changes ? 'plannerModel'
    and jsonb_typeof(p_changes->'plannerModel') = 'string'
    and (length(btrim(p_changes->>'plannerModel')) = 0 or length(p_changes->>'plannerModel') > 160) then
    raise exception 'invalid Agent Session planner model' using errcode = '22023';
  end if;
  if p_changes ? 'confirmationWaivers' and (
    jsonb_typeof(p_changes->'confirmationWaivers') is distinct from 'array'
    or jsonb_array_length(p_changes->'confirmationWaivers') > 2
    or exists (
      select 1 from jsonb_array_elements_text(p_changes->'confirmationWaivers') as waiver(value)
      where waiver.value not in ('manual', 'batch_count')
    )
  ) then
    raise exception 'invalid Agent Session confirmation waivers' using errcode = '22023';
  end if;
  if p_changes ? 'mountedSkillIds' and (
    jsonb_typeof(p_changes->'mountedSkillIds') is distinct from 'array'
    or jsonb_array_length(p_changes->'mountedSkillIds') > 16
  ) then
    raise exception 'invalid Agent Session skills' using errcode = '22023';
  end if;
  if p_changes ? 'contextNodeIds' and (
    jsonb_typeof(p_changes->'contextNodeIds') is distinct from 'array'
    or jsonb_array_length(p_changes->'contextNodeIds') > 32
  ) then
    raise exception 'invalid Agent Session context' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('agent-session:' || p_session_id, 0));
  select * into existing from public.agent_sessions where id = p_session_id for update;
  if existing.id is not null and existing.project_id <> p_project_id then
    raise exception 'Agent session id belongs to another project' using errcode = '23505';
  end if;

  select member.role into member_role
  from public.project_members as member
  where member.project_id = p_project_id and member.user_id = p_actor_id
  for share;
  if member_role is null or member_role not in ('owner', 'editor') then
    raise exception 'Agent Session write forbidden' using errcode = '42501';
  end if;

  was_created := existing.id is null;
  current_revision := case
    when existing.payload->>'revision' ~ '^\d+$' then (existing.payload->>'revision')::bigint
    else 0
  end;
  stored_payload := coalesce(existing.payload, jsonb_build_object(
    'id', p_session_id,
    'title', '新建对话',
    'executionMode', 'manual',
    'contextNodeIds', '[]'::jsonb,
    'revision', 0,
    'createdAt', p_created_at,
    'updatedAt', greatest(p_created_at, now_ms)
  )) || p_changes;
  if p_changes ? 'plannerModel' and jsonb_typeof(p_changes->'plannerModel') = 'null' then
    stored_payload := stored_payload - 'plannerModel';
  end if;

  normalized_next := jsonb_build_object(
    'title', stored_payload->'title',
    'executionMode', stored_payload->'executionMode',
    'confirmationWaivers', coalesce(stored_payload->'confirmationWaivers', '[]'::jsonb),
    'plannerModel', coalesce(stored_payload->'plannerModel', 'null'::jsonb),
    'mountedSkillIds', coalesce(stored_payload->'mountedSkillIds', '[]'::jsonb),
    'contextNodeIds', coalesce(stored_payload->'contextNodeIds', '[]'::jsonb)
  );
  if existing.id is not null then
    normalized_current := jsonb_build_object(
      'title', existing.payload->'title',
      'executionMode', existing.payload->'executionMode',
      'confirmationWaivers', coalesce(existing.payload->'confirmationWaivers', '[]'::jsonb),
      'plannerModel', coalesce(existing.payload->'plannerModel', 'null'::jsonb),
      'mountedSkillIds', coalesce(existing.payload->'mountedSkillIds', '[]'::jsonb),
      'contextNodeIds', coalesce(existing.payload->'contextNodeIds', '[]'::jsonb)
    );
    if normalized_next = normalized_current then
      return jsonb_build_object('kind', 'replayed', 'changed', false, 'session', existing.payload);
    end if;
  end if;

  if p_expected_revision <> current_revision then
    return jsonb_build_object(
      'kind', 'conflict', 'changed', false,
      'session', case when existing.id is null then null else existing.payload end
    );
  end if;

  next_revision := current_revision + 1;
  stored_payload := jsonb_set(stored_payload, '{revision}', to_jsonb(next_revision), true);
  stored_payload := jsonb_set(stored_payload, '{updatedAt}', to_jsonb(greatest(p_created_at, now_ms)), true);
  insert into public.agent_sessions (id, owner_id, project_id, updated_at, payload)
  values (
    p_session_id, p_actor_id, p_project_id,
    to_timestamp(greatest(p_created_at, now_ms)::double precision / 1000.0), stored_payload
  )
  on conflict (id) do update set
    updated_at = excluded.updated_at,
    payload = excluded.payload
  where agent_sessions.project_id = excluded.project_id;

  return jsonb_build_object(
    'kind', case when was_created then 'created' else 'updated' end,
    'changed', true,
    'session', stored_payload
  );
end;
$$;

-- 第十个能力标记把 CanvasDocument Session 同步收紧为 insert-only。
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
        incoming.value->'payload'
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

revoke all on function public.botanic_compare_and_set_agent_session_settings(uuid, text, text, bigint, jsonb, bigint)
from public, anon, authenticated;
grant execute on function public.botanic_compare_and_set_agent_session_settings(uuid, text, text, bigint, jsonb, bigint)
to service_role;

revoke all on function public.botanic_sync_agent_entities(uuid, text, jsonb, jsonb, jsonb, jsonb, jsonb, boolean, boolean, boolean)
from public, anon, authenticated;
grant execute on function public.botanic_sync_agent_entities(uuid, text, jsonb, jsonb, jsonb, jsonb, jsonb, boolean, boolean, boolean)
to service_role;

commit;
