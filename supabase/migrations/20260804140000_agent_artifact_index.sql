-- Artifact Index 是项目级、可查询的历史产物目录。
-- Artifact ID 只在项目内唯一；删除画布节点不会删除历史 Artifact。

create table if not exists public.agent_artifacts (
  project_id text not null references public.projects(id) on delete cascade,
  id text not null,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('image', 'video', 'text', 'workflow', 'asset_group', 'file')),
  source_kind text not null check (source_kind in ('agent_action', 'generation_output')),
  run_id text,
  job_id text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  payload jsonb not null,
  primary key (project_id, id)
);

create index if not exists agent_artifacts_project_created_idx
on public.agent_artifacts (project_id, created_at desc, id);
create index if not exists agent_artifacts_run_idx
on public.agent_artifacts (project_id, run_id) where run_id is not null;
create index if not exists agent_artifacts_job_idx
on public.agent_artifacts (project_id, job_id) where job_id is not null;

alter table public.agent_artifacts enable row level security;

drop policy if exists "project members can read agent artifacts" on public.agent_artifacts;
create policy "project members can read agent artifacts"
on public.agent_artifacts for select to authenticated
using (public.botanic_has_project_role(project_id, array['owner', 'editor', 'viewer']::public.botanic_project_role[]));

drop policy if exists "project editors can write agent artifacts" on public.agent_artifacts;
create policy "project editors can write agent artifacts"
on public.agent_artifacts for all to authenticated
using (public.botanic_has_project_role(project_id, array['owner', 'editor']::public.botanic_project_role[]))
with check (public.botanic_has_project_role(project_id, array['owner', 'editor']::public.botanic_project_role[]));

insert into public.agent_artifacts (
  project_id, id, owner_id, kind, source_kind, run_id, job_id,
  created_at, updated_at, payload
)
select message.project_id, artifact->>'id', message.owner_id, artifact->>'kind', 'agent_action',
  nullif(artifact->'provenance'->>'runId', ''), null,
  case when message.payload->>'createdAt' ~ '^[0-9]+$'
    then to_timestamp((message.payload->>'createdAt')::double precision / 1000.0)
    else message.updated_at end,
  message.updated_at,
  artifact || jsonb_build_object(
    'origin', jsonb_strip_nulls(jsonb_build_object(
      'type', 'agent_action', 'sessionId', message.session_id,
      'messageId', message.id, 'actionId', action->>'id'
    )),
    'createdAt', case when message.payload->>'createdAt' ~ '^[0-9]+$'
      then (message.payload->>'createdAt')::bigint
      else (extract(epoch from message.updated_at) * 1000)::bigint end,
    'updatedAt', (extract(epoch from message.updated_at) * 1000)::bigint
  )
from public.agent_messages message
cross join lateral jsonb_array_elements(case
  when jsonb_typeof(message.payload->'plan'->'actions') = 'array' then message.payload->'plan'->'actions'
  else '[]'::jsonb end) action
cross join lateral jsonb_array_elements(case
  when jsonb_typeof(action->'result'->'artifacts') = 'array' then action->'result'->'artifacts'
  else '[]'::jsonb end) artifact
where nullif(artifact->>'id', '') is not null
  and artifact->>'kind' in ('image', 'video', 'text', 'workflow', 'asset_group', 'file')
  and nullif(artifact->>'label', '') is not null
  and jsonb_typeof(artifact->'provenance') = 'object'
on conflict (project_id, id) do update set
  kind = excluded.kind,
  source_kind = excluded.source_kind,
  run_id = excluded.run_id,
  updated_at = excluded.updated_at,
  payload = excluded.payload
where agent_artifacts.updated_at <= excluded.updated_at;

insert into public.agent_artifacts (
  project_id, id, owner_id, kind, source_kind, run_id, job_id,
  created_at, updated_at, payload
)
select receipt.project_id, artifact->>'id', receipt.owner_id, artifact->>'kind', 'agent_action',
  nullif(artifact->'provenance'->>'runId', ''), null,
  receipt.created_at, receipt.created_at,
  artifact || jsonb_build_object(
    'origin', jsonb_strip_nulls(jsonb_build_object(
      'type', 'agent_action',
      'actionId', coalesce(
        receipt.payload->>'toolCallId',
        receipt.payload->'result'->'toolCall'->>'id',
        receipt.payload->'toolCall'->>'id'
      )
    )),
    'createdAt', (extract(epoch from receipt.created_at) * 1000)::bigint,
    'updatedAt', (extract(epoch from receipt.created_at) * 1000)::bigint
  )
from public.agent_action_receipts receipt
cross join lateral jsonb_array_elements(case
  when jsonb_typeof(receipt.payload->'output'->'artifacts') = 'array' then receipt.payload->'output'->'artifacts'
  when jsonb_typeof(receipt.payload->'result'->'output'->'artifacts') = 'array' then receipt.payload->'result'->'output'->'artifacts'
  when jsonb_typeof(receipt.payload->'result'->'artifacts') = 'array' then receipt.payload->'result'->'artifacts'
  else '[]'::jsonb end) artifact
where nullif(artifact->>'id', '') is not null
  and artifact->>'kind' in ('image', 'video', 'text', 'workflow', 'asset_group', 'file')
  and nullif(artifact->>'label', '') is not null
  and jsonb_typeof(artifact->'provenance') = 'object'
on conflict (project_id, id) do update set
  kind = excluded.kind,
  source_kind = excluded.source_kind,
  run_id = excluded.run_id,
  updated_at = excluded.updated_at,
  payload = excluded.payload
where agent_artifacts.updated_at <= excluded.updated_at;

insert into public.agent_artifacts (
  project_id, id, owner_id, kind, source_kind, run_id, job_id,
  created_at, updated_at, payload
)
select job.project_id, 'generation:' || job.id || ':' || (output->>'id'), job.owner_id,
  case when output->>'mediaKind' = 'video' then 'video' else 'image' end,
  'generation_output', nullif(job.payload->'agentRun'->>'runId', ''), job.id,
  job.updated_at, job.updated_at,
  jsonb_build_object(
    'id', 'generation:' || job.id || ':' || (output->>'id'),
    'kind', case when output->>'mediaKind' = 'video' then 'video' else 'image' end,
    'label', case when output->>'mediaKind' = 'video' then '生成视频' else '生成图片' end,
    'url', output->>'image',
    'metadata', jsonb_strip_nulls(jsonb_build_object(
      'source', 'generation', 'status', job.status, 'jobId', job.id,
      'branchId', job.payload->'agentRun'->>'branchId',
      'groupId', job.payload->'agentRun'->>'runId',
      'outputId', output->>'id', 'settings', job.payload->'settings'
    )),
    'provenance', jsonb_strip_nulls(jsonb_build_object(
      'actionId', 'generation:' || job.id,
      'toolName', case when output->>'mediaKind' = 'video' then 'video_generation' else 'image_generation' end,
      'runId', job.payload->'agentRun'->>'runId',
      'sourceNodeIds', coalesce((
        select jsonb_agg(node->>'id' order by node->>'id')
        from jsonb_array_elements(coalesce(project.document->'nodes', '[]'::jsonb)) node
        where node->>'type' = 'result'
          and node->'data'->>'jobId' = job.id
          and (
            node->'data'->>'candidateId' = output->>'id'
            or (
              nullif(node->'data'->>'candidateId', '') is null
              and jsonb_array_length(job.payload->'outputs') = 1
            )
          )
      ), '[]'::jsonb)
    )),
    'origin', jsonb_build_object(
      'type', 'generation_output', 'jobId', job.id, 'outputId', output->>'id'
    ),
    'createdAt', (extract(epoch from job.updated_at) * 1000)::bigint,
    'updatedAt', (extract(epoch from job.updated_at) * 1000)::bigint
  )
from public.generation_jobs job
join public.projects project on project.id = job.project_id
cross join lateral jsonb_array_elements(case
  when jsonb_typeof(job.payload->'outputs') = 'array' then job.payload->'outputs'
  else '[]'::jsonb end) output
where nullif(output->>'id', '') is not null and nullif(output->>'image', '') is not null
on conflict (project_id, id) do update set
  kind = excluded.kind,
  source_kind = excluded.source_kind,
  run_id = excluded.run_id,
  job_id = excluded.job_id,
  updated_at = excluded.updated_at,
  payload = excluded.payload
where agent_artifacts.updated_at <= excluded.updated_at;

-- 迁移事务内完成只读对账。旧实体中每个可识别产物都必须进入索引；索引中多出的
-- 记录属于画布节点删除后仍需保留的历史，因此不视为异常。
do $$
declare
  missing_count bigint;
  malformed_count bigint;
begin
  with expected as (
    select message.project_id, artifact->>'id' as id
    from public.agent_messages message
    cross join lateral jsonb_array_elements(case
      when jsonb_typeof(message.payload->'plan'->'actions') = 'array' then message.payload->'plan'->'actions'
      else '[]'::jsonb end) action
    cross join lateral jsonb_array_elements(case
      when jsonb_typeof(action->'result'->'artifacts') = 'array' then action->'result'->'artifacts'
      else '[]'::jsonb end) artifact
    where nullif(artifact->>'id', '') is not null
      and artifact->>'kind' in ('image', 'video', 'text', 'workflow', 'asset_group', 'file')
      and nullif(artifact->>'label', '') is not null
      and jsonb_typeof(artifact->'provenance') = 'object'
    union
    select receipt.project_id, artifact->>'id' as id
    from public.agent_action_receipts receipt
    cross join lateral jsonb_array_elements(case
      when jsonb_typeof(receipt.payload->'output'->'artifacts') = 'array' then receipt.payload->'output'->'artifacts'
      when jsonb_typeof(receipt.payload->'result'->'output'->'artifacts') = 'array' then receipt.payload->'result'->'output'->'artifacts'
      when jsonb_typeof(receipt.payload->'result'->'artifacts') = 'array' then receipt.payload->'result'->'artifacts'
      else '[]'::jsonb end) artifact
    where nullif(artifact->>'id', '') is not null
      and artifact->>'kind' in ('image', 'video', 'text', 'workflow', 'asset_group', 'file')
      and nullif(artifact->>'label', '') is not null
      and jsonb_typeof(artifact->'provenance') = 'object'
    union
    select job.project_id, 'generation:' || job.id || ':' || (output->>'id') as id
    from public.generation_jobs job
    cross join lateral jsonb_array_elements(case
      when jsonb_typeof(job.payload->'outputs') = 'array' then job.payload->'outputs'
      else '[]'::jsonb end) output
    where nullif(output->>'id', '') is not null
      and nullif(output->>'image', '') is not null
  )
  select count(*) into missing_count
  from expected
  left join public.agent_artifacts indexed
    on indexed.project_id = expected.project_id and indexed.id = expected.id
  where indexed.id is null;

  select count(*) into malformed_count
  from public.agent_artifacts
  where payload->>'id' is distinct from id
    or payload->>'kind' is distinct from kind
    or payload->'origin'->>'type' is distinct from source_kind;

  if missing_count > 0 then
    raise exception 'Artifact Index migration reconciliation failed: % expected artifacts are missing', missing_count;
  end if;
  if malformed_count > 0 then
    raise exception 'Artifact Index migration reconciliation failed: % indexed artifacts have malformed payloads', malformed_count;
  end if;

  raise notice 'Artifact Index migration reconciliation passed';
end $$;
