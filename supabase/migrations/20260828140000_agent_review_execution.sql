begin;

-- ReviewTask 是逐候选视觉评审的执行权威。execution generation + lease token 只对
-- Worker 可见；prepared checkpoint 在外呼前持久化，结果和 checkpoint 清理同一 CAS。
create table if not exists public.agent_review_tasks (
  id text primary key,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  project_id text not null references public.projects(id) on delete cascade,
  run_id text not null references public.agent_runs(id) on delete cascade,
  status text not null check (status in ('queued', 'running', 'completed', 'failed')),
  updated_at timestamptz not null default now(),
  payload jsonb not null,
  execution_version bigint not null default 0,
  lease_token text,
  lease_expires_at timestamptz
);

alter table public.agent_review_tasks
  add column if not exists execution_version bigint not null default 0,
  add column if not exists lease_token text,
  add column if not exists lease_expires_at timestamptz;

update public.agent_review_tasks
set execution_version = greatest(
      execution_version,
      case when payload->>'executionVersion' ~ '^[0-9]+$'
        then (payload->>'executionVersion')::bigint else 0 end,
      case when payload->'execution'->>'generation' ~ '^[0-9]+$'
        then (payload->'execution'->>'generation')::bigint else 0 end
    ),
    lease_token = coalesce(lease_token, nullif(payload->'execution'->>'leaseToken', '')),
    lease_expires_at = coalesce(
      lease_expires_at,
      case when payload->'execution'->>'leaseExpiresAt' ~ '^[0-9]+([.][0-9]+)?$'
        then to_timestamp((payload->'execution'->>'leaseExpiresAt')::double precision / 1000.0)
        else null end
    );

create index if not exists agent_review_tasks_pending_idx
  on public.agent_review_tasks (updated_at asc, id asc)
  where status in ('queued', 'running');

create index if not exists agent_review_tasks_running_lease_idx
  on public.agent_review_tasks (lease_expires_at asc, id asc)
  where status = 'running';

alter table public.agent_review_tasks enable row level security;
revoke all on table public.agent_review_tasks from public, anon, authenticated;
grant select, insert, update on table public.agent_review_tasks to service_role;

create or replace function public.botanic_valid_agent_review_checkpoint(p_checkpoint jsonb)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $$
begin
  if p_checkpoint is null or jsonb_typeof(p_checkpoint) is distinct from 'object' then
    return false;
  end if;
  if (select count(*) from jsonb_object_keys(p_checkpoint)) <> 4 then
    return false;
  end if;
  return p_checkpoint->'version' = '1'::jsonb
    and p_checkpoint->>'phase' = 'prepared'
    and jsonb_typeof(p_checkpoint->'artifactId') = 'string'
    and p_checkpoint->>'artifactId' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$'
    and jsonb_typeof(p_checkpoint->'preparedAt') = 'number'
    and (p_checkpoint->>'preparedAt')::numeric > 0
    and not exists (
      select 1 from jsonb_object_keys(p_checkpoint) key
      where key not in ('version', 'phase', 'artifactId', 'preparedAt')
    );
exception when others then
  return false;
end;
$$;

create or replace function public.botanic_agent_review_has_result(
  p_payload jsonb,
  p_task_id text,
  p_artifact_id text
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $$
begin
  if jsonb_typeof(p_payload->'results') is distinct from 'array' then
    return false;
  end if;
  return exists (
    select 1
    from jsonb_array_elements(p_payload->'results') result
    where result->>'taskId' = p_task_id
      and result->>'artifactId' = p_artifact_id
  );
exception when others then
  return false;
end;
$$;

create or replace function public.botanic_put_agent_review_task_guarded(
  p_owner_id uuid,
  p_task_id text,
  p_project_id text,
  p_task jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing public.agent_review_tasks%rowtype;
  stored_payload jsonb;
  observed_at timestamptz;
  observed_ms bigint;
  run_id text := nullif(btrim(p_task->>'runId'), '');
begin
  if p_owner_id is null or nullif(btrim(p_task_id), '') is null
    or nullif(btrim(p_project_id), '') is null
    or jsonb_typeof(p_task) is distinct from 'object'
    or p_task->>'id' is distinct from p_task_id
    or p_task->>'projectId' is distinct from p_project_id
    or run_id is null then
    raise exception 'invalid agent review task put' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_task_id, 5));
  select * into existing from public.agent_review_tasks where id = p_task_id for update;
  observed_at := clock_timestamp();
  observed_ms := floor(extract(epoch from observed_at) * 1000)::bigint;

  if not found then
    if not exists (
      select 1 from public.agent_runs
      where id = run_id and owner_id = p_owner_id and project_id = p_project_id
    ) then
      raise exception 'agent review run identity mismatch' using errcode = '22023';
    end if;
    stored_payload := (((p_task - 'execution') - 'executionVersion') - 'error')
      || jsonb_build_object(
        'id', p_task_id,
        'ownerId', p_owner_id::text,
        'projectId', p_project_id,
        'runId', run_id,
        'status', 'queued',
        'attempt', 0,
        'results', '[]'::jsonb,
        'updatedAt', observed_ms
      );
    insert into public.agent_review_tasks (
      id, owner_id, project_id, run_id, status, updated_at,
      execution_version, lease_token, lease_expires_at, payload
    ) values (
      p_task_id, p_owner_id, p_project_id, run_id, 'queued', observed_at,
      0, null, null, stored_payload
    );
    return jsonb_build_object('kind', 'inserted', 'changed', true, 'task', stored_payload);
  end if;

  stored_payload := existing.payload || jsonb_build_object(
    'id', existing.id,
    'ownerId', existing.owner_id::text,
    'projectId', existing.project_id,
    'runId', existing.run_id,
    'status', existing.status,
    'executionVersion', existing.execution_version
  );
  if existing.owner_id <> p_owner_id or existing.project_id <> p_project_id
    or existing.run_id <> run_id then
    return jsonb_build_object('kind', 'conflict', 'changed', false, 'task', stored_payload);
  end if;
  if existing.execution_version > 0
    or jsonb_typeof(existing.payload->'execution') = 'object'
    or existing.status in ('completed', 'failed')
    or jsonb_array_length(case when jsonb_typeof(existing.payload->'results') = 'array'
      then existing.payload->'results' else '[]'::jsonb end) > 0 then
    return jsonb_build_object('kind', 'fenced', 'changed', false, 'task', stored_payload);
  end if;
  return jsonb_build_object('kind', 'replay', 'changed', false, 'task', stored_payload);
end;
$$;

create or replace function public.botanic_claim_agent_review_execution(
  p_owner_id uuid,
  p_task_id text,
  p_project_id text,
  p_claim jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing public.agent_review_tasks%rowtype;
  stored_payload jsonb;
  execution_payload jsonb;
  raw_checkpoint jsonb;
  observed_at timestamptz;
  observed_ms bigint;
  existing_updated_ms bigint;
  lease_duration_ms bigint;
  generation bigint;
  token text := nullif(btrim(p_claim->>'leaseToken'), '');
  artifact_id text;
  allow_takeover boolean := coalesce(p_claim->'allowTakeover', 'false'::jsonb) = 'true'::jsonb;
begin
  if p_owner_id is null or nullif(btrim(p_task_id), '') is null
    or nullif(btrim(p_project_id), '') is null
    or jsonb_typeof(p_claim) is distinct from 'object'
    or p_claim->>'id' is distinct from p_task_id
    or p_claim->>'projectId' is distinct from p_project_id
    or token is null then
    raise exception 'invalid agent review execution claim' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_task_id, 5));
  select * into existing from public.agent_review_tasks where id = p_task_id for update;
  if not found or existing.owner_id <> p_owner_id then
    return jsonb_build_object('kind', 'missing', 'changed', false);
  end if;
  stored_payload := existing.payload || jsonb_build_object(
    'id', existing.id,
    'ownerId', existing.owner_id::text,
    'projectId', existing.project_id,
    'runId', existing.run_id,
    'status', existing.status,
    'executionVersion', existing.execution_version
  );
  if existing.project_id <> p_project_id then
    return jsonb_build_object('kind', 'conflict', 'changed', false, 'task', stored_payload);
  end if;
  if existing.status = 'completed' then
    return jsonb_build_object('kind', 'replay', 'changed', false, 'task', stored_payload);
  end if;
  if existing.status = 'failed' then
    return jsonb_build_object(
      'kind', case when stored_payload->'error'->>'code' = 'AGENT_REVIEW_OUTCOME_UNKNOWN'
        then 'outcome_unknown' else 'terminal' end,
      'changed', false,
      'task', stored_payload
    );
  end if;
  if existing.status not in ('queued', 'running') then
    return jsonb_build_object('kind', 'conflict', 'changed', false, 'task', stored_payload);
  end if;

  observed_at := clock_timestamp();
  observed_ms := floor(extract(epoch from observed_at) * 1000)::bigint;
  existing_updated_ms := case when stored_payload->>'updatedAt' ~ '^[0-9]+$'
    then (stored_payload->>'updatedAt')::bigint else 0 end;
  lease_duration_ms := greatest(30000, least(
    case when p_claim->>'leaseDurationMs' ~ '^[0-9]+$'
      then (p_claim->>'leaseDurationMs')::bigint else 120000 end,
    900000
  ));

  if existing.status = 'running' then
    if existing.lease_token = token then
      return jsonb_build_object('kind', 'claimed', 'changed', false, 'task', stored_payload);
    end if;
    if existing.lease_expires_at is not null and existing.lease_expires_at > observed_at then
      return jsonb_build_object('kind', 'in_progress', 'changed', false, 'task', stored_payload);
    end if;

    raw_checkpoint := stored_payload->'execution'->'checkpoint';
    if jsonb_typeof(raw_checkpoint) = 'null' then raw_checkpoint := null; end if;
    if raw_checkpoint is not null then
      if public.botanic_valid_agent_review_checkpoint(raw_checkpoint) then
        artifact_id := raw_checkpoint->>'artifactId';
      else
        artifact_id := null;
      end if;
      if artifact_id is null
        or not public.botanic_agent_review_has_result(stored_payload, existing.id, artifact_id) then
        execution_payload := coalesce(stored_payload->'execution', '{}'::jsonb);
        if not (execution_payload ? 'settledAt') then
          execution_payload := execution_payload || jsonb_build_object('settledAt', observed_ms);
        end if;
        stored_payload := stored_payload || jsonb_build_object(
          'status', 'failed',
          'updatedAt', greatest(existing_updated_ms, observed_ms),
          'error', jsonb_build_object(
            'code', 'AGENT_REVIEW_OUTCOME_UNKNOWN',
            'message', '视觉评审可能已调用但结果未确认。为避免重复调用，系统不会自动重试。'
          ),
          'execution', execution_payload
        );
        update public.agent_review_tasks set
          status = 'failed', updated_at = observed_at, payload = stored_payload
        where id = p_task_id;
        return jsonb_build_object('kind', 'outcome_unknown', 'changed', true, 'task', stored_payload);
      end if;
    end if;
    if not allow_takeover then
      return jsonb_build_object('kind', 'stale', 'changed', false, 'task', stored_payload);
    end if;
  end if;

  generation := greatest(
    existing.execution_version,
    case when stored_payload->>'executionVersion' ~ '^[0-9]+$'
      then (stored_payload->>'executionVersion')::bigint else 0 end,
    case when stored_payload->'execution'->>'generation' ~ '^[0-9]+$'
      then (stored_payload->'execution'->>'generation')::bigint else 0 end
  ) + 1;
  execution_payload := jsonb_build_object(
    'generation', generation,
    'leaseToken', token,
    'leaseDurationMs', lease_duration_ms,
    'leaseExpiresAt', observed_ms + lease_duration_ms,
    'claimedAt', observed_ms,
    'lastHeartbeatAt', observed_ms
  );
  stored_payload := (stored_payload - 'error') || jsonb_build_object(
    'status', 'running',
    'attempt', coalesce(case when stored_payload->>'attempt' ~ '^[0-9]+$'
      then (stored_payload->>'attempt')::bigint else 0 end, 0) + 1,
    'updatedAt', greatest(existing_updated_ms, observed_ms),
    'executionVersion', generation,
    'execution', execution_payload
  );
  update public.agent_review_tasks set
    status = 'running',
    updated_at = observed_at,
    execution_version = generation,
    lease_token = token,
    lease_expires_at = observed_at + (lease_duration_ms::double precision * interval '1 millisecond'),
    payload = stored_payload
  where id = p_task_id;
  return jsonb_build_object('kind', 'claimed', 'changed', true, 'task', stored_payload);
end;
$$;

create or replace function public.botanic_commit_agent_review_execution(
  p_owner_id uuid,
  p_task_id text,
  p_project_id text,
  p_command jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing public.agent_review_tasks%rowtype;
  stored_payload jsonb;
  execution_payload jsonb;
  current_checkpoint jsonb;
  requested_checkpoint jsonb;
  next_checkpoint jsonb;
  results_payload jsonb;
  result_payload jsonb;
  existing_result jsonb;
  observed_at timestamptz;
  observed_ms bigint;
  existing_updated_ms bigint;
  lease_duration_ms bigint;
  generation bigint;
  next_status text := p_command->>'status';
  token text := nullif(btrim(p_command->>'leaseToken'), '');
  artifact_id text;
begin
  if p_owner_id is null or nullif(btrim(p_task_id), '') is null
    or nullif(btrim(p_project_id), '') is null
    or jsonb_typeof(p_command) is distinct from 'object'
    or p_command->>'id' is distinct from p_task_id
    or p_command->>'projectId' is distinct from p_project_id
    or next_status not in ('running', 'completed', 'failed')
    or token is null
    or nullif(p_command->>'executionGeneration', '') is null
    or p_command->>'executionGeneration' !~ '^[0-9]+$' then
    raise exception 'invalid agent review execution commit' using errcode = '22023';
  end if;
  generation := (p_command->>'executionGeneration')::bigint;

  perform pg_advisory_xact_lock(hashtextextended(p_task_id, 5));
  select * into existing from public.agent_review_tasks where id = p_task_id for update;
  if not found or existing.owner_id <> p_owner_id then
    return jsonb_build_object('kind', 'missing', 'changed', false);
  end if;
  stored_payload := existing.payload || jsonb_build_object(
    'id', existing.id,
    'ownerId', existing.owner_id::text,
    'projectId', existing.project_id,
    'runId', existing.run_id,
    'status', existing.status,
    'executionVersion', existing.execution_version
  );
  if existing.project_id <> p_project_id then
    return jsonb_build_object('kind', 'conflict', 'changed', false, 'task', stored_payload);
  end if;
  if existing.execution_version <> generation
    or existing.lease_token is distinct from token
    or stored_payload->'execution'->>'leaseToken' is distinct from token
    or stored_payload->'execution'->>'generation' is distinct from generation::text then
    return jsonb_build_object('kind', 'stale', 'changed', false, 'task', stored_payload);
  end if;
  if existing.status in ('completed', 'failed') then
    return jsonb_build_object(
      'kind', case when existing.status = next_status then 'replay' else 'stale' end,
      'changed', false,
      'task', stored_payload
    );
  end if;
  if existing.status <> 'running' then
    return jsonb_build_object('kind', 'stale', 'changed', false, 'task', stored_payload);
  end if;

  current_checkpoint := stored_payload->'execution'->'checkpoint';
  if jsonb_typeof(current_checkpoint) = 'null' then current_checkpoint := null; end if;
  if current_checkpoint is not null
    and not public.botanic_valid_agent_review_checkpoint(current_checkpoint) then
    return jsonb_build_object('kind', 'conflict', 'changed', false, 'task', stored_payload);
  end if;
  next_checkpoint := current_checkpoint;
  if p_command ? 'checkpoint' and jsonb_typeof(p_command->'checkpoint') <> 'null' then
    requested_checkpoint := p_command->'checkpoint';
    if not public.botanic_valid_agent_review_checkpoint(requested_checkpoint) then
      return jsonb_build_object('kind', 'conflict', 'changed', false, 'task', stored_payload);
    end if;
    artifact_id := requested_checkpoint->>'artifactId';
    if public.botanic_agent_review_has_result(stored_payload, existing.id, artifact_id)
      or not exists (
        select 1
        from jsonb_array_elements_text(case
          when jsonb_typeof(stored_payload->'coverage'->'artifactIds') = 'array'
            then stored_payload->'coverage'->'artifactIds'
          else '[]'::jsonb end
        ) covered(artifact_id)
        where covered.artifact_id = requested_checkpoint->>'artifactId'
      )
      or (current_checkpoint is not null
        and current_checkpoint->>'artifactId' is distinct from requested_checkpoint->>'artifactId') then
      return jsonb_build_object('kind', 'conflict', 'changed', false, 'task', stored_payload);
    end if;
    next_checkpoint := requested_checkpoint;
  end if;

  if jsonb_typeof(stored_payload->'results') is distinct from 'array' then
    return jsonb_build_object('kind', 'conflict', 'changed', false, 'task', stored_payload);
  end if;
  results_payload := stored_payload->'results';
  if p_command ? 'result' then
    result_payload := p_command->'result';
    if jsonb_typeof(result_payload) is distinct from 'object'
      or result_payload->>'taskId' is distinct from existing.id
      or result_payload->>'projectId' is distinct from existing.project_id
      or nullif(btrim(result_payload->>'artifactId'), '') is null then
      return jsonb_build_object('kind', 'conflict', 'changed', false, 'task', stored_payload);
    end if;
    artifact_id := result_payload->>'artifactId';
    existing_result := null;
    select result into existing_result
    from jsonb_array_elements(results_payload) result
    where result->>'artifactId' = artifact_id
    limit 1;

    if current_checkpoint is null and (existing_result is null or existing_result <> result_payload) then
      return jsonb_build_object('kind', 'conflict', 'changed', false, 'task', stored_payload);
    end if;
    if current_checkpoint is not null
      and current_checkpoint->>'artifactId' is distinct from artifact_id then
      return jsonb_build_object('kind', 'conflict', 'changed', false, 'task', stored_payload);
    end if;
    if current_checkpoint is not null
      and not (p_command ? 'checkpoint' and jsonb_typeof(p_command->'checkpoint') = 'null') then
      return jsonb_build_object('kind', 'conflict', 'changed', false, 'task', stored_payload);
    end if;
    if existing_result is not null and existing_result <> result_payload then
      return jsonb_build_object('kind', 'conflict', 'changed', false, 'task', stored_payload);
    end if;
    if existing_result is null then
      results_payload := results_payload || jsonb_build_array(result_payload);
    end if;
  end if;

  if p_command ? 'checkpoint' and jsonb_typeof(p_command->'checkpoint') = 'null' then
    if current_checkpoint is not null
      and not public.botanic_agent_review_has_result(
        jsonb_build_object('results', results_payload),
        existing.id,
        current_checkpoint->>'artifactId'
      ) then
      return jsonb_build_object('kind', 'conflict', 'changed', false, 'task', stored_payload);
    end if;
    next_checkpoint := null;
  end if;

  if next_status <> 'running' then
    if next_checkpoint is not null then
      return jsonb_build_object('kind', 'conflict', 'changed', false, 'task', stored_payload);
    end if;
    if next_status = 'completed' and exists (
      select 1
      from jsonb_array_elements_text(case
        when jsonb_typeof(stored_payload->'coverage'->'artifactIds') = 'array'
          then stored_payload->'coverage'->'artifactIds'
        else '[]'::jsonb end
      ) covered(artifact_id)
      where not public.botanic_agent_review_has_result(
        jsonb_build_object('results', results_payload), existing.id, covered.artifact_id
      )
    ) then
      return jsonb_build_object('kind', 'conflict', 'changed', false, 'task', stored_payload);
    end if;
    if next_status = 'failed'
      and (jsonb_typeof(p_command->'error') is distinct from 'object'
        or nullif(btrim(p_command->'error'->>'code'), '') is null) then
      return jsonb_build_object('kind', 'conflict', 'changed', false, 'task', stored_payload);
    end if;
  end if;

  observed_at := clock_timestamp();
  observed_ms := floor(extract(epoch from observed_at) * 1000)::bigint;
  existing_updated_ms := case when stored_payload->>'updatedAt' ~ '^[0-9]+$'
    then (stored_payload->>'updatedAt')::bigint else 0 end;
  lease_duration_ms := case when stored_payload->'execution'->>'leaseDurationMs' ~ '^[0-9]+$'
    then greatest(30000, (stored_payload->'execution'->>'leaseDurationMs')::bigint)
    else 120000 end;
  execution_payload := coalesce(stored_payload->'execution', '{}'::jsonb)
    || jsonb_build_object('generation', generation, 'leaseToken', token);
  if next_status = 'running' then
    execution_payload := execution_payload || jsonb_build_object(
      'leaseExpiresAt', observed_ms + lease_duration_ms,
      'lastHeartbeatAt', observed_ms
    );
  elsif not (execution_payload ? 'settledAt') then
    execution_payload := execution_payload || jsonb_build_object('settledAt', observed_ms);
  end if;
  if next_checkpoint is null then
    execution_payload := execution_payload - 'checkpoint';
  else
    execution_payload := execution_payload || jsonb_build_object('checkpoint', next_checkpoint);
  end if;

  stored_payload := (stored_payload - 'error') || jsonb_build_object(
    'status', next_status,
    'results', results_payload,
    'updatedAt', greatest(existing_updated_ms, observed_ms),
    'executionVersion', generation,
    'execution', execution_payload
  );
  if next_status = 'failed' then
    stored_payload := stored_payload || jsonb_build_object(
      'error', jsonb_build_object(
        'code', p_command->'error'->>'code',
        'message', left(coalesce(p_command->'error'->>'message', ''), 500)
      )
    );
  end if;

  update public.agent_review_tasks set
    status = next_status,
    updated_at = observed_at,
    execution_version = generation,
    lease_token = token,
    lease_expires_at = case when next_status = 'running'
      then observed_at + (lease_duration_ms::double precision * interval '1 millisecond')
      else lease_expires_at end,
    payload = stored_payload
  where id = p_task_id;
  return jsonb_build_object('kind', 'committed', 'changed', true, 'task', stored_payload);
end;
$$;

create or replace function public.botanic_commit_agent_review_human_decisions(
  p_actor_id uuid,
  p_task_id text,
  p_project_id text,
  p_command jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing public.agent_review_tasks%rowtype;
  stored_payload jsonb;
  decisions_payload jsonb;
  results_payload jsonb;
  accepted_decisions jsonb := '[]'::jsonb;
  requested_decision jsonb;
  existing_decision jsonb;
  projected_decision jsonb;
  observed_at timestamptz;
  observed_ms bigint;
  existing_updated_ms bigint;
  decision_version bigint;
  last_decided_ms bigint;
  requested_ids text[] := array[]::text[];
  requested_artifacts text[] := array[]::text[];
  changed boolean := false;
  expected_candidate_status text;
begin
  if p_actor_id is null or nullif(btrim(p_task_id), '') is null
    or nullif(btrim(p_project_id), '') is null
    or jsonb_typeof(p_command) is distinct from 'object'
    or p_command->>'id' is distinct from p_task_id
    or p_command->>'projectId' is distinct from p_project_id
    or jsonb_typeof(p_command->'decisions') is distinct from 'array'
    or jsonb_array_length(p_command->'decisions') not between 1 and 60 then
    raise exception 'invalid agent review human decision command' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_task_id, 5));
  select * into existing from public.agent_review_tasks where id = p_task_id for update;
  if not found then
    return jsonb_build_object('kind', 'missing', 'changed', false);
  end if;
  stored_payload := existing.payload || jsonb_build_object(
    'id', existing.id,
    'ownerId', existing.owner_id::text,
    'projectId', existing.project_id,
    'runId', existing.run_id,
    'status', existing.status,
    'executionVersion', existing.execution_version
  );
  if existing.project_id <> p_project_id then
    return jsonb_build_object('kind', 'conflict', 'changed', false, 'task', stored_payload);
  end if;
  if not exists (
    select 1 from public.project_members
    where project_id = p_project_id and user_id = p_actor_id
      and role::text in ('owner', 'editor')
  ) then
    raise exception 'agent review decision forbidden' using errcode = '42501';
  end if;
  if existing.status <> 'completed' then
    return jsonb_build_object('kind', 'not_ready', 'changed', false, 'task', stored_payload);
  end if;
  if jsonb_typeof(stored_payload->'results') is distinct from 'array'
    or jsonb_typeof(coalesce(stored_payload->'decisions', '[]'::jsonb)) is distinct from 'array' then
    return jsonb_build_object('kind', 'conflict', 'changed', false, 'task', stored_payload);
  end if;
  results_payload := stored_payload->'results';
  decisions_payload := coalesce(stored_payload->'decisions', '[]'::jsonb);
  if exists (
    select 1
    from jsonb_array_elements(decisions_payload) decision
    group by decision->>'id'
    having nullif(btrim(decision->>'id'), '') is null or count(*) > 1
  ) then
    return jsonb_build_object('kind', 'conflict', 'changed', false, 'task', stored_payload);
  end if;
  observed_at := clock_timestamp();
  observed_ms := floor(extract(epoch from observed_at) * 1000)::bigint;
  select greatest(
    case when stored_payload->>'decisionVersion' ~ '^[0-9]+$'
      then (stored_payload->>'decisionVersion')::bigint else 0 end,
    jsonb_array_length(decisions_payload),
    coalesce(max(case when decision->>'decisionRevision' ~ '^[0-9]+$'
      then (decision->>'decisionRevision')::bigint else 0 end), 0)
  ) into decision_version
  from jsonb_array_elements(decisions_payload) decision;
  select coalesce(max(case when decision->>'decidedAt' ~ '^[0-9]+$'
    then (decision->>'decidedAt')::bigint else 0 end), 0)
  into last_decided_ms
  from jsonb_array_elements(decisions_payload) decision;

  for requested_decision in
    select value from jsonb_array_elements(p_command->'decisions')
  loop
    expected_candidate_status := case requested_decision->>'decision'
      when 'accepted' then 'accepted'
      when 'rejected' then 'rejected'
      when 'retry_requested' then 'pending_review'
      else null
    end;
    if jsonb_typeof(requested_decision) is distinct from 'object'
      or nullif(btrim(requested_decision->>'id'), '') is null
      or requested_decision->>'taskId' is distinct from existing.id
      or requested_decision->>'projectId' is distinct from existing.project_id
      or nullif(btrim(requested_decision->>'artifactId'), '') is null
      or requested_decision->>'decidedBy' is distinct from p_actor_id::text
      or nullif(btrim(requested_decision->>'idempotencyKey'), '') is null
      or expected_candidate_status is null
      or requested_decision->>'candidateStatus' is distinct from expected_candidate_status
      or jsonb_typeof(requested_decision->'decidedAt') is distinct from 'number'
      or (requested_decision->>'decidedAt')::numeric <= 0
      or (requested_decision ? 'note' and (
        jsonb_typeof(requested_decision->'note') is distinct from 'string'
        or length(requested_decision->>'note') > 500
      ))
      or not exists (
        select 1 from jsonb_array_elements_text(case
          when jsonb_typeof(stored_payload->'coverage'->'artifactIds') = 'array'
            then stored_payload->'coverage'->'artifactIds'
          else '[]'::jsonb end
        ) covered(artifact_id)
        where covered.artifact_id = requested_decision->>'artifactId'
      )
      or not public.botanic_agent_review_has_result(
        stored_payload, existing.id, requested_decision->>'artifactId'
      ) then
      return jsonb_build_object('kind', 'conflict', 'changed', false, 'task', stored_payload);
    end if;
    if requested_decision->>'id' = any(requested_ids)
      or requested_decision->>'artifactId' = any(requested_artifacts) then
      return jsonb_build_object('kind', 'conflict', 'changed', false, 'task', stored_payload);
    end if;
    requested_ids := array_append(requested_ids, requested_decision->>'id');
    requested_artifacts := array_append(requested_artifacts, requested_decision->>'artifactId');

    existing_decision := null;
    select decision into existing_decision
    from jsonb_array_elements(decisions_payload) decision
    where decision->>'id' = requested_decision->>'id'
    limit 1;
    if existing_decision is not null then
      if ((existing_decision - 'decidedAt') - 'decisionRevision')
        <> ((requested_decision - 'decidedAt') - 'decisionRevision') then
        return jsonb_build_object('kind', 'conflict', 'changed', false, 'task', stored_payload);
      end if;
      accepted_decisions := accepted_decisions || jsonb_build_array(existing_decision);
    else
      changed := true;
      decision_version := decision_version + 1;
      last_decided_ms := greatest(last_decided_ms + 1, observed_ms);
      requested_decision := ((requested_decision - 'decidedAt') - 'decisionRevision')
        || jsonb_build_object(
          'decisionRevision', decision_version,
          'decidedAt', last_decided_ms
        );
      decisions_payload := decisions_payload || jsonb_build_array(requested_decision);
      accepted_decisions := accepted_decisions || jsonb_build_array(requested_decision);
    end if;
  end loop;

  if not changed then
    return jsonb_build_object('kind', 'replay', 'changed', false, 'task', stored_payload);
  end if;

  for projected_decision in
    select value from jsonb_array_elements(accepted_decisions)
  loop
    select coalesce(jsonb_agg(
      case when result->>'artifactId' = projected_decision->>'artifactId' then
        result || jsonb_build_object(
          'candidateStatus', projected_decision->>'candidateStatus',
          'humanDecisionId', projected_decision->>'id',
          'updatedAt', projected_decision->'decidedAt'
        )
      else result end
      order by ordinal
    ), '[]'::jsonb)
    into results_payload
    from jsonb_array_elements(results_payload) with ordinality as rows(result, ordinal);
  end loop;

  existing_updated_ms := case when stored_payload->>'updatedAt' ~ '^[0-9]+$'
    then (stored_payload->>'updatedAt')::bigint else 0 end;
  stored_payload := stored_payload || jsonb_build_object(
    'decisions', decisions_payload,
    'results', results_payload,
    'decisionVersion', decision_version,
    'updatedAt', greatest(existing_updated_ms, observed_ms)
  );
  update public.agent_review_tasks set
    updated_at = observed_at,
    payload = stored_payload
  where id = p_task_id;
  return jsonb_build_object('kind', 'committed', 'changed', true, 'task', stored_payload);
exception when invalid_text_representation or numeric_value_out_of_range then
  return jsonb_build_object('kind', 'conflict', 'changed', false, 'task', stored_payload);
end;
$$;

revoke all on function public.botanic_valid_agent_review_checkpoint(jsonb)
  from public, anon, authenticated;
revoke all on function public.botanic_agent_review_has_result(jsonb, text, text)
  from public, anon, authenticated;
revoke all on function public.botanic_put_agent_review_task_guarded(uuid, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.botanic_claim_agent_review_execution(uuid, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.botanic_commit_agent_review_execution(uuid, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.botanic_commit_agent_review_human_decisions(uuid, text, text, jsonb)
  from public, anon, authenticated;

grant execute on function public.botanic_put_agent_review_task_guarded(uuid, text, text, jsonb)
  to service_role;
grant execute on function public.botanic_claim_agent_review_execution(uuid, text, text, jsonb)
  to service_role;
grant execute on function public.botanic_commit_agent_review_execution(uuid, text, text, jsonb)
  to service_role;
grant execute on function public.botanic_commit_agent_review_human_decisions(uuid, text, text, jsonb)
  to service_role;

commit;
