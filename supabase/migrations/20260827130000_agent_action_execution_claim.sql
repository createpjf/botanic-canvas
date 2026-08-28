-- 不可重复 Agent Action 的执行所有权。
-- Receipt 仍以 payload 为兼容权威；两个 RPC 在同一事务锁内完成 claim / settle，
-- 防止多个 API 实例同时 read-miss 后各执行一次外部副作用。

create or replace function public.botanic_claim_agent_action_receipt(
  p_owner_id uuid,
  p_receipt_id text,
  p_project_id text,
  p_claim jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  existing public.agent_action_receipts%rowtype;
  member_role public.botanic_project_role;
  current_status text;
  observed_at bigint;
  lease_duration_ms bigint;
  lease_expires_at bigint;
  incoming_binding text;
  existing_binding text;
  stored_payload jsonb;
begin
  incoming_binding := nullif(btrim(p_claim->>'actionBindingHash'), '');
  if p_owner_id is null or nullif(p_receipt_id, '') is null or nullif(p_project_id, '') is null
    or nullif(p_claim->>'intentHash', '') is null
    or nullif(p_claim->>'leaseToken', '') is null
    or nullif(p_claim->>'toolCallId', '') is null
    or nullif(p_claim->>'actionName', '') is null
    or coalesce(p_claim->>'replayPolicy', '') not in ('safe', 'never') then
    raise exception 'Invalid Agent action claim' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_receipt_id, 2));
  select * into existing from public.agent_action_receipts where id = p_receipt_id for update;

  if existing.id is not null and (existing.owner_id <> p_owner_id or existing.project_id <> p_project_id) then
    return jsonb_build_object('kind', 'conflict');
  end if;
  if existing.id is not null then
    existing_binding := nullif(btrim(existing.payload->>'actionBindingHash'), '');
    -- contextual 与 legacy standalone 是两条互斥身份域；任一侧缺 binding 或
    -- 两个 binding 不同，都不能读取、接管或重放对方的 Receipt。
    if existing_binding is distinct from incoming_binding then
      return jsonb_build_object('kind', 'conflict', 'receipt', existing.payload);
    end if;
  end if;
  -- Supabase transport 会自动重试响应丢失的 RPC；原 claim 已提交时，同一租约
  -- 仍是执行权持有者。即使期间成员被撤权，也不能把已授权且可能已开始的行动悬空。
  if existing.id is not null
    and existing.payload->>'intentHash' = p_claim->>'intentHash'
    and existing.payload->>'status' = 'running'
    and existing.payload->>'leaseToken' = p_claim->>'leaseToken' then
    return jsonb_build_object('kind', 'claimed', 'receipt', existing.payload);
  end if;

  select member.role into member_role
  from public.project_members as member
  where member.project_id = p_project_id and member.user_id = p_owner_id
  for share;
  if member_role is null or member_role not in ('owner', 'editor') then
    raise exception 'Agent action claim forbidden' using errcode = '42501';
  end if;

  observed_at := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  lease_duration_ms := greatest(1000, least(
    case when p_claim->>'leaseDurationMs' ~ '^[0-9]+$'
      then (p_claim->>'leaseDurationMs')::bigint else 60000 end,
    900000
  ));

  if existing.id is null then
    stored_payload := jsonb_strip_nulls(jsonb_build_object(
      'id', p_receipt_id,
      'ownerId', p_owner_id,
      'projectId', p_project_id,
      'toolCallId', p_claim->>'toolCallId',
      'actionName', p_claim->>'actionName',
      'intentHash', p_claim->>'intentHash',
      'actionBindingHash', incoming_binding,
      'replayPolicy', p_claim->>'replayPolicy',
      'status', 'running',
      'leaseToken', p_claim->>'leaseToken',
      'leaseDurationMs', lease_duration_ms,
      'leaseExpiresAt', observed_at + lease_duration_ms,
      'createdAt', observed_at,
      'updatedAt', observed_at
    ));
    insert into public.agent_action_receipts (id, owner_id, project_id, created_at, payload)
    values (
      p_receipt_id,
      p_owner_id,
      p_project_id,
      to_timestamp(observed_at::double precision / 1000.0),
      stored_payload
    );
    return jsonb_build_object('kind', 'claimed', 'receipt', stored_payload);
  end if;

  if nullif(existing.payload->>'intentHash', '') is not null
    and existing.payload->>'intentHash' <> p_claim->>'intentHash' then
    return jsonb_build_object('kind', 'conflict');
  end if;

  current_status := coalesce(nullif(existing.payload->>'status', ''), 'succeeded');
  if current_status = 'succeeded' then
    return jsonb_build_object('kind', 'replay', 'receipt', existing.payload);
  end if;
  if current_status = 'failed'
    and existing.payload->>'replayPolicy' = 'safe'
    and p_claim->>'replayPolicy' = 'safe' then
    stored_payload := (existing.payload || jsonb_build_object(
      'status', 'running',
      'leaseToken', p_claim->>'leaseToken',
      'leaseDurationMs', lease_duration_ms,
      'leaseExpiresAt', observed_at + lease_duration_ms,
      'updatedAt', observed_at
    )) - 'error' - 'result';
    update public.agent_action_receipts set payload = stored_payload where id = p_receipt_id;
    return jsonb_build_object('kind', 'claimed', 'receipt', stored_payload);
  end if;
  if current_status in ('failed', 'uncertain') then
    return jsonb_build_object('kind', current_status, 'receipt', existing.payload);
  end if;
  if current_status <> 'running' then
    return jsonb_build_object('kind', 'conflict');
  end if;

  lease_expires_at := case when existing.payload->>'leaseExpiresAt' ~ '^[0-9]+$'
    then (existing.payload->>'leaseExpiresAt')::bigint else 0 end;
  if lease_expires_at > observed_at then
    return jsonb_build_object('kind', 'in_progress', 'receipt', existing.payload);
  end if;

  stored_payload := existing.payload || jsonb_build_object(
    'status', 'uncertain',
    'updatedAt', observed_at,
    'error', jsonb_build_object(
      'code', 'AGENT_ACTION_OUTCOME_UNKNOWN',
      'message', '行动执行租约已过期，副作用结果无法安全确认。',
      'statusCode', 409
    )
  );
  update public.agent_action_receipts set payload = stored_payload where id = p_receipt_id;
  return jsonb_build_object('kind', 'uncertain', 'receipt', stored_payload);
end;
$$;

create or replace function public.botanic_settle_agent_action_receipt(
  p_owner_id uuid,
  p_receipt_id text,
  p_project_id text,
  p_settlement jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  existing public.agent_action_receipts%rowtype;
  current_status text;
  observed_at bigint;
  stored_payload jsonb;
begin
  if p_owner_id is null or nullif(p_receipt_id, '') is null or nullif(p_project_id, '') is null
    or nullif(p_settlement->>'leaseToken', '') is null
    or coalesce(p_settlement->>'status', '') not in ('succeeded', 'failed', 'uncertain') then
    raise exception 'Invalid Agent action settlement' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_receipt_id, 2));
  select * into existing from public.agent_action_receipts where id = p_receipt_id for update;
  if existing.id is null or existing.owner_id <> p_owner_id or existing.project_id <> p_project_id then
    raise exception 'Agent action receipt not found' using errcode = 'PAA02';
  end if;
  current_status := coalesce(existing.payload->>'status', '');
  if current_status = p_settlement->>'status'
    and current_status in ('succeeded', 'failed', 'uncertain')
    and existing.payload->>'leaseToken' = p_settlement->>'leaseToken' then
    -- 同一租约的终态重试只读取第一次提交的权威结果；后续 payload 不得改写它。
    return existing.payload;
  end if;
  if current_status <> 'running'
    or existing.payload->>'leaseToken' is distinct from p_settlement->>'leaseToken' then
    raise exception 'Agent action lease is stale' using errcode = 'PAA01';
  end if;

  observed_at := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  stored_payload := existing.payload || jsonb_build_object(
    'status', p_settlement->>'status',
    'updatedAt', observed_at
  );
  if p_settlement->>'status' = 'succeeded' then
    stored_payload := (stored_payload || jsonb_build_object('result', p_settlement->'result')) - 'error';
  else
    stored_payload := (stored_payload || jsonb_build_object('error', p_settlement->'error')) - 'result';
  end if;
  update public.agent_action_receipts set payload = stored_payload where id = p_receipt_id;

  if p_settlement->>'status' = 'succeeded' then
    insert into public.agent_artifacts (
      project_id, id, owner_id, kind, source_kind, run_id, job_id,
      created_at, updated_at, payload
    )
    select p_project_id, selected_artifact.payload->>'id', p_owner_id,
      selected_artifact.payload->>'kind', 'agent_action',
      nullif(selected_artifact.payload->'provenance'->>'runId', ''), null,
      existing.created_at, to_timestamp(observed_at::double precision / 1000.0),
      selected_artifact.payload || jsonb_build_object(
        'origin', jsonb_strip_nulls(jsonb_build_object(
          'type', 'agent_action', 'actionId', existing.payload->>'toolCallId'
        )),
        'createdAt', (extract(epoch from existing.created_at) * 1000)::bigint,
        'updatedAt', observed_at
      )
    from (
      -- 同一 action 输出里若重复声明 Artifact ID，只采用最后一条；否则 PostgreSQL
      -- 会以 21000 拒绝单条 UPSERT 二次命中同一行，使成功回执无法 settle。
      select distinct on (candidate.payload->>'id') candidate.payload
      from jsonb_array_elements(case
        when jsonb_typeof(stored_payload->'output'->'artifacts') = 'array' then stored_payload->'output'->'artifacts'
        when jsonb_typeof(stored_payload->'result'->'output'->'artifacts') = 'array' then stored_payload->'result'->'output'->'artifacts'
        when jsonb_typeof(stored_payload->'result'->'artifacts') = 'array' then stored_payload->'result'->'artifacts'
        else '[]'::jsonb end) with ordinality as candidate(payload, position)
      where nullif(candidate.payload->>'id', '') is not null
        and candidate.payload->>'kind' in ('image', 'video', 'text', 'workflow', 'asset_group', 'file')
        and nullif(candidate.payload->>'label', '') is not null
        and jsonb_typeof(candidate.payload->'provenance') = 'object'
      order by candidate.payload->>'id', candidate.position desc
    ) as selected_artifact
    on conflict (project_id, id) do update set
      kind = excluded.kind,
      source_kind = excluded.source_kind,
      run_id = excluded.run_id,
      updated_at = excluded.updated_at,
      payload = excluded.payload
    where agent_artifacts.updated_at <= excluded.updated_at;

    insert into public.audit_events (id, actor_id, action, project_id, target_id, detail)
    values (
      'audit_agent_action_' || md5(p_receipt_id),
      p_owner_id,
      'agent-action.succeeded',
      p_project_id,
      p_receipt_id,
      jsonb_build_object('toolCallId', existing.payload->>'toolCallId')
    )
    on conflict (id) do nothing;
  end if;
  return stored_payload;
end;
$$;

revoke all on function public.botanic_claim_agent_action_receipt(uuid, text, text, jsonb)
from public, anon, authenticated;
grant execute on function public.botanic_claim_agent_action_receipt(uuid, text, text, jsonb)
to service_role;

revoke all on function public.botanic_settle_agent_action_receipt(uuid, text, text, jsonb)
from public, anon, authenticated;
grant execute on function public.botanic_settle_agent_action_receipt(uuid, text, text, jsonb)
to service_role;
