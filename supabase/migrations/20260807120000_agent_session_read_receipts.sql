-- Agent 阅读位置按成员隔离；共享 Session 不再承载某一成员的阅读进度。
create table if not exists public.agent_session_read_receipts (
  user_id uuid not null references public.profiles(id) on delete cascade,
  project_id text not null references public.projects(id) on delete cascade,
  session_id text not null references public.agent_sessions(id) on delete cascade,
  message_id text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, project_id, session_id)
);

create index if not exists agent_session_read_receipts_project_user_updated_idx
on public.agent_session_read_receipts (project_id, user_id, updated_at desc);

insert into public.agent_session_read_receipts (user_id, project_id, session_id, message_id, updated_at)
select owner_id, project_id, id, payload->>'readingAnchorMessageId',
  case when payload->>'readingAnchorUpdatedAt' ~ '^[0-9]+$'
    then to_timestamp((payload->>'readingAnchorUpdatedAt')::double precision / 1000.0)
    else updated_at end
from public.agent_sessions
where nullif(payload->>'readingAnchorMessageId', '') is not null
on conflict (user_id, project_id, session_id) do nothing;

alter table public.agent_session_read_receipts enable row level security;

drop policy if exists "members can read own agent receipts" on public.agent_session_read_receipts;
create policy "members can read own agent receipts"
on public.agent_session_read_receipts for select to authenticated
using (
  user_id = auth.uid()
  and public.botanic_has_project_role(project_id, array['owner', 'editor', 'viewer']::public.botanic_project_role[])
);

drop policy if exists "members can write own agent receipts" on public.agent_session_read_receipts;
create policy "members can write own agent receipts"
on public.agent_session_read_receipts for all to authenticated
using (
  user_id = auth.uid()
  and public.botanic_has_project_role(project_id, array['owner', 'editor', 'viewer']::public.botanic_project_role[])
)
with check (
  user_id = auth.uid()
  and public.botanic_has_project_role(project_id, array['owner', 'editor', 'viewer']::public.botanic_project_role[])
);

-- 原子 LWW：较旧设备的阅读位置不得覆盖成员在另一设备上的新位置。
create or replace function public.botanic_put_agent_session_read_receipt(
  p_user_id uuid,
  p_project_id text,
  p_session_id text,
  p_message_id text,
  p_updated_at timestamptz
)
returns table (session_id text, message_id text, updated_at timestamptz)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  insert into public.agent_session_read_receipts (
    user_id, project_id, session_id, message_id, updated_at
  ) values (
    p_user_id, p_project_id, p_session_id, p_message_id, p_updated_at
  )
  on conflict (user_id, project_id, session_id) do update set
    message_id = excluded.message_id,
    updated_at = excluded.updated_at
  where agent_session_read_receipts.updated_at < excluded.updated_at;

  return query
  select receipt.session_id, receipt.message_id, receipt.updated_at
  from public.agent_session_read_receipts receipt
  where receipt.user_id = p_user_id
    and receipt.project_id = p_project_id
    and receipt.session_id = p_session_id;
end;
$$;

revoke all on function public.botanic_put_agent_session_read_receipt(uuid, text, text, text, timestamptz)
from public, anon, authenticated;
grant execute on function public.botanic_put_agent_session_read_receipt(uuid, text, text, text, timestamptz)
to service_role;
