begin;

-- Trigger-only function: Auth clients must not invoke it through PostgREST RPC.
revoke all on function public.botanic_handle_new_user() from public, anon, authenticated;

-- RLS policies call this helper as authenticated users; anonymous callers do not need it.
revoke all on function public.botanic_has_project_role(text, public.botanic_project_role[])
from public, anon;
grant execute on function public.botanic_has_project_role(text, public.botanic_project_role[])
to authenticated;

commit;
