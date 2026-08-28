begin;

-- uncertain Action Receipt 的人工调和。身份、决议、一次性重试授权与安全 Audit
-- 在同一行锁事务内提交；客户端时间与 actor 均不会成为权威。
create or replace function public.botanic_resolve_agent_action_receipt(
  p_owner_id uuid,
  p_receipt_id text,
  p_project_id text,
  p_command jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  existing public.agent_action_receipts%rowtype;
  member_role public.botanic_project_role;
  observed_at timestamptz;
  observed_ms bigint;
  requested_decision text;
  binding_hash text;
  requested_authorization jsonb;
  stored_authorization jsonb;
  authorization_ttl_ms bigint;
  authorization_anchor_ms bigint;
  stored_payload jsonb;
  stored_resolution jsonb;
  manual_retry_exhausted boolean;
begin
  requested_decision := p_command->>'decision';
  binding_hash := p_command->>'actionBindingHash';
  manual_retry_exhausted := coalesce(p_command->>'manualRetryExhausted', 'false') = 'true';
  if p_owner_id is null or nullif(p_receipt_id, '') is null or nullif(p_project_id, '') is null
    or nullif(p_command->>'toolCallId', '') is null
    or nullif(p_command->>'actionName', '') is null
    or nullif(p_command->>'intentHash', '') is null
    or nullif(binding_hash, '') is null
    or requested_decision not in ('confirmed_applied', 'confirmed_not_applied') then
    raise exception 'Invalid Agent action reconciliation' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_receipt_id, 2));
  select * into existing from public.agent_action_receipts where id = p_receipt_id for update;
  if existing.id is null or existing.owner_id <> p_owner_id or existing.project_id <> p_project_id then
    return jsonb_build_object('kind', 'not_found', 'changed', false);
  end if;

  select member.role into member_role
  from public.project_members as member
  where member.project_id = p_project_id and member.user_id = p_owner_id
  for share;
  if member_role is null or member_role not in ('owner', 'editor') then
    raise exception 'Agent action reconciliation forbidden' using errcode = '42501';
  end if;

  if existing.payload->>'toolCallId' is distinct from p_command->>'toolCallId'
    or existing.payload->>'actionName' is distinct from p_command->>'actionName'
    or existing.payload->>'intentHash' is distinct from p_command->>'intentHash'
    or (nullif(existing.payload->>'actionBindingHash', '') is not null
      and existing.payload->>'actionBindingHash' <> binding_hash) then
    return jsonb_build_object('kind', 'conflict', 'receipt', existing.payload, 'changed', false);
  end if;

  stored_resolution := existing.payload->'resolution';
  if stored_resolution is not null and jsonb_typeof(stored_resolution) = 'object' then
    if stored_resolution->>'decision' = requested_decision
      and stored_resolution->>'actorId' = p_owner_id::text
      and stored_resolution->>'actionBindingHash' = binding_hash
      and (coalesce(stored_resolution->>'manualRetryExhausted', 'false') = 'true') = manual_retry_exhausted then
      return jsonb_build_object('kind', 'replay', 'receipt', existing.payload, 'changed', false);
    end if;
    return jsonb_build_object('kind', 'conflict', 'receipt', existing.payload, 'changed', false);
  end if;
  if existing.payload->>'status' is distinct from 'uncertain' then
    return jsonb_build_object('kind', 'not_uncertain', 'receipt', existing.payload, 'changed', false);
  end if;

  observed_at := clock_timestamp();
  observed_ms := floor(extract(epoch from observed_at) * 1000)::bigint;
  requested_authorization := p_command->'manualRetryAuthorization';
  if requested_decision = 'confirmed_not_applied' then
    if manual_retry_exhausted then
      if requested_authorization is not null and jsonb_typeof(requested_authorization) <> 'null' then
        return jsonb_build_object('kind', 'invalid', 'receipt', existing.payload, 'changed', false);
      end if;
    elsif jsonb_typeof(requested_authorization) is distinct from 'object'
      or jsonb_typeof(requested_authorization->'version') is distinct from 'number'
      or coalesce(requested_authorization->>'version', '') not in ('1', '2')
      or nullif(requested_authorization->>'id', '') is null
      or requested_authorization->>'receiptId' is distinct from p_receipt_id
      or requested_authorization->>'intentHash' is distinct from p_command->>'intentHash'
      or requested_authorization->>'actionBindingHash' is distinct from binding_hash
      or requested_authorization->>'userId' is distinct from p_owner_id::text
      or requested_authorization->>'projectId' is distinct from p_project_id
      or nullif(requested_authorization->>'actionId', '') is null
      or requested_authorization ? 'consumedAt'
      or requested_authorization ? 'consumedByReceiptId' then
      return jsonb_build_object('kind', 'invalid', 'receipt', existing.payload, 'changed', false);
    else
      if requested_authorization->>'version' = '1' then
        -- 显式判 NULL；`NULL !~ regex` 的结果仍是 NULL，不能放任 SQL 三值逻辑
        -- 把缺失 issuedAt/expiresAt 的 malformed 授权当作通过。
        if nullif(requested_authorization->>'tokenHash', '') is null
          or nullif(requested_authorization->>'issuedAt', '') is null
          or requested_authorization->>'issuedAt' !~ '^[0-9]+$'
          or nullif(requested_authorization->>'expiresAt', '') is null
          or requested_authorization->>'expiresAt' !~ '^[0-9]+$' then
          return jsonb_build_object('kind', 'invalid', 'receipt', existing.payload, 'changed', false);
        end if;
        authorization_anchor_ms := (requested_authorization->>'issuedAt')::bigint;
      else
        if nullif(requested_authorization->>'boundRetryReceiptId', '') is null
          or requested_authorization->>'boundRetryReceiptId' = p_receipt_id
          or requested_authorization ? 'tokenHash'
          or requested_authorization ? 'tokenHint'
          or requested_authorization ? 'issuedAt'
          or nullif(requested_authorization->>'reservedAt', '') is null
          or requested_authorization->>'reservedAt' !~ '^[0-9]+$'
          or nullif(requested_authorization->>'expiresAt', '') is null
          or requested_authorization->>'expiresAt' !~ '^[0-9]+$' then
          return jsonb_build_object('kind', 'invalid', 'receipt', existing.payload, 'changed', false);
        end if;
        authorization_anchor_ms := (requested_authorization->>'reservedAt')::bigint;
      end if;
      if authorization_anchor_ms <= 0
        or (requested_authorization->>'expiresAt')::bigint <= authorization_anchor_ms then
        return jsonb_build_object('kind', 'invalid', 'receipt', existing.payload, 'changed', false);
      end if;
      authorization_ttl_ms := greatest(1, least(
        (requested_authorization->>'expiresAt')::bigint - authorization_anchor_ms,
        3600000
      ));
      if requested_authorization->>'version' = '1' then
        stored_authorization := jsonb_strip_nulls(jsonb_build_object(
          'version', 1,
          'id', requested_authorization->>'id',
          'receiptId', p_receipt_id,
          'intentHash', p_command->>'intentHash',
          'actionBindingHash', binding_hash,
          'userId', p_owner_id::text,
          'projectId', p_project_id,
          'actionId', requested_authorization->>'actionId',
          'tokenHash', requested_authorization->>'tokenHash',
          'tokenHint', nullif(requested_authorization->>'tokenHint', ''),
          'issuedAt', observed_ms,
          'expiresAt', observed_ms + authorization_ttl_ms
        ));
      else
        stored_authorization := jsonb_build_object(
          'version', 2,
          'id', requested_authorization->>'id',
          'receiptId', p_receipt_id,
          'intentHash', p_command->>'intentHash',
          'actionBindingHash', binding_hash,
          'userId', p_owner_id::text,
          'projectId', p_project_id,
          'actionId', requested_authorization->>'actionId',
          'boundRetryReceiptId', requested_authorization->>'boundRetryReceiptId',
          'reservedAt', observed_ms,
          'expiresAt', observed_ms + authorization_ttl_ms
        );
      end if;
    end if;
  elsif manual_retry_exhausted
    or (requested_authorization is not null and jsonb_typeof(requested_authorization) <> 'null') then
    return jsonb_build_object('kind', 'invalid', 'receipt', existing.payload, 'changed', false);
  end if;

  stored_payload := (
    existing.payload - 'result' - 'output' - 'artifacts'
      - 'leaseToken' - 'leaseDurationMs' - 'leaseExpiresAt'
  ) || jsonb_build_object(
    'status', case when requested_decision = 'confirmed_applied' then 'succeeded' else 'failed' end,
    'updatedAt', observed_ms,
    'actionBindingHash', binding_hash,
    'resolution', jsonb_strip_nulls(jsonb_build_object(
      'version', 1,
      'decision', requested_decision,
      'actorId', p_owner_id::text,
      'actionBindingHash', binding_hash,
      'resolvedAt', observed_ms,
      'manualRetryExhausted', case when manual_retry_exhausted then true else null end
    ))
  );
  if requested_decision = 'confirmed_applied' then
    stored_payload := stored_payload - 'error' - 'manualRetryAuthorization';
  elsif manual_retry_exhausted then
    stored_payload := (stored_payload || jsonb_build_object(
      'error', jsonb_build_object(
        'code', 'AGENT_ACTION_MANUAL_RETRY_EXHAUSTED',
        'message', '已人工确认该行动未生效；一次性手动重试机会已用完。',
        'statusCode', 409
      )
    )) - 'manualRetryAuthorization';
  else
    stored_payload := stored_payload || jsonb_build_object(
      'error', jsonb_build_object(
        'code', 'AGENT_ACTION_CONFIRMED_NOT_APPLIED',
        'message', '已人工确认该行动未生效，可使用一次性授权重新提交。',
        'statusCode', 409
      ),
      'manualRetryAuthorization', stored_authorization
    );
  end if;

  update public.agent_action_receipts set payload = stored_payload where id = p_receipt_id;
  insert into public.audit_events (id, actor_id, action, project_id, target_id, detail, created_at)
  values (
    'audit_agent_action_reconcile_' || md5(p_receipt_id),
    p_owner_id,
    'agent-action.reconciled',
    p_project_id,
    p_receipt_id,
    jsonb_build_object(
      'result', requested_decision,
      'status', stored_payload->>'status',
      'toolCallId', existing.payload->>'toolCallId',
      'toolName', existing.payload->>'actionName'
    ),
    observed_at
  ) on conflict (id) do nothing;
  return jsonb_build_object('kind', 'resolved', 'receipt', stored_payload, 'changed', true);
end;
$$;

-- 一次性授权的消费与 retryReceiptId 绑定。相同 token/action/retryReceiptId 的响应
-- 丢失重试返回 replay；其他新提交键永远不能复用这次授权。
create or replace function public.botanic_consume_agent_action_manual_retry(
  p_owner_id uuid,
  p_receipt_id text,
  p_project_id text,
  p_command jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  existing public.agent_action_receipts%rowtype;
  member_role public.botanic_project_role;
  observed_at timestamptz;
  observed_ms bigint;
  authorization jsonb;
  stored_authorization jsonb;
  stored_payload jsonb;
  public_authorization jsonb;
begin
  if p_owner_id is null or nullif(p_receipt_id, '') is null or nullif(p_project_id, '') is null
    or nullif(p_command->>'actionId', '') is null
    or nullif(p_command->>'toolCallId', '') is null
    or nullif(p_command->>'actionName', '') is null
    or nullif(p_command->>'intentHash', '') is null
    or nullif(p_command->>'actionBindingHash', '') is null
    or nullif(p_command->>'retryReceiptId', '') is null then
    raise exception 'Invalid Agent action manual retry consumption' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_receipt_id, 2));
  select * into existing from public.agent_action_receipts where id = p_receipt_id for update;
  if existing.id is null or existing.owner_id <> p_owner_id or existing.project_id <> p_project_id then
    return jsonb_build_object('kind', 'not_found', 'changed', false);
  end if;
  select member.role into member_role
  from public.project_members as member
  where member.project_id = p_project_id and member.user_id = p_owner_id
  for share;
  if member_role is null or member_role not in ('owner', 'editor') then
    raise exception 'Agent action retry forbidden' using errcode = '42501';
  end if;

  if existing.payload->>'toolCallId' is distinct from p_command->>'toolCallId'
    or existing.payload->>'actionName' is distinct from p_command->>'actionName'
    or existing.payload->>'intentHash' is distinct from p_command->>'intentHash'
    or existing.payload->>'actionBindingHash' is distinct from p_command->>'actionBindingHash'
    or existing.payload->'resolution'->>'actionBindingHash' is distinct from p_command->>'actionBindingHash' then
    return jsonb_build_object('kind', 'conflict', 'receipt', existing.payload, 'changed', false);
  end if;
  if existing.payload->>'status' is distinct from 'failed'
    or existing.payload->'resolution'->>'decision' is distinct from 'confirmed_not_applied' then
    return jsonb_build_object('kind', 'unavailable', 'receipt', existing.payload, 'changed', false);
  end if;

  authorization := existing.payload->'manualRetryAuthorization';
  if jsonb_typeof(authorization) is distinct from 'object'
    or jsonb_typeof(authorization->'version') is distinct from 'number'
    or nullif(authorization->>'id', '') is null
    or authorization->>'receiptId' is distinct from p_receipt_id
    or authorization->>'intentHash' is distinct from p_command->>'intentHash'
    or authorization->>'actionBindingHash' is distinct from p_command->>'actionBindingHash'
    or authorization->>'userId' is distinct from p_owner_id::text
    or authorization->>'projectId' is distinct from p_project_id
    or authorization->>'actionId' is distinct from p_command->>'actionId'
    or coalesce(authorization->>'version', '') not in ('1', '2') then
    return jsonb_build_object('kind', 'invalid', 'receipt', existing.payload, 'changed', false);
  end if;

  if authorization->>'version' = '1' then
    if nullif(authorization->>'tokenHash', '') is null
      or nullif(p_command->>'tokenHash', '') is null
      or authorization->>'tokenHash' is distinct from p_command->>'tokenHash'
      or nullif(authorization->>'issuedAt', '') is null
      or authorization->>'issuedAt' !~ '^[0-9]+$'
      or nullif(authorization->>'expiresAt', '') is null
      or authorization->>'expiresAt' !~ '^[0-9]+$' then
      return jsonb_build_object('kind', 'invalid', 'receipt', existing.payload, 'changed', false);
    end if;
    if (authorization->>'issuedAt')::bigint <= 0
      or (authorization->>'expiresAt')::bigint <= (authorization->>'issuedAt')::bigint then
      return jsonb_build_object('kind', 'invalid', 'receipt', existing.payload, 'changed', false);
    end if;
  else
    if nullif(authorization->>'boundRetryReceiptId', '') is null
      or nullif(authorization->>'reservedAt', '') is null
      or authorization->>'reservedAt' !~ '^[0-9]+$'
      or nullif(authorization->>'expiresAt', '') is null
      or authorization->>'expiresAt' !~ '^[0-9]+$' then
      return jsonb_build_object('kind', 'invalid', 'receipt', existing.payload, 'changed', false);
    end if;
    if (authorization->>'reservedAt')::bigint <= 0
      or (authorization->>'expiresAt')::bigint <= (authorization->>'reservedAt')::bigint then
      return jsonb_build_object('kind', 'invalid', 'receipt', existing.payload, 'changed', false);
    end if;
  end if;

  if authorization ? 'consumedAt' then
    if nullif(authorization->>'consumedAt', '') is null
      or authorization->>'consumedAt' !~ '^[0-9]+$'
      or nullif(authorization->>'consumedByReceiptId', '') is null then
      return jsonb_build_object('kind', 'invalid', 'receipt', existing.payload, 'changed', false);
    end if;
    if (authorization->>'consumedAt')::bigint <= 0 then
      return jsonb_build_object('kind', 'invalid', 'receipt', existing.payload, 'changed', false);
    end if;
    if authorization->>'consumedByReceiptId' = p_command->>'retryReceiptId' then
      public_authorization := jsonb_build_object(
        'id', authorization->>'id',
        'consumedAt', (authorization->>'consumedAt')::bigint,
        'consumedByReceiptId', authorization->>'consumedByReceiptId'
      );
      return jsonb_build_object(
        'kind', 'replay', 'receipt', existing.payload,
        'authorization', public_authorization, 'changed', false
      );
    end if;
    return jsonb_build_object('kind', 'already_consumed', 'receipt', existing.payload, 'changed', false);
  end if;

  if authorization->>'version' = '2'
    and authorization->>'boundRetryReceiptId' is distinct from p_command->>'retryReceiptId' then
    return jsonb_build_object('kind', 'conflict', 'receipt', existing.payload, 'changed', false);
  end if;

  observed_at := clock_timestamp();
  observed_ms := floor(extract(epoch from observed_at) * 1000)::bigint;
  if observed_ms >= (authorization->>'expiresAt')::bigint then
    return jsonb_build_object('kind', 'expired', 'receipt', existing.payload, 'changed', false);
  end if;

  stored_authorization := authorization || jsonb_build_object(
    'consumedAt', observed_ms,
    'consumedByReceiptId', p_command->>'retryReceiptId'
  );
  stored_payload := existing.payload || jsonb_build_object(
    'updatedAt', observed_ms,
    'manualRetryAuthorization', stored_authorization
  );
  update public.agent_action_receipts set payload = stored_payload where id = p_receipt_id;
  insert into public.audit_events (id, actor_id, action, project_id, target_id, detail, created_at)
  values (
    'audit_agent_action_retry_' || md5(p_receipt_id || ':' || authorization->>'id'),
    p_owner_id,
    'agent-action.manual-retry-consumed',
    p_project_id,
    p_receipt_id,
    jsonb_build_object(
      'authorizationId', authorization->>'id',
      'retryReceiptId', p_command->>'retryReceiptId',
      'toolCallId', existing.payload->>'toolCallId',
      'toolName', existing.payload->>'actionName'
    ),
    observed_at
  ) on conflict (id) do nothing;
  public_authorization := jsonb_build_object(
    'id', authorization->>'id',
    'consumedAt', observed_ms,
    'consumedByReceiptId', p_command->>'retryReceiptId'
  );
  return jsonb_build_object(
    'kind', 'consumed', 'receipt', stored_payload,
    'authorization', public_authorization, 'changed', true
  );
end;
$$;

-- Run/Job 深取消完成后，独立于原 leaseToken 收口 Turn；新 cancelled 事件与 Turn
-- terminal 状态、lastSequence 和 Audit 同事务提交。
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
  if p_owner_id is null or nullif(p_turn_id, '') is null or nullif(p_project_id, '') is null then
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
    -- cancelled 事件已存在而 Turn 尚未 cancelled 表示此前事务不完整；RPC 从不猜测或覆盖。
    raise exception 'Agent Turn cancellation state conflict' using errcode = 'PAT03';
  end if;

  observed_at := clock_timestamp();
  observed_ms := floor(extract(epoch from observed_at) * 1000)::bigint;
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
  cancellation_payload := coalesce(existing.payload->'cancellation', '{}'::jsonb)
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

revoke all on function public.botanic_resolve_agent_action_receipt(uuid, text, text, jsonb)
from public, anon, authenticated;
grant execute on function public.botanic_resolve_agent_action_receipt(uuid, text, text, jsonb)
to service_role;

revoke all on function public.botanic_consume_agent_action_manual_retry(uuid, text, text, jsonb)
from public, anon, authenticated;
grant execute on function public.botanic_consume_agent_action_manual_retry(uuid, text, text, jsonb)
to service_role;

revoke all on function public.botanic_finalize_agent_turn_cancellation(uuid, text, text, jsonb)
from public, anon, authenticated;
grant execute on function public.botanic_finalize_agent_turn_cancellation(uuid, text, text, jsonb)
to service_role;

commit;
