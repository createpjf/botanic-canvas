begin;

-- 原始 Subagent descriptor / activation 含 owner、request hash、dispatch lease 与
-- execution fence。客户端只能读取服务端鉴权后的安全 DTO，不能直连 Data API 读取原表。
drop policy if exists "project members can read agent subagents"
  on public.agent_subagents;
drop policy if exists "project members can read agent subagent activations"
  on public.agent_subagent_activations;

revoke all on table public.agent_subagents
  from public, anon, authenticated;
revoke all on table public.agent_subagent_activations
  from public, anon, authenticated;

grant select, insert, update, delete
  on table public.agent_subagents to service_role;
grant select, insert, update, delete
  on table public.agent_subagent_activations to service_role;

commit;
