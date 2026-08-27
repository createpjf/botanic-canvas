begin;

-- Message 正文、Turn 终态与服务端派生引用共用同一行锁内合并。
-- entityReferences 只在稳定 assistant Turn 结果投影上是 once-bound：
-- 旧 writer 遗漏必须保留，无论 incoming 的 updated_at 更旧或相等都允许首次权威回填；
-- 两份已绑引用不同则 fail closed。普通 Message 仍随正文 LWW，不被这条规则剥离字段。
create or replace function public.botanic_merge_agent_message_sticky_fields(
  p_current jsonb,
  p_incoming jsonb,
  p_apply_body boolean
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = public, pg_temp
as $$
declare
  merged jsonb;
  apply_body boolean;
  effective_turn_id text;
  current_status text;
  incoming_status text;
  is_turn_projection boolean;
  current_cancel numeric;
  incoming_cancel numeric;
  earliest_cancel numeric;
  current_message_updated_at numeric;
  incoming_message_updated_at numeric;
begin
  if jsonb_typeof(p_incoming) is distinct from 'object'
    or p_apply_body is null then
    raise exception 'invalid Agent Message payload' using errcode = '22023';
  end if;

  apply_body := p_apply_body;
  if p_current ? 'turnId' then
    if p_incoming ? 'turnId'
      and p_current->>'turnId' is distinct from p_incoming->>'turnId' then
      raise exception 'AGENT_MESSAGE_TURN_ID_CONFLICT' using errcode = '23514';
    end if;
  end if;
  if p_current ? 'role'
    and p_incoming ? 'role'
    and p_current->>'role' is distinct from p_incoming->>'role' then
    raise exception 'AGENT_MESSAGE_ROLE_CONFLICT' using errcode = '23514';
  end if;
  if jsonb_typeof(p_current) = 'object'
    and (p_current ? 'turnRequestSnapshot' or p_incoming ? 'turnRequestSnapshot')
    and (
      p_current->>'kind' is distinct from p_incoming->>'kind'
      or p_current->>'content' is distinct from p_incoming->>'content'
      or p_current->'mentions' is distinct from p_incoming->'mentions'
      or p_current->'createdAt' is distinct from p_incoming->'createdAt'
    ) then
    raise exception 'AGENT_MESSAGE_TURN_REQUEST_CONFLICT' using errcode = '23514';
  end if;

  effective_turn_id := coalesce(nullif(p_current->>'turnId', ''), nullif(p_incoming->>'turnId', ''));
  current_status := p_current->>'status';
  incoming_status := p_incoming->>'status';
  is_turn_projection := effective_turn_id is not null
    and coalesce(p_incoming->>'id', p_current->>'id') = 'agent-turn-result-' || effective_turn_id
    and coalesce(p_current->>'role', p_incoming->>'role') = 'assistant'
    and coalesce(p_incoming->>'role', p_current->>'role') = 'assistant';
  if is_turn_projection then
    if current_status = 'failed' and incoming_status is distinct from 'failed' then
      apply_body := false;
    elsif incoming_status = 'failed' and current_status is distinct from 'failed' then
      apply_body := true;
    end if;
  end if;

  -- 普通正文遵循 updated_at LWW；终态与 sticky 字段不受正文新旧影响。
  merged := (case
    when apply_body or jsonb_typeof(p_current) is distinct from 'object' then p_incoming
    else p_current
  end) - 'role' - 'createdAt' - 'turnCancellationRequestedAt' - 'turnRequestSnapshot';
  if p_current ? 'role' then
    merged := jsonb_set(merged, '{role}', p_current->'role', true);
  elsif p_incoming ? 'role' then
    merged := jsonb_set(merged, '{role}', p_incoming->'role', true);
  end if;
  if p_current ? 'createdAt' then
    merged := jsonb_set(merged, '{createdAt}', p_current->'createdAt', true);
  elsif p_incoming ? 'createdAt' then
    merged := jsonb_set(merged, '{createdAt}', p_incoming->'createdAt', true);
  end if;
  if p_current ? 'turnId' then
    merged := jsonb_set(merged, '{turnId}', p_current->'turnId', true);
  elsif p_incoming ? 'turnId' then
    merged := jsonb_set(merged, '{turnId}', p_incoming->'turnId', true);
  end if;

  if p_current ? 'turnRequestSnapshot' then
    if p_incoming ? 'turnRequestSnapshot'
      and p_current->'turnRequestSnapshot' is distinct from p_incoming->'turnRequestSnapshot' then
      raise exception 'AGENT_MESSAGE_TURN_REQUEST_CONFLICT' using errcode = '23514';
    end if;
    merged := jsonb_set(merged, '{turnRequestSnapshot}', p_current->'turnRequestSnapshot', true);
  elsif p_incoming ? 'turnRequestSnapshot' then
    merged := jsonb_set(merged, '{turnRequestSnapshot}', p_incoming->'turnRequestSnapshot', true);
  end if;

  -- Entity References 是稳定 Turn 结果的服务端派生事实，不属于正文 LWW。
  if is_turn_projection then
    if p_current ? 'entityReferences'
      and p_incoming ? 'entityReferences'
      and p_current->'entityReferences' is distinct from p_incoming->'entityReferences' then
      raise exception 'AGENT_MESSAGE_ENTITY_REFERENCES_CONFLICT' using errcode = '23514';
    end if;
    merged := merged - 'entityReferences';
    if p_current ? 'entityReferences' then
      merged := jsonb_set(merged, '{entityReferences}', p_current->'entityReferences', true);
    elsif p_incoming ? 'entityReferences' then
      merged := jsonb_set(merged, '{entityReferences}', p_incoming->'entityReferences', true);
    end if;
  end if;

  if jsonb_typeof(p_current->'turnCancellationRequestedAt') = 'number' then
    current_cancel := (p_current->>'turnCancellationRequestedAt')::numeric;
    if current_cancel < 0
      or current_cancel <> trunc(current_cancel)
      or current_cancel > 9007199254740991 then
      current_cancel := null;
    end if;
  end if;
  if jsonb_typeof(p_incoming->'turnCancellationRequestedAt') = 'number' then
    incoming_cancel := (p_incoming->>'turnCancellationRequestedAt')::numeric;
    if incoming_cancel < 0
      or incoming_cancel <> trunc(incoming_cancel)
      or incoming_cancel > 9007199254740991 then
      incoming_cancel := null;
    end if;
  end if;

  if current_cancel is not null and incoming_cancel is not null then
    earliest_cancel := least(current_cancel, incoming_cancel);
  else
    earliest_cancel := coalesce(current_cancel, incoming_cancel);
  end if;
  if earliest_cancel is not null then
    merged := jsonb_set(
      merged,
      '{turnCancellationRequestedAt}',
      to_jsonb(earliest_cancel::bigint),
      true
    );
  end if;

  if jsonb_typeof(p_current->'updatedAt') = 'number' then
    current_message_updated_at := (p_current->>'updatedAt')::numeric;
    if current_message_updated_at < 0 then current_message_updated_at := null; end if;
  end if;
  if jsonb_typeof(p_incoming->'updatedAt') = 'number' then
    incoming_message_updated_at := (p_incoming->>'updatedAt')::numeric;
    if incoming_message_updated_at < 0 then incoming_message_updated_at := null; end if;
  end if;
  if current_message_updated_at is not null or incoming_message_updated_at is not null then
    merged := jsonb_set(
      merged,
      '{updatedAt}',
      to_jsonb(greatest(coalesce(current_message_updated_at, 0), coalesce(incoming_message_updated_at, 0))),
      true
    );
  end if;
  return merged;
end;
$$;

-- 新 Adapter 只调用六参签名。能力标记避免新应用在缺迁移时被误路由到
-- 五参旧函数；五参签名保留给滚动发布中的旧实例，它也会动态调用上面的新 helper。
create or replace function public.botanic_put_agent_message(
  p_actor_id uuid,
  p_project_id text,
  p_session_id text,
  p_message jsonb,
  p_updated_at timestamptz,
  p_preserve_entity_references boolean
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if p_preserve_entity_references is distinct from true then
    raise exception 'entity references preservation capability required' using errcode = '22023';
  end if;
  return public.botanic_put_agent_message(
    p_actor_id,
    p_project_id,
    p_session_id,
    p_message,
    p_updated_at
  );
end;
$$;

-- 九参签名是 CanvasDocument 双写的新 capability seam。Session 整个 payload
-- 原样转发给已部署的八参原子函数，不拆解或重建 threadSummary。
create or replace function public.botanic_sync_agent_entities(
  p_owner_id uuid,
  p_project_id text,
  p_sessions jsonb,
  p_messages jsonb,
  p_memory jsonb,
  p_runs jsonb,
  p_deleted_memory jsonb,
  p_preserve_thread_summary boolean,
  p_preserve_entity_references boolean
)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if p_preserve_thread_summary is distinct from true
    or p_preserve_entity_references is distinct from true then
    raise exception 'derived field preservation capabilities required' using errcode = '22023';
  end if;
  perform public.botanic_sync_agent_entities(
    p_owner_id,
    p_project_id,
    p_sessions,
    p_messages,
    p_memory,
    p_runs,
    p_deleted_memory,
    p_preserve_thread_summary
  );
end;
$$;

-- SECURITY INVOKER 不代表可公开调用。所有新旧签名都撤销 PUBLIC/anon/authenticated，
-- 只允许服务端 secret key 所属的 service_role 执行。
revoke all on function public.botanic_merge_agent_message_sticky_fields(jsonb, jsonb)
from public, anon, authenticated;
grant execute on function public.botanic_merge_agent_message_sticky_fields(jsonb, jsonb)
to service_role;

revoke all on function public.botanic_merge_agent_message_sticky_fields(jsonb, jsonb, boolean)
from public, anon, authenticated;
grant execute on function public.botanic_merge_agent_message_sticky_fields(jsonb, jsonb, boolean)
to service_role;

revoke all on function public.botanic_put_agent_message(uuid, text, text, jsonb, timestamptz)
from public, anon, authenticated;
grant execute on function public.botanic_put_agent_message(uuid, text, text, jsonb, timestamptz)
to service_role;

revoke all on function public.botanic_put_agent_message(uuid, text, text, jsonb, timestamptz, boolean)
from public, anon, authenticated;
grant execute on function public.botanic_put_agent_message(uuid, text, text, jsonb, timestamptz, boolean)
to service_role;

revoke all on function public.botanic_sync_agent_entities(uuid, text, jsonb, jsonb, jsonb, jsonb, jsonb)
from public, anon, authenticated;
grant execute on function public.botanic_sync_agent_entities(uuid, text, jsonb, jsonb, jsonb, jsonb, jsonb)
to service_role;

revoke all on function public.botanic_sync_agent_entities(uuid, text, jsonb, jsonb, jsonb, jsonb, jsonb, boolean)
from public, anon, authenticated;
grant execute on function public.botanic_sync_agent_entities(uuid, text, jsonb, jsonb, jsonb, jsonb, jsonb, boolean)
to service_role;

revoke all on function public.botanic_sync_agent_entities(uuid, text, jsonb, jsonb, jsonb, jsonb, jsonb, boolean, boolean)
from public, anon, authenticated;
grant execute on function public.botanic_sync_agent_entities(uuid, text, jsonb, jsonb, jsonb, jsonb, jsonb, boolean, boolean)
to service_role;

commit;
