begin;

-- 这些 RPC 已由 20260827170000 建立。先保留原状态机实现，再用同名 wrapper
-- 在同一 advisory/row lock 内保护 endpoint + project + requestHash 绑定。
alter function public.botanic_put_agent_run(uuid, jsonb)
  rename to botanic_put_agent_run_unbound;
alter function public.botanic_put_generation_job_guarded(uuid, text, text, jsonb)
  rename to botanic_put_generation_job_guarded_unbound;
alter function public.botanic_commit_generation_job_execution(uuid, text, text, jsonb)
  rename to botanic_commit_generation_job_execution_unbound;
alter function public.botanic_compare_and_set_generation_job(uuid, text, text, jsonb)
  rename to botanic_compare_and_set_generation_job_unbound;

-- 把 request identity 字段从已存权威实体覆盖回候选，兼容滚动部署中尚不知道
-- idempotencyBinding 的旧 writer；它们可以推进状态，但不能改写第一次请求。
create or replace function public.botanic_sticky_json_fields(
  p_existing jsonb,
  p_candidate jsonb,
  p_fields text[]
)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  result jsonb := p_candidate;
  field_name text;
begin
  foreach field_name in array p_fields loop
    if p_existing ? field_name then
      result := jsonb_set(result, array[field_name], p_existing->field_name, true);
    else
      result := result - field_name;
    end if;
  end loop;
  return result;
end;
$$;

-- Run 分支同时承载 immutable request（id/label/asset/variation/item）与执行态。
-- 不能把整个 branches 锁死；按首次分支集合覆盖请求字段，只允许状态/attempt/jobIds 推进。
create or replace function public.botanic_sticky_agent_run_branches(
  p_existing jsonb,
  p_candidate jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  result jsonb := '[]'::jsonb;
  stored_branch jsonb;
  candidate_branch jsonb;
begin
  if jsonb_typeof(p_existing) is distinct from 'array'
    or jsonb_typeof(p_candidate) is distinct from 'array' then
    return p_existing;
  end if;
  for stored_branch in select value from jsonb_array_elements(p_existing)
  loop
    select value into candidate_branch
    from jsonb_array_elements(p_candidate)
    where value->>'id' = stored_branch->>'id'
    limit 1;
    candidate_branch := coalesce(candidate_branch, stored_branch);
    candidate_branch := public.botanic_sticky_json_fields(
      stored_branch,
      candidate_branch,
      array['id', 'label', 'assetId', 'variation', 'item']
    );
    result := result || jsonb_build_array(candidate_branch);
  end loop;
  return result;
end;
$$;

create or replace function public.botanic_put_agent_run(
  p_owner_id uuid,
  p_run jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing public.agent_runs%rowtype;
  stored_binding jsonb;
  candidate_binding jsonb;
  candidate_payload jsonb;
  run_id text := nullif(btrim(p_run->>'id'), '');
begin
  if p_owner_id is null or run_id is null or jsonb_typeof(p_run->'payload') is distinct from 'object' then
    raise exception 'invalid Agent run binding put' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(run_id, 0));
  select * into existing from public.agent_runs where id = run_id for update;
  if found then
    stored_binding := existing.payload->'idempotencyBinding';
    candidate_binding := p_run->'payload'->'idempotencyBinding';
    if existing.payload ? 'idempotencyBinding'
      and jsonb_typeof(stored_binding) is distinct from 'object' then
      return existing.payload;
    end if;
    if candidate_binding is not null and jsonb_typeof(candidate_binding) is distinct from 'object' then
      return existing.payload;
    end if;
    if stored_binding is not null and candidate_binding is not null
      and candidate_binding is distinct from stored_binding then
      return existing.payload;
    end if;
    if stored_binding is not null then
      candidate_payload := public.botanic_sticky_json_fields(
        existing.payload,
        p_run->'payload',
        array['id', 'ownerId', 'projectId', 'createdAt', 'turnId', 'lineage', 'plan', 'idempotencyBinding']
      );
      candidate_payload := jsonb_set(
        candidate_payload,
        '{branches}',
        public.botanic_sticky_agent_run_branches(
          existing.payload->'branches',
          candidate_payload->'branches'
        ),
        true
      );
      p_run := jsonb_set(p_run, '{payload}', candidate_payload, true);
    end if;
  end if;
  return public.botanic_put_agent_run_unbound(p_owner_id, p_run);
end;
$$;

create or replace function public.botanic_put_generation_job_guarded(
  p_owner_id uuid,
  p_job_id text,
  p_project_id text,
  p_job jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing public.generation_jobs%rowtype;
  stored_binding jsonb;
  candidate_binding jsonb;
begin
  if p_owner_id is null or nullif(btrim(p_job_id), '') is null
    or nullif(btrim(p_project_id), '') is null or jsonb_typeof(p_job) is distinct from 'object' then
    raise exception 'invalid Generation Job binding put' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_job_id, 4));
  select * into existing from public.generation_jobs where id = p_job_id for update;
  if found then
    stored_binding := existing.payload->'idempotencyBinding';
    candidate_binding := p_job->'idempotencyBinding';
    if existing.payload ? 'idempotencyBinding'
      and jsonb_typeof(stored_binding) is distinct from 'object' then
      return jsonb_build_object('kind', 'conflict', 'changed', false, 'job', existing.payload);
    end if;
    if candidate_binding is not null and jsonb_typeof(candidate_binding) is distinct from 'object' then
      return jsonb_build_object('kind', 'conflict', 'changed', false, 'job', existing.payload);
    end if;
    if stored_binding is not null and candidate_binding is not null
      and candidate_binding is distinct from stored_binding then
      return jsonb_build_object('kind', 'conflict', 'changed', false, 'job', existing.payload);
    end if;
    if stored_binding is not null then
      p_job := public.botanic_sticky_json_fields(
        existing.payload,
        p_job,
        array[
          'id', 'ownerId', 'projectId', 'createdAt', 'kind', 'refinementMode', 'batchCount',
          'settings', 'provider', 'rawInput', 'idempotencyKey', 'agentRun', 'idempotencyBinding'
        ]
      );
    end if;
  end if;
  return public.botanic_put_generation_job_guarded_unbound(p_owner_id, p_job_id, p_project_id, p_job);
end;
$$;

create or replace function public.botanic_commit_generation_job_execution(
  p_owner_id uuid,
  p_job_id text,
  p_project_id text,
  p_command jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing public.generation_jobs%rowtype;
  stored_binding jsonb;
  candidate_binding jsonb;
  candidate_job jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_job_id, 4));
  select * into existing from public.generation_jobs where id = p_job_id for update;
  if found and jsonb_typeof(p_command->'job') = 'object' then
    stored_binding := existing.payload->'idempotencyBinding';
    candidate_binding := p_command->'job'->'idempotencyBinding';
    if stored_binding is not null and candidate_binding is not null
      and candidate_binding is distinct from stored_binding then
      return jsonb_build_object('kind', 'conflict', 'changed', false, 'job', existing.payload);
    end if;
    if stored_binding is not null then
      candidate_job := public.botanic_sticky_json_fields(
        existing.payload,
        p_command->'job',
        array[
          'id', 'ownerId', 'projectId', 'createdAt', 'kind', 'refinementMode', 'batchCount',
          'settings', 'provider', 'rawInput', 'idempotencyKey', 'agentRun', 'idempotencyBinding'
        ]
      );
      p_command := jsonb_set(p_command, '{job}', candidate_job, true);
    end if;
  end if;
  return public.botanic_commit_generation_job_execution_unbound(
    p_owner_id, p_job_id, p_project_id, p_command
  );
end;
$$;

create or replace function public.botanic_compare_and_set_generation_job(
  p_owner_id uuid,
  p_job_id text,
  p_project_id text,
  p_command jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing public.generation_jobs%rowtype;
  stored_binding jsonb;
  candidate_binding jsonb;
  candidate_job jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_job_id, 4));
  select * into existing from public.generation_jobs where id = p_job_id for update;
  if found and jsonb_typeof(p_command->'job') = 'object' then
    stored_binding := existing.payload->'idempotencyBinding';
    candidate_binding := p_command->'job'->'idempotencyBinding';
    if stored_binding is not null and candidate_binding is not null
      and candidate_binding is distinct from stored_binding then
      return jsonb_build_object('kind', 'conflict', 'changed', false, 'job', existing.payload);
    end if;
    if stored_binding is not null then
      candidate_job := public.botanic_sticky_json_fields(
        existing.payload,
        p_command->'job',
        array[
          'id', 'ownerId', 'projectId', 'createdAt', 'kind', 'refinementMode', 'batchCount',
          'settings', 'provider', 'rawInput', 'idempotencyKey', 'agentRun', 'idempotencyBinding'
        ]
      );
      p_command := jsonb_set(p_command, '{job}', candidate_job, true);
    end if;
  end if;
  return public.botanic_compare_and_set_generation_job_unbound(
    p_owner_id, p_job_id, p_project_id, p_command
  );
end;
$$;

revoke all on function public.botanic_sticky_json_fields(jsonb, jsonb, text[])
from public, anon, authenticated;
revoke all on function public.botanic_sticky_agent_run_branches(jsonb, jsonb)
from public, anon, authenticated;
revoke all on function public.botanic_put_agent_run_unbound(uuid, jsonb)
from public, anon, authenticated, service_role;
revoke all on function public.botanic_put_generation_job_guarded_unbound(uuid, text, text, jsonb)
from public, anon, authenticated, service_role;
revoke all on function public.botanic_commit_generation_job_execution_unbound(uuid, text, text, jsonb)
from public, anon, authenticated, service_role;
revoke all on function public.botanic_compare_and_set_generation_job_unbound(uuid, text, text, jsonb)
from public, anon, authenticated, service_role;

revoke all on function public.botanic_put_agent_run(uuid, jsonb)
from public, anon, authenticated;
grant execute on function public.botanic_put_agent_run(uuid, jsonb) to service_role;
revoke all on function public.botanic_put_generation_job_guarded(uuid, text, text, jsonb)
from public, anon, authenticated;
grant execute on function public.botanic_put_generation_job_guarded(uuid, text, text, jsonb) to service_role;
revoke all on function public.botanic_commit_generation_job_execution(uuid, text, text, jsonb)
from public, anon, authenticated;
grant execute on function public.botanic_commit_generation_job_execution(uuid, text, text, jsonb) to service_role;
revoke all on function public.botanic_compare_and_set_generation_job(uuid, text, text, jsonb)
from public, anon, authenticated;
grant execute on function public.botanic_compare_and_set_generation_job(uuid, text, text, jsonb) to service_role;

commit;
