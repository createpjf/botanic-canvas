begin;

-- Model Context state 是当前 head；ledger 只追加每次成功 CAS。
-- usage-only 迁移也进 ledger 以保证历史幂等键可 replay，但 compaction_id 为 null。
create table if not exists public.agent_context_states (
  session_id text primary key references public.agent_sessions(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  project_id text not null references public.projects(id) on delete cascade,
  revision bigint not null default 0 check (revision >= 0),
  head_compaction_id text,
  head_compaction_sequence bigint,
  updated_at timestamptz not null default clock_timestamp(),
  payload jsonb not null,
  constraint agent_context_states_head_shape check (
    (head_compaction_id is null and head_compaction_sequence is null)
    or (nullif(head_compaction_id, '') is not null
      and head_compaction_sequence > 0 and head_compaction_sequence <= revision)
  )
);

create table if not exists public.agent_context_compactions (
  session_id text not null references public.agent_sessions(id) on delete cascade,
  sequence bigint not null check (sequence > 0),
  id text not null unique,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  project_id text not null references public.projects(id) on delete cascade,
  idempotency_key text not null,
  request_hash text not null,
  compaction_id text,
  created_at timestamptz not null default clock_timestamp(),
  payload jsonb not null,
  primary key (session_id, sequence),
  unique (session_id, idempotency_key),
  unique (session_id, compaction_id)
);

create index if not exists agent_context_compactions_session_sequence_idx
  on public.agent_context_compactions (session_id, sequence asc)
  where compaction_id is not null;

alter table public.agent_context_states enable row level security;
alter table public.agent_context_compactions enable row level security;

drop policy if exists "project members can read agent context states" on public.agent_context_states;
create policy "project members can read agent context states"
on public.agent_context_states for select to authenticated
using (public.botanic_has_project_role(
  project_id,
  array['owner', 'editor', 'viewer']::public.botanic_project_role[]
));

drop policy if exists "project members can read agent context compactions" on public.agent_context_compactions;
create policy "project members can read agent context compactions"
on public.agent_context_compactions for select to authenticated
using (public.botanic_has_project_role(
  project_id,
  array['owner', 'editor', 'viewer']::public.botanic_project_role[]
));

-- Context 是服务端派生的模型输入层；浏览器不能直写或绕过 CAS。
revoke all on table public.agent_context_states from public, anon, authenticated;
revoke all on table public.agent_context_compactions from public, anon, authenticated;

create or replace function public.botanic_compare_and_set_agent_context_state(
  p_actor_id uuid,
  p_command jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  command_project_id text;
  command_session_id text;
  command_idempotency_key text;
  supplied_hash text;
  computed_hash text;
  expected_revision bigint;
  current_revision bigint := 0;
  next_revision bigint;
  observed_at timestamptz;
  session_row public.agent_sessions%rowtype;
  state_row public.agent_context_states%rowtype;
  replay_row public.agent_context_compactions%rowtype;
  member_role public.botanic_project_role;
  request_payload jsonb;
  next_usage_anchor jsonb;
  next_head_compaction_id text;
  next_head_compaction_sequence bigint;
  next_state jsonb;
  ledger_payload jsonb;
  ledger_id text;
  incoming_compaction jsonb;
  incoming_compaction_id text;
begin
  if p_actor_id is null or jsonb_typeof(p_command) is distinct from 'object' then
    return jsonb_build_object('kind', 'invalid', 'changed', false);
  end if;
  command_project_id := nullif(btrim(p_command->>'projectId'), '');
  command_session_id := nullif(btrim(p_command->>'sessionId'), '');
  command_idempotency_key := nullif(btrim(p_command->>'idempotencyKey'), '');
  supplied_hash := nullif(btrim(p_command->>'requestHash'), '');
  if command_project_id is null or command_session_id is null or command_idempotency_key is null
    or length(command_project_id) > 200 or length(command_session_id) > 200 or length(command_idempotency_key) > 200
    or jsonb_typeof(p_command->'expectedRevision') is distinct from 'number'
    or (not (p_command ? 'usageAnchor') and not (p_command ? 'compaction')) then
    return jsonb_build_object('kind', 'invalid', 'changed', false);
  end if;
  begin
    if (p_command->>'expectedRevision')::numeric < 0
      or (p_command->>'expectedRevision')::numeric <> trunc((p_command->>'expectedRevision')::numeric)
      or (p_command->>'expectedRevision')::numeric > 9007199254740991 then
      return jsonb_build_object('kind', 'invalid', 'changed', false);
    end if;
    expected_revision := (p_command->>'expectedRevision')::bigint;
  exception when others then
    return jsonb_build_object('kind', 'invalid', 'changed', false);
  end;
  if p_command ? 'usageAnchor' and (
    jsonb_typeof(p_command->'usageAnchor') is distinct from 'object'
    or p_command->'usageAnchor'->'version' is distinct from '1'::jsonb
  ) then
    return jsonb_build_object('kind', 'invalid', 'changed', false);
  end if;
  if p_command ? 'compaction' and (
    jsonb_typeof(p_command->'compaction') is distinct from 'object'
    or p_command->'compaction'->'version' is distinct from '2'::jsonb
    or nullif(btrim(p_command->'compaction'->>'id'), '') is null
    or p_command->'compaction'->>'trigger' not in ('pre_step', 'overflow', 'manual')
    or jsonb_typeof(p_command->'compaction'->'checkpoint') is distinct from 'object'
    or p_command->'compaction'->'checkpoint'->>'role' is distinct from 'user'
    or jsonb_typeof(p_command->'compaction'->'checkpoint'->'content') is distinct from 'string'
    or public.botanic_canonical_json_hash(p_command->'compaction'->'checkpoint'->'content')
      is distinct from p_command->'compaction'->'checkpoint'->>'contentHash'
  ) then
    return jsonb_build_object('kind', 'invalid', 'changed', false);
  end if;

  request_payload := jsonb_strip_nulls(jsonb_build_object(
    'version', 2,
    'projectId', command_project_id,
    'sessionId', command_session_id,
    'usageAnchor', case when p_command ? 'usageAnchor' then p_command->'usageAnchor' else null end,
    'compaction', case when p_command ? 'compaction' then p_command->'compaction' else null end
  ));
  computed_hash := public.botanic_canonical_json_hash(request_payload);
  if supplied_hash is null or supplied_hash is distinct from computed_hash then
    return jsonb_build_object('kind', 'invalid', 'changed', false);
  end if;

  select session.* into session_row
  from public.agent_sessions as session
  where session.id = command_session_id and session.project_id = command_project_id
  for update;
  if session_row.id is null then
    return jsonb_build_object('kind', 'not_found', 'changed', false);
  end if;

  select member.role into member_role
  from public.project_members as member
  where member.project_id = command_project_id and member.user_id = p_actor_id
  for share;
  if member_role is null or member_role not in ('owner', 'editor') then
    raise exception 'Agent context CAS forbidden' using errcode = '42501';
  end if;

  select context_state.* into state_row
  from public.agent_context_states as context_state
  where context_state.session_id = command_session_id
  for update;
  if state_row.session_id is not null then current_revision := state_row.revision; end if;

  select ledger.* into replay_row
  from public.agent_context_compactions as ledger
  where ledger.session_id = command_session_id
    and ledger.idempotency_key = command_idempotency_key;
  if replay_row.id is not null then
    if replay_row.request_hash is distinct from computed_hash then
      return jsonb_strip_nulls(jsonb_build_object(
        'kind', 'conflict', 'changed', false, 'state', state_row.payload
      ));
    end if;
    return jsonb_strip_nulls(jsonb_build_object(
      'kind', 'replay',
      'changed', false,
      'state', replay_row.payload->'state',
      'compaction', replay_row.payload->'compaction'
    ));
  end if;

  if current_revision is distinct from expected_revision then
    return jsonb_strip_nulls(jsonb_build_object(
      'kind', 'conflict', 'changed', false,
      'state', state_row.payload
    ));
  end if;
  if current_revision >= 9007199254740991 then
    return jsonb_build_object('kind', 'invalid', 'changed', false);
  end if;

  observed_at := clock_timestamp();
  next_revision := current_revision + 1;
  incoming_compaction := case when p_command ? 'compaction' then p_command->'compaction' else null end;
  incoming_compaction_id := nullif(btrim(incoming_compaction->>'id'), '');
  next_head_compaction_id := coalesce(incoming_compaction_id, state_row.head_compaction_id);
  next_head_compaction_sequence := case
    when incoming_compaction_id is not null then next_revision
    else state_row.head_compaction_sequence
  end;
  next_usage_anchor := case
    when p_command ? 'usageAnchor' then p_command->'usageAnchor'
    else state_row.payload->'usageAnchor'
  end;
  next_state := jsonb_strip_nulls(jsonb_build_object(
    'version', 2,
    'sessionId', command_session_id,
    'projectId', command_project_id,
    'revision', next_revision,
    'headCompactionId', next_head_compaction_id,
    'headCompactionSequence', next_head_compaction_sequence,
    'usageAnchor', next_usage_anchor,
    'updatedAt', floor(extract(epoch from observed_at) * 1000)::bigint
  ));
  ledger_id := 'agent_context_' || left(public.botanic_canonical_json_hash(jsonb_build_object(
    'sessionId', command_session_id,
    'idempotencyKey', command_idempotency_key
  )), 32);
  ledger_payload := jsonb_strip_nulls(jsonb_build_object(
    'id', ledger_id,
    'ownerId', coalesce(state_row.owner_id, session_row.owner_id),
    'projectId', command_project_id,
    'sessionId', command_session_id,
    'sequence', next_revision,
    'state', next_state,
    'usageAnchor', case when p_command ? 'usageAnchor' then p_command->'usageAnchor' else null end,
    'compaction', incoming_compaction,
    'createdAt', floor(extract(epoch from observed_at) * 1000)::bigint
  ));

  insert into public.agent_context_compactions (
    session_id, sequence, id, owner_id, project_id, idempotency_key,
    request_hash, compaction_id, created_at, payload
  ) values (
    command_session_id, next_revision, ledger_id, coalesce(state_row.owner_id, session_row.owner_id),
    command_project_id, command_idempotency_key, computed_hash, incoming_compaction_id, observed_at, ledger_payload
  );

  insert into public.agent_context_states (
    session_id, owner_id, project_id, revision, head_compaction_id,
    head_compaction_sequence, updated_at, payload
  ) values (
    command_session_id, coalesce(state_row.owner_id, session_row.owner_id), command_project_id,
    next_revision, next_head_compaction_id, next_head_compaction_sequence, observed_at, next_state
  )
  on conflict (session_id) do update set
    revision = excluded.revision,
    head_compaction_id = excluded.head_compaction_id,
    head_compaction_sequence = excluded.head_compaction_sequence,
    updated_at = excluded.updated_at,
    payload = excluded.payload;

  return jsonb_strip_nulls(jsonb_build_object(
    'kind', 'updated',
    'changed', true,
    'state', next_state,
    'compaction', incoming_compaction
  ));
end;
$$;

revoke all on function public.botanic_compare_and_set_agent_context_state(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.botanic_compare_and_set_agent_context_state(uuid, jsonb)
  to service_role;
-- CAS 内部重算与 Node canonicalHash 同源的 binding；这些 helper 在旧迁移中
-- 已从 PUBLIC 撤权，security invoker 调用链需向 service_role 显式授权。
grant execute on function public.botanic_js_number_text(jsonb) to service_role;
grant execute on function public.botanic_canonical_json_text(jsonb) to service_role;
grant execute on function public.botanic_sha256_base64url(text) to service_role;
grant execute on function public.botanic_canonical_json_hash(jsonb) to service_role;
grant select, insert, update on table public.agent_context_states to service_role;
grant select, insert on table public.agent_context_compactions to service_role;

commit;
