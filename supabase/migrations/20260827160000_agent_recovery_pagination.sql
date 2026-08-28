begin;

-- Recovery cursor 使用持久化的 epoch 毫秒，避免 RPC 的排序表达式与索引键不一致。
-- 普通列由同一触发器从 updated_at 派生；Provider/客户端不能把它当作独立权威写入。
create or replace function public.botanic_set_recovery_updated_at_ms()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.recovery_updated_at_ms :=
    floor(extract(epoch from new.updated_at) * 1000)::bigint;
  return new;
end;
$$;

alter table public.agent_turns
  add column if not exists recovery_updated_at_ms bigint;

update public.agent_turns
set recovery_updated_at_ms = floor(extract(epoch from updated_at) * 1000)::bigint
where recovery_updated_at_ms is null;

alter table public.agent_turns
  alter column recovery_updated_at_ms set not null;

drop trigger if exists botanic_agent_turns_recovery_updated_at_ms
on public.agent_turns;
create trigger botanic_agent_turns_recovery_updated_at_ms
before insert or update on public.agent_turns
for each row execute function public.botanic_set_recovery_updated_at_ms();

-- 已部署过旧 120000 migration 的环境可能仍有包含 waiting_user 的索引；显式移除，
-- 防止无效等待行长期占据 stale sweep 的首页。
drop index if exists public.agent_turns_non_terminal_updated_idx;
drop index if exists public.agent_turns_reclaimable_updated_id_idx;
create index agent_turns_reclaimable_updated_id_idx
  on public.agent_turns (recovery_updated_at_ms asc, id collate "C" asc)
  where status in ('queued', 'running', 'cancelling');

-- Worker 以 id ASC keyset 扫描 queued Run，避免固定首页 poison row 饥饿后续 Run。
create index if not exists agent_runs_queued_id_idx
  on public.agent_runs (id asc)
  where status = 'queued';

-- 深取消从 Generation Job / Agent Run 的权威外键投影反查，不依赖 Turn/Run 内的
-- 有界 branch 列表。表达式索引与 project/owner scope、id cursor 顺序一致。
create index if not exists agent_runs_turn_id_page_idx
  on public.agent_runs (project_id, owner_id, (payload->>'turnId'), id asc)
  where nullif(payload->>'turnId', '') is not null;

create index if not exists generation_jobs_agent_run_id_page_idx
  on public.generation_jobs (
    project_id,
    owner_id,
    (payload->'agentRun'->>'runId'),
    id asc
  )
  where nullif(payload->'agentRun'->>'runId', '') is not null;

-- RPC 与 partial index 共享同一 (epoch 毫秒, C-collated id) keyset。
create or replace function public.botanic_list_stale_agent_turns(
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
  if p_older_than_ms is null
    or (p_after_updated_at_ms is null) <> (p_after_id is null)
    or (p_after_id is not null and btrim(p_after_id) = '') then
    raise exception 'invalid stale turn cursor' using errcode = '22023';
  end if;

  -- 拆开首屏与续页，让连接切到 generic plan 后 tuple cursor 仍进入 Index Cond，
  -- 不把已翻过的深页前缀退化成 Filter。
  if p_after_updated_at_ms is null then
    select coalesce(
      jsonb_agg(candidate.payload order by candidate.updated_at_ms, candidate.id collate "C"),
      '[]'::jsonb
    )
    into result
    from (
      select
        turn.id,
        turn.recovery_updated_at_ms as updated_at_ms,
        turn.payload || jsonb_build_object(
          'updatedAt', turn.recovery_updated_at_ms
        ) as payload
      from public.agent_turns as turn
      where turn.status in ('queued', 'running', 'cancelling')
        and turn.recovery_updated_at_ms < p_older_than_ms
      order by turn.recovery_updated_at_ms asc, turn.id collate "C" asc
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
        turn.id,
        turn.recovery_updated_at_ms as updated_at_ms,
        turn.payload || jsonb_build_object(
          'updatedAt', turn.recovery_updated_at_ms
        ) as payload
      from public.agent_turns as turn
      where turn.status in ('queued', 'running', 'cancelling')
        and turn.recovery_updated_at_ms < p_older_than_ms
        and (turn.recovery_updated_at_ms, turn.id collate "C")
          > (p_after_updated_at_ms, p_after_id collate "C")
      order by turn.recovery_updated_at_ms asc, turn.id collate "C" asc
      limit normalized_limit
    ) as candidate;
  end if;

  return result;
end;
$$;

revoke all on function public.botanic_list_stale_agent_turns(bigint, bigint, text, integer)
from public, anon, authenticated;
grant execute on function public.botanic_list_stale_agent_turns(bigint, bigint, text, integer)
to service_role;

commit;
