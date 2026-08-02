create table if not exists public.agent_runs (
  id text primary key,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  project_id text not null references public.projects(id) on delete cascade,
  status text not null check (status in ('queued', 'running', 'completed', 'partial', 'failed', 'cancelled')),
  updated_at timestamptz not null default now(),
  payload jsonb not null
);

create index if not exists agent_runs_project_updated_idx
on public.agent_runs (project_id, updated_at desc);

alter table public.agent_runs enable row level security;

drop policy if exists "owner can read agent runs" on public.agent_runs;
create policy "owner can read agent runs"
on public.agent_runs for select to authenticated
using ((select auth.uid()) = owner_id);
