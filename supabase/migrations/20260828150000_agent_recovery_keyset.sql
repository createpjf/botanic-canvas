begin;

-- 与 Turn Recovery 共用持久化毫秒 cursor。先回填，再收紧 NOT NULL，之后所有
-- INSERT / UPDATE 都由统一触发器从 updated_at 重算，不能独立篡改游标列。
alter table public.agent_runs
  add column if not exists recovery_updated_at_ms bigint;
update public.agent_runs
set recovery_updated_at_ms = floor(extract(epoch from updated_at) * 1000)::bigint
where recovery_updated_at_ms is null;
alter table public.agent_runs
  alter column recovery_updated_at_ms set not null;
drop trigger if exists botanic_agent_runs_recovery_updated_at_ms
on public.agent_runs;
create trigger botanic_agent_runs_recovery_updated_at_ms
before insert or update on public.agent_runs
for each row execute function public.botanic_set_recovery_updated_at_ms();

alter table public.agent_review_tasks
  add column if not exists recovery_updated_at_ms bigint;
update public.agent_review_tasks
set recovery_updated_at_ms = floor(extract(epoch from updated_at) * 1000)::bigint
where recovery_updated_at_ms is null;
alter table public.agent_review_tasks
  alter column recovery_updated_at_ms set not null;
drop trigger if exists botanic_agent_review_tasks_recovery_updated_at_ms
on public.agent_review_tasks;
create trigger botanic_agent_review_tasks_recovery_updated_at_ms
before insert or update on public.agent_review_tasks
for each row execute function public.botanic_set_recovery_updated_at_ms();

alter table public.generation_jobs
  add column if not exists recovery_updated_at_ms bigint;
update public.generation_jobs
set recovery_updated_at_ms = floor(extract(epoch from updated_at) * 1000)::bigint
where recovery_updated_at_ms is null;
alter table public.generation_jobs
  alter column recovery_updated_at_ms set not null;
drop trigger if exists botanic_generation_jobs_recovery_updated_at_ms
on public.generation_jobs;
create trigger botanic_generation_jobs_recovery_updated_at_ms
before insert or update on public.generation_jobs
for each row execute function public.botanic_set_recovery_updated_at_ms();

-- Worker 恢复扫描只需要小而稳定的候选集。Partial index 与 RPC 的谓词保持
-- 完全一致，避免固定首页 poison item 让后续 Run / Task / Job 永久饥饿。
drop index if exists public.agent_runs_failed_branch_recovery_updated_id_idx;
create index agent_runs_failed_branch_recovery_updated_id_idx
  on public.agent_runs (recovery_updated_at_ms asc, id collate "C" asc)
  where status in ('partial', 'failed')
    and payload @> '{"branches":[{"status":"failed"}]}'::jsonb;

-- 20260828140000 已建立同名索引；这里重申 Recovery RPC 依赖的精确契约，
-- 让从不同历史版本升级的环境也能幂等补齐。
drop index if exists public.agent_review_tasks_pending_idx;
create index agent_review_tasks_pending_idx
  on public.agent_review_tasks (recovery_updated_at_ms asc, id collate "C" asc)
  where status in ('queued', 'running');

drop index if exists public.generation_jobs_recoverable_updated_id_idx;
create index generation_jobs_recoverable_updated_id_idx
  on public.generation_jobs (recovery_updated_at_ms asc, id collate "C" asc)
  where (status = 'queued' or payload->>'projectWritebackPending' = 'true');

-- RPC 与 partial index 共享同一 (epoch 毫秒, C-collated id) keyset。
create or replace function public.botanic_list_runs_with_failed_branches(
  p_after_updated_at_ms bigint default null,
  p_after_id text default null,
  p_limit integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  normalized_limit integer := greatest(1, least(coalesce(p_limit, 25), 200));
  result jsonb;
begin
  if (p_after_updated_at_ms is null) <> (p_after_id is null)
    or (p_after_updated_at_ms is not null and p_after_updated_at_ms < 0)
    or (p_after_id is not null and btrim(p_after_id) = '') then
    raise exception 'invalid failed branch run cursor' using errcode = '22023';
  end if;

  if p_after_updated_at_ms is null then
    select coalesce(
      jsonb_agg(candidate.payload order by candidate.updated_at_ms, candidate.id collate "C"),
      '[]'::jsonb
    )
    into result
    from (
      select
        run.id,
        run.recovery_updated_at_ms as updated_at_ms,
        jsonb_build_object(
          'id', run.id,
          'runId', run.id,
          'ownerId', run.owner_id,
          'projectId', run.project_id,
          'updatedAt', run.recovery_updated_at_ms
        ) as payload
      from public.agent_runs as run
      where run.status in ('partial', 'failed')
        and run.payload @> '{"branches":[{"status":"failed"}]}'::jsonb
      order by run.recovery_updated_at_ms asc, run.id collate "C" asc
      limit normalized_limit
    ) as candidate;
  else
    select coalesce(
      jsonb_agg(candidate.payload order by candidate.updated_at_ms, candidate.id collate "C"),
      '[]'::jsonb
    )
    into result
    from (
      select
        run.id,
        run.recovery_updated_at_ms as updated_at_ms,
        jsonb_build_object(
          'id', run.id,
          'runId', run.id,
          'ownerId', run.owner_id,
          'projectId', run.project_id,
          'updatedAt', run.recovery_updated_at_ms
        ) as payload
      from public.agent_runs as run
      where run.status in ('partial', 'failed')
        and run.payload @> '{"branches":[{"status":"failed"}]}'::jsonb
        and (run.recovery_updated_at_ms, run.id collate "C")
          > (p_after_updated_at_ms, p_after_id collate "C")
      order by run.recovery_updated_at_ms asc, run.id collate "C" asc
      limit normalized_limit
    ) as candidate;
  end if;

  return result;
end;
$$;

create or replace function public.botanic_list_pending_agent_review_tasks(
  p_older_than_ms bigint,
  p_after_updated_at_ms bigint default null,
  p_after_id text default null,
  p_limit integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  normalized_limit integer := greatest(1, least(coalesce(p_limit, 25), 200));
  result jsonb;
begin
  if p_older_than_ms is null or p_older_than_ms < 0
    or (p_after_updated_at_ms is null) <> (p_after_id is null)
    or (p_after_updated_at_ms is not null and p_after_updated_at_ms < 0)
    or (p_after_id is not null and btrim(p_after_id) = '') then
    raise exception 'invalid pending review task cursor' using errcode = '22023';
  end if;

  if p_after_updated_at_ms is null then
    select coalesce(
      jsonb_agg(candidate.payload order by candidate.updated_at_ms, candidate.id collate "C"),
      '[]'::jsonb
    )
    into result
    from (
      select
        task.id,
        task.recovery_updated_at_ms as updated_at_ms,
        task.payload || jsonb_build_object(
          'id', task.id,
          'updatedAt', task.recovery_updated_at_ms
        ) as payload
      from public.agent_review_tasks as task
      where task.status in ('queued', 'running')
        and task.recovery_updated_at_ms <= p_older_than_ms
      order by task.recovery_updated_at_ms asc, task.id collate "C" asc
      limit normalized_limit
    ) as candidate;
  else
    select coalesce(
      jsonb_agg(candidate.payload order by candidate.updated_at_ms, candidate.id collate "C"),
      '[]'::jsonb
    )
    into result
    from (
      select
        task.id,
        task.recovery_updated_at_ms as updated_at_ms,
        task.payload || jsonb_build_object(
          'id', task.id,
          'updatedAt', task.recovery_updated_at_ms
        ) as payload
      from public.agent_review_tasks as task
      where task.status in ('queued', 'running')
        and task.recovery_updated_at_ms <= p_older_than_ms
        and (task.recovery_updated_at_ms, task.id collate "C")
          > (p_after_updated_at_ms, p_after_id collate "C")
      order by task.recovery_updated_at_ms asc, task.id collate "C" asc
      limit normalized_limit
    ) as candidate;
  end if;

  return result;
end;
$$;

create or replace function public.botanic_list_recoverable_generation_jobs(
  p_after_updated_at_ms bigint default null,
  p_after_id text default null,
  p_limit integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  normalized_limit integer := greatest(1, least(coalesce(p_limit, 25), 200));
  result jsonb;
begin
  if (p_after_updated_at_ms is null) <> (p_after_id is null)
    or (p_after_updated_at_ms is not null and p_after_updated_at_ms < 0)
    or (p_after_id is not null and btrim(p_after_id) = '') then
    raise exception 'invalid recoverable generation job cursor' using errcode = '22023';
  end if;

  if p_after_updated_at_ms is null then
    select coalesce(
      jsonb_agg(candidate.payload order by candidate.updated_at_ms, candidate.id collate "C"),
      '[]'::jsonb
    )
    into result
    from (
      select
        job.id,
        job.recovery_updated_at_ms as updated_at_ms,
        job.payload || jsonb_build_object(
          'id', job.id,
          'updatedAt', job.recovery_updated_at_ms
        ) as payload
      from public.generation_jobs as job
      where job.status = 'queued' or job.payload->>'projectWritebackPending' = 'true'
      order by job.recovery_updated_at_ms asc, job.id collate "C" asc
      limit normalized_limit
    ) as candidate;
  else
    select coalesce(
      jsonb_agg(candidate.payload order by candidate.updated_at_ms, candidate.id collate "C"),
      '[]'::jsonb
    )
    into result
    from (
      select
        job.id,
        job.recovery_updated_at_ms as updated_at_ms,
        job.payload || jsonb_build_object(
          'id', job.id,
          'updatedAt', job.recovery_updated_at_ms
        ) as payload
      from public.generation_jobs as job
      where (job.status = 'queued' or job.payload->>'projectWritebackPending' = 'true')
        and (job.recovery_updated_at_ms, job.id collate "C")
          > (p_after_updated_at_ms, p_after_id collate "C")
      order by job.recovery_updated_at_ms asc, job.id collate "C" asc
      limit normalized_limit
    ) as candidate;
  end if;

  return result;
end;
$$;

revoke all on function public.botanic_list_runs_with_failed_branches(bigint, text, integer)
from public, anon, authenticated;
grant execute on function public.botanic_list_runs_with_failed_branches(bigint, text, integer)
to service_role;

revoke all on function public.botanic_list_pending_agent_review_tasks(bigint, bigint, text, integer)
from public, anon, authenticated;
grant execute on function public.botanic_list_pending_agent_review_tasks(bigint, bigint, text, integer)
to service_role;

revoke all on function public.botanic_list_recoverable_generation_jobs(bigint, text, integer)
from public, anon, authenticated;
grant execute on function public.botanic_list_recoverable_generation_jobs(bigint, text, integer)
to service_role;

commit;
