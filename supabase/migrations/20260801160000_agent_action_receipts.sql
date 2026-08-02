create table if not exists public.agent_action_receipts (
  id text primary key,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  project_id text not null references public.projects(id) on delete cascade,
  created_at timestamptz not null default now(),
  payload jsonb not null
);

create index if not exists agent_action_receipts_project_created_idx
on public.agent_action_receipts (project_id, created_at desc);

alter table public.agent_action_receipts enable row level security;

drop policy if exists "owner can read agent action receipts" on public.agent_action_receipts;
create policy "owner can read agent action receipts"
on public.agent_action_receipts for select to authenticated
using ((select auth.uid()) = owner_id);
