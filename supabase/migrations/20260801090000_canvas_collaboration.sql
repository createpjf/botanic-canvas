-- 将画布图谱与项目元数据拆分，并持久化 Yjs 增量日志。
-- 任务、媒体和项目元数据仍保留原有权威边界。

create table if not exists public.canvas_graphs (
  project_id text primary key references public.projects(id) on delete cascade,
  graph jsonb not null default '{"nodes":[],"edges":[]}'::jsonb,
  revision integer not null default 1 check (revision > 0),
  yjs_snapshot text,
  updated_at timestamptz not null default now()
);

create table if not exists public.canvas_graph_updates (
  id bigint generated always as identity primary key,
  project_id text not null references public.canvas_graphs(project_id) on delete cascade,
  update_base64 text not null,
  created_at timestamptz not null default now()
);

create index if not exists canvas_graph_updates_project_idx
  on public.canvas_graph_updates (project_id, id);

insert into public.canvas_graphs (project_id, graph, revision, updated_at)
select id,
  jsonb_build_object(
    'nodes', coalesce(document -> 'nodes', '[]'::jsonb),
    'edges', coalesce(document -> 'edges', '[]'::jsonb)
  ),
  1,
  updated_at
from public.projects
on conflict (project_id) do nothing;

alter table public.canvas_graphs enable row level security;
alter table public.canvas_graph_updates enable row level security;

create policy "project members can read canvas graphs"
on public.canvas_graphs for select to authenticated using (
  public.botanic_has_project_role(project_id, array['owner', 'editor', 'viewer']::public.botanic_project_role[])
);

create policy "project members can read canvas updates"
on public.canvas_graph_updates for select to authenticated using (
  public.botanic_has_project_role(project_id, array['owner', 'editor', 'viewer']::public.botanic_project_role[])
);

drop function if exists public.botanic_write_project_document(uuid, jsonb, integer);

create or replace function public.botanic_write_project_document(
  p_actor uuid,
  p_document jsonb,
  p_expected_revision integer default null,
  p_expected_graph_revision integer default null
)
returns table (document jsonb, revision integer, graph_revision integer, created boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project_id text := p_document ->> 'id';
  v_name text := p_document ->> 'name';
  v_revision integer;
  v_graph_revision integer;
  v_current_graph jsonb;
  v_next_graph jsonb := jsonb_build_object(
    'nodes', coalesce(p_document -> 'nodes', '[]'::jsonb),
    'edges', coalesce(p_document -> 'edges', '[]'::jsonb)
  );
  v_role public.botanic_project_role;
begin
  if p_actor is null or v_project_id is null or v_name is null then
    raise exception '项目文档格式无效' using errcode = '22023';
  end if;

  select project.revision into v_revision
  from public.projects as project
  where project.id = v_project_id
  for update;

  if found then
    select member.role into v_role
    from public.project_members as member
    where member.project_id = v_project_id and member.user_id = p_actor;
    if v_role is null or v_role not in ('owner', 'editor') then
      raise exception '你没有编辑该项目的权限' using errcode = '42501';
    end if;
    if p_expected_revision is not null and p_expected_revision <> v_revision then
      raise exception '项目已被其他成员更新，请刷新后再保存' using errcode = '40001';
    end if;

    insert into public.canvas_graphs (project_id, graph, revision)
    values (v_project_id, v_next_graph, 1)
    on conflict (project_id) do nothing;
    select graph, canvas.revision into v_current_graph, v_graph_revision
    from public.canvas_graphs as canvas
    where canvas.project_id = v_project_id
    for update;

    if v_current_graph is distinct from v_next_graph then
      if p_expected_graph_revision is not null and p_expected_graph_revision <> v_graph_revision then
        raise exception '画布已被其他成员更新，请刷新后再保存' using errcode = 'BG001';
      end if;
      v_graph_revision := v_graph_revision + 1;
      update public.canvas_graphs
      set graph = v_next_graph, revision = v_graph_revision, updated_at = now()
      where project_id = v_project_id;
    end if;

    v_revision := v_revision + 1;
    update public.projects
    set name = v_name, document = p_document, revision = v_revision
    where id = v_project_id;
    insert into public.audit_events (id, actor_id, action, project_id, detail)
    values ('audit_' || gen_random_uuid(), p_actor, 'project.updated', v_project_id, jsonb_build_object('revision', v_revision));
    return query select
      p_document || jsonb_build_object('nodes', v_next_graph -> 'nodes', 'edges', v_next_graph -> 'edges'),
      v_revision,
      v_graph_revision,
      false;
  else
    insert into public.projects (id, name, document) values (v_project_id, v_name, p_document);
    insert into public.project_members (project_id, user_id, role) values (v_project_id, p_actor, 'owner');
    insert into public.canvas_graphs (project_id, graph, revision) values (v_project_id, v_next_graph, 1);
    insert into public.audit_events (id, actor_id, action, project_id) values ('audit_' || gen_random_uuid(), p_actor, 'project.created', v_project_id);
    return query select p_document, 1, 1, true;
  end if;
end;
$$;

revoke all on function public.botanic_write_project_document(uuid, jsonb, integer, integer) from public, anon, authenticated;
grant execute on function public.botanic_write_project_document(uuid, jsonb, integer, integer) to service_role;

create or replace function public.botanic_append_canvas_graph_update(
  p_actor uuid,
  p_project_id text,
  p_update_base64 text,
  p_graph jsonb
)
returns table (graph_revision integer, update_count integer, updated_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.botanic_project_role;
  v_revision integer;
  v_count integer;
  v_updated_at timestamptz := now();
begin
  select role into v_role from public.project_members
  where project_id = p_project_id and user_id = p_actor;
  if v_role is null or v_role not in ('owner', 'editor') then
    raise exception '你没有编辑该项目的权限' using errcode = '42501';
  end if;

  insert into public.canvas_graphs (project_id, graph, revision)
  select id, jsonb_build_object('nodes', coalesce(document -> 'nodes', '[]'::jsonb), 'edges', coalesce(document -> 'edges', '[]'::jsonb)), 1
  from public.projects where id = p_project_id
  on conflict (project_id) do nothing;

  update public.canvas_graphs
  set graph = p_graph, revision = revision + 1, updated_at = v_updated_at
  where project_id = p_project_id
  returning revision into v_revision;
  insert into public.canvas_graph_updates (project_id, update_base64)
  values (p_project_id, p_update_base64);
  select count(*)::integer into v_count from public.canvas_graph_updates where project_id = p_project_id;
  return query select v_revision, v_count, v_updated_at;
end;
$$;

revoke all on function public.botanic_append_canvas_graph_update(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.botanic_append_canvas_graph_update(uuid, text, text, jsonb) to service_role;

create or replace function public.botanic_compact_canvas_graph_updates(
  p_actor uuid,
  p_project_id text,
  p_snapshot text,
  p_graph jsonb
)
returns table (graph_revision integer, updated_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.botanic_project_role;
  v_revision integer;
  v_updated_at timestamptz := now();
begin
  select role into v_role from public.project_members
  where project_id = p_project_id and user_id = p_actor;
  if v_role is null or v_role not in ('owner', 'editor') then
    raise exception '你没有编辑该项目的权限' using errcode = '42501';
  end if;
  update public.canvas_graphs
  set graph = p_graph, yjs_snapshot = p_snapshot, updated_at = v_updated_at
  where project_id = p_project_id
  returning revision into v_revision;
  delete from public.canvas_graph_updates where project_id = p_project_id;
  return query select v_revision, v_updated_at;
end;
$$;

revoke all on function public.botanic_compact_canvas_graph_updates(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.botanic_compact_canvas_graph_updates(uuid, text, text, jsonb) to service_role;
