begin;

-- ADR 0004：Supabase 必须接受与 Local/PostgreSQL Adapter 相同的 Turn 生命周期。
-- 旧迁移只声明 running/completed/failed/cancelled，导致 queued、等待确认和取消中
-- 在 Supabase 部署上无法落库。
alter table public.agent_turns
  drop constraint if exists agent_turns_status_check;

alter table public.agent_turns
  add constraint agent_turns_status_check
  check (status in (
    'queued',
    'running',
    'waiting_user',
    'cancelling',
    'completed',
    'failed',
    'cancelled'
  ));

-- waiting_user 等待外部输入，不是失联执行。回收索引只覆盖可由 Worker 推进的状态，
-- id 是同毫秒 Turn 的稳定 keyset tie-breaker。
create index if not exists agent_turns_reclaimable_updated_id_idx
  on public.agent_turns (updated_at asc, id asc)
  where status in ('queued', 'running', 'cancelling');

commit;
