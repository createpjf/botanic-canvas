-- Agent Run 独立实体是执行状态权威：
-- 1. CanvasDocument 双写只迁移缺失 Run，不能更新已有实体。
-- 2. 显式 Run 写入使用原子 RPC，并拒绝旧快照及待确认状态回退。

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
    payload = excluded.payload
  where agent_sessions.project_id = excluded.project_id
    and agent_sessions.updated_at <= excluded.updated_at;

  insert into public.agent_messages (id, owner_id, project_id, session_id, updated_at, payload)
  select incoming.id, p_owner_id, p_project_id, incoming.session_id, incoming.updated_at, incoming.payload
  from jsonb_to_recordset(coalesce(p_messages, '[]'::jsonb))
    as incoming(id text, project_id text, session_id text, updated_at timestamptz, payload jsonb)
  on conflict (id) do update set
    updated_at = excluded.updated_at,
    payload = excluded.payload
  where agent_messages.project_id = excluded.project_id
    and agent_messages.session_id = excluded.session_id
    and agent_messages.updated_at <= excluded.updated_at;

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

revoke all on function public.botanic_sync_agent_entities(uuid, text, jsonb, jsonb, jsonb, jsonb, jsonb)
from public, anon, authenticated;
grant execute on function public.botanic_sync_agent_entities(uuid, text, jsonb, jsonb, jsonb, jsonb, jsonb)
to service_role;

create or replace function public.botanic_put_agent_run(
  p_owner_id uuid,
  p_run jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  incoming record;
  existing public.agent_runs%rowtype;
begin
  select * into incoming
  from jsonb_to_record(p_run)
    as value(id text, owner_id uuid, project_id text, status text, updated_at timestamptz, payload jsonb);

  if incoming.id is null
    or incoming.project_id is null
    or incoming.status is null
    or incoming.updated_at is null
    or incoming.owner_id is distinct from p_owner_id then
    raise exception 'Invalid Agent run payload' using errcode = '22023';
  end if;

  -- SELECT ... FOR UPDATE cannot lock a missing row. Serialize the first creator
  -- and all subsequent writers for the same run id before reading current state.
  perform pg_advisory_xact_lock(hashtextextended(incoming.id, 0));

  select * into existing from public.agent_runs where id = incoming.id for update;
  if existing.id is not null and (existing.project_id <> incoming.project_id or existing.owner_id <> p_owner_id) then
    raise exception 'Agent run id belongs to another project or owner' using errcode = '23505';
  end if;

  if existing.id is not null and (
    existing.updated_at > incoming.updated_at
    or (existing.status <> 'awaiting_confirmation' and incoming.status = 'awaiting_confirmation')
  ) then
    return existing.payload;
  end if;

  insert into public.agent_runs (id, owner_id, project_id, status, updated_at, payload)
  values (incoming.id, p_owner_id, incoming.project_id, incoming.status, incoming.updated_at, incoming.payload)
  on conflict (id) do update set
    status = excluded.status,
    updated_at = excluded.updated_at,
    payload = excluded.payload
  where agent_runs.project_id = excluded.project_id
    and agent_runs.owner_id = excluded.owner_id
    and agent_runs.updated_at <= excluded.updated_at
    and not (
      agent_runs.status <> 'awaiting_confirmation'
      and excluded.status = 'awaiting_confirmation'
    );

  select * into existing from public.agent_runs where id = incoming.id;
  if existing.project_id <> incoming.project_id or existing.owner_id <> p_owner_id then
    raise exception 'Agent run id belongs to another project or owner' using errcode = '23505';
  end if;
  return existing.payload;
end;
$$;

revoke all on function public.botanic_put_agent_run(uuid, jsonb)
from public, anon, authenticated;
grant execute on function public.botanic_put_agent_run(uuid, jsonb)
to service_role;
