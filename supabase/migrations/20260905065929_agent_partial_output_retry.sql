begin;

-- 缺图的成功 Job 投影为可重试的部分完成 Run。保留外层幂等绑定 wrapper、锁和原执行权限。
create or replace function public.botanic_put_agent_run_unbound(
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
    elsif completed_count > 0 or exists (
      select 1 from jsonb_array_elements(branches)
      where value->>'status' = 'failed'
        and coalesce(nullif(value->>'outputCount', '')::integer, 0) > 0
    ) then run_status := 'partial';
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
  job_error text := nullif(p_job->>'error', '');
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
  if job_status = 'succeeded' and coalesce(nullif(p_job->>'missingOutputCount', '')::integer, 0) > 0 then
    job_status := 'failed';
    job_error := coalesce(nullif(p_job->>'partialError', ''), '仍有图片未完成');
  end if;

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
        if job_error is not null then
          branch_payload := branch_payload || jsonb_build_object('error', job_error);
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
  elsif completed_count > 0 or exists (
      select 1 from jsonb_array_elements(branches)
      where value->>'status' = 'failed'
        and coalesce(nullif(value->>'outputCount', '')::integer, 0) > 0
    ) then run_status := 'partial';
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

commit;
