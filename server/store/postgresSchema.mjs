// PostgreSQL schema 权威：建表/索引/迁移 DDL 与 bootstrap 令牌预置。
// 只被 postgresProductStore 工厂在启动时调用一次；不持有连接与业务闭包。
import { randomUUID } from 'node:crypto'

export async function ensurePostgresSchema(sql) {
  await sql.begin(async (tx) => {
    await tx`set local client_min_messages = warning`
    await tx`select pg_advisory_xact_lock(72695837)`
    await tx.unsafe(`
    create table if not exists app_users (
      id text primary key,
      email text not null unique,
      name text not null,
      role text not null check (role in ('owner', 'member')),
      status text not null default 'active',
      created_at bigint not null
    );
    create table if not exists access_tokens (
      id text primary key,
      user_id text not null references app_users(id) on delete cascade,
      token_hash text not null unique,
      created_at bigint not null,
      revoked_at bigint
    );
    create table if not exists auth_identities (
      provider text not null,
      subject text not null,
      user_id text not null references app_users(id) on delete cascade,
      created_at bigint not null,
      primary key (provider, subject),
      unique (provider, user_id)
    );
    create table if not exists projects (
      id text primary key,
      name text not null,
      document jsonb not null,
      revision integer not null default 1,
      created_at bigint not null,
      updated_at bigint not null
    );
    create table if not exists project_members (
      project_id text not null references projects(id) on delete cascade,
      user_id text not null references app_users(id) on delete cascade,
      role text not null check (role in ('owner', 'editor', 'viewer')),
      added_at bigint not null,
      primary key (project_id, user_id)
    );
    create table if not exists canvas_graphs (
      project_id text primary key references projects(id) on delete cascade,
      graph jsonb not null,
      revision integer not null default 1,
      sync_protocol_epoch integer not null default 1,
      yjs_snapshot text,
      updated_at bigint not null
    );
    alter table canvas_graphs add column if not exists sync_protocol_epoch integer not null default 1;
    create table if not exists canvas_graph_updates (
      id bigserial primary key,
      project_id text not null references canvas_graphs(project_id) on delete cascade,
      update_base64 text,
      mutation_id text,
      graph_revision integer,
      payload_sha256 text,
      compacted_at bigint,
      created_at bigint not null
    );
    create table if not exists global_asset_libraries (
      id text primary key,
      library jsonb not null,
      updated_at bigint not null
    );
    create table if not exists generation_jobs (
      id text primary key,
      owner_id text not null references app_users(id) on delete cascade,
      project_id text not null references projects(id) on delete cascade,
      status text not null check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
      updated_at bigint not null,
      execution_version bigint not null default 0,
      lease_token text,
      lease_expires_at bigint,
      payload jsonb not null
    );
    alter table generation_jobs add column if not exists execution_version bigint not null default 0;
    alter table generation_jobs add column if not exists lease_token text;
    alter table generation_jobs add column if not exists lease_expires_at bigint;
    create table if not exists agent_runs (
      id text primary key,
      owner_id text not null references app_users(id) on delete cascade,
      project_id text not null references projects(id) on delete cascade,
      status text not null check (status in ('queued', 'running', 'completed', 'partial', 'failed', 'cancelled')),
      updated_at bigint not null,
      payload jsonb not null
    );
    alter table agent_runs drop constraint if exists agent_runs_status_check;
    alter table agent_runs add constraint agent_runs_status_check
      check (status in ('awaiting_confirmation', 'queued', 'executing', 'running', 'completed', 'partial', 'failed', 'cancelled'));
    create table if not exists agent_turns (
      id text primary key,
      owner_id text not null references app_users(id) on delete cascade,
      project_id text not null references projects(id) on delete cascade,
      session_id text,
      idempotency_key text not null,
      status text not null check (status in ('running', 'completed', 'failed', 'cancelled')),
      updated_at bigint not null,
      payload jsonb not null,
      unique (owner_id, project_id, idempotency_key)
    );
    -- ADR 0004：Turn 需要 queued（已接受未开始）与 waiting_user（等待确认）持久态，
    -- 否则进程在首个工具前退出会留下永久 running 的孤儿；cancelling 是取消向 Run
    -- 传播完成前的中间态。已建库不会重跑 create table，因此必须显式改约束。
    alter table agent_turns drop constraint if exists agent_turns_status_check;
    alter table agent_turns add constraint agent_turns_status_check
      check (status in ('queued', 'running', 'waiting_user', 'cancelling', 'completed', 'failed', 'cancelled'));
    create table if not exists agent_turn_events (
      id text primary key,
      turn_id text not null references agent_turns(id) on delete cascade,
      owner_id text not null references app_users(id) on delete cascade,
      project_id text not null references projects(id) on delete cascade,
      sequence integer not null,
      execution_generation bigint,
      type text not null,
      created_at bigint not null,
      payload jsonb,
      unique (turn_id, sequence)
    );
    alter table agent_turn_events add column if not exists execution_generation bigint;
    create table if not exists agent_review_tasks (
      id text primary key,
      owner_id text not null references app_users(id) on delete cascade,
      project_id text not null references projects(id) on delete cascade,
      run_id text not null references agent_runs(id) on delete cascade,
      status text not null check (status in ('queued', 'running', 'completed', 'failed')),
      updated_at bigint not null,
      payload jsonb not null
    );
    alter table agent_review_tasks
      add column if not exists execution_version bigint not null default 0,
      add column if not exists lease_token text,
      add column if not exists lease_expires_at bigint;
    create index if not exists agent_review_tasks_pending_idx
      on agent_review_tasks (updated_at) where status in ('queued', 'running');
    create index if not exists agent_review_tasks_running_lease_idx
      on agent_review_tasks (lease_expires_at, id) where status = 'running';
    create table if not exists agent_reviews (
      id text primary key,
      owner_id text not null references app_users(id) on delete cascade,
      project_id text not null references projects(id) on delete cascade,
      run_id text not null references agent_runs(id) on delete cascade,
      locale text not null,
      status text not null check (status in ('pending', 'accepted', 'rejected', 'retry_requested')),
      updated_at bigint not null,
      payload jsonb not null,
      unique (project_id, run_id, locale)
    );
    create table if not exists agent_sessions (
      id text primary key,
      owner_id text not null references app_users(id) on delete cascade,
      project_id text not null references projects(id) on delete cascade,
      updated_at bigint not null,
      payload jsonb not null
    );
    create table if not exists agent_messages (
      id text primary key,
      owner_id text not null references app_users(id) on delete cascade,
      project_id text not null references projects(id) on delete cascade,
      session_id text not null references agent_sessions(id) on delete cascade,
      updated_at bigint not null,
      payload jsonb not null
    );
    create table if not exists agent_context_states (
      session_id text primary key references agent_sessions(id) on delete cascade,
      owner_id text not null references app_users(id) on delete cascade,
      project_id text not null references projects(id) on delete cascade,
      revision bigint not null default 0 check (revision >= 0),
      head_compaction_id text,
      head_compaction_sequence bigint,
      updated_at bigint not null,
      payload jsonb not null,
      constraint agent_context_states_head_shape check (
        (head_compaction_id is null and head_compaction_sequence is null)
        or (nullif(head_compaction_id, '') is not null
          and head_compaction_sequence > 0 and head_compaction_sequence <= revision)
      )
    );
    alter table agent_context_states add column if not exists head_compaction_sequence bigint;
    alter table agent_context_states drop constraint if exists agent_context_states_head_shape;
    alter table agent_context_states add constraint agent_context_states_head_shape check (
      (head_compaction_id is null and head_compaction_sequence is null)
      or (nullif(head_compaction_id, '') is not null
        and head_compaction_sequence > 0 and head_compaction_sequence <= revision)
    );
    create table if not exists agent_context_compactions (
      session_id text not null references agent_sessions(id) on delete cascade,
      sequence bigint not null check (sequence > 0),
      id text not null unique,
      owner_id text not null references app_users(id) on delete cascade,
      project_id text not null references projects(id) on delete cascade,
      idempotency_key text not null,
      request_hash text not null,
      compaction_id text,
      created_at bigint not null,
      payload jsonb not null,
      primary key (session_id, sequence),
      unique (session_id, idempotency_key)
    );
    create table if not exists agent_subagents (
      id text primary key,
      owner_id text not null references app_users(id) on delete cascade,
      project_id text not null references projects(id) on delete cascade,
      root_turn_id text not null,
      parent_session_id text,
      session_id text not null unique references agent_sessions(id) on delete restrict,
      status text not null check (status in ('active', 'cancelling', 'cancelled')),
      cancel_generation bigint not null default 0,
      last_enqueued_sequence integer not null default 0,
      settled_through_sequence integer not null default 0,
      dispatch_generation bigint not null default 0,
      dispatch_activation_sequence integer,
      dispatch_lease_token text,
      dispatch_lease_expires_at bigint,
      idempotency_key text not null,
      request_hash text not null,
      payload jsonb not null,
      created_at bigint not null,
      updated_at bigint not null,
      unique (owner_id, project_id, idempotency_key),
      check (cancel_generation >= 0),
      check (settled_through_sequence >= 0 and settled_through_sequence <= last_enqueued_sequence),
      check (
        (dispatch_activation_sequence is null and dispatch_lease_token is null and dispatch_lease_expires_at is null)
        or (dispatch_activation_sequence = settled_through_sequence + 1
          and dispatch_activation_sequence <= last_enqueued_sequence
          and nullif(dispatch_lease_token, '') is not null
          and dispatch_lease_expires_at is not null)
      )
    );
    create table if not exists agent_subagent_activations (
      subagent_id text not null references agent_subagents(id) on delete cascade,
      sequence integer not null check (sequence > 0),
      turn_id text not null unique references agent_turns(id) on delete restrict,
      input_message_id text not null references agent_messages(id) on delete restrict,
      result_message_id text not null,
      source_turn_id text not null,
      idempotency_key text not null,
      request_hash text not null,
      subagent_generation bigint not null check (subagent_generation >= 0),
      execution_generation bigint not null default 0 check (execution_generation >= 0),
      execution_cancel_generation bigint,
      execution_lease_token text,
      execution_lease_expires_at bigint,
      payload jsonb not null,
      created_at bigint not null,
      updated_at bigint not null,
      settled_at bigint,
      primary key (subagent_id, sequence),
      unique (subagent_id, idempotency_key),
      unique (subagent_id, result_message_id),
      check (
        (execution_lease_token is null and execution_cancel_generation is null
          and execution_lease_expires_at is null)
        or (execution_generation > 0 and execution_cancel_generation is not null
          and nullif(execution_lease_token, '') is not null
          and execution_lease_expires_at is not null)
      )
    );
    alter table agent_subagent_activations
      add column if not exists execution_generation bigint not null default 0,
      add column if not exists execution_cancel_generation bigint,
      add column if not exists execution_lease_token text,
      add column if not exists execution_lease_expires_at bigint;
    create table if not exists agent_session_read_receipts (
      user_id text not null references app_users(id) on delete cascade,
      project_id text not null references projects(id) on delete cascade,
      session_id text not null references agent_sessions(id) on delete cascade,
      message_id text not null,
      updated_at bigint not null,
      primary key (user_id, project_id, session_id)
    );
    create index if not exists agent_session_read_receipts_project_user_updated_idx
      on agent_session_read_receipts (project_id, user_id, updated_at desc);
    create table if not exists collaboration_activities (
      project_id text not null references projects(id) on delete cascade,
      id text not null,
      actor_id text not null references app_users(id) on delete cascade,
      occurred_at bigint not null,
      payload jsonb not null,
      primary key (project_id, id)
    );
    create index if not exists collaboration_activities_project_occurred_idx
      on collaboration_activities (project_id, occurred_at desc, id desc);
    create table if not exists collaboration_activity_receipts (
      user_id text not null references app_users(id) on delete cascade,
      project_id text not null references projects(id) on delete cascade,
      read_at bigint not null default 0,
      cleared_at bigint not null default 0,
      updated_at bigint not null,
      primary key (user_id, project_id)
    );
    insert into agent_session_read_receipts (user_id, project_id, session_id, message_id, updated_at)
    select owner_id, project_id, id, payload->>'readingAnchorMessageId',
      case when payload->>'readingAnchorUpdatedAt' ~ '^[0-9]+$'
        then (payload->>'readingAnchorUpdatedAt')::bigint else updated_at end
    from agent_sessions
    where nullif(payload->>'readingAnchorMessageId', '') is not null
    on conflict (user_id, project_id, session_id) do nothing;
    create table if not exists agent_memory_items (
      id text primary key,
      owner_id text not null references app_users(id) on delete cascade,
      project_id text not null references projects(id) on delete cascade,
      updated_at bigint not null,
      deleted_at bigint,
      payload jsonb not null
    );
    create table if not exists agent_artifacts (
      project_id text not null references projects(id) on delete cascade,
      id text not null,
      owner_id text not null references app_users(id) on delete cascade,
      kind text not null check (kind in ('image', 'video', 'text', 'workflow', 'asset_group', 'file')),
      source_kind text not null check (source_kind in ('agent_action', 'generation_output')),
      run_id text,
      job_id text,
      created_at bigint not null,
      updated_at bigint not null,
      payload jsonb not null,
      primary key (project_id, id)
    );
    create table if not exists agent_skills (
      id text primary key,
      owner_id text not null references app_users(id) on delete cascade,
      project_id text not null references projects(id) on delete cascade,
      status text not null check (status in ('active', 'archived')),
      updated_at bigint not null,
      payload jsonb not null
    );
    create table if not exists agent_action_receipts (
      id text primary key,
      owner_id text not null references app_users(id) on delete cascade,
      project_id text not null references projects(id) on delete cascade,
      created_at bigint not null,
      payload jsonb not null
    );
    create table if not exists media_objects (
      id text primary key,
      project_id text not null,
      owner_id text not null references app_users(id) on delete cascade,
      storage_key text not null unique,
      content_type text not null,
      byte_size bigint not null,
      created_at bigint not null
    );
    create table if not exists audit_events (
      id text primary key,
      actor_id text not null references app_users(id) on delete cascade,
      action text not null,
      project_id text,
      target_id text,
      detail jsonb not null default '{}'::jsonb,
      created_at bigint not null
    );
    create index if not exists projects_updated_at_idx on projects (updated_at desc);
    alter table app_users add column if not exists status text not null default 'active';
    create index if not exists app_users_status_idx on app_users (status, created_at);
    create index if not exists auth_identities_user_idx on auth_identities (user_id);
    alter table canvas_graph_updates alter column update_base64 drop not null;
    alter table canvas_graph_updates add column if not exists mutation_id text;
    alter table canvas_graph_updates add column if not exists graph_revision integer;
    alter table canvas_graph_updates add column if not exists payload_sha256 text;
    alter table canvas_graph_updates add column if not exists compacted_at bigint;
    with hashed as (
      select id, project_id,
        rtrim(translate(encode(pg_catalog.sha256(pg_catalog.convert_to(update_base64, 'UTF8')), 'base64'), '+/', '-_'), '=') as payload_hash
      from canvas_graph_updates
      where mutation_id is null and update_base64 is not null
    ), ranked as (
      select id, payload_hash,
        row_number() over (partition by project_id, payload_hash order by id) as duplicate_ordinal
      from hashed
    )
    update canvas_graph_updates as updates
    set mutation_id = case when ranked.duplicate_ordinal = 1
        then 'legacy:' || payload_hash else 'legacy-row:' || updates.id end,
      payload_sha256 = payload_hash
    from ranked
    where updates.id = ranked.id;
    update canvas_graph_updates
    set payload_sha256 = rtrim(translate(encode(pg_catalog.sha256(pg_catalog.convert_to(update_base64, 'UTF8')), 'base64'), '+/', '-_'), '=')
    where payload_sha256 is null and update_base64 is not null;
    update canvas_graph_updates set mutation_id = 'legacy-row:' || id where mutation_id is null;
    update canvas_graph_updates set payload_sha256 = 'legacy-row:' || id where payload_sha256 is null;
    alter table canvas_graph_updates alter column mutation_id set not null;
    alter table canvas_graph_updates alter column payload_sha256 set not null;
    create index if not exists canvas_graph_updates_project_idx on canvas_graph_updates (project_id, id);
    create unique index if not exists canvas_graph_updates_mutation_idx on canvas_graph_updates (project_id, mutation_id);
    create unique index if not exists canvas_graph_updates_revision_idx on canvas_graph_updates (project_id, graph_revision) where graph_revision is not null;
    create index if not exists jobs_status_updated_at_idx on generation_jobs (status, updated_at);
    create index if not exists generation_jobs_running_lease_idx
      on generation_jobs (lease_expires_at asc, id asc) where status = 'running';
    create index if not exists generation_jobs_agent_run_id_page_idx
      on generation_jobs (project_id, owner_id, (payload->'agentRun'->>'runId'), id asc)
      where nullif(payload->'agentRun'->>'runId', '') is not null;
    create index if not exists agent_runs_project_updated_idx on agent_runs (project_id, updated_at desc);
    create index if not exists agent_runs_queued_id_idx on agent_runs (id asc) where status = 'queued';
    create index if not exists agent_runs_turn_id_page_idx
      on agent_runs (project_id, owner_id, (payload->>'turnId'), id asc)
      where nullif(payload->>'turnId', '') is not null;
    create index if not exists agent_turns_project_updated_idx on agent_turns (project_id, updated_at desc);
    -- 孤儿回收是跨项目扫描：按状态过滤后取最旧的一批，没有这个索引会全表扫。
    create index if not exists agent_turns_status_updated_idx on agent_turns (status, updated_at asc);
    create index if not exists agent_turns_reclaimable_updated_id_idx
      on agent_turns (updated_at asc, id asc) where status in ('queued', 'running', 'cancelling');
    create index if not exists agent_turn_events_turn_sequence_idx on agent_turn_events (turn_id, sequence asc);
    create index if not exists agent_reviews_run_updated_idx on agent_reviews (project_id, run_id, updated_at desc);
    create index if not exists agent_sessions_project_updated_idx on agent_sessions (project_id, updated_at desc);
    create index if not exists agent_messages_session_updated_idx on agent_messages (session_id, updated_at asc);
    create index if not exists agent_messages_project_updated_idx on agent_messages (project_id, updated_at asc);
    create index if not exists agent_context_compactions_session_sequence_idx
      on agent_context_compactions (session_id, sequence asc) where compaction_id is not null;
    create index if not exists agent_subagents_project_updated_idx on agent_subagents (project_id, updated_at desc);
    create index if not exists agent_subagents_root_turn_idx
      on agent_subagents (project_id, root_turn_id, id collate "C" asc);
    create index if not exists agent_subagents_runnable_v2_idx
      on agent_subagents (updated_at asc, id collate "C" asc)
      where status <> 'cancelled' and settled_through_sequence < last_enqueued_sequence;
    create index if not exists agent_subagent_activations_sequence_idx
      on agent_subagent_activations (subagent_id, sequence asc);
    create index if not exists agent_subagent_activations_unsettled_idx
      on agent_subagent_activations (subagent_id, sequence asc) where settled_at is null;
    create index if not exists agent_memory_project_updated_idx on agent_memory_items (project_id, updated_at desc);
    create index if not exists agent_artifacts_project_created_idx on agent_artifacts (project_id, created_at desc, id);
    create index if not exists agent_artifacts_run_idx on agent_artifacts (project_id, run_id) where run_id is not null;
    create index if not exists agent_artifacts_job_idx on agent_artifacts (project_id, job_id) where job_id is not null;
    create index if not exists agent_skills_project_updated_idx on agent_skills (project_id, updated_at desc);
    create index if not exists agent_action_receipts_project_created_idx on agent_action_receipts (project_id, created_at desc);
    create index if not exists media_project_idx on media_objects (project_id);
    create index if not exists audit_project_created_idx on audit_events (project_id, created_at desc);
    create index if not exists audit_created_idx on audit_events (created_at desc);
    -- 对象先上传、再原子写入新项目文档时，项目行尚未存在。媒体可短暂成为
    -- 不可访问孤儿对象；读取授权仍通过 project_members join 约束，生命周期规则负责清理。
    alter table media_objects drop constraint if exists media_objects_project_id_fkey;
    insert into canvas_graphs (project_id, graph, revision, updated_at)
    select id,
      jsonb_build_object(
        'nodes', coalesce(document->'nodes', '[]'::jsonb),
        'edges', coalesce(document->'edges', '[]'::jsonb)
      ),
      1,
      updated_at
    from projects
    on conflict (project_id) do nothing;
    insert into agent_sessions (id, owner_id, project_id, updated_at, payload)
    select session->>'id', member.user_id, project.id,
      case when session->>'updatedAt' ~ '^[0-9]+$' then (session->>'updatedAt')::bigint else project.updated_at end,
      session - 'messages'
    from projects project
    join lateral (
      select user_id from project_members
      where project_id = project.id
      order by (role = 'owner') desc, added_at asc limit 1
    ) member on true
    cross join lateral jsonb_array_elements(coalesce(project.document->'agentSessions', '[]'::jsonb)) session
    where nullif(session->>'id', '') is not null
    on conflict (id) do nothing;
    insert into agent_messages (id, owner_id, project_id, session_id, updated_at, payload)
    select message->>'id', member.user_id, project.id, session->>'id',
      case when session->>'updatedAt' ~ '^[0-9]+$' then (session->>'updatedAt')::bigint else project.updated_at end,
      message
    from projects project
    join lateral (
      select user_id from project_members
      where project_id = project.id
      order by (role = 'owner') desc, added_at asc limit 1
    ) member on true
    cross join lateral jsonb_array_elements(coalesce(project.document->'agentSessions', '[]'::jsonb)) session
    cross join lateral jsonb_array_elements(coalesce(session->'messages', '[]'::jsonb)) message
    where nullif(session->>'id', '') is not null and nullif(message->>'id', '') is not null
    on conflict (id) do nothing;
    insert into agent_memory_items (id, owner_id, project_id, updated_at, payload)
    select memory->>'id', member.user_id, project.id,
      case when memory->>'updatedAt' ~ '^[0-9]+$' then (memory->>'updatedAt')::bigint else project.updated_at end,
      memory
    from projects project
    join lateral (
      select user_id from project_members
      where project_id = project.id
      order by (role = 'owner') desc, added_at asc limit 1
    ) member on true
    cross join lateral jsonb_array_elements(coalesce(project.document->'agentMemory', '[]'::jsonb)) memory
    where nullif(memory->>'id', '') is not null
    on conflict (id) do nothing;
    insert into agent_runs (id, owner_id, project_id, status, updated_at, payload)
    select run->>'id', member.user_id, project.id,
      case when run->>'status' in ('awaiting_confirmation', 'queued', 'executing', 'running', 'completed', 'partial', 'failed', 'cancelled')
        then run->>'status' else 'awaiting_confirmation' end,
      case when run->>'updatedAt' ~ '^[0-9]+$' then (run->>'updatedAt')::bigint else project.updated_at end,
      run || jsonb_build_object('ownerId', member.user_id, 'projectId', project.id)
    from projects project
    join lateral (
      select user_id from project_members
      where project_id = project.id
      order by (role = 'owner') desc, added_at asc limit 1
    ) member on true
    cross join lateral jsonb_array_elements(coalesce(project.document->'agentRuns', '[]'::jsonb)) run
    where nullif(run->>'id', '') is not null
    on conflict (id) do nothing;
    -- Agent 实体 ID 全局唯一，项目 ID 是授权与归属边界。历史快照若复用其他项目的
    -- 实体 ID，不能被 on conflict 静默吞掉；启动事务必须中止并要求修复冲突数据。
    do $$
    declare
      conflict_count bigint;
    begin
      with expected_sessions as (
        select project.id as project_id, session->>'id' as id
        from projects project
        cross join lateral jsonb_array_elements(coalesce(project.document->'agentSessions', '[]'::jsonb)) session
        where nullif(session->>'id', '') is not null
      ), expected_messages as (
        select project.id as project_id, session->>'id' as session_id, message->>'id' as id
        from projects project
        cross join lateral jsonb_array_elements(coalesce(project.document->'agentSessions', '[]'::jsonb)) session
        cross join lateral jsonb_array_elements(coalesce(session->'messages', '[]'::jsonb)) message
        where nullif(session->>'id', '') is not null and nullif(message->>'id', '') is not null
      ), expected_memory as (
        select project.id as project_id, memory->>'id' as id
        from projects project
        cross join lateral jsonb_array_elements(coalesce(project.document->'agentMemory', '[]'::jsonb)) memory
        where nullif(memory->>'id', '') is not null
      ), expected_runs as (
        select project.id as project_id, run->>'id' as id
        from projects project
        cross join lateral jsonb_array_elements(coalesce(project.document->'agentRuns', '[]'::jsonb)) run
        where nullif(run->>'id', '') is not null
      )
      select count(*) into conflict_count
      from (
        select expected.id
        from expected_sessions expected
        left join agent_sessions indexed
          on indexed.id = expected.id and indexed.project_id = expected.project_id
        where indexed.id is null
        union all
        select expected.id
        from expected_messages expected
        left join agent_messages indexed
          on indexed.id = expected.id
          and indexed.project_id = expected.project_id
          and indexed.session_id = expected.session_id
        where indexed.id is null
        union all
        select expected.id
        from expected_memory expected
        left join agent_memory_items indexed
          on indexed.id = expected.id and indexed.project_id = expected.project_id
        where indexed.id is null
        union all
        select expected.id
        from expected_runs expected
        left join agent_runs indexed
          on indexed.id = expected.id and indexed.project_id = expected.project_id
        where indexed.id is null
      ) conflicts;

      if conflict_count > 0 then
        raise exception 'Agent entity migration reconciliation failed: % entities have conflicting project or session ownership', conflict_count;
      end if;
    end $$;
    insert into agent_artifacts (project_id, id, owner_id, kind, source_kind, run_id, job_id, created_at, updated_at, payload)
    select message.project_id, artifact->>'id', message.owner_id, artifact->>'kind', 'agent_action',
      nullif(artifact->'provenance'->>'runId', ''), null,
      case when message.payload->>'createdAt' ~ '^[0-9]+$' then (message.payload->>'createdAt')::bigint else message.updated_at end,
      message.updated_at,
      artifact || jsonb_build_object(
        'origin', jsonb_strip_nulls(jsonb_build_object(
          'type', 'agent_action', 'sessionId', message.session_id,
          'messageId', message.id, 'actionId', action->>'id'
        )),
        'createdAt', case when message.payload->>'createdAt' ~ '^[0-9]+$' then (message.payload->>'createdAt')::bigint else message.updated_at end,
        'updatedAt', message.updated_at
      )
    from agent_messages message
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
      kind = excluded.kind, source_kind = excluded.source_kind, run_id = excluded.run_id,
      updated_at = excluded.updated_at, payload = excluded.payload
    where agent_artifacts.updated_at <= excluded.updated_at;
    insert into agent_artifacts (project_id, id, owner_id, kind, source_kind, run_id, job_id, created_at, updated_at, payload)
    select receipt.project_id, artifact->>'id', receipt.owner_id, artifact->>'kind', 'agent_action',
      nullif(artifact->'provenance'->>'runId', ''), null, receipt.created_at, receipt.created_at,
      artifact || jsonb_build_object(
        'origin', jsonb_strip_nulls(jsonb_build_object(
          'type', 'agent_action',
          'actionId', coalesce(
            receipt.payload->>'toolCallId',
            receipt.payload->'result'->'toolCall'->>'id',
            receipt.payload->'toolCall'->>'id'
          )
        )),
        'createdAt', receipt.created_at, 'updatedAt', receipt.created_at
      )
    from agent_action_receipts receipt
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
      kind = excluded.kind, source_kind = excluded.source_kind, run_id = excluded.run_id,
      updated_at = excluded.updated_at, payload = excluded.payload
    where agent_artifacts.updated_at <= excluded.updated_at;
    insert into agent_artifacts (project_id, id, owner_id, kind, source_kind, run_id, job_id, created_at, updated_at, payload)
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
          'branchId', job.payload->'agentRun'->>'branchId', 'groupId', job.payload->'agentRun'->>'runId',
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
        'origin', jsonb_build_object('type', 'generation_output', 'jobId', job.id, 'outputId', output->>'id'),
        'createdAt', job.updated_at, 'updatedAt', job.updated_at
      )
    from generation_jobs job
    join projects project on project.id = job.project_id
    cross join lateral jsonb_array_elements(case
      when jsonb_typeof(job.payload->'outputs') = 'array' then job.payload->'outputs'
      else '[]'::jsonb end) output
    where nullif(output->>'id', '') is not null and nullif(output->>'image', '') is not null
    on conflict (project_id, id) do update set
      kind = excluded.kind, source_kind = excluded.source_kind, run_id = excluded.run_id,
      job_id = excluded.job_id, updated_at = excluded.updated_at, payload = excluded.payload
    where agent_artifacts.updated_at <= excluded.updated_at;
    -- 三类历史来源完成回填后立即对账；缺失或损坏会让同一启动事务回滚。
    do $$
    declare
      missing_count bigint;
      malformed_count bigint;
    begin
      with expected as (
        select message.project_id, artifact->>'id' as id
        from agent_messages message
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
        from agent_action_receipts receipt
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
        from generation_jobs job
        cross join lateral jsonb_array_elements(case
          when jsonb_typeof(job.payload->'outputs') = 'array' then job.payload->'outputs'
          else '[]'::jsonb end) output
        where nullif(output->>'id', '') is not null and nullif(output->>'image', '') is not null
      )
      select count(*) into missing_count
      from expected
      left join agent_artifacts indexed
        on indexed.project_id = expected.project_id and indexed.id = expected.id
      where indexed.id is null;

      select count(*) into malformed_count
      from agent_artifacts
      where payload->>'id' is distinct from id
        or payload->>'kind' is distinct from kind
        or payload->'origin'->>'type' is distinct from source_kind;

      if missing_count > 0 then
        raise exception 'Artifact Index migration reconciliation failed: % expected artifacts are missing', missing_count;
      end if;
      if malformed_count > 0 then
        raise exception 'Artifact Index migration reconciliation failed: % indexed artifacts have malformed payloads', malformed_count;
      end if;
    end $$;
    `)
  })
}

/**
 * 本地访问令牌模式才需要预置 token。生产迁移期由 Supabase Auth 校验身份，
 * 因而不能要求一个额外的共享启动令牌。
 */
export async function ensureBootstrapAccessToken(sql, { bootstrapAccessToken, bootstrapEmail, hashAccessToken, now }) {
  if (!bootstrapAccessToken) return
  const bootstrapHash = hashAccessToken(bootstrapAccessToken)
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(72695838)`
    const [token] = await tx`select id from access_tokens where token_hash = ${bootstrapHash} and revoked_at is null`
    if (token) return
    let [owner] = await tx`select id from app_users where role = 'owner' order by created_at asc limit 1`
    if (!owner) {
      owner = { id: `usr_${randomUUID()}` }
      await tx`insert into app_users (id, email, name, role, created_at) values (${owner.id}, ${bootstrapEmail}, 'Botanic Owner', 'owner', ${now()})`
    }
    await tx`insert into access_tokens (id, user_id, token_hash, created_at) values (${`token_${randomUUID()}`}, ${owner.id}, ${bootstrapHash}, ${now()})`
  })
}
