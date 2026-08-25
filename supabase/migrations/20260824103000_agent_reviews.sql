-- 持久化质量评审：模型评审是派生结论，人工决策是可变的治理状态。
create table if not exists public.agent_reviews (
  id text primary key,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  project_id text not null references public.projects(id) on delete cascade,
  run_id text not null references public.agent_runs(id) on delete cascade,
  locale text not null,
  status text not null check (status in ('pending', 'accepted', 'rejected', 'retry_requested')),
  updated_at timestamptz not null default now(),
  payload jsonb not null,
  unique (project_id, run_id, locale)
);

create index if not exists agent_reviews_run_updated_idx
on public.agent_reviews (project_id, run_id, updated_at desc);

alter table public.agent_reviews enable row level security;

drop policy if exists "project members can read agent reviews" on public.agent_reviews;
create policy "project members can read agent reviews"
on public.agent_reviews for select to authenticated
using (public.botanic_has_project_role(project_id, array['owner', 'editor', 'viewer']::public.botanic_project_role[]));

drop policy if exists "project editors can write agent reviews" on public.agent_reviews;
create policy "project editors can write agent reviews"
on public.agent_reviews for all to authenticated
using (public.botanic_has_project_role(project_id, array['owner', 'editor']::public.botanic_project_role[]))
with check (public.botanic_has_project_role(project_id, array['owner', 'editor']::public.botanic_project_role[]));
