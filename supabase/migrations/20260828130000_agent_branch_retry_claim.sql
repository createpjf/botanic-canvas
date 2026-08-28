begin;

-- Run CAS 与新 Generation Job identity 共用一个事务。若先移动 activeJobId 再另行
-- put Job，普通 generation endpoint 可用同 user+key 抢占 jobId，留下 foreign orphan。
create or replace function public.botanic_claim_agent_branch_retry(
  p_owner_id uuid,
  p_command jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing public.agent_runs%rowtype;
  existing_job public.generation_jobs%rowtype;
  member_role public.botanic_project_role;
  run_id text := nullif(btrim(p_command->>'runId'), '');
  command_project_id text := nullif(btrim(p_command->>'projectId'), '');
  branch_id text := nullif(btrim(p_command->>'branchId'), '');
  expected_attempt integer;
  expected_active_job_id text := nullif(btrim(p_command->>'expectedActiveJobId'), '');
  job_id text := nullif(btrim(p_command->>'jobId'), '');
  request_binding jsonb := p_command->'idempotencyBinding';
  candidate_job jsonb := p_command->'job';
  authoritative_job jsonb;
  job_changed boolean := false;
  job_exists boolean := false;
  branch_payload jsonb;
  retry_claim jsonb;
  branch_attempt integer;
  job_ids jsonb;
  next_branch jsonb;
  branches jsonb;
  observed_at bigint;
  observed_timestamp timestamptz;
  run_status text;
  completed_count integer;
  failed_count integer;
  total_count integer;
  running_count integer;
  queued_count integer;
  cancelled_count integer;
  next_payload jsonb;
begin
  if p_owner_id is null or run_id is null or command_project_id is null or branch_id is null
    or expected_active_job_id is null or job_id is null
    or jsonb_typeof(p_command->'expectedAttempt') is distinct from 'number'
    or coalesce(p_command->>'expectedAttempt', '') !~ '^[0-9]+$'
    or jsonb_typeof(request_binding) is distinct from 'object'
    or request_binding->>'scope' is distinct from 'agent-branch.retry'
    or request_binding->>'projectId' is distinct from command_project_id
    or jsonb_typeof(candidate_job) is distinct from 'object' then
    raise exception 'invalid Agent branch retry claim' using errcode = '22023';
  end if;
  expected_attempt := (p_command->>'expectedAttempt')::integer;
  if expected_attempt < 0
    or candidate_job->>'id' is distinct from job_id
    or candidate_job->>'projectId' is distinct from command_project_id
    or candidate_job->>'status' is distinct from 'queued'
    or candidate_job->'idempotencyBinding' is distinct from request_binding
    or candidate_job->'agentRun'->>'runId' is distinct from run_id
    or candidate_job->'agentRun'->>'branchId' is distinct from branch_id
    or candidate_job->'agentRun'->>'attempt' is distinct from (expected_attempt + 1)::text
    or jsonb_typeof(candidate_job->'rawInput') is distinct from 'object'
    or (candidate_job ? 'ownerId' and candidate_job->>'ownerId' is distinct from p_owner_id::text) then
    raise exception 'invalid Agent branch retry Job identity' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(run_id, 0));
  select * into existing from public.agent_runs where id = run_id for update;
  if not found then
    return jsonb_build_object('kind', 'missing', 'changed', false);
  end if;
  if existing.owner_id is distinct from p_owner_id or existing.project_id is distinct from command_project_id then
    return jsonb_build_object('kind', 'conflict', 'changed', false);
  end if;
  select role into member_role from public.project_members
  where project_id = existing.project_id and user_id = p_owner_id
  for share;
  if member_role is null or member_role not in ('owner', 'editor') then
    raise exception 'Agent branch retry permission denied' using errcode = '42501';
  end if;
  if jsonb_typeof(existing.payload->'branches') is distinct from 'array' then
    raise exception 'invalid persisted Agent Run branches' using errcode = '22023';
  end if;

  -- 与 botanic_put_generation_job_guarded 共用 seed=4；跨 endpoint 首写只有一个赢家。
  perform pg_advisory_xact_lock(hashtextextended(job_id, 4));
  select * into existing_job from public.generation_jobs where id = job_id for update;
  job_exists := found;
  observed_timestamp := clock_timestamp();
  observed_at := floor(extract(epoch from observed_timestamp) * 1000)::bigint;
  candidate_job := candidate_job || jsonb_build_object(
    'ownerId', p_owner_id::text,
    'status', 'queued',
    'createdAt', observed_at,
    'updatedAt', observed_at,
    'outputs', '[]'::jsonb
  );
  candidate_job := candidate_job
    - 'execution' - 'executionVersion' - 'cancel' - 'error' - 'errorCode'
    - 'partialError' - 'projectWritebackPending';
  if job_exists then
    if existing_job.owner_id is distinct from p_owner_id
      or existing_job.project_id is distinct from command_project_id
      or existing_job.payload->'idempotencyBinding' is distinct from request_binding
      or existing_job.payload->'agentRun'->>'runId' is distinct from run_id
      or existing_job.payload->'agentRun'->>'branchId' is distinct from branch_id
      or existing_job.payload->'agentRun'->>'attempt' is distinct from (expected_attempt + 1)::text then
      return jsonb_build_object(
        'kind', 'job_conflict', 'changed', false,
        'run', existing.payload, 'job', existing_job.payload
      );
    end if;
    authoritative_job := existing_job.payload;
  else
    authoritative_job := candidate_job;
    job_changed := true;
  end if;

  select value into branch_payload
  from jsonb_array_elements(existing.payload->'branches')
  where value->>'id' = branch_id
  limit 1;
  if branch_payload is null then
    return jsonb_build_object('kind', 'conflict', 'changed', false, 'run', existing.payload);
  end if;
  branch_attempt := case
    when coalesce(branch_payload->>'attempt', '') ~ '^[0-9]+$'
      then (branch_payload->>'attempt')::integer
    else 0
  end;
  retry_claim := branch_payload->'retryClaim';
  if branch_payload->>'activeJobId' is not distinct from job_id
    and branch_attempt = expected_attempt + 1
    and retry_claim->>'sourceAttempt' is not distinct from expected_attempt::text
    and retry_claim->>'sourceJobId' is not distinct from expected_active_job_id
    and retry_claim->>'jobId' is not distinct from job_id
    and retry_claim->'idempotencyBinding' is not distinct from request_binding then
    if job_changed then
      insert into public.generation_jobs (
        id, owner_id, project_id, status, updated_at,
        execution_version, lease_token, lease_expires_at, payload
      ) values (
        job_id, p_owner_id, command_project_id, 'queued', observed_timestamp,
        0, null, null, authoritative_job
      );
    end if;
    return jsonb_build_object(
      'kind', 'replay', 'changed', job_changed,
      'run', existing.payload, 'job', authoritative_job
    );
  end if;
  if branch_attempt is distinct from expected_attempt
    or branch_payload->>'activeJobId' is distinct from expected_active_job_id
    or branch_payload->>'status' not in ('failed', 'cancelled') then
    return jsonb_build_object('kind', 'conflict', 'changed', false, 'run', existing.payload);
  end if;

  job_ids := case when jsonb_typeof(branch_payload->'jobIds') = 'array'
    then branch_payload->'jobIds' else '[]'::jsonb end;
  if not job_ids @> jsonb_build_array(job_id) then
    job_ids := job_ids || jsonb_build_array(job_id);
  end if;
  next_branch := (branch_payload || jsonb_build_object(
    'status', 'queued',
    'attempt', expected_attempt + 1,
    'activeJobId', job_id,
    'jobIds', job_ids,
    'outputCount', 0,
    'updatedAt', observed_at,
    'retryClaim', jsonb_build_object(
      'sourceAttempt', expected_attempt,
      'sourceJobId', expected_active_job_id,
      'jobId', job_id,
      'claimedAt', observed_at,
      'idempotencyBinding', request_binding
    )
  )) - 'error';
  select coalesce(jsonb_agg(
    case when value->>'id' = branch_id then next_branch else value end
    order by ordinality
  ), '[]'::jsonb)
  into branches
  from jsonb_array_elements(existing.payload->'branches') with ordinality as item(value, ordinality);

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
  next_payload := existing.payload || jsonb_build_object(
    'branches', branches,
    'status', run_status,
    'completedBranchCount', completed_count,
    'failedBranchCount', failed_count,
    'updatedAt', observed_at
  );
  if job_changed then
    insert into public.generation_jobs (
      id, owner_id, project_id, status, updated_at,
      execution_version, lease_token, lease_expires_at, payload
    ) values (
      job_id, p_owner_id, command_project_id, 'queued', observed_timestamp,
      0, null, null, authoritative_job
    );
  end if;
  update public.agent_runs set
    status = run_status,
    updated_at = observed_timestamp,
    payload = next_payload
  where id = run_id and owner_id = p_owner_id and project_id = command_project_id;
  return jsonb_build_object(
    'kind', 'claimed', 'changed', true,
    'run', next_payload, 'job', authoritative_job
  );
end;
$$;

revoke all on function public.botanic_claim_agent_branch_retry(uuid, jsonb)
from public, anon, authenticated;
grant execute on function public.botanic_claim_agent_branch_retry(uuid, jsonb) to service_role;

commit;
