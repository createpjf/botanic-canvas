begin;

-- AgentSubagent 只拥有生命周期、FIFO 与取消围栏；每次 activation 的执行状态仍由
-- 现有 AgentTurn 权威承载。租约只存在于独立列，payload 永不保存 lease token。
create table if not exists public.agent_subagents (
  id text primary key,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  project_id text not null references public.projects(id) on delete cascade,
  root_turn_id text not null,
  parent_session_id text,
  session_id text not null unique references public.agent_sessions(id) on delete restrict,
  status text not null check (status in ('active', 'cancelling', 'cancelled')),
  cancel_generation bigint not null default 0 check (cancel_generation >= 0),
  last_enqueued_sequence integer not null default 0 check (last_enqueued_sequence >= 0),
  settled_through_sequence integer not null default 0 check (
    settled_through_sequence >= 0 and settled_through_sequence <= last_enqueued_sequence
  ),
  dispatch_generation bigint not null default 0 check (dispatch_generation >= 0),
  dispatch_activation_sequence integer,
  dispatch_lease_token text,
  dispatch_lease_expires_at timestamptz,
  idempotency_key text not null,
  request_hash text not null,
  payload jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (owner_id, project_id, idempotency_key),
  constraint agent_subagents_dispatch_shape check (
    (dispatch_activation_sequence is null and dispatch_lease_token is null and dispatch_lease_expires_at is null)
    or (dispatch_activation_sequence = settled_through_sequence + 1
      and dispatch_activation_sequence <= last_enqueued_sequence
      and nullif(dispatch_lease_token, '') is not null
      and dispatch_lease_expires_at is not null)
  )
);

create table if not exists public.agent_subagent_activations (
  subagent_id text not null references public.agent_subagents(id) on delete cascade,
  sequence integer not null check (sequence > 0),
  turn_id text not null unique references public.agent_turns(id) on delete restrict,
  input_message_id text not null references public.agent_messages(id) on delete restrict,
  result_message_id text not null,
  source_turn_id text not null,
  idempotency_key text not null,
  request_hash text not null,
  subagent_generation bigint not null check (subagent_generation >= 0),
  execution_generation bigint not null default 0 check (execution_generation >= 0),
  execution_cancel_generation bigint,
  execution_lease_token text,
  execution_lease_expires_at timestamptz,
  payload jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  settled_at timestamptz,
  primary key (subagent_id, sequence),
  unique (subagent_id, idempotency_key),
  unique (subagent_id, result_message_id),
  constraint agent_subagent_activations_execution_shape check (
    (execution_lease_token is null and execution_cancel_generation is null
      and execution_lease_expires_at is null)
    or (execution_generation > 0 and execution_cancel_generation is not null
      and nullif(execution_lease_token, '') is not null
      and execution_lease_expires_at is not null)
  )
);

create index if not exists agent_subagents_project_updated_idx
  on public.agent_subagents (project_id, updated_at desc);
create index if not exists agent_subagents_root_turn_idx
  on public.agent_subagents (project_id, root_turn_id, id collate "C" asc);
create index if not exists agent_subagents_runnable_idx
  on public.agent_subagents (updated_at asc, id collate "C" asc)
  where status <> 'cancelled' and settled_through_sequence < last_enqueued_sequence;
create index if not exists agent_subagent_activations_sequence_idx
  on public.agent_subagent_activations (subagent_id, sequence asc);
create index if not exists agent_subagent_activations_unsettled_idx
  on public.agent_subagent_activations (subagent_id, sequence asc)
  where settled_at is null;

alter table public.agent_subagents enable row level security;
alter table public.agent_subagent_activations enable row level security;

drop policy if exists "project members can read agent subagents" on public.agent_subagents;
drop policy if exists "project members can read agent subagent activations" on public.agent_subagent_activations;

-- 客户端没有 descriptor/activation 直读或写权；公共 DTO 只能经服务端鉴权 HTTP 资源读取，
-- 服务端持久化与 Worker 只能经 service_role/RPC 访问原始 payload 与 fencing 字段。
drop policy if exists "project editors can write agent subagents" on public.agent_subagents;
drop policy if exists "project editors can write agent subagent activations" on public.agent_subagent_activations;
revoke all on table public.agent_subagents from public, anon, authenticated;
revoke all on table public.agent_subagent_activations from public, anon, authenticated;

-- 公共投影永不包含租约；Worker RPC/secret-key read 会从权威列恢复它。
create or replace function public.botanic_public_agent_subagent_payload(
  p_payload jsonb,
  p_status text,
  p_cancel_generation bigint,
  p_last_enqueued_sequence integer,
  p_settled_through_sequence integer,
  p_dispatch_generation bigint,
  p_dispatch_activation_sequence integer,
  p_dispatch_lease_expires_at timestamptz,
  p_updated_at timestamptz
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_strip_nulls(
    (coalesce(p_payload, '{}'::jsonb)
      - 'dispatch' - 'ownerId' - 'idempotencyKey' - 'requestHash' - 'cancellation')
    || jsonb_build_object(
      'status', p_status,
      'cancelGeneration', p_cancel_generation,
      'lastEnqueuedSequence', p_last_enqueued_sequence,
      'settledThroughSequence', p_settled_through_sequence,
      'dispatch', case when p_dispatch_activation_sequence is null then null else jsonb_build_object(
        'activationId', p_payload->'dispatch'->'activationId',
        'generation', p_dispatch_generation,
        'activationSequence', p_dispatch_activation_sequence,
        'cancelGeneration', p_cancel_generation,
        'leaseExpiresAt', floor(extract(epoch from p_dispatch_lease_expires_at) * 1000)::bigint
      ) end,
      'cancellation', case when jsonb_typeof(p_payload->'cancellation') = 'object'
        then jsonb_strip_nulls(jsonb_build_object(
          'generation', p_payload->'cancellation'->'generation',
          'reason', p_payload->'cancellation'->'reason',
          'requestedAt', p_payload->'cancellation'->'requestedAt',
          'finalizedAt', p_payload->'cancellation'->'finalizedAt'
        )) else null end,
      'updatedAt', floor(extract(epoch from p_updated_at) * 1000)::bigint
    )
  )
$$;

create or replace function public.botanic_enqueue_agent_subagent_activation(
  p_actor_id uuid,
  p_command jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing public.agent_subagents%rowtype;
  prior_activation public.agent_subagent_activations%rowtype;
  stored public.agent_subagents%rowtype;
  root_turn public.agent_turns%rowtype;
  activation_payload jsonb := p_command->'activation';
  descriptor_payload jsonb := p_command->'subagent';
  session_payload jsonb := p_command->'session';
  message_payload jsonb := p_command->'inputMessage';
  turn_payload jsonb := p_command->'turn';
  observed_at timestamptz := clock_timestamp();
  observed_ms bigint;
  requested_kind text := p_command->>'kind';
  requested_id text := nullif(btrim(p_command->>'subagentId'), '');
  project_id text := nullif(btrim(p_command->>'projectId'), '');
  activation_sequence integer;
  max_activations integer;
  turn_intent jsonb;
  turn_request_hash text;
  entity_owner_id uuid;
  root_turn_id text;
  root_execution jsonb := p_command->'rootExecution';
begin
  if p_actor_id is null or jsonb_typeof(p_command) is distinct from 'object'
    or requested_kind not in ('start', 'followup')
    or requested_id is null or length(requested_id) > 160
    or project_id is null or length(project_id) > 160
    or nullif(btrim(p_command->>'idempotencyKey'), '') is null
    or nullif(btrim(p_command->>'requestHash'), '') is null
    or nullif(btrim(p_command->>'sourceTurnId'), '') is null
    or jsonb_typeof(p_command->'input') is distinct from 'object'
    or nullif(p_command->'input'->>'content', '') is null
    or jsonb_typeof(activation_payload) is distinct from 'object'
    or jsonb_typeof(message_payload) is distinct from 'object'
    or jsonb_typeof(turn_payload) is distinct from 'object'
    or activation_payload->>'sequence' !~ '^[1-9][0-9]*$'
    or activation_payload->>'cancelGeneration' !~ '^[0-9]+$'
    or turn_payload->>'requestHashVersion' !~ '^[0-9]+$' then
    raise exception 'invalid AgentSubagent enqueue command' using errcode = '22023';
  end if;
  if p_command ? 'rootExecution' and (
    jsonb_typeof(root_execution) is distinct from 'object'
    or root_execution->>'generation' !~ '^[1-9][0-9]*$'
    or nullif(btrim(root_execution->>'leaseToken'), '') is null
    or length(root_execution->>'leaseToken') > 240
  ) then
    raise exception 'invalid AgentSubagent root execution fence' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.project_members member
    where member.project_id = p_command->>'projectId' and member.user_id = p_actor_id
      and member.role::text in ('owner', 'editor')
  ) then
    raise exception 'AgentSubagent enqueue forbidden' using errcode = '42501';
  end if;
  observed_ms := floor(extract(epoch from observed_at) * 1000)::bigint;
  perform pg_advisory_xact_lock(hashtextextended(requested_id, 6));
  select * into existing from public.agent_subagents where id = requested_id for update;
  if requested_kind = 'followup' and not found then
    return jsonb_build_object('kind', 'missing', 'changed', false);
  end if;
  entity_owner_id := coalesce(existing.owner_id, p_actor_id);
  root_turn_id := case when requested_kind = 'followup'
    then existing.root_turn_id else nullif(btrim(descriptor_payload->>'rootTurnId'), '') end;
  select * into root_turn from public.agent_turns where id = root_turn_id for update;
  if not found or root_turn.owner_id <> entity_owner_id or root_turn.project_id <> project_id then
    raise exception 'AgentSubagent root Turn not found' using errcode = 'PSS05';
  end if;
  if root_turn.status in ('failed', 'cancelling', 'cancelled') then
    raise exception 'Agent Turn cannot delegate after cancellation or failure' using errcode = 'PSS06';
  elsif root_turn.status = 'queued' then
    raise exception 'Agent Turn is not ready to delegate' using errcode = 'PSS08';
  elsif root_turn.status = 'running' then
    if jsonb_typeof(root_execution) is distinct from 'object'
      or root_turn.payload->'execution'->>'generation' is distinct from root_execution->>'generation'
      or root_turn.payload->'execution'->>'leaseToken' is distinct from root_execution->>'leaseToken' then
      raise exception 'Agent Turn execution fence is stale' using errcode = 'PSS07';
    end if;
  elsif root_turn.status in ('completed', 'waiting_user') then
    if p_command ? 'rootExecution' then
      raise exception 'Agent Turn has no active execution lease' using errcode = 'PSS07';
    end if;
  else
    raise exception 'Agent Turn is not ready to delegate' using errcode = 'PSS08';
  end if;
  select * into prior_activation from public.agent_subagent_activations
  where subagent_id = requested_id
    and idempotency_key = p_command->>'idempotencyKey' for update;

  if found then
    if prior_activation.request_hash is distinct from p_command->>'requestHash' then
      return jsonb_build_object(
        'kind', 'conflict', 'changed', false,
        'subagent', case when existing.id is null then null else public.botanic_public_agent_subagent_payload(
          existing.payload, existing.status, existing.cancel_generation,
          existing.last_enqueued_sequence, existing.settled_through_sequence,
          existing.dispatch_generation, existing.dispatch_activation_sequence,
          existing.dispatch_lease_expires_at, existing.updated_at
        ) end,
        'activation', prior_activation.payload
      );
    end if;
    select * into stored from public.agent_subagents where id = requested_id;
    return jsonb_build_object(
      'kind', 'replay', 'changed', false,
      'subagent', public.botanic_public_agent_subagent_payload(
        stored.payload, stored.status, stored.cancel_generation,
        stored.last_enqueued_sequence, stored.settled_through_sequence,
        stored.dispatch_generation, stored.dispatch_activation_sequence,
        stored.dispatch_lease_expires_at, stored.updated_at
      ),
      'activation', prior_activation.payload,
      'turn', (select payload from public.agent_turns where id = prior_activation.turn_id)
    );
  end if;

  if requested_kind = 'start' then
    if existing.id is not null then
      return jsonb_build_object(
        'kind', 'conflict', 'changed', false,
        'subagent', public.botanic_public_agent_subagent_payload(
          existing.payload, existing.status, existing.cancel_generation,
          existing.last_enqueued_sequence, existing.settled_through_sequence,
          existing.dispatch_generation, existing.dispatch_activation_sequence,
          existing.dispatch_lease_expires_at, existing.updated_at
        )
      );
    end if;
    if jsonb_typeof(descriptor_payload) is distinct from 'object'
      or jsonb_typeof(session_payload) is distinct from 'object'
      or descriptor_payload->>'id' is distinct from requested_id
      or descriptor_payload->>'ownerId' is distinct from p_actor_id::text
      or descriptor_payload->>'projectId' is distinct from project_id
      or descriptor_payload->>'idempotencyKey' is distinct from p_command->>'idempotencyKey'
      or descriptor_payload->>'requestHash' is distinct from p_command->>'requestHash'
      or descriptor_payload->>'rootTurnId' is distinct from activation_payload->>'sourceTurnId'
      or descriptor_payload->>'capabilityHash' !~ '^[A-Za-z0-9_-]{43}$'
      or jsonb_typeof(descriptor_payload->'outputSchema') is distinct from 'object'
      or session_payload->>'id' is distinct from descriptor_payload->>'sessionId'
      or session_payload->>'kind' is distinct from 'subagent'
      or session_payload->>'subagentId' is distinct from requested_id then
      raise exception 'invalid AgentSubagent start materialization' using errcode = '22023';
    end if;
    max_activations := case when descriptor_payload->'budget'->>'maxActivations' ~ '^[0-9]+$'
      then (descriptor_payload->'budget'->>'maxActivations')::integer else null end;
    if max_activations is null or max_activations < 1 or max_activations > 8 then
      raise exception 'invalid AgentSubagent activation budget' using errcode = '22023';
    end if;
    activation_sequence := 1;
  else
    if existing.id is null then return jsonb_build_object('kind', 'missing', 'changed', false); end if;
    if existing.project_id <> project_id then
      return jsonb_build_object('kind', 'missing', 'changed', false);
    end if;
    if existing.status <> 'active' then
      return jsonb_build_object(
        'kind', 'inactive', 'changed', false,
        'subagent', public.botanic_public_agent_subagent_payload(
          existing.payload, existing.status, existing.cancel_generation,
          existing.last_enqueued_sequence, existing.settled_through_sequence,
          existing.dispatch_generation, existing.dispatch_activation_sequence,
          existing.dispatch_lease_expires_at, existing.updated_at
        )
      );
    end if;
    max_activations := case when existing.payload->'budget'->>'maxActivations' ~ '^[0-9]+$'
      then (existing.payload->'budget'->>'maxActivations')::integer else 8 end;
    if existing.last_enqueued_sequence >= least(max_activations, 8) then
      return jsonb_build_object(
        'kind', 'inactive', 'changed', false, 'reason', 'activation_budget_exhausted',
        'subagent', public.botanic_public_agent_subagent_payload(
          existing.payload, existing.status, existing.cancel_generation,
          existing.last_enqueued_sequence, existing.settled_through_sequence,
          existing.dispatch_generation, existing.dispatch_activation_sequence,
          existing.dispatch_lease_expires_at, existing.updated_at
        )
      );
    end if;
    activation_sequence := existing.last_enqueued_sequence + 1;
  end if;

  if requested_kind = 'followup' and (
    (activation_payload->>'sequence')::integer is distinct from activation_sequence
    or (activation_payload->>'cancelGeneration')::bigint is distinct from existing.cancel_generation
  ) then
    return jsonb_build_object('kind', 'retry', 'changed', false);
  end if;
  if requested_kind = 'start'
    and (activation_payload->>'cancelGeneration')::bigint <> 0 then
    raise exception 'invalid AgentSubagent start generation' using errcode = '22023';
  end if;

  if activation_payload->>'subagentId' is distinct from requested_id
    or activation_payload->>'ownerId' is distinct from entity_owner_id::text
    or activation_payload->>'projectId' is distinct from project_id
    or activation_payload->>'kind' is distinct from requested_kind
    or activation_payload->>'idempotencyKey' is distinct from p_command->>'idempotencyKey'
    or activation_payload->>'requestHash' is distinct from p_command->>'requestHash'
    or activation_payload->>'sourceTurnId' is distinct from p_command->>'sourceTurnId'
    or activation_payload->>'sessionId' is distinct from coalesce(existing.session_id, descriptor_payload->>'sessionId')
    or activation_payload->>'status' is distinct from 'queued'
    or activation_payload->>'turnId' is distinct from turn_payload->>'id'
    or activation_payload->>'inputMessageId' is distinct from message_payload->>'id'
    or activation_payload->>'resultMessageId' is distinct from 'agent-turn-result-' || (turn_payload->>'id')
    or message_payload->>'turnId' is distinct from turn_payload->>'id'
    or message_payload->>'role' is distinct from 'user'
    or message_payload->>'kind' is distinct from 'text'
    or message_payload->>'status' is distinct from 'submitted'
    or message_payload->>'content' is distinct from p_command->'input'->>'content'
    or turn_payload->>'ownerId' is distinct from entity_owner_id::text
    or turn_payload->>'projectId' is distinct from project_id
    or turn_payload->>'sessionId' is distinct from coalesce(existing.session_id, descriptor_payload->>'sessionId')
    or turn_payload->>'status' is distinct from 'queued'
    or nullif(turn_payload->>'requestHash', '') is null
    or (turn_payload->>'requestHashVersion')::integer is distinct from 2
    or turn_payload->'request'->>'runtimeOperation' is distinct from 'subagent'
    or jsonb_typeof(turn_payload->'request'->'input') is distinct from 'object'
    or turn_payload->'request'->'input'->>'subagentId' is distinct from requested_id
    or turn_payload->'request'->'input'->>'activationId' is distinct from activation_payload->>'id'
    or (turn_payload->'request'->'input'->>'activationSequence')::integer is distinct from activation_sequence
    or (turn_payload->'request'->'input'->>'cancelGeneration')::bigint
      is distinct from (activation_payload->>'cancelGeneration')::bigint
    or turn_payload->'request'->'input'->>'sessionId'
      is distinct from coalesce(existing.session_id, descriptor_payload->>'sessionId')
    or turn_payload->'request'->'input'->>'sourceTurnId' is distinct from p_command->>'sourceTurnId'
    or jsonb_typeof(turn_payload->'request'->'input'->'inputMessage') is distinct from 'object'
    or turn_payload->'request'->'input'->'inputMessage'->>'id' is distinct from message_payload->>'id'
    or turn_payload->'request'->'input'->'inputMessage'->>'content'
      is distinct from message_payload->>'content' then
    raise exception 'invalid AgentSubagent activation materialization' using errcode = '22023';
  end if;
  turn_intent := case
    when jsonb_typeof(turn_payload->'request') = 'object'
      and nullif(turn_payload->'request'->>'sessionId', '') is not null
      and jsonb_typeof(turn_payload->'request'->'inputMessage') = 'object'
      and nullif(turn_payload->'request'->'inputMessage'->>'id', '') is not null
    then turn_payload->'request' - 'messages'
    else turn_payload->'request'
  end;
  turn_request_hash := public.botanic_canonical_json_hash(turn_intent);
  if turn_payload->>'requestHash' is distinct from turn_request_hash then
    raise exception 'AgentSubagent Turn request hash mismatch' using errcode = '22023';
  end if;

  if requested_kind = 'start' then
    insert into public.agent_sessions (id, owner_id, project_id, updated_at, payload)
    values (
      descriptor_payload->>'sessionId', entity_owner_id, project_id, observed_at,
      session_payload || jsonb_build_object('createdAt', observed_ms, 'updatedAt', observed_ms)
    );
  end if;
  insert into public.agent_messages (id, owner_id, project_id, session_id, updated_at, payload)
  values (
    message_payload->>'id', entity_owner_id, project_id,
    coalesce(existing.session_id, descriptor_payload->>'sessionId'), observed_at,
    message_payload || jsonb_build_object('createdAt', observed_ms, 'updatedAt', observed_ms)
  );
  update public.agent_sessions set
    updated_at = greatest(updated_at, observed_at),
    payload = jsonb_set(
      payload, '{updatedAt}',
      to_jsonb(floor(extract(epoch from greatest(updated_at, observed_at)) * 1000)::bigint), true
    )
  where id = coalesce(existing.session_id, descriptor_payload->>'sessionId')
    and agent_sessions.project_id = p_command->>'projectId';
  insert into public.agent_turns (
    id, owner_id, project_id, session_id, idempotency_key, status, updated_at, payload,
    request_hash, request_hash_version, execution_version, lease_token,
    lease_expires_at, last_sequence
  ) values (
    turn_payload->>'id', entity_owner_id, project_id,
    coalesce(existing.session_id, descriptor_payload->>'sessionId'),
    turn_payload->>'idempotencyKey', 'queued', observed_at,
    turn_payload || jsonb_build_object('ownerId', entity_owner_id::text, 'projectId', project_id,
      'status', 'queued', 'createdAt', observed_ms, 'updatedAt', observed_ms),
    turn_request_hash, 2, 0, null, null, 0
  );

  if requested_kind = 'start' then
    insert into public.agent_subagents (
      id, owner_id, project_id, root_turn_id, parent_session_id, session_id,
      status, cancel_generation, last_enqueued_sequence, settled_through_sequence,
      dispatch_generation, dispatch_activation_sequence, dispatch_lease_token,
      dispatch_lease_expires_at, idempotency_key, request_hash, payload, created_at, updated_at
    ) values (
      requested_id, entity_owner_id, project_id, descriptor_payload->>'rootTurnId',
      nullif(descriptor_payload->>'parentSessionId', ''), descriptor_payload->>'sessionId',
      'active', 0, 1, 0, 0, null, null, null,
      p_command->>'idempotencyKey', p_command->>'requestHash',
      (descriptor_payload - 'dispatch') || jsonb_build_object('createdAt', observed_ms, 'updatedAt', observed_ms),
      observed_at, observed_at
    ) returning * into stored;
  else
    update public.agent_subagents set
      last_enqueued_sequence = activation_sequence,
      updated_at = observed_at,
      payload = (payload - 'dispatch') || jsonb_build_object(
        'lastEnqueuedSequence', activation_sequence, 'updatedAt', observed_ms
      )
    where id = requested_id returning * into stored;
  end if;

  insert into public.agent_subagent_activations (
    subagent_id, sequence, turn_id, input_message_id, result_message_id,
    source_turn_id, idempotency_key, request_hash, subagent_generation,
    payload, created_at, updated_at
  ) values (
    requested_id, activation_sequence, activation_payload->>'turnId',
    activation_payload->>'inputMessageId', activation_payload->>'resultMessageId',
    activation_payload->>'sourceTurnId', activation_payload->>'idempotencyKey',
    activation_payload->>'requestHash',
    (activation_payload->>'cancelGeneration')::bigint,
    (activation_payload - 'execution') || jsonb_build_object('createdAt', observed_ms, 'updatedAt', observed_ms),
    observed_at, observed_at
  );
  return jsonb_build_object(
    'kind', 'enqueued', 'changed', true,
    'subagent', public.botanic_public_agent_subagent_payload(
      stored.payload, stored.status, stored.cancel_generation,
      stored.last_enqueued_sequence, stored.settled_through_sequence,
      stored.dispatch_generation, stored.dispatch_activation_sequence,
      stored.dispatch_lease_expires_at, stored.updated_at
    ),
    'activation', (activation_payload - 'execution') || jsonb_build_object('createdAt', observed_ms, 'updatedAt', observed_ms),
    'turn', turn_payload || jsonb_build_object('ownerId', entity_owner_id::text,
      'projectId', project_id, 'status', 'queued', 'createdAt', observed_ms, 'updatedAt', observed_ms)
  );
end;
$$;


create or replace function public.botanic_claim_agent_subagent_activation(
  p_command jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  subagent public.agent_subagents%rowtype;
  activation public.agent_subagent_activations%rowtype;
  turn public.agent_turns%rowtype;
  observed_at timestamptz := clock_timestamp();
  observed_ms bigint;
  lease_duration_ms bigint;
  next_generation bigint;
  head_sequence integer;
  requested_id text := nullif(btrim(p_command->>'subagentId'), '');
  lease_token text := nullif(btrim(p_command->>'leaseToken'), '');
  worker_payload jsonb;
  worker_activation_payload jsonb;
  activation_status text;
begin
  if jsonb_typeof(p_command) is distinct from 'object'
    or requested_id is null or length(requested_id) > 160
    or lease_token is null or length(lease_token) > 240
    or (p_command ? 'activationId' and nullif(btrim(p_command->>'activationId'), '') is null)
    or (p_command ? 'allowTakeover' and jsonb_typeof(p_command->'allowTakeover') is distinct from 'boolean') then
    raise exception 'invalid AgentSubagent activation claim' using errcode = '22023';
  end if;
  lease_duration_ms := greatest(30000, least(
    case when p_command->>'leaseDurationMs' ~ '^[0-9]+$'
      then (p_command->>'leaseDurationMs')::bigint else 120000 end,
    900000
  ));
  observed_ms := floor(extract(epoch from observed_at) * 1000)::bigint;

  perform pg_advisory_xact_lock(hashtextextended(requested_id, 6));
  select * into subagent from public.agent_subagents
  where id = requested_id for update;
  if not found then return jsonb_build_object('kind', 'missing', 'changed', false); end if;

  worker_payload := (subagent.payload - 'dispatch') || jsonb_strip_nulls(jsonb_build_object(
    'status', subagent.status,
    'cancelGeneration', subagent.cancel_generation,
    'lastEnqueuedSequence', subagent.last_enqueued_sequence,
    'settledThroughSequence', subagent.settled_through_sequence,
    'dispatch', case when subagent.dispatch_activation_sequence is null then null else jsonb_build_object(
      'activationId', subagent.payload->'dispatch'->'activationId',
      'generation', subagent.dispatch_generation,
      'activationSequence', subagent.dispatch_activation_sequence,
      'cancelGeneration', subagent.cancel_generation,
      'leaseToken', subagent.dispatch_lease_token,
      'leaseExpiresAt', floor(extract(epoch from subagent.dispatch_lease_expires_at) * 1000)::bigint
    ) end,
    'updatedAt', floor(extract(epoch from subagent.updated_at) * 1000)::bigint
  ));
  if subagent.status = 'cancelling' then
    return jsonb_build_object('kind', 'cancelling', 'changed', false, 'subagent', worker_payload);
  end if;
  if subagent.status = 'cancelled' then
    return jsonb_build_object('kind', 'cancelled', 'changed', false, 'subagent', worker_payload);
  end if;
  head_sequence := subagent.settled_through_sequence + 1;
  if head_sequence > subagent.last_enqueued_sequence then
    return jsonb_build_object('kind', 'missing', 'changed', false, 'subagent', worker_payload);
  end if;
  select * into activation from public.agent_subagent_activations
  where subagent_id = requested_id and sequence = head_sequence for update;
  if not found then
    raise exception 'AgentSubagent FIFO head missing' using errcode = 'PSS01';
  end if;
  if nullif(p_command->>'activationId', '') is not null
    and activation.payload->>'id' is distinct from p_command->>'activationId' then
    return jsonb_build_object(
      'kind', 'not_head', 'changed', false, 'subagent', worker_payload,
      'activation', activation.payload
    );
  end if;
  activation_status := activation.payload->>'status';
  worker_activation_payload := activation.payload;
  if activation.execution_lease_token is not null then
    worker_activation_payload := (activation.payload - 'execution') || jsonb_build_object(
      'execution', coalesce(activation.payload->'execution', '{}'::jsonb) || jsonb_build_object(
        'generation', activation.execution_generation,
        'cancelGeneration', activation.execution_cancel_generation,
        'leaseToken', activation.execution_lease_token,
        'leaseExpiresAt', floor(extract(epoch from activation.execution_lease_expires_at) * 1000)::bigint
      )
    );
  end if;
  if activation_status in ('completed', 'failed', 'cancelled') then
    select * into turn from public.agent_turns where id = activation.turn_id;
    return jsonb_build_object(
      'kind', 'replay', 'changed', false, 'subagent', worker_payload,
      'activation', worker_activation_payload, 'turn', turn.payload
    );
  end if;
  if activation_status = 'cancelling' then
    return jsonb_build_object(
      'kind', 'cancelling', 'changed', false, 'subagent', worker_payload,
      'activation', worker_activation_payload
    );
  end if;
  if activation_status not in ('queued', 'running') then
    return jsonb_build_object(
      'kind', 'conflict', 'changed', false, 'subagent', worker_payload,
      'activation', worker_activation_payload
    );
  end if;
  if activation.subagent_generation <> subagent.cancel_generation then
    return jsonb_build_object(
      'kind', 'stale', 'changed', false, 'subagent', worker_payload,
      'activation', worker_activation_payload
    );
  end if;

  if subagent.dispatch_activation_sequence is not null then
    if subagent.dispatch_activation_sequence <> head_sequence then
      raise exception 'AgentSubagent dispatch does not point at FIFO head' using errcode = 'PSS01';
    end if;
    if activation_status <> 'running'
      or activation.execution_generation <> subagent.dispatch_generation
      or activation.execution_cancel_generation <> subagent.cancel_generation
      or activation.execution_lease_token is distinct from subagent.dispatch_lease_token
      or activation.execution_lease_expires_at is distinct from subagent.dispatch_lease_expires_at then
      raise exception 'AgentSubagent activation fence differs from descriptor dispatch' using errcode = 'PSS01';
    end if;
    if subagent.dispatch_lease_token = lease_token then
      select * into turn from public.agent_turns where id = activation.turn_id;
      return jsonb_build_object(
        'kind', 'claimed', 'changed', false, 'subagent', worker_payload,
        'activation', worker_activation_payload, 'turn', turn.payload
      );
    end if;
    if subagent.dispatch_lease_expires_at > observed_at then
      return jsonb_build_object(
        'kind', 'in_progress', 'changed', false, 'subagent', worker_payload,
        'activation', worker_activation_payload
      );
    end if;
    if coalesce((p_command->>'allowTakeover')::boolean, false) is not true then
      return jsonb_build_object(
        'kind', 'stale', 'changed', false, 'subagent', worker_payload,
        'activation', worker_activation_payload
      );
    end if;
  elsif activation_status = 'running' then
    return jsonb_build_object(
      'kind', 'conflict', 'changed', false, 'subagent', worker_payload,
      'activation', worker_activation_payload
    );
  end if;

  next_generation := activation.execution_generation + 1;
  update public.agent_subagents set
    dispatch_generation = next_generation,
    dispatch_activation_sequence = head_sequence,
    dispatch_lease_token = lease_token,
    dispatch_lease_expires_at = observed_at + make_interval(secs => lease_duration_ms::double precision / 1000.0),
    updated_at = observed_at,
    payload = (payload - 'dispatch') || jsonb_build_object(
      'dispatch', jsonb_build_object(
        'activationId', activation.payload->>'id',
        'activationSequence', head_sequence,
        'generation', next_generation,
        'cancelGeneration', subagent.cancel_generation,
        'leaseExpiresAt', observed_ms + lease_duration_ms
      ),
      'updatedAt', observed_ms
    )
  where id = requested_id
  returning * into subagent;

  update public.agent_subagent_activations set
    execution_generation = next_generation,
    execution_cancel_generation = subagent.cancel_generation,
    execution_lease_token = lease_token,
    execution_lease_expires_at = subagent.dispatch_lease_expires_at,
    updated_at = observed_at,
    payload = (payload - 'execution') || jsonb_build_object(
      'status', 'running',
      'cancelGeneration', subagent.cancel_generation,
      'execution', jsonb_build_object(
        'generation', next_generation,
        'cancelGeneration', subagent.cancel_generation,
        'leaseDurationMs', lease_duration_ms,
        'leaseExpiresAt', observed_ms + lease_duration_ms,
        'claimedAt', observed_ms,
        'lastHeartbeatAt', observed_ms
      ),
      'updatedAt', observed_ms
    )
  where subagent_id = requested_id and sequence = head_sequence
  returning * into activation;
  select * into turn from public.agent_turns where id = activation.turn_id;
  worker_activation_payload := (activation.payload - 'execution') || jsonb_build_object(
    'execution', activation.payload->'execution' || jsonb_build_object(
      'leaseToken', activation.execution_lease_token
    )
  );

  worker_payload := (subagent.payload - 'dispatch') || jsonb_build_object(
    'status', subagent.status,
    'cancelGeneration', subagent.cancel_generation,
    'lastEnqueuedSequence', subagent.last_enqueued_sequence,
    'settledThroughSequence', subagent.settled_through_sequence,
    'dispatch', jsonb_build_object(
      'activationId', activation.payload->>'id',
      'generation', subagent.dispatch_generation,
      'activationSequence', head_sequence,
      'cancelGeneration', subagent.cancel_generation,
      'leaseToken', subagent.dispatch_lease_token,
      'leaseExpiresAt', floor(extract(epoch from subagent.dispatch_lease_expires_at) * 1000)::bigint
    ),
    'updatedAt', observed_ms
  );
  return jsonb_build_object(
    'kind', 'claimed', 'changed', true, 'subagent', worker_payload,
    'activation', worker_activation_payload, 'turn', turn.payload
  );
end;
$$;

create or replace function public.botanic_settle_agent_subagent_activation(
  p_command jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  subagent public.agent_subagents%rowtype;
  activation public.agent_subagent_activations%rowtype;
  turn public.agent_turns%rowtype;
  existing_message public.agent_messages%rowtype;
  observed_at timestamptz := clock_timestamp();
  observed_ms bigint;
  requested_id text := nullif(btrim(p_command->>'subagentId'), '');
  activation_id text := nullif(btrim(p_command->>'activationId'), '');
  lease_token text := nullif(btrim(p_command->>'leaseToken'), '');
  requested_generation bigint;
  head_sequence integer;
  result_message jsonb;
  result_content text;
  terminal_status text;
  stored_payload jsonb;
begin
  if jsonb_typeof(p_command) is distinct from 'object'
    or requested_id is null or activation_id is null or lease_token is null
    or p_command->>'executionGeneration' !~ '^[1-9][0-9]*$'
    or p_command->>'cancelGeneration' !~ '^[0-9]+$' then
    raise exception 'invalid AgentSubagent activation settlement' using errcode = '22023';
  end if;
  requested_generation := (p_command->>'executionGeneration')::bigint;
  observed_ms := floor(extract(epoch from observed_at) * 1000)::bigint;
  perform pg_advisory_xact_lock(hashtextextended(requested_id, 6));
  select * into subagent from public.agent_subagents where id = requested_id for update;
  if not found then return jsonb_build_object('kind', 'missing', 'changed', false); end if;
  stored_payload := public.botanic_public_agent_subagent_payload(
    subagent.payload, subagent.status, subagent.cancel_generation,
    subagent.last_enqueued_sequence, subagent.settled_through_sequence,
    subagent.dispatch_generation, subagent.dispatch_activation_sequence,
    subagent.dispatch_lease_expires_at, subagent.updated_at
  );
  if subagent.status = 'cancelling' then
    return jsonb_build_object('kind', 'cancelling', 'changed', false, 'subagent', stored_payload);
  end if;
  if subagent.status <> 'active' then
    return jsonb_build_object('kind', 'conflict', 'changed', false, 'subagent', stored_payload);
  end if;
  head_sequence := subagent.settled_through_sequence + 1;
  select * into activation from public.agent_subagent_activations
  where subagent_id = requested_id and payload->>'id' = activation_id for update;
  if not found then return jsonb_build_object('kind', 'missing', 'changed', false, 'subagent', stored_payload); end if;
  if activation.sequence < head_sequence and activation.settled_at is not null then
    return jsonb_build_object(
      'kind', 'replay', 'changed', false, 'subagent', stored_payload,
      'activation', case when activation.execution_lease_token is null then activation.payload else
        (activation.payload - 'execution') || jsonb_build_object(
          'execution', coalesce(activation.payload->'execution', '{}'::jsonb) || jsonb_build_object(
            'generation', activation.execution_generation,
            'cancelGeneration', activation.execution_cancel_generation,
            'leaseToken', activation.execution_lease_token,
            'leaseExpiresAt', floor(extract(epoch from activation.execution_lease_expires_at) * 1000)::bigint
          )
        )
      end,
      'resultMessage', (select payload from public.agent_messages where id = activation.result_message_id)
    );
  end if;
  if activation.sequence <> head_sequence then
    return jsonb_build_object(
      'kind', 'not_head', 'changed', false, 'subagent', stored_payload,
      'activation', activation.payload
    );
  end if;
  if activation.subagent_generation <> subagent.cancel_generation
    or (p_command->>'cancelGeneration')::bigint <> subagent.cancel_generation
    or subagent.dispatch_generation <> requested_generation
    or subagent.dispatch_activation_sequence <> head_sequence
    or subagent.dispatch_lease_token is distinct from lease_token
    or activation.payload->>'status' is distinct from 'running'
    or activation.execution_generation <> requested_generation
    or activation.execution_cancel_generation <> subagent.cancel_generation
    or activation.execution_lease_token is distinct from lease_token
    or activation.execution_lease_expires_at is distinct from subagent.dispatch_lease_expires_at then
    return jsonb_build_object(
      'kind', 'stale', 'changed', false, 'subagent', stored_payload,
      'activation', activation.payload
    );
  end if;
  select * into turn from public.agent_turns where id = activation.turn_id for update;
  if not found then raise exception 'AgentSubagent activation Turn missing' using errcode = 'PSS01'; end if;
  if turn.owner_id <> subagent.owner_id or turn.project_id <> subagent.project_id
    or turn.status not in ('completed', 'failed', 'cancelled') then
    return jsonb_build_object(
      'kind', 'not_ready', 'changed', false, 'subagent', stored_payload,
      'activation', activation.payload, 'turn', turn.payload
    );
  end if;

  terminal_status := turn.status;
  result_content := case terminal_status
    when 'completed' then coalesce(
      nullif(turn.payload->'result'->>'answer', ''),
      nullif(turn.payload->'result'->>'summary', ''),
      case when jsonb_typeof(turn.payload->'result'->'output') = 'string'
        then nullif(turn.payload->'result'->>'output', '') else null end,
      left(coalesce((turn.payload->'result'->'output')::text, ''), 64000),
      'Subagent 已完成。'
    )
    when 'failed' then coalesce(nullif(turn.payload->'error'->>'message', ''), 'Subagent 未完成。')
    else 'Subagent 已取消。'
  end;
  if result_content = '' then result_content := 'Subagent 已完成。'; end if;
  result_message := jsonb_strip_nulls(jsonb_build_object(
    'id', activation.result_message_id,
    'role', 'assistant',
    'kind', case when terminal_status = 'completed' then 'text' else 'notice' end,
    'content', left(result_content, 64000),
    'turnId', activation.turn_id,
    'status', case when terminal_status = 'completed' then 'submitted' else 'failed' end,
    'entityReferences', case when terminal_status = 'completed'
      and jsonb_typeof(turn.payload->'result'->'entityReferences') = 'array'
      then turn.payload->'result'->'entityReferences' else null end,
    'createdAt', observed_ms,
    'updatedAt', observed_ms
  ));
  select * into existing_message from public.agent_messages
  where id = activation.result_message_id for update;
  if found and (
    existing_message.project_id <> subagent.project_id
    or existing_message.session_id <> subagent.session_id
    or existing_message.payload->>'turnId' is distinct from activation.turn_id
    or existing_message.payload->>'role' is distinct from 'assistant'
  ) then
    raise exception 'AgentSubagent result Message conflict' using errcode = 'PSS03';
  end if;
  if existing_message.id is null then
    insert into public.agent_messages (id, owner_id, project_id, session_id, updated_at, payload)
    values (
      activation.result_message_id, subagent.owner_id, subagent.project_id,
      subagent.session_id, observed_at, result_message
    );
  else
    result_message := existing_message.payload;
  end if;
  update public.agent_sessions set
    updated_at = greatest(updated_at, observed_at),
    payload = jsonb_set(
      payload, '{updatedAt}',
      to_jsonb(floor(extract(epoch from greatest(updated_at, observed_at)) * 1000)::bigint), true
    )
  where id = subagent.session_id and project_id = subagent.project_id;

  update public.agent_subagent_activations set
    execution_generation = 0,
    execution_cancel_generation = null,
    execution_lease_token = null,
    execution_lease_expires_at = null,
    settled_at = observed_at,
    updated_at = observed_at,
    payload = (payload - 'execution') || jsonb_build_object(
      'status', terminal_status,
      'settledAt', observed_ms,
      'settlement', jsonb_build_object(
        'turnStatus', terminal_status,
        'executionGeneration', requested_generation,
        'cancelGeneration', subagent.cancel_generation
      ),
      'updatedAt', observed_ms
    )
  where subagent_id = requested_id and sequence = head_sequence
  returning * into activation;
  update public.agent_subagents set
    settled_through_sequence = head_sequence,
    dispatch_generation = 0,
    dispatch_activation_sequence = null,
    dispatch_lease_token = null,
    dispatch_lease_expires_at = null,
    updated_at = observed_at,
    payload = (payload - 'dispatch') || jsonb_build_object(
      'settledThroughSequence', head_sequence,
      'updatedAt', observed_ms
    )
  where id = requested_id returning * into subagent;

  return jsonb_strip_nulls(jsonb_build_object(
    'kind', 'settled', 'changed', true,
    'subagent', public.botanic_public_agent_subagent_payload(
      subagent.payload, subagent.status, subagent.cancel_generation,
      subagent.last_enqueued_sequence, subagent.settled_through_sequence,
      subagent.dispatch_generation, subagent.dispatch_activation_sequence,
      subagent.dispatch_lease_expires_at, subagent.updated_at
    ),
    'activation', activation.payload, 'turn', turn.payload,
    'resultMessage', result_message,
    'nextActivation', case
      when subagent.status = 'active'
        and subagent.settled_through_sequence < subagent.last_enqueued_sequence
      then (
        select jsonb_build_object('activation', next_activation.payload, 'turn', next_turn.payload)
        from public.agent_subagent_activations next_activation
        join public.agent_turns next_turn on next_turn.id = next_activation.turn_id
        where next_activation.subagent_id = subagent.id
          and next_activation.sequence = subagent.settled_through_sequence + 1
          and next_activation.payload->>'status' = 'queued'
      ) else null end
  ));
end;
$$;


create or replace function public.botanic_request_agent_subagent_cancellation(
  p_actor_id uuid,
  p_command jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  subagent public.agent_subagents%rowtype;
  head_activation public.agent_subagent_activations%rowtype;
  observed_at timestamptz := clock_timestamp();
  observed_ms bigint;
  requested_id text := nullif(btrim(p_command->>'subagentId'), '');
  project_id text := nullif(btrim(p_command->>'projectId'), '');
  signal_id text := nullif(btrim(p_command->>'signalId'), '');
  cancellation jsonb;
  stored_payload jsonb;
  next_generation bigint;
  requested_status text;
  turn_ids jsonb;
begin
  if p_actor_id is null or jsonb_typeof(p_command) is distinct from 'object'
    or requested_id is null or length(requested_id) > 160
    or project_id is null or length(project_id) > 160
    or signal_id is null or length(signal_id) > 240
    or (p_command ? 'reason' and length(p_command->>'reason') > 500) then
    raise exception 'invalid AgentSubagent cancellation request' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(requested_id, 6));
  select * into subagent from public.agent_subagents
  where id = requested_id for update;
  if not found or subagent.project_id <> project_id then
    return jsonb_build_object('kind', 'missing', 'changed', false);
  end if;
  if not exists (
    select 1 from public.project_members
    where project_id = subagent.project_id and user_id = p_actor_id
      and role::text in ('owner', 'editor')
  ) then
    raise exception 'AgentSubagent cancellation forbidden' using errcode = '42501';
  end if;
  stored_payload := public.botanic_public_agent_subagent_payload(
    subagent.payload, subagent.status, subagent.cancel_generation,
    subagent.last_enqueued_sequence, subagent.settled_through_sequence,
    subagent.dispatch_generation, subagent.dispatch_activation_sequence,
    subagent.dispatch_lease_expires_at, subagent.updated_at
  );
  select * into head_activation from public.agent_subagent_activations
  where subagent_id = requested_id
    and sequence = subagent.settled_through_sequence + 1
  for update;
  cancellation := subagent.payload->'cancellation';
  if p_command ? 'expectedCancelGeneration' and (
    p_command->>'expectedCancelGeneration' !~ '^[0-9]+$'
    or (p_command->>'expectedCancelGeneration')::bigint <> subagent.cancel_generation
  ) then
    return jsonb_build_object(
      'kind', 'stale', 'changed', false, 'subagent', stored_payload,
      'activation', head_activation.payload
    );
  end if;
  if subagent.status = 'cancelled' then
    return jsonb_build_object(
      'kind', 'replay', 'changed', false, 'subagent', stored_payload,
      'activation', head_activation.payload
    );
  end if;
  if subagent.status = 'cancelling' then
    if jsonb_typeof(cancellation) is distinct from 'object'
      or cancellation->>'signalId' is distinct from signal_id then
      return jsonb_build_object('kind', 'conflict', 'changed', false, 'subagent', stored_payload);
    end if;
    return jsonb_build_object(
      'kind', 'replay', 'changed', false, 'subagent', stored_payload,
      'activation', head_activation.payload
    );
  end if;

  observed_ms := floor(extract(epoch from observed_at) * 1000)::bigint;
  next_generation := subagent.cancel_generation + 1;
  requested_status := case
    when subagent.settled_through_sequence = subagent.last_enqueued_sequence then 'cancelled'
    else 'cancelling'
  end;
  cancellation := jsonb_strip_nulls(jsonb_build_object(
    'version', 1,
    'signalId', signal_id,
    'requestedBy', p_actor_id::text,
    'requestedAt', observed_ms,
    'reason', coalesce(nullif(btrim(p_command->>'reason'), ''), '用户取消了 Subagent。'),
    'generation', next_generation,
    'finalizedAt', case when requested_status = 'cancelled' then observed_ms else null end
  ));
  update public.agent_subagents set
    status = requested_status,
    cancel_generation = next_generation,
    dispatch_generation = 0,
    dispatch_activation_sequence = null,
    dispatch_lease_token = null,
    dispatch_lease_expires_at = null,
    updated_at = observed_at,
    payload = (payload - 'dispatch') || jsonb_build_object(
      'status', requested_status,
      'cancelGeneration', next_generation,
      'cancellation', cancellation,
      'updatedAt', observed_ms
    )
  where id = requested_id returning * into subagent;

  update public.agent_subagent_activations set
    updated_at = observed_at,
    payload = payload || jsonb_build_object('status', 'cancelling', 'updatedAt', observed_ms)
  where subagent_id = requested_id
    and sequence = subagent.settled_through_sequence + 1
    and settled_at is null
  returning * into head_activation;

  select coalesce(jsonb_agg(activation.turn_id order by activation.sequence), '[]'::jsonb)
  into turn_ids
  from public.agent_subagent_activations activation
  join public.agent_turns turn on turn.id = activation.turn_id
  where activation.subagent_id = requested_id
    and turn.status in ('queued', 'running', 'waiting_user', 'cancelling');

  stored_payload := public.botanic_public_agent_subagent_payload(
    subagent.payload, subagent.status, subagent.cancel_generation,
    subagent.last_enqueued_sequence, subagent.settled_through_sequence,
    subagent.dispatch_generation, subagent.dispatch_activation_sequence,
    subagent.dispatch_lease_expires_at, subagent.updated_at
  );
  return jsonb_build_object(
    'kind', 'requested', 'changed', true, 'subagent', stored_payload,
    'activation', head_activation.payload,
    'turnIds', turn_ids
  );
end;
$$;

create or replace function public.botanic_finalize_agent_subagent_cancellation(
  p_actor_id uuid,
  p_command jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  subagent public.agent_subagents%rowtype;
  activation public.agent_subagent_activations%rowtype;
  turn public.agent_turns%rowtype;
  existing_message public.agent_messages%rowtype;
  observed_at timestamptz := clock_timestamp();
  observed_ms bigint;
  requested_id text := nullif(btrim(p_command->>'subagentId'), '');
  project_id text := nullif(btrim(p_command->>'projectId'), '');
  signal_id text := nullif(btrim(p_command->>'signalId'), '');
  requested_generation bigint;
  cancellation jsonb;
  result_message jsonb;
  result_content text;
  updated_activations jsonb := '[]'::jsonb;
  result_messages jsonb := '[]'::jsonb;
  last_activation jsonb;
  last_turn jsonb;
begin
  if p_actor_id is null or jsonb_typeof(p_command) is distinct from 'object'
    or requested_id is null or project_id is null or signal_id is null
    or p_command->>'cancelGeneration' !~ '^[1-9][0-9]*$' then
    raise exception 'invalid AgentSubagent cancellation finalization' using errcode = '22023';
  end if;
  requested_generation := (p_command->>'cancelGeneration')::bigint;
  observed_ms := floor(extract(epoch from observed_at) * 1000)::bigint;
  perform pg_advisory_xact_lock(hashtextextended(requested_id, 6));
  select * into subagent from public.agent_subagents where id = requested_id for update;
  if not found or subagent.project_id <> project_id then
    return jsonb_build_object('kind', 'missing', 'changed', false);
  end if;
  if not exists (
    select 1 from public.project_members member
    where member.project_id = subagent.project_id and member.user_id = p_actor_id
      and member.role::text in ('owner', 'editor')
  ) then
    raise exception 'AgentSubagent cancellation finalization forbidden' using errcode = '42501';
  end if;
  if subagent.cancel_generation <> requested_generation then
    return jsonb_build_object(
      'kind', 'stale', 'changed', false,
      'subagent', public.botanic_public_agent_subagent_payload(
        subagent.payload, subagent.status, subagent.cancel_generation,
        subagent.last_enqueued_sequence, subagent.settled_through_sequence,
        subagent.dispatch_generation, subagent.dispatch_activation_sequence,
        subagent.dispatch_lease_expires_at, subagent.updated_at
      )
    );
  end if;
  cancellation := subagent.payload->'cancellation';
  if jsonb_typeof(cancellation) is distinct from 'object'
    or cancellation->>'signalId' is distinct from signal_id
    or (cancellation->>'generation')::bigint is distinct from requested_generation then
    return jsonb_build_object('kind', 'stale', 'changed', false);
  end if;
  if subagent.status = 'cancelled' then
    return jsonb_build_object(
      'kind', 'replay', 'changed', false,
      'subagent', public.botanic_public_agent_subagent_payload(
        subagent.payload, subagent.status, subagent.cancel_generation,
        subagent.last_enqueued_sequence, subagent.settled_through_sequence,
        subagent.dispatch_generation, subagent.dispatch_activation_sequence,
        subagent.dispatch_lease_expires_at, subagent.updated_at
      )
    );
  end if;
  if subagent.status <> 'cancelling' then
    return jsonb_build_object('kind', 'conflict', 'changed', false);
  end if;
  if exists (
    select 1 from public.agent_subagent_activations candidate
    join public.agent_turns candidate_turn on candidate_turn.id = candidate.turn_id
    where candidate.subagent_id = requested_id
      and candidate.sequence > subagent.settled_through_sequence
      and candidate_turn.status not in ('completed', 'failed', 'cancelled')
  ) then
    return jsonb_build_object(
      'kind', 'not_ready', 'changed', false,
      'subagent', public.botanic_public_agent_subagent_payload(
        subagent.payload, subagent.status, subagent.cancel_generation,
        subagent.last_enqueued_sequence, subagent.settled_through_sequence,
        subagent.dispatch_generation, subagent.dispatch_activation_sequence,
        subagent.dispatch_lease_expires_at, subagent.updated_at
      )
    );
  end if;
  if (
    select count(*) from public.agent_subagent_activations candidate
    where candidate.subagent_id = requested_id
      and candidate.settled_at is null
  ) <> subagent.last_enqueued_sequence - subagent.settled_through_sequence
    or exists (
      select 1
      from generate_series(
        subagent.settled_through_sequence + 1,
        subagent.last_enqueued_sequence
      ) expected(sequence)
      left join public.agent_subagent_activations candidate
        on candidate.subagent_id = requested_id and candidate.sequence = expected.sequence
      where candidate.subagent_id is null or candidate.settled_at is not null
    ) then
    raise exception 'AgentSubagent cancellation FIFO is not gapless' using errcode = 'PSS01';
  end if;

  -- 取消收口按 activation.sequence 投影稳定 Message；不按消息时间排序，避免提前排队的
  -- followup 出现在上一 activation 结果之前。
  for activation in
    select * from public.agent_subagent_activations
    where subagent_id = requested_id and settled_at is null
    order by sequence asc
    for update
  loop
    select * into turn from public.agent_turns where id = activation.turn_id for update;
    if turn.owner_id <> subagent.owner_id or turn.project_id <> subagent.project_id
      or turn.status not in ('completed', 'failed', 'cancelled') then
      return jsonb_build_object('kind', 'not_ready', 'changed', false);
    end if;
    result_content := case turn.status
      when 'completed' then coalesce(
        nullif(turn.payload->'result'->>'answer', ''),
        nullif(turn.payload->'result'->>'summary', ''),
        case when jsonb_typeof(turn.payload->'result'->'output') = 'string'
          then nullif(turn.payload->'result'->>'output', '') else null end,
        left(coalesce((turn.payload->'result'->'output')::text, ''), 64000),
        'Subagent 已完成。'
      )
      when 'failed' then coalesce(nullif(turn.payload->'error'->>'message', ''), 'Subagent 未完成。')
      else 'Subagent 已取消。'
    end;
    if result_content = '' then result_content := 'Subagent 已取消。'; end if;
    result_message := jsonb_strip_nulls(jsonb_build_object(
      'id', activation.result_message_id,
      'role', 'assistant',
      'kind', case when turn.status = 'completed' then 'text' else 'notice' end,
      'content', left(result_content, 64000),
      'turnId', activation.turn_id,
      'status', case when turn.status = 'completed' then 'submitted' else 'failed' end,
      'entityReferences', case when turn.status = 'completed'
        and jsonb_typeof(turn.payload->'result'->'entityReferences') = 'array'
        then turn.payload->'result'->'entityReferences' else null end,
      'createdAt', observed_ms,
      'updatedAt', observed_ms
    ));
    select * into existing_message from public.agent_messages
    where id = activation.result_message_id for update;
    if found and (
      existing_message.project_id <> subagent.project_id
      or existing_message.session_id <> subagent.session_id
      or existing_message.payload->>'turnId' is distinct from activation.turn_id
      or existing_message.payload->>'role' is distinct from 'assistant'
    ) then
      raise exception 'AgentSubagent cancellation Message conflict' using errcode = 'PSS03';
    end if;
    if existing_message.id is null then
      insert into public.agent_messages (id, owner_id, project_id, session_id, updated_at, payload)
      values (
        activation.result_message_id, subagent.owner_id, subagent.project_id,
        subagent.session_id, observed_at, result_message
      );
    else
      result_message := existing_message.payload;
    end if;
    update public.agent_sessions set
      updated_at = greatest(updated_at, observed_at),
      payload = jsonb_set(
        payload, '{updatedAt}',
        to_jsonb(floor(extract(epoch from greatest(updated_at, observed_at)) * 1000)::bigint), true
      )
    where id = subagent.session_id and project_id = subagent.project_id;
    update public.agent_subagent_activations set
      subagent_generation = requested_generation,
      execution_generation = 0,
      execution_cancel_generation = null,
      execution_lease_token = null,
      execution_lease_expires_at = null,
      settled_at = observed_at,
      updated_at = observed_at,
      payload = (payload - 'execution') || jsonb_build_object(
        'status', turn.status,
        'cancelGeneration', requested_generation,
        'settledAt', observed_ms,
        'settlement', jsonb_build_object(
          'turnStatus', turn.status,
          'executionGeneration', case when activation.payload->'execution'->>'generation' ~ '^[0-9]+$'
            then (activation.payload->'execution'->>'generation')::bigint else 0 end,
          'cancelGeneration', requested_generation
        ),
        'updatedAt', observed_ms
      )
    where subagent_id = requested_id and sequence = activation.sequence
    returning * into activation;
    updated_activations := updated_activations || jsonb_build_array(activation.payload);
    result_messages := result_messages || jsonb_build_array(result_message);
    last_activation := activation.payload;
    last_turn := turn.payload;
  end loop;

  cancellation := coalesce(subagent.payload->'cancellation', '{}'::jsonb)
    || jsonb_build_object('finalizedAt', observed_ms);
  update public.agent_subagents set
    status = 'cancelled',
    settled_through_sequence = last_enqueued_sequence,
    dispatch_generation = 0,
    dispatch_activation_sequence = null,
    dispatch_lease_token = null,
    dispatch_lease_expires_at = null,
    updated_at = observed_at,
    payload = (payload - 'dispatch') || jsonb_build_object(
      'status', 'cancelled',
      'settledThroughSequence', last_enqueued_sequence,
      'cancellation', cancellation,
      'updatedAt', observed_ms
    )
  where id = requested_id returning * into subagent;
  return jsonb_build_object(
    'kind', 'finalized', 'changed', true,
    'subagent', public.botanic_public_agent_subagent_payload(
      subagent.payload, subagent.status, subagent.cancel_generation,
      subagent.last_enqueued_sequence, subagent.settled_through_sequence,
      subagent.dispatch_generation, subagent.dispatch_activation_sequence,
      subagent.dispatch_lease_expires_at, subagent.updated_at
    ),
    'activation', last_activation,
    'turn', last_turn,
    'activations', updated_activations,
    'resultMessages', result_messages
  );
end;
$$;


create or replace function public.botanic_list_agent_subagents_for_root_turn(
  p_actor_id uuid,
  p_project_id text,
  p_root_turn_id text,
  p_after_id text default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  bounded_limit integer;
  result jsonb;
begin
  if p_actor_id is null
    or nullif(btrim(p_project_id), '') is null
    or nullif(btrim(p_root_turn_id), '') is null
    or (p_after_id is not null and (nullif(btrim(p_after_id), '') is null or length(p_after_id) > 160)) then
    raise exception 'invalid AgentSubagent root Turn page' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.project_members member
    where member.project_id = p_project_id and member.user_id = p_actor_id
      and member.role::text in ('owner', 'editor', 'viewer')
  ) then
    raise exception 'AgentSubagent root Turn page forbidden' using errcode = '42501';
  end if;
  bounded_limit := greatest(1, least(coalesce(p_limit, 50), 200));
  select coalesce(jsonb_agg(entry.payload order by entry.id collate "C" asc), '[]'::jsonb)
  into result
  from (
    select subagent.id, public.botanic_public_agent_subagent_payload(
      subagent.payload, subagent.status, subagent.cancel_generation,
      subagent.last_enqueued_sequence, subagent.settled_through_sequence,
      subagent.dispatch_generation, subagent.dispatch_activation_sequence,
      subagent.dispatch_lease_expires_at, subagent.updated_at
    ) as payload
    from public.agent_subagents subagent
    where subagent.project_id = p_project_id
      and subagent.root_turn_id = p_root_turn_id
      and (p_after_id is null or subagent.id collate "C" > p_after_id collate "C")
    order by subagent.id collate "C" asc
    limit bounded_limit
  ) entry;
  return result;
end;
$$;


create or replace function public.botanic_list_runnable_agent_subagents(
  p_older_than_ms bigint default null,
  p_after_updated_at_ms bigint default null,
  p_after_id text default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  observed_at timestamptz := clock_timestamp();
  older_than timestamptz;
  after_updated_at timestamptz;
  bounded_limit integer;
  result jsonb;
begin
  if (p_after_updated_at_ms is null) <> (p_after_id is null)
    or (p_after_id is not null and (nullif(btrim(p_after_id), '') is null or length(p_after_id) > 160)) then
    raise exception 'invalid AgentSubagent recovery cursor' using errcode = '22023';
  end if;
  older_than := case when p_older_than_ms is null
    then observed_at
    else least(observed_at, to_timestamp(p_older_than_ms::double precision / 1000.0)) end;
  after_updated_at := case when p_after_updated_at_ms is null
    then null
    else to_timestamp(p_after_updated_at_ms::double precision / 1000.0) end;
  bounded_limit := greatest(1, least(coalesce(p_limit, 50), 200));

  select coalesce(jsonb_agg(entry.value order by entry.updated_at asc, entry.id collate "C" asc), '[]'::jsonb)
  into result
  from (
    select subagent.updated_at, subagent.id, jsonb_build_object(
      'subagent', (subagent.payload - 'dispatch') || jsonb_strip_nulls(jsonb_build_object(
        'status', subagent.status,
        'cancelGeneration', subagent.cancel_generation,
        'lastEnqueuedSequence', subagent.last_enqueued_sequence,
        'settledThroughSequence', subagent.settled_through_sequence,
        'dispatch', case when subagent.dispatch_activation_sequence is null then null else jsonb_build_object(
          'activationId', subagent.payload->'dispatch'->'activationId',
          'generation', subagent.dispatch_generation,
          'activationSequence', subagent.dispatch_activation_sequence,
          'cancelGeneration', subagent.cancel_generation,
          'leaseToken', subagent.dispatch_lease_token,
          'leaseExpiresAt', floor(extract(epoch from subagent.dispatch_lease_expires_at) * 1000)::bigint
        ) end,
        'updatedAt', floor(extract(epoch from subagent.updated_at) * 1000)::bigint
      )),
      'activation', case when activation.execution_lease_token is null then activation.payload else
        (activation.payload - 'execution') || jsonb_build_object(
          'execution', coalesce(activation.payload->'execution', '{}'::jsonb) || jsonb_build_object(
            'generation', activation.execution_generation,
            'cancelGeneration', activation.execution_cancel_generation,
            'leaseToken', activation.execution_lease_token,
            'leaseExpiresAt', floor(extract(epoch from activation.execution_lease_expires_at) * 1000)::bigint
          )
        )
      end,
      'turn', turn.payload
    ) as value
    from public.agent_subagents subagent
    join public.agent_subagent_activations activation
      on activation.subagent_id = subagent.id
      and activation.sequence = subagent.settled_through_sequence + 1
    join public.agent_turns turn on turn.id = activation.turn_id
    where subagent.status in ('active', 'cancelling')
      and subagent.settled_through_sequence < subagent.last_enqueued_sequence
      and subagent.updated_at <= older_than
      and (
        subagent.status = 'cancelling'
        or activation.payload->>'status' = 'queued'
        or (
          activation.payload->>'status' = 'running'
          and activation.execution_lease_expires_at <= observed_at
        )
      )
      and (
        after_updated_at is null
        or subagent.updated_at > after_updated_at
        or (subagent.updated_at = after_updated_at and subagent.id collate "C" > p_after_id collate "C")
      )
    order by subagent.updated_at asc, subagent.id collate "C" asc
    limit bounded_limit
  ) entry;
  return result;
end;
$$;

revoke all on function public.botanic_public_agent_subagent_payload(
  jsonb, text, bigint, integer, integer, bigint, integer, timestamptz, timestamptz
) from public, anon, authenticated;
revoke all on function public.botanic_enqueue_agent_subagent_activation(uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.botanic_claim_agent_subagent_activation(jsonb)
  from public, anon, authenticated;
revoke all on function public.botanic_settle_agent_subagent_activation(jsonb)
  from public, anon, authenticated;
revoke all on function public.botanic_request_agent_subagent_cancellation(uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.botanic_finalize_agent_subagent_cancellation(uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.botanic_list_agent_subagents_for_root_turn(
  uuid, text, text, text, integer
) from public, anon, authenticated;
revoke all on function public.botanic_list_runnable_agent_subagents(bigint, bigint, text, integer)
  from public, anon, authenticated;

grant execute on function public.botanic_public_agent_subagent_payload(
  jsonb, text, bigint, integer, integer, bigint, integer, timestamptz, timestamptz
) to service_role;
grant execute on function public.botanic_enqueue_agent_subagent_activation(uuid, jsonb)
  to service_role;
grant execute on function public.botanic_claim_agent_subagent_activation(jsonb)
  to service_role;
grant execute on function public.botanic_settle_agent_subagent_activation(jsonb)
  to service_role;
grant execute on function public.botanic_request_agent_subagent_cancellation(uuid, jsonb)
  to service_role;
grant execute on function public.botanic_finalize_agent_subagent_cancellation(uuid, jsonb)
  to service_role;
grant execute on function public.botanic_list_agent_subagents_for_root_turn(
  uuid, text, text, text, integer
) to service_role;
grant execute on function public.botanic_list_runnable_agent_subagents(bigint, bigint, text, integer)
  to service_role;
grant select, insert, update, delete on table public.agent_subagents to service_role;
grant select, insert, update, delete on table public.agent_subagent_activations to service_role;

commit;
