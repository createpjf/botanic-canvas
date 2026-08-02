create table if not exists public.agent_skills (
  id text primary key,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  project_id text not null references public.projects(id) on delete cascade,
  status text not null check (status in ('active', 'archived')),
  updated_at timestamptz not null default now(),
  payload jsonb not null
);

create index if not exists agent_skills_project_updated_idx
on public.agent_skills (project_id, updated_at desc);

alter table public.agent_skills enable row level security;

drop policy if exists "project members can read agent skills" on public.agent_skills;
create policy "project members can read agent skills"
on public.agent_skills for select to authenticated
using (exists (
  select 1 from public.project_members member
  where member.project_id = agent_skills.project_id
    and member.user_id = (select auth.uid())
));
