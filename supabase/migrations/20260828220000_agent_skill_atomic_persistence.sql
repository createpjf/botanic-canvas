begin;

-- outputSchema 会直接进入 Node/SQL 共用的 canonical hash。PostgreSQL C collation
-- 与 JavaScript UTF-16 对 Unicode 对象键的排序并不等价，因此只允许结构化契约
-- 已支持的 ASCII 字段词表；递归覆盖 properties/items 等任意嵌套层。
create or replace function public.botanic_agent_skill_schema_keys_are_ascii(p_schema jsonb)
returns boolean
language plpgsql
immutable
security invoker
set search_path = public, pg_temp
as $$
declare
  object_entry record;
  array_entry jsonb;
begin
  if jsonb_typeof(p_schema) = 'object' then
    for object_entry in select entry.key, entry.value from jsonb_each(p_schema) as entry(key, value) loop
      if object_entry.key !~ '^[A-Za-z_][A-Za-z0-9_.-]{0,79}$'
        or object_entry.key in ('__proto__', 'prototype', 'constructor')
        or not public.botanic_agent_skill_schema_keys_are_ascii(object_entry.value) then
        return false;
      end if;
    end loop;
  elsif jsonb_typeof(p_schema) = 'array' then
    for array_entry in select item.value from jsonb_array_elements(p_schema) as item(value) loop
      if not public.botanic_agent_skill_schema_keys_are_ascii(array_entry) then return false; end if;
    end loop;
  end if;
  return true;
end;
$$;

-- 从 Skill 的公开执行语义重算 V2 contentHash。这里不信任 service_role
-- 传入的 contentHash；必须与 server/botanicAgentSkill.mjs 的归一化边界一致。
create or replace function public.botanic_agent_skill_execution_hash(p_skill jsonb)
returns text
language plpgsql
immutable
security invoker
set search_path = public, pg_temp
as $$
declare
  normalized_name text;
  normalized_instructions text;
  normalized_capabilities jsonb;
  manifest_value jsonb;
  manifest_semantics jsonb := 'null'::jsonb;
  manifest_kind text;
  normalized_tools jsonb := '[]'::jsonb;
  normalized_dependencies jsonb := '[]'::jsonb;
  dependency jsonb;
  normalized_dependency jsonb;
  output_schema jsonb;
  property_count integer;
  capability_count integer;
  distinct_capability_count integer;
  tool_count integer;
  distinct_tool_count integer;
begin
  if jsonb_typeof(p_skill) is distinct from 'object'
    or jsonb_typeof(p_skill->'name') is distinct from 'string'
    or jsonb_typeof(p_skill->'instructions') is distinct from 'string'
    or jsonb_typeof(p_skill->'capabilities') is distinct from 'array' then
    return null;
  end if;

  normalized_name := btrim(p_skill->>'name');
  normalized_instructions := btrim(p_skill->>'instructions');
  if normalized_name = '' or length(normalized_name) > 80
    or normalized_name is distinct from p_skill->>'name'
    or normalized_instructions = '' or length(normalized_instructions) > 4000
    or normalized_instructions is distinct from p_skill->>'instructions' then
    return null;
  end if;

  if jsonb_array_length(p_skill->'capabilities') < 1
    or jsonb_array_length(p_skill->'capabilities') > 12
    or exists (
      select 1 from jsonb_array_elements(p_skill->'capabilities') as item(value)
      where jsonb_typeof(item.value) is distinct from 'string'
    ) then
    return null;
  end if;
  select count(*), count(distinct item.value)
  into capability_count, distinct_capability_count
  from jsonb_array_elements_text(p_skill->'capabilities') as item(value);
  if capability_count is distinct from distinct_capability_count
    or exists (
      select 1 from jsonb_array_elements_text(p_skill->'capabilities') as item(value)
      where item.value not in ('read', 'write', 'costly', 'external')
    ) then
    return null;
  end if;
  select jsonb_agg(to_jsonb(item.value) order by case item.value
    when 'read' then 1 when 'write' then 2 when 'costly' then 3 else 4 end)
  into normalized_capabilities
  from jsonb_array_elements_text(p_skill->'capabilities') as item(value);

  if p_skill ? 'manifest' then
    manifest_value := p_skill->'manifest';
    if jsonb_typeof(manifest_value) is distinct from 'object'
      or (manifest_value - 'version' - 'kind' - 'outputSchema' - 'toolAllowlist' - 'dependencies') <> '{}'::jsonb
      or manifest_value->'version' is distinct from '1'::jsonb
      or jsonb_typeof(manifest_value->'kind') is distinct from 'string'
      or manifest_value->>'kind' not in ('guidance', 'evaluator')
      or jsonb_typeof(manifest_value->'toolAllowlist') is distinct from 'array'
      or jsonb_typeof(manifest_value->'dependencies') is distinct from 'array' then
      return null;
    end if;
    manifest_kind := manifest_value->>'kind';

    if jsonb_array_length(manifest_value->'toolAllowlist') > 12
      or exists (
        select 1 from jsonb_array_elements(manifest_value->'toolAllowlist') as item(value)
        where jsonb_typeof(item.value) is distinct from 'string'
      ) then
      return null;
    end if;
    select count(*), count(distinct item.value)
    into tool_count, distinct_tool_count
    from jsonb_array_elements_text(manifest_value->'toolAllowlist') as item(value);
    if tool_count is distinct from distinct_tool_count
      or exists (
        select 1 from jsonb_array_elements_text(manifest_value->'toolAllowlist') as item(value)
        where item.value !~ '^[a-z][a-z0-9_]{1,63}$'
      ) then
      return null;
    end if;
    select coalesce(jsonb_agg(to_jsonb(item.value) order by item.value collate "C"), '[]'::jsonb)
    into normalized_tools
    from jsonb_array_elements_text(manifest_value->'toolAllowlist') as item(value);

    if jsonb_array_length(manifest_value->'dependencies') > 8 then return null; end if;
    for dependency in select value from jsonb_array_elements(manifest_value->'dependencies') loop
      if jsonb_typeof(dependency) is distinct from 'object'
        or (dependency - 'skillId' - 'version' - 'contentHash') <> '{}'::jsonb
        or jsonb_typeof(dependency->'skillId') is distinct from 'string'
        or btrim(dependency->>'skillId') = ''
        or length(dependency->>'skillId') > 160
        or btrim(dependency->>'skillId') is distinct from dependency->>'skillId' then
        return null;
      end if;
      if dependency ? 'version' and (
        jsonb_typeof(dependency->'version') is distinct from 'number'
        or (dependency->>'version')::numeric < 1
        or (dependency->>'version')::numeric <> trunc((dependency->>'version')::numeric)
        or (dependency->>'version')::numeric > 9007199254740991
      ) then return null; end if;
      if dependency ? 'contentHash' and (
        jsonb_typeof(dependency->'contentHash') is distinct from 'string'
        or btrim(dependency->>'contentHash') = ''
        or length(dependency->>'contentHash') > 200
        or btrim(dependency->>'contentHash') is distinct from dependency->>'contentHash'
      ) then return null; end if;
      normalized_dependency := jsonb_build_object('skillId', dependency->'skillId');
      if dependency ? 'version' then
        normalized_dependency := normalized_dependency || jsonb_build_object('version', dependency->'version');
      end if;
      if dependency ? 'contentHash' then
        normalized_dependency := normalized_dependency || jsonb_build_object('contentHash', dependency->'contentHash');
      end if;
      normalized_dependencies := normalized_dependencies || jsonb_build_array(normalized_dependency);
    end loop;
    select coalesce(jsonb_agg(item.value order by
      item.value->>'skillId' collate "C",
      coalesce((item.value->>'version')::numeric, 0),
      coalesce(item.value->>'contentHash', '') collate "C"
    ), '[]'::jsonb)
    into normalized_dependencies
    from jsonb_array_elements(normalized_dependencies) as item(value);

    if manifest_kind = 'guidance' then
      if manifest_value ? 'outputSchema' then return null; end if;
    else
      output_schema := manifest_value->'outputSchema';
      if jsonb_typeof(output_schema) is distinct from 'object'
        or not public.botanic_agent_skill_schema_keys_are_ascii(output_schema)
        or output_schema->>'type' is distinct from 'object'
        or jsonb_typeof(output_schema->'properties') is distinct from 'object'
        or jsonb_typeof(output_schema->'required') is distinct from 'array'
        or not exists (
          select 1 from jsonb_array_elements_text(output_schema->'required') as required(value)
          where required.value = 'verdict'
        )
        or jsonb_typeof(output_schema->'properties'->'verdict') is distinct from 'object'
        or output_schema->'properties'->'verdict'->>'type' is distinct from 'string'
        or jsonb_typeof(output_schema->'properties'->'verdict'->'enum') is distinct from 'array'
        or jsonb_array_length(output_schema->'properties'->'verdict'->'enum') < 1
        or exists (
          select 1 from jsonb_array_elements(output_schema->'properties'->'verdict'->'enum') as verdict(value)
          where jsonb_typeof(verdict.value) is distinct from 'string'
            or verdict.value #>> '{}' not in ('pass', 'fail', 'unverifiable')
        ) then
        return null;
      end if;
      select count(*) into property_count from jsonb_object_keys(output_schema->'properties');
      if property_count > 6 then return null; end if;
    end if;

    manifest_semantics := jsonb_build_object(
      'version', 1,
      'kind', manifest_kind,
      'toolAllowlist', normalized_tools,
      'dependencies', normalized_dependencies
    );
    if manifest_kind = 'evaluator' then
      manifest_semantics := manifest_semantics || jsonb_build_object('outputSchema', output_schema);
    end if;
  end if;

  return public.botanic_canonical_json_hash(jsonb_build_object(
    'schemaVersion', 2,
    'name', normalized_name,
    'instructions', normalized_instructions,
    'capabilities', normalized_capabilities,
    'manifest', manifest_semantics
  ));
exception when others then
  return null;
end;
$$;

-- 用 Node agentSkillExecutionContentHash 生成的固定向量锁住能力风险排序、
-- Manifest 工具/依赖排序与 canonical JSON 表示；任一漂移都让迁移原子失败。
do $botanic_agent_skill_hash_contract$
begin
  if public.botanic_agent_skill_execution_hash('{
    "name":"Publish Asset",
    "instructions":"Publish the approved asset.",
    "capabilities":["external","read"],
    "manifest":{
      "version":1,
      "kind":"guidance",
      "toolAllowlist":["skill_run","mcp_call"],
      "dependencies":[
        {"skillId":"z","version":2,"contentHash":"b"},
        {"skillId":"a","version":1,"contentHash":"a"}
      ]
    }
  }'::jsonb) is distinct from 'douzsE2vbVirbUKvqk0jC-RqoLtvoMGD7H4CcNonFQg' then
    raise exception 'Agent Skill execution hash contract differs from server';
  end if;
  if public.botanic_agent_skill_execution_hash('{
    "name":"Unicode",
    "instructions":"Stable ordering.",
    "capabilities":["read"],
    "manifest":{
      "version":1,
      "kind":"guidance",
      "toolAllowlist":[],
      "dependencies":[
        {"skillId":"😀","version":1,"contentHash":"😀"},
        {"skillId":"","version":1,"contentHash":""}
      ]
    }
  }'::jsonb) is distinct from 'wN5FAvyktMi6n5aB9hL1l-KSLTorNJXjp4z-IhadQCY' then
    raise exception 'Agent Skill Unicode ordering differs from server';
  end if;
  if public.botanic_agent_skill_execution_hash('{
    "name":"Visual Judge",
    "instructions":"Evaluate the visual.",
    "capabilities":["read"],
    "manifest":{
      "version":1,
      "kind":"evaluator",
      "outputSchema":{
        "type":"object",
        "properties":{
          "verdict":{"type":"string","enum":["pass","fail","unverifiable"]},
          "details":{
            "type":"object",
            "properties":{"summary_text":{"type":"string"}},
            "required":["summary_text"]
          }
        },
        "required":["verdict"]
      },
      "toolAllowlist":[],
      "dependencies":[]
    }
  }'::jsonb) is distinct from 'NiNG1eDcG9QAKjDUCnrmhBoTqCwaBBWllOhXqqO2Lqc' then
    raise exception 'Agent Skill evaluator schema hash contract differs from server';
  end if;
  if public.botanic_agent_skill_execution_hash('{
    "name":"Unicode Schema",
    "instructions":"Reject divergent keys.",
    "capabilities":["read"],
    "manifest":{
      "version":1,
      "kind":"evaluator",
      "outputSchema":{
        "type":"object",
        "properties":{
          "verdict":{"type":"string","enum":["pass","fail","unverifiable"]},
          "details":{"type":"object","properties":{"说明":{"type":"string"}}}
        },
        "required":["verdict"]
      },
      "toolAllowlist":[],
      "dependencies":[]
    }
  }'::jsonb) is not null then
    raise exception 'Agent Skill evaluator schema accepted a Unicode object key';
  end if;
end;
$botanic_agent_skill_hash_contract$;

-- Skill 版本历史是一个不可变聚合。事务锁让两个同时基于 v1 的 v2
-- 候选串行化：后到者必须对已落库的 v2 重做前缀/无间隙校验，不能覆盖。
create or replace function public.botanic_put_agent_skill(
  p_actor_id uuid,
  p_skill jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  command_skill_id text;
  command_project_id text;
  incoming_version bigint;
  incoming_versions jsonb;
  incoming_count integer;
  current_snapshot jsonb;
  snapshot jsonb;
  computed_hash text;
  existing_row public.agent_skills%rowtype;
  existing_versions jsonb := '[]'::jsonb;
  existing_count integer := 0;
  existing_effective_count integer := 0;
  existing_version bigint;
  previous_snapshot_version bigint := 0;
  snapshot_version bigint;
  stored_snapshot jsonb;
  incoming_snapshot jsonb;
  legacy_updated_at jsonb;
  stored_payload jsonb;
  observed_at timestamptz := clock_timestamp();
  updated_at_value timestamptz;
  member_role public.botanic_project_role;
  ordinal integer;
  complete_snapshot boolean;
  action_name text;
  incoming_updated_at numeric;
  existing_updated_at numeric;
begin
  if p_actor_id is null or jsonb_typeof(p_skill) is distinct from 'object'
    or jsonb_typeof(p_skill->'id') is distinct from 'string'
    or jsonb_typeof(p_skill->'projectId') is distinct from 'string' then
    return jsonb_build_object('kind', 'invalid', 'code', 'INVALID_AGENT_SKILL_VERSION');
  end if;
  command_skill_id := nullif(btrim(p_skill->>'id'), '');
  command_project_id := nullif(btrim(p_skill->>'projectId'), '');
  if command_skill_id is null or command_project_id is null
    or length(command_skill_id) > 160 or length(command_project_id) > 200
    or p_skill->>'id' is distinct from command_skill_id
    or p_skill->>'projectId' is distinct from command_project_id
    or p_skill->>'status' not in ('active', 'archived') then
    return jsonb_build_object('kind', 'invalid', 'code', 'INVALID_AGENT_SKILL_VERSION');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(command_skill_id, 11));
  select member.role into member_role
  from public.project_members as member
  where member.project_id = command_project_id and member.user_id = p_actor_id
  for share;
  if member_role is null or member_role not in ('owner', 'editor') then
    raise exception 'Agent Skill write forbidden' using errcode = '42501';
  end if;

  select skill.* into existing_row
  from public.agent_skills as skill
  where skill.id = command_skill_id
  for update;
  if existing_row.id is not null and existing_row.project_id is distinct from command_project_id then
    return jsonb_build_object('kind', 'conflict', 'code', 'AGENT_SKILL_ID_CONFLICT');
  end if;

  if jsonb_typeof(p_skill->'version') is distinct from 'number'
    or jsonb_typeof(p_skill->'versions') is distinct from 'array' then
    return jsonb_build_object('kind', 'invalid', 'code', 'INVALID_AGENT_SKILL_VERSION');
  end if;
  begin
    if (p_skill->>'version')::numeric < 1
      or (p_skill->>'version')::numeric <> trunc((p_skill->>'version')::numeric)
      or (p_skill->>'version')::numeric > 9007199254740991 then
      return jsonb_build_object('kind', 'invalid', 'code', 'INVALID_AGENT_SKILL_VERSION');
    end if;
    incoming_version := (p_skill->>'version')::bigint;
  exception when others then
    return jsonb_build_object('kind', 'invalid', 'code', 'INVALID_AGENT_SKILL_VERSION');
  end;
  incoming_versions := p_skill->'versions';
  incoming_count := jsonb_array_length(incoming_versions);
  if incoming_count < 1 then
    return jsonb_build_object('kind', 'conflict', 'code', 'AGENT_SKILL_HISTORY_CONFLICT');
  end if;

  if existing_row.id is not null then
    if jsonb_typeof(existing_row.payload->'versions') = 'array' then
      existing_versions := existing_row.payload->'versions';
      existing_count := jsonb_array_length(existing_versions);
    end if;
    begin
      existing_version := (existing_row.payload->>'version')::bigint;
    exception when others then
      return jsonb_build_object('kind', 'conflict', 'code', 'AGENT_SKILL_HISTORY_CONFLICT');
    end;
    existing_effective_count := greatest(existing_count, 1);
    legacy_updated_at := coalesce(
      nullif(existing_row.payload->'updatedAt', 'null'::jsonb),
      nullif(existing_row.payload->'createdAt', 'null'::jsonb)
    );
  end if;

  for snapshot, ordinal in
    select item.value, item.ordinality::integer
    from jsonb_array_elements(incoming_versions) with ordinality as item(value, ordinality)
  loop
    if jsonb_typeof(snapshot) is distinct from 'object'
      or jsonb_typeof(snapshot->'version') is distinct from 'number' then
      return jsonb_build_object('kind', 'conflict', 'code', 'AGENT_SKILL_HISTORY_CONFLICT');
    end if;
    begin
      if (snapshot->>'version')::numeric < 1
        or (snapshot->>'version')::numeric <> trunc((snapshot->>'version')::numeric)
        or (snapshot->>'version')::numeric > 9007199254740991 then
        return jsonb_build_object('kind', 'conflict', 'code', 'AGENT_SKILL_HISTORY_CONFLICT');
      end if;
      snapshot_version := (snapshot->>'version')::bigint;
    exception when others then
      return jsonb_build_object('kind', 'conflict', 'code', 'AGENT_SKILL_HISTORY_CONFLICT');
    end;
    if snapshot_version <= previous_snapshot_version then
      return jsonb_build_object('kind', 'conflict', 'code', 'AGENT_SKILL_HISTORY_CONFLICT');
    end if;
    previous_snapshot_version := snapshot_version;
    complete_snapshot := jsonb_typeof(snapshot->'name') = 'string'
      and jsonb_typeof(snapshot->'instructions') = 'string'
      and jsonb_typeof(snapshot->'capabilities') = 'array'
      and jsonb_typeof(snapshot->'contentHash') = 'string';
    if complete_snapshot then
      if jsonb_typeof(snapshot->'updatedAt') is distinct from 'number'
        or (snapshot->>'updatedAt')::numeric < 0
        or ((snapshot ? 'publishedBy') <> (snapshot ? 'publishedAt'))
        or (snapshot ? 'publishedBy' and (
          jsonb_typeof(snapshot->'publishedBy') is distinct from 'string'
          or btrim(snapshot->>'publishedBy') = ''
          or length(snapshot->>'publishedBy') > 160
          or btrim(snapshot->>'publishedBy') is distinct from snapshot->>'publishedBy'
          or jsonb_typeof(snapshot->'publishedAt') is distinct from 'number'
          or (snapshot->>'publishedAt')::numeric < 0
        )) then
        return jsonb_build_object('kind', 'invalid', 'code', 'INVALID_AGENT_SKILL_VERSION');
      end if;
      computed_hash := public.botanic_agent_skill_execution_hash(snapshot);
      if computed_hash is null or snapshot->>'contentHash' is distinct from computed_hash then
        return jsonb_build_object('kind', 'invalid', 'code', 'AGENT_SKILL_VERSION_HASH_MISMATCH');
      end if;
    elsif not (
      existing_row.id is not null and (
        (ordinal <= existing_count and existing_versions->(ordinal - 1) = snapshot)
        or (
          existing_count = 0
          and ordinal = 1
          and snapshot_version = existing_version
          and snapshot->>'instructions' is not distinct from existing_row.payload->>'instructions'
          and snapshot->>'contentHash' is not distinct from existing_row.payload->>'contentHash'
          and (snapshot - 'version' - 'instructions' - 'contentHash' - 'updatedAt') = '{}'::jsonb
          and jsonb_typeof(snapshot->'updatedAt') = 'number'
          and (snapshot->>'updatedAt')::numeric >= 0
          and snapshot->'updatedAt' = legacy_updated_at
        )
      )
    ) then
      -- 不完整快照只能是已存在的 legacy 历史前缀，不能新建或改写。
      return jsonb_build_object('kind', 'invalid', 'code', 'INVALID_AGENT_SKILL_VERSION');
    end if;
  end loop;

  if previous_snapshot_version is distinct from incoming_version then
    return jsonb_build_object('kind', 'conflict', 'code', 'AGENT_SKILL_HISTORY_CONFLICT');
  end if;

  current_snapshot := incoming_versions->(incoming_count - 1);
  computed_hash := public.botanic_agent_skill_execution_hash(current_snapshot);
  if computed_hash is null
    or p_skill->>'contentHash' is distinct from current_snapshot->>'contentHash'
    or public.botanic_agent_skill_execution_hash(p_skill) is distinct from computed_hash then
    return jsonb_build_object('kind', 'invalid', 'code', 'AGENT_SKILL_VERSION_HASH_MISMATCH');
  end if;

  if existing_row.id is null then
    if incoming_version <> 1 or incoming_count <> 1 then
      return jsonb_build_object('kind', 'conflict', 'code', 'AGENT_SKILL_HISTORY_CONFLICT');
    end if;
  else
    if incoming_version < existing_version or incoming_count < existing_effective_count then
      return jsonb_build_object('kind', 'conflict', 'code', 'AGENT_SKILL_VERSION_STALE');
    end if;
    if existing_count > 0 then
      for ordinal in 1..existing_count loop
        stored_snapshot := existing_versions->(ordinal - 1);
        incoming_snapshot := incoming_versions->(ordinal - 1);
        if stored_snapshot is distinct from incoming_snapshot and not (
          not (stored_snapshot ? 'publishedBy')
          and not (stored_snapshot ? 'publishedAt')
          and incoming_snapshot ? 'publishedBy'
          and incoming_snapshot ? 'publishedAt'
          and (incoming_snapshot - 'publishedBy' - 'publishedAt') = stored_snapshot
        ) then
          return jsonb_build_object('kind', 'conflict', 'code', 'AGENT_SKILL_HISTORY_CONFLICT');
        end if;
      end loop;
    end if;
    if incoming_version = existing_version then
      if p_skill->>'contentHash' is distinct from existing_row.payload->>'contentHash'
        or incoming_count is distinct from existing_effective_count then
        return jsonb_build_object('kind', 'conflict', 'code', 'AGENT_SKILL_VERSION_CONFLICT');
      end if;
      if existing_count = 0 and public.botanic_agent_skill_execution_hash(existing_row.payload)
        is distinct from existing_row.payload->>'contentHash' then
        return jsonb_build_object('kind', 'conflict', 'code', 'AGENT_SKILL_VERSION_CONFLICT');
      end if;
    elsif incoming_version <> existing_version + 1 or incoming_count <> existing_effective_count + 1 then
      return jsonb_build_object('kind', 'conflict', 'code', 'AGENT_SKILL_HISTORY_CONFLICT');
    end if;
  end if;

  stored_payload := p_skill;
  stored_payload := jsonb_set(
    stored_payload,
    '{ownerId}',
    coalesce(existing_row.payload->'ownerId', to_jsonb(p_actor_id::text)),
    true
  );
  if existing_row.payload->'createdAt' is not null and existing_row.payload->'createdAt' <> 'null'::jsonb then
    stored_payload := jsonb_set(stored_payload, '{createdAt}', existing_row.payload->'createdAt', true);
  end if;
  if existing_row.id is not null and stored_payload = existing_row.payload then
    return jsonb_build_object('kind', 'replay', 'changed', false, 'payload', existing_row.payload);
  end if;

  if existing_row.id is not null and incoming_version = existing_version and not (
    -- 存量 V2 行第一次只补 versions；不允许借 backfill 改写生命周期或其他顶层语义。
    existing_count = 0
    and (stored_payload - 'versions') = (existing_row.payload - 'versions')
  ) then
    begin
      if jsonb_typeof(stored_payload->'updatedAt') is distinct from 'number'
        or jsonb_typeof(existing_row.payload->'updatedAt') is distinct from 'number' then
        return jsonb_build_object('kind', 'conflict', 'code', 'AGENT_SKILL_VERSION_STALE');
      end if;
      incoming_updated_at := (stored_payload->>'updatedAt')::numeric;
      existing_updated_at := (existing_row.payload->>'updatedAt')::numeric;
      if incoming_updated_at < 0 or existing_updated_at < 0
        or incoming_updated_at <= existing_updated_at then
        return jsonb_build_object('kind', 'conflict', 'code', 'AGENT_SKILL_VERSION_STALE');
      end if;
    exception when others then
      return jsonb_build_object('kind', 'conflict', 'code', 'AGENT_SKILL_VERSION_STALE');
    end;
  end if;

  begin
    if jsonb_typeof(stored_payload->'updatedAt') = 'number' then
      updated_at_value := to_timestamp(((stored_payload->>'updatedAt')::numeric / 1000)::double precision);
    else
      updated_at_value := observed_at;
    end if;
  exception when others then
    updated_at_value := observed_at;
  end;
  action_name := case when existing_row.id is null then 'agent-skill.created' else 'agent-skill.updated' end;

  insert into public.agent_skills (id, owner_id, project_id, status, updated_at, payload)
  values (
    command_skill_id,
    coalesce(existing_row.owner_id, p_actor_id),
    command_project_id,
    stored_payload->>'status',
    updated_at_value,
    stored_payload
  )
  on conflict (id) do update set
    status = excluded.status,
    updated_at = excluded.updated_at,
    payload = excluded.payload;

  insert into public.audit_events (id, actor_id, action, project_id, target_id, detail, created_at)
  values (
    'audit_agent_skill_' || left(public.botanic_sha256_base64url(
      command_skill_id || ':' || public.botanic_canonical_json_hash(stored_payload)
    ), 32),
    p_actor_id,
    action_name,
    command_project_id,
    command_skill_id,
    jsonb_build_object('version', incoming_version),
    observed_at
  ) on conflict (id) do nothing;

  return jsonb_build_object('kind', 'write', 'changed', true, 'payload', stored_payload);
exception
  when check_violation or invalid_text_representation or numeric_value_out_of_range then
    return jsonb_build_object('kind', 'invalid', 'code', 'INVALID_AGENT_SKILL_VERSION');
end;
$$;

revoke all on function public.botanic_agent_skill_execution_hash(jsonb)
  from public, anon, authenticated;
revoke all on function public.botanic_agent_skill_schema_keys_are_ascii(jsonb)
  from public, anon, authenticated;
revoke all on function public.botanic_put_agent_skill(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.botanic_agent_skill_execution_hash(jsonb) to service_role;
grant execute on function public.botanic_agent_skill_schema_keys_are_ascii(jsonb) to service_role;
grant execute on function public.botanic_put_agent_skill(uuid, jsonb) to service_role;
grant execute on function public.botanic_js_number_text(jsonb) to service_role;
grant execute on function public.botanic_canonical_json_text(jsonb) to service_role;
grant execute on function public.botanic_canonical_json_hash(jsonb) to service_role;
grant execute on function public.botanic_sha256_base64url(text) to service_role;
grant select, insert, update on table public.agent_skills to service_role;
grant select on table public.project_members to service_role;
grant insert on table public.audit_events to service_role;

commit;
