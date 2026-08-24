-- Agent Turn Runtime V2：一次用户意图回合的生命周期与可恢复事件。
-- 原始 reasoning 不写入这两张表；Turn 的 result 由服务端先剥离 reasoning 后再保存。
create table if not exists public.agent_turns (
  id text primary key,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  project_id text not null references public.projects(id) on delete cascade,
  session_id text,
  idempotency_key text not null,
  status text not null check (status in ('running', 'completed', 'failed', 'cancelled')),
  updated_at timestamptz not null default now(),
  payload jsonb not null,
  unique (owner_id, project_id, idempotency_key)
);

create index if not exists agent_turns_project_updated_idx
on public.agent_turns (project_id, updated_at desc);

create table if not exists public.agent_turn_events (
  id text primary key,
  turn_id text not null references public.agent_turns(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  project_id text not null references public.projects(id) on delete cascade,
  sequence integer not null,
  type text not null,
  created_at timestamptz not null default now(),
  payload jsonb,
  unique (turn_id, sequence)
);

create index if not exists agent_turn_events_turn_sequence_idx
on public.agent_turn_events (turn_id, sequence asc);

alter table public.agent_turns enable row level security;
alter table public.agent_turn_events enable row level security;

drop policy if exists "project members can read agent turns" on public.agent_turns;
create policy "project members can read agent turns"
on public.agent_turns for select to authenticated
using (public.botanic_has_project_role(project_id, array['owner', 'editor', 'viewer']::public.botanic_project_role[]));

drop policy if exists "project members can read agent turn events" on public.agent_turn_events;
create policy "project members can read agent turn events"
on public.agent_turn_events for select to authenticated
using (public.botanic_has_project_role(project_id, array['owner', 'editor', 'viewer']::public.botanic_project_role[]));

drop policy if exists "project editors can write agent turns" on public.agent_turns;
create policy "project editors can write agent turns"
on public.agent_turns for all to authenticated
using (public.botanic_has_project_role(project_id, array['owner', 'editor']::public.botanic_project_role[]))
with check (public.botanic_has_project_role(project_id, array['owner', 'editor']::public.botanic_project_role[]));

drop policy if exists "project editors can write agent turn events" on public.agent_turn_events;
create policy "project editors can write agent turn events"
on public.agent_turn_events for all to authenticated
using (public.botanic_has_project_role(project_id, array['owner', 'editor']::public.botanic_project_role[]))
with check (public.botanic_has_project_role(project_id, array['owner', 'editor']::public.botanic_project_role[]));
