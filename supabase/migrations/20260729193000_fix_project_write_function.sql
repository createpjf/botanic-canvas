-- 返回表字段 revision 与 projects.revision 同名；显式限定列来源，确保新项目首次写入可执行。
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
    v_revision := v_revision + 1;
    update public.projects
    set name = v_name, document = p_document, revision = v_revision
    where id = v_project_id;
    insert into public.audit_events (id, actor_id, action, project_id, detail)
    values ('audit_' || gen_random_uuid(), p_actor, 'project.updated', v_project_id, jsonb_build_object('revision', v_revision));
    return query select p_document as document, v_revision as revision, false as created;
  else
    insert into public.projects (id, name, document) values (v_project_id, v_name, p_document);
    insert into public.project_members (project_id, user_id, role) values (v_project_id, p_actor, 'owner');
    insert into public.audit_events (id, actor_id, action, project_id) values ('audit_' || gen_random_uuid(), p_actor, 'project.created', v_project_id);
    return query select p_document as document, 1 as revision, true as created;
  end if;
end;
$$;
