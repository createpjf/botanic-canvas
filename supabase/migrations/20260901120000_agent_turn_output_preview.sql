-- ADR 0012: fenced replace-style Agent Turn output preview.
-- Preview text lives only in the active Turn payload; append-only events contain metadata, never text.

create or replace function public.botanic_clear_terminal_turn_output_preview()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.status in ('waiting_user', 'completed', 'failed', 'cancelled') then
    new.payload := coalesce(new.payload, '{}'::jsonb) - 'outputPreview';
  end if;
  return new;
end;
$$;

drop trigger if exists agent_turn_clear_terminal_output_preview on public.agent_turns;
create trigger agent_turn_clear_terminal_output_preview
before insert or update on public.agent_turns
for each row execute function public.botanic_clear_terminal_turn_output_preview();

revoke all on function public.botanic_clear_terminal_turn_output_preview()
from public, anon, authenticated;

create or replace function public.botanic_commit_agent_turn_output_preview(
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
  preview jsonb;
  stored_preview jsonb;
  event_value jsonb;
  execution_payload jsonb;
  stored_payload jsonb;
  stored_event jsonb;
  observed_at timestamptz;
  observed_ms bigint;
  lease_duration_ms bigint;
  requested_generation bigint;
  requested_revision integer;
  stored_revision integer;
  authoritative_last_sequence integer;
  next_sequence integer;
begin
  preview := p_command->'outputPreview';
  event_value := p_command->'event';
  if p_owner_id is null or nullif(p_turn_id, '') is null or nullif(p_project_id, '') is null
    or jsonb_typeof(p_command) is distinct from 'object'
    or nullif(p_command->>'leaseToken', '') is null
    or p_command->>'executionGeneration' !~ '^[1-9][0-9]*$'
    or p_command->>'status' is distinct from 'running'
    or jsonb_typeof(preview) is distinct from 'object'
    or preview->>'version' is distinct from '1'
    or coalesce(preview->>'attemptId', '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
    or preview->>'revision' !~ '^[1-9][0-9]*$'
    or preview->>'step' !~ '^[0-9]+$'
    or (preview->>'step')::integer > 64
    or jsonb_typeof(preview->'text') is distinct from 'string'
    or length(preview->>'text') > 12288
    or (preview ? 'truncated' and jsonb_typeof(preview->'truncated') is distinct from 'boolean')
    or jsonb_typeof(event_value) is distinct from 'object'
    or event_value->>'type' is distinct from 'turn.output_preview.updated'
    or event_value->>'turnId' is distinct from p_turn_id
    or event_value->>'projectId' is distinct from p_project_id
    or nullif(event_value->>'id', '') is null then
    raise exception 'Invalid Agent Turn output preview commit' using errcode = '22023';
  end if;
  requested_generation := (p_command->>'executionGeneration')::bigint;
  requested_revision := (preview->>'revision')::integer;

  perform pg_advisory_xact_lock(hashtextextended(p_turn_id, 3));
  select * into existing from public.agent_turns where id = p_turn_id for update;
  if existing.id is null or existing.owner_id <> p_owner_id or existing.project_id <> p_project_id then
    raise exception 'Agent Turn not found' using errcode = 'PAT02';
  end if;
  if existing.status <> 'running'
    or existing.execution_version <> requested_generation
    or existing.lease_token is distinct from p_command->>'leaseToken' then
    return jsonb_build_object('kind', 'stale', 'turn', existing.payload);
  end if;

  select * into existing_event from public.agent_turn_events where id = event_value->>'id' for update;
  if existing_event.id is not null and (
    existing_event.turn_id <> p_turn_id
    or existing_event.project_id <> p_project_id
    or existing_event.type <> 'turn.output_preview.updated'
  ) then
    raise exception 'Agent Turn event conflict' using errcode = 'PAT03';
  end if;

  stored_payload := existing.payload;
  stored_preview := stored_payload->'outputPreview';
  if stored_preview is null then
    if requested_revision <> 1 then
      return jsonb_build_object('kind', 'conflict', 'turn', stored_payload);
    end if;
  else
    if jsonb_typeof(stored_preview) is distinct from 'object'
      or stored_preview->>'revision' !~ '^[1-9][0-9]*$' then
      return jsonb_build_object('kind', 'conflict', 'turn', stored_payload);
    end if;
    stored_revision := (stored_preview->>'revision')::integer;
    if requested_revision = stored_revision then
      if (preview - 'updatedAt') = (stored_preview - 'updatedAt') then
        if existing_event.id is not null then
          stored_event := jsonb_build_object(
            'id', existing_event.id, 'turnId', existing_event.turn_id,
            'ownerId', existing_event.owner_id, 'projectId', existing_event.project_id,
            'sequence', existing_event.sequence, 'type', existing_event.type,
            'createdAt', floor(extract(epoch from existing_event.created_at) * 1000)::bigint,
            'executionGeneration', existing_event.execution_version,
            'payload', existing_event.payload
          );
        end if;
        return jsonb_strip_nulls(jsonb_build_object('kind', 'replay', 'turn', stored_payload, 'event', stored_event));
      end if;
      return jsonb_build_object('kind', 'conflict', 'turn', stored_payload);
    end if;
    if requested_revision < stored_revision then
      return jsonb_build_object('kind', 'stale', 'turn', stored_payload);
    end if;
    if requested_revision <> stored_revision + 1 then
      return jsonb_build_object('kind', 'conflict', 'turn', stored_payload);
    end if;
  end if;

  if existing_event.id is not null then
    return jsonb_build_object('kind', 'conflict', 'turn', stored_payload);
  end if;

  observed_at := clock_timestamp();
  observed_ms := floor(extract(epoch from observed_at) * 1000)::bigint;
  preview := (preview - 'updatedAt') || jsonb_build_object('updatedAt', observed_ms);
  event_value := (event_value - 'payload') || jsonb_build_object('payload', jsonb_strip_nulls(jsonb_build_object(
    'revision', requested_revision,
    'attemptId', preview->>'attemptId',
    'step', (preview->>'step')::integer,
    'charCount', length(preview->>'text'),
    'truncated', case when coalesce((preview->>'truncated')::boolean, false) then true else null end
  )));
  lease_duration_ms := greatest(30000, coalesce(nullif(stored_payload->'execution'->>'leaseDurationMs', '')::bigint, 120000));
  execution_payload := coalesce(stored_payload->'execution', '{}'::jsonb) || jsonb_build_object(
    'generation', requested_generation,
    'leaseToken', p_command->>'leaseToken',
    'leaseExpiresAt', observed_ms + lease_duration_ms,
    'lastHeartbeatAt', observed_ms
  );

  select greatest(existing.last_sequence, coalesce(max(sequence), 0))::integer
    into authoritative_last_sequence
  from public.agent_turn_events where turn_id = p_turn_id;
  next_sequence := authoritative_last_sequence + 1;
  insert into public.agent_turn_events (
    id, turn_id, owner_id, project_id, sequence, type, created_at, payload, execution_version
  ) values (
    event_value->>'id', p_turn_id, p_owner_id, p_project_id, next_sequence,
    event_value->>'type', observed_at, event_value->'payload', requested_generation
  );
  stored_event := jsonb_strip_nulls(event_value || jsonb_build_object(
    'ownerId', p_owner_id::text, 'projectId', p_project_id,
    'sequence', next_sequence, 'createdAt', observed_ms,
    'executionGeneration', requested_generation
  ));
  stored_payload := stored_payload || jsonb_build_object(
    'status', 'running', 'updatedAt', observed_ms, 'execution', execution_payload,
    'outputPreview', preview, 'lastSequence', next_sequence
  );
  update public.agent_turns set
    status = 'running', updated_at = observed_at, payload = stored_payload,
    lease_expires_at = observed_at + (lease_duration_ms::double precision * interval '1 millisecond'),
    last_sequence = next_sequence
  where id = p_turn_id;

  return jsonb_build_object('kind', 'committed', 'turn', stored_payload, 'event', stored_event);
end;
$$;

revoke all on function public.botanic_commit_agent_turn_output_preview(uuid, text, text, jsonb)
from public, anon, authenticated;
grant execute on function public.botanic_commit_agent_turn_output_preview(uuid, text, text, jsonb)
to service_role;
