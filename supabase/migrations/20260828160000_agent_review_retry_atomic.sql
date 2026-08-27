begin;

-- JSONB 会丢失数字原始词法；这里按 ECMAScript NumberToString 的两个指数阈值
-- 恢复 JSON.stringify 使用的表示。Run 领域只接受 JS finite number，因此先还原
-- double precision，再在 [1e-6, 1e21) 使用固定十进制，其他范围规范化指数前导零。
create or replace function public.botanic_js_number_text(p_value jsonb)
returns text
language plpgsql
immutable
strict
security invoker
set search_path = ''
as $$
declare
  numeric_value numeric;
  absolute_value numeric;
  fixed_value text;
  exponent_value text;
begin
  if jsonb_typeof(p_value) <> 'number' then return null; end if;
  numeric_value := (p_value #>> '{}')::numeric;
  if numeric_value = 0 then return '0'; end if;
  absolute_value := abs(numeric_value);
  if absolute_value >= 0.000001 and absolute_value < 1000000000000000000000 then
    fixed_value := numeric_value::text;
    if position('.' in fixed_value) > 0 then
      fixed_value := rtrim(rtrim(fixed_value, '0'), '.');
    end if;
    return fixed_value;
  end if;
  exponent_value := (numeric_value::double precision)::text;
  exponent_value := regexp_replace(exponent_value, 'e([+-]?)0+([0-9]+)$', 'e\1\2');
  return exponent_value;
exception when others then return null;
end;
$$;

-- 与 server/canonicalHash.mjs 相同：对象键排序、数组保序、无额外空白。
-- Review retry 的两个 immutable request binding 都必须由数据库从请求主体重算，
-- 不能只相信 service_role 传来的自述 hash。
create or replace function public.botanic_canonical_json_text(p_value jsonb)
returns text
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  result text;
begin
  if p_value is null then return 'null'; end if;
  case jsonb_typeof(p_value)
    when 'object' then
      select '{' || coalesce(string_agg(
        to_jsonb(entry.key)::text || ':' || public.botanic_canonical_json_text(entry.value),
        ',' order by entry.key collate "C"
      ), '') || '}' into result
      from jsonb_each(p_value) entry;
      return result;
    when 'array' then
      select '[' || coalesce(string_agg(
        public.botanic_canonical_json_text(entry.value), ',' order by entry.ordinal
      ), '') || ']' into result
      from jsonb_array_elements(p_value) with ordinality entry(value, ordinal);
      return result;
    when 'number' then return public.botanic_js_number_text(p_value);
    else return p_value::text;
  end case;
end;
$$;

create or replace function public.botanic_sha256_base64url(p_value text)
returns text
language sql
immutable
strict
security invoker
set search_path = ''
as $$
  select rtrim(
    translate(
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_value, 'UTF8')), 'base64'),
      '+/', '-_'
    ), '='
  )
$$;

create or replace function public.botanic_canonical_json_hash(p_value jsonb)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select public.botanic_sha256_base64url(public.botanic_canonical_json_text(p_value))
$$;

-- 部署时用 server/canonicalHash.mjs 生成的固定向量自检。这样数据库排序规则或
-- NumberToString 表示一旦与 Node 漂移，迁移会在启用付费 retry 前原子失败。
do $botanic_retry_hash_contract$
begin
  if public.botanic_canonical_json_hash(
    '{"z":1e-7,"a":{"b":1e+21,"c":0.000001,"d":1.0000000000000002}}'::jsonb
  ) is distinct from 'SJehkqRQqU8R4gPzIXi6Ll4ps7wlhVGnlJhGncNCFdo' then
    raise exception 'canonical JSON number/hash contract differs from server';
  end if;
  if public.botanic_canonical_json_hash(
    '{"Z":1,"a":2,"_":3,"A":4}'::jsonb
  ) is distinct from '-gr8vMCWEzhTn5TGLoPEUDhTSGrMzTwpW0knX_4q5Dw' then
    raise exception 'canonical JSON key-order contract differs from server';
  end if;
end;
$botanic_retry_hash_contract$;

create or replace function public.botanic_same_request_binding(p_left jsonb, p_right jsonb)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $$
begin
  return jsonb_typeof(p_left) = 'object'
    and jsonb_typeof(p_right) = 'object'
    and p_left->'version' = '1'::jsonb
    and p_right->'version' = '1'::jsonb
    and p_left->>'scope' = p_right->>'scope'
    and p_left->>'projectId' = p_right->>'projectId'
    and nullif(p_left->>'requestHash', '') is not null
    and p_left->>'requestHash' = p_right->>'requestHash';
exception when others then return false;
end;
$$;

create or replace function public.botanic_valid_request_binding(
  p_binding jsonb,
  p_scope text,
  p_project_id text,
  p_request jsonb
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $$
begin
  return jsonb_typeof(p_binding) = 'object'
    and p_binding->'version' = '1'::jsonb
    and p_binding->>'scope' = p_scope
    and p_binding->>'projectId' = p_project_id
    and p_binding->>'requestHash' = public.botanic_canonical_json_hash(p_request);
exception when others then return false;
end;
$$;

create or replace function public.botanic_agent_review_retry_run_id(
  p_task_id text,
  p_review_result_id text
)
returns text
language sql
immutable
strict
security invoker
set search_path = ''
as $$
  select 'agent_run_review_retry_'
    || left(public.botanic_sha256_base64url(p_task_id || ':' || p_review_result_id), 32)
$$;

-- agentRunSubmissionBinding 只覆盖 Run 的 immutable creation input。分支执行态
-- status/attempt/jobIds/activeJobId 不得进入 hash，已有 Run 已推进时仍能安全重放。
create or replace function public.botanic_agent_review_run_submission_request(p_run jsonb)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  branch jsonb;
  branch_identity jsonb;
  branches jsonb := '[]'::jsonb;
  request_payload jsonb;
begin
  if jsonb_typeof(p_run) <> 'object' or jsonb_typeof(p_run->'branches') <> 'array' then
    return null;
  end if;
  for branch in select value from jsonb_array_elements(p_run->'branches') loop
    branch_identity := jsonb_build_object('id', branch->'id', 'label', branch->'label');
    if nullif(branch->>'assetId', '') is not null then
      branch_identity := branch_identity || jsonb_build_object('assetId', branch->'assetId');
    end if;
    if branch ? 'variation' and jsonb_typeof(branch->'variation') <> 'null' then
      branch_identity := branch_identity || jsonb_build_object('variation', branch->'variation');
    end if;
    if branch ? 'item' then
      branch_identity := branch_identity || jsonb_build_object('item', branch->'item');
    end if;
    branches := branches || jsonb_build_array(branch_identity);
  end loop;
  request_payload := jsonb_build_object(
    'projectId', p_run->'projectId', 'plan', p_run->'plan', 'branches', branches
  );
  if nullif(p_run->>'turnId', '') is not null then
    request_payload := request_payload || jsonb_build_object('turnId', p_run->'turnId');
  end if;
  if p_run ? 'lineage' and jsonb_typeof(p_run->'lineage') = 'object' then
    request_payload := request_payload || jsonb_build_object('lineage', p_run->'lineage');
  end if;
  return request_payload;
exception when others then return null;
end;
$$;

create or replace function public.botanic_agent_review_run_submission_hash(p_run jsonb)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select public.botanic_canonical_json_hash(
    public.botanic_agent_review_run_submission_request(p_run)
  )
$$;

-- 旧四参数 RPC 会在 Decision 已写入后才让新服务发现 retry Run 缺失。升级为显式
-- contract version：新服务遇到旧 schema 会在任何写入前失败关闭；旧服务遇到新 schema
-- 也不会退回非原子的人审写入。
drop function if exists public.botanic_commit_agent_review_human_decisions(uuid, text, text, jsonb);

create or replace function public.botanic_commit_agent_review_human_decisions(
  p_actor_id uuid,
  p_task_id text,
  p_project_id text,
  p_command jsonb,
  p_contract_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing public.agent_review_tasks%rowtype;
  existing_run public.agent_runs%rowtype;
  stored_payload jsonb;
  authoritative_payload jsonb;
  decisions_payload jsonb;
  results_payload jsonb;
  accepted_decisions jsonb := '[]'::jsonb;
  retry_runs jsonb := '[]'::jsonb;
  runs_to_insert jsonb := '[]'::jsonb;
  requested_decision jsonb;
  existing_decision jsonb;
  projected_decision jsonb;
  candidate jsonb;
  run_payload jsonb;
  run_to_return jsonb;
  existing_run_payload jsonb;
  branch_payload jsonb;
  result_payload jsonb;
  previous_materialization jsonb;
  materialization jsonb;
  first_retry_decision jsonb;
  expected_retry_request jsonb;
  observed_at timestamptz;
  observed_ms bigint;
  existing_updated_ms bigint;
  decision_version bigint;
  last_decided_ms bigint;
  requested_ids text[] := array[]::text[];
  requested_artifacts text[] := array[]::text[];
  candidate_run_ids text[] := array[]::text[];
  changed boolean := false;
  has_retry boolean := false;
  expected_candidate_status text;
  required_permission text;
  member_role text;
  locked_run_id text;
  run_id text;
  review_result_id text;
  artifact_id text;
  source_run_id text;
  source_branch_id text;
  source_job_id text;
  source_output_id text;
  existing_run_found boolean;
begin
  if p_contract_version is distinct from 2 then
    raise exception 'agent review retry atomic contract version required' using errcode = '22023';
  end if;
  if p_actor_id is null or nullif(btrim(p_task_id), '') is null
    or nullif(btrim(p_project_id), '') is null
    or jsonb_typeof(p_command) is distinct from 'object'
    or p_command->>'id' is distinct from p_task_id
    or p_command->>'projectId' is distinct from p_project_id
    or jsonb_typeof(p_command->'decisions') is distinct from 'array'
    or jsonb_array_length(p_command->'decisions') not between 1 and 60
    or jsonb_typeof(coalesce(p_command->'retryRunCandidates', '[]'::jsonb)) is distinct from 'array'
    or jsonb_array_length(coalesce(p_command->'retryRunCandidates', '[]'::jsonb)) > 60 then
    raise exception 'invalid agent review human decision command' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_task_id, 5));
  select * into existing from public.agent_review_tasks where id = p_task_id for update;
  if not found then
    return jsonb_build_object('kind', 'missing', 'changed', false, 'retryRuns', '[]'::jsonb);
  end if;
  stored_payload := existing.payload || jsonb_build_object(
    'id', existing.id, 'ownerId', existing.owner_id::text,
    'projectId', existing.project_id, 'runId', existing.run_id,
    'status', existing.status, 'executionVersion', existing.execution_version
  );
  authoritative_payload := stored_payload;
  if existing.project_id <> p_project_id then
    return jsonb_build_object(
      'kind', 'conflict', 'changed', false, 'task', stored_payload, 'retryRuns', '[]'::jsonb
    );
  end if;

  select exists (
    select 1 from jsonb_array_elements(p_command->'decisions') decision
    where decision->>'decision' = 'retry_requested'
  ) into has_retry;
  required_permission := case when has_retry then 'create-generation' else 'edit' end;
  select role::text into member_role from public.project_members
  where project_id = p_project_id and user_id = p_actor_id
    and role::text in ('owner', 'editor')
  for share;
  if member_role is null then
    if required_permission = 'create-generation' then
      raise exception 'agent review retry generation forbidden' using errcode = '42501';
    end if;
    raise exception 'agent review decision forbidden' using errcode = '42501';
  end if;

  if existing.status <> 'completed' then
    return jsonb_build_object(
      'kind', 'not_ready', 'changed', false, 'task', stored_payload, 'retryRuns', '[]'::jsonb
    );
  end if;
  if jsonb_typeof(stored_payload->'results') is distinct from 'array'
    or jsonb_typeof(coalesce(stored_payload->'decisions', '[]'::jsonb)) is distinct from 'array' then
    return jsonb_build_object(
      'kind', 'conflict', 'changed', false, 'task', stored_payload, 'retryRuns', '[]'::jsonb
    );
  end if;
  results_payload := stored_payload->'results';
  decisions_payload := coalesce(stored_payload->'decisions', '[]'::jsonb);

  -- 同 ID 的历史 Decision 允许逐字相同的旧重复项；身份不一致必须失败关闭。
  if exists (
    select 1
    from jsonb_array_elements(decisions_payload) with ordinality left_rows(decision, ordinal)
    join jsonb_array_elements(decisions_payload) with ordinality right_rows(decision, ordinal)
      on left_rows.ordinal < right_rows.ordinal
      and left_rows.decision->>'id' = right_rows.decision->>'id'
    where nullif(btrim(left_rows.decision->>'id'), '') is not null
      and ((left_rows.decision - 'decidedAt') - 'decisionRevision')
        is distinct from ((right_rows.decision - 'decidedAt') - 'decisionRevision')
  ) then
    return jsonb_build_object(
      'kind', 'conflict', 'changed', false, 'task', stored_payload, 'retryRuns', '[]'::jsonb
    );
  end if;

  observed_at := clock_timestamp();
  observed_ms := floor(extract(epoch from observed_at) * 1000)::bigint;
  select greatest(
    case when stored_payload->>'decisionVersion' ~ '^[0-9]+$'
      then (stored_payload->>'decisionVersion')::bigint else 0 end,
    jsonb_array_length(decisions_payload),
    coalesce(max(case when decision->>'decisionRevision' ~ '^[0-9]+$'
      then (decision->>'decisionRevision')::bigint else 0 end), 0)
  ) into decision_version from jsonb_array_elements(decisions_payload) decision;
  select coalesce(max(case when decision->>'decidedAt' ~ '^[0-9]+$'
    then (decision->>'decidedAt')::bigint else 0 end), 0)
  into last_decided_ms from jsonb_array_elements(decisions_payload) decision;

  for requested_decision in select value from jsonb_array_elements(p_command->'decisions') loop
    expected_candidate_status := case requested_decision->>'decision'
      when 'accepted' then 'accepted'
      when 'rejected' then 'rejected'
      when 'retry_requested' then 'pending_review'
      else null
    end;
    if jsonb_typeof(requested_decision) is distinct from 'object'
      or nullif(btrim(requested_decision->>'id'), '') is null
      or requested_decision->>'taskId' is distinct from existing.id
      or requested_decision->>'projectId' is distinct from existing.project_id
      or nullif(btrim(requested_decision->>'artifactId'), '') is null
      or requested_decision->>'decidedBy' is distinct from p_actor_id::text
      or nullif(btrim(requested_decision->>'idempotencyKey'), '') is null
      or expected_candidate_status is null
      or requested_decision->>'candidateStatus' is distinct from expected_candidate_status
      or jsonb_typeof(requested_decision->'decidedAt') is distinct from 'number'
      or (requested_decision->>'decidedAt')::numeric <= 0
      or (requested_decision ? 'note' and (
        jsonb_typeof(requested_decision->'note') is distinct from 'string'
        or length(requested_decision->>'note') > 500
      ))
      or not exists (
        select 1 from jsonb_array_elements_text(case
          when jsonb_typeof(stored_payload->'coverage'->'artifactIds') = 'array'
            then stored_payload->'coverage'->'artifactIds' else '[]'::jsonb end
        ) covered(covered_artifact_id)
        where covered.covered_artifact_id = requested_decision->>'artifactId'
      )
      or not public.botanic_agent_review_has_result(
        stored_payload, existing.id, requested_decision->>'artifactId'
      ) then
      return jsonb_build_object(
        'kind', 'conflict', 'changed', false, 'task', stored_payload, 'retryRuns', '[]'::jsonb
      );
    end if;
    if requested_decision->>'id' = any(requested_ids)
      or requested_decision->>'artifactId' = any(requested_artifacts) then
      return jsonb_build_object(
        'kind', 'conflict', 'changed', false, 'task', stored_payload, 'retryRuns', '[]'::jsonb
      );
    end if;
    requested_ids := array_append(requested_ids, requested_decision->>'id');
    requested_artifacts := array_append(requested_artifacts, requested_decision->>'artifactId');

    existing_decision := null;
    select decision into existing_decision from jsonb_array_elements(decisions_payload) decision
    where decision->>'id' = requested_decision->>'id' limit 1;
    if existing_decision is not null then
      if ((existing_decision - 'decidedAt') - 'decisionRevision')
        is distinct from ((requested_decision - 'decidedAt') - 'decisionRevision') then
        return jsonb_build_object(
          'kind', 'conflict', 'changed', false, 'task', stored_payload, 'retryRuns', '[]'::jsonb
        );
      end if;
      accepted_decisions := accepted_decisions || jsonb_build_array(existing_decision);
    else
      changed := true;
      decision_version := decision_version + 1;
      last_decided_ms := greatest(last_decided_ms + 1, observed_ms);
      requested_decision := ((requested_decision - 'decidedAt') - 'decisionRevision')
        || jsonb_build_object('decisionRevision', decision_version, 'decidedAt', last_decided_ms);
      decisions_payload := decisions_payload || jsonb_build_array(requested_decision);
      accepted_decisions := accepted_decisions || jsonb_build_array(requested_decision);
    end if;
  end loop;

  if (select count(*) from jsonb_array_elements(p_command->'decisions') decision
      where decision->>'decision' = 'retry_requested')
    <> jsonb_array_length(coalesce(p_command->'retryRunCandidates', '[]'::jsonb)) then
    return jsonb_build_object(
      'kind', 'conflict', 'changed', false, 'task', stored_payload, 'retryRuns', '[]'::jsonb
    );
  end if;

  -- 历史 retry 已落 Decision 却没有 materialization 时，执行结果未知，绝不补建付费 Run。
  if has_retry and exists (
    select 1
    from jsonb_array_elements(p_command->'decisions') requested
    join jsonb_array_elements(stored_payload->'results') result
      on result->>'artifactId' = requested->>'artifactId'
    where requested->>'decision' = 'retry_requested'
      and jsonb_typeof(result->'retryMaterialization') is distinct from 'object'
      and exists (
        select 1 from jsonb_array_elements(coalesce(stored_payload->'decisions', '[]'::jsonb)) prior
        where prior->>'artifactId' = requested->>'artifactId'
          and prior->>'decision' = 'retry_requested'
      )
  ) then
    return jsonb_build_object(
      'kind', 'legacy_unknown', 'changed', false, 'task', stored_payload, 'retryRuns', '[]'::jsonb
    );
  end if;

  if exists (
    select 1 from jsonb_array_elements(coalesce(p_command->'retryRunCandidates', '[]'::jsonb)) candidate
    where jsonb_typeof(candidate) <> 'object' or jsonb_typeof(candidate->'run') <> 'object'
      or nullif(btrim(candidate->'run'->>'id'), '') is null
  ) or exists (
    select 1 from jsonb_array_elements(coalesce(p_command->'retryRunCandidates', '[]'::jsonb)) candidate
    group by candidate->'run'->>'id' having count(*) > 1
  ) or exists (
    select 1 from jsonb_array_elements(coalesce(p_command->'retryRunCandidates', '[]'::jsonb)) candidate
    group by candidate->>'reviewResultId'
    having nullif(btrim(candidate->>'reviewResultId'), '') is null or count(*) > 1
  ) then
    return jsonb_build_object(
      'kind', 'conflict', 'changed', false, 'task', stored_payload, 'retryRuns', '[]'::jsonb
    );
  end if;

  for locked_run_id in
    select rows.run_id from (
      select candidate->'run'->>'id' as run_id
      from jsonb_array_elements(coalesce(p_command->'retryRunCandidates', '[]'::jsonb)) candidate
    ) rows order by rows.run_id collate "C"
  loop
    perform pg_advisory_xact_lock(hashtextextended(locked_run_id, 0));
    candidate_run_ids := array_append(candidate_run_ids, locked_run_id);
  end loop;
  perform 1 from public.agent_runs
  where id = any(candidate_run_ids)
  order by id collate "C"
  for update;

  -- 先在局部变量中投影 Decision；候选校验失败时仍然零写。
  for projected_decision in select value from jsonb_array_elements(accepted_decisions) loop
    select coalesce(jsonb_agg(
      case when result->>'artifactId' = projected_decision->>'artifactId' then
        result || jsonb_build_object(
          'candidateStatus', projected_decision->>'candidateStatus',
          'humanDecisionId', projected_decision->>'id', 'updatedAt', projected_decision->'decidedAt'
        )
      else result end order by ordinal
    ), '[]'::jsonb) into results_payload
    from jsonb_array_elements(results_payload) with ordinality rows(result, ordinal);
  end loop;

  for candidate in
    select value from jsonb_array_elements(coalesce(p_command->'retryRunCandidates', '[]'::jsonb))
  loop
    review_result_id := nullif(btrim(candidate->>'reviewResultId'), '');
    artifact_id := nullif(btrim(candidate->>'artifactId'), '');
    source_run_id := nullif(btrim(candidate->>'sourceRunId'), '');
    source_branch_id := nullif(btrim(candidate->>'sourceBranchId'), '');
    source_job_id := nullif(btrim(candidate->>'sourceJobId'), '');
    source_output_id := nullif(btrim(candidate->>'sourceOutputId'), '');
    run_payload := candidate->'run';
    run_id := nullif(btrim(run_payload->>'id'), '');

    result_payload := null;
    select result into result_payload from jsonb_array_elements(results_payload) result
    where result->>'id' = review_result_id and result->>'artifactId' = artifact_id
      and result->>'taskId' = existing.id and result->>'projectId' = existing.project_id
    limit 1;
    if result_payload is null
      or (select count(*) from jsonb_array_elements(results_payload) result
        where result->>'id' = review_result_id and result->>'artifactId' = artifact_id
          and result->>'taskId' = existing.id and result->>'projectId' = existing.project_id) <> 1
      or not exists (
        select 1 from jsonb_array_elements(p_command->'decisions') decision
        where decision->>'artifactId' = artifact_id and decision->>'decision' = 'retry_requested'
      )
      or source_run_id is distinct from existing.run_id
      or source_branch_id is null or source_job_id is null or source_output_id is null
      or artifact_id is distinct from ('generation:' || source_job_id || ':' || source_output_id)
      or run_id is distinct from public.botanic_agent_review_retry_run_id(existing.id, review_result_id)
      or run_payload->>'projectId' is distinct from existing.project_id
      or run_payload->>'ownerId' is distinct from p_actor_id::text
      or run_payload->>'status' is distinct from 'queued'
      or jsonb_typeof(run_payload->'plan'->'output') is distinct from 'object'
      or run_payload->'plan'->'output'->>'mode' is distinct from 'single'
      or run_payload->'plan'->'output'->'count' is distinct from '1'::jsonb
      or run_payload->'plan'->'output'->'candidatesPerItem' is distinct from '1'::jsonb
      or jsonb_typeof(result_payload->'createdAt') is distinct from 'number'
      or run_payload->'createdAt' is distinct from result_payload->'createdAt'
      or run_payload->'updatedAt' is distinct from result_payload->'createdAt'
      or run_payload->'lineage'->'createdAt' is distinct from result_payload->'createdAt'
      or run_payload ? 'execution' or run_payload ? 'executionVersion'
      or run_payload ? 'jobId' or run_payload ? 'jobIds'
      or run_payload->'completedBranchCount' is distinct from '0'::jsonb
      or run_payload->'failedBranchCount' is distinct from '0'::jsonb
      or run_payload->'lineage'->>'relation' is distinct from 'review_retry'
      or run_payload->'lineage'->>'parentRunId' is distinct from existing.run_id
      or run_payload->'lineage'->>'parentBranchId' is distinct from source_branch_id
      or run_payload->'lineage'->>'reviewTaskId' is distinct from existing.id
      or run_payload->'lineage'->>'sourceArtifactId' is distinct from artifact_id
      or jsonb_typeof(run_payload->'branches') is distinct from 'array'
      or jsonb_array_length(run_payload->'branches') <> 1 then
      return jsonb_build_object(
        'kind', 'conflict', 'changed', false, 'task', stored_payload, 'retryRuns', '[]'::jsonb
      );
    end if;

    branch_payload := run_payload->'branches'->0;
    expected_retry_request := jsonb_build_object(
      'taskId', existing.id, 'reviewResultId', review_result_id, 'artifactId', artifact_id,
      'sourceRunId', source_run_id, 'sourceBranchId', source_branch_id,
      'sourceJobId', source_job_id, 'sourceOutputId', source_output_id
    );
    if not public.botanic_valid_request_binding(
        candidate->'idempotencyBinding', 'agent-review.retry', existing.project_id,
        expected_retry_request
      )
      or not public.botanic_valid_request_binding(
        run_payload->'idempotencyBinding', 'agent-run.create', existing.project_id,
        public.botanic_agent_review_run_submission_request(run_payload)
      )
      or branch_payload->>'status' is distinct from 'queued'
      or branch_payload->'attempt' is distinct from '0'::jsonb
      or jsonb_typeof(branch_payload->'jobIds') is distinct from 'array'
      or jsonb_array_length(branch_payload->'jobIds') <> 0
      or nullif(branch_payload->>'activeJobId', '') is not null
      or branch_payload ? 'retryClaim'
      or branch_payload->'outputCount' is distinct from '0'::jsonb
      or branch_payload ? 'error'
      or branch_payload->'updatedAt' is distinct from result_payload->'createdAt' then
      return jsonb_build_object(
        'kind', 'conflict', 'changed', false, 'task', stored_payload, 'retryRuns', '[]'::jsonb
      );
    end if;

    select * into existing_run from public.agent_runs where id = run_id;
    existing_run_found := found;
    previous_materialization := result_payload->'retryMaterialization';
    if existing_run_found then
      existing_run_payload := existing_run.payload || jsonb_build_object(
        'id', existing_run.id, 'ownerId', existing_run.owner_id::text,
        'projectId', existing_run.project_id, 'status', existing_run.status
      );
      if existing_run.project_id <> existing.project_id
        or nullif(existing_run.owner_id::text, '') is null
        or not public.botanic_same_request_binding(
          existing_run.payload->'idempotencyBinding', run_payload->'idempotencyBinding'
        )
        or existing_run.payload->'idempotencyBinding'->>'requestHash'
          is distinct from public.botanic_agent_review_run_submission_hash(existing_run_payload)
        or not public.botanic_valid_request_binding(
          existing_run.payload->'idempotencyBinding', 'agent-run.create', existing.project_id,
          public.botanic_agent_review_run_submission_request(existing_run_payload)
        )
        or existing_run.payload->'lineage'->>'relation'
          is distinct from run_payload->'lineage'->>'relation'
        or existing_run.payload->'lineage'->>'parentRunId'
          is distinct from run_payload->'lineage'->>'parentRunId'
        or existing_run.payload->'lineage'->>'parentBranchId'
          is distinct from run_payload->'lineage'->>'parentBranchId'
        or existing_run.payload->'lineage'->>'reviewTaskId'
          is distinct from run_payload->'lineage'->>'reviewTaskId'
        or existing_run.payload->'lineage'->>'sourceArtifactId'
          is distinct from run_payload->'lineage'->>'sourceArtifactId' then
        return jsonb_build_object(
          'kind', 'conflict', 'changed', false, 'task', stored_payload, 'retryRuns', '[]'::jsonb
        );
      end if;
      run_to_return := existing_run_payload;
    else
      if previous_materialization is not null then
        return jsonb_build_object(
          'kind', 'conflict', 'changed', false, 'task', stored_payload, 'retryRuns', '[]'::jsonb
        );
      end if;
      run_to_return := run_payload;
      runs_to_insert := runs_to_insert || jsonb_build_array(run_payload);
    end if;

    first_retry_decision := null;
    select decision into first_retry_decision from jsonb_array_elements(decisions_payload) decision
    where decision->>'artifactId' = artifact_id and decision->>'decision' = 'retry_requested'
    order by
      case when decision->>'decisionRevision' ~ '^[0-9]+$'
        then (decision->>'decisionRevision')::bigint else 9223372036854775807 end,
      case when decision->>'decidedAt' ~ '^[0-9]+$'
        then (decision->>'decidedAt')::bigint else 0 end
    limit 1;
    if first_retry_decision is null then
      return jsonb_build_object(
        'kind', 'conflict', 'changed', false, 'task', stored_payload, 'retryRuns', '[]'::jsonb
      );
    end if;
    if previous_materialization is not null then
      if jsonb_typeof(previous_materialization) is distinct from 'object'
        or not public.botanic_same_request_binding(
          previous_materialization->'requestBinding', candidate->'idempotencyBinding'
        )
        or previous_materialization->>'runId' is distinct from run_id
        or previous_materialization->>'runOwnerId' is distinct from run_to_return->>'ownerId'
        or previous_materialization->>'requestedBy' is distinct from first_retry_decision->>'decidedBy'
        or previous_materialization->'createdAt' is distinct from first_retry_decision->'decidedAt' then
        return jsonb_build_object(
          'kind', 'conflict', 'changed', false, 'task', stored_payload, 'retryRuns', '[]'::jsonb
        );
      end if;
      materialization := previous_materialization;
    else
      materialization := jsonb_build_object(
        'requestBinding', candidate->'idempotencyBinding', 'runId', run_id,
        'runOwnerId', run_to_return->>'ownerId',
        'requestedBy', first_retry_decision->>'decidedBy',
        'createdAt', first_retry_decision->'decidedAt'
      );
    end if;

    select coalesce(jsonb_agg(
      case when result->>'id' = review_result_id then
        result || jsonb_build_object('retryMaterialization', materialization)
      else result end order by ordinal
    ), '[]'::jsonb) into results_payload
    from jsonb_array_elements(results_payload) with ordinality rows(result, ordinal);
    retry_runs := retry_runs || jsonb_build_array(run_to_return);
  end loop;

  if not changed then
    return jsonb_build_object(
      'kind', 'replay', 'changed', false, 'task', stored_payload, 'retryRuns', retry_runs
    );
  end if;
  existing_updated_ms := case when stored_payload->>'updatedAt' ~ '^[0-9]+$'
    then (stored_payload->>'updatedAt')::bigint else 0 end;
  stored_payload := stored_payload || jsonb_build_object(
    'decisions', decisions_payload, 'results', results_payload,
    'decisionVersion', decision_version, 'updatedAt', greatest(existing_updated_ms, observed_ms)
  );

  -- 所有 fail-closed 验证完成后才允许写入；任一异常都会回滚整个函数事务。
  for run_payload in
    select value from jsonb_array_elements(runs_to_insert) order by value->>'id'
  loop
    insert into public.agent_runs (id, owner_id, project_id, status, updated_at, payload)
    values (
      run_payload->>'id', (run_payload->>'ownerId')::uuid, run_payload->>'projectId', 'queued',
      to_timestamp((run_payload->>'updatedAt')::double precision / 1000.0), run_payload
    );
  end loop;
  update public.agent_review_tasks set updated_at = observed_at, payload = stored_payload
  where id = p_task_id;
  return jsonb_build_object(
    'kind', 'committed', 'changed', true, 'task', stored_payload, 'retryRuns', retry_runs
  );
exception when invalid_text_representation or numeric_value_out_of_range or unique_violation then
  return jsonb_build_object(
    'kind', 'conflict', 'changed', false, 'task', authoritative_payload, 'retryRuns', '[]'::jsonb
  );
end;
$$;

revoke all on function public.botanic_js_number_text(jsonb) from public, anon, authenticated;
revoke all on function public.botanic_canonical_json_text(jsonb) from public, anon, authenticated;
revoke all on function public.botanic_sha256_base64url(text) from public, anon, authenticated;
revoke all on function public.botanic_canonical_json_hash(jsonb) from public, anon, authenticated;
revoke all on function public.botanic_same_request_binding(jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.botanic_valid_request_binding(jsonb, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.botanic_agent_review_retry_run_id(text, text)
  from public, anon, authenticated;
revoke all on function public.botanic_agent_review_run_submission_request(jsonb)
  from public, anon, authenticated;
revoke all on function public.botanic_agent_review_run_submission_hash(jsonb)
  from public, anon, authenticated;
revoke all on function public.botanic_commit_agent_review_human_decisions(uuid, text, text, jsonb, integer)
  from public, anon, authenticated;
grant execute on function public.botanic_commit_agent_review_human_decisions(uuid, text, text, jsonb, integer)
  to service_role;

commit;
