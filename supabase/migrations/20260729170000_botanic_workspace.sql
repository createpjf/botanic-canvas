-- Botanic · Supabase 生产数据模型
-- 仅在 Supabase SQL Editor / supabase db push 中执行；不要把 service_role/secret key 放进客户端。

create extension if not exists pgcrypto;

create type public.botanic_workspace_role as enum ('owner', 'member');
create type public.botanic_project_role as enum ('owner', 'editor', 'viewer');
create type public.botanic_generation_status as enum ('queued', 'running', 'succeeded', 'failed', 'cancelled');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text not null,
  workspace_role public.botanic_workspace_role not null default 'member',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.projects (
  id text primary key,
  name text not null,
  document jsonb not null,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.project_members (
  project_id text not null references public.projects(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role public.botanic_project_role not null,
  added_at timestamptz not null default now(),
  primary key (project_id, user_id)
);

create table public.global_asset_libraries (
  id text primary key,
  library jsonb not null,
  updated_at timestamptz not null default now()
);

create table public.generation_jobs (
  id text primary key,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  project_id text not null references public.projects(id) on delete cascade,
  status public.botanic_generation_status not null,
  updated_at timestamptz not null default now(),
  payload jsonb not null
);

create table public.media_objects (
  id text primary key,
  project_id text not null,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  storage_key text not null unique,
  content_type text not null,
  byte_size bigint not null check (byte_size > 0),
  created_at timestamptz not null default now()
);

create table public.audit_events (
  id text primary key,
  actor_id uuid not null references public.profiles(id) on delete cascade,
  action text not null,
  project_id text,
  target_id text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index project_members_user_idx on public.project_members (user_id, project_id);
create index projects_updated_at_idx on public.projects (updated_at desc);
create index jobs_status_updated_at_idx on public.generation_jobs (status, updated_at);
create index media_project_idx on public.media_objects (project_id);
create index audit_project_created_idx on public.audit_events (project_id, created_at desc);

create or replace function public.botanic_set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_updated_at before update on public.profiles
for each row execute function public.botanic_set_updated_at();

create trigger projects_updated_at before update on public.projects
for each row execute function public.botanic_set_updated_at();

create or replace function public.botanic_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'display_name', split_part(coalesce(new.email, ''), '@', 1), 'Botanic Member')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.botanic_handle_new_user();

-- RLS helper：仅由 policy 调用，权限判断不依赖可被用户修改的 metadata。
create or replace function public.botanic_has_project_role(p_project_id text, p_roles public.botanic_project_role[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.project_members
    where project_id = p_project_id
      and user_id = auth.uid()
      and role = any(p_roles)
  );
$$;

revoke all on function public.botanic_has_project_role(text, public.botanic_project_role[]) from public;
grant execute on function public.botanic_has_project_role(text, public.botanic_project_role[]) to authenticated;

alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.project_members enable row level security;
alter table public.global_asset_libraries enable row level security;
alter table public.generation_jobs enable row level security;
alter table public.media_objects enable row level security;
alter table public.audit_events enable row level security;

create policy "profiles readable by self" on public.profiles for select to authenticated using ((select auth.uid()) = id);
create policy "profiles editable by self" on public.profiles for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

create policy "project members can read projects" on public.projects for select to authenticated using (
  public.botanic_has_project_role(id, array['owner', 'editor', 'viewer']::public.botanic_project_role[])
);
create policy "editors can update projects" on public.projects for update to authenticated using (
  public.botanic_has_project_role(id, array['owner', 'editor']::public.botanic_project_role[])
) with check (
  public.botanic_has_project_role(id, array['owner', 'editor']::public.botanic_project_role[])
);

create policy "project members can read members" on public.project_members for select to authenticated using (
  public.botanic_has_project_role(project_id, array['owner', 'editor', 'viewer']::public.botanic_project_role[])
);

create policy "workspace members can read brand library" on public.global_asset_libraries for select to authenticated using (
  exists (select 1 from public.project_members where user_id = auth.uid())
);
create policy "editors can update brand library" on public.global_asset_libraries for all to authenticated using (
  exists (select 1 from public.project_members where user_id = auth.uid() and role in ('owner', 'editor'))
) with check (
  exists (select 1 from public.project_members where user_id = auth.uid() and role in ('owner', 'editor'))
);

create policy "owner can read generation jobs" on public.generation_jobs for select to authenticated using ((select auth.uid()) = owner_id);
create policy "members can read project audit" on public.audit_events for select to authenticated using (
  public.botanic_has_project_role(project_id, array['owner', 'editor', 'viewer']::public.botanic_project_role[])
);
create policy "members can read media metadata" on public.media_objects for select to authenticated using (
  public.botanic_has_project_role(project_id, array['owner', 'editor', 'viewer']::public.botanic_project_role[])
);

insert into storage.buckets (id, name, public)
values ('botanic-media', 'botanic-media', false)
on conflict (id) do update set public = false;

create policy "project members can read Botanic media" on storage.objects for select to authenticated using (
  bucket_id = 'botanic-media'
  and exists (
    select 1 from public.media_objects media
    where media.storage_key = name
      and public.botanic_has_project_role(media.project_id, array['owner', 'editor', 'viewer']::public.botanic_project_role[])
  )
);

-- 原子版本写入由服务端 service role 调用；客户端没有执行权限。
create or replace function public.botanic_write_project_document(
  p_actor uuid,
  p_document jsonb,
  p_expected_revision integer default null
)
returns table (document jsonb, revision integer, created boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project_id text := p_document ->> 'id';
  v_name text := p_document ->> 'name';
  v_revision integer;
  v_role public.botanic_project_role;
begin
  if p_actor is null or v_project_id is null or v_name is null then
    raise exception '项目文档格式无效' using errcode = '22023';
  end if;

  select revision into v_revision from public.projects where id = v_project_id for update;
  if found then
    select role into v_role from public.project_members where project_id = v_project_id and user_id = p_actor;
    if v_role is null or v_role not in ('owner', 'editor') then raise exception '你没有编辑该项目的权限' using errcode = '42501'; end if;
    if p_expected_revision is not null and p_expected_revision <> v_revision then
      raise exception '项目已被其他成员更新，请刷新后再保存' using errcode = '40001';
    end if;
    v_revision := v_revision + 1;
    update public.projects set name = v_name, document = p_document, revision = v_revision where id = v_project_id;
    insert into public.audit_events (id, actor_id, action, project_id, detail)
    values ('audit_' || gen_random_uuid(), p_actor, 'project.updated', v_project_id, jsonb_build_object('revision', v_revision));
    return query select p_document, v_revision, false;
  else
    insert into public.projects (id, name, document) values (v_project_id, v_name, p_document);
    insert into public.project_members (project_id, user_id, role) values (v_project_id, p_actor, 'owner');
    insert into public.audit_events (id, actor_id, action, project_id) values ('audit_' || gen_random_uuid(), p_actor, 'project.created', v_project_id);
    return query select p_document, 1, true;
  end if;
end;
$$;

revoke all on function public.botanic_write_project_document(uuid, jsonb, integer) from public, anon, authenticated;
grant execute on function public.botanic_write_project_document(uuid, jsonb, integer) to service_role;
