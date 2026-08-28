begin;

-- 显式取消先写 durable fence。只有仍持有 generation + leaseToken 的 running
-- executor 需要跨实例 signal/exit ack；queued、waiting_user、completed 没有活跃
-- 执行者，深取消可以直接进入后续收口。
create or replace function public.botanic_request_agent_turn_cancellation(
  p_owner_id uuid,
  p_turn_id text,
  p_project_id text,
  p_request jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  existing public.agent_turns%rowtype;
  existing_event public.agent_turn_events%rowtype;
  member_role public.botanic_project_role;
  observed_at timestamptz;
  observed_ms bigint;
  stored_payload jsonb;
  cancellation_payload jsonb;
  event_payload jsonb;
  stored_event jsonb;
  authoritative_last_sequence integer;
  next_sequence integer;
  reason text;
  active_executor boolean;
begin
  if p_owner_id is null or nullif(p_turn_id, '') is null or nullif(p_project_id, '') is null
    or jsonb_typeof(p_request) is distinct from 'object' then
    raise exception 'Invalid Agent Turn cancellation' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_turn_id, 3));
  select * into existing from public.agent_turns where id = p_turn_id for update;
  if existing.id is null or existing.owner_id <> p_owner_id or existing.project_id <> p_project_id then
    raise exception 'Agent Turn not found' using errcode = 'PAT02';
  end if;

  select member.role into member_role
  from public.project_members as member
  where member.project_id = p_project_id and member.user_id = p_owner_id
  for share;
  if member_role is null or member_role not in ('owner', 'editor', 'viewer') then
    raise exception 'Agent Turn cancellation forbidden' using errcode = '42501';
  end if;

  event_payload := p_request->'event';
  if existing.status in ('failed', 'cancelled', 'cancelling') then
    -- 首次事务已提交但响应丢失时，原事件与原 Turn 一起回读，绝不创建第二个事件。
    if jsonb_typeof(event_payload) = 'object' and nullif(event_payload->>'id', '') is not null then
      select * into existing_event from public.agent_turn_events where id = event_payload->>'id' for update;
      if existing_event.id is not null then
        if existing_event.turn_id <> p_turn_id or existing_event.project_id <> p_project_id
          or existing_event.type <> 'turn.cancelling' then
          raise exception 'Agent Turn event conflict' using errcode = 'PAT03';
        end if;
        stored_event := jsonb_build_object(
          'id', existing_event.id, 'turnId', existing_event.turn_id,
          'ownerId', existing_event.owner_id, 'projectId', existing_event.project_id,
          'sequence', existing_event.sequence, 'type', existing_event.type,
          'createdAt', floor(extract(epoch from existing_event.created_at) * 1000)::bigint,
          'executionGeneration', existing_event.execution_version,
          'payload', existing_event.payload
        );
      end if;
    end if;
    return jsonb_strip_nulls(jsonb_build_object(
      'kind', 'replay', 'turn', existing.payload, 'event', stored_event
    ));
  end if;
  if existing.status not in ('queued', 'running', 'waiting_user', 'completed') then
    raise exception 'Invalid Agent Turn cancellation state' using errcode = '22023';
  end if;

  observed_at := clock_timestamp();
  observed_ms := floor(extract(epoch from observed_at) * 1000)::bigint;
  reason := left(coalesce(nullif(btrim(p_request->>'reason'), ''), '用户取消了 Agent 回合。'), 500);
  active_executor := existing.status = 'running'
    and existing.execution_version > 0
    and existing.lease_token is not null
    and nullif(btrim(existing.lease_token), '') is not null
    and existing.lease_expires_at is not null
    and extract(epoch from existing.lease_expires_at) > 0;
  cancellation_payload := jsonb_build_object(
    'status', 'requested',
    'requestedAt', observed_ms,
    'reason', 'user'
  );
  if active_executor then
    cancellation_payload := cancellation_payload || jsonb_build_object(
      'signalRequired', true,
      'signalId', 'agent-turn-cancel:' || p_turn_id || ':' || existing.execution_version::text || ':' || observed_ms::text,
      'executionGeneration', existing.execution_version,
      'workerReleased', false
    );
  end if;
  stored_payload := (existing.payload || jsonb_build_object(
    'status', 'cancelling',
    'updatedAt', observed_ms,
    'error', jsonb_build_object('code', 'AGENT_TURN_CANCELLED', 'message', reason),
    'cancellation', cancellation_payload
  )) - 'result';

  authoritative_last_sequence := existing.last_sequence;
  if event_payload is not null and jsonb_typeof(event_payload) <> 'null' then
    if jsonb_typeof(event_payload) <> 'object'
      or nullif(event_payload->>'id', '') is null
      or event_payload->>'turnId' is distinct from p_turn_id
      or event_payload->>'projectId' is distinct from p_project_id
      or event_payload->>'type' is distinct from 'turn.cancelling' then
      raise exception 'Invalid Agent Turn cancellation event' using errcode = '22023';
    end if;
    select * into existing_event from public.agent_turn_events where id = event_payload->>'id' for update;
    if existing_event.id is not null then
      if existing_event.turn_id <> p_turn_id or existing_event.project_id <> p_project_id
        or existing_event.type <> 'turn.cancelling' then
        raise exception 'Agent Turn event conflict' using errcode = 'PAT03';
      end if;
      authoritative_last_sequence := greatest(authoritative_last_sequence, existing_event.sequence);
      stored_event := jsonb_build_object(
        'id', existing_event.id, 'turnId', existing_event.turn_id,
        'ownerId', existing_event.owner_id, 'projectId', existing_event.project_id,
        'sequence', existing_event.sequence, 'type', existing_event.type,
        'createdAt', floor(extract(epoch from existing_event.created_at) * 1000)::bigint,
        'executionGeneration', existing_event.execution_version,
        'payload', existing_event.payload
      );
    else
      select greatest(authoritative_last_sequence, coalesce(max(sequence), 0))::integer
        into authoritative_last_sequence
      from public.agent_turn_events where turn_id = p_turn_id;
      next_sequence := authoritative_last_sequence + 1;
      insert into public.agent_turn_events (
        id, turn_id, owner_id, project_id, sequence, type, created_at, payload, execution_version
      ) values (
        event_payload->>'id', p_turn_id, p_owner_id, p_project_id, next_sequence,
        'turn.cancelling', observed_at, event_payload->'payload', existing.execution_version
      );
      authoritative_last_sequence := next_sequence;
      stored_event := jsonb_strip_nulls(event_payload || jsonb_build_object(
        'ownerId', p_owner_id::text, 'projectId', p_project_id,
        'sequence', next_sequence, 'createdAt', observed_ms,
        'executionGeneration', existing.execution_version
      ));
    end if;
    stored_payload := stored_payload || jsonb_build_object('lastSequence', authoritative_last_sequence);
  end if;

  update public.agent_turns set
    status = 'cancelling', updated_at = observed_at,
    payload = stored_payload, last_sequence = authoritative_last_sequence
  where id = p_turn_id;
  insert into public.audit_events (id, actor_id, action, project_id, target_id, detail)
  values (
    'audit_agent_turn_cancel_' || md5(p_turn_id), p_owner_id,
    'agent-turn.cancelling', p_project_id, p_turn_id,
    jsonb_build_object('executionGeneration', existing.execution_version)
  ) on conflict (id) do nothing;

  return jsonb_strip_nulls(jsonb_build_object(
    'kind', 'requested', 'turn', stored_payload, 'event', stored_event
  ));
end;
$$;

-- 同一 commit RPC 同时承载普通 heartbeat/终态与 cancelling executor 的续租/退出
-- 确认。取消分支仍先校验原 generation + leaseToken，再校验 durable signalId。
create or replace function public.botanic_commit_agent_turn_execution(
  p_owner_id uuid,
  p_turn_id text,
  p_project_id text,
  p_command jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  existing public.agent_turns%rowtype;
  existing_event public.agent_turn_events%rowtype;
  requested_status text;
  requested_generation bigint;
  observed_at timestamptz;
  observed_ms bigint;
  lease_duration_ms bigint;
  stored_payload jsonb;
  execution_payload jsonb;
  cancellation_payload jsonb;
  event_payload jsonb;
  stored_event jsonb;
  authoritative_last_sequence integer;
  next_sequence integer;
  result_kind text := 'committed';
begin
  requested_status := p_command->>'status';
  if p_owner_id is null or nullif(p_turn_id, '') is null or nullif(p_project_id, '') is null
    or jsonb_typeof(p_command) is distinct from 'object'
    or nullif(p_command->>'leaseToken', '') is null
    or p_command->>'executionGeneration' !~ '^[1-9][0-9]*$'
    or requested_status not in ('running', 'waiting_user', 'completed', 'failed', 'cancelled') then
    raise exception 'Invalid Agent Turn execution commit' using errcode = '22023';
  end if;
  requested_generation := (p_command->>'executionGeneration')::bigint;

  perform pg_advisory_xact_lock(hashtextextended(p_turn_id, 3));
  select * into existing from public.agent_turns where id = p_turn_id for update;
  if existing.id is null or existing.owner_id <> p_owner_id or existing.project_id <> p_project_id then
    raise exception 'Agent Turn not found' using errcode = 'PAT02';
  end if;
  if existing.execution_version <> requested_generation
    or existing.lease_token is distinct from p_command->>'leaseToken' then
    raise exception 'AGENT_TURN_LEASE_STALE' using errcode = 'PAT01';
  end if;
  stored_payload := existing.payload;

  -- cancelled 只能由 finalizer 在深取消与 release proof 完成后提交。
  if requested_status = 'cancelled' then
    return case when existing.status = 'cancelling'
      then jsonb_build_object('kind', 'cancelling', 'turn', stored_payload)
      else jsonb_build_object('kind', 'conflict', 'turn', stored_payload)
    end;
  end if;
  if existing.status in ('completed', 'failed', 'cancelled') then
    if existing.status <> requested_status then
      raise exception 'AGENT_TURN_LEASE_STALE' using errcode = 'PAT01';
    end if;
    result_kind := 'replay';
  elsif existing.status = 'waiting_user' then
    if requested_status = 'waiting_user' then
      result_kind := 'replay';
    else
      raise exception 'AGENT_TURN_LEASE_STALE' using errcode = 'PAT01';
    end if;
  elsif existing.status = 'cancelling' then
    if coalesce((stored_payload->'cancellation'->>'signalRequired')::boolean, false) is not true then
      return jsonb_build_object('kind', 'cancelling', 'turn', stored_payload);
    end if;
    if nullif(p_command->>'signalId', '') is null then
      return jsonb_build_object('kind', 'cancelling', 'turn', stored_payload);
    end if;
    if p_command->>'signalId' is distinct from stored_payload->'cancellation'->>'signalId'
      or stored_payload->'cancellation'->>'executionGeneration' !~ '^[1-9][0-9]*$'
      or (stored_payload->'cancellation'->>'executionGeneration')::bigint is distinct from requested_generation then
      return jsonb_build_object('kind', 'stale', 'turn', stored_payload);
    end if;

    observed_at := clock_timestamp();
    observed_ms := floor(extract(epoch from observed_at) * 1000)::bigint;
    if p_command->>'releaseBasis' = 'worker_exit' then
      if coalesce((stored_payload->'cancellation'->>'workerReleased')::boolean, false) is true then
        return jsonb_build_object('kind', 'replay', 'turn', stored_payload);
      end if;
      execution_payload := coalesce(stored_payload->'execution', '{}'::jsonb)
        || jsonb_build_object('settledAt', observed_ms);
      cancellation_payload := stored_payload->'cancellation' || jsonb_build_object(
        'workerReleased', true,
        'signalAcknowledgedAt', observed_ms,
        'releaseBasis', 'worker_exit'
      );
      stored_payload := stored_payload || jsonb_build_object(
        'updatedAt', observed_ms,
        'execution', execution_payload,
        'cancellation', cancellation_payload
      );
      update public.agent_turns set updated_at = observed_at, payload = stored_payload
      where id = p_turn_id;
      return jsonb_build_object('kind', 'cancellation_acknowledged', 'turn', stored_payload);
    end if;
    if p_command->>'releaseBasis' is not null or requested_status <> 'running'
      or coalesce((stored_payload->'cancellation'->>'workerReleased')::boolean, false) is true then
      return jsonb_build_object('kind', 'stale', 'turn', stored_payload);
    end if;

    lease_duration_ms := greatest(
      30000,
      coalesce(nullif(stored_payload->'execution'->>'leaseDurationMs', '')::bigint, 120000)
    );
    execution_payload := coalesce(stored_payload->'execution', '{}'::jsonb) || jsonb_build_object(
      'generation', requested_generation,
      'leaseToken', p_command->>'leaseToken',
      'leaseExpiresAt', observed_ms + lease_duration_ms,
      'lastHeartbeatAt', observed_ms
    );
    cancellation_payload := stored_payload->'cancellation'
      || jsonb_build_object('lastHeartbeatAt', observed_ms);
    stored_payload := stored_payload || jsonb_build_object(
      'updatedAt', observed_ms,
      'execution', execution_payload,
      'cancellation', cancellation_payload
    );
    update public.agent_turns set
      updated_at = observed_at,
      payload = stored_payload,
      lease_expires_at = observed_at + (lease_duration_ms::double precision * interval '1 millisecond')
    where id = p_turn_id;
    return jsonb_build_object('kind', 'cancellation_heartbeat', 'turn', stored_payload);
  elsif existing.status <> 'running' then
    raise exception 'AGENT_TURN_LEASE_STALE' using errcode = 'PAT01';
  else
    observed_at := clock_timestamp();
    observed_ms := floor(extract(epoch from observed_at) * 1000)::bigint;
    lease_duration_ms := greatest(
      30000,
      coalesce(nullif(stored_payload->'execution'->>'leaseDurationMs', '')::bigint, 120000)
    );
    execution_payload := coalesce(stored_payload->'execution', '{}'::jsonb) || jsonb_build_object(
      'generation', requested_generation,
      'leaseToken', p_command->>'leaseToken'
    );
    if requested_status = 'running' then
      execution_payload := execution_payload || jsonb_build_object(
        'leaseExpiresAt', observed_ms + lease_duration_ms,
        'lastHeartbeatAt', observed_ms
      );
      stored_payload := (stored_payload || jsonb_build_object(
        'status', 'running', 'updatedAt', observed_ms, 'execution', execution_payload
      )) - 'result' - 'error';
      if p_command ? 'checkpoint' then
        stored_payload := stored_payload || jsonb_build_object('checkpoint', p_command->'checkpoint');
      end if;
    else
      execution_payload := execution_payload || jsonb_build_object('settledAt', observed_ms);
      stored_payload := stored_payload || jsonb_build_object(
        'status', requested_status, 'updatedAt', observed_ms, 'execution', execution_payload
      );
      if requested_status in ('completed', 'waiting_user') then
        stored_payload := (stored_payload || jsonb_build_object('result', p_command->'result')) - 'error';
      else
        stored_payload := (stored_payload || jsonb_build_object('error', p_command->'error')) - 'result';
      end if;
    end if;
  end if;

  event_payload := p_command->'event';
  authoritative_last_sequence := existing.last_sequence;
  if event_payload is not null and jsonb_typeof(event_payload) <> 'null' then
    if jsonb_typeof(event_payload) <> 'object'
      or nullif(event_payload->>'id', '') is null
      or nullif(event_payload->>'type', '') is null
      or event_payload->>'turnId' is distinct from p_turn_id
      or event_payload->>'projectId' is distinct from p_project_id then
      raise exception 'Invalid Agent Turn event' using errcode = '22023';
    end if;
    select * into existing_event from public.agent_turn_events where id = event_payload->>'id' for update;
    if existing_event.id is not null then
      if existing_event.turn_id <> p_turn_id or existing_event.type <> event_payload->>'type' then
        raise exception 'Agent Turn event conflict' using errcode = 'PAT03';
      end if;
      authoritative_last_sequence := greatest(existing.last_sequence, existing_event.sequence);
      stored_event := jsonb_build_object(
        'id', existing_event.id, 'turnId', existing_event.turn_id,
        'ownerId', existing_event.owner_id, 'projectId', existing_event.project_id,
        'sequence', existing_event.sequence, 'type', existing_event.type,
        'createdAt', floor(extract(epoch from existing_event.created_at) * 1000)::bigint,
        'executionGeneration', existing_event.execution_version,
        'payload', existing_event.payload
      );
    elsif result_kind = 'committed' then
      select greatest(existing.last_sequence, coalesce(max(sequence), 0))::integer
        into authoritative_last_sequence
      from public.agent_turn_events where turn_id = p_turn_id;
      next_sequence := authoritative_last_sequence + 1;
      observed_at := coalesce(observed_at, clock_timestamp());
      observed_ms := coalesce(observed_ms, floor(extract(epoch from observed_at) * 1000)::bigint);
      insert into public.agent_turn_events (
        id, turn_id, owner_id, project_id, sequence, type, created_at, payload, execution_version
      ) values (
        event_payload->>'id', p_turn_id, p_owner_id, p_project_id, next_sequence,
        event_payload->>'type', observed_at, event_payload->'payload', requested_generation
      );
      authoritative_last_sequence := next_sequence;
      stored_event := jsonb_strip_nulls(event_payload || jsonb_build_object(
        'ownerId', p_owner_id::text, 'projectId', p_project_id,
        'sequence', next_sequence, 'createdAt', observed_ms,
        'executionGeneration', requested_generation
      ));
    end if;
    stored_payload := stored_payload || jsonb_build_object('lastSequence', authoritative_last_sequence);
  end if;

  if result_kind = 'committed' then
    observed_at := coalesce(observed_at, clock_timestamp());
    update public.agent_turns set
      status = requested_status,
      updated_at = observed_at,
      payload = stored_payload,
      lease_expires_at = case when requested_status = 'running'
        then observed_at + (lease_duration_ms::double precision * interval '1 millisecond')
        else lease_expires_at end,
      last_sequence = authoritative_last_sequence
    where id = p_turn_id;

    if requested_status in ('completed', 'failed') then
      insert into public.audit_events (id, actor_id, action, project_id, target_id, detail)
      values (
        'audit_agent_turn_' || md5(p_turn_id || ':' || requested_status || ':' || requested_generation::text),
        p_owner_id, 'agent-turn.' || requested_status, p_project_id, p_turn_id,
        jsonb_build_object('executionGeneration', requested_generation)
      ) on conflict (id) do nothing;
    end if;
  elsif authoritative_last_sequence > existing.last_sequence then
    stored_payload := existing.payload || jsonb_build_object('lastSequence', authoritative_last_sequence);
    update public.agent_turns set payload = stored_payload, last_sequence = authoritative_last_sequence
    where id = p_turn_id;
  end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'kind', result_kind,
    'turn', stored_payload,
    'event', stored_event
  ));
end;
$$;

-- 深取消完成后的 Turn terminal 收口。signalRequired 的 running executor 必须先有
-- worker_exit ack；唯一替代证明是数据库时钟观察到最后一次 heartbeat 租约已过期。
create or replace function public.botanic_finalize_agent_turn_cancellation(
  p_owner_id uuid,
  p_turn_id text,
  p_project_id text,
  p_command jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  existing public.agent_turns%rowtype;
  existing_event public.agent_turn_events%rowtype;
  observed_at timestamptz;
  observed_ms bigint;
  event_payload jsonb;
  stored_event jsonb;
  stored_payload jsonb;
  execution_payload jsonb;
  cancellation_payload jsonb;
  authoritative_last_sequence integer;
  next_sequence integer;
begin
  if p_owner_id is null or nullif(p_turn_id, '') is null or nullif(p_project_id, '') is null
    or jsonb_typeof(p_command) is distinct from 'object' then
    raise exception 'Invalid Agent Turn cancellation finalization' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_turn_id, 3));
  select * into existing from public.agent_turns where id = p_turn_id for update;
  if existing.id is null or existing.owner_id <> p_owner_id or existing.project_id <> p_project_id then
    raise exception 'Agent Turn not found' using errcode = 'PAT02';
  end if;

  event_payload := p_command->'event';
  if existing.status = 'cancelled' then
    if jsonb_typeof(event_payload) = 'object' and nullif(event_payload->>'id', '') is not null then
      select * into existing_event from public.agent_turn_events where id = event_payload->>'id' for update;
      if existing_event.id is not null then
        if existing_event.turn_id <> p_turn_id or existing_event.project_id <> p_project_id
          or existing_event.type <> 'turn.cancelled' then
          raise exception 'Agent Turn event conflict' using errcode = 'PAT03';
        end if;
        stored_event := jsonb_build_object(
          'id', existing_event.id, 'turnId', existing_event.turn_id,
          'ownerId', existing_event.owner_id, 'projectId', existing_event.project_id,
          'sequence', existing_event.sequence, 'type', existing_event.type,
          'createdAt', floor(extract(epoch from existing_event.created_at) * 1000)::bigint,
          'executionGeneration', existing_event.execution_version,
          'payload', existing_event.payload
        );
      end if;
    end if;
    return jsonb_strip_nulls(jsonb_build_object(
      'kind', 'replay', 'turn', existing.payload, 'event', stored_event
    ));
  end if;
  if existing.status in ('completed', 'failed') then
    return jsonb_build_object('kind', 'stale', 'turn', existing.payload);
  end if;
  if existing.status <> 'cancelling' then
    return jsonb_build_object('kind', 'conflict', 'turn', existing.payload);
  end if;
  if jsonb_typeof(event_payload) is distinct from 'object'
    or nullif(event_payload->>'id', '') is null
    or event_payload->>'turnId' is distinct from p_turn_id
    or event_payload->>'projectId' is distinct from p_project_id
    or event_payload->>'type' is distinct from 'turn.cancelled' then
    raise exception 'Invalid Agent Turn cancellation finalization event' using errcode = '22023';
  end if;
  select * into existing_event from public.agent_turn_events where id = event_payload->>'id' for update;
  if existing_event.id is not null then
    if existing_event.turn_id <> p_turn_id or existing_event.project_id <> p_project_id
      or existing_event.type <> 'turn.cancelled' then
      raise exception 'Agent Turn event conflict' using errcode = 'PAT03';
    end if;
    raise exception 'Agent Turn cancellation state conflict' using errcode = 'PAT03';
  end if;

  observed_at := clock_timestamp();
  observed_ms := floor(extract(epoch from observed_at) * 1000)::bigint;
  cancellation_payload := coalesce(existing.payload->'cancellation', '{}'::jsonb);
  if coalesce((cancellation_payload->>'signalRequired')::boolean, false) is true
    and coalesce((cancellation_payload->>'workerReleased')::boolean, false) is not true then
    if existing.lease_expires_at is null or existing.lease_expires_at > observed_at then
      return jsonb_build_object('kind', 'pending', 'turn', existing.payload);
    end if;
    cancellation_payload := cancellation_payload || jsonb_build_object(
      'workerReleased', true,
      'signalAcknowledgedAt', observed_ms,
      'releaseBasis', 'lease_expired'
    );
  end if;

  select greatest(existing.last_sequence, coalesce(max(sequence), 0))::integer
    into authoritative_last_sequence
  from public.agent_turn_events where turn_id = p_turn_id;
  next_sequence := authoritative_last_sequence + 1;
  insert into public.agent_turn_events (
    id, turn_id, owner_id, project_id, sequence, type, created_at, payload, execution_version
  ) values (
    event_payload->>'id', p_turn_id, p_owner_id, p_project_id, next_sequence,
    'turn.cancelled', observed_at,
    coalesce(existing.payload->'error', jsonb_build_object(
      'code', 'AGENT_TURN_CANCELLED', 'message', 'Agent 回合已取消。'
    )),
    existing.execution_version
  );
  stored_event := jsonb_strip_nulls(event_payload || jsonb_build_object(
    'ownerId', p_owner_id::text,
    'projectId', p_project_id,
    'sequence', next_sequence,
    'createdAt', observed_ms,
    'executionGeneration', existing.execution_version,
    'payload', coalesce(existing.payload->'error', jsonb_build_object(
      'code', 'AGENT_TURN_CANCELLED', 'message', 'Agent 回合已取消。'
    ))
  ));
  execution_payload := coalesce(existing.payload->'execution', '{}'::jsonb)
    || jsonb_build_object('settledAt', observed_ms);
  cancellation_payload := cancellation_payload
    || jsonb_build_object('status', 'completed', 'completedAt', observed_ms);
  stored_payload := (existing.payload || jsonb_build_object(
    'status', 'cancelled',
    'updatedAt', observed_ms,
    'execution', execution_payload,
    'cancellation', cancellation_payload,
    'lastSequence', next_sequence,
    'error', coalesce(existing.payload->'error', jsonb_build_object(
      'code', 'AGENT_TURN_CANCELLED', 'message', 'Agent 回合已取消。'
    ))
  )) - 'result';
  update public.agent_turns set
    status = 'cancelled',
    updated_at = observed_at,
    payload = stored_payload,
    last_sequence = next_sequence
  where id = p_turn_id;
  insert into public.audit_events (id, actor_id, action, project_id, target_id, detail, created_at)
  values (
    'audit_agent_turn_cancelled_' || md5(p_turn_id),
    p_owner_id,
    'agent-turn.cancelled',
    p_project_id,
    p_turn_id,
    jsonb_build_object('executionGeneration', existing.execution_version),
    observed_at
  ) on conflict (id) do nothing;
  return jsonb_build_object(
    'kind', 'finalized', 'turn', stored_payload, 'event', stored_event
  );
end;
$$;

-- GenerationJob 取消按行锁内真实状态选择 outcome。running 立即对用户显示 cancelled，
-- 但保留原 execution 未 settled，等待该 generation 的 Worker 退出证明。
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
  generation bigint;
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
  generation := greatest(
    existing.execution_version,
    coalesce(nullif(existing.payload->'execution'->>'generation', '')::bigint, 0),
    coalesce(nullif(existing.payload->>'executionVersion', '')::bigint, 0)
  );
  stored_payload := existing.payload || jsonb_build_object(
    'id', existing.id,
    'ownerId', existing.owner_id::text,
    'projectId', existing.project_id,
    'status', existing.status::text,
    'executionVersion', generation
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
      when coalesce((outcome->>'workerReleased')::boolean, false) then true
      else null
    end,
    'workerReleased', case
      when prior_status = 'running' then false
      else coalesce((outcome->>'workerReleased')::boolean, false)
    end,
    'code', outcome->>'code',
    'signalRequired', case when prior_status = 'running' then true else null end,
    'signalId', case when prior_status = 'running' then
      'generation-cancel:' || p_job_id || ':' || generation::text || ':' || requested_ms::text
      else null
    end
  ));
  stored_payload := ((stored_payload - 'error') - 'errorCode') || jsonb_build_object(
    'status', 'cancelled',
    'updatedAt', observed_ms,
    'cancel', cancel_payload
  );
  if jsonb_typeof(existing.payload->'execution') = 'object' then
    execution_payload := existing.payload->'execution';
    if prior_status <> 'running' then
      execution_payload := execution_payload || jsonb_build_object('settledAt', observed_ms);
    end if;
    stored_payload := stored_payload || jsonb_build_object(
      'executionVersion', generation,
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

-- 保留 20260828120000 的 immutable request sticky 语义，同时让 cancelled Job 的
-- 原 Worker 可用同一 fence 续租。普通 succeeded/failed 迟到结果仍被 cancelled 压住。
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
  stored_binding jsonb;
  candidate_binding jsonb;
  candidate jsonb;
  execution_payload jsonb;
  cancel_payload jsonb;
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
    or next_status not in ('running', 'succeeded', 'failed', 'cancelled')
    or nullif(btrim(token), '') is null
    or p_command->>'executionGeneration' !~ '^[0-9]+$' then
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

  if existing.status = 'cancelled' then
    if coalesce((stored_payload->'cancel'->>'signalRequired')::boolean, false) is true
      and coalesce((stored_payload->'cancel'->>'workerReleased')::boolean, false) is not true
      and next_status = 'running'
      and nullif(p_command->>'signalId', '') is null then
      return jsonb_build_object('kind', 'cancellation_required', 'changed', false, 'job', stored_payload);
    end if;
    if coalesce((stored_payload->'cancel'->>'signalRequired')::boolean, false) is not true
      or coalesce((stored_payload->'cancel'->>'workerReleased')::boolean, false) is true
      or next_status <> 'cancelled'
      or nullif(p_command->>'signalId', '') is null
      or stored_payload->'cancel'->>'signalId' is distinct from p_command->>'signalId' then
      return jsonb_build_object('kind', 'stale', 'changed', false, 'job', stored_payload);
    end if;

    observed_at := clock_timestamp();
    observed_ms := floor(extract(epoch from observed_at) * 1000)::bigint;
    lease_duration_ms := greatest(
      30000,
      coalesce(nullif(stored_payload->'execution'->>'leaseDurationMs', '')::bigint, 120000)
    );
    execution_payload := coalesce(stored_payload->'execution', '{}'::jsonb) || jsonb_build_object(
      'generation', generation,
      'leaseToken', token,
      'leaseExpiresAt', observed_ms + lease_duration_ms,
      'lastHeartbeatAt', observed_ms
    );
    cancel_payload := stored_payload->'cancel' || jsonb_build_object('lastHeartbeatAt', observed_ms);
    stored_payload := stored_payload || jsonb_build_object(
      'updatedAt', observed_ms,
      'executionVersion', generation,
      'execution', execution_payload,
      'cancel', cancel_payload
    );
    update public.generation_jobs set
      updated_at = observed_at,
      execution_version = generation,
      lease_token = token,
      lease_expires_at = observed_at + (lease_duration_ms::double precision * interval '1 millisecond'),
      payload = stored_payload
    where id = p_job_id;
    return jsonb_build_object(
      'kind', 'cancellation_heartbeat', 'changed', true, 'job', stored_payload
    );
  end if;

  if (existing.status in ('succeeded', 'failed') and existing.status::text <> next_status)
    or existing.status::text not in ('running', next_status)
    or next_status = 'cancelled' then
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
    stored_binding := stored_payload->'idempotencyBinding';
    candidate_binding := candidate->'idempotencyBinding';
    if stored_binding is not null and candidate_binding is not null
      and candidate_binding is distinct from stored_binding then
      return jsonb_build_object('kind', 'conflict', 'changed', false, 'job', stored_payload);
    end if;
    if stored_binding is not null then
      candidate := public.botanic_sticky_json_fields(
        stored_payload,
        candidate,
        array[
          'id', 'ownerId', 'projectId', 'createdAt', 'kind', 'refinementMode', 'batchCount',
          'settings', 'provider', 'rawInput', 'idempotencyKey', 'agentRun', 'idempotencyBinding'
        ]
      );
    end if;
  else
    candidate := stored_payload;
  end if;

  observed_at := clock_timestamp();
  observed_ms := floor(extract(epoch from observed_at) * 1000)::bigint;
  lease_duration_ms := greatest(
    30000,
    coalesce(nullif(stored_payload->'execution'->>'leaseDurationMs', '')::bigint, 120000)
  );
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

-- Worker 只有在 Provider/heartbeat 已退出且本地句柄已释放后，才能用原 fence 写
-- worker_exit。Worker 崩溃时只能由 DB clock 观察到最后租约过期后替代确认。
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
  execution_payload jsonb;
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
    or existing.execution_version <> generation
    or nullif(stored_payload->'execution'->>'generation', '')::bigint is distinct from generation then
    return jsonb_build_object('kind', 'stale', 'changed', false, 'job', stored_payload);
  end if;
  if release_basis = 'worker_exit'
    and (
      nullif(p_command->>'leaseToken', '') is null
      or p_command->>'leaseToken' is distinct from existing.lease_token
      or p_command->>'leaseToken' is distinct from stored_payload->'execution'->>'leaseToken'
    ) then
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

  if jsonb_typeof(stored_payload->'execution') = 'object' then
    execution_payload := stored_payload->'execution' || jsonb_build_object(
      'settledAt', coalesce(
        nullif(stored_payload->'execution'->>'settledAt', '')::bigint,
        observed_ms
      )
    );
    stored_payload := stored_payload || jsonb_build_object('execution', execution_payload);
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
  return jsonb_build_object(
    'kind', 'acknowledged', 'changed', true, 'job', stored_payload
  );
end;
$$;

revoke all on function public.botanic_request_agent_turn_cancellation(uuid, text, text, jsonb)
from public, anon, authenticated;
grant execute on function public.botanic_request_agent_turn_cancellation(uuid, text, text, jsonb)
to service_role;

revoke all on function public.botanic_commit_agent_turn_execution(uuid, text, text, jsonb)
from public, anon, authenticated;
grant execute on function public.botanic_commit_agent_turn_execution(uuid, text, text, jsonb)
to service_role;

revoke all on function public.botanic_finalize_agent_turn_cancellation(uuid, text, text, jsonb)
from public, anon, authenticated;
grant execute on function public.botanic_finalize_agent_turn_cancellation(uuid, text, text, jsonb)
to service_role;

revoke all on function public.botanic_cancel_generation_job_execution(uuid, text, text, jsonb)
from public, anon, authenticated;
grant execute on function public.botanic_cancel_generation_job_execution(uuid, text, text, jsonb)
to service_role;

revoke all on function public.botanic_commit_generation_job_execution(uuid, text, text, jsonb)
from public, anon, authenticated;
grant execute on function public.botanic_commit_generation_job_execution(uuid, text, text, jsonb)
to service_role;

revoke all on function public.botanic_acknowledge_generation_job_cancellation(uuid, text, text, jsonb)
from public, anon, authenticated;
grant execute on function public.botanic_acknowledge_generation_job_cancellation(uuid, text, text, jsonb)
to service_role;

commit;
