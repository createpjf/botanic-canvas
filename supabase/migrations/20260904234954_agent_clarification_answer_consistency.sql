begin;

-- 只升级 Message 合并与能力签名，不改表、不回填数据，旧调用方仍共享同一行锁合并。
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
  current_answered boolean;
  incoming_answered boolean;
  current_answers jsonb;
  incoming_answers jsonb;
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
  -- 与 agentMessageMerge.mjs 一致：确认答案不由客户端时钟覆盖。
  if p_current->>'kind' = 'question' and p_incoming->>'kind' = 'question'
    and nullif(p_current#>>'{question,id}', '') is not null
    and p_current#>>'{question,id}' is distinct from p_incoming#>>'{question,id}'
    and incoming_status in ('answered', 'submitted') then
    raise exception 'AGENT_MESSAGE_ANSWER_CONFLICT' using errcode = '23514';
  end if;
  if p_current->>'kind' = 'question' and p_incoming->>'kind' = 'question'
    and nullif(p_current#>>'{question,id}', '') is not null
    and p_current#>>'{question,id}' = p_incoming#>>'{question,id}' then
    current_answered := coalesce(current_status in ('answered', 'submitted'), false);
    incoming_answered := coalesce(incoming_status in ('answered', 'submitted'), false);
    if current_answered and incoming_answered then
      select coalesce(jsonb_object_agg(field->>'id', coalesce(field->'defaultValue', '""'::jsonb)), '{}'::jsonb)
        into current_answers from jsonb_array_elements(coalesce(p_current#>'{question,fields}', '[]'::jsonb)) field;
      select coalesce(jsonb_object_agg(field->>'id', coalesce(field->'defaultValue', '""'::jsonb)), '{}'::jsonb)
        into incoming_answers from jsonb_array_elements(coalesce(p_incoming#>'{question,fields}', '[]'::jsonb)) field;
      if current_answers is distinct from incoming_answers
        or p_current#>'{question,brief}' is distinct from p_incoming#>'{question,brief}'
        or p_current#>'{question,originalInstruction}' is distinct from p_incoming#>'{question,originalInstruction}'
        or p_current#>'{question,sourcePromptMessageId}' is distinct from p_incoming#>'{question,sourcePromptMessageId}'
        or p_current#>'{question,resolvedGeneration}' is distinct from p_incoming#>'{question,resolvedGeneration}' then
        raise exception 'AGENT_MESSAGE_ANSWER_CONFLICT' using errcode = '23514';
      end if;
      apply_body := false;
    elsif current_answered and incoming_status = 'pending' then
      apply_body := false;
    elsif current_status = 'pending' and incoming_answered then
      apply_body := true;
    end if;
  end if;
  if p_current->>'kind' = 'question' and p_incoming->>'kind' = 'text'
    and jsonb_typeof(p_incoming->'prompt') = 'string' and btrim(p_incoming->>'prompt') <> '' then
    apply_body := true;
  elsif p_incoming->>'kind' = 'question' and p_current->>'kind' = 'text'
    and jsonb_typeof(p_current->'prompt') = 'string' and btrim(p_current->>'prompt') <> '' then
    apply_body := false;
  end if;
  if is_turn_projection then
    if p_current->>'kind' = 'question'
      and (jsonb_typeof(p_incoming->'plan') = 'object' or nullif(p_incoming->>'runId', '') is not null) then
      apply_body := true;
    elsif p_incoming->>'kind' = 'question'
      and (jsonb_typeof(p_current->'plan') = 'object' or nullif(p_current->>'runId', '') is not null) then
      apply_body := false;
    end if;
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


create or replace function public.botanic_put_agent_message(
  p_actor_id uuid, p_project_id text, p_session_id text, p_message jsonb,
  p_updated_at timestamptz, p_preserve_entity_references boolean,
  p_preserve_clarification_answers boolean
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp
as $$
begin
  if p_preserve_clarification_answers is distinct from true then
    raise exception 'clarification preservation capability required' using errcode = '22023';
  end if;
  return public.botanic_put_agent_message(p_actor_id, p_project_id, p_session_id,
    p_message, p_updated_at, p_preserve_entity_references);
end;
$$;

create or replace function public.botanic_sync_agent_entities(
  p_owner_id uuid, p_project_id text, p_sessions jsonb, p_messages jsonb,
  p_memory jsonb, p_runs jsonb, p_deleted_memory jsonb,
  p_preserve_thread_summary boolean, p_preserve_entity_references boolean,
  p_insert_sessions_only boolean, p_preserve_clarification_answers boolean
) returns void language plpgsql security invoker set search_path = public, pg_temp
as $$
begin
  if p_preserve_clarification_answers is distinct from true then
    raise exception 'clarification preservation capability required' using errcode = '22023';
  end if;
  perform public.botanic_sync_agent_entities(p_owner_id, p_project_id, p_sessions,
    p_messages, p_memory, p_runs, p_deleted_memory, p_preserve_thread_summary,
    p_preserve_entity_references, p_insert_sessions_only);
end;
$$;

revoke all on function public.botanic_merge_agent_message_sticky_fields(jsonb, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.botanic_merge_agent_message_sticky_fields(jsonb, jsonb, boolean) to service_role;
revoke all on function public.botanic_put_agent_message(uuid, text, text, jsonb, timestamptz, boolean, boolean) from public, anon, authenticated;
grant execute on function public.botanic_put_agent_message(uuid, text, text, jsonb, timestamptz, boolean, boolean) to service_role;
revoke all on function public.botanic_sync_agent_entities(uuid, text, jsonb, jsonb, jsonb, jsonb, jsonb, boolean, boolean, boolean, boolean) from public, anon, authenticated;
grant execute on function public.botanic_sync_agent_entities(uuid, text, jsonb, jsonb, jsonb, jsonb, jsonb, boolean, boolean, boolean, boolean) to service_role;
notify pgrst, 'reload schema';
commit;
