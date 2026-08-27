begin;

-- Session 普通写入不拥有 Thread Summary。咨询锁覆盖「尚无行」的首次创建，
-- 行已存在时则无条件保留当前派生摘要，不信任调用方携带的快照。
create or replace function public.botanic_put_agent_session(
  p_actor_id uuid,
  p_project_id text,
  p_session jsonb,
  p_updated_at timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  session_id text;
  existing public.agent_sessions%rowtype;
  member_role public.botanic_project_role;
  stored_payload jsonb;
  was_created boolean;
begin
  session_id := nullif(btrim(p_session->>'id'), '');
  if p_actor_id is null
    or nullif(btrim(p_project_id), '') is null
    or session_id is null
    or jsonb_typeof(p_session) is distinct from 'object'
    or p_updated_at is null then
    raise exception 'invalid Agent Session payload' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('agent-session:' || session_id, 0));
  select * into existing
  from public.agent_sessions
  where id = session_id
  for update;
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
  stored_payload := p_session;
  if existing.id is not null and existing.payload ? 'threadSummary' then
    stored_payload := jsonb_set(
      stored_payload,
      '{threadSummary}',
      existing.payload->'threadSummary',
      true
    );
  end if;

  insert into public.agent_sessions (id, owner_id, project_id, updated_at, payload)
  values (session_id, p_actor_id, p_project_id, p_updated_at, stored_payload)
  on conflict (id) do update set
    updated_at = excluded.updated_at,
    payload = excluded.payload
  where agent_sessions.project_id = excluded.project_id;

  return jsonb_build_object('created', was_created, 'payload', stored_payload);
end;
$$;

-- Message 正文生命周期与三个服务端控制字段共用一个原子合并器：
-- 1. turnId 可首次绑定，不可清空或改绑。
-- 2. turnCancellationRequestedAt 一旦存在不可撤回，并保留所有有效值中最早的时间。
-- 3. turnRequestSnapshot 可首次绑定，旧 writer 遗漏时保留，改绑时 fail-closed。
-- 4. 稳定 Turn 投影的 failed 终态压过 answered/submitted，不信任客户端时钟。
-- 5. role 是作者身份、不可改绑；createdAt 首次绑定后保留。
-- 6. 快照首次绑定前须与当前请求正文一致；绑定后 kind/content/mentions/createdAt 不可漂移。
create or replace function public.botanic_merge_agent_message_sticky_fields(
  p_current jsonb,
  p_incoming jsonb,
  p_apply_body boolean
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = public, pg_temp
as $$
declare
  merged jsonb;
  apply_body boolean;
  effective_turn_id text;
  current_status text;
  incoming_status text;
  is_turn_projection boolean;
  current_cancel numeric;
  incoming_cancel numeric;
  earliest_cancel numeric;
  current_message_updated_at numeric;
  incoming_message_updated_at numeric;
begin
  if jsonb_typeof(p_incoming) is distinct from 'object'
    or p_apply_body is null then
    raise exception 'invalid Agent Message payload' using errcode = '22023';
  end if;

  apply_body := p_apply_body;
  if p_current ? 'turnId' then
    if p_incoming ? 'turnId'
      and p_current->>'turnId' is distinct from p_incoming->>'turnId' then
      raise exception 'AGENT_MESSAGE_TURN_ID_CONFLICT' using errcode = '23514';
    end if;
  end if;
  if p_current ? 'role'
    and p_incoming ? 'role'
    and p_current->>'role' is distinct from p_incoming->>'role' then
    raise exception 'AGENT_MESSAGE_ROLE_CONFLICT' using errcode = '23514';
  end if;
  if jsonb_typeof(p_current) = 'object'
    and (p_current ? 'turnRequestSnapshot' or p_incoming ? 'turnRequestSnapshot')
    and (
      p_current->>'kind' is distinct from p_incoming->>'kind'
      or p_current->>'content' is distinct from p_incoming->>'content'
      or p_current->'mentions' is distinct from p_incoming->'mentions'
      or p_current->'createdAt' is distinct from p_incoming->'createdAt'
    ) then
    raise exception 'AGENT_MESSAGE_TURN_REQUEST_CONFLICT' using errcode = '23514';
  end if;

  effective_turn_id := coalesce(nullif(p_current->>'turnId', ''), nullif(p_incoming->>'turnId', ''));
  current_status := p_current->>'status';
  incoming_status := p_incoming->>'status';
  is_turn_projection := effective_turn_id is not null
    and coalesce(p_current->>'id', p_incoming->>'id') = 'agent-turn-result-' || effective_turn_id
    and coalesce(p_current->>'role', p_incoming->>'role') = 'assistant'
    and coalesce(p_incoming->>'role', p_current->>'role') = 'assistant';
  if is_turn_projection then
    if current_status = 'failed' and incoming_status is distinct from 'failed' then
      apply_body := false;
    elsif incoming_status = 'failed' and current_status is distinct from 'failed' then
      apply_body := true;
    end if;
  end if;

  -- 普通正文遵循 updated_at LWW；终态与 sticky 字段不受正文新旧影响。
  merged := (case
    when apply_body or jsonb_typeof(p_current) is distinct from 'object' then p_incoming
    else p_current
  end) - 'role' - 'createdAt' - 'turnCancellationRequestedAt' - 'turnRequestSnapshot';
  if p_current ? 'role' then
    merged := jsonb_set(merged, '{role}', p_current->'role', true);
  elsif p_incoming ? 'role' then
    merged := jsonb_set(merged, '{role}', p_incoming->'role', true);
  end if;
  if p_current ? 'createdAt' then
    merged := jsonb_set(merged, '{createdAt}', p_current->'createdAt', true);
  elsif p_incoming ? 'createdAt' then
    merged := jsonb_set(merged, '{createdAt}', p_incoming->'createdAt', true);
  end if;
  if p_current ? 'turnId' then
    merged := jsonb_set(merged, '{turnId}', p_current->'turnId', true);
  elsif p_incoming ? 'turnId' then
    merged := jsonb_set(merged, '{turnId}', p_incoming->'turnId', true);
  end if;

  if p_current ? 'turnRequestSnapshot' then
    if p_incoming ? 'turnRequestSnapshot'
      and p_current->'turnRequestSnapshot' is distinct from p_incoming->'turnRequestSnapshot' then
      raise exception 'AGENT_MESSAGE_TURN_REQUEST_CONFLICT' using errcode = '23514';
    end if;
    merged := jsonb_set(merged, '{turnRequestSnapshot}', p_current->'turnRequestSnapshot', true);
  elsif p_incoming ? 'turnRequestSnapshot' then
    merged := jsonb_set(merged, '{turnRequestSnapshot}', p_incoming->'turnRequestSnapshot', true);
  end if;

  if jsonb_typeof(p_current->'turnCancellationRequestedAt') = 'number' then
    current_cancel := (p_current->>'turnCancellationRequestedAt')::numeric;
    if current_cancel < 0
      or current_cancel <> trunc(current_cancel)
      or current_cancel > 9007199254740991 then
      current_cancel := null;
    end if;
  end if;
  if jsonb_typeof(p_incoming->'turnCancellationRequestedAt') = 'number' then
    incoming_cancel := (p_incoming->>'turnCancellationRequestedAt')::numeric;
    if incoming_cancel < 0
      or incoming_cancel <> trunc(incoming_cancel)
      or incoming_cancel > 9007199254740991 then
      incoming_cancel := null;
    end if;
  end if;

  if current_cancel is not null and incoming_cancel is not null then
    earliest_cancel := least(current_cancel, incoming_cancel);
  else
    earliest_cancel := coalesce(current_cancel, incoming_cancel);
  end if;
  if earliest_cancel is not null then
    merged := jsonb_set(
      merged,
      '{turnCancellationRequestedAt}',
      to_jsonb(earliest_cancel::bigint),
      true
    );
  end if;

  if jsonb_typeof(p_current->'updatedAt') = 'number' then
    current_message_updated_at := (p_current->>'updatedAt')::numeric;
    if current_message_updated_at < 0 then current_message_updated_at := null; end if;
  end if;
  if jsonb_typeof(p_incoming->'updatedAt') = 'number' then
    incoming_message_updated_at := (p_incoming->>'updatedAt')::numeric;
    if incoming_message_updated_at < 0 then incoming_message_updated_at := null; end if;
  end if;
  if current_message_updated_at is not null or incoming_message_updated_at is not null then
    merged := jsonb_set(
      merged,
      '{updatedAt}',
      to_jsonb(greatest(coalesce(current_message_updated_at, 0), coalesce(incoming_message_updated_at, 0))),
      true
    );
  end if;
  return merged;
end;
$$;

-- 保留两参数签名供滚动发布中的旧数据库函数安全转发。
create or replace function public.botanic_merge_agent_message_sticky_fields(
  p_current jsonb,
  p_incoming jsonb
)
returns jsonb
language sql
immutable
security invoker
set search_path = public, pg_temp
as $$
  select public.botanic_merge_agent_message_sticky_fields(p_current, p_incoming, true);
$$;

-- Message 与 Session.updatedAt 在同一事务内写入，Session 只 patch 时间字段。
create or replace function public.botanic_put_agent_message(
  p_actor_id uuid,
  p_project_id text,
  p_session_id text,
  p_message jsonb,
  p_updated_at timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  message_id text;
  session_row public.agent_sessions%rowtype;
  existing public.agent_messages%rowtype;
  member_role public.botanic_project_role;
  stored_payload jsonb;
  stored_updated_at timestamptz;
  session_updated_at timestamptz;
  was_created boolean;
  updated_at_millis bigint;
begin
  message_id := nullif(btrim(p_message->>'id'), '');
  if p_actor_id is null
    or nullif(btrim(p_project_id), '') is null
    or nullif(btrim(p_session_id), '') is null
    or message_id is null
    or jsonb_typeof(p_message) is distinct from 'object'
    or p_updated_at is null then
    raise exception 'invalid Agent Message payload' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('agent-message:' || message_id, 0));
  select * into session_row
  from public.agent_sessions
  where id = p_session_id and project_id = p_project_id
  for update;
  if session_row.id is null then
    raise exception 'Agent Session not found' using errcode = '23503';
  end if;

  select member.role into member_role
  from public.project_members as member
  where member.project_id = p_project_id and member.user_id = p_actor_id
  for share;
  if member_role is null or member_role not in ('owner', 'editor') then
    raise exception 'Agent Message write forbidden' using errcode = '42501';
  end if;

  select * into existing
  from public.agent_messages
  where id = message_id
  for update;
  if existing.id is not null
    and (existing.project_id <> p_project_id or existing.session_id <> p_session_id) then
    raise exception 'Agent message id belongs to another project or session' using errcode = '23505';
  end if;
  was_created := existing.id is null;
  stored_payload := public.botanic_merge_agent_message_sticky_fields(
    existing.payload,
    p_message,
    existing.id is null or existing.updated_at < p_updated_at
  );
  stored_updated_at := case
    when existing.id is null then p_updated_at
    else greatest(existing.updated_at, p_updated_at)
  end;

  insert into public.agent_messages (id, owner_id, project_id, session_id, updated_at, payload)
  values (message_id, p_actor_id, p_project_id, p_session_id, stored_updated_at, stored_payload)
  on conflict (id) do update set
    updated_at = excluded.updated_at,
    payload = excluded.payload
  where agent_messages.project_id = excluded.project_id
    and agent_messages.session_id = excluded.session_id;

  session_updated_at := greatest(session_row.updated_at, stored_updated_at);
  updated_at_millis := floor(extract(epoch from session_updated_at) * 1000)::bigint;
  update public.agent_sessions
  set updated_at = session_updated_at,
      payload = jsonb_set(payload, '{updatedAt}', to_jsonb(updated_at_millis), true)
  where id = p_session_id and project_id = p_project_id;

  return jsonb_build_object('created', was_created, 'payload', stored_payload);
end;
$$;

-- 新的第八参数是能力标记。Adapter 总是传 true；若未部署本迁移，PostgREST
-- 无法将请求误路由到历史七参数 RPC，从而 fail-closed。
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
    select 'agent-session:' || item->>'id' as lock_key
    from jsonb_array_elements(coalesce(p_sessions, '[]'::jsonb)) as item
    union
    select 'agent-message:' || item->>'id' as lock_key
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

-- 滚动发布期间旧 Worker 仍可能调用七参数签名；将它改为安全转发，
-- 避免已部署迁移却被旧实例覆盖派生字段。新 Adapter 仍只调八参数签名以 fail-closed。
create or replace function public.botanic_sync_agent_entities(
  p_owner_id uuid,
  p_project_id text,
  p_sessions jsonb,
  p_messages jsonb,
  p_memory jsonb,
  p_runs jsonb,
  p_deleted_memory jsonb
)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  perform public.botanic_sync_agent_entities(
    p_owner_id,
    p_project_id,
    p_sessions,
    p_messages,
    p_memory,
    p_runs,
    p_deleted_memory,
    true
  );
end;
$$;

-- Thread Summary 是服务端 compactor 的派生缓存。只能在当前摘要版本仍与读取快照
-- 一致时替换 payload.threadSummary；Session 主 updated_at 与其它 payload 字段不动。
create or replace function public.botanic_compare_and_set_agent_thread_summary(
  p_actor_id uuid,
  p_session_id text,
  p_expected_updated_at bigint,
  p_summary jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  existing public.agent_sessions%rowtype;
  member_role public.botanic_project_role;
  current_summary jsonb;
  current_updated_at bigint;
  current_numeric numeric;
  candidate_numeric numeric;
  stored_payload jsonb;
begin
  if p_actor_id is null
    or nullif(btrim(p_session_id), '') is null
    or jsonb_typeof(p_summary) is distinct from 'object'
    or jsonb_typeof(p_summary->'updatedAt') is distinct from 'number'
    or p_expected_updated_at < 0
    or p_expected_updated_at > 9007199254740991 then
    raise exception 'invalid Agent Thread Summary CAS command' using errcode = '22023';
  end if;

  candidate_numeric := (p_summary->>'updatedAt')::numeric;
  if candidate_numeric < 0
    or candidate_numeric <> trunc(candidate_numeric)
    or candidate_numeric > 9007199254740991
    or (p_expected_updated_at is not null and candidate_numeric <= p_expected_updated_at) then
    raise exception 'invalid Agent Thread Summary CAS version' using errcode = '22023';
  end if;

  select * into existing
  from public.agent_sessions
  where id = p_session_id
  for update;
  if existing.id is null or existing.payload->>'id' is distinct from p_session_id then
    return jsonb_build_object('kind', 'not_found', 'changed', false);
  end if;

  select member.role into member_role
  from public.project_members as member
  where member.project_id = existing.project_id and member.user_id = p_actor_id
  for share;
  if member_role is null or member_role not in ('owner', 'editor') then
    raise exception 'Agent Thread Summary CAS forbidden' using errcode = '42501';
  end if;

  current_summary := existing.payload->'threadSummary';
  if current_summary is null or jsonb_typeof(current_summary) = 'null' then
    current_updated_at := null;
  elsif jsonb_typeof(current_summary) is distinct from 'object'
    or jsonb_typeof(current_summary->'updatedAt') is distinct from 'number' then
    return jsonb_build_object(
      'kind', 'invalid',
      'changed', false,
      'session', existing.payload
    );
  else
    current_numeric := (current_summary->>'updatedAt')::numeric;
    if current_numeric < 0
      or current_numeric <> trunc(current_numeric)
      or current_numeric > 9007199254740991 then
      return jsonb_build_object(
        'kind', 'invalid',
        'changed', false,
        'session', existing.payload
      );
    end if;
    current_updated_at := current_numeric::bigint;
  end if;

  if current_updated_at is distinct from p_expected_updated_at then
    return jsonb_build_object(
      'kind', 'conflict',
      'changed', false,
      'session', existing.payload
    );
  end if;

  stored_payload := jsonb_set(existing.payload, '{threadSummary}', p_summary, true);
  update public.agent_sessions
  set payload = stored_payload
  where id = p_session_id;

  return jsonb_build_object(
    'kind', 'updated',
    'changed', true,
    'session', stored_payload
  );
end;
$$;

revoke all on function public.botanic_compare_and_set_agent_thread_summary(uuid, text, bigint, jsonb)
from public, anon, authenticated;
grant execute on function public.botanic_compare_and_set_agent_thread_summary(uuid, text, bigint, jsonb)
to service_role;

revoke all on function public.botanic_put_agent_session(uuid, text, jsonb, timestamptz)
from public, anon, authenticated;
grant execute on function public.botanic_put_agent_session(uuid, text, jsonb, timestamptz)
to service_role;

revoke all on function public.botanic_merge_agent_message_sticky_fields(jsonb, jsonb)
from public, anon, authenticated;
grant execute on function public.botanic_merge_agent_message_sticky_fields(jsonb, jsonb)
to service_role;

revoke all on function public.botanic_merge_agent_message_sticky_fields(jsonb, jsonb, boolean)
from public, anon, authenticated;
grant execute on function public.botanic_merge_agent_message_sticky_fields(jsonb, jsonb, boolean)
to service_role;

revoke all on function public.botanic_put_agent_message(uuid, text, text, jsonb, timestamptz)
from public, anon, authenticated;
grant execute on function public.botanic_put_agent_message(uuid, text, text, jsonb, timestamptz)
to service_role;

revoke all on function public.botanic_sync_agent_entities(uuid, text, jsonb, jsonb, jsonb, jsonb, jsonb, boolean)
from public, anon, authenticated;
grant execute on function public.botanic_sync_agent_entities(uuid, text, jsonb, jsonb, jsonb, jsonb, jsonb, boolean)
to service_role;

revoke all on function public.botanic_sync_agent_entities(uuid, text, jsonb, jsonb, jsonb, jsonb, jsonb)
from public, anon, authenticated;
grant execute on function public.botanic_sync_agent_entities(uuid, text, jsonb, jsonb, jsonb, jsonb, jsonb)
to service_role;

commit;
