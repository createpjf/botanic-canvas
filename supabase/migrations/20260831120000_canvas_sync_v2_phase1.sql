-- Canvas Sync V2 Phase 1/2: durable mutation identity, graph CAS, epoch fencing and safe compaction.
-- Production application/backfill remains an explicit release operation.

alter table public.canvas_graphs add column if not exists sync_protocol_epoch integer not null default 1;
alter table public.canvas_graphs drop constraint if exists canvas_graphs_sync_protocol_epoch_check;
alter table public.canvas_graphs add constraint canvas_graphs_sync_protocol_epoch_check
  check (sync_protocol_epoch > 0);

alter table public.canvas_graph_updates alter column update_base64 drop not null;
alter table public.canvas_graph_updates add column if not exists mutation_id text;
alter table public.canvas_graph_updates add column if not exists graph_revision integer;
alter table public.canvas_graph_updates add column if not exists payload_sha256 text;
alter table public.canvas_graph_updates add column if not exists compacted_at timestamptz;

with hashed as (
  select id, project_id, public.botanic_sha256_base64url(update_base64) as payload_hash
  from public.canvas_graph_updates
  where mutation_id is null and update_base64 is not null
), ranked as (
  select id, payload_hash,
    row_number() over (partition by project_id, payload_hash order by id) as duplicate_ordinal
  from hashed
)
update public.canvas_graph_updates as updates
set mutation_id = case when ranked.duplicate_ordinal = 1
    then 'legacy:' || payload_hash else 'legacy-row:' || updates.id end,
  payload_sha256 = payload_hash
from ranked
where updates.id = ranked.id;

update public.canvas_graph_updates
set payload_sha256 = public.botanic_sha256_base64url(update_base64)
where payload_sha256 is null and update_base64 is not null;

update public.canvas_graph_updates set mutation_id = 'legacy-row:' || id where mutation_id is null;
update public.canvas_graph_updates set payload_sha256 = 'legacy-row:' || id where payload_sha256 is null;

alter table public.canvas_graph_updates alter column mutation_id set not null;
alter table public.canvas_graph_updates alter column payload_sha256 set not null;

create unique index if not exists canvas_graph_updates_mutation_idx
  on public.canvas_graph_updates (project_id, mutation_id);
create unique index if not exists canvas_graph_updates_revision_idx
  on public.canvas_graph_updates (project_id, graph_revision)
  where graph_revision is not null;

create or replace function public.botanic_load_canvas_collaboration(
  p_actor uuid,
  p_project_id text
)
returns table (
  graph jsonb,
  graph_revision integer,
  sync_protocol_epoch integer,
  snapshot text,
  updates text[],
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_graph jsonb;
  v_graph_revision integer;
  v_sync_protocol_epoch integer;
  v_snapshot text;
  v_updates text[];
  v_updated_at timestamptz;
begin
  if not exists (
    select 1 from public.project_members
    where project_id = p_project_id and user_id = p_actor
  ) then
    return;
  end if;

  select canvas.graph, canvas.revision, canvas.sync_protocol_epoch,
    canvas.yjs_snapshot, canvas.updated_at
  into v_graph, v_graph_revision, v_sync_protocol_epoch, v_snapshot, v_updated_at
  from public.canvas_graphs as canvas
  where canvas.project_id = p_project_id
  for share;
  if not found then return; end if;

  select coalesce(array_agg(entry.update_base64 order by entry.graph_revision asc nulls first, entry.id asc), array[]::text[])
  into v_updates
  from public.canvas_graph_updates as entry
  where entry.project_id = p_project_id and entry.update_base64 is not null;

  return query select v_graph, v_graph_revision, v_sync_protocol_epoch,
    v_snapshot, v_updates, v_updated_at;
end;
$$;

revoke all on function public.botanic_load_canvas_collaboration(uuid, text)
  from public, anon, authenticated;
grant execute on function public.botanic_load_canvas_collaboration(uuid, text)
  to service_role;

drop function if exists public.botanic_append_canvas_graph_update(uuid, text, text, jsonb);

create or replace function public.botanic_append_canvas_graph_update(
  p_actor uuid,
  p_project_id text,
  p_update_base64 text,
  p_graph jsonb,
  p_mutation_id text,
  p_payload_sha256 text,
  p_expected_graph_revision integer,
  p_sync_protocol_epoch integer
)
returns table (
  graph_revision integer,
  mutation_revision integer,
  update_count integer,
  updated_at timestamptz,
  duplicate boolean,
  committed_update text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.botanic_project_role;
  v_current_revision integer;
  v_sync_protocol_epoch integer;
  v_mutation_revision integer;
  v_existing_hash text;
  v_existing_update text;
  v_count integer;
  v_updated_at timestamptz := now();
begin
  select role into v_role
  from public.project_members
  where project_id = p_project_id and user_id = p_actor;
  if v_role is null or v_role not in ('owner', 'editor') then
    raise exception '你没有编辑该项目的权限' using errcode = '42501';
  end if;
  if p_mutation_id is null or p_mutation_id !~ '^[A-Za-z0-9._:-]{1,200}$'
    or p_payload_sha256 is null or p_payload_sha256 = '' then
    raise exception '画布协作提交身份无效' using errcode = '22000';
  end if;

  insert into public.canvas_graphs (project_id, graph, revision)
  select id,
    jsonb_build_object(
      'nodes', coalesce(document -> 'nodes', '[]'::jsonb),
      'edges', coalesce(document -> 'edges', '[]'::jsonb)
    ),
    1
  from public.projects where id = p_project_id
  on conflict (project_id) do nothing;

  select revision, sync_protocol_epoch into v_current_revision, v_sync_protocol_epoch
  from public.canvas_graphs
  where project_id = p_project_id
  for update;

  if v_sync_protocol_epoch >= 2 and p_sync_protocol_epoch is distinct from v_sync_protocol_epoch then
    raise exception '画布同步协议版本已前进，请重新握手'
      using errcode = '55000', detail = v_sync_protocol_epoch::text;
  end if;

  select updates.graph_revision, updates.payload_sha256, updates.update_base64
  into v_mutation_revision, v_existing_hash, v_existing_update
  from public.canvas_graph_updates as updates
  where updates.project_id = p_project_id and updates.mutation_id = p_mutation_id;

  if found then
    if v_existing_hash <> p_payload_sha256 then
      raise exception '画布协作提交身份已绑定到其他更新' using errcode = '22000';
    end if;
    select count(*)::integer into v_count
    from public.canvas_graph_updates
    where project_id = p_project_id and update_base64 is not null;
    return query select
      v_current_revision,
      coalesce(v_mutation_revision, v_current_revision),
      v_count,
      (select canvas.updated_at from public.canvas_graphs as canvas where canvas.project_id = p_project_id),
      true,
      v_existing_update;
    return;
  end if;

  if p_expected_graph_revision is not null and p_expected_graph_revision <> v_current_revision then
    raise exception '画布图谱版本冲突' using errcode = '40001';
  end if;

  update public.canvas_graphs
  set graph = p_graph, revision = revision + 1, updated_at = v_updated_at
  where project_id = p_project_id and revision = v_current_revision
  returning revision into v_current_revision;
  if not found then
    raise exception '画布图谱版本冲突' using errcode = '40001';
  end if;

  insert into public.canvas_graph_updates (
    project_id, update_base64, mutation_id, graph_revision, payload_sha256
  ) values (
    p_project_id, p_update_base64, p_mutation_id, v_current_revision, p_payload_sha256
  );
  select count(*)::integer into v_count
  from public.canvas_graph_updates
  where project_id = p_project_id and update_base64 is not null;

  return query select v_current_revision, v_current_revision, v_count, v_updated_at, false, p_update_base64;
end;
$$;

revoke all on function public.botanic_append_canvas_graph_update(uuid, text, text, jsonb, text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.botanic_append_canvas_graph_update(uuid, text, text, jsonb, text, text, integer, integer)
  to service_role;

-- 滚动发布兼容：旧 V2 API 没有 epoch；epoch 提升到 2 后会由同一事务拒绝。
create or replace function public.botanic_append_canvas_graph_update(
  p_actor uuid,
  p_project_id text,
  p_update_base64 text,
  p_graph jsonb,
  p_mutation_id text,
  p_payload_sha256 text,
  p_expected_graph_revision integer
)
returns table (
  graph_revision integer,
  mutation_revision integer,
  update_count integer,
  updated_at timestamptz,
  duplicate boolean,
  committed_update text
)
language sql
security definer
set search_path = public
as $$
  select *
  from public.botanic_append_canvas_graph_update(
    p_actor,
    p_project_id,
    p_update_base64,
    p_graph,
    p_mutation_id,
    p_payload_sha256,
    p_expected_graph_revision,
    null
  )
$$;

revoke all on function public.botanic_append_canvas_graph_update(uuid, text, text, jsonb, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.botanic_append_canvas_graph_update(uuid, text, text, jsonb, text, text, integer)
  to service_role;

-- 更旧的 V1 API 没有 mutation 参数，仍委托给同一幂等实现。
create or replace function public.botanic_append_canvas_graph_update(
  p_actor uuid,
  p_project_id text,
  p_update_base64 text,
  p_graph jsonb
)
returns table (graph_revision integer, update_count integer, updated_at timestamptz)
language sql
security definer
set search_path = public
as $$
  select committed.graph_revision, committed.update_count, committed.updated_at
  from public.botanic_append_canvas_graph_update(
    p_actor,
    p_project_id,
    p_update_base64,
    p_graph,
    'legacy:' || public.botanic_sha256_base64url(p_update_base64),
    public.botanic_sha256_base64url(p_update_base64),
    null
  ) as committed
$$;

revoke all on function public.botanic_append_canvas_graph_update(uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.botanic_append_canvas_graph_update(uuid, text, text, jsonb)
  to service_role;

drop function if exists public.botanic_compact_canvas_graph_updates(uuid, text, text, jsonb);

create or replace function public.botanic_compact_canvas_graph_updates(
  p_actor uuid,
  p_project_id text,
  p_snapshot text,
  p_graph jsonb,
  p_expected_graph_revision integer
)
returns table (graph_revision integer, updated_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.botanic_project_role;
  v_current_revision integer;
  v_updated_at timestamptz := now();
begin
  select role into v_role
  from public.project_members
  where project_id = p_project_id and user_id = p_actor;
  if v_role is null or v_role not in ('owner', 'editor') then
    raise exception '你没有编辑该项目的权限' using errcode = '42501';
  end if;

  select revision into v_current_revision
  from public.canvas_graphs
  where project_id = p_project_id
  for update;
  if p_expected_graph_revision is not null and p_expected_graph_revision <> v_current_revision then
    raise exception '画布图谱版本冲突' using errcode = '40001';
  end if;

  update public.canvas_graphs
  set graph = p_graph, yjs_snapshot = p_snapshot, updated_at = v_updated_at
  where project_id = p_project_id and revision = v_current_revision;
  if not found then
    raise exception '画布图谱版本冲突' using errcode = '40001';
  end if;

  update public.canvas_graph_updates
  set update_base64 = null, compacted_at = v_updated_at
  where project_id = p_project_id and update_base64 is not null
    and (graph_revision is null or graph_revision <= v_current_revision);

  return query select v_current_revision, v_updated_at;
end;
$$;

revoke all on function public.botanic_compact_canvas_graph_updates(uuid, text, text, jsonb, integer)
  from public, anon, authenticated;
grant execute on function public.botanic_compact_canvas_graph_updates(uuid, text, text, jsonb, integer)
  to service_role;

-- 旧 API 压缩也走保留 mutation ledger 的新实现，避免滚动发布期间删掉幂等记录。
create or replace function public.botanic_compact_canvas_graph_updates(
  p_actor uuid,
  p_project_id text,
  p_snapshot text,
  p_graph jsonb
)
returns table (graph_revision integer, updated_at timestamptz)
language sql
security definer
set search_path = public
as $$
  select compacted.graph_revision, compacted.updated_at
  from public.botanic_compact_canvas_graph_updates(
    p_actor,
    p_project_id,
    p_snapshot,
    p_graph,
    null
  ) as compacted
$$;

revoke all on function public.botanic_compact_canvas_graph_updates(uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.botanic_compact_canvas_graph_updates(uuid, text, text, jsonb)
  to service_role;

-- 项目整文档写入也必须在同一事务内观察 epoch；先锁项目再锁图谱，保持旧 RPC 的锁顺序。
alter function public.botanic_write_project_document(uuid, jsonb, integer, integer)
  rename to botanic_write_project_document_legacy;
revoke all on function public.botanic_write_project_document_legacy(uuid, jsonb, integer, integer)
  from public, anon, authenticated, service_role;

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
  v_existing_project_id text;
  v_current_graph jsonb;
  v_authoritative_graph jsonb;
  v_incoming_graph jsonb;
  v_document jsonb := p_document;
  v_sync_protocol_epoch integer;
  v_role public.botanic_project_role;
begin
  if p_actor is null or p_document is null or v_project_id is null or p_document ->> 'name' is null then
    return query
      select * from public.botanic_write_project_document_legacy(
        p_actor, p_document, p_expected_revision, p_expected_graph_revision
      );
    return;
  end if;

  -- 与 legacy RPC 保持 project -> canvas_graphs 的锁顺序，避免并发写入互相等待。
  select project.id into v_existing_project_id
  from public.projects as project
  where project.id = v_project_id
  for update;
  if not found then
    return query
      select * from public.botanic_write_project_document_legacy(
        p_actor, p_document, p_expected_revision, p_expected_graph_revision
      );
    return;
  end if;

  select member.role into v_role
  from public.project_members as member
  where member.project_id = v_project_id and member.user_id = p_actor;
  if v_role is null or v_role not in ('owner', 'editor') then
    raise exception '你没有编辑该项目的权限' using errcode = '42501';
  end if;

  select canvas.graph, canvas.sync_protocol_epoch
  into v_current_graph, v_sync_protocol_epoch
  from public.canvas_graphs as canvas
  where canvas.project_id = v_project_id
  for update;
  if not found then
    return query
      select * from public.botanic_write_project_document_legacy(
        p_actor, p_document, p_expected_revision, p_expected_graph_revision
      );
    return;
  end if;

  v_authoritative_graph := jsonb_build_object(
    'nodes', coalesce(v_current_graph -> 'nodes', '[]'::jsonb),
    'edges', coalesce(v_current_graph -> 'edges', '[]'::jsonb)
  );
  v_incoming_graph := jsonb_build_object(
    'nodes', case when p_document ? 'nodes'
      then coalesce(p_document -> 'nodes', '[]'::jsonb)
      else v_authoritative_graph -> 'nodes' end,
    'edges', case when p_document ? 'edges'
      then coalesce(p_document -> 'edges', '[]'::jsonb)
      else v_authoritative_graph -> 'edges' end
  );

  if v_sync_protocol_epoch >= 2
    and v_incoming_graph is distinct from v_authoritative_graph then
    raise exception '画布同步协议版本已前进，请重新握手'
      using errcode = '55000', detail = v_sync_protocol_epoch::text;
  end if;

  -- V2 的 graphless metadata 写入交给旧 RPC 时，补回权威图谱，避免其兼容逻辑写空图。
  if v_sync_protocol_epoch >= 2 then
    if not (p_document ? 'nodes') then
      v_document := jsonb_set(v_document, '{nodes}', v_authoritative_graph -> 'nodes', true);
    end if;
    if not (p_document ? 'edges') then
      v_document := jsonb_set(v_document, '{edges}', v_authoritative_graph -> 'edges', true);
    end if;
  end if;

  return query
    select * from public.botanic_write_project_document_legacy(
      p_actor, v_document, p_expected_revision, p_expected_graph_revision
    );
end;
$$;

revoke all on function public.botanic_write_project_document(uuid, jsonb, integer, integer)
  from public, anon, authenticated;
grant execute on function public.botanic_write_project_document(uuid, jsonb, integer, integer)
  to service_role;
