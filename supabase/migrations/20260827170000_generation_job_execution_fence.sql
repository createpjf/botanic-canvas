begin;

-- Generation Job 的执行权由数据库行上的单调 generation 与不可猜测 lease token
-- 共同标识。payload 保留完整私有执行信息，列投影用于原子条件与过期扫描。
alter table public.generation_jobs
  add column if not exists execution_version bigint not null default 0,
  add column if not exists lease_token text,
  add column if not exists lease_expires_at timestamptz;

create index if not exists generation_jobs_running_lease_idx
  on public.generation_jobs (lease_expires_at asc, id asc)
  where status = 'running';

-- leaseToken 是 Worker capability，不是项目成员可读数据。产品端统一经鉴权 HTTP
-- 读取已净化的 publicGenerationJob；service_role 仍可供 Worker/恢复器读取权威行。
drop policy if exists "owner can read generation jobs" on public.generation_jobs;
revoke select on table public.generation_jobs from public, anon, authenticated;

create or replace function public.botanic_put_generation_job_guarded(
  p_owner_id uuid,
  p_job_id text,
  p_project_id text,
  p_job jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing public.generation_jobs%rowtype;
  existing_payload jsonb;
  stored_payload jsonb;
  observed_at timestamptz := clock_timestamp();
  observed_ms bigint;
begin
  if p_owner_id is null or nullif(btrim(p_job_id), '') is null
    or nullif(btrim(p_project_id), '') is null
    or jsonb_typeof(p_job) is distinct from 'object'
    or p_job->>'id' is distinct from p_job_id
    or p_job->>'projectId' is distinct from p_project_id
    or p_job->>'status' not in ('queued', 'running', 'succeeded', 'failed', 'cancelled') then
    raise exception 'invalid generation job put' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_job_id, 4));
  select * into existing from public.generation_jobs where id = p_job_id for update;
  observed_at := clock_timestamp();
  observed_ms := floor(extract(epoch from observed_at) * 1000)::bigint;
  stored_payload := ((p_job - 'execution') - 'executionVersion') || jsonb_build_object(
    'id', p_job_id,
    'ownerId', p_owner_id::text,
    'projectId', p_project_id,
    'updatedAt', observed_ms
  );

  if not found then
    insert into public.generation_jobs (
      id, owner_id, project_id, status, updated_at,
      execution_version, lease_token, lease_expires_at, payload
    ) values (
      p_job_id, p_owner_id, p_project_id,
      (stored_payload->>'status')::public.botanic_generation_status, observed_at,
      0, null, null, stored_payload
    );
    return jsonb_build_object('kind', 'inserted', 'changed', true, 'job', stored_payload);
  end if;

  existing_payload := existing.payload || jsonb_build_object(
    'id', existing.id,
    'ownerId', existing.owner_id::text,
    'projectId', existing.project_id,
    'status', existing.status::text,
    'executionVersion', existing.execution_version
  );
  if existing.owner_id <> p_owner_id or existing.project_id <> p_project_id then
    return jsonb_build_object('kind', 'conflict', 'changed', false, 'job', existing_payload);
  end if;
  if existing.execution_version > 0
    or jsonb_typeof(existing.payload->'execution') = 'object'
    or (existing.status in ('succeeded', 'failed', 'cancelled')
      and existing.status::text is distinct from stored_payload->>'status') then
    return jsonb_build_object('kind', 'fenced', 'changed', false, 'job', existing_payload);
  end if;

  update public.generation_jobs set
    status = (stored_payload->>'status')::public.botanic_generation_status,
    updated_at = observed_at,
    execution_version = 0,
    lease_token = null,
    lease_expires_at = null,
    payload = stored_payload
  where id = p_job_id;
  return jsonb_build_object('kind', 'updated', 'changed', true, 'job', stored_payload);
end;
$$;

create or replace function public.botanic_claim_generation_job_execution(
  p_job_id text,
  p_claim jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing public.generation_jobs%rowtype;
  stored_payload jsonb;
  execution_payload jsonb;
  observed_at timestamptz;
  observed_ms bigint;
  lease_duration_ms bigint;
  generation bigint;
  token text := nullif(btrim(p_claim->>'leaseToken'), '');
begin
  if nullif(btrim(p_job_id), '') is null or jsonb_typeof(p_claim) is distinct from 'object'
    or token is null then
    raise exception 'invalid generation execution claim' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_job_id, 4));
  select * into existing from public.generation_jobs where id = p_job_id for update;
  if not found then
    return jsonb_build_object('kind', 'missing', 'changed', false);
  end if;
  stored_payload := existing.payload || jsonb_build_object(
    'id', existing.id,
    'ownerId', existing.owner_id::text,
    'projectId', existing.project_id,
    'status', existing.status::text,
    'executionVersion', existing.execution_version
  );
  if existing.status in ('succeeded', 'failed', 'cancelled') then
    return jsonb_build_object('kind', 'terminal', 'changed', false, 'job', stored_payload);
  end if;
  if existing.status not in ('queued', 'running') then
    return jsonb_build_object('kind', 'conflict', 'changed', false, 'job', stored_payload);
  end if;

  observed_at := clock_timestamp();
  observed_ms := floor(extract(epoch from observed_at) * 1000)::bigint;
  lease_duration_ms := greatest(30000, least(coalesce(nullif(p_claim->>'leaseDurationMs', '')::bigint, 120000), 900000));
  if existing.status = 'running' then
    if existing.lease_token = token then
      return jsonb_build_object('kind', 'claimed', 'changed', false, 'job', stored_payload);
    end if;
    if existing.lease_expires_at is not null and existing.lease_expires_at > observed_at then
      return jsonb_build_object('kind', 'in_progress', 'changed', false, 'job', stored_payload);
    end if;
    if coalesce((p_claim->>'allowTakeover')::boolean, false) is not true then
      return jsonb_build_object('kind', 'stale', 'changed', false, 'job', stored_payload);
    end if;
  end if;

  generation := greatest(
    existing.execution_version,
    coalesce(nullif(existing.payload->'execution'->>'generation', '')::bigint, 0),
    coalesce(nullif(existing.payload->>'executionVersion', '')::bigint, 0)
  ) + 1;
  execution_payload := jsonb_build_object(
    'generation', generation,
    'leaseToken', token,
    'leaseDurationMs', lease_duration_ms,
    'leaseExpiresAt', observed_ms + lease_duration_ms,
    'claimedAt', observed_ms,
    'lastHeartbeatAt', observed_ms
  );
  stored_payload := ((stored_payload - 'error') - 'errorCode') || jsonb_build_object(
    'status', 'running',
    'updatedAt', observed_ms,
    'executionVersion', generation,
    'execution', execution_payload
  );
  update public.generation_jobs set
    status = 'running',
    updated_at = observed_at,
    execution_version = generation,
    lease_token = token,
    lease_expires_at = observed_at + (lease_duration_ms::double precision * interval '1 millisecond'),
    payload = stored_payload
  where id = p_job_id;
  return jsonb_build_object('kind', 'claimed', 'changed', true, 'job', stored_payload);
end;
$$;

create or replace function public.botanic_commit_generation_job_execution(
  p_owner_id uuid,
  p_job_id text,
  p_project_id text,
  p_command jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing public.generation_jobs%rowtype;
  stored_payload jsonb;
  candidate jsonb;
  execution_payload jsonb;
  observed_at timestamptz;
  observed_ms bigint;
  generation bigint;
  lease_duration_ms bigint;
  next_status text := p_command->>'status';
  token text := p_command->>'leaseToken';
begin
  if p_owner_id is null or nullif(btrim(p_job_id), '') is null
    or nullif(btrim(p_project_id), '') is null
    or jsonb_typeof(p_command) is distinct from 'object'
    or next_status not in ('running', 'succeeded', 'failed')
    or nullif(btrim(token), '') is null
    or nullif(p_command->>'executionGeneration', '') is null then
    raise exception 'invalid generation execution commit' using errcode = '22023';
  end if;
  generation := (p_command->>'executionGeneration')::bigint;
  perform pg_advisory_xact_lock(hashtextextended(p_job_id, 4));
  select * into existing from public.generation_jobs where id = p_job_id for update;
  if not found or existing.owner_id <> p_owner_id then
    return jsonb_build_object('kind', 'missing', 'changed', false);
  end if;
  stored_payload := existing.payload || jsonb_build_object(
    'id', existing.id,
    'ownerId', existing.owner_id::text,
    'projectId', existing.project_id,
    'status', existing.status::text,
    'executionVersion', existing.execution_version
  );
  if existing.project_id <> p_project_id then
    return jsonb_build_object('kind', 'conflict', 'changed', false, 'job', stored_payload);
  end if;
  if existing.lease_token is distinct from token
    or existing.execution_version <> generation
    or existing.payload->'execution'->>'leaseToken' is distinct from token
    or nullif(existing.payload->'execution'->>'generation', '')::bigint is distinct from generation then
    return jsonb_build_object('kind', 'stale', 'changed', false, 'job', stored_payload);
  end if;
  if existing.status = 'cancelled'
    or (existing.status in ('succeeded', 'failed') and existing.status::text <> next_status)
    or existing.status::text not in ('running', next_status) then
    return jsonb_build_object('kind', 'stale', 'changed', false, 'job', stored_payload);
  end if;
  if p_command ? 'job' then
    if jsonb_typeof(p_command->'job') is distinct from 'object'
      or p_command->'job'->>'id' is distinct from p_job_id
      or p_command->'job'->>'projectId' is distinct from p_project_id
      or p_command->'job'->>'ownerId' is distinct from p_owner_id::text
      or p_command->'job'->>'status' is distinct from next_status then
      return jsonb_build_object('kind', 'conflict', 'changed', false, 'job', stored_payload);
    end if;
    candidate := p_command->'job';
  else
    candidate := stored_payload;
  end if;

  observed_at := clock_timestamp();
  observed_ms := floor(extract(epoch from observed_at) * 1000)::bigint;
  lease_duration_ms := greatest(30000, coalesce(nullif(stored_payload->'execution'->>'leaseDurationMs', '')::bigint, 120000));
  execution_payload := coalesce(stored_payload->'execution', '{}'::jsonb)
    || jsonb_build_object('generation', generation, 'leaseToken', token);
  if next_status = 'running' then
    execution_payload := execution_payload || jsonb_build_object(
      'leaseExpiresAt', observed_ms + lease_duration_ms,
      'lastHeartbeatAt', observed_ms
    );
  else
    execution_payload := execution_payload || jsonb_build_object(
      'settledAt', coalesce(nullif(stored_payload->'execution'->>'settledAt', '')::bigint, observed_ms)
    );
  end if;
  candidate := candidate || jsonb_build_object(
    'id', existing.id,
    'ownerId', existing.owner_id::text,
    'projectId', existing.project_id,
    'createdAt', stored_payload->'createdAt',
    'idempotencyKey', stored_payload->'idempotencyKey',
    'status', next_status,
    'updatedAt', observed_ms,
    'executionVersion', generation,
    'execution', execution_payload
  );
  update public.generation_jobs set
    status = next_status::public.botanic_generation_status,
    updated_at = observed_at,
    execution_version = generation,
    lease_token = token,
    lease_expires_at = case when next_status = 'running'
      then observed_at + (lease_duration_ms::double precision * interval '1 millisecond')
      else existing.lease_expires_at end,
    payload = candidate
  where id = p_job_id;
  return jsonb_build_object('kind', 'committed', 'changed', true, 'job', candidate);
end;
$$;

create or replace function public.botanic_cancel_generation_job_execution(
  p_owner_id uuid,
  p_job_id text,
  p_project_id text,
  p_command jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing public.generation_jobs%rowtype;
  stored_payload jsonb;
  outcome jsonb;
  cancel_payload jsonb;
  execution_payload jsonb;
  observed_at timestamptz;
  observed_ms bigint;
  requested_ms bigint;
  prior_status text;
begin
  if p_owner_id is null or nullif(btrim(p_job_id), '') is null
    or nullif(btrim(p_project_id), '') is null
    or jsonb_typeof(p_command) is distinct from 'object' then
    raise exception 'invalid generation cancellation' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_job_id, 4));
  select * into existing from public.generation_jobs where id = p_job_id for update;
  if not found or existing.owner_id <> p_owner_id then
    return jsonb_build_object('kind', 'missing', 'changed', false);
  end if;
  stored_payload := existing.payload || jsonb_build_object(
    'id', existing.id,
    'ownerId', existing.owner_id::text,
    'projectId', existing.project_id,
    'status', existing.status::text,
    'executionVersion', existing.execution_version
  );
  if existing.project_id <> p_project_id then
    return jsonb_build_object('kind', 'conflict', 'changed', false, 'job', stored_payload);
  end if;
  if existing.status in ('succeeded', 'failed', 'cancelled') then
    return jsonb_build_object('kind', 'replay', 'changed', false, 'job', stored_payload);
  end if;
  if existing.status not in ('queued', 'running') then
    return jsonb_build_object('kind', 'conflict', 'changed', false, 'job', stored_payload);
  end if;
  prior_status := existing.status::text;
  outcome := p_command->'outcomes'->prior_status;
  if jsonb_typeof(outcome) is distinct from 'object'
    or outcome->>'billing' not in ('none', 'possible')
    or nullif(outcome->>'capability', '') is null
    or nullif(outcome->>'code', '') is null then
    return jsonb_build_object('kind', 'conflict', 'changed', false, 'job', stored_payload);
  end if;

  observed_at := clock_timestamp();
  observed_ms := floor(extract(epoch from observed_at) * 1000)::bigint;
  requested_ms := coalesce(nullif(p_command->>'requestedAt', '')::bigint, observed_ms);
  cancel_payload := jsonb_strip_nulls(jsonb_build_object(
    'requestedAt', requested_ms,
    'reason', p_command->'reason',
    'requestedBy', p_command->'requestedBy',
    'billing', outcome->>'billing',
    'capability', outcome->>'capability',
    'workerReleaseExpected', case
      when prior_status = 'running' and coalesce((outcome->>'workerReleased')::boolean, false) then true
      else null
    end,
    -- Provider capability 不是投递证明。running Job 只有执行该 generation 的 Worker
    -- 退出后，或 DB clock 证明其 lease 已过期后，才允许 durable ack。
    'workerReleased', case
      when prior_status = 'running' then false
      else coalesce((outcome->>'workerReleased')::boolean, false)
    end,
    'code', outcome->>'code',
    'signalRequired', case when prior_status = 'running' then true else null end,
    'signalId', case when prior_status = 'running' then
      'generation-cancel:' || p_job_id || ':' || existing.execution_version::text || ':' || requested_ms::text
      else null
    end
  ));
  stored_payload := ((stored_payload - 'error') - 'errorCode') || jsonb_build_object(
    'status', 'cancelled',
    'updatedAt', observed_ms,
    'cancel', cancel_payload
  );
  if jsonb_typeof(existing.payload->'execution') = 'object' then
    execution_payload := existing.payload->'execution' || jsonb_build_object('settledAt', observed_ms);
    stored_payload := stored_payload || jsonb_build_object(
      'executionVersion', existing.execution_version,
      'execution', execution_payload
    );
  end if;
  update public.generation_jobs set
    status = 'cancelled',
    updated_at = observed_at,
    payload = stored_payload
  where id = p_job_id;
  return jsonb_build_object(
    'kind', 'cancelled', 'changed', true, 'priorStatus', prior_status, 'job', stored_payload
  );
end;
$$;

create or replace function public.botanic_acknowledge_generation_job_cancellation(
  p_owner_id uuid,
  p_job_id text,
  p_project_id text,
  p_command jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing public.generation_jobs%rowtype;
  stored_payload jsonb;
  cancel_payload jsonb;
  observed_at timestamptz;
  observed_ms bigint;
  generation bigint;
  release_basis text := p_command->>'releaseBasis';
begin
  if p_owner_id is null or nullif(btrim(p_job_id), '') is null
    or nullif(btrim(p_project_id), '') is null
    or jsonb_typeof(p_command) is distinct from 'object'
    or nullif(p_command->>'signalId', '') is null
    or nullif(p_command->>'executionGeneration', '') is null
    or p_command->>'executionGeneration' !~ '^[0-9]+$'
    or release_basis not in ('worker_exit', 'lease_expired') then
    raise exception 'invalid generation cancellation acknowledgement' using errcode = '22023';
  end if;
  generation := (p_command->>'executionGeneration')::bigint;

  perform pg_advisory_xact_lock(hashtextextended(p_job_id, 4));
  select * into existing from public.generation_jobs where id = p_job_id for update;
  if not found or existing.owner_id <> p_owner_id then
    return jsonb_build_object('kind', 'missing', 'changed', false);
  end if;
  stored_payload := existing.payload || jsonb_build_object(
    'id', existing.id,
    'ownerId', existing.owner_id::text,
    'projectId', existing.project_id,
    'status', existing.status::text,
    'executionVersion', existing.execution_version
  );
  if existing.project_id <> p_project_id then
    return jsonb_build_object('kind', 'conflict', 'changed', false, 'job', stored_payload);
  end if;
  if existing.status <> 'cancelled'
    or coalesce((stored_payload->'cancel'->>'signalRequired')::boolean, false) is not true then
    return jsonb_build_object('kind', 'replay', 'changed', false, 'job', stored_payload);
  end if;
  if stored_payload->'cancel'->>'signalId' is distinct from p_command->>'signalId'
    or existing.execution_version <> generation then
    return jsonb_build_object('kind', 'stale', 'changed', false, 'job', stored_payload);
  end if;
  if coalesce(nullif(stored_payload->'cancel'->>'signalAcknowledgedAt', '')::bigint, 0) > 0 then
    return jsonb_build_object('kind', 'replay', 'changed', false, 'job', stored_payload);
  end if;

  observed_at := clock_timestamp();
  observed_ms := floor(extract(epoch from observed_at) * 1000)::bigint;
  if release_basis = 'lease_expired'
    and (existing.lease_expires_at is null or existing.lease_expires_at > observed_at) then
    return jsonb_build_object('kind', 'pending', 'changed', false, 'job', stored_payload);
  end if;

  cancel_payload := stored_payload->'cancel' || jsonb_build_object(
    'workerReleased', true,
    'signalAcknowledgedAt', observed_ms,
    'releaseBasis', release_basis
  );
  stored_payload := stored_payload || jsonb_build_object(
    'updatedAt', observed_ms,
    'cancel', cancel_payload
  );
  update public.generation_jobs set
    updated_at = observed_at,
    payload = stored_payload
  where id = p_job_id;
  return jsonb_build_object('kind', 'acknowledged', 'changed', true, 'job', stored_payload);
end;
$$;

create or replace function public.botanic_compare_and_set_generation_job(
  p_owner_id uuid,
  p_job_id text,
  p_project_id text,
  p_command jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing public.generation_jobs%rowtype;
  stored_payload jsonb;
  next_payload jsonb;
  execution_payload jsonb;
  observed_at timestamptz;
  observed_ms bigint;
  expected_status text := p_command->>'expectedStatus';
  next_status text;
  expected_generation bigint;
  version bigint;
  clear_execution boolean := coalesce((p_command->>'clearExecution')::boolean, false);
begin
  if p_owner_id is null or nullif(btrim(p_job_id), '') is null
    or nullif(btrim(p_project_id), '') is null
    or jsonb_typeof(p_command) is distinct from 'object'
    or jsonb_typeof(p_command->'job') is distinct from 'object'
    or not (p_command ? 'expectedExecutionGeneration') then
    raise exception 'invalid generation compare-and-set' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_job_id, 4));
  select * into existing from public.generation_jobs where id = p_job_id for update;
  if not found or existing.owner_id <> p_owner_id then
    return jsonb_build_object('kind', 'missing', 'changed', false);
  end if;
  stored_payload := existing.payload || jsonb_build_object(
    'id', existing.id,
    'ownerId', existing.owner_id::text,
    'projectId', existing.project_id,
    'status', existing.status::text,
    'executionVersion', existing.execution_version
  );
  if existing.project_id <> p_project_id then
    return jsonb_build_object('kind', 'conflict', 'changed', false, 'job', stored_payload);
  end if;
  if p_command->'expectedExecutionGeneration' <> 'null'::jsonb then
    expected_generation := (p_command->>'expectedExecutionGeneration')::bigint;
  end if;
  if existing.status::text is distinct from expected_status
    or (expected_generation is null and jsonb_typeof(existing.payload->'execution') = 'object')
    or (expected_generation is not null and (
      jsonb_typeof(existing.payload->'execution') is distinct from 'object'
      or existing.execution_version <> expected_generation
      or nullif(existing.payload->'execution'->>'generation', '')::bigint is distinct from expected_generation
    )) then
    return jsonb_build_object('kind', 'stale', 'changed', false, 'job', stored_payload);
  end if;

  next_payload := p_command->'job';
  next_status := next_payload->>'status';
  if next_payload->>'id' is distinct from p_job_id
    or next_payload->>'projectId' is distinct from p_project_id
    or next_payload->>'ownerId' is distinct from p_owner_id::text
    or next_status not in ('queued', 'running', 'succeeded', 'failed', 'cancelled') then
    return jsonb_build_object('kind', 'conflict', 'changed', false, 'job', stored_payload);
  end if;
  if not (
    existing.status::text = next_status
    or (existing.status = 'queued' and next_status = 'failed')
    or (existing.status = 'running' and next_status = 'failed')
    or (existing.status in ('failed', 'cancelled') and next_status = 'queued' and clear_execution)
  ) then
    return jsonb_build_object('kind', 'conflict', 'changed', false, 'job', stored_payload);
  end if;

  observed_at := clock_timestamp();
  observed_ms := floor(extract(epoch from observed_at) * 1000)::bigint;
  version := greatest(
    existing.execution_version,
    coalesce(nullif(existing.payload->>'executionVersion', '')::bigint, 0),
    coalesce(nullif(existing.payload->'execution'->>'generation', '')::bigint, 0)
  );
  next_payload := next_payload || jsonb_build_object(
    'id', existing.id,
    'ownerId', existing.owner_id::text,
    'projectId', existing.project_id,
    'createdAt', stored_payload->'createdAt',
    'idempotencyKey', stored_payload->'idempotencyKey',
    'updatedAt', observed_ms
  );
  if version > 0 then
    next_payload := next_payload || jsonb_build_object('executionVersion', version);
  else
    next_payload := next_payload - 'executionVersion';
  end if;
  if clear_execution then
    next_payload := next_payload - 'execution';
  elsif jsonb_typeof(existing.payload->'execution') = 'object' then
    execution_payload := existing.payload->'execution';
    if next_status in ('succeeded', 'failed', 'cancelled') then
      execution_payload := execution_payload || jsonb_build_object(
        'settledAt', coalesce(nullif(execution_payload->>'settledAt', '')::bigint, observed_ms)
      );
    end if;
    next_payload := next_payload || jsonb_build_object('execution', execution_payload);
  else
    next_payload := next_payload - 'execution';
  end if;
  update public.generation_jobs set
    status = next_status::public.botanic_generation_status,
    updated_at = observed_at,
    execution_version = version,
    lease_token = case when clear_execution then null else existing.lease_token end,
    lease_expires_at = case when clear_execution then null else existing.lease_expires_at end,
    payload = next_payload
  where id = p_job_id;
  return jsonb_build_object('kind', 'updated', 'changed', true, 'job', next_payload);
end;
$$;

-- 普通 Agent Run 写入也必须按分支合并。调用方可能只重试 A 分支，却携带读取时
-- 的旧 B 快照；whole-row LWW 会把 B 的并发 Generation 终态覆盖掉。
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
  candidate_branch jsonb;
  stored_branch jsonb;
  chosen_branch jsonb;
  branches jsonb := '[]'::jsonb;
  stored_attempt integer;
  candidate_attempt integer;
  stored_updated_ms bigint;
  candidate_updated_ms bigint;
  stored_active_job_id text;
  candidate_active_job_id text;
  run_updated_ms bigint;
  max_branch_updated_ms bigint := 0;
  completed_count integer := 0;
  failed_count integer := 0;
  total_count integer := 0;
  running_count integer := 0;
  queued_count integer := 0;
  cancelled_count integer := 0;
  run_status text;
  next_payload jsonb;
begin
  select * into incoming
  from jsonb_to_record(p_run)
    as value(id text, owner_id uuid, project_id text, status text, updated_at timestamptz, payload jsonb);

  if incoming.id is null
    or incoming.project_id is null
    or incoming.status is null
    or incoming.updated_at is null
    or incoming.owner_id is distinct from p_owner_id
    or jsonb_typeof(incoming.payload) is distinct from 'object'
    or incoming.payload->>'id' is distinct from incoming.id
    or incoming.payload->>'ownerId' is distinct from p_owner_id::text
    or incoming.payload->>'projectId' is distinct from incoming.project_id
    or jsonb_typeof(incoming.payload->'branches') is distinct from 'array' then
    raise exception 'Invalid Agent run payload' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(incoming.id, 0));
  select * into existing from public.agent_runs where id = incoming.id for update;
  if not found then
    insert into public.agent_runs (id, owner_id, project_id, status, updated_at, payload)
    values (incoming.id, p_owner_id, incoming.project_id, incoming.status, incoming.updated_at, incoming.payload);
    return incoming.payload;
  end if;
  if existing.project_id <> incoming.project_id or existing.owner_id <> p_owner_id then
    raise exception 'Agent run id belongs to another project or owner' using errcode = '23505';
  end if;
  if jsonb_typeof(existing.payload->'branches') is distinct from 'array' then
    raise exception 'Invalid persisted Agent run branches' using errcode = '22023';
  end if;
  if existing.updated_at > incoming.updated_at
    or (existing.status <> 'awaiting_confirmation' and incoming.status = 'awaiting_confirmation') then
    return existing.payload;
  end if;

  for candidate_branch in
    select value from jsonb_array_elements(incoming.payload->'branches')
  loop
    if nullif(candidate_branch->>'id', '') is null then
      raise exception 'Invalid Agent run branch' using errcode = '22023';
    end if;
    stored_branch := null;
    select value into stored_branch
    from jsonb_array_elements(existing.payload->'branches')
    where value->>'id' = candidate_branch->>'id'
    limit 1;
    if stored_branch is null then
      chosen_branch := candidate_branch;
    else
      stored_attempt := coalesce(nullif(stored_branch->>'attempt', '')::integer, 0);
      candidate_attempt := coalesce(nullif(candidate_branch->>'attempt', '')::integer, 0);
      stored_updated_ms := coalesce(nullif(stored_branch->>'updatedAt', '')::bigint, 0);
      candidate_updated_ms := coalesce(nullif(candidate_branch->>'updatedAt', '')::bigint, 0);
      stored_active_job_id := nullif(stored_branch->>'activeJobId', '');
      candidate_active_job_id := nullif(candidate_branch->>'activeJobId', '');
      if stored_attempt > candidate_attempt then
        chosen_branch := stored_branch;
      elsif candidate_attempt > stored_attempt then
        chosen_branch := candidate_branch;
      elsif stored_active_job_id is not null
        and stored_active_job_id is distinct from candidate_active_job_id then
        chosen_branch := stored_branch;
      elsif stored_updated_ms > candidate_updated_ms then
        chosen_branch := stored_branch;
      elsif candidate_updated_ms > stored_updated_ms then
        chosen_branch := candidate_branch;
      elsif stored_branch->>'status' in ('succeeded', 'failed', 'cancelled')
        and candidate_branch->>'status' in ('queued', 'running') then
        chosen_branch := stored_branch;
      else
        chosen_branch := candidate_branch;
      end if;
    end if;
    branches := branches || jsonb_build_array(chosen_branch);
  end loop;

  for stored_branch in
    select value from jsonb_array_elements(existing.payload->'branches')
  loop
    if not exists (
      select 1
      from jsonb_array_elements(incoming.payload->'branches') as candidate(value)
      where candidate.value->>'id' = stored_branch->>'id'
    ) then
      branches := branches || jsonb_build_array(stored_branch);
    end if;
  end loop;

  select coalesce(max(coalesce(nullif(value->>'updatedAt', '')::bigint, 0)), 0)
  into max_branch_updated_ms
  from jsonb_array_elements(branches);
  run_updated_ms := greatest(
    coalesce(nullif(existing.payload->>'updatedAt', '')::bigint, 0),
    coalesce(nullif(incoming.payload->>'updatedAt', '')::bigint, 0),
    max_branch_updated_ms
  );

  select
    count(*) filter (where value->>'status' = 'succeeded'),
    count(*) filter (where value->>'status' in ('failed', 'cancelled')),
    count(*),
    count(*) filter (where value->>'status' = 'running'),
    count(*) filter (where value->>'status' = 'queued'),
    count(*) filter (where value->>'status' = 'cancelled')
  into completed_count, failed_count, total_count, running_count, queued_count, cancelled_count
  from jsonb_array_elements(branches);

  if total_count = 0 then
    run_status := incoming.status;
    next_payload := existing.payload || incoming.payload || jsonb_build_object(
      'branches', branches,
      'updatedAt', run_updated_ms
    );
  else
    if running_count > 0 then run_status := 'running';
    elsif queued_count > 0 then run_status := 'queued';
    elsif completed_count = total_count then run_status := 'completed';
    elsif completed_count > 0 then run_status := 'partial';
    elsif cancelled_count = total_count then run_status := 'cancelled';
    else run_status := 'failed';
    end if;
    next_payload := existing.payload || incoming.payload || jsonb_build_object(
      'branches', branches,
      'status', run_status,
      'completedBranchCount', completed_count,
      'failedBranchCount', failed_count,
      'updatedAt', run_updated_ms
    );
  end if;

  update public.agent_runs set
    status = run_status,
    updated_at = greatest(
      existing.updated_at,
      incoming.updated_at,
      to_timestamp(run_updated_ms::double precision / 1000.0)
    ),
    payload = next_payload
  where id = incoming.id;
  return next_payload;
end;
$$;

-- Generation Job 与 Agent Run 不在同一状态权威中：Job 先原子提交，再以这个
-- 行锁 RPC 只合并目标分支。不同 Worker 同时完成不同分支时不会用旧快照覆盖整条 Run。
create or replace function public.botanic_project_generation_job_to_agent_run(
  p_owner_id uuid,
  p_project_id text,
  p_job jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing public.agent_runs%rowtype;
  run_id text := nullif(btrim(p_job->'agentRun'->>'runId'), '');
  branch_id text := nullif(btrim(p_job->'agentRun'->>'branchId'), '');
  job_id text := nullif(btrim(p_job->>'id'), '');
  job_status text := p_job->>'status';
  job_updated_ms bigint;
  run_updated_ms bigint;
  prior_updated bigint;
  branch_payload jsonb;
  branches jsonb := '[]'::jsonb;
  job_ids jsonb;
  target_found boolean := false;
  projection_applied boolean := false;
  completed_count integer := 0;
  failed_count integer := 0;
  total_count integer := 0;
  running_count integer := 0;
  queued_count integer := 0;
  cancelled_count integer := 0;
  run_status text;
  next_payload jsonb;
begin
  if p_owner_id is null or nullif(btrim(p_project_id), '') is null
    or jsonb_typeof(p_job) is distinct from 'object'
    or run_id is null or branch_id is null or job_id is null
    or p_job->>'ownerId' is distinct from p_owner_id::text
    or p_job->>'projectId' is distinct from p_project_id
    or job_status is null
    or job_status not in ('queued', 'running', 'succeeded', 'failed', 'cancelled')
    or nullif(p_job->>'updatedAt', '') is null then
    raise exception 'invalid generation Agent Run projection' using errcode = '22023';
  end if;
  job_updated_ms := (p_job->>'updatedAt')::bigint;

  select * into existing from public.agent_runs where id = run_id for update;
  if not found then
    return null;
  end if;
  if existing.owner_id <> p_owner_id or existing.project_id <> p_project_id then
    raise exception 'generation Agent Run projection forbidden' using errcode = '42501';
  end if;
  if jsonb_typeof(existing.payload->'branches') is distinct from 'array' then
    raise exception 'invalid persisted Agent Run branches' using errcode = '22023';
  end if;

  for branch_payload in
    select value from jsonb_array_elements(existing.payload->'branches')
  loop
    if branch_payload->>'id' = branch_id then
      target_found := true;
      prior_updated := coalesce(nullif(branch_payload->>'updatedAt', '')::bigint, 0);
      -- Job RPC 先提交，因此 updatedAt 是 DB clock。迟到的 running 投影不得把
      -- 已发布的 terminal 分支倒退；同毫秒时 terminal 同样优先。
      if nullif(branch_payload->>'activeJobId', '') is not null
        and branch_payload->>'activeJobId' is distinct from job_id then
        -- 分支已切换到新 retry identity；旧 Job 即使 terminal 且时间戳更大，也只能
        -- 留在历史 Job 记录，不能夺回 active branch。
        null;
      elsif not (
        prior_updated > job_updated_ms
        or (
          prior_updated = job_updated_ms
          and branch_payload->>'status' in ('succeeded', 'failed', 'cancelled')
          and job_status in ('queued', 'running')
        )
      ) then
        projection_applied := true;
        job_ids := coalesce(branch_payload->'jobIds', '[]'::jsonb);
        if jsonb_typeof(job_ids) is distinct from 'array' then
          job_ids := '[]'::jsonb;
        end if;
        if not (job_ids @> jsonb_build_array(job_id)) then
          job_ids := job_ids || jsonb_build_array(job_id);
        end if;
        branch_payload := (branch_payload - 'error') || jsonb_build_object(
          'status', job_status,
          'activeJobId', job_id,
          'jobIds', job_ids,
          'outputCount', case
            when jsonb_typeof(p_job->'outputs') = 'array' then jsonb_array_length(p_job->'outputs')
            else coalesce(nullif(branch_payload->>'outputCount', '')::integer, 0)
          end,
          'updatedAt', job_updated_ms
        );
        if nullif(p_job->>'error', '') is not null then
          branch_payload := branch_payload || jsonb_build_object('error', p_job->>'error');
        end if;
      end if;
    end if;
    branches := branches || jsonb_build_array(branch_payload);
  end loop;
  if not target_found or not projection_applied then
    return existing.payload;
  end if;

  select
    count(*) filter (where value->>'status' = 'succeeded'),
    count(*) filter (where value->>'status' in ('failed', 'cancelled')),
    count(*),
    count(*) filter (where value->>'status' = 'running'),
    count(*) filter (where value->>'status' = 'queued'),
    count(*) filter (where value->>'status' = 'cancelled')
  into completed_count, failed_count, total_count, running_count, queued_count, cancelled_count
  from jsonb_array_elements(branches);

  if running_count > 0 then run_status := 'running';
  elsif queued_count > 0 then run_status := 'queued';
  elsif completed_count = total_count then run_status := 'completed';
  elsif completed_count > 0 then run_status := 'partial';
  elsif cancelled_count = total_count then run_status := 'cancelled';
  else run_status := 'failed';
  end if;
  run_updated_ms := greatest(
    coalesce(nullif(existing.payload->>'updatedAt', '')::bigint, 0),
    job_updated_ms
  );
  next_payload := existing.payload || jsonb_build_object(
    'branches', branches,
    'status', run_status,
    'completedBranchCount', completed_count,
    'failedBranchCount', failed_count,
    'updatedAt', run_updated_ms
  );
  update public.agent_runs set
    status = run_status,
    updated_at = greatest(existing.updated_at, to_timestamp(run_updated_ms::double precision / 1000.0)),
    payload = next_payload
  where id = run_id;
  return next_payload;
end;
$$;

create or replace function public.botanic_recover_stale_generation_jobs(
  p_stale_after_ms bigint default 90000
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  observed_at timestamptz := clock_timestamp();
  stale_after_ms bigint := greatest(30000, coalesce(p_stale_after_ms, 90000));
  jobs jsonb;
begin
  select coalesce(jsonb_agg(job.payload order by job.updated_at, job.id), '[]'::jsonb)
  into jobs
  from public.generation_jobs job
  where job.status = 'running'
    and (
      (job.lease_expires_at is not null and job.lease_expires_at <= observed_at)
      or (
        job.lease_expires_at is null
        and job.updated_at <= observed_at - (stale_after_ms::double precision * interval '1 millisecond')
      )
    );
  return jobs;
end;
$$;

revoke all on function public.botanic_put_generation_job_guarded(uuid, text, text, jsonb)
from public, anon, authenticated;
grant execute on function public.botanic_put_generation_job_guarded(uuid, text, text, jsonb)
to service_role;

revoke all on function public.botanic_claim_generation_job_execution(text, jsonb)
from public, anon, authenticated;
grant execute on function public.botanic_claim_generation_job_execution(text, jsonb)
to service_role;

revoke all on function public.botanic_commit_generation_job_execution(uuid, text, text, jsonb)
from public, anon, authenticated;
grant execute on function public.botanic_commit_generation_job_execution(uuid, text, text, jsonb)
to service_role;

revoke all on function public.botanic_cancel_generation_job_execution(uuid, text, text, jsonb)
from public, anon, authenticated;
grant execute on function public.botanic_cancel_generation_job_execution(uuid, text, text, jsonb)
to service_role;

revoke all on function public.botanic_acknowledge_generation_job_cancellation(uuid, text, text, jsonb)
from public, anon, authenticated;
grant execute on function public.botanic_acknowledge_generation_job_cancellation(uuid, text, text, jsonb)
to service_role;

revoke all on function public.botanic_compare_and_set_generation_job(uuid, text, text, jsonb)
from public, anon, authenticated;
grant execute on function public.botanic_compare_and_set_generation_job(uuid, text, text, jsonb)
to service_role;

revoke all on function public.botanic_put_agent_run(uuid, jsonb)
from public, anon, authenticated;
grant execute on function public.botanic_put_agent_run(uuid, jsonb)
to service_role;

revoke all on function public.botanic_project_generation_job_to_agent_run(uuid, text, jsonb)
from public, anon, authenticated;
grant execute on function public.botanic_project_generation_job_to_agent_run(uuid, text, jsonb)
to service_role;

revoke all on function public.botanic_recover_stale_generation_jobs(bigint)
from public, anon, authenticated;
grant execute on function public.botanic_recover_stale_generation_jobs(bigint)
to service_role;

commit;
