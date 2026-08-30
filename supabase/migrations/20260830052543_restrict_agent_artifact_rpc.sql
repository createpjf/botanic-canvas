begin;

revoke all on function public.botanic_upsert_agent_artifacts_monotonic(uuid, text, jsonb) from public;
revoke all on function public.botanic_upsert_agent_artifacts_monotonic(uuid, text, jsonb) from anon;
revoke all on function public.botanic_upsert_agent_artifacts_monotonic(uuid, text, jsonb) from authenticated;
grant execute on function public.botanic_upsert_agent_artifacts_monotonic(uuid, text, jsonb) to service_role;

commit;
