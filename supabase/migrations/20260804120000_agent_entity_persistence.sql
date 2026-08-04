-- Agent Session、Message 与 Memory 从 CanvasDocument 拆为项目级独立实体。
-- 迁移期间保留旧字段并双写；新实体优先读取，旧字段只作为兼容回退。

alter table public.agent_runs drop constraint if exists agent_runs_status_check;
alter table public.agent_runs add constraint agent_runs_status_check
check (status in ('awaiting_confirmation', 'queued', 'executing', 'running', 'completed', 'partial', 'failed', 'cancelled'));

drop policy if exists "owner can read agent runs" on public.agent_runs;
drop policy if exists "project members can read agent runs" on public.agent_runs;
create policy "project members can read agent runs"
on public.agent_runs for select to authenticated
using (public.botanic_has_project_role(project_id, array['owner', 'editor', 'viewer']::public.botanic_project_role[]));

create table if not exists public.agent_sessions (
  id text primary key,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  project_id text not null references public.projects(id) on delete cascade,
  updated_at timestamptz not null default now(),
  payload jsonb not null
);

create table if not exists public.agent_messages (
  id text primary key,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  project_id text not null references public.projects(id) on delete cascade,
  session_id text not null references public.agent_sessions(id) on delete cascade,
  updated_at timestamptz not null default now(),
  payload jsonb not null
);

create table if not exists public.agent_memory_items (
  id text primary key,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  project_id text not null references public.projects(id) on delete cascade,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  payload jsonb not null
);

create index if not exists agent_sessions_project_updated_idx
on public.agent_sessions (project_id, updated_at desc);
create index if not exists agent_messages_session_updated_idx
on public.agent_messages (session_id, updated_at asc);
create index if not exists agent_memory_project_updated_idx
on public.agent_memory_items (project_id, updated_at desc);

alter table public.agent_sessions enable row level security;
alter table public.agent_messages enable row level security;
alter table public.agent_memory_items enable row level security;

drop policy if exists "project members can read agent sessions" on public.agent_sessions;
create policy "project members can read agent sessions"
on public.agent_sessions for select to authenticated
using (public.botanic_has_project_role(project_id, array['owner', 'editor', 'viewer']::public.botanic_project_role[]));

drop policy if exists "project editors can write agent sessions" on public.agent_sessions;
create policy "project editors can write agent sessions"
on public.agent_sessions for all to authenticated
using (public.botanic_has_project_role(project_id, array['owner', 'editor']::public.botanic_project_role[]))
with check (public.botanic_has_project_role(project_id, array['owner', 'editor']::public.botanic_project_role[]));

drop policy if exists "project members can read agent messages" on public.agent_messages;
create policy "project members can read agent messages"
on public.agent_messages for select to authenticated
using (public.botanic_has_project_role(project_id, array['owner', 'editor', 'viewer']::public.botanic_project_role[]));

drop policy if exists "project editors can write agent messages" on public.agent_messages;
create policy "project editors can write agent messages"
on public.agent_messages for all to authenticated
using (public.botanic_has_project_role(project_id, array['owner', 'editor']::public.botanic_project_role[]))
with check (public.botanic_has_project_role(project_id, array['owner', 'editor']::public.botanic_project_role[]));

drop policy if exists "project members can read agent memory" on public.agent_memory_items;
create policy "project members can read agent memory"
on public.agent_memory_items for select to authenticated
using (public.botanic_has_project_role(project_id, array['owner', 'editor', 'viewer']::public.botanic_project_role[]));

drop policy if exists "project editors can write agent memory" on public.agent_memory_items;
create policy "project editors can write agent memory"
on public.agent_memory_items for all to authenticated
using (public.botanic_has_project_role(project_id, array['owner', 'editor']::public.botanic_project_role[]))
with check (public.botanic_has_project_role(project_id, array['owner', 'editor']::public.botanic_project_role[]));

insert into public.agent_sessions (id, owner_id, project_id, updated_at, payload)
select session->>'id', member.user_id, project.id,
  case when session->>'updatedAt' ~ '^[0-9]+$'
    then to_timestamp((session->>'updatedAt')::double precision / 1000.0)
    else project.updated_at end,
  session - 'messages'
from public.projects project
join lateral (
  select user_id from public.project_members
  where project_id = project.id
  order by (role = 'owner') desc, added_at asc limit 1
) member on true
cross join lateral jsonb_array_elements(coalesce(project.document->'agentSessions', '[]'::jsonb)) session
where nullif(session->>'id', '') is not null
on conflict (id) do nothing;

insert into public.agent_messages (id, owner_id, project_id, session_id, updated_at, payload)
select message->>'id', member.user_id, project.id, session->>'id',
  case when session->>'updatedAt' ~ '^[0-9]+$'
    then to_timestamp((session->>'updatedAt')::double precision / 1000.0)
    else project.updated_at end,
  message
from public.projects project
join lateral (
  select user_id from public.project_members
  where project_id = project.id
  order by (role = 'owner') desc, added_at asc limit 1
) member on true
cross join lateral jsonb_array_elements(coalesce(project.document->'agentSessions', '[]'::jsonb)) session
cross join lateral jsonb_array_elements(coalesce(session->'messages', '[]'::jsonb)) message
where nullif(session->>'id', '') is not null and nullif(message->>'id', '') is not null
on conflict (id) do nothing;

insert into public.agent_memory_items (id, owner_id, project_id, updated_at, payload)
select memory->>'id', member.user_id, project.id,
  case when memory->>'updatedAt' ~ '^[0-9]+$'
    then to_timestamp((memory->>'updatedAt')::double precision / 1000.0)
    else project.updated_at end,
  memory
from public.projects project
join lateral (
  select user_id from public.project_members
  where project_id = project.id
  order by (role = 'owner') desc, added_at asc limit 1
) member on true
cross join lateral jsonb_array_elements(coalesce(project.document->'agentMemory', '[]'::jsonb)) memory
where nullif(memory->>'id', '') is not null
on conflict (id) do nothing;

insert into public.agent_runs (id, owner_id, project_id, status, updated_at, payload)
select run->>'id', member.user_id, project.id,
  case when run->>'status' in ('awaiting_confirmation', 'queued', 'executing', 'running', 'completed', 'partial', 'failed', 'cancelled')
    then run->>'status' else 'awaiting_confirmation' end,
  case when run->>'updatedAt' ~ '^[0-9]+$'
    then to_timestamp((run->>'updatedAt')::double precision / 1000.0)
    else project.updated_at end,
  run || jsonb_build_object('ownerId', member.user_id, 'projectId', project.id)
from public.projects project
join lateral (
  select user_id from public.project_members
  where project_id = project.id
  order by (role = 'owner') desc, added_at asc limit 1
) member on true
cross join lateral jsonb_array_elements(coalesce(project.document->'agentRuns', '[]'::jsonb)) run
where nullif(run->>'id', '') is not null
on conflict (id) do nothing;
