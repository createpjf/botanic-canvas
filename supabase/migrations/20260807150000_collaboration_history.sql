-- 协作历史是项目级只读时间线；成员已读和清空状态按用户隔离。
create table if not exists public.collaboration_activities (
  project_id text not null references public.projects(id) on delete cascade,
  id text not null,
  actor_id uuid not null references public.profiles(id) on delete cascade,
  occurred_at timestamptz not null default now(),
  payload jsonb not null,
  primary key (project_id, id)
);

create index if not exists collaboration_activities_project_occurred_idx
on public.collaboration_activities (project_id, occurred_at desc, id desc);

create table if not exists public.collaboration_activity_receipts (
  user_id uuid not null references public.profiles(id) on delete cascade,
  project_id text not null references public.projects(id) on delete cascade,
  read_at timestamptz not null default to_timestamp(0),
  cleared_at timestamptz not null default to_timestamp(0),
  updated_at timestamptz not null default now(),
  primary key (user_id, project_id)
);

alter table public.collaboration_activities enable row level security;
alter table public.collaboration_activity_receipts enable row level security;

drop policy if exists "members can read collaboration activities" on public.collaboration_activities;
create policy "members can read collaboration activities"
on public.collaboration_activities for select to authenticated
using (public.botanic_has_project_role(project_id, array['owner', 'editor', 'viewer']::public.botanic_project_role[]));

drop policy if exists "members can read own collaboration receipt" on public.collaboration_activity_receipts;
create policy "members can read own collaboration receipt"
on public.collaboration_activity_receipts for select to authenticated
using (
  user_id = auth.uid()
  and public.botanic_has_project_role(project_id, array['owner', 'editor', 'viewer']::public.botanic_project_role[])
);

drop policy if exists "members can write own collaboration receipt" on public.collaboration_activity_receipts;
create policy "members can write own collaboration receipt"
on public.collaboration_activity_receipts for all to authenticated
using (
  user_id = auth.uid()
  and public.botanic_has_project_role(project_id, array['owner', 'editor', 'viewer']::public.botanic_project_role[])
)
with check (
  user_id = auth.uid()
  and public.botanic_has_project_role(project_id, array['owner', 'editor', 'viewer']::public.botanic_project_role[])
);

-- 协作事件仅由受信服务端根据已成功写入的项目/图谱变更生成。
revoke all on public.collaboration_activities from public, anon, authenticated;
grant select on public.collaboration_activities to authenticated;
grant all on public.collaboration_activities, public.collaboration_activity_receipts to service_role;

-- 多设备同时已读/清空时只允许时间向前，避免旧请求后到覆盖新回执。
create or replace function public.botanic_put_collaboration_activity_receipt(
  p_user_id uuid,
  p_project_id text,
  p_action text,
  p_timestamp timestamptz
)
returns table(read_at timestamptz, cleared_at timestamptz, updated_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_action not in ('read', 'clear') then
    raise exception 'invalid collaboration receipt action';
  end if;

  insert into public.collaboration_activity_receipts (user_id, project_id, read_at, cleared_at, updated_at)
  values (
    p_user_id,
    p_project_id,
    p_timestamp,
    case when p_action = 'clear' then p_timestamp else to_timestamp(0) end,
    p_timestamp
  )
  on conflict (user_id, project_id) do update set
    read_at = greatest(public.collaboration_activity_receipts.read_at, excluded.read_at),
    cleared_at = greatest(public.collaboration_activity_receipts.cleared_at, excluded.cleared_at),
    updated_at = greatest(public.collaboration_activity_receipts.updated_at, excluded.updated_at);

  return query
  select r.read_at, r.cleared_at, r.updated_at
  from public.collaboration_activity_receipts r
  where r.user_id = p_user_id and r.project_id = p_project_id;
end;
$$;

revoke all on function public.botanic_put_collaboration_activity_receipt(uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.botanic_put_collaboration_activity_receipt(uuid, text, text, timestamptz) to service_role;
