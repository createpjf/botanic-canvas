begin;

-- Artifact Index 必须在数据库内比较 updated_at；应用层 read-then-upsert 会让迟到旧写覆盖新血缘。
create or replace function public.botanic_upsert_agent_artifacts_monotonic(
  p_actor_id uuid,
  p_project_id text,
  p_artifacts jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  changed_count integer;
begin
  if p_actor_id is null
    or nullif(btrim(p_project_id), '') is null
    or jsonb_typeof(p_artifacts) is distinct from 'array'
    or jsonb_array_length(p_artifacts) > 500 then
    raise exception 'invalid Agent Artifact upsert' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.project_members member
    where member.project_id = p_project_id
      and member.user_id = p_actor_id
      and member.role in ('owner', 'editor')
  ) then
    raise exception 'Agent Artifact write forbidden' using errcode = '42501';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_artifacts) as incoming(
      id text, kind text, source_kind text, run_id text, job_id text,
      created_at timestamptz, updated_at timestamptz, payload jsonb
    )
    where nullif(btrim(incoming.id), '') is null
      or incoming.kind not in ('image', 'video', 'text', 'workflow', 'asset_group', 'file')
      or incoming.source_kind not in ('agent_action', 'generation_output')
      or incoming.created_at is null
      or incoming.updated_at is null
      or jsonb_typeof(incoming.payload) is distinct from 'object'
      or incoming.payload->>'id' is distinct from incoming.id
  ) then
    raise exception 'invalid Agent Artifact row' using errcode = '22023';
  end if;

  with parsed as (
    select
      incoming.*,
      min(incoming.created_at) over (partition by incoming.id) as earliest_created_at,
      row_number() over (
        partition by incoming.id
        order by incoming.updated_at desc, incoming.created_at asc
      ) as freshness_rank
    from jsonb_to_recordset(p_artifacts) as incoming(
      id text, kind text, source_kind text, run_id text, job_id text,
      created_at timestamptz, updated_at timestamptz, payload jsonb
    )
  ), newest as (
    select
      id, kind, source_kind, run_id, job_id,
      earliest_created_at as created_at,
      updated_at,
      jsonb_set(
        payload,
        '{createdAt}',
        to_jsonb(floor(extract(epoch from earliest_created_at) * 1000)::bigint),
        true
      ) as payload
    from parsed
    where freshness_rank = 1
  )
  insert into public.agent_artifacts (
    project_id, id, owner_id, kind, source_kind, run_id, job_id,
    created_at, updated_at, payload
  )
  select
    p_project_id, newest.id, p_actor_id, newest.kind, newest.source_kind,
    newest.run_id, newest.job_id, newest.created_at, newest.updated_at, newest.payload
  from newest
  on conflict (project_id, id) do update set
    kind = excluded.kind,
    source_kind = excluded.source_kind,
    run_id = excluded.run_id,
    job_id = excluded.job_id,
    created_at = least(agent_artifacts.created_at, excluded.created_at),
    updated_at = excluded.updated_at,
    payload = jsonb_set(
      excluded.payload,
      '{createdAt}',
      to_jsonb(floor(extract(epoch from least(agent_artifacts.created_at, excluded.created_at)) * 1000)::bigint),
      true
    )
  where agent_artifacts.updated_at <= excluded.updated_at;

  get diagnostics changed_count = row_count;
  return changed_count;
end;
$$;

revoke all on function public.botanic_upsert_agent_artifacts_monotonic(uuid, text, jsonb) from public;
revoke all on function public.botanic_upsert_agent_artifacts_monotonic(uuid, text, jsonb) from authenticated;
grant execute on function public.botanic_upsert_agent_artifacts_monotonic(uuid, text, jsonb) to service_role;

commit;
