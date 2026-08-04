-- 将 Railway/Postgres 的 Agent 实体 LWW 规则同步到 Supabase：
-- 1. Session / Message / Run 只接受更新或同时刻的幂等回放。
-- 2. Memory 的删除墓碑在同时刻胜出，防止旧画布复活已删记忆。
-- 3. 一次 RPC 在同一事务中合并，避免 REST 预读 + upsert 的 TOCTOU 竞态。

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

  -- 先写墓碑；后续同时戳的内容 upsert 不得将它复活。
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
  on conflict (id) do update set
    status = excluded.status,
    updated_at = excluded.updated_at,
    payload = excluded.payload
  where agent_runs.project_id = excluded.project_id
    and agent_runs.updated_at <= excluded.updated_at;
end;
$$;

revoke all on function public.botanic_sync_agent_entities(uuid, text, jsonb, jsonb, jsonb, jsonb, jsonb)
from public, anon, authenticated;
grant execute on function public.botanic_sync_agent_entities(uuid, text, jsonb, jsonb, jsonb, jsonb, jsonb)
to service_role;
