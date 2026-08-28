begin;

-- Review 取消是显式 durable 状态，不把 HTTP 断开解释为取消。running 先进入
-- cancelling，只有 generation-fenced Worker 退出或数据库确认租约过期后才收口。
alter table public.agent_review_tasks
  drop constraint if exists agent_review_tasks_status_check;
alter table public.agent_review_tasks
  add constraint agent_review_tasks_status_check
  check (status in ('queued', 'running', 'cancelling', 'completed', 'failed', 'cancelled'));

drop index if exists public.agent_review_tasks_pending_idx;
create index agent_review_tasks_pending_idx
  on public.agent_review_tasks (recovery_updated_at_ms asc, id collate "C" asc)
  where status in ('queued', 'running', 'cancelling');

create unique index if not exists agent_review_tasks_cancel_signal_unique
  on public.agent_review_tasks (project_id, ((payload->'cancel'->>'signalId')))
  where nullif(payload->'cancel'->>'signalId', '') is not null;

-- retry_once 必须是数据库约束，不只靠进程内判定；这样任何 Adapter/RPC 都无法
-- 写入第二条付费重试或让同一 idempotency key 绑定两种人工决议。
create or replace function public.botanic_valid_agent_review_reconciliation(p_value jsonb)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  retry_count integer;
  declared_retry_count integer;
  resolution_count integer;
begin
  if p_value is null then return true; end if;
  if jsonb_typeof(p_value) is distinct from 'object'
    or p_value->'version' is distinct from '1'::jsonb
    or jsonb_typeof(p_value->'retryCount') is distinct from 'number'
    or jsonb_typeof(p_value->'resolutions') is distinct from 'array' then
    return false;
  end if;
  declared_retry_count := (p_value->>'retryCount')::integer;
  resolution_count := jsonb_array_length(p_value->'resolutions');
  if declared_retry_count < 0 or declared_retry_count > 1 or resolution_count > 4 then
    return false;
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_value->'resolutions') resolution
    where jsonb_typeof(resolution) is distinct from 'object'
      or nullif(btrim(resolution->>'idempotencyKey'), '') is null
      or length(resolution->>'idempotencyKey') > 200
      or resolution->>'action' is null
      or resolution->>'action' not in ('continue_unverifiable', 'retry_once')
      or nullif(btrim(resolution->>'actorId'), '') is null
      or length(resolution->>'actorId') > 160
      or jsonb_typeof(resolution->'resolvedAt') is distinct from 'number'
      or (resolution->>'resolvedAt')::numeric <= 0
      or jsonb_typeof(resolution->'prior') is distinct from 'object'
      or resolution->'prior'->>'errorCode' is distinct from 'AGENT_REVIEW_OUTCOME_UNKNOWN'
      or jsonb_typeof(resolution->'prior'->'executionGeneration') is distinct from 'number'
      or (resolution->'prior'->>'executionGeneration')::numeric <= 0
      or jsonb_typeof(resolution->'prior'->'results') is distinct from 'array'
  ) then
    return false;
  end if;
  if (
    select count(*) from jsonb_array_elements(p_value->'resolutions') resolution
  ) <> (
    select count(distinct resolution->>'idempotencyKey')
    from jsonb_array_elements(p_value->'resolutions') resolution
  ) then
    return false;
  end if;
  select count(*) into retry_count
  from jsonb_array_elements(p_value->'resolutions') resolution
  where resolution->>'action' = 'retry_once';
  return retry_count = declared_retry_count and retry_count <= 1;
exception when others then
  return false;
end;
$$;

alter table public.agent_review_tasks
  drop constraint if exists agent_review_tasks_reconciliation_valid;
alter table public.agent_review_tasks
  add constraint agent_review_tasks_reconciliation_valid
  check (public.botanic_valid_agent_review_reconciliation(payload->'reconciliation'));

create or replace function public.botanic_request_agent_review_cancellation(
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
  cancel_payload jsonb;
  execution_payload jsonb;
  observed_at timestamptz;
  observed_ms bigint;
  generation bigint;
  requested_status text;
  result_kind text;
  signal_required boolean;
  requested_reason text := nullif(btrim(p_command->>'reason'), '');
begin
  if p_actor_id is null or nullif(btrim(p_task_id), '') is null
    or nullif(btrim(p_project_id), '') is null
    or jsonb_typeof(p_command) is distinct from 'object'
    or p_command->>'id' is distinct from p_task_id
    or p_command->>'projectId' is distinct from p_project_id
    or p_command->>'requestedBy' is distinct from p_actor_id::text
    or nullif(btrim(p_command->>'idempotencyKey'), '') is null
    or length(p_command->>'idempotencyKey') > 200
    or nullif(btrim(p_command->>'signalId'), '') is null
    or length(p_command->>'signalId') > 240
    or (p_command ? 'reason' and (
      requested_reason is null or length(requested_reason) > 500
    )) then
    raise exception 'invalid Agent Review cancellation request' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_task_id, 5));
  select * into existing from public.agent_review_tasks where id = p_task_id for update;
  if not found or existing.project_id <> p_project_id then
    return jsonb_build_object('kind', 'missing', 'changed', false);
  end if;
  if not exists (
    select 1 from public.project_members
    where project_id = p_project_id and user_id = p_actor_id
      and role::text in ('owner', 'editor')
  ) then
    raise exception 'Agent Review cancellation forbidden' using errcode = '42501';
  end if;

  generation := greatest(
    existing.execution_version,
    case when existing.payload->>'executionVersion' ~ '^[0-9]+$'
      then (existing.payload->>'executionVersion')::bigint else 0 end,
    case when existing.payload->'execution'->>'generation' ~ '^[0-9]+$'
      then (existing.payload->'execution'->>'generation')::bigint else 0 end
  );
  stored_payload := existing.payload || jsonb_strip_nulls(jsonb_build_object(
    'id', existing.id,
    'ownerId', existing.owner_id::text,
    'projectId', existing.project_id,
    'runId', existing.run_id,
    'status', existing.status,
    'executionVersion', case when generation > 0 or existing.payload ? 'executionVersion'
      then generation else null end
  ));

  if existing.status in ('cancelling', 'cancelled') then
    cancel_payload := stored_payload->'cancel';
    if jsonb_typeof(cancel_payload) is distinct from 'object'
      or cancel_payload->>'idempotencyKey' is distinct from btrim(p_command->>'idempotencyKey')
      or cancel_payload->>'signalId' is distinct from btrim(p_command->>'signalId')
      or cancel_payload->>'requestedBy' is distinct from p_actor_id::text
      or coalesce(cancel_payload->>'reason', '') is distinct from coalesce(requested_reason, '') then
      return jsonb_build_object('kind', 'conflict', 'changed', false, 'task', stored_payload);
    end if;
    return jsonb_build_object(
      'kind', case when existing.status = 'cancelled' then 'replay' else 'cancelling' end,
      'changed', false,
      'task', stored_payload
    );
  end if;
  if existing.status in ('completed', 'failed') then
    return jsonb_build_object('kind', 'terminal', 'changed', false, 'task', stored_payload);
  end if;
  if existing.status not in ('queued', 'running') then
    return jsonb_build_object('kind', 'conflict', 'changed', false, 'task', stored_payload);
  end if;

  signal_required := existing.status = 'running';
  if signal_required and (generation < 1 or nullif(existing.lease_token, '') is null) then
    return jsonb_build_object('kind', 'conflict', 'changed', false, 'task', stored_payload);
  end if;
  observed_at := clock_timestamp();
  observed_ms := floor(extract(epoch from observed_at) * 1000)::bigint;
  cancel_payload := jsonb_strip_nulls(jsonb_build_object(
    'version', 1,
    'idempotencyKey', btrim(p_command->>'idempotencyKey'),
    'signalId', btrim(p_command->>'signalId'),
    'requestedAt', observed_ms,
    'requestedBy', p_actor_id::text,
    'reason', requested_reason,
    'executionGeneration', generation,
    'signalRequired', signal_required,
    'workerReleased', not signal_required,
    'signalAcknowledgedAt', case when signal_required then null else observed_ms end,
    'releaseBasis', case when signal_required then null else 'not_started' end
  ));
  requested_status := case when signal_required then 'cancelling' else 'cancelled' end;
  result_kind := requested_status;
  stored_payload := (stored_payload || jsonb_build_object(
    'status', requested_status,
    'cancel', cancel_payload,
    'updatedAt', greatest(
      case when stored_payload->>'updatedAt' ~ '^[0-9]+$'
        then (stored_payload->>'updatedAt')::bigint else 0 end,
      observed_ms
    )
  )) - 'error';
  if not signal_required and jsonb_typeof(stored_payload->'execution') = 'object' then
    execution_payload := stored_payload->'execution';
    if not (execution_payload->>'settledAt' ~ '^[0-9]+$') then
      execution_payload := execution_payload || jsonb_build_object('settledAt', observed_ms);
    end if;
    stored_payload := stored_payload || jsonb_build_object('execution', execution_payload);
  end if;

  update public.agent_review_tasks set
    status = requested_status,
    updated_at = observed_at,
    payload = stored_payload
  where id = p_task_id;
  insert into public.audit_events (id, actor_id, action, project_id, target_id, detail, created_at)
  values (
    'audit_agent_review_cancel_' || md5(p_task_id || ':' || cancel_payload->>'signalId'),
    p_actor_id,
    'agent-review.' || requested_status,
    p_project_id,
    p_task_id,
    jsonb_build_object('signalId', cancel_payload->>'signalId', 'executionGeneration', generation),
    observed_at
  ) on conflict (id) do nothing;
  return jsonb_build_object('kind', result_kind, 'changed', true, 'task', stored_payload);
end;
$$;

create or replace function public.botanic_finalize_agent_review_cancellation(
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
  cancel_payload jsonb;
  execution_payload jsonb;
  observed_at timestamptz;
  observed_ms bigint;
  generation bigint;
  requested_generation bigint;
  proof_kind text;
begin
  if p_owner_id is null or nullif(btrim(p_task_id), '') is null
    or nullif(btrim(p_project_id), '') is null
    or jsonb_typeof(p_command) is distinct from 'object'
    or p_command->>'id' is distinct from p_task_id
    or p_command->>'projectId' is distinct from p_project_id
    or nullif(btrim(p_command->>'signalId'), '') is null
    or length(p_command->>'signalId') > 240
    or jsonb_typeof(p_command->'executionGeneration') is distinct from 'number'
    or jsonb_typeof(p_command->'proof') is distinct from 'object' then
    raise exception 'invalid Agent Review cancellation finalization' using errcode = '22023';
  end if;
  requested_generation := (p_command->>'executionGeneration')::bigint;
  proof_kind := p_command->'proof'->>'kind';
  if requested_generation < 1 or proof_kind is null
    or proof_kind not in ('worker_exit', 'lease_expired') then
    raise exception 'invalid Agent Review cancellation proof' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_task_id, 5));
  select * into existing from public.agent_review_tasks where id = p_task_id for update;
  if not found or existing.owner_id <> p_owner_id or existing.project_id <> p_project_id then
    return jsonb_build_object('kind', 'missing', 'changed', false);
  end if;
  generation := greatest(
    existing.execution_version,
    case when existing.payload->>'executionVersion' ~ '^[0-9]+$'
      then (existing.payload->>'executionVersion')::bigint else 0 end,
    case when existing.payload->'execution'->>'generation' ~ '^[0-9]+$'
      then (existing.payload->'execution'->>'generation')::bigint else 0 end
  );
  stored_payload := existing.payload || jsonb_build_object(
    'id', existing.id,
    'ownerId', existing.owner_id::text,
    'projectId', existing.project_id,
    'runId', existing.run_id,
    'status', existing.status,
    'executionVersion', generation
  );
  cancel_payload := stored_payload->'cancel';

  if existing.status = 'cancelled' then
    return jsonb_build_object(
      'kind', case when cancel_payload->>'signalId' = btrim(p_command->>'signalId')
        and case when cancel_payload->>'executionGeneration' ~ '^[0-9]+$'
          then (cancel_payload->>'executionGeneration')::bigint else 0 end = requested_generation
        then 'replay' else 'stale' end,
      'changed', false,
      'task', stored_payload
    );
  end if;
  if existing.status <> 'cancelling' then
    return jsonb_build_object(
      'kind', case when existing.status in ('completed', 'failed') then 'terminal' else 'stale' end,
      'changed', false,
      'task', stored_payload
    );
  end if;
  if jsonb_typeof(cancel_payload) is distinct from 'object'
    or cancel_payload->'signalRequired' is distinct from 'true'::jsonb
    or cancel_payload->>'signalId' is distinct from btrim(p_command->>'signalId')
    or not (cancel_payload->>'executionGeneration' ~ '^[0-9]+$')
    or (cancel_payload->>'executionGeneration')::bigint <> requested_generation
    or generation <> requested_generation then
    return jsonb_build_object('kind', 'stale', 'changed', false, 'task', stored_payload);
  end if;

  observed_at := clock_timestamp();
  observed_ms := floor(extract(epoch from observed_at) * 1000)::bigint;
  if not (cancel_payload->>'requestedAt' ~ '^[0-9]+$')
    or (cancel_payload->>'requestedAt')::bigint > observed_ms then
    return jsonb_build_object('kind', 'conflict', 'changed', false, 'task', stored_payload);
  end if;
  if proof_kind = 'worker_exit' then
    if nullif(btrim(p_command->'proof'->>'leaseToken'), '') is null
      or length(p_command->'proof'->>'leaseToken') > 240
      or p_command->'proof'->>'leaseToken' is distinct from existing.lease_token then
      return jsonb_build_object('kind', 'stale', 'changed', false, 'task', stored_payload);
    end if;
  else
    if existing.lease_expires_at is null then
      return jsonb_build_object('kind', 'conflict', 'changed', false, 'task', stored_payload);
    end if;
    if existing.lease_expires_at > observed_at then
      return jsonb_build_object('kind', 'pending', 'changed', false, 'task', stored_payload);
    end if;
  end if;

  cancel_payload := cancel_payload || jsonb_build_object(
    'workerReleased', true,
    'signalAcknowledgedAt', observed_ms,
    'releaseBasis', proof_kind
  );
  execution_payload := coalesce(stored_payload->'execution', '{}'::jsonb);
  if not (execution_payload->>'settledAt' ~ '^[0-9]+$') then
    execution_payload := execution_payload || jsonb_build_object('settledAt', observed_ms);
  end if;
  stored_payload := (stored_payload || jsonb_build_object(
    'status', 'cancelled',
    'cancel', cancel_payload,
    'execution', execution_payload,
    'updatedAt', greatest(
      case when stored_payload->>'updatedAt' ~ '^[0-9]+$'
        then (stored_payload->>'updatedAt')::bigint else 0 end,
      observed_ms
    )
  )) - 'error';
  update public.agent_review_tasks set
    status = 'cancelled',
    updated_at = observed_at,
    payload = stored_payload
  where id = p_task_id;
  insert into public.audit_events (id, actor_id, action, project_id, target_id, detail, created_at)
  values (
    'audit_agent_review_cancelled_' || md5(p_task_id || ':' || cancel_payload->>'signalId'),
    p_owner_id,
    'agent-review.cancelled',
    p_project_id,
    p_task_id,
    jsonb_build_object('releaseBasis', proof_kind, 'executionGeneration', generation),
    observed_at
  ) on conflict (id) do nothing;
  return jsonb_build_object('kind', 'cancelled', 'changed', true, 'task', stored_payload);
exception when invalid_text_representation or numeric_value_out_of_range then
  return jsonb_build_object('kind', 'conflict', 'changed', false, 'task', stored_payload);
end;
$$;

create or replace function public.botanic_resolve_agent_review_outcome_unknown(
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
  reconciliation_payload jsonb;
  resolutions_payload jsonb;
  resolution_payload jsonb;
  prior_payload jsonb;
  prior_results jsonb;
  checkpoint_payload jsonb;
  execution_payload jsonb;
  results_payload jsonb;
  result_payload jsonb;
  observed_at timestamptz;
  observed_ms bigint;
  generation bigint;
  retry_count integer;
  action text := p_command->>'action';
  idempotency_key text := nullif(btrim(p_command->>'idempotencyKey'), '');
  checkpoint_state text;
  next_status text;
begin
  if p_actor_id is null or nullif(btrim(p_task_id), '') is null
    or nullif(btrim(p_project_id), '') is null
    or jsonb_typeof(p_command) is distinct from 'object'
    or p_command->>'id' is distinct from p_task_id
    or p_command->>'projectId' is distinct from p_project_id
    or p_command->>'actorId' is distinct from p_actor_id::text
    or idempotency_key is null or length(idempotency_key) > 200
    or action is null or action not in ('continue_unverifiable', 'retry_once') then
    raise exception 'invalid Agent Review reconciliation command' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_task_id, 5));
  select * into existing from public.agent_review_tasks where id = p_task_id for update;
  if not found or existing.project_id <> p_project_id then
    return jsonb_build_object('kind', 'missing', 'changed', false);
  end if;
  if not exists (
    select 1 from public.project_members
    where project_id = p_project_id and user_id = p_actor_id
      and role::text in ('owner', 'editor')
  ) then
    raise exception 'Agent Review reconciliation forbidden' using errcode = '42501';
  end if;
  -- retry_once 会再次调用付费 Provider，因此 Store 层再次校验 create-generation；
  -- 当前权限矩阵中 owner/editor 拥有该能力，不能只依赖 HTTP route 的预检。
  if action = 'retry_once' and not exists (
    select 1 from public.project_members
    where project_id = p_project_id and user_id = p_actor_id
      and role::text in ('owner', 'editor')
  ) then
    raise exception 'Agent Review retry generation forbidden' using errcode = '42501';
  end if;

  generation := greatest(
    existing.execution_version,
    case when existing.payload->>'executionVersion' ~ '^[0-9]+$'
      then (existing.payload->>'executionVersion')::bigint else 0 end,
    case when existing.payload->'execution'->>'generation' ~ '^[0-9]+$'
      then (existing.payload->'execution'->>'generation')::bigint else 0 end
  );
  stored_payload := existing.payload || jsonb_build_object(
    'id', existing.id,
    'ownerId', existing.owner_id::text,
    'projectId', existing.project_id,
    'runId', existing.run_id,
    'status', existing.status,
    'executionVersion', generation
  );
  reconciliation_payload := coalesce(stored_payload->'reconciliation', jsonb_build_object(
    'version', 1, 'retryCount', 0, 'resolutions', '[]'::jsonb
  ));
  if not public.botanic_valid_agent_review_reconciliation(reconciliation_payload) then
    return jsonb_build_object('kind', 'conflict', 'changed', false, 'task', stored_payload);
  end if;
  resolutions_payload := reconciliation_payload->'resolutions';
  select resolution into resolution_payload
  from jsonb_array_elements(resolutions_payload) resolution
  where resolution->>'idempotencyKey' = idempotency_key
  limit 1;
  if resolution_payload is not null then
    return jsonb_build_object(
      'kind', case when resolution_payload->>'action' = action
        and resolution_payload->>'actorId' = p_actor_id::text then 'replay' else 'conflict' end,
      'changed', false,
      'task', stored_payload
    );
  end if;
  if existing.status <> 'failed'
    or stored_payload->'error'->>'code' is distinct from 'AGENT_REVIEW_OUTCOME_UNKNOWN' then
    return jsonb_build_object('kind', 'not_reconcilable', 'changed', false, 'task', stored_payload);
  end if;
  if generation < 1 then
    return jsonb_build_object('kind', 'conflict', 'changed', false, 'task', stored_payload);
  end if;
  retry_count := (reconciliation_payload->>'retryCount')::integer;
  if action = 'retry_once' and retry_count >= 1 then
    return jsonb_build_object('kind', 'retry_limit', 'changed', false, 'task', stored_payload);
  end if;

  observed_at := clock_timestamp();
  observed_ms := floor(extract(epoch from observed_at) * 1000)::bigint;
  checkpoint_payload := stored_payload->'execution'->'checkpoint';
  checkpoint_state := case
    when checkpoint_payload is null then 'missing'
    when public.botanic_valid_agent_review_checkpoint(checkpoint_payload) then 'prepared'
    else 'invalid'
  end;
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'id', result->>'id',
    'artifactId', result->>'artifactId',
    'verdict', nullif(btrim(result->>'verdict'), '')
  )) order by ordinal), '[]'::jsonb)
  into prior_results
  from jsonb_array_elements(case when jsonb_typeof(stored_payload->'results') = 'array'
    then stored_payload->'results' else '[]'::jsonb end)
    with ordinality rows(result, ordinal)
  where nullif(btrim(result->>'id'), '') is not null
    and length(result->>'id') <= 200
    and nullif(btrim(result->>'artifactId'), '') is not null
    and length(result->>'artifactId') <= 240
    and result->>'taskId' = existing.id
    and result->>'projectId' = existing.project_id;
  prior_payload := jsonb_strip_nulls(jsonb_build_object(
    'status', existing.status,
    'errorCode', 'AGENT_REVIEW_OUTCOME_UNKNOWN',
    'executionGeneration', generation,
    'checkpointState', checkpoint_state,
    'checkpointArtifactId', case when checkpoint_state = 'prepared'
      then checkpoint_payload->>'artifactId' else null end,
    'results', prior_results
  ));
  resolution_payload := jsonb_build_object(
    'idempotencyKey', idempotency_key,
    'action', action,
    'actorId', p_actor_id::text,
    'resolvedAt', observed_ms,
    'prior', prior_payload
  );
  if action = 'retry_once' then
    resolution_payload := resolution_payload || jsonb_build_object('risk', jsonb_build_object(
      'code', 'AGENT_REVIEW_RETRY_MAY_DUPLICATE_PROVIDER_CALL',
      'acknowledged', true,
      'message', '此前 Provider 是否执行成功未知；再次调用可能产生重复评审或重复计费。'
    ));
  end if;
  reconciliation_payload := jsonb_build_object(
    'version', 1,
    'retryCount', retry_count + case when action = 'retry_once' then 1 else 0 end,
    'resolutions', resolutions_payload || jsonb_build_array(resolution_payload)
  );
  execution_payload := coalesce(stored_payload->'execution', '{}'::jsonb) - 'checkpoint';
  if not (execution_payload->>'settledAt' ~ '^[0-9]+$') then
    execution_payload := execution_payload || jsonb_build_object('settledAt', observed_ms);
  end if;

  results_payload := case when jsonb_typeof(stored_payload->'results') = 'array'
    then stored_payload->'results' else '[]'::jsonb end;
  if action = 'continue_unverifiable' then
    if checkpoint_state <> 'prepared'
      or not exists (
        select 1 from jsonb_array_elements_text(case
          when jsonb_typeof(stored_payload->'coverage'->'artifactIds') = 'array'
            then stored_payload->'coverage'->'artifactIds' else '[]'::jsonb end
        ) covered(artifact_id)
        where covered.artifact_id = checkpoint_payload->>'artifactId'
      )
      or public.botanic_agent_review_has_result(
        stored_payload, existing.id, checkpoint_payload->>'artifactId'
      ) then
      return jsonb_build_object('kind', 'conflict', 'changed', false, 'task', stored_payload);
    end if;
    result_payload := jsonb_build_object(
      'id', 'review_result_' || left(public.botanic_sha256_base64url(
        existing.id || ':' || checkpoint_payload->>'artifactId'
      ), 32),
      'taskId', existing.id,
      'projectId', existing.project_id,
      'artifactId', checkpoint_payload->>'artifactId',
      'qualityPolicyFingerprint', stored_payload->>'qualityPolicyFingerprint',
      'criteria', jsonb_build_array(jsonb_build_object(
        'id', 'provider_outcome',
        'layer', 'human',
        'verdict', 'unverifiable',
        'evidence', 'Provider 调用结果未知；人工选择不重复调用，并保留为无法验证。'
      )),
      'verdict', 'unverifiable',
      'candidateStatus', 'pending_human',
      'createdAt', observed_ms,
      'updatedAt', observed_ms,
      'source', 'human_resolution',
      'resolution', jsonb_build_object(
        'kind', 'human_resolution',
        'action', 'continue_unverifiable',
        'reasonCode', 'AGENT_REVIEW_OUTCOME_UNKNOWN',
        'resolvedBy', p_actor_id::text,
        'resolvedAt', observed_ms
      )
    );
    results_payload := results_payload || jsonb_build_array(result_payload);
    next_status := case when not exists (
      select 1 from jsonb_array_elements_text(case
        when jsonb_typeof(stored_payload->'coverage'->'artifactIds') = 'array'
          then stored_payload->'coverage'->'artifactIds' else '[]'::jsonb end
      ) covered(artifact_id)
      where not exists (
        select 1 from jsonb_array_elements(results_payload) result
        where result->>'taskId' = existing.id
          and result->>'projectId' = existing.project_id
          and result->>'artifactId' = covered.artifact_id
      )
    ) then 'completed' else 'queued' end;
  else
    next_status := 'queued';
  end if;

  stored_payload := (stored_payload || jsonb_build_object(
    'status', next_status,
    'results', results_payload,
    'reconciliation', reconciliation_payload,
    'execution', execution_payload,
    'updatedAt', greatest(
      case when stored_payload->>'updatedAt' ~ '^[0-9]+$'
        then (stored_payload->>'updatedAt')::bigint else 0 end,
      observed_ms
    )
  )) - 'error';
  update public.agent_review_tasks set
    status = next_status,
    updated_at = observed_at,
    payload = stored_payload
  where id = p_task_id;
  insert into public.audit_events (id, actor_id, action, project_id, target_id, detail, created_at)
  values (
    'audit_agent_review_reconcile_' || md5(p_task_id || ':' || idempotency_key),
    p_actor_id,
    'agent-review.reconciled',
    p_project_id,
    p_task_id,
    jsonb_build_object('action', action, 'status', next_status, 'executionGeneration', generation),
    observed_at
  ) on conflict (id) do nothing;
  return jsonb_build_object('kind', 'resolved', 'changed', true, 'task', stored_payload);
exception when invalid_text_representation or numeric_value_out_of_range then
  return jsonb_build_object('kind', 'conflict', 'changed', false, 'task', stored_payload);
end;
$$;

-- Cancelling 任务也必须被 keyset Worker 看见，否则 Worker 崩溃后永远无法用
-- lease_expired 证明收口。
create or replace function public.botanic_list_pending_agent_review_tasks(
  p_older_than_ms bigint,
  p_after_updated_at_ms bigint default null,
  p_after_id text default null,
  p_limit integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  normalized_limit integer := greatest(1, least(coalesce(p_limit, 25), 200));
  result jsonb;
begin
  if p_older_than_ms is null or p_older_than_ms < 0
    or (p_after_updated_at_ms is null) <> (p_after_id is null)
    or (p_after_updated_at_ms is not null and p_after_updated_at_ms < 0)
    or (p_after_id is not null and btrim(p_after_id) = '') then
    raise exception 'invalid pending review task cursor' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(
    candidate.payload order by candidate.updated_at_ms, candidate.id collate "C"
  ), '[]'::jsonb)
  into result
  from (
    select
      task.id,
      task.recovery_updated_at_ms as updated_at_ms,
      task.payload || jsonb_build_object(
        'id', task.id,
        'updatedAt', task.recovery_updated_at_ms
      ) as payload
    from public.agent_review_tasks task
    where task.status in ('queued', 'running', 'cancelling')
      and task.recovery_updated_at_ms <= p_older_than_ms
      and (
        p_after_updated_at_ms is null
        or (task.recovery_updated_at_ms, task.id collate "C")
          > (p_after_updated_at_ms, p_after_id collate "C")
      )
    order by task.recovery_updated_at_ms asc, task.id collate "C" asc
    limit normalized_limit
  ) candidate;
  return result;
end;
$$;

revoke all on function public.botanic_valid_agent_review_reconciliation(jsonb)
  from public, anon, authenticated;
revoke all on function public.botanic_request_agent_review_cancellation(uuid, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.botanic_finalize_agent_review_cancellation(uuid, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.botanic_resolve_agent_review_outcome_unknown(uuid, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.botanic_list_pending_agent_review_tasks(bigint, bigint, text, integer)
  from public, anon, authenticated;

grant execute on function public.botanic_request_agent_review_cancellation(uuid, text, text, jsonb)
  to service_role;
grant execute on function public.botanic_valid_agent_review_reconciliation(jsonb)
  to service_role;
grant execute on function public.botanic_finalize_agent_review_cancellation(uuid, text, text, jsonb)
  to service_role;
grant execute on function public.botanic_resolve_agent_review_outcome_unknown(uuid, text, text, jsonb)
  to service_role;
grant execute on function public.botanic_list_pending_agent_review_tasks(bigint, bigint, text, integer)
  to service_role;

commit;
