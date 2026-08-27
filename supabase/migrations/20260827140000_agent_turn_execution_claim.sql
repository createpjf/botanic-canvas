begin;

-- Durable Turn 的跨实例执行所有权。数据库列用于锁、扫描与 fencing；payload 保留
-- Adapter 兼容投影，公共 HTTP read model 不下发 leaseToken。
alter table public.agent_turns
  add column if not exists request_hash text,
  add column if not exists request_hash_version smallint,
  add column if not exists execution_version bigint not null default 0,
  add column if not exists lease_token text,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists last_sequence integer not null default 0;

alter table public.agent_turn_events
  add column if not exists execution_version bigint not null default 0;

update public.agent_turns as turn
set last_sequence = greatest(turn.last_sequence, events.last_sequence)
from (
  select turn_id, coalesce(max(sequence), 0)::integer as last_sequence
  from public.agent_turn_events
  group by turn_id
) as events
where events.turn_id = turn.id and events.last_sequence > turn.last_sequence;

create index if not exists agent_turns_running_lease_idx
  on public.agent_turns (lease_expires_at asc)
  where status = 'running';

create or replace function public.botanic_claim_agent_turn_execution(
  p_owner_id uuid,
  p_turn_id text,
  p_project_id text,
  p_claim jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  existing public.agent_turns%rowtype;
  member_role public.botanic_project_role;
  source_turn jsonb;
  stored_payload jsonb;
  execution_payload jsonb;
  observed_at timestamptz;
  observed_ms bigint;
  lease_duration_ms bigint;
  next_generation bigint;
  historical_last_sequence integer;
  current_status text;
  source_hash text;
  source_hash_version integer;
  stored_hash text;
  stored_hash_version integer;
  stored_request_intent jsonb;
  source_request_intent jsonb;
  request_binding_backfilled boolean := false;
begin
  source_turn := p_claim->'turn';
  source_hash := nullif(source_turn->>'requestHash', '');
  source_hash_version := case
    when source_turn->>'requestHashVersion' ~ '^[0-9]+$'
      then (source_turn->>'requestHashVersion')::integer
    else null
  end;
  if p_owner_id is null or nullif(p_turn_id, '') is null or nullif(p_project_id, '') is null
    or jsonb_typeof(source_turn) <> 'object'
    or source_turn->>'id' is distinct from p_turn_id
    or source_turn->>'projectId' is distinct from p_project_id
    or nullif(source_turn->>'idempotencyKey', '') is null
    or source_hash is null
    or source_hash_version is null or source_hash_version not in (1, 2)
    or nullif(p_claim->>'leaseToken', '') is null then
    raise exception 'Invalid Agent Turn execution claim' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_turn_id, 3));
  select * into existing from public.agent_turns where id = p_turn_id for update;

  if existing.id is not null and (existing.owner_id <> p_owner_id or existing.project_id <> p_project_id) then
    return jsonb_build_object('kind', 'conflict');
  end if;

  select member.role into member_role
  from public.project_members as member
  where member.project_id = p_project_id and member.user_id = p_owner_id
  for share;
  if member_role is null or member_role not in ('owner', 'editor', 'viewer') then
    raise exception 'Agent Turn claim forbidden' using errcode = '42501';
  end if;

  observed_at := clock_timestamp();
  observed_ms := floor(extract(epoch from observed_at) * 1000)::bigint;
  lease_duration_ms := greatest(30000, least(
    case when p_claim->>'leaseDurationMs' ~ '^[0-9]+$'
      then (p_claim->>'leaseDurationMs')::bigint else 120000 end,
    900000
  ));

  if existing.id is null then
    select coalesce(max(sequence), 0)::integer into historical_last_sequence
    from public.agent_turn_events where turn_id = p_turn_id;
    next_generation := 1;
    execution_payload := jsonb_build_object(
      'generation', next_generation,
      'leaseToken', p_claim->>'leaseToken',
      'leaseDurationMs', lease_duration_ms,
      'leaseExpiresAt', observed_ms + lease_duration_ms,
      'claimedAt', observed_ms,
      'lastHeartbeatAt', observed_ms
    );
    stored_payload := (source_turn || jsonb_build_object(
      'ownerId', p_owner_id::text,
      'projectId', p_project_id,
      'status', 'running',
      'updatedAt', observed_ms,
      'lastSequence', historical_last_sequence,
      'execution', execution_payload
    )) - 'error' - 'result';
    insert into public.agent_turns (
      id, owner_id, project_id, session_id, idempotency_key, status, updated_at, payload,
      request_hash, request_hash_version, execution_version, lease_token, lease_expires_at, last_sequence
    ) values (
      p_turn_id, p_owner_id, p_project_id, nullif(source_turn->>'sessionId', ''),
      source_turn->>'idempotencyKey', 'running', observed_at, stored_payload,
      source_hash, source_hash_version, next_generation, p_claim->>'leaseToken',
      observed_at + make_interval(secs => lease_duration_ms::double precision / 1000.0),
      historical_last_sequence
    );
    return jsonb_build_object('kind', 'claimed', 'turn', stored_payload);
  end if;

  if existing.idempotency_key is distinct from source_turn->>'idempotencyKey' then
    return jsonb_build_object('kind', 'conflict', 'turn', existing.payload);
  end if;

  stored_hash := coalesce(existing.request_hash, nullif(existing.payload->>'requestHash', ''));
  stored_hash_version := coalesce(
    existing.request_hash_version,
    case
      when existing.payload->>'requestHashVersion' ~ '^[12]$'
        then (existing.payload->>'requestHashVersion')::integer
      when not (existing.payload ? 'requestHashVersion') and existing.payload->>'version' = '2' then 2
      when not (existing.payload ? 'requestHashVersion')
        and (not (existing.payload ? 'version') or existing.payload->>'version' = '1') then 1
      else null
    end
  );

  if stored_hash is not null then
    if stored_hash_version is null or stored_hash_version not in (1, 2)
      or stored_hash is distinct from source_hash then
      return jsonb_build_object('kind', 'conflict', 'turn', existing.payload);
    end if;
    if existing.request_hash is null or existing.request_hash_version is null
      or not (existing.payload ? 'requestHash') or not (existing.payload ? 'requestHashVersion') then
      stored_payload := existing.payload || jsonb_build_object(
        'requestHash', stored_hash,
        'requestHashVersion', stored_hash_version
      );
      request_binding_backfilled := true;
    else
      stored_payload := existing.payload;
    end if;
  else
    -- 缺摘要的旧 Turn 只允许从已存 immutable request 恢复绑定。
    -- 存储快照缺失、版本未知或本次请求不等时均 fail closed。
    if stored_hash_version is null or stored_hash_version not in (1, 2)
      or jsonb_typeof(existing.payload->'request') <> 'object'
      or jsonb_typeof(source_turn->'request') <> 'object' then
      return jsonb_build_object('kind', 'conflict', 'turn', existing.payload);
    end if;

    if stored_hash_version = 2
      and nullif(existing.payload->'request'->>'sessionId', '') is not null
      and jsonb_typeof(existing.payload->'request'->'inputMessage') = 'object'
      and nullif(existing.payload->'request'->'inputMessage'->>'id', '') is not null then
      stored_request_intent := (existing.payload->'request') - 'messages';
    else
      stored_request_intent := existing.payload->'request';
    end if;
    if stored_hash_version = 2
      and nullif(source_turn->'request'->>'sessionId', '') is not null
      and jsonb_typeof(source_turn->'request'->'inputMessage') = 'object'
      and nullif(source_turn->'request'->'inputMessage'->>'id', '') is not null then
      source_request_intent := (source_turn->'request') - 'messages';
    else
      source_request_intent := source_turn->'request';
    end if;
    if stored_request_intent is distinct from source_request_intent then
      return jsonb_build_object('kind', 'conflict', 'turn', existing.payload);
    end if;

    -- 只有在数据库锁内证明新旧请求是同一意图后，才用当前版本摘要升级旧绑定。
    stored_hash := source_hash;
    stored_hash_version := source_hash_version;
    stored_payload := existing.payload || jsonb_build_object(
      'requestHash', stored_hash,
      'requestHashVersion', stored_hash_version
    );
    request_binding_backfilled := true;
  end if;

  if request_binding_backfilled then
    update public.agent_turns set
      payload = stored_payload,
      request_hash = stored_hash,
      request_hash_version = stored_hash_version
    where id = p_turn_id;
    existing.payload := stored_payload;
    existing.request_hash := stored_hash;
    existing.request_hash_version := stored_hash_version;
  end if;

  current_status := existing.status;
  if current_status in ('completed', 'failed', 'cancelled') then
    return jsonb_build_object('kind', 'replay', 'turn', existing.payload);
  end if;
  if current_status = 'waiting_user' then
    return jsonb_build_object('kind', 'waiting_user', 'turn', existing.payload);
  end if;
  if current_status = 'cancelling' then
    return jsonb_build_object('kind', 'cancelling', 'turn', existing.payload);
  end if;
  if current_status = 'running' and existing.lease_token = p_claim->>'leaseToken' then
    return jsonb_build_object('kind', 'claimed', 'turn', existing.payload);
  end if;
  if current_status = 'running' and existing.lease_expires_at > observed_at then
    return jsonb_build_object('kind', 'in_progress', 'turn', existing.payload);
  end if;
  if current_status = 'running' and coalesce(p_claim->>'allowTakeover', 'false') <> 'true' then
    return jsonb_build_object('kind', 'stale', 'turn', existing.payload);
  end if;
  if current_status not in ('queued', 'running') then
    return jsonb_build_object('kind', 'conflict', 'turn', existing.payload);
  end if;

  next_generation := greatest(existing.execution_version, 0) + 1;
  execution_payload := jsonb_build_object(
    'generation', next_generation,
    'leaseToken', p_claim->>'leaseToken',
    'leaseDurationMs', lease_duration_ms,
    'leaseExpiresAt', observed_ms + lease_duration_ms,
    'claimedAt', observed_ms,
    'lastHeartbeatAt', observed_ms
  );
  stored_payload := (existing.payload || jsonb_build_object(
    'status', 'running',
    'updatedAt', observed_ms,
    'lastSequence', existing.last_sequence,
    'execution', execution_payload
  )) - 'error' - 'result';
  update public.agent_turns set
    status = 'running',
    updated_at = observed_at,
    payload = stored_payload,
    request_hash = stored_hash,
    request_hash_version = stored_hash_version,
    execution_version = next_generation,
    lease_token = p_claim->>'leaseToken',
    lease_expires_at = observed_at + make_interval(secs => lease_duration_ms::double precision / 1000.0)
  where id = p_turn_id;
  return jsonb_build_object('kind', 'claimed', 'turn', stored_payload);
end;
$$;

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
  stored_payload jsonb;
  execution_payload jsonb;
  event_payload jsonb;
  stored_event jsonb;
  authoritative_last_sequence integer;
  next_sequence integer;
  result_kind text := 'committed';
begin
  requested_status := p_command->>'status';
  if p_owner_id is null or nullif(p_turn_id, '') is null or nullif(p_project_id, '') is null
    or nullif(p_command->>'leaseToken', '') is null
    or p_command->>'executionGeneration' !~ '^[1-9][0-9]*$'
    -- cancelled 只能由 botanic_finalize_agent_turn_cancellation 在深取消完成后写入。
    or requested_status not in ('running', 'waiting_user', 'completed', 'failed') then
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
  if existing.status in ('completed', 'failed', 'cancelled') then
    if existing.status <> requested_status then
      raise exception 'AGENT_TURN_LEASE_STALE' using errcode = 'PAT01';
    end if;
    result_kind := 'replay';
    stored_payload := existing.payload;
  elsif existing.status = 'waiting_user' then
    if requested_status = 'waiting_user' then
      result_kind := 'replay';
      stored_payload := existing.payload;
    else
      raise exception 'AGENT_TURN_LEASE_STALE' using errcode = 'PAT01';
    end if;
  elsif existing.status = 'cancelling' then
    return jsonb_build_object('kind', 'cancelling', 'turn', existing.payload);
  elsif existing.status <> 'running' then
    raise exception 'AGENT_TURN_LEASE_STALE' using errcode = 'PAT01';
  else
    observed_at := clock_timestamp();
    observed_ms := floor(extract(epoch from observed_at) * 1000)::bigint;
    execution_payload := coalesce(existing.payload->'execution', '{}'::jsonb) || jsonb_build_object(
      'generation', requested_generation,
      'leaseToken', p_command->>'leaseToken'
    );
    if requested_status = 'running' then
      execution_payload := execution_payload || jsonb_build_object(
        'leaseExpiresAt', observed_ms + greatest(30000, coalesce((existing.payload->'execution'->>'leaseDurationMs')::bigint, 120000)),
        'lastHeartbeatAt', observed_ms
      );
      stored_payload := (existing.payload || jsonb_build_object(
        'status', 'running', 'updatedAt', observed_ms, 'execution', execution_payload
      )) - 'result' - 'error';
      if p_command ? 'checkpoint' then
        stored_payload := stored_payload || jsonb_build_object('checkpoint', p_command->'checkpoint');
      end if;
    else
      execution_payload := execution_payload || jsonb_build_object('settledAt', observed_ms);
      stored_payload := existing.payload || jsonb_build_object(
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
  else
    authoritative_last_sequence := existing.last_sequence;
  end if;

  if result_kind = 'committed' then
    observed_at := coalesce(observed_at, clock_timestamp());
    update public.agent_turns set
      status = requested_status,
      updated_at = observed_at,
      payload = stored_payload,
      lease_expires_at = case when requested_status = 'running'
        then observed_at + make_interval(secs => greatest(30000, coalesce((stored_payload->'execution'->>'leaseDurationMs')::bigint, 120000))::double precision / 1000.0)
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
    -- 终态响应丢失后重试时，只补缺失事件与 lastSequence，不改写第一次结果。
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
  event_payload jsonb;
  stored_event jsonb;
  authoritative_last_sequence integer;
  next_sequence integer;
  reason text;
begin
  if p_owner_id is null or nullif(p_turn_id, '') is null or nullif(p_project_id, '') is null then
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

  if existing.status in ('failed', 'cancelled', 'cancelling') then
    return jsonb_build_object('kind', 'replay', 'turn', existing.payload);
  end if;
  if existing.status not in ('queued', 'running', 'waiting_user', 'completed') then
    raise exception 'Invalid Agent Turn cancellation state' using errcode = '22023';
  end if;

  observed_at := clock_timestamp();
  observed_ms := floor(extract(epoch from observed_at) * 1000)::bigint;
  reason := left(coalesce(nullif(btrim(p_request->>'reason'), ''), '用户取消了 Agent 回合。'), 500);
  stored_payload := (existing.payload || jsonb_build_object(
    'status', 'cancelling',
    'updatedAt', observed_ms,
    'error', jsonb_build_object('code', 'AGENT_TURN_CANCELLED', 'message', reason),
    'cancellation', jsonb_build_object(
      'status', 'requested', 'requestedAt', observed_ms, 'reason', 'user'
    )
  )) - 'result';

  event_payload := p_request->'event';
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
      if existing_event.turn_id <> p_turn_id or existing_event.type <> 'turn.cancelling' then
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
        'ownerId', p_owner_id::text, 'sequence', next_sequence,
        'createdAt', observed_ms, 'executionGeneration', existing.execution_version
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

-- 兼容写入口必须与 claim 使用同一把事务锁。旧实现先读 execution、再普通 upsert，
-- 两步之间若另一个实例完成 claim，会把刚建立的 token/generation 整行抹掉。
-- 此 RPC 只允许创建或更新尚未 claim 的 legacy Turn；execution 一旦存在就原样返回。
create or replace function public.botanic_put_agent_turn_compatible(
  p_owner_id uuid,
  p_turn_id text,
  p_project_id text,
  p_turn jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  existing public.agent_turns%rowtype;
  member_role public.botanic_project_role;
  stored_payload jsonb;
  incoming_payload jsonb;
  incoming_status text;
  incoming_updated_ms bigint;
  incoming_updated_at timestamptz;
  incoming_hash text;
  incoming_hash_version smallint;
  payload_hash text;
  payload_hash_version smallint;
  stored_hash text;
  stored_hash_version smallint;
begin
  if p_owner_id is null or nullif(btrim(p_turn_id), '') is null
    or nullif(btrim(p_project_id), '') is null
    or jsonb_typeof(p_turn) is distinct from 'object'
    or p_turn->>'id' is distinct from p_turn_id
    or p_turn->>'projectId' is distinct from p_project_id
    or nullif(p_turn->>'idempotencyKey', '') is null
    or nullif(p_turn->>'updatedAt', '') is null
    or p_turn->>'updatedAt' !~ '^[0-9]+$'
    or (p_turn ? 'ownerId' and p_turn->>'ownerId' is distinct from p_owner_id::text) then
    raise exception 'Invalid compatible Agent Turn write' using errcode = '22023';
  end if;
  incoming_status := p_turn->>'status';
  if incoming_status not in ('queued', 'running', 'waiting_user', 'cancelling', 'completed', 'failed', 'cancelled') then
    raise exception 'Invalid compatible Agent Turn status' using errcode = '22023';
  end if;
  incoming_updated_ms := (p_turn->>'updatedAt')::bigint;
  incoming_updated_at := to_timestamp(incoming_updated_ms::double precision / 1000.0);
  incoming_hash := nullif(p_turn->>'requestHash', '');
  incoming_hash_version := case
    when p_turn->>'requestHashVersion' ~ '^[12]$' then (p_turn->>'requestHashVersion')::smallint
    else null
  end;
  if (incoming_hash is null and incoming_hash_version is not null)
    or (incoming_hash is not null and incoming_hash_version is null) then
    raise exception 'Invalid compatible Agent Turn request binding' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_turn_id, 3));
  select * into existing from public.agent_turns where id = p_turn_id for update;

  if existing.id is not null and (existing.owner_id <> p_owner_id or existing.project_id <> p_project_id) then
    raise exception 'Agent Turn identity conflict' using errcode = 'PAT04';
  end if;
  if existing.id is not null then
    payload_hash := nullif(existing.payload->>'requestHash', '');
    payload_hash_version := case
      when existing.payload->>'requestHashVersion' ~ '^[12]$'
        then (existing.payload->>'requestHashVersion')::smallint
      else null
    end;
    if existing.request_hash is not null and payload_hash is not null
      and existing.request_hash is distinct from payload_hash then
      raise exception 'Agent Turn stored request hash conflict' using errcode = 'PAT04';
    end if;
    if existing.request_hash_version is not null and payload_hash_version is not null
      and existing.request_hash_version is distinct from payload_hash_version then
      raise exception 'Agent Turn stored request hash version conflict' using errcode = 'PAT04';
    end if;
    stored_hash := coalesce(existing.request_hash, nullif(existing.payload->>'requestHash', ''));
    stored_hash_version := coalesce(
      existing.request_hash_version,
      case
        when existing.payload->>'requestHashVersion' ~ '^[12]$'
          then (existing.payload->>'requestHashVersion')::smallint
        else null
      end
    );
    if (stored_hash is null and stored_hash_version is not null)
      or (stored_hash is not null and stored_hash_version is null) then
      raise exception 'Agent Turn stored request binding is incomplete' using errcode = 'PAT04';
    end if;
    -- 缺字段的旧 writer 可以重放，但显式带来的新绑定不得改写历史身份。
    if stored_hash is not null and incoming_hash is not null
      and incoming_hash is distinct from stored_hash then
      raise exception 'Agent Turn request binding conflict' using errcode = 'PAT04';
    end if;
    if stored_hash_version is not null and incoming_hash_version is not null
      and incoming_hash_version is distinct from stored_hash_version then
      raise exception 'Agent Turn request binding conflict' using errcode = 'PAT04';
    end if;
  end if;
  select member.role into member_role
  from public.project_members as member
  where member.project_id = p_project_id and member.user_id = p_owner_id
  for share;
  if member_role is null or member_role not in ('owner', 'editor', 'viewer') then
    raise exception 'Compatible Agent Turn write forbidden' using errcode = '42501';
  end if;

  -- 历史行可能只在 payload 保存 request binding；先原子回填列与 payload，
  -- 后续的 claim/compatible put 才不会把它当成未绑定 Turn。
  if existing.id is not null and stored_hash is not null then
    stored_payload := existing.payload || jsonb_build_object(
      'requestHash', stored_hash,
      'requestHashVersion', stored_hash_version
    );
    if existing.request_hash is distinct from stored_hash
      or existing.request_hash_version is distinct from stored_hash_version
      or existing.payload is distinct from stored_payload then
      update public.agent_turns set
        request_hash = stored_hash,
        request_hash_version = stored_hash_version,
        payload = stored_payload
      where id = p_turn_id;
      existing.request_hash := stored_hash;
      existing.request_hash_version := stored_hash_version;
      existing.payload := stored_payload;
    end if;
  end if;

  -- generic put 永远不能铸造 execution；数据库当前行已经 claim 时也不能更新任何字段。
  if existing.id is not null and (
    existing.execution_version > 0
    or existing.lease_token is not null
    or jsonb_typeof(existing.payload->'execution') = 'object'
  ) then
    return existing.payload;
  end if;

  incoming_payload := (p_turn - 'execution' - 'executionVersion') || jsonb_build_object(
    'ownerId', p_owner_id::text,
    'projectId', p_project_id,
    'updatedAt', incoming_updated_ms
  );
  if stored_hash is not null then
    incoming_payload := incoming_payload || jsonb_build_object(
      'requestHash', stored_hash,
      'requestHashVersion', stored_hash_version
    );
  end if;

  if existing.id is not null then
    if existing.idempotency_key is distinct from p_turn->>'idempotencyKey' then
      raise exception 'Agent Turn request binding conflict' using errcode = 'PAT04';
    end if;
    if jsonb_typeof(existing.payload->'request') = 'object'
      and jsonb_typeof(incoming_payload->'request') = 'object'
      and existing.payload->'request' is distinct from incoming_payload->'request' then
      raise exception 'Agent Turn immutable request conflict' using errcode = 'PAT04';
    end if;
    if jsonb_typeof(existing.payload->'request') = 'object'
      and jsonb_typeof(incoming_payload->'request') is distinct from 'object' then
      incoming_payload := jsonb_set(incoming_payload, '{request}', existing.payload->'request', true);
    end if;
    if existing.status in ('completed', 'failed', 'cancelled')
      and incoming_status not in ('completed', 'failed', 'cancelled') then
      return existing.payload;
    end if;
    if existing.updated_at > incoming_updated_at then
      return existing.payload;
    end if;
    incoming_payload := incoming_payload || jsonb_build_object(
      'lastSequence', greatest(
        existing.last_sequence,
        coalesce(nullif(incoming_payload->>'lastSequence', '')::integer, 0)
      )
    );
    update public.agent_turns set
      session_id = nullif(p_turn->>'sessionId', ''),
      status = incoming_status,
      updated_at = incoming_updated_at,
      payload = incoming_payload,
      request_hash = coalesce(stored_hash, incoming_hash),
      request_hash_version = coalesce(stored_hash_version, incoming_hash_version)
    where id = p_turn_id;
  else
    insert into public.agent_turns (
      id, owner_id, project_id, session_id, idempotency_key, status, updated_at, payload,
      request_hash, request_hash_version, execution_version, lease_token, lease_expires_at, last_sequence
    ) values (
      p_turn_id, p_owner_id, p_project_id, nullif(p_turn->>'sessionId', ''),
      p_turn->>'idempotencyKey', incoming_status, incoming_updated_at, incoming_payload,
      incoming_hash, incoming_hash_version, 0, null, null,
      coalesce(nullif(incoming_payload->>'lastSequence', '')::integer, 0)
    );
  end if;

  select payload into stored_payload from public.agent_turns where id = p_turn_id;
  insert into public.audit_events (id, actor_id, action, project_id, target_id, detail)
  values (
    'audit_agent_turn_compatible_' || md5(p_turn_id || ':' || incoming_updated_ms::text),
    p_owner_id, 'agent-turn.' || incoming_status, p_project_id, p_turn_id,
    jsonb_build_object('compatibleWrite', true)
  ) on conflict (id) do nothing;
  return stored_payload;
end;
$$;

revoke all on function public.botanic_claim_agent_turn_execution(uuid, text, text, jsonb)
from public, anon, authenticated;
grant execute on function public.botanic_claim_agent_turn_execution(uuid, text, text, jsonb)
to service_role;

revoke all on function public.botanic_commit_agent_turn_execution(uuid, text, text, jsonb)
from public, anon, authenticated;
grant execute on function public.botanic_commit_agent_turn_execution(uuid, text, text, jsonb)
to service_role;

revoke all on function public.botanic_request_agent_turn_cancellation(uuid, text, text, jsonb)
from public, anon, authenticated;
grant execute on function public.botanic_request_agent_turn_cancellation(uuid, text, text, jsonb)
to service_role;

revoke all on function public.botanic_put_agent_turn_compatible(uuid, text, text, jsonb)
from public, anon, authenticated;
grant execute on function public.botanic_put_agent_turn_compatible(uuid, text, text, jsonb)
to service_role;

commit;
