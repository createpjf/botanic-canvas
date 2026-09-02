import { createHash, randomUUID } from 'node:crypto'
import { agentActionManualRetryConsumptionDecision, agentActionReceiptClaimDecision, agentActionReceiptResolutionDecision, agentSkillPersistenceDecision, agentThreadSummaryCompareAndSetDecision, agentTurnExecutionClaimDecision, authoritativeAgentActionManualRetryAuthorization, canvasGraphConflictCode, canvasMutationConflictCode, canvasSyncEpochStaleError, committedAgentTurnExecution, finalizedAgentTurnCancellation, normalizeAgentEntityIdPage, normalizeCanvasGraphMutation, normalizePendingAgentReviewRecoveryPage, normalizeStaleTurnQuery, normalizeTurnEventPage, normalizeUpdatedAtIdRecoveryPage, persistedAgentSkillVersion, reclaimableAgentTurnStatuses, requestedAgentTurnCancellation, settledAgentActionReceipt } from './productStoreContract.mjs'
import postgres from 'postgres'
import { assertProjectPermission, assertWorkspacePermission, projectPermissionDecision } from './authorization.mjs'
import { artifactIndexLimits, artifactsFromActionReceipt, artifactsFromAgentMessage, artifactsFromDocument, artifactsFromGenerationJob, generationArtifactRefreshReport, generationArtifactsFromJobReport } from './botanicArtifactIndex.mjs'
import { applyGenerationJobToAgentRun, mergeAgentRunForWrite } from './botanicAgentRun.mjs'
import { agentEntityLimits, agentStateFromDocument, applyAgentSessionReadReceipts, compareAndSetAgentSessionSettings, mergeAgentStateIntoDocument, shouldApplyAgentEntityWrite, shouldApplyAgentRunWrite, stripAgentMessagesFromDocument, validateAgentEntityWriteTimestamp, validateAgentMemoryEntity, validateAgentMessageEntity, validateAgentSessionEntity, validateAgentSessionReadReceipt } from './botanicAgentPersistence.mjs'
import { agentMessageListOptions, encodeAgentMessageCursor, normalizeAgentSessionListLimit } from './agentMessagePersistence.mjs'
import { collaborationActivitiesForMember, collaborationActivityListOptions, nextCollaborationReceipt, validateCollaborationActivity } from './collaborationActivityPersistence.mjs'
import { mergeAgentMessageForWrite } from './agentMessageMerge.mjs'
import { observeProductStoreRead, timedProductStoreRead } from './productStoreMetrics.mjs'
import { acknowledgedGenerationJobCancellation, committedGenerationJobExecution, comparedAndSetGenerationJob, generationJobExecutionClaimDecision, generationJobPutDecision, requestedGenerationJobCancellation } from './generationJobExecution.mjs'
import { idempotencyRequestBindingWriteDecision } from './idempotencyRequestBinding.mjs'
import { agentBranchRetryClaimDecision, agentBranchRetryJobDecision } from './agentBranchRetryClaim.mjs'
import { agentReviewCancellationFinalizeDecision, agentReviewCancellationRequestDecision, agentReviewExecutionClaimDecision, agentReviewTaskPutDecision, committedAgentReviewExecution } from './agentReviewExecution.mjs'
import { agentReviewRetryMaterializationDecision } from './agentReviewRetryMaterialization.mjs'
import { agentReviewOutcomeReconciliationDecision } from './agentReviewReconciliation.mjs'
import {
  agentSubagentActivationClaimDecision,
  agentSubagentActivationSettleDecision,
  assertAgentSubagentRootTurnFence,
  agentSubagentCancellationFinalizeDecision,
  agentSubagentCancellationRequestDecision,
  agentSubagentEnqueueDecision,
  materializeAgentSubagentEnqueueCommand,
  normalizeAgentSubagentActivationPage,
  normalizeRunnableAgentSubagentPage,
  publicAgentSubagent,
  publicAgentSubagentActivation,
} from './agentSubagentPersistence.mjs'
import {
  agentContextStateCompareAndSetDecision,
  materializeAgentContextCommand,
  normalizeAgentContextCompactionPage,
  publicAgentContextCompaction,
} from './agentContextPersistence.mjs'

const now = () => Date.now()
const hashAccessToken = (token) => createHash('sha256').update(token).digest('hex')
const clone = (value) => structuredClone(value)

function productError(message, code = 'PRODUCT_STORE_ERROR') {
  const error = new Error(message)
  error.code = code
  return error
}

function preserveAgentThreadSummary(current, incoming) {
  if (current?.threadSummary === undefined) return incoming
  return { ...incoming, threadSummary: clone(current.threadSummary) }
}

function asUser(row) {
  return row ? {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status ?? 'active',
    createdAt: row.createdAt === undefined ? undefined : Number(row.createdAt),
  } : undefined
}

function asJson(value) {
  if (typeof value === 'string') {
    try {
      return clone(JSON.parse(value))
    } catch {
      return value
    }
  }
  return clone(value)
}

function asPayload(row) {
  return row ? asJson(row.payload) : undefined
}

function agentSubagentFromRow(row, { includeLease = true } = {}) {
  if (!row) return undefined
  const base = asPayload(row) ?? {}
  const dispatch = row.dispatchActivationSequence === null || row.dispatchActivationSequence === undefined
    ? undefined
    : {
        ...(base.dispatch ?? {}),
        generation: Number(row.dispatchGeneration),
        activationSequence: Number(row.dispatchActivationSequence),
        ...(includeLease ? { leaseToken: row.dispatchLeaseToken } : {}),
        leaseExpiresAt: Number(row.dispatchLeaseExpiresAt),
      }
  return {
    ...base,
    id: row.id,
    ownerId: row.ownerId,
    projectId: row.projectId,
    rootTurnId: row.rootTurnId,
    ...(row.parentSessionId ? { parentSessionId: row.parentSessionId } : {}),
    sessionId: row.sessionId,
    status: row.status,
    cancelGeneration: Number(row.cancelGeneration),
    lastEnqueuedSequence: Number(row.lastEnqueuedSequence),
    settledThroughSequence: Number(row.settledThroughSequence),
    ...(dispatch ? { dispatch } : {}),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  }
}

function agentSubagentActivationFromRow(row, { includeLease = true } = {}) {
  if (!row) return undefined
  const stored = asPayload(row) ?? {}
  const { execution: storedExecution, ...payload } = stored
  const execution = row.executionLeaseToken
    ? {
        ...(storedExecution ?? {}),
        generation: Number(row.executionGeneration),
        cancelGeneration: Number(row.executionCancelGeneration),
        ...(includeLease ? { leaseToken: row.executionLeaseToken } : {}),
        leaseExpiresAt: Number(row.executionLeaseExpiresAt),
      }
    : undefined
  return {
    ...payload,
    subagentId: row.subagentId,
    sequence: Number(row.sequence),
    turnId: row.turnId,
    inputMessageId: row.inputMessageId,
    resultMessageId: row.resultMessageId,
    sourceTurnId: row.sourceTurnId,
    idempotencyKey: row.idempotencyKey,
    requestHash: row.requestHash,
    cancelGeneration: Number(row.subagentGeneration),
    ...(execution ? { execution } : {}),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    ...(row.settledAt === null || row.settledAt === undefined
      ? {}
      : { settledAt: Number(row.settledAt) }),
  }
}

function publicAgentSubagentTurn(turn) {
  if (!turn) return undefined
  return {
    id: turn.id,
    version: turn.version,
    projectId: turn.projectId,
    ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
    status: turn.status,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
    ...(turn.result ? { result: clone(turn.result) } : {}),
    ...(turn.error ? { error: clone(turn.error) } : {}),
  }
}

function publicAgentSubagentDecision(value) {
  return {
    kind: value?.kind,
    subagent: publicAgentSubagent(value?.subagent),
    activation: publicAgentSubagentActivation(value?.activation),
    ...(value?.turn ? { turn: publicAgentSubagentTurn(value.turn) } : {}),
    changed: value?.changed === true,
  }
}

function canvasGraph(document) {
  return {
    nodes: Array.isArray(document?.nodes) ? clone(document.nodes) : [],
    edges: Array.isArray(document?.edges) ? clone(document.edges) : [],
  }
}

function sameGraph(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function insertAudit(sql, { actorId, action, projectId, targetId, detail = {}, createdAt }) {
  await sql`
    insert into audit_events (id, actor_id, action, project_id, target_id, detail, created_at)
    values (${`audit_${randomUUID()}`}, ${actorId}, ${action}, ${projectId ?? null}, ${targetId ?? null}, ${sql.json(detail)}::jsonb, ${Number(createdAt) || now()})
  `
}

/**
 * PostgreSQL Adapter。它实现与 file ProductStore 相同的 Interface；调用方无需
 * 知道 JSONB、事务、行锁与审计写入的细节。
 */
export async function createPostgresProductStore({ databaseUrl, bootstrapAccessToken, bootstrapEmail = 'owner@botanic.local' }) {
  if (!databaseUrl) throw new Error('DATABASE_URL 未配置，无法启动生产数据存储。')

  const sql = postgres(databaseUrl, {
    max: Number(process.env.POSTGRES_POOL_MAX ?? 4),
    idle_timeout: 20,
    connect_timeout: 10,
    connection: {
      application_name: 'botanic-worker-api',
      statement_timeout: Number(process.env.POSTGRES_STATEMENT_TIMEOUT_MS ?? 15_000),
      lock_timeout: Number(process.env.POSTGRES_LOCK_TIMEOUT_MS ?? 5_000),
    },
  })

  // 启动时先探一次连接。不探的话，连不上会在建表事务里以驱动原始堆栈冒出来
  // （`write CONNECT_TIMEOUT undefined:undefined`），既看不出是哪个主机、
  // 也看不出该改什么。启动失败可以接受，说不清原因不行。
  try {
    await sql`select 1`
  } catch (caught) {
    const host = (() => {
      try { return new URL(databaseUrl).host } catch { return '（无法解析的 DATABASE_URL）' }
    })()
    const error = new Error(
      `无法连接数据库 ${host}：${/** @type {any} */ (caught)?.code ?? caught}。`
      + '请检查 DATABASE_URL、网络可达性与代理规则（TUN/fake-ip 代理常会让 TCP 建立但握手超时）。',
    )
    error.cause = caught
    throw error
  }

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

  // 本地访问令牌模式才需要预置 token。生产迁移期由 Supabase Auth 校验身份，
  // 因而不能要求一个额外的共享启动令牌。
  if (bootstrapAccessToken) {
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

  async function memberRole(projectId, userId) {
    const [row] = await sql`select role from project_members where project_id = ${projectId} and user_id = ${userId}`
    return row?.role
  }

  async function ensureCanvasGraph(tx, projectId) {
    await tx`
      insert into canvas_graphs (project_id, graph, revision, updated_at)
      select p.id,
        jsonb_build_object(
          'nodes', coalesce(p.document->'nodes', '[]'::jsonb),
          'edges', coalesce(p.document->'edges', '[]'::jsonb)
        ),
        1,
        p.updated_at
      from projects p
      where p.id = ${projectId}
      on conflict (project_id) do nothing
    `
  }

  async function readAgentStateRows(query, projectId, userId, options = {}) {
    const startedAt = Date.now()
    const includeMessages = options.includeMessages !== false
    const includeSubagents = options.includeSubagents === true
    try {
      // 一个项目读请求会同时补读多张 Agent 表；并发占用连接会把 max=4 的池瞬间打满。
      // 顺序读取仍复用同一个 query/事务，并把活跃连接压力限制在每个请求一条。
      const sessionRows = await query`
        select payload from agent_sessions
        where project_id = ${projectId}
          and (${includeSubagents} or coalesce(payload->>'kind', 'primary') <> 'subagent')
        order by updated_at desc limit 80
      `
      const messageRows = includeMessages
        ? await query`
            select session_id as "sessionId", updated_at as "updatedAt", payload from (
              select session_id, updated_at, payload,
                row_number() over (partition by session_id order by updated_at desc) as recency
              from agent_messages where project_id = ${projectId}
                and (${includeSubagents} or session_id in (
                  select id from agent_sessions
                  where project_id = ${projectId}
                    and coalesce(payload->>'kind', 'primary') <> 'subagent'
                ))
            ) ranked
            where recency <= ${agentEntityLimits.messagesPerSession}
            order by updated_at asc
          `
        : []
      const memoryRows = await query`select id, deleted_at as "deletedAt", payload from agent_memory_items where project_id = ${projectId} order by updated_at desc limit 200`
      const runRows = await query`select payload from agent_runs where project_id = ${projectId} order by updated_at desc limit 60`
      const receiptRows = userId
        ? await query`select session_id as "sessionId", message_id as "messageId", updated_at as "updatedAt" from agent_session_read_receipts where project_id = ${projectId} and user_id = ${userId}`
        : []
      const result = {
        sessions: applyAgentSessionReadReceipts(sessionRows.map(asPayload), receiptRows.map((row) => ({
          sessionId: row.sessionId,
          messageId: row.messageId,
          updatedAt: Number(row.updatedAt),
        }))),
        messages: messageRows.map((row) => ({ sessionId: row.sessionId, updatedAt: Number(row.updatedAt), message: asPayload(row) })),
        memory: memoryRows.filter((row) => row.deletedAt === null).map(asPayload),
        deletedMemoryIds: memoryRows.filter((row) => row.deletedAt !== null).map((row) => row.id),
        runs: runRows.map(asPayload),
      }
      observeProductStoreRead('readAgentStateRows', {
        projectId,
        userId,
        includeMessages,
        durationMs: Date.now() - startedAt,
        ok: true,
        sessionCount: result.sessions.length,
        messageRowCount: result.messages.length,
      })
      return result
    } catch (error) {
      observeProductStoreRead('readAgentStateRows', {
        projectId,
        userId,
        includeMessages,
        durationMs: Date.now() - startedAt,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  async function upsertArtifactRecords(query, userId, projectId, artifacts) {
    for (const artifact of artifacts) {
      await query`
        insert into agent_artifacts (
          project_id, id, owner_id, kind, source_kind, run_id, job_id,
          created_at, updated_at, payload
        ) values (
          ${projectId}, ${artifact.id}, ${userId}, ${artifact.kind}, ${artifact.origin.type},
          ${artifact.provenance.runId ?? null}, ${artifact.origin.jobId ?? null},
          ${artifact.createdAt}, ${artifact.updatedAt}, ${query.json(artifact)}::jsonb
        )
        on conflict (project_id, id) do update set
          kind = excluded.kind,
          source_kind = excluded.source_kind,
          run_id = excluded.run_id,
          job_id = excluded.job_id,
          created_at = least(agent_artifacts.created_at, excluded.created_at),
          updated_at = excluded.updated_at,
          payload = jsonb_set(
            excluded.payload,
            '{createdAt}',
            to_jsonb(least(agent_artifacts.created_at, excluded.created_at)),
            true
          )
        where agent_artifacts.updated_at <= excluded.updated_at
      `
    }
  }

  async function syncAgentState(tx, userId, document, previousDocument) {
    const extracted = agentStateFromDocument(document)
    let previous
    try {
      previous = previousDocument ? agentStateFromDocument(previousDocument) : undefined
    } catch {
      // 旧文档可能包含当前规则不再接受的数据；差量基线失效时退回全量同步，
      // 不能让上一版坏数据阻断用户提交已经修正的新文档。
      previous = undefined
    }
    const changed = (items, previousItems, key = (item) => item.id) => {
      if (!previous) return items
      const previousById = new Map(previousItems.map((item) => [key(item), item]))
      return items.filter((item) => {
        const before = previousById.get(key(item))
        return !before || JSON.stringify(before) !== JSON.stringify(item)
      })
    }
    const changedSessions = changed(extracted.sessions, previous?.sessions ?? [])
    const changedMessages = changed(extracted.messages, previous?.messages ?? [], (entry) => entry.message.id)
    const changedMemory = changed(extracted.memory, previous?.memory ?? [])
    const changedRuns = changed(extracted.runs, previous?.runs ?? [])

    for (const session of changedSessions) {
      await tx`select pg_advisory_xact_lock(hashtextextended(${'agent-session:' + session.id}, 0))`
      const [conflict] = await tx`select project_id as "projectId" from agent_sessions where id = ${session.id} for update`
      if (conflict && conflict.projectId !== document.id) throw productError('Agent 会话标识已被其他项目使用。', 'AGENT_SESSION_ID_CONFLICT')
      await tx`
        insert into agent_sessions (id, owner_id, project_id, updated_at, payload)
        values (${session.id}, ${userId}, ${document.id}, ${session.updatedAt}, ${tx.json(session)}::jsonb)
        on conflict (id) do nothing
      `
    }
    for (const entry of changedMessages) {
      await tx`select pg_advisory_xact_lock(hashtextextended(${'agent-message:' + entry.message.id}, 0))`
      const [conflict] = await tx`
        select project_id as "projectId", session_id as "sessionId", updated_at as "updatedAt", payload
        from agent_messages where id = ${entry.message.id} for update
      `
      if (conflict && (conflict.projectId !== document.id || conflict.sessionId !== entry.sessionId)) {
        throw productError('Agent 消息标识已被其他会话使用。', 'AGENT_MESSAGE_ID_CONFLICT')
      }
      const merged = mergeAgentMessageForWrite(asPayload(conflict), entry.message, {
        currentUpdatedAt: conflict ? Number(conflict.updatedAt) : undefined,
        incomingUpdatedAt: entry.updatedAt,
      })
      const message = merged.message
      const storedUpdatedAt = merged.updatedAt
      await tx`
        insert into agent_messages (id, owner_id, project_id, session_id, updated_at, payload)
        values (${entry.message.id}, ${userId}, ${document.id}, ${entry.sessionId}, ${storedUpdatedAt}, ${tx.json(message)}::jsonb)
        on conflict (id) do update set
          updated_at = excluded.updated_at,
          payload = excluded.payload
        where agent_messages.project_id = excluded.project_id
          and agent_messages.session_id = excluded.session_id
      `
    }
    for (const session of extracted.sessions) {
      if (!session.readingAnchorMessageId || session.readingAnchorUpdatedAt === undefined) continue
      const messageExists = extracted.messages.some((entry) => entry.sessionId === session.id && entry.message.id === session.readingAnchorMessageId)
      if (!messageExists) continue
      await tx`
        insert into agent_session_read_receipts (user_id, project_id, session_id, message_id, updated_at)
        values (${userId}, ${document.id}, ${session.id}, ${session.readingAnchorMessageId}, ${session.readingAnchorUpdatedAt})
        on conflict (user_id, project_id, session_id) do update set
          message_id = excluded.message_id,
          updated_at = excluded.updated_at
        where agent_session_read_receipts.updated_at < excluded.updated_at
      `
    }
    const previousMemoryIds = new Set((Array.isArray(previousDocument?.agentMemory) ? previousDocument.agentMemory : []).map((item) => item?.id).filter(Boolean))
    const nextMemoryIds = new Set(extracted.memory.map((item) => item.id))
    for (const memoryId of previousMemoryIds) {
      if (!nextMemoryIds.has(memoryId)) await tx`update agent_memory_items set deleted_at = ${now()}, updated_at = ${now()} where id = ${memoryId} and project_id = ${document.id}`
    }
    for (const memory of changedMemory) {
      const [conflict] = await tx`select project_id as "projectId" from agent_memory_items where id = ${memory.id}`
      if (conflict && conflict.projectId !== document.id) throw productError('Agent 记忆标识已被其他项目使用。', 'AGENT_MEMORY_ID_CONFLICT')
      await tx`
        insert into agent_memory_items (id, owner_id, project_id, updated_at, deleted_at, payload)
        values (${memory.id}, ${userId}, ${document.id}, ${memory.updatedAt}, null, ${tx.json(memory)}::jsonb)
        on conflict (id) do update set updated_at = excluded.updated_at, deleted_at = null, payload = excluded.payload
        where agent_memory_items.project_id = excluded.project_id
          and agent_memory_items.deleted_at is null
          and agent_memory_items.updated_at <= excluded.updated_at
      `
    }
    for (const run of changedRuns) {
      const status = run.status
      const [conflict] = await tx`select project_id as "projectId" from agent_runs where id = ${run.id}`
      if (conflict && conflict.projectId !== document.id) throw productError('Agent Run 标识已被其他项目使用。', 'AGENT_RUN_ID_CONFLICT')
      await tx`
        insert into agent_runs (id, owner_id, project_id, status, updated_at, payload)
        values (${run.id}, ${userId}, ${document.id}, ${status}, ${Number(run.updatedAt) || now()}, ${tx.json({ ...run, projectId: document.id, ownerId: userId })}::jsonb)
        on conflict (id) do nothing
      `
    }
    const artifacts = artifactsFromDocument(document)
    const previousArtifacts = previousDocument ? artifactsFromDocument(previousDocument) : []
    await upsertArtifactRecords(tx, userId, document.id, changed(artifacts, previousArtifacts))
  }

  async function generationObservedAt(tx) {
    const [clock] = await tx`
      select floor(extract(epoch from clock_timestamp()) * 1000)::bigint as "observedAt"
    `
    return Number(clock.observedAt)
  }

  async function lockedAgentSubagent(tx, subagentId) {
    const [row] = await tx`
      select id, owner_id as "ownerId", project_id as "projectId",
        root_turn_id as "rootTurnId", parent_session_id as "parentSessionId",
        session_id as "sessionId", status, cancel_generation as "cancelGeneration",
        last_enqueued_sequence as "lastEnqueuedSequence",
        settled_through_sequence as "settledThroughSequence",
        dispatch_generation as "dispatchGeneration",
        dispatch_activation_sequence as "dispatchActivationSequence",
        dispatch_lease_token as "dispatchLeaseToken",
        dispatch_lease_expires_at as "dispatchLeaseExpiresAt",
        idempotency_key as "idempotencyKey", request_hash as "requestHash",
        created_at as "createdAt", updated_at as "updatedAt", payload
      from agent_subagents where id = ${subagentId} for update
    `
    return row ? { row, subagent: agentSubagentFromRow(row) } : undefined
  }

  async function lockedAgentSubagentActivation(tx, subagentId, predicate) {
    const rows = predicate?.idempotencyKey
      ? await tx`
          select subagent_id as "subagentId", sequence, turn_id as "turnId",
            input_message_id as "inputMessageId", result_message_id as "resultMessageId",
            source_turn_id as "sourceTurnId", idempotency_key as "idempotencyKey",
            request_hash as "requestHash", subagent_generation as "subagentGeneration",
            execution_generation as "executionGeneration",
            execution_cancel_generation as "executionCancelGeneration",
            execution_lease_token as "executionLeaseToken",
            execution_lease_expires_at as "executionLeaseExpiresAt",
            created_at as "createdAt", updated_at as "updatedAt", settled_at as "settledAt", payload
          from agent_subagent_activations
          where subagent_id = ${subagentId} and idempotency_key = ${predicate.idempotencyKey}
          for update
        `
      : await tx`
          select subagent_id as "subagentId", sequence, turn_id as "turnId",
            input_message_id as "inputMessageId", result_message_id as "resultMessageId",
            source_turn_id as "sourceTurnId", idempotency_key as "idempotencyKey",
            request_hash as "requestHash", subagent_generation as "subagentGeneration",
            execution_generation as "executionGeneration",
            execution_cancel_generation as "executionCancelGeneration",
            execution_lease_token as "executionLeaseToken",
            execution_lease_expires_at as "executionLeaseExpiresAt",
            created_at as "createdAt", updated_at as "updatedAt", settled_at as "settledAt", payload
          from agent_subagent_activations
          where subagent_id = ${subagentId} and sequence = ${Number(predicate?.sequence) || 0}
          for update
        `
    const row = rows[0]
    return row ? { row, activation: agentSubagentActivationFromRow(row) } : undefined
  }

  async function persistAgentSubagent(tx, subagent) {
    const { dispatch, ...descriptorPayload } = clone(subagent)
    const publicPayload = {
      ...descriptorPayload,
      ...(dispatch ? {
        dispatch: {
          activationId: dispatch.activationId,
          activationSequence: dispatch.activationSequence,
          generation: dispatch.generation,
          cancelGeneration: dispatch.cancelGeneration,
          leaseExpiresAt: dispatch.leaseExpiresAt,
        },
      } : {}),
    }
    await tx`
      insert into agent_subagents (
        id, owner_id, project_id, root_turn_id, parent_session_id, session_id,
        status, cancel_generation, last_enqueued_sequence, settled_through_sequence,
        dispatch_generation, dispatch_activation_sequence, dispatch_lease_token,
        dispatch_lease_expires_at, idempotency_key, request_hash, payload, created_at, updated_at
      ) values (
        ${subagent.id}, ${subagent.ownerId}, ${subagent.projectId}, ${subagent.rootTurnId},
        ${subagent.parentSessionId ?? null}, ${subagent.sessionId}, ${subagent.status},
        ${subagent.cancelGeneration}, ${subagent.lastEnqueuedSequence},
        ${subagent.settledThroughSequence}, ${Number(dispatch?.generation) || 0},
        ${dispatch?.activationSequence ?? null}, ${dispatch?.leaseToken ?? null},
        ${Number(dispatch?.leaseExpiresAt) || null}, ${subagent.idempotencyKey},
        ${subagent.requestHash}, ${tx.json(publicPayload)}::jsonb,
        ${subagent.createdAt}, ${subagent.updatedAt}
      )
      on conflict (id) do update set
        status = excluded.status,
        cancel_generation = excluded.cancel_generation,
        last_enqueued_sequence = excluded.last_enqueued_sequence,
        settled_through_sequence = excluded.settled_through_sequence,
        dispatch_generation = excluded.dispatch_generation,
        dispatch_activation_sequence = excluded.dispatch_activation_sequence,
        dispatch_lease_token = excluded.dispatch_lease_token,
        dispatch_lease_expires_at = excluded.dispatch_lease_expires_at,
        payload = excluded.payload,
        updated_at = excluded.updated_at
      where agent_subagents.owner_id = excluded.owner_id
        and agent_subagents.project_id = excluded.project_id
        and agent_subagents.root_turn_id = excluded.root_turn_id
        and agent_subagents.session_id = excluded.session_id
        and agent_subagents.idempotency_key = excluded.idempotency_key
        and agent_subagents.request_hash = excluded.request_hash
    `
  }

  async function persistAgentSubagentActivation(tx, activation) {
    const { execution, ...activationPayload } = clone(activation)
    const publicPayload = {
      ...activationPayload,
      ...(execution ? {
        execution: {
          generation: execution.generation,
          cancelGeneration: execution.cancelGeneration,
          leaseDurationMs: execution.leaseDurationMs,
          leaseExpiresAt: execution.leaseExpiresAt,
          claimedAt: execution.claimedAt,
          lastHeartbeatAt: execution.lastHeartbeatAt,
        },
      } : {}),
    }
    await tx`
      insert into agent_subagent_activations (
        subagent_id, sequence, turn_id, input_message_id, result_message_id,
        source_turn_id, idempotency_key, request_hash, subagent_generation,
        execution_generation, execution_cancel_generation, execution_lease_token,
        execution_lease_expires_at, payload, created_at, updated_at, settled_at
      ) values (
        ${activation.subagentId}, ${activation.sequence}, ${activation.turnId},
        ${activation.inputMessageId}, ${activation.resultMessageId}, ${activation.sourceTurnId},
        ${activation.idempotencyKey}, ${activation.requestHash},
        ${activation.cancelGeneration}, ${Number(execution?.generation) || 0},
        ${execution?.cancelGeneration ?? null}, ${execution?.leaseToken ?? null},
        ${Number(execution?.leaseExpiresAt) || null}, ${tx.json(publicPayload)}::jsonb,
        ${activation.createdAt}, ${activation.updatedAt}, ${activation.settledAt ?? null}
      )
      on conflict (subagent_id, sequence) do update set
        payload = excluded.payload,
        execution_generation = excluded.execution_generation,
        execution_cancel_generation = excluded.execution_cancel_generation,
        execution_lease_token = excluded.execution_lease_token,
        execution_lease_expires_at = excluded.execution_lease_expires_at,
        updated_at = excluded.updated_at,
        settled_at = excluded.settled_at
      where agent_subagent_activations.turn_id = excluded.turn_id
        and agent_subagent_activations.input_message_id = excluded.input_message_id
        and agent_subagent_activations.result_message_id = excluded.result_message_id
        and agent_subagent_activations.idempotency_key = excluded.idempotency_key
        and agent_subagent_activations.request_hash = excluded.request_hash
        and agent_subagent_activations.subagent_generation = excluded.subagent_generation
    `
  }

  async function lockedGenerationJob(tx, jobId) {
    const [row] = await tx`
      select owner_id as "ownerId", project_id as "projectId", payload
      from generation_jobs where id = ${jobId} for update
    `
    return row ? {
      row,
      job: { ...asPayload(row), id: jobId, ownerId: row.ownerId, projectId: row.projectId },
    } : undefined
  }

  async function persistGenerationDecision(tx, job) {
    const executionVersion = Math.max(0, Number(job.executionVersion) || Number(job.execution?.generation) || 0)
    await tx`
      insert into generation_jobs (
        id, owner_id, project_id, status, updated_at,
        execution_version, lease_token, lease_expires_at, payload
      ) values (
        ${job.id}, ${job.ownerId}, ${job.projectId}, ${job.status}, ${job.updatedAt},
        ${executionVersion}, ${job.execution?.leaseToken ?? null},
        ${Number(job.execution?.leaseExpiresAt) || null}, ${tx.json(job)}::jsonb
      )
      on conflict (id) do update set
        status = excluded.status,
        updated_at = excluded.updated_at,
        execution_version = excluded.execution_version,
        lease_token = excluded.lease_token,
        lease_expires_at = excluded.lease_expires_at,
        payload = excluded.payload
      where generation_jobs.owner_id = excluded.owner_id
        and generation_jobs.project_id = excluded.project_id
    `
    return clone(job)
  }

  async function persistAgentReviewExecutionDecision(tx, task) {
    const executionVersion = Math.max(
      0,
      Number(task.executionVersion) || 0,
      Number(task.execution?.generation) || 0,
    )
    await tx`
      insert into agent_review_tasks (
        id, owner_id, project_id, run_id, status, updated_at,
        execution_version, lease_token, lease_expires_at, payload
      ) values (
        ${task.id}, ${task.ownerId}, ${task.projectId}, ${task.runId}, ${task.status}, ${task.updatedAt},
        ${executionVersion}, ${task.execution?.leaseToken ?? null},
        ${Number(task.execution?.leaseExpiresAt) || null}, ${tx.json(task)}::jsonb
      )
      on conflict (id) do update set
        status = excluded.status,
        updated_at = excluded.updated_at,
        execution_version = excluded.execution_version,
        lease_token = excluded.lease_token,
        lease_expires_at = excluded.lease_expires_at,
        payload = excluded.payload
      where agent_review_tasks.owner_id = excluded.owner_id
        and agent_review_tasks.project_id = excluded.project_id
        and agent_review_tasks.run_id = excluded.run_id
    `
    return clone(task)
  }

  async function refreshGenerationArtifactRecords(userId, jobId) {
    return sql.begin(async (tx) => {
      const [row] = await tx`
        select job.payload, project.document, graph.graph
        from generation_jobs job
        join projects project on project.id = job.project_id
        join project_members member on member.project_id = project.id and member.user_id = ${userId}
        left join canvas_graphs graph on graph.project_id = project.id
        where job.id = ${jobId} and job.owner_id = ${userId}
      `
      if (!row) return false
      const job = asPayload(row)
      const conversion = generationArtifactsFromJobReport(job, {
        document: { ...asJson(row.document), ...asJson(row.graph ?? {}) },
      })
      await upsertArtifactRecords(tx, userId, job.projectId, conversion.artifacts)
      const indexed = await tx`
        select id from agent_artifacts
        where project_id = ${job.projectId} and job_id = ${job.id}
      `
      return generationArtifactRefreshReport(conversion, indexed)
    })
  }

  async function projectGenerationDecision(job, options = {}) {
    const { updateAgentRun = true, recordAudit = true, syncArtifacts = true } = options
    let artifactReady = true
    if (syncArtifacts) {
      try {
        const report = await refreshGenerationArtifactRecords(job.ownerId, job.id)
        artifactReady = report !== false && report.status === 'passed'
      } catch (caught) {
        artifactReady = false
        console.warn(`[artifact-index] generation sync deferred for ${job.id}: ${caught instanceof Error ? caught.message : String(caught)}`)
      }
    }
    const terminalNeedsArtifacts = ['succeeded', 'failed'].includes(job.status) && Boolean(job.outputs?.length)
    if (updateAgentRun && job.agentRun?.runId) {
      if (!terminalNeedsArtifacts || !syncArtifacts || artifactReady) {
        const runProjected = await sql.begin(async (tx) => {
          const [row] = await tx`
            select payload from agent_runs
            where id = ${job.agentRun.runId} and owner_id = ${job.ownerId}
            for update
          `
          if (!row) return false
          const run = applyGenerationJobToAgentRun(asPayload(row), job)
          await tx`
            update agent_runs set status = ${run.status}, updated_at = ${run.updatedAt},
              payload = ${tx.json(run)}::jsonb
            where id = ${run.id} and owner_id = ${job.ownerId}
          `
          return true
        })
        if (!runProjected) throw productError('未找到关联的 Agent Run。', 'AGENT_RUN_NOT_FOUND')
      }
    }
    if (recordAudit) {
      try {
        await sql.begin(async (tx) => insertAudit(tx, {
          actorId: job.ownerId,
          action: `generation.${job.status}`,
          projectId: job.projectId,
          targetId: job.id,
          createdAt: job.updatedAt,
          detail: { model: job.settings?.model, batchCount: job.batchCount },
        }))
      } catch (caught) {
        console.warn(`[generation] audit deferred for ${job.id}: ${caught instanceof Error ? caught.message : String(caught)}`)
      }
    }
  }

  const store = {
    async authenticate(accessToken) {
      if (!accessToken) return undefined
      const [row] = await sql`
        select u.id, u.email, u.name, u.role, u.status, u.created_at as "createdAt"
        from access_tokens t join app_users u on u.id = t.user_id
        where t.token_hash = ${hashAccessToken(accessToken)} and t.revoked_at is null and u.status = 'active'
      `
      return asUser(row)
    },

    // Auth 身份通过 auth_identities 绑定既有工作区用户，绝不改写用户主键、
    // 项目成员关系或历史数据；业务数据也不经过 Supabase PostgREST。
    async ensureAuthenticatedUser({ id, email, name, roleHint, statusHint = 'active', createIfMissing = true }) {
      if (!id) throw productError('登录用户缺少标识。', 'AUTH_USER_INVALID')
      const normalizedEmail = (email || `${id}@auth.botanic.local`).trim().toLowerCase()
      const normalizedName = name?.trim() || normalizedEmail.split('@')[0] || 'Botanic Member'
      return sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(72695839)`
        const [identity] = await tx`
          select u.id, u.email, u.name, u.role, u.status, u.created_at as "createdAt"
          from auth_identities i join app_users u on u.id = i.user_id
          where i.provider = 'supabase' and i.subject = ${id}
          for update of u
        `
        const [sameId] = identity ? [] : await tx`select id, email, name, role, status, created_at as "createdAt" from app_users where id = ${id} for update`
        const [sameEmail] = identity || sameId ? [] : await tx`select id, email, name, role, status, created_at as "createdAt" from app_users where lower(email) = lower(${normalizedEmail}) for update`
        const existing = identity ?? sameId ?? sameEmail
        if (existing) {
          if (existing.status === 'disabled') return undefined
          const status = existing.status === 'invited' && statusHint === 'active' ? 'active' : existing.status
          if (existing.email !== normalizedEmail || existing.name !== normalizedName || existing.status !== status) {
            await tx`update app_users set email = ${normalizedEmail}, name = ${normalizedName}, status = ${status} where id = ${existing.id}`
          }
          await tx`
            insert into auth_identities (provider, subject, user_id, created_at)
            values ('supabase', ${id}, ${existing.id}, ${now()})
            on conflict (provider, subject) do update set user_id = excluded.user_id
          `
          return asUser({ ...existing, email: normalizedEmail, name: normalizedName, status })
        }
        if (!createIfMissing) return undefined
        const [owner] = await tx`select id from app_users where role = 'owner' limit 1`
        const role = roleHint === 'owner' || !owner ? 'owner' : 'member'
        const status = statusHint === 'invited' ? 'invited' : 'active'
        const createdAt = now()
        await tx`insert into app_users (id, email, name, role, status, created_at) values (${id}, ${normalizedEmail}, ${normalizedName}, ${role}, ${status}, ${createdAt})`
        await tx`insert into auth_identities (provider, subject, user_id, created_at) values ('supabase', ${id}, ${id}, ${createdAt})`
        return { id, email: normalizedEmail, name: normalizedName, role, status, createdAt }
      })
    },

    async readUser(userId) {
      const [row] = await sql`select id, email, name, role, status, created_at as "createdAt" from app_users where id = ${userId}`
      return asUser(row)
    },

    async createUser(actorId, { email, name, role = 'member', accessToken }) {
      return sql.begin(async (tx) => {
        const [actor] = await tx`select role, status from app_users where id = ${actorId}`
        assertWorkspacePermission(actor, 'manage-members', 'USER_CREATE_FORBIDDEN')
        const [existing] = await tx`select id from app_users where lower(email) = lower(${email})`
        if (existing) throw productError('该成员已存在。', 'USER_EXISTS')
        const user = { id: `usr_${randomUUID()}`, email, name: name || email, role, status: 'active', createdAt: now() }
        await tx`insert into app_users (id, email, name, role, status, created_at) values (${user.id}, ${user.email}, ${user.name}, ${user.role}, ${user.status}, ${user.createdAt})`
        await tx`insert into access_tokens (id, user_id, token_hash, created_at) values (${`token_${randomUUID()}`}, ${user.id}, ${hashAccessToken(accessToken)}, ${now()})`
        await insertAudit(tx, { actorId, action: 'member.created', targetId: user.id, detail: { email: user.email, role: user.role } })
        return user
      })
    },

    async listUsers(actorId) {
      const [actor] = await sql`select role, status from app_users where id = ${actorId}`
      assertWorkspacePermission(actor, 'manage-members', 'USER_MANAGE_FORBIDDEN')
      const rows = await sql`
        select id, email, name, role, status, created_at as "createdAt"
        from app_users order by created_at asc
      `
      return rows.map(asUser)
    },

    async updateUser(actorId, targetId, updates) {
      return sql.begin(async (tx) => {
        const [actor] = await tx`select role, status from app_users where id = ${actorId} for update`
        assertWorkspacePermission(actor, 'manage-members', 'USER_MANAGE_FORBIDDEN')
        const [target] = await tx`
          select id, email, name, role, status, created_at as "createdAt"
          from app_users where id = ${targetId} for update
        `
        if (!target) throw productError('未找到该工作区成员。', 'USER_NOT_FOUND')
        const role = updates?.role ?? target.role
        const status = updates?.status ?? target.status
        if (!['owner', 'member'].includes(role) || !['invited', 'active', 'disabled'].includes(status)) {
          throw productError('成员更新参数无效。', 'USER_UPDATE_INVALID')
        }
        if (target.role === 'owner' && target.status === 'active' && (role !== 'owner' || status !== 'active')) {
          const [{ count }] = await tx`select count(*)::int as count from app_users where role = 'owner' and status = 'active'`
          if (Number(count) <= 1) throw productError('工作区必须保留至少一名启用的所有者。', 'LAST_OWNER_REQUIRED')
        }
        await tx`update app_users set role = ${role}, status = ${status} where id = ${targetId}`
        if (status === 'disabled') await tx`update access_tokens set revoked_at = ${now()} where user_id = ${targetId} and revoked_at is null`
        await insertAudit(tx, { actorId, action: 'member.updated', targetId, detail: { role, status } })
        return asUser({ ...target, role, status })
      })
    },

    async listProjects(userId) {
      return timedProductStoreRead('listProjects', { userId }, async () => {
        // 列表只要封面和节点计数。摘要直接在 SQL 里算：整份 graph（节点带 image、
        // prompt）随项目数放大后，光是传输和 JSON 解析就能把项目库首屏拖成秒级。
        const rows = await sql`
        select p.id, p.name, greatest(p.updated_at, coalesce(c.updated_at, p.updated_at)) as "updatedAt",
          p.revision, m.role, c.revision as "graphRevision",
          coalesce(jsonb_array_length(c.graph->'nodes'), 0)::int as "nodeCount",
          (
            select count(*)::int
            from jsonb_array_elements(coalesce(c.graph->'nodes', '[]'::jsonb)) as node
            where node->>'type' = 'result' and jsonb_typeof(node->'data'->'image') = 'string'
          ) as "resultCount",
          (
            select node->'data'->>'image'
            from jsonb_array_elements(coalesce(c.graph->'nodes', '[]'::jsonb)) with ordinality as entry(node, position)
            where node->>'type' = 'result' and jsonb_typeof(node->'data'->'image') = 'string'
            order by entry.position desc limit 1
          ) as "coverImage"
        from projects p join project_members m on m.project_id = p.id
        left join canvas_graphs c on c.project_id = p.id
        where m.user_id = ${userId}
        order by greatest(p.updated_at, coalesce(c.updated_at, p.updated_at)) desc
      `
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        role: row.role,
        nodeCount: Number(row.nodeCount ?? 0),
        resultCount: Number(row.resultCount ?? 0),
        ...(row.coverImage ? { coverImage: row.coverImage } : {}),
        updatedAt: Number(row.updatedAt),
        revision: Number(row.revision),
        graphRevision: Number(row.graphRevision ?? 1),
      }))
      })
    },

    async readProject(userId, projectId) {
      return timedProductStoreRead('readProject', { projectId, userId }, () => sql.begin(async (tx) => {
        const [row] = await tx`
          select p.document, p.revision, p.updated_at as "projectUpdatedAt", c.graph,
            c.revision as "graphRevision", c.sync_protocol_epoch as "syncProtocolEpoch",
            c.updated_at as "graphUpdatedAt"
          from projects p join project_members m on m.project_id = p.id
          left join canvas_graphs c on c.project_id = p.id
          where p.id = ${projectId} and m.user_id = ${userId}
        `
        if (!row) return undefined
        const document = asJson(row.document)
        const graph = row.graph ? asJson(row.graph) : canvasGraph(document)
        const agentState = await readAgentStateRows(tx, projectId, userId, { includeMessages: false })
        const updatedAt = Math.max(
          Number(document.updatedAt ?? 0),
          Number(row.projectUpdatedAt ?? 0),
          Number(row.graphUpdatedAt ?? 0),
        )
        return {
          document: mergeAgentStateIntoDocument({ ...document, ...graph, updatedAt }, agentState, { includeMessages: false }),
          revision: Number(row.revision),
          graphRevision: Number(row.graphRevision ?? 1),
          syncProtocolEpoch: Number(row.syncProtocolEpoch ?? 1),
          readMetrics: {
            messageRowCount: 0,
            sessionCount: agentState.sessions?.length ?? 0,
          },
        }
      }))
    },

    async projectAccess(userId, projectId) {
      const [row] = await sql`
        select p.id, m.role
        from projects p left join project_members m on m.project_id = p.id and m.user_id = ${userId}
        where p.id = ${projectId}
      `
      return { exists: Boolean(row), role: row?.role }
    },

    async canEditProject(userId, projectId) {
      const role = await memberRole(projectId, userId)
      return projectPermissionDecision(role, 'edit') === 'allow'
    },

    async readCanvasSyncProtocolEpoch(userId, projectId) {
      return sql.begin(async (tx) => {
        const [member] = await tx`select 1 from project_members where project_id = ${projectId} and user_id = ${userId}`
        if (!member) return undefined
        await ensureCanvasGraph(tx, projectId)
        const [entry] = await tx`select sync_protocol_epoch as "syncProtocolEpoch" from canvas_graphs where project_id = ${projectId}`
        return entry ? Number(entry.syncProtocolEpoch ?? 1) : undefined
      })
    },

    /**
     * 行锁事务内原子地「读最新文档 → mutate → 写回」：Worker 的任务状态回写不再与
     * 用户保存做 CAS 竞速，全文档 5 连重试从根上消失。mutate 只碰生成投影
     * （nodes/edges/generationJobs），agent 实体字段与存量一致，无需 syncAgentState。
     */
    async updateProjectDocument(userId, projectId, mutate) {
      return sql.begin(async (tx) => {
        const [existing] = await tx`
          select p.id, p.revision, p.document, m.role
          from projects p left join project_members m on m.project_id = p.id and m.user_id = ${userId}
          where p.id = ${projectId}
          for update of p
        `
        if (!existing) return undefined
        assertProjectPermission(existing.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
        await ensureCanvasGraph(tx, projectId)
        const [currentGraphEntry] = await tx`
          select graph, revision, sync_protocol_epoch as "syncProtocolEpoch"
          from canvas_graphs where project_id = ${projectId} for update
        `
        const currentGraph = asJson(currentGraphEntry.graph)
        const next = mutate({ ...asJson(existing.document), ...clone(currentGraph) })
        if (!next) return undefined
        const timestamp = now()
        const nextGraph = canvasGraph(next)
        const graphChanged = !sameGraph(currentGraph, nextGraph)
        if (graphChanged && Number(currentGraphEntry.syncProtocolEpoch ?? 1) >= 2) {
          throw canvasSyncEpochStaleError(Number(currentGraphEntry.syncProtocolEpoch ?? 1))
        }
        const revision = Number(existing.revision) + 1
        const persistedDocument = stripAgentMessagesFromDocument(next)
        await tx`update projects set name = ${next.name}, document = ${tx.json(persistedDocument)}::jsonb, revision = ${revision}, updated_at = ${timestamp} where id = ${projectId}`
        let graphRevision = Number(currentGraphEntry.revision)
        if (graphChanged) {
          const [savedGraph] = await tx`
            update canvas_graphs
            set graph = ${tx.json(nextGraph)}::jsonb, revision = revision + 1, updated_at = ${timestamp}
            where project_id = ${projectId}
            returning revision
          `
          graphRevision = Number(savedGraph.revision)
        }
        await insertAudit(tx, { actorId: userId, action: 'project.updated', projectId, detail: { revision } })
        return {
          document: { ...stripAgentMessagesFromDocument(clone(next)), ...(graphChanged ? nextGraph : currentGraph) },
          revision,
          graphRevision,
          syncProtocolEpoch: Number(currentGraphEntry.syncProtocolEpoch ?? 1),
          created: false,
        }
      })
    },

    async writeProject(userId, document, expectedRevision, expectedGraphRevision) {
      return sql.begin(async (tx) => {
        const [existing] = await tx`
          select p.id, p.revision, p.document, m.role
          from projects p left join project_members m on m.project_id = p.id and m.user_id = ${userId}
          where p.id = ${document.id}
          for update of p
        `
        const timestamp = now()
        if (existing) {
          assertProjectPermission(existing.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
          if (Number.isInteger(expectedRevision) && expectedRevision !== Number(existing.revision)) {
            throw productError('项目已被其他成员更新，请刷新后再保存。', 'PROJECT_CONFLICT')
          }
          await ensureCanvasGraph(tx, document.id)
          const [currentGraphEntry] = await tx`
            select graph, revision, sync_protocol_epoch as "syncProtocolEpoch"
            from canvas_graphs where project_id = ${document.id} for update
          `
          const currentGraph = asJson(currentGraphEntry.graph)
          const nextGraph = canvasGraph(document)
          const graphChanged = !sameGraph(currentGraph, nextGraph)
          if (graphChanged && Number(currentGraphEntry.syncProtocolEpoch ?? 1) >= 2) {
            throw canvasSyncEpochStaleError(Number(currentGraphEntry.syncProtocolEpoch ?? 1))
          }
          if (graphChanged && Number.isInteger(expectedGraphRevision) && expectedGraphRevision !== Number(currentGraphEntry.revision)) {
            throw productError('画布已被其他成员更新，请刷新后再保存。', 'CANVAS_GRAPH_CONFLICT')
          }
          const revision = Number(existing.revision) + 1
          await syncAgentState(tx, userId, document, asJson(existing.document))
          const persistedDocument = stripAgentMessagesFromDocument(document)
          await tx`update projects set name = ${document.name}, document = ${tx.json(persistedDocument)}::jsonb, revision = ${revision}, updated_at = ${timestamp} where id = ${document.id}`
          let graphRevision = Number(currentGraphEntry.revision)
          if (graphChanged) {
            const [savedGraph] = await tx`
              update canvas_graphs
              set graph = ${tx.json(nextGraph)}::jsonb, revision = revision + 1, updated_at = ${timestamp}
              where project_id = ${document.id}
              returning revision
            `
            graphRevision = Number(savedGraph.revision)
          }
          await insertAudit(tx, { actorId: userId, action: 'project.updated', projectId: document.id, detail: { revision } })
          return {
            document: { ...stripAgentMessagesFromDocument(clone(document)), ...(graphChanged ? nextGraph : currentGraph) },
            revision,
            graphRevision,
            syncProtocolEpoch: Number(currentGraphEntry.syncProtocolEpoch ?? 1),
            created: false,
          }
        }

        await tx`insert into projects (id, name, document, revision, created_at, updated_at) values (${document.id}, ${document.name}, ${tx.json(stripAgentMessagesFromDocument(document))}::jsonb, 1, ${timestamp}, ${timestamp})`
        await tx`insert into project_members (project_id, user_id, role, added_at) values (${document.id}, ${userId}, 'owner', ${timestamp})`
        await tx`
          insert into canvas_graphs (project_id, graph, revision, updated_at)
          values (${document.id}, ${tx.json(canvasGraph(document))}::jsonb, 1, ${timestamp})
        `
        await syncAgentState(tx, userId, document)
        await insertAudit(tx, { actorId: userId, action: 'project.created', projectId: document.id })
        return { document: stripAgentMessagesFromDocument(clone(document)), revision: 1, graphRevision: 1, syncProtocolEpoch: 1, created: true }
      })
    },

    async deleteProject(userId, projectId) {
      return sql.begin(async (tx) => {
        const [member] = await tx`select role from project_members where project_id = ${projectId} and user_id = ${userId} for update`
        if (!member) return false
        assertProjectPermission(member.role, 'delete-project', 'PROJECT_DELETE_FORBIDDEN')
        const [project] = await tx`select name from projects where id = ${projectId} for update`
        if (!project) return false
        await tx`delete from media_objects where project_id = ${projectId}`
        await tx`delete from projects where id = ${projectId}`
        await insertAudit(tx, { actorId: userId, action: 'project.deleted', targetId: projectId, detail: { name: project.name } })
        return true
      })
    },

    async addProjectMember(actorId, projectId, userId, role) {
      return sql.begin(async (tx) => {
        const [member] = await tx`select role from project_members where project_id = ${projectId} and user_id = ${actorId} for update`
        assertProjectPermission(member?.role, 'manage-members', 'PROJECT_MEMBER_FORBIDDEN')
        const [user] = await tx`select id from app_users where id = ${userId}`
        if (!user) throw productError('未找到成员。', 'USER_NOT_FOUND')
        await tx`
          insert into project_members (project_id, user_id, role, added_at)
          values (${projectId}, ${userId}, ${role}, ${now()})
          on conflict (project_id, user_id) do update set role = excluded.role
        `
        await tx`update projects set revision = revision + 1, updated_at = ${now()} where id = ${projectId}`
        await insertAudit(tx, { actorId, action: 'project.member.upserted', projectId, targetId: userId, detail: { role } })
      })
    },

    async loadCanvasCollaboration(userId, projectId) {
      return sql.begin(async (tx) => {
        const [member] = await tx`select role from project_members where project_id = ${projectId} and user_id = ${userId}`
        if (!member) return undefined
        await ensureCanvasGraph(tx, projectId)
        const [entry] = await tx`
          select graph, revision as "graphRevision", sync_protocol_epoch as "syncProtocolEpoch",
            yjs_snapshot as snapshot, updated_at as "updatedAt"
          from canvas_graphs where project_id = ${projectId} for share
        `
        if (!entry) return undefined
        const updates = await tx`
          select update_base64 as update from canvas_graph_updates
          where project_id = ${projectId} and update_base64 is not null
          order by graph_revision asc nulls first, id asc
        `
        return {
          graph: asJson(entry.graph),
          graphRevision: Number(entry.graphRevision),
          syncProtocolEpoch: Number(entry.syncProtocolEpoch ?? 1),
          snapshot: entry.snapshot ?? undefined,
          updates: updates.map((item) => item.update),
          updatedAt: Number(entry.updatedAt),
        }
      })
    },

    async appendCanvasGraphUpdate(userId, projectId, input) {
      const { update, graph, mutationId, payloadHash, expectedGraphRevision, syncProtocolEpoch } = normalizeCanvasGraphMutation(input)
      return sql.begin(async (tx) => {
        const [member] = await tx`select role from project_members where project_id = ${projectId} and user_id = ${userId}`
        assertProjectPermission(member?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
        await ensureCanvasGraph(tx, projectId)
        const [current] = await tx`
          select revision as "graphRevision", sync_protocol_epoch as "syncProtocolEpoch", updated_at as "updatedAt"
          from canvas_graphs where project_id = ${projectId} for update
        `
        if (Number(current.syncProtocolEpoch ?? 1) >= 2 && syncProtocolEpoch !== Number(current.syncProtocolEpoch)) {
          throw canvasSyncEpochStaleError(Number(current.syncProtocolEpoch))
        }
        const [committed] = await tx`
          select graph_revision as "mutationRevision", payload_sha256 as "payloadHash", update_base64 as "update"
          from canvas_graph_updates where project_id = ${projectId} and mutation_id = ${mutationId}
        `
        const [{ count: updateCount }] = await tx`
          select count(*)::int as count from canvas_graph_updates
          where project_id = ${projectId} and update_base64 is not null
        `
        if (committed) {
          if (committed.payloadHash !== payloadHash) {
            throw productError('画布协作提交身份已绑定到其他更新。', canvasMutationConflictCode)
          }
          return {
            graphRevision: Number(current.graphRevision),
            mutationRevision: Number(committed.mutationRevision ?? current.graphRevision),
            updatedAt: Number(current.updatedAt),
            updateCount: Number(updateCount),
            duplicate: true,
            ...(committed.update ? { update: committed.update } : {}),
          }
        }
        if (Number.isInteger(expectedGraphRevision) && expectedGraphRevision !== Number(current.graphRevision)) {
          throw productError('画布已被其他成员更新，请重新同步。', canvasGraphConflictCode)
        }
        const timestamp = now()
        const [entry] = await tx`
          update canvas_graphs
          set graph = ${tx.json(graph)}::jsonb, revision = revision + 1, updated_at = ${timestamp}
          where project_id = ${projectId} and revision = ${Number(current.graphRevision)}
          returning revision as "graphRevision"
        `
        if (!entry) throw productError('画布已被其他成员更新，请重新同步。', canvasGraphConflictCode)
        await tx`
          insert into canvas_graph_updates (
            project_id, update_base64, mutation_id, graph_revision, payload_sha256, created_at
          ) values (
            ${projectId}, ${update}, ${mutationId}, ${Number(entry.graphRevision)}, ${payloadHash}, ${timestamp}
          )
        `
        return {
          graphRevision: Number(entry.graphRevision),
          mutationRevision: Number(entry.graphRevision),
          updatedAt: timestamp,
          updateCount: Number(updateCount) + 1,
          duplicate: false,
        }
      })
    },

    async compactCanvasGraphUpdates(userId, projectId, { snapshot, graph, expectedGraphRevision }) {
      if (typeof snapshot !== 'string' || !snapshot || !Array.isArray(graph?.nodes) || !Array.isArray(graph?.edges)) {
        throw new TypeError('画布协作快照格式无效。')
      }
      if (expectedGraphRevision !== undefined
        && (!Number.isInteger(expectedGraphRevision) || expectedGraphRevision < 1)) {
        throw new TypeError('画布协作 expectedGraphRevision 无效。')
      }
      return sql.begin(async (tx) => {
        const [member] = await tx`select role from project_members where project_id = ${projectId} and user_id = ${userId}`
        assertProjectPermission(member?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
        await ensureCanvasGraph(tx, projectId)
        const [current] = await tx`
          select revision as "graphRevision" from canvas_graphs where project_id = ${projectId} for update
        `
        if (Number.isInteger(expectedGraphRevision) && expectedGraphRevision !== Number(current.graphRevision)) {
          throw productError('画布已被其他成员更新，请重新同步。', canvasGraphConflictCode)
        }
        const timestamp = now()
        const [entry] = await tx`
          update canvas_graphs
          set graph = ${tx.json(graph)}::jsonb, yjs_snapshot = ${snapshot}, updated_at = ${timestamp}
          where project_id = ${projectId} and revision = ${Number(current.graphRevision)}
          returning revision as "graphRevision"
        `
        if (!entry) throw productError('画布已被其他成员更新，请重新同步。', canvasGraphConflictCode)
        await tx`
          update canvas_graph_updates set update_base64 = null, compacted_at = ${timestamp}
          where project_id = ${projectId} and update_base64 is not null
            and (graph_revision is null or graph_revision <= ${Number(entry.graphRevision)})
        `
        return { graphRevision: Number(entry.graphRevision), updatedAt: timestamp }
      })
    },

    async readGlobalAssetLibrary(userId, id) {
      const [access] = await sql`select 1 from app_users where id = ${userId} and status <> 'disabled'`
      if (!access) return undefined
      const [row] = await sql`select library from global_asset_libraries where id = ${id}`
      return row ? asJson(row.library) : undefined
    },

    async writeGlobalAssetLibrary(userId, library) {
      const [user] = await sql`select role, status from app_users where id = ${userId}`
      assertWorkspacePermission(user, 'manage-library', 'LIBRARY_WRITE_FORBIDDEN')
      await sql`
        insert into global_asset_libraries (id, library, updated_at)
        values (${library.id}, ${sql.json(library)}::jsonb, ${now()})
        on conflict (id) do update set library = excluded.library, updated_at = excluded.updated_at
      `
      await insertAudit(sql, { actorId: userId, action: 'brand-library.updated', targetId: library.id })
      return clone(library)
    },

    async deleteGlobalAsset(userId, assetId) {
      const [user] = await sql`select role, status from app_users where id = ${userId}`
      assertWorkspacePermission(user, 'manage-library', 'LIBRARY_WRITE_FORBIDDEN')
      return sql.begin(async (tx) => {
        const [row] = await tx`select library from global_asset_libraries where id = 'global-brand-assets' for update`
        if (!row) return { deleted: false, library: undefined }
        const currentLibrary = asJson(row.library)
        const assets = currentLibrary.assets.filter((asset) => asset.id !== assetId)
        const deleted = assets.length !== currentLibrary.assets.length
        const library = deleted ? { ...currentLibrary, assets, updatedAt: now() } : currentLibrary
        if (deleted) {
          await tx`update global_asset_libraries set library = ${tx.json(library)}::jsonb, updated_at = ${now()} where id = 'global-brand-assets'`
          await insertAudit(tx, { actorId: userId, action: 'brand-asset.deleted', targetId: assetId })
        }
        return { deleted, library: clone(library) }
      })
    },

    async readAgentState(userId, projectId, options = {}) {
      if (!await memberRole(projectId, userId)) return undefined
      const state = await readAgentStateRows(sql, projectId, userId, options)
      const hydrated = mergeAgentStateIntoDocument({ agentSessions: [], agentMemory: [], agentRuns: [] }, state)
      return { sessions: hydrated.agentSessions, memory: hydrated.agentMemory, runs: hydrated.agentRuns }
    },

    async listAgentSessions(userId, projectId, options = {}) {
      if (!await memberRole(projectId, userId)) return undefined
      const limit = normalizeAgentSessionListLimit(options.limit)
      const state = await readAgentStateRows(sql, projectId, userId, {
        includeMessages: false,
        includeSubagents: options.includeSubagents === true,
      })
      return state.sessions.slice(0, limit).map((session) => ({ ...session, messages: [] }))
    },

    async readAgentSession(userId, projectId, sessionId, options = {}) {
      if (!await memberRole(projectId, userId)) return undefined
      const [row] = await sql`
        select payload from agent_sessions
        where project_id = ${projectId} and id = ${sessionId}
          and (${options.includeSubagents === true} or coalesce(payload->>'kind', 'primary') <> 'subagent')
      `
      return row ? { ...asPayload(row), messages: [] } : undefined
    },

    async listAgentSessionMessages(userId, projectId, sessionId, options = {}) {
      if (!await memberRole(projectId, userId)) return undefined
      const [sessionRow] = await sql`select 1 from agent_sessions where project_id = ${projectId} and id = ${sessionId}`
      if (!sessionRow) return undefined
      const page = agentMessageListOptions(options)
      const rows = page.before
        ? await sql`
            select id, updated_at as "updatedAt", payload from agent_messages
            where project_id = ${projectId} and session_id = ${sessionId}
              and (updated_at < ${page.before.updatedAt}
                or (updated_at = ${page.before.updatedAt} and id < ${page.before.id}))
            order by updated_at desc, id desc limit ${page.limit}
          `
        : await sql`
            select id, updated_at as "updatedAt", payload from agent_messages
            where project_id = ${projectId} and session_id = ${sessionId}
            order by updated_at desc, id desc limit ${page.limit}
          `
      const messages = rows.map((row) => asPayload(row)).reverse()
      const oldest = rows.at(-1)
      return {
        messages,
        nextBefore: rows.length === page.limit && oldest
          ? encodeAgentMessageCursor({ id: oldest.id, updatedAt: Number(oldest.updatedAt), createdAt: Number(oldest.updatedAt) })
          : undefined,
        readMetrics: { messageCount: messages.length },
      }
    },

    async listCollaborationActivities(userId, projectId, options = 100) {
      if (!await memberRole(projectId, userId)) return undefined
      const page = collaborationActivityListOptions(options)
      const [activities, receipts] = await Promise.all([
        page.before
          ? sql`select payload from collaboration_activities where project_id = ${projectId} and (occurred_at < ${page.before.occurredAt} or (occurred_at = ${page.before.occurredAt} and id < ${page.before.id})) order by occurred_at desc, id desc limit ${page.limit}`
          : sql`select payload from collaboration_activities where project_id = ${projectId} order by occurred_at desc, id desc limit ${page.limit}`,
        sql`select read_at as "readAt", cleared_at as "clearedAt", updated_at as "updatedAt" from collaboration_activity_receipts where user_id = ${userId} and project_id = ${projectId}`,
      ])
      return collaborationActivitiesForMember(activities.map((row) => asJson(row.payload)), receipts[0], userId, page)
    },

    async putCollaborationActivity(userId, projectId, input) {
      assertProjectPermission(await memberRole(projectId, userId), 'edit', 'PROJECT_WRITE_FORBIDDEN')
      return sql.begin(async (tx) => {
        const [existing] = await tx`select payload from collaboration_activities where project_id = ${projectId} and id = ${input?.id ?? ''}`
        if (existing) return asJson(existing.payload)
        const [actor] = await tx`select name from app_users where id = ${userId}`
        const activity = validateCollaborationActivity(input, { actorId: userId, actorName: actor?.name })
        await tx`
          insert into collaboration_activities (project_id, id, actor_id, occurred_at, payload)
          values (${projectId}, ${activity.id}, ${userId}, ${activity.occurredAt}, ${tx.json(activity)}::jsonb)
          on conflict (project_id, id) do nothing
        `
        const [stored] = await tx`select payload from collaboration_activities where project_id = ${projectId} and id = ${activity.id}`
        return asJson(stored.payload)
      })
    },

    async putCollaborationActivityReceipt(userId, projectId, input) {
      assertProjectPermission(await memberRole(projectId, userId), 'read', 'PROJECT_READ_FORBIDDEN')
      return sql.begin(async (tx) => {
        const [current] = await tx`select read_at as "readAt", cleared_at as "clearedAt" from collaboration_activity_receipts where user_id = ${userId} and project_id = ${projectId} for update`
        const receipt = nextCollaborationReceipt(current, input?.action)
        await tx`
          insert into collaboration_activity_receipts (user_id, project_id, read_at, cleared_at, updated_at)
          values (${userId}, ${projectId}, ${receipt.readAt}, ${receipt.clearedAt}, ${receipt.updatedAt})
          on conflict (user_id, project_id) do update set
            read_at = greatest(collaboration_activity_receipts.read_at, excluded.read_at),
            cleared_at = greatest(collaboration_activity_receipts.cleared_at, excluded.cleared_at),
            updated_at = greatest(collaboration_activity_receipts.updated_at, excluded.updated_at)
        `
        return receipt
      })
    },

    async putAgentSessionReadReceipt(userId, projectId, sessionId, input) {
      const role = await memberRole(projectId, userId)
      assertProjectPermission(role, 'read', 'PROJECT_READ_FORBIDDEN')
      const serverTime = now()
      const requestedTimestamp = input?.updatedAt === undefined
        ? serverTime
        : validateAgentEntityWriteTimestamp(input.updatedAt, { now: serverTime })
      const receipt = validateAgentSessionReadReceipt({ ...input, sessionId, updatedAt: requestedTimestamp }, { now: serverTime })
      return sql.begin(async (tx) => {
        const [session] = await tx`select id from agent_sessions where id = ${sessionId} and project_id = ${projectId}`
        if (!session) throw productError('未找到 Agent 会话。', 'AGENT_SESSION_NOT_FOUND')
        const [message] = await tx`select id from agent_messages where id = ${receipt.messageId} and project_id = ${projectId} and session_id = ${sessionId}`
        if (!message) throw productError('目标消息已不存在。', 'AGENT_MESSAGE_NOT_FOUND')
        const [existing] = await tx`
          select session_id as "sessionId", message_id as "messageId", updated_at as "updatedAt"
          from agent_session_read_receipts
          where user_id = ${userId} and project_id = ${projectId} and session_id = ${sessionId}
          for update
        `
        if (existing && Number(existing.updatedAt) >= receipt.updatedAt) {
          return { sessionId: existing.sessionId, messageId: existing.messageId, updatedAt: Number(existing.updatedAt) }
        }
        await tx`
          insert into agent_session_read_receipts (user_id, project_id, session_id, message_id, updated_at)
          values (${userId}, ${projectId}, ${sessionId}, ${receipt.messageId}, ${receipt.updatedAt})
          on conflict (user_id, project_id, session_id) do update set
            message_id = excluded.message_id,
            updated_at = excluded.updated_at
          where agent_session_read_receipts.updated_at < excluded.updated_at
        `
        return clone(receipt)
      })
    },

    async compareAndSetAgentSessionSettings(userId, projectId, command) {
      return sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${'agent-session:' + String(command?.sessionId ?? '')}, 0))`
        const [existing] = await tx`
          select project_id as "projectId", owner_id as "ownerId", payload
          from agent_sessions where id = ${command?.sessionId ?? ''} for update
        `
        if (existing && existing.projectId !== projectId) {
          throw productError('Agent 会话标识已被其他项目使用。', 'AGENT_SESSION_ID_CONFLICT')
        }
        const [member] = await tx`
          select role from project_members
          where project_id = ${projectId} and user_id = ${userId} for share
        `
        assertProjectPermission(member?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
        const decision = compareAndSetAgentSessionSettings(asPayload(existing), command, { now: now() })
        if (!decision.changed) return clone(decision)
        const session = decision.session
        await tx`
          insert into agent_sessions (id, owner_id, project_id, updated_at, payload)
          values (${session.id}, ${existing?.ownerId ?? userId}, ${projectId}, ${session.updatedAt}, ${tx.json(session)}::jsonb)
          on conflict (id) do update set updated_at = excluded.updated_at, payload = excluded.payload
        `
        await insertAudit(tx, {
          actorId: userId,
          action: decision.kind === 'created' ? 'agent-session.created' : 'agent-session.updated',
          projectId,
          targetId: session.id,
        })
        return clone(decision)
      })
    },

    async putAgentSession(userId, projectId, input) {
      const role = await memberRole(projectId, userId)
      assertProjectPermission(role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const timestampValue = now()
      let session = validateAgentSessionEntity({ ...input, updatedAt: timestampValue }, { now: timestampValue })
      await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${'agent-session:' + session.id}, 0))`
        const [existing] = await tx`select project_id as "projectId", payload from agent_sessions where id = ${session.id} for update`
        if (existing && existing.projectId !== projectId) throw productError('Agent 会话标识已被其他项目使用。', 'AGENT_SESSION_ID_CONFLICT')
        const previous = asPayload(existing)
        session = preserveAgentThreadSummary(previous, session)
        await tx`
          insert into agent_sessions (id, owner_id, project_id, updated_at, payload)
          values (${session.id}, ${userId}, ${projectId}, ${timestampValue}, ${tx.json(session)}::jsonb)
          on conflict (id) do update set updated_at = excluded.updated_at, payload = excluded.payload
        `
        await insertAudit(tx, { actorId: userId, action: existing ? 'agent-session.updated' : 'agent-session.created', projectId, targetId: session.id })
      })
      return clone(session)
    },

    async compareAndSetAgentThreadSummary(userId, command) {
      const inputDecision = agentThreadSummaryCompareAndSetDecision(undefined, command)
      if (inputDecision.kind === 'invalid') return clone(inputDecision)
      return sql.begin(async (tx) => {
        const [row] = await tx`
          select project_id as "projectId", payload
          from agent_sessions
          where id = ${command?.sessionId ?? ''}
          for update
        `
        if (!row) return clone(inputDecision)
        const [member] = await tx`
          select role
          from project_members
          where project_id = ${row.projectId} and user_id = ${userId}
          for share
        `
        assertProjectPermission(member?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
        const decision = agentThreadSummaryCompareAndSetDecision(asPayload(row), command)
        if (!decision.changed) return clone(decision)
        await tx`
          update agent_sessions
          set payload = jsonb_set(payload, '{threadSummary}', ${tx.json(decision.session.threadSummary)}::jsonb, true)
          where id = ${command.sessionId}
        `
        return clone(decision)
      })
    },

    async readAgentContextState(userId, projectId, sessionId) {
      if (!await memberRole(projectId, userId)) return undefined
      const [session] = await sql`
        select 1 from agent_sessions where id = ${sessionId} and project_id = ${projectId}
      `
      if (!session) return undefined
      const [row] = await sql`
        select payload from agent_context_states
        where session_id = ${sessionId} and project_id = ${projectId}
      `
      return row ? asPayload(row) : {
        version: 2, sessionId, projectId, revision: 0, updatedAt: 0,
      }
    },

    async listAgentContextCompactions(userId, projectId, sessionId, options = {}) {
      if (!await memberRole(projectId, userId)) return undefined
      const [session] = await sql`
        select 1 from agent_sessions where id = ${sessionId} and project_id = ${projectId}
      `
      if (!session) return undefined
      const page = normalizeAgentContextCompactionPage(options)
      const rows = await sql`
        select sequence, created_at as "createdAt", payload
        from agent_context_compactions
        where project_id = ${projectId} and session_id = ${sessionId}
          and compaction_id is not null and sequence > ${page.afterSequence}
        order by sequence asc
        limit ${page.limit}
      `
      const compactions = rows
        .map((row) => publicAgentContextCompaction({
          ...asPayload(row), sequence: Number(row.sequence), createdAt: Number(row.createdAt),
        }))
        .filter(Boolean)
      return {
        compactions,
        ...(compactions.length === page.limit
          ? { nextAfterSequence: compactions.at(-1)?.sequence }
          : {}),
      }
    },

    async compareAndSetAgentContextState(userId, rawCommand) {
      let command
      try {
        command = materializeAgentContextCommand(rawCommand)
      } catch {
        return { kind: 'invalid', changed: false }
      }
      return sql.begin(async (tx) => {
        const [session] = await tx`
          select owner_id as "ownerId", project_id as "projectId"
          from agent_sessions
          where id = ${command.sessionId} and project_id = ${command.projectId}
          for update
        `
        if (!session) return { kind: 'not_found', changed: false }
        const [member] = await tx`
          select role from project_members
          where project_id = ${command.projectId} and user_id = ${userId}
          for share
        `
        assertProjectPermission(member?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
        const [clock] = await tx`
          select floor(extract(epoch from clock_timestamp()) * 1000)::bigint as "observedAt"
        `
        const [stateRow] = await tx`
          select owner_id as "ownerId", payload from agent_context_states
          where session_id = ${command.sessionId} for update
        `
        const [replayRow] = await tx`
          select request_hash as "requestHash", payload from agent_context_compactions
          where session_id = ${command.sessionId} and idempotency_key = ${command.idempotencyKey}
        `
        const decision = agentContextStateCompareAndSetDecision({
          state: asPayload(stateRow),
          replayEntry: replayRow ? {
            ...asPayload(replayRow), requestHash: replayRow.requestHash,
          } : undefined,
          command,
          ownerId: stateRow?.ownerId ?? session.ownerId,
          observedAt: Number(clock.observedAt),
        })
        if (!decision.changed) return clone(decision)
        const ledger = decision.ledgerEntry
        await tx`
          insert into agent_context_compactions (
            session_id, sequence, id, owner_id, project_id, idempotency_key,
            request_hash, compaction_id, created_at, payload
          ) values (
            ${ledger.sessionId}, ${ledger.sequence}, ${ledger.id}, ${ledger.ownerId},
            ${ledger.projectId}, ${ledger.idempotencyKey}, ${ledger.requestHash},
            ${ledger.compaction?.id ?? null}, ${ledger.createdAt}, ${tx.json(ledger)}::jsonb
          )
        `
        await tx`
          insert into agent_context_states (
            session_id, owner_id, project_id, revision, head_compaction_id,
            head_compaction_sequence, updated_at, payload
          ) values (
            ${command.sessionId}, ${ledger.ownerId}, ${command.projectId}, ${decision.state.revision},
            ${decision.state.headCompactionId ?? null}, ${decision.state.headCompactionSequence ?? null},
            ${decision.state.updatedAt}, ${tx.json(decision.state)}::jsonb
          )
          on conflict (session_id) do update set
            revision = excluded.revision,
            head_compaction_id = excluded.head_compaction_id,
            head_compaction_sequence = excluded.head_compaction_sequence,
            updated_at = excluded.updated_at,
            payload = excluded.payload
        `
        const { ledgerEntry: _ledgerEntry, ...publicDecision } = decision
        return clone(publicDecision)
      })
    },

    async putAgentMessage(userId, projectId, sessionId, input) {
      const role = await memberRole(projectId, userId)
      assertProjectPermission(role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const timestampValue = now()
      let message = validateAgentMessageEntity(input, { now: timestampValue })
      await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${'agent-message:' + message.id}, 0))`
        const [sessionRow] = await tx`select payload from agent_sessions where id = ${sessionId} and project_id = ${projectId} for update`
        if (!sessionRow) throw productError('未找到 Agent 会话。', 'AGENT_SESSION_NOT_FOUND')
        const [existing] = await tx`
          select project_id as "projectId", session_id as "sessionId", updated_at as "updatedAt", payload
          from agent_messages where id = ${message.id} for update
        `
        if (existing && (existing.projectId !== projectId || existing.sessionId !== sessionId)) {
          throw productError('Agent 消息标识已被其他会话使用。', 'AGENT_MESSAGE_ID_CONFLICT')
        }
        const merged = mergeAgentMessageForWrite(asPayload(existing), message, {
          currentUpdatedAt: existing ? Number(existing.updatedAt) : undefined,
          incomingUpdatedAt: message.updatedAt,
        })
        message = merged.message
        const storedUpdatedAt = merged.updatedAt
        await tx`
          insert into agent_messages (id, owner_id, project_id, session_id, updated_at, payload)
          values (${message.id}, ${userId}, ${projectId}, ${sessionId}, ${storedUpdatedAt}, ${tx.json(message)}::jsonb)
          on conflict (id) do update set
            updated_at = excluded.updated_at,
            payload = excluded.payload
        `
        await tx`
          update agent_sessions
          set updated_at = greatest(updated_at, ${storedUpdatedAt}),
              payload = jsonb_set(payload, '{updatedAt}', to_jsonb(greatest(updated_at, ${storedUpdatedAt})::bigint), true)
          where id = ${sessionId}
        `
        await upsertArtifactRecords(tx, userId, projectId, artifactsFromAgentMessage(message, { sessionId, updatedAt: storedUpdatedAt }))
        await insertAudit(tx, { actorId: userId, action: existing ? 'agent-message.updated' : 'agent-message.created', projectId, targetId: message.id, detail: { sessionId } })
      })
      return clone(message)
    },

    async putAgentMemoryItem(userId, projectId, input) {
      const role = await memberRole(projectId, userId)
      assertProjectPermission(role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const serverTime = now()
      const requestedTimestamp = input?.updatedAt === undefined
        ? serverTime
        : validateAgentEntityWriteTimestamp(input.updatedAt, { now: serverTime })
      const memory = validateAgentMemoryEntity({ ...input, updatedAt: requestedTimestamp }, { now: serverTime })
      const timestampValue = validateAgentEntityWriteTimestamp(memory.updatedAt, { now: serverTime })
      return sql.begin(async (tx) => {
        const [existing] = await tx`
          select project_id as "projectId", updated_at as "updatedAt", deleted_at as "deletedAt", payload
          from agent_memory_items where id = ${memory.id} for update
        `
        if (existing && existing.projectId !== projectId) throw productError('Agent 记忆标识已被其他项目使用。', 'AGENT_MEMORY_ID_CONFLICT')
        if (existing?.deletedAt) throw productError('该 Agent 记忆已删除，请创建新的记忆。', 'AGENT_MEMORY_DELETED')
        if (existing && !shouldApplyAgentEntityWrite(existing, memory, { tombstoneWinsTie: true })) {
          return clone(existing.payload)
        }
        await tx`
          insert into agent_memory_items (id, owner_id, project_id, updated_at, deleted_at, payload)
          values (${memory.id}, ${userId}, ${projectId}, ${timestampValue}, null, ${tx.json(memory)}::jsonb)
          on conflict (id) do update set updated_at = excluded.updated_at, deleted_at = null, payload = excluded.payload
          where agent_memory_items.project_id = excluded.project_id
            and (
              agent_memory_items.updated_at < excluded.updated_at
              or (
                agent_memory_items.updated_at = excluded.updated_at
                and agent_memory_items.deleted_at is null
              )
            )
        `
        await insertAudit(tx, { actorId: userId, action: existing ? 'agent-memory.updated' : 'agent-memory.created', projectId, targetId: memory.id })
        return clone(memory)
      })
    },

    async deleteAgentMemoryItem(userId, projectId, memoryId) {
      const role = await memberRole(projectId, userId)
      assertProjectPermission(role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      return sql.begin(async (tx) => {
        const [existing] = await tx`select id from agent_memory_items where id = ${memoryId} and project_id = ${projectId} and deleted_at is null for update`
        if (!existing) return false
        const timestampValue = now()
        await tx`update agent_memory_items set deleted_at = ${timestampValue}, updated_at = ${timestampValue} where id = ${memoryId}`
        await insertAudit(tx, { actorId: userId, action: 'agent-memory.deleted', projectId, targetId: memoryId })
        return true
      })
    },

    async listAgentArtifacts(userId, projectId, { limit = 100, before } = {}) {
      if (!await memberRole(projectId, userId)) return undefined
      const maximum = Math.max(1, Math.min(Number(limit) || 100, artifactIndexLimits.page))
      const beforeTimestamp = Number.isFinite(Number(before?.createdAt)) ? Number(before.createdAt) : Number.MAX_SAFE_INTEGER
      const beforeId = typeof before?.id === 'string' ? before.id : undefined
      const rows = beforeId === undefined
        ? await sql`
          select artifact.payload, artifact.created_at as "indexCreatedAt" from agent_artifacts artifact
          where artifact.project_id = ${projectId} and artifact.created_at < ${beforeTimestamp}
          order by artifact.created_at desc, artifact.id asc
          limit ${maximum}
        `
        : await sql`
          select artifact.payload, artifact.created_at as "indexCreatedAt" from agent_artifacts artifact
          where artifact.project_id = ${projectId}
            and (artifact.created_at < ${beforeTimestamp}
              or (artifact.created_at = ${beforeTimestamp} and artifact.id > ${beforeId}))
          order by artifact.created_at desc, artifact.id asc
          limit ${maximum}
        `
      return rows.map((row) => ({ ...asPayload(row), createdAt: Number(row.indexCreatedAt) }))
    },

    async putAgentSkill(userId, skill) {
      return sql.begin(async (tx) => {
        // Skill ID 是全局唯一身份。咨询锁同时保护「行还不存在」的首版竞争；
        // 已存在行再用 for update 把读取、历史前缀校验与写入固定在同一事务。
        await tx`select pg_advisory_xact_lock(hashtextextended(${skill.id}, 11))`
        const [membership] = await tx`
          select role from project_members
          where project_id = ${skill.projectId} and user_id = ${userId}
          for share
        `
        assertProjectPermission(membership?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
        const [existing] = await tx`
          select project_id as "projectId", payload
          from agent_skills where id = ${skill.id}
          for update
        `
        if (existing && existing.projectId !== skill.projectId) {
          throw productError('Skill 标识已被其他项目使用。', 'AGENT_SKILL_ID_CONFLICT')
        }
        const previous = asPayload(existing)
        const decision = agentSkillPersistenceDecision(previous, skill, { ownerId: userId })
        if (decision.kind === 'replay') return clone(previous)
        const payload = decision.payload
        const timestamp = Number.isFinite(Number(payload.updatedAt)) ? Number(payload.updatedAt) : now()
        await tx`
          insert into agent_skills (id, owner_id, project_id, status, updated_at, payload)
          values (${skill.id}, ${userId}, ${skill.projectId}, ${payload.status}, ${timestamp}, ${tx.json(payload)}::jsonb)
          on conflict (id) do update set
            status = excluded.status,
            updated_at = excluded.updated_at,
            payload = excluded.payload
        `
        await insertAudit(tx, {
          actorId: userId,
          action: existing ? 'agent-skill.updated' : 'agent-skill.created',
          projectId: skill.projectId,
          targetId: skill.id,
        })
        return clone(payload)
      })
    },

    async listAgentSkills(userId, projectId) {
      if (!await memberRole(projectId, userId)) return undefined
      const rows = await sql`
        select s.payload from agent_skills s join project_members m on m.project_id = s.project_id
        where s.project_id = ${projectId} and s.status = 'active' and m.user_id = ${userId}
        order by s.updated_at desc
      `
      return rows.map(asPayload)
    },

    async readAgentSkillVersion(userId, projectId, skillId, version) {
      if (!await memberRole(projectId, userId)) return undefined
      const [row] = await sql`
        select payload from agent_skills
        where project_id = ${projectId} and id = ${skillId}
      `
      const snapshot = persistedAgentSkillVersion(asPayload(row), version)
      return snapshot ? clone({ projectId, skillId, ...snapshot }) : undefined
    },

    async putAgentActionReceipt(userId, receipt) {
      return sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${receipt.id}, 2))`
        const [membership] = await tx`
          select role from project_members
          where project_id = ${receipt.projectId} and user_id = ${userId}
          for share
        `
        assertProjectPermission(membership?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
        const [existing] = await tx`
          select owner_id as "ownerId", project_id as "projectId", payload
          from agent_action_receipts where id = ${receipt.id} for update
        `
        if (existing && (existing.ownerId !== userId || existing.projectId !== receipt.projectId)) {
          throw productError('Agent 行动回执冲突。', 'AGENT_ACTION_RECEIPT_CONFLICT')
        }
        // 旧完成写入只能首次插入，不能覆盖 claim/settle 管理的执行状态。
        if (existing) return clone(asPayload(existing))
        const payload = { ...clone(receipt), ownerId: userId }
        await tx`
          insert into agent_action_receipts (id, owner_id, project_id, created_at, payload)
          values (${receipt.id}, ${userId}, ${receipt.projectId}, ${receipt.createdAt}, ${tx.json(payload)}::jsonb)
        `
        await upsertArtifactRecords(tx, userId, receipt.projectId, artifactsFromActionReceipt(receipt))
        await insertAudit(tx, { actorId: userId, action: 'agent-action.succeeded', projectId: receipt.projectId, targetId: receipt.id, detail: { toolCallId: receipt.toolCallId } })
        return clone(payload)
      })
    },

    async readAgentActionReceipt(userId, receiptId) {
      const [row] = await sql`
        select receipt.payload from agent_action_receipts receipt
        join project_members member on member.project_id = receipt.project_id
        where receipt.id = ${receiptId} and receipt.owner_id = ${userId} and member.user_id = ${userId}
      `
      return asPayload(row)
    },

    async claimAgentActionReceipt(userId, claim) {
      if (typeof claim?.leaseToken !== 'string' || !claim.leaseToken.trim()) {
        throw productError('Agent 行动执行租约无效。', 'AGENT_ACTION_RECEIPT_INVALID')
      }
      return sql.begin(async (tx) => {
        // 缺失行也要串行化；只锁现有行无法阻止两个 API 实例同时首次执行副作用。
        await tx`select pg_advisory_xact_lock(hashtextextended(${claim.id}, 2))`
        const [membership] = await tx`
          select role from project_members
          where project_id = ${claim.projectId} and user_id = ${userId}
          for share
        `
        assertProjectPermission(membership?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
        const [clock] = await tx`
          select floor(extract(epoch from clock_timestamp()) * 1000)::bigint as "observedAt"
        `
        const observedAt = Number(clock.observedAt)
        const leaseDurationMs = Math.max(1_000, Math.min(Number(claim.leaseDurationMs) || 60_000, 900_000))
        const authoritativeClaim = {
          ...clone(claim),
          createdAt: observedAt,
          updatedAt: observedAt,
          leaseDurationMs,
          leaseExpiresAt: observedAt + leaseDurationMs,
        }
        const [row] = await tx`
          select owner_id as "ownerId", project_id as "projectId", payload
          from agent_action_receipts where id = ${claim.id} for update
        `
        if (row && (row.ownerId !== userId || row.projectId !== claim.projectId)) {
          return { kind: 'conflict' }
        }
        const existing = asPayload(row)
        const decision = agentActionReceiptClaimDecision(existing, { ...authoritativeClaim, ownerId: userId })
        if (decision.changed) {
          await tx`
            insert into agent_action_receipts (id, owner_id, project_id, created_at, payload)
            values (${claim.id}, ${userId}, ${claim.projectId}, ${decision.receipt.createdAt}, ${tx.json(decision.receipt)}::jsonb)
            on conflict (id) do update set payload = excluded.payload
            where agent_action_receipts.owner_id = excluded.owner_id
              and agent_action_receipts.project_id = excluded.project_id
          `
        }
        return clone({ kind: decision.kind, receipt: decision.receipt })
      })
    },

    async settleAgentActionReceipt(userId, settlement) {
      if (typeof settlement?.leaseToken !== 'string' || !settlement.leaseToken.trim()) {
        throw productError('Agent 行动执行租约无效。', 'AGENT_ACTION_RECEIPT_INVALID')
      }
      return sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${settlement.id}, 2))`
        const [row] = await tx`
          select owner_id as "ownerId", project_id as "projectId", payload
          from agent_action_receipts where id = ${settlement.id} for update
        `
        if (!row || row.ownerId !== userId || row.projectId !== settlement.projectId) {
          throw productError('未找到 Agent 行动回执。', 'AGENT_ACTION_RECEIPT_NOT_FOUND')
        }
        const existing = asPayload(row)
        if (existing.leaseToken === settlement.leaseToken && existing.status === settlement.status
          && ['succeeded', 'failed', 'uncertain'].includes(existing.status)) {
          return clone(existing)
        }
        if (existing.status !== 'running' || existing.leaseToken !== settlement.leaseToken) {
          throw productError('Agent 行动执行租约已失效。', 'AGENT_ACTION_LEASE_STALE')
        }
        if (!['succeeded', 'failed', 'uncertain'].includes(settlement.status)) {
          throw productError('Agent 行动回执状态无效。', 'AGENT_ACTION_RECEIPT_INVALID')
        }
        const receipt = settledAgentActionReceipt(existing, settlement)
        await tx`
          update agent_action_receipts set payload = ${tx.json(receipt)}::jsonb
          where id = ${settlement.id} and owner_id = ${userId} and project_id = ${settlement.projectId}
        `
        if (settlement.status === 'succeeded') {
          await upsertArtifactRecords(tx, userId, settlement.projectId, artifactsFromActionReceipt(receipt))
          await insertAudit(tx, { actorId: userId, action: 'agent-action.succeeded', projectId: settlement.projectId, targetId: settlement.id, detail: { toolCallId: receipt.toolCallId } })
        }
        return clone(receipt)
      })
    },

    async resolveAgentActionReceipt(userId, command) {
      return sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${command?.id ?? ''}, 2))`
        const [row] = await tx`
          select owner_id as "ownerId", project_id as "projectId", payload
          from agent_action_receipts where id = ${command?.id ?? ''} for update
        `
        if (!row || row.ownerId !== userId || row.projectId !== command?.projectId) {
          return { kind: 'not_found', changed: false }
        }
        const [membership] = await tx`
          select role from project_members
          where project_id = ${command.projectId} and user_id = ${userId}
          for share
        `
        assertProjectPermission(membership?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
        const [clock] = await tx`
          select floor(extract(epoch from clock_timestamp()) * 1000)::bigint as "observedAt"
        `
        const observedAt = Number(clock.observedAt)
        const requestedAuthorization = command?.manualRetryAuthorization
        const decision = agentActionReceiptResolutionDecision(asPayload(row), {
          ...clone(command), ownerId: userId, actorId: userId, resolvedAt: observedAt,
          ...(requestedAuthorization ? {
            manualRetryAuthorization: authoritativeAgentActionManualRetryAuthorization(
              requestedAuthorization,
              observedAt,
            ),
          } : {}),
        })
        if (decision.changed) {
          await tx`
            update agent_action_receipts set payload = ${tx.json(decision.receipt)}::jsonb
            where id = ${command.id} and owner_id = ${userId} and project_id = ${command.projectId}
          `
          await insertAudit(tx, {
            actorId: userId,
            action: 'agent-action.reconciled',
            projectId: command.projectId,
            targetId: command.id,
            createdAt: observedAt,
            detail: {
              result: decision.receipt.resolution.decision,
              status: decision.receipt.status,
              toolCallId: decision.receipt.toolCallId,
              toolName: decision.receipt.actionName,
            },
          })
        }
        return clone(decision)
      })
    },

    async consumeAgentActionManualRetryAuthorization(userId, command) {
      return sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${command?.id ?? ''}, 2))`
        const [row] = await tx`
          select owner_id as "ownerId", project_id as "projectId", payload
          from agent_action_receipts where id = ${command?.id ?? ''} for update
        `
        if (!row || row.ownerId !== userId || row.projectId !== command?.projectId) {
          return { kind: 'not_found', changed: false }
        }
        const [membership] = await tx`
          select role from project_members
          where project_id = ${command.projectId} and user_id = ${userId}
          for share
        `
        assertProjectPermission(membership?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
        const [clock] = await tx`
          select floor(extract(epoch from clock_timestamp()) * 1000)::bigint as "observedAt"
        `
        const observedAt = Number(clock.observedAt)
        const decision = agentActionManualRetryConsumptionDecision(asPayload(row), {
          ...clone(command), ownerId: userId, actorId: userId, consumedAt: observedAt,
        })
        if (decision.changed) {
          await tx`
            update agent_action_receipts set payload = ${tx.json(decision.receipt)}::jsonb
            where id = ${command.id} and owner_id = ${userId} and project_id = ${command.projectId}
          `
          await insertAudit(tx, {
            actorId: userId,
            action: 'agent-action.manual-retry-consumed',
            projectId: command.projectId,
            targetId: command.id,
            createdAt: observedAt,
            detail: {
              authorizationId: decision.authorization.id,
              retryReceiptId: decision.authorization.consumedByReceiptId,
              toolCallId: decision.receipt.toolCallId,
              toolName: decision.receipt.actionName,
            },
          })
        }
        return clone(decision)
      })
    },

    async putGenerationJob(userId, job, { updateAgentRun = true, recordAudit = true } = {}) {
      const decision = await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${job.id}, 4))`
        const locked = await lockedGenerationJob(tx, job.id)
        const observedAt = await generationObservedAt(tx)
        const incoming = { ...clone(job), ownerId: userId }
        const decision = generationJobPutDecision(locked?.job, incoming, { observedAt })
        if (decision.changed) await persistGenerationDecision(tx, decision.job)
        return clone(decision)
      })
      if (decision.changed) {
        await projectGenerationDecision(decision.job, { updateAgentRun, recordAudit, syncArtifacts: true })
      }
      return clone(decision.job)
    },

    async claimGenerationJobExecution(jobId, claim) {
      return sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${jobId}, 4))`
        const locked = await lockedGenerationJob(tx, jobId)
        const observedAt = await generationObservedAt(tx)
        const decision = generationJobExecutionClaimDecision(locked?.job, { ...clone(claim), observedAt })
        if (decision.changed) {
          await persistGenerationDecision(tx, decision.job)
        }
        return clone(decision)
      })
    },

    async commitGenerationJobExecution(userId, command) {
      const decision = await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${command?.id ?? ''}, 4))`
        const locked = await lockedGenerationJob(tx, command?.id ?? '')
        if (locked && locked.job.ownerId !== userId) return { kind: 'missing', changed: false }
        const observedAt = await generationObservedAt(tx)
        const decision = committedGenerationJobExecution(locked?.job, { ...clone(command), observedAt })
        if (decision.changed) {
          await persistGenerationDecision(tx, decision.job)
        }
        return clone(decision)
      })
      if (decision.changed) {
        await projectGenerationDecision(decision.job, {
          updateAgentRun: command.updateAgentRun !== false,
          recordAudit: command.recordAudit !== false,
          syncArtifacts: false,
        })
      }
      return decision
    },

    async cancelGenerationJobExecution(userId, command) {
      const decision = await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${command?.id ?? ''}, 4))`
        const locked = await lockedGenerationJob(tx, command?.id ?? '')
        if (locked && locked.job.ownerId !== userId) return { kind: 'missing', changed: false }
        const observedAt = await generationObservedAt(tx)
        const decision = requestedGenerationJobCancellation(locked?.job, { ...clone(command), observedAt })
        if (decision.changed) await persistGenerationDecision(tx, decision.job)
        return clone(decision)
      })
      if (decision.changed) await projectGenerationDecision(decision.job)
      return decision
    },

    async acknowledgeGenerationJobCancellation(userId, command) {
      return sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${command?.id ?? ''}, 4))`
        const locked = await lockedGenerationJob(tx, command?.id ?? '')
        if (locked && locked.job.ownerId !== userId) return { kind: 'missing', changed: false }
        const observedAt = await generationObservedAt(tx)
        const decision = acknowledgedGenerationJobCancellation(locked?.job, { ...clone(command), observedAt })
        if (decision.changed) await persistGenerationDecision(tx, decision.job)
        return clone(decision)
      })
    },

    async compareAndSetGenerationJob(userId, command) {
      const decision = await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${command?.id ?? ''}, 4))`
        const locked = await lockedGenerationJob(tx, command?.id ?? '')
        if (locked && locked.job.ownerId !== userId) return { kind: 'missing', changed: false }
        const observedAt = await generationObservedAt(tx)
        const decision = comparedAndSetGenerationJob(locked?.job, { ...clone(command), observedAt })
        if (decision.changed) {
          await persistGenerationDecision(tx, decision.job)
        }
        return clone(decision)
      })
      if (decision.changed) {
        await projectGenerationDecision(decision.job, {
          updateAgentRun: command.updateAgentRun !== false,
          recordAudit: command.recordAudit !== false,
          syncArtifacts: true,
        })
      }
      return decision
    },

    async refreshGenerationArtifacts(userId, jobId) {
      return refreshGenerationArtifactRecords(userId, jobId)
    },

    async putAgentRun(userId, run) {
      const role = await memberRole(run.projectId, userId)
      assertProjectPermission(role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const payload = { ...clone(run), ownerId: userId, updatedAt: Number(run.updatedAt) || now() }
      return sql.begin(async (tx) => {
        // 行尚未创建时 SELECT ... FOR UPDATE 无法加锁；同一 runId 先获取事务级咨询锁，
        // 让首次创建与后续更新共用同一条串行化写入路径。
        await tx`select pg_advisory_xact_lock(hashtextextended(${run.id}, 0))`
        const [existing] = await tx`
          select owner_id as "ownerId", project_id as "projectId", status, updated_at as "updatedAt", payload
          from agent_runs where id = ${run.id} for update
        `
        if (existing && (existing.projectId !== run.projectId || existing.ownerId !== userId)) {
          throw productError('Agent Run 标识已被其他项目使用。', 'AGENT_RUN_ID_CONFLICT')
        }
        const bindingDecision = idempotencyRequestBindingWriteDecision(asPayload(existing), payload)
        if (bindingDecision.kind === 'conflict') {
          throw productError('Agent Run 幂等请求绑定冲突。', 'IDEMPOTENCY_BINDING_CONFLICT')
        }
        if (bindingDecision.binding) payload.idempotencyBinding = clone(bindingDecision.binding)
        if (existing && !shouldApplyAgentRunWrite(existing, payload)) return clone(asPayload(existing))
        const storedPayload = existing ? mergeAgentRunForWrite(asPayload(existing), payload) : payload
        await tx`
          insert into agent_runs (id, owner_id, project_id, status, updated_at, payload)
          values (${run.id}, ${userId}, ${run.projectId}, ${storedPayload.status}, ${storedPayload.updatedAt}, ${tx.json(storedPayload)}::jsonb)
          on conflict (id) do update set status = excluded.status, updated_at = excluded.updated_at, payload = excluded.payload
          where agent_runs.project_id = excluded.project_id
            and agent_runs.owner_id = excluded.owner_id
            and agent_runs.updated_at <= excluded.updated_at
            and not (
              agent_runs.status <> 'awaiting_confirmation'
              and excluded.status = 'awaiting_confirmation'
            )
        `
        const [storedRow] = await tx`
          select owner_id as "ownerId", project_id as "projectId", payload
          from agent_runs where id = ${run.id}
        `
        if (!storedRow || storedRow.projectId !== run.projectId || storedRow.ownerId !== userId) {
          throw productError('Agent Run 标识已被其他项目使用。', 'AGENT_RUN_ID_CONFLICT')
        }
        const stored = asPayload(storedRow)
        if (stored?.updatedAt === storedPayload.updatedAt && stored?.status === storedPayload.status) {
          await insertAudit(tx, { actorId: userId, action: `agent-run.${storedPayload.status}`, projectId: run.projectId, targetId: run.id })
        }
        return clone(stored)
      })
    },

    async readAgentRun(userId, runId) {
      const [row] = await sql`
        select r.payload from agent_runs r join project_members m on m.project_id = r.project_id
        where r.id = ${runId} and r.owner_id = ${userId} and m.user_id = ${userId}
      `
      return asPayload(row)
    },

    async readAgentRunForWorker(runId) {
      const [row] = await sql`select payload from agent_runs where id = ${runId}`
      return asPayload(row)
    },

    async claimAgentBranchRetry(userId, command) {
      return sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${command?.runId}, 0))`
        const [row] = await tx`
          select owner_id as "ownerId", project_id as "projectId", payload
          from agent_runs where id = ${command?.runId} for update
        `
        if (row && (row.ownerId !== userId || row.projectId !== command?.projectId)) {
          return { kind: 'conflict', changed: false }
        }
        const [membership] = await tx`
          select role from project_members
          where project_id = ${command?.projectId} and user_id = ${userId}
          for share
        `
        assertProjectPermission(membership?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
        const [clock] = await tx`
          select floor(extract(epoch from clock_timestamp()) * 1000)::bigint as "observedAt"
        `
        await tx`select pg_advisory_xact_lock(hashtextextended(${command?.jobId}, 4))`
        const lockedJob = await lockedGenerationJob(tx, command?.jobId)
        const jobDecision = agentBranchRetryJobDecision(lockedJob?.job, command, {
          ownerId: userId,
          observedAt: Number(clock.observedAt),
        })
        if (jobDecision.kind === 'conflict') {
          return { kind: 'job_conflict', changed: false, run: clone(asPayload(row)), job: clone(jobDecision.job) }
        }
        const decision = agentBranchRetryClaimDecision(asPayload(row), {
          ...clone(command),
          observedAt: Number(clock.observedAt),
        })
        if (['claimed', 'replay'].includes(decision.kind) && jobDecision.changed) {
          await persistGenerationDecision(tx, jobDecision.job)
        }
        if (decision.changed) {
          await tx`
            update agent_runs set
              status = ${decision.run.status},
              updated_at = ${decision.run.updatedAt},
              payload = ${tx.json(decision.run)}::jsonb
            where id = ${command.runId} and owner_id = ${userId} and project_id = ${command.projectId}
          `
          await insertAudit(tx, {
            actorId: userId,
            action: 'agent-run.branch-retry-claimed',
            projectId: command.projectId,
            targetId: command.runId,
          })
        }
        return clone({
          ...decision,
          changed: decision.changed || (['claimed', 'replay'].includes(decision.kind) && jobDecision.changed),
          ...(['claimed', 'replay'].includes(decision.kind) ? { job: jobDecision.job } : {}),
        })
      })
    },

    async listQueuedAgentRunsForRecovery(options = {}) {
      const { afterId, limit } = normalizeAgentEntityIdPage(options)
      const cursor = afterId === null ? sql`` : sql`and id > ${afterId}`
      const rows = await sql`
        select payload from agent_runs where status = 'queued' ${cursor}
        order by id asc limit ${limit}
      `
      return rows.map(asPayload)
    },

    async listAgentRunsForProject(userId, projectId, limit = 30) {
      const rows = await sql`
        select r.payload from agent_runs r join project_members m on m.project_id = r.project_id
        where r.project_id = ${projectId} and r.owner_id = ${userId} and m.user_id = ${userId}
        order by r.updated_at desc limit ${Math.max(1, Math.min(limit, 60))}
      `
      return rows.map(asPayload)
    },

    async listAgentRunsForTurn(userId, projectId, turnId, limit = 20) {
      // 先按 project_id + owner_id 收窄（既有索引），再按 payload 里的 turnId 过滤。
      // turnId 目前不是独立列，这在每项目 Run 量级下可接受；若后续需要跨项目反查，
      // 应提列并建索引，而不是放开这里的项目范围。
      const rows = await sql`
        select r.payload from agent_runs r join project_members m on m.project_id = r.project_id
        where r.project_id = ${projectId} and r.owner_id = ${userId} and m.user_id = ${userId}
          and r.payload->>'turnId' = ${turnId}
        order by case when r.payload->>'createdAt' ~ '^[0-9]+$'
          then (r.payload->>'createdAt')::bigint else r.updated_at end asc
        limit ${Math.max(1, Math.min(limit, 60))}
      `
      return rows.map(asPayload)
    },

    async listAgentRunsForTurnPage(userId, projectId, turnId, options = {}) {
      const { afterId, limit } = normalizeAgentEntityIdPage(options)
      const cursor = afterId === null ? sql`` : sql`and r.id > ${afterId}`
      const rows = await sql`
        select r.payload from agent_runs r join project_members m on m.project_id = r.project_id
        where r.project_id = ${projectId} and r.owner_id = ${userId} and m.user_id = ${userId}
          and r.payload->>'turnId' = ${turnId} ${cursor}
        order by r.id asc limit ${limit}
      `
      return rows.map(asPayload)
    },

    async claimAgentTurnExecution(userId, claim) {
      if (typeof claim?.leaseToken !== 'string' || !claim.leaseToken.trim() || !claim?.turn?.id) {
        throw productError('Agent Turn 执行租约无效。', 'AGENT_TURN_EXECUTION_INVALID')
      }
      return sql.begin(async (tx) => {
        // 缺失行首次 claim 也必须串行化；只做 FOR UPDATE 无法锁住不存在的 Turn。
        // seed=3 与兼容 put 共用，避免旧写入口和新 claim 互相穿透。
        await tx`select pg_advisory_xact_lock(hashtextextended(${claim.turn.id}, 3))`
        const [row] = await tx`
          select owner_id as "ownerId", project_id as "projectId", payload
          from agent_turns where id = ${claim.turn.id} for update
        `
        const existingTurn = asPayload(row)
        if (row && (row.ownerId !== userId || row.projectId !== claim.turn.projectId)) {
          return { kind: 'conflict' }
        }

        // 同一 Token 的 claim 是响应丢失后的传输重试。原持有者即使随后被撤权，
        // 也必须能拿回已取得的执行权；新的首次 claim / takeover 仍需当前成员权限。
        if (existingTurn?.execution?.leaseToken !== claim.leaseToken) {
          const [membership] = await tx`
            select role from project_members
            where project_id = ${claim.turn.projectId} and user_id = ${userId}
            for share
          `
          assertProjectPermission(membership?.role, 'read', 'PROJECT_READ_FORBIDDEN')
        }
        const [clock] = await tx`
          select floor(extract(epoch from clock_timestamp()) * 1000)::bigint as "observedAt"
        `
        const observedAt = Number(clock.observedAt)
        const sourceTurn = {
          ...clone(claim.turn),
          ownerId: userId,
          lastSequence: 0,
          ...(!existingTurn ? { createdAt: observedAt, updatedAt: observedAt } : {}),
        }
        const decision = agentTurnExecutionClaimDecision(existingTurn, {
          ...clone(claim),
          turn: sourceTurn,
          observedAt,
        })
        if (decision.changed) {
          await tx`
            insert into agent_turns (id, owner_id, project_id, session_id, idempotency_key, status, updated_at, payload)
            values (
              ${decision.turn.id}, ${userId}, ${decision.turn.projectId}, ${decision.turn.sessionId ?? null},
              ${decision.turn.idempotencyKey}, ${decision.turn.status}, ${decision.turn.updatedAt},
              ${tx.json(decision.turn)}::jsonb
            )
            on conflict (id) do update set
              session_id = excluded.session_id,
              status = excluded.status,
              updated_at = excluded.updated_at,
              payload = excluded.payload
            where agent_turns.owner_id = excluded.owner_id
              and agent_turns.project_id = excluded.project_id
          `
          if (decision.kind === 'claimed') {
            await insertAudit(tx, {
              actorId: userId,
              action: 'agent-turn.running',
              projectId: decision.turn.projectId,
              targetId: decision.turn.id,
            })
          }
        }
        return clone({ kind: decision.kind, turn: decision.turn })
      })
    },

    async commitAgentTurnExecution(userId, command) {
      if (typeof command?.leaseToken !== 'string' || !command.leaseToken.trim()
        || !Number.isInteger(command?.executionGeneration) || command.executionGeneration < 1) {
        throw productError('Agent Turn 执行租约无效。', 'AGENT_TURN_EXECUTION_INVALID')
      }
      return sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${command.id}, 3))`
        const [row] = await tx`
          select owner_id as "ownerId", project_id as "projectId", payload
          from agent_turns where id = ${command.id} for update
        `
        if (!row || row.ownerId !== userId || row.projectId !== command.projectId) {
          throw productError('未找到 Agent Turn。', 'AGENT_TURN_NOT_FOUND')
        }
        const existingTurn = asPayload(row)
        const [clock] = await tx`
          select floor(extract(epoch from clock_timestamp()) * 1000)::bigint as "observedAt"
        `
        const observedAt = Number(clock.observedAt)
        const decision = committedAgentTurnExecution(existingTurn, {
          ...clone(command),
          observedAt,
        })

        let storedEvent
        if (['committed', 'replay'].includes(decision.kind) && command.event) {
          if (typeof command.event.id !== 'string' || !command.event.id
            || command.event.turnId !== existingTurn.id
            || command.event.projectId !== existingTurn.projectId
            || typeof command.event.type !== 'string' || !command.event.type) {
            throw productError('Agent Turn 事件身份无效。', 'AGENT_TURN_EXECUTION_INVALID')
          }
          const [eventRow] = await tx`
            select id, turn_id as "turnId", owner_id as "ownerId", project_id as "projectId",
              sequence, execution_generation as "executionGeneration", type,
              created_at as "createdAt", payload
            from agent_turn_events where id = ${command.event.id}
          `
          if (eventRow && (eventRow.turnId !== existingTurn.id
            || eventRow.projectId !== existingTurn.projectId
            || eventRow.type !== command.event.type)) {
            throw productError('Agent Turn 事件标识冲突。', 'AGENT_TURN_EVENT_CONFLICT')
          }
          if (eventRow) {
            storedEvent = { ...eventRow, payload: asJson(eventRow.payload) }
          } else if (decision.kind === 'committed') {
            const [sequenceRow] = await tx`
              select coalesce(max(sequence), 0)::integer as "lastSequence"
              from agent_turn_events where turn_id = ${existingTurn.id}
            `
            const lastSequence = Math.max(
              Number(existingTurn.lastSequence) || 0,
              Number(sequenceRow.lastSequence) || 0,
            )
            storedEvent = {
              ...clone(command.event),
              ownerId: userId,
              projectId: existingTurn.projectId,
              sequence: lastSequence + 1,
              executionGeneration: command.executionGeneration,
              createdAt: observedAt,
            }
            await tx`
              insert into agent_turn_events (
                id, turn_id, owner_id, project_id, sequence, execution_generation, type, created_at, payload
              ) values (
                ${storedEvent.id}, ${storedEvent.turnId}, ${userId}, ${storedEvent.projectId},
                ${storedEvent.sequence}, ${storedEvent.executionGeneration}, ${storedEvent.type},
                ${storedEvent.createdAt}, ${storedEvent.payload ? tx.json(storedEvent.payload) : null}::jsonb
              )
            `
            decision.turn.lastSequence = storedEvent.sequence
          }
        }

        if (decision.changed) {
          // 普通 Event/终态与取消 heartbeat/ack 都在同一 Turn 行锁内落库；只有普通
          // committed 分支拥有 Event 与 terminal Audit，取消进度不得伪造二者。
          await tx`
            update agent_turns set
              status = ${decision.turn.status},
              updated_at = ${decision.turn.updatedAt},
              payload = ${tx.json(decision.turn)}::jsonb
            where id = ${command.id} and owner_id = ${userId} and project_id = ${command.projectId}
          `
          if (decision.kind === 'committed'
            && ['completed', 'failed', 'cancelled'].includes(decision.turn.status)) {
            await insertAudit(tx, {
              actorId: userId,
              action: `agent-turn.${decision.turn.status}`,
              projectId: decision.turn.projectId,
              targetId: decision.turn.id,
            })
          }
        }
        return clone({
          kind: decision.kind,
          turn: decision.turn,
          ...(storedEvent ? { event: storedEvent } : {}),
        })
      })
    },

    async requestAgentTurnCancellation(userId, request) {
      if (typeof request?.id !== 'string' || !request.id
        || typeof request?.projectId !== 'string' || !request.projectId) {
        throw productError('Agent Turn 取消请求无效。', 'AGENT_TURN_EXECUTION_INVALID')
      }
      return sql.begin(async (tx) => {
        // 与 claim/commit/兼容 put 共用同一 advisory lock。取消与完成无论谁先拿锁，
        // 后拿锁的一方都会基于前者已提交的状态判定，不存在 completed/cancelling 互盖。
        await tx`select pg_advisory_xact_lock(hashtextextended(${request.id}, 3))`
        const [row] = await tx`
          select owner_id as "ownerId", project_id as "projectId", payload
          from agent_turns where id = ${request.id} for update
        `
        if (!row || row.ownerId !== userId || row.projectId !== request.projectId) {
          throw productError('未找到 Agent Turn。', 'AGENT_TURN_NOT_FOUND')
        }
        const [membership] = await tx`
          select role from project_members
          where project_id = ${request.projectId} and user_id = ${userId}
          for share
        `
        assertProjectPermission(membership?.role, 'read', 'PROJECT_READ_FORBIDDEN')
        const [clock] = await tx`
          select floor(extract(epoch from clock_timestamp()) * 1000)::bigint as "observedAt"
        `
        const observedAt = Number(clock.observedAt)
        const existingTurn = asPayload(row)
        const decision = requestedAgentTurnCancellation(existingTurn, {
          ...clone(request),
          observedAt,
        })

        let storedEvent
        if (request.event) {
          if (typeof request.event.id !== 'string' || !request.event.id
            || request.event.turnId !== existingTurn.id
            || request.event.projectId !== existingTurn.projectId
            || request.event.type !== 'turn.cancelling') {
            throw productError('Agent Turn 取消事件身份无效。', 'AGENT_TURN_EXECUTION_INVALID')
          }
          const [eventRow] = await tx`
            select id, turn_id as "turnId", owner_id as "ownerId", project_id as "projectId",
              sequence, execution_generation as "executionGeneration", type,
              created_at as "createdAt", payload
            from agent_turn_events where id = ${request.event.id}
          `
          if (eventRow && (eventRow.turnId !== existingTurn.id
            || eventRow.projectId !== existingTurn.projectId
            || eventRow.type !== request.event.type)) {
            throw productError('Agent Turn 事件标识冲突。', 'AGENT_TURN_EVENT_CONFLICT')
          }
          if (eventRow) {
            storedEvent = { ...eventRow, payload: asJson(eventRow.payload) }
          } else if (decision.kind === 'requested') {
            const [sequenceRow] = await tx`
              select coalesce(max(sequence), 0)::integer as "lastSequence"
              from agent_turn_events where turn_id = ${existingTurn.id}
            `
            const lastSequence = Math.max(
              Number(existingTurn.lastSequence) || 0,
              Number(sequenceRow.lastSequence) || 0,
            )
            storedEvent = {
              ...clone(request.event),
              ownerId: userId,
              projectId: existingTurn.projectId,
              sequence: lastSequence + 1,
              executionGeneration: Number(existingTurn.execution?.generation) || undefined,
              createdAt: observedAt,
              payload: clone(decision.turn.error),
            }
            await tx`
              insert into agent_turn_events (
                id, turn_id, owner_id, project_id, sequence, execution_generation, type, created_at, payload
              ) values (
                ${storedEvent.id}, ${storedEvent.turnId}, ${userId}, ${storedEvent.projectId},
                ${storedEvent.sequence}, ${storedEvent.executionGeneration ?? null}, ${storedEvent.type},
                ${storedEvent.createdAt}, ${tx.json(storedEvent.payload)}::jsonb
              )
            `
            decision.turn.lastSequence = storedEvent.sequence
          }
        } else if (decision.kind === 'requested') {
          // 新取消没有事件就会留下不可续读的状态跳变；在写 Turn 前拒绝，事务不产生半态。
          throw productError('Agent Turn 取消事件缺失。', 'AGENT_TURN_EXECUTION_INVALID')
        }

        if (decision.kind === 'requested') {
          // cancelling 与对应事件同事务；若事件唯一约束或 Turn 更新失败，二者一起回滚。
          await tx`
            update agent_turns set
              status = ${decision.turn.status},
              updated_at = ${decision.turn.updatedAt},
              payload = ${tx.json(decision.turn)}::jsonb
            where id = ${request.id} and owner_id = ${userId} and project_id = ${request.projectId}
          `
          await insertAudit(tx, {
            actorId: userId,
            action: 'agent-turn.cancelling',
            projectId: decision.turn.projectId,
            targetId: decision.turn.id,
          })
        }
        return clone({
          kind: decision.kind,
          turn: decision.turn,
          ...(storedEvent ? { event: storedEvent } : {}),
        })
      })
    },

    async finalizeAgentTurnCancellation(userId, command) {
      if (typeof command?.id !== 'string' || !command.id
        || typeof command?.projectId !== 'string' || !command.projectId) {
        throw productError('Agent Turn 取消收口参数无效。', 'AGENT_TURN_EXECUTION_INVALID')
      }
      return sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${command.id}, 3))`
        const [row] = await tx`
          select owner_id as "ownerId", project_id as "projectId", payload
          from agent_turns where id = ${command.id} for update
        `
        if (!row || row.ownerId !== userId || row.projectId !== command.projectId) {
          throw productError('未找到 Agent Turn。', 'AGENT_TURN_NOT_FOUND')
        }
        const [clock] = await tx`
          select floor(extract(epoch from clock_timestamp()) * 1000)::bigint as "observedAt"
        `
        const observedAt = Number(clock.observedAt)
        const existingTurn = asPayload(row)
        const decision = finalizedAgentTurnCancellation(existingTurn, {
          ...clone(command), observedAt,
        })

        let storedEvent
        if (command.event) {
          if (typeof command.event.id !== 'string' || !command.event.id
            || command.event.turnId !== existingTurn.id
            || command.event.projectId !== existingTurn.projectId
            || command.event.type !== 'turn.cancelled') {
            throw productError('Agent Turn 取消收口事件身份无效。', 'AGENT_TURN_EXECUTION_INVALID')
          }
          const [eventRow] = await tx`
            select id, turn_id as "turnId", owner_id as "ownerId", project_id as "projectId",
              sequence, execution_generation as "executionGeneration", type,
              created_at as "createdAt", payload
            from agent_turn_events where id = ${command.event.id} for update
          `
          if (eventRow && (eventRow.turnId !== existingTurn.id
            || eventRow.projectId !== existingTurn.projectId
            || eventRow.type !== 'turn.cancelled')) {
            throw productError('Agent Turn 事件标识冲突。', 'AGENT_TURN_EVENT_CONFLICT')
          }
          if (eventRow) {
            storedEvent = { ...eventRow, payload: asJson(eventRow.payload) }
          } else if (decision.kind === 'finalized') {
            const [sequenceRow] = await tx`
              select coalesce(max(sequence), 0)::integer as "lastSequence"
              from agent_turn_events where turn_id = ${existingTurn.id}
            `
            const lastSequence = Math.max(
              Number(existingTurn.lastSequence) || 0,
              Number(sequenceRow.lastSequence) || 0,
            )
            storedEvent = {
              ...clone(command.event),
              ownerId: userId,
              projectId: existingTurn.projectId,
              sequence: lastSequence + 1,
              executionGeneration: Number(existingTurn.execution?.generation) || undefined,
              createdAt: observedAt,
              payload: clone(decision.turn.error),
            }
            await tx`
              insert into agent_turn_events (
                id, turn_id, owner_id, project_id, sequence, execution_generation, type, created_at, payload
              ) values (
                ${storedEvent.id}, ${storedEvent.turnId}, ${userId}, ${storedEvent.projectId},
                ${storedEvent.sequence}, ${storedEvent.executionGeneration ?? null}, ${storedEvent.type},
                ${storedEvent.createdAt}, ${tx.json(storedEvent.payload)}::jsonb
              )
            `
            decision.turn.lastSequence = storedEvent.sequence
          }
        } else if (decision.kind === 'finalized') {
          throw productError('Agent Turn 取消收口事件缺失。', 'AGENT_TURN_EXECUTION_INVALID')
        }

        if (decision.changed) {
          await tx`
            update agent_turns set
              status = ${decision.turn.status},
              updated_at = ${decision.turn.updatedAt},
              payload = ${tx.json(decision.turn)}::jsonb
            where id = ${command.id} and owner_id = ${userId} and project_id = ${command.projectId}
          `
          await insertAudit(tx, {
            actorId: userId,
            action: 'agent-turn.cancelled',
            projectId: decision.turn.projectId,
            targetId: decision.turn.id,
            createdAt: observedAt,
            detail: { executionGeneration: Number(decision.turn.execution?.generation) || undefined },
          })
        }
        return clone({
          kind: decision.kind,
          turn: decision.turn,
          ...(storedEvent ? { event: storedEvent } : {}),
        })
      })
    },

    async putAgentTurn(userId, turn) {
      const role = await memberRole(turn.projectId, userId)
      assertProjectPermission(role, 'read', 'PROJECT_READ_FORBIDDEN')
      const payload = { ...clone(turn), ownerId: userId, updatedAt: Number(turn.updatedAt) || now() }
      return sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${turn.id}, 3))`
        const [existing] = await tx`
          select owner_id as "ownerId", project_id as "projectId", payload
          from agent_turns where id = ${turn.id} for update
        `
        if (existing && (existing.projectId !== turn.projectId || existing.ownerId !== userId)) {
          throw productError('Agent Turn 标识已被其他项目使用。', 'AGENT_TURN_ID_CONFLICT')
        }
        const existingTurn = asPayload(existing)
        // execution 一旦由原子 claim 建立，兼容整条 put 不能再绕过 Token/generation
        // 覆盖 checkpoint、取消中间态或终态。新 Runtime 只走 fenced commit。
        if (existingTurn?.execution) return clone(existingTurn)
        await tx`
          insert into agent_turns (id, owner_id, project_id, session_id, idempotency_key, status, updated_at, payload)
          values (${turn.id}, ${userId}, ${turn.projectId}, ${turn.sessionId ?? null}, ${turn.idempotencyKey}, ${turn.status}, ${payload.updatedAt}, ${tx.json(payload)}::jsonb)
          on conflict (id) do update set session_id = excluded.session_id, status = excluded.status,
            updated_at = excluded.updated_at, payload = excluded.payload
          where agent_turns.owner_id = excluded.owner_id
            and agent_turns.project_id = excluded.project_id
            and agent_turns.updated_at <= excluded.updated_at
        `
        const [stored] = await tx`select owner_id as "ownerId", project_id as "projectId", payload from agent_turns where id = ${turn.id}`
        if (!stored || stored.ownerId !== userId || stored.projectId !== turn.projectId) {
          throw productError('Agent Turn 标识已被其他项目使用。', 'AGENT_TURN_ID_CONFLICT')
        }
        await insertAudit(tx, { actorId: userId, action: `agent-turn.${turn.status}`, projectId: turn.projectId, targetId: turn.id })
        return clone(asPayload(stored))
      })
    },

    async readAgentTurn(userId, turnId) {
      const [row] = await sql`
        select t.payload from agent_turns t join project_members m on m.project_id = t.project_id
        where t.id = ${turnId} and t.owner_id = ${userId} and m.user_id = ${userId}
      `
      return asPayload(row)
    },

    async readAgentTurnForWorker(turnId) {
      const [row] = await sql`select payload from agent_turns where id = ${turnId}`
      return asPayload(row)
    },

    async listAgentTurnsForProject(userId, projectId, limit = 30) {
      const rows = await sql`
        select t.payload from agent_turns t join project_members m on m.project_id = t.project_id
        where t.project_id = ${projectId} and t.owner_id = ${userId} and m.user_id = ${userId}
        order by t.updated_at desc limit ${Math.max(1, Math.min(Number(limit) || 30, 100))}
      `
      return rows.map(asPayload)
    },

    async appendAgentTurnEvent(userId, projectId, event) {
      const role = await memberRole(projectId, userId)
      assertProjectPermission(role, 'read', 'PROJECT_READ_FORBIDDEN')
      return sql.begin(async (tx) => {
        const [turn] = await tx`select owner_id as "ownerId", project_id as "projectId" from agent_turns where id = ${event.turnId} for share`
        if (!turn || turn.ownerId !== userId || turn.projectId !== projectId) throw productError('未找到 Agent Turn。', 'AGENT_TURN_NOT_FOUND')
        await tx`
          insert into agent_turn_events (id, turn_id, owner_id, project_id, sequence, execution_generation, type, created_at, payload)
          values (${event.id}, ${event.turnId}, ${userId}, ${projectId}, ${event.sequence}, ${event.executionGeneration ?? null}, ${event.type}, ${event.createdAt || now()}, ${event.payload ? tx.json(event.payload) : null}::jsonb)
          on conflict (turn_id, sequence) do nothing
        `
        const [stored] = await tx`select id, turn_id as "turnId", owner_id as "ownerId", project_id as "projectId", sequence, execution_generation as "executionGeneration", type, created_at as "createdAt", payload from agent_turn_events where turn_id = ${event.turnId} and sequence = ${event.sequence}`
        return clone(stored ? { ...stored, payload: asJson(stored.payload) } : event)
      })
    },

    /**
     * `after` 是 `(turnId, sequence)` 游标的服务端一侧：只返回该序号之后的事件。
     * 断线重连据此续读，不必为了知道自己读到哪而重新拉全量。
     */
    async listAgentTurnEvents(userId, projectId, turnId, options = {}) {
      const { after, limit } = normalizeTurnEventPage(options)
      // 用片段而不是 `${after} is null or ...`：裸参数在 is null 里无法被 Postgres
      // 推断类型（42P18），而且这样生成的查询更紧、能直接走 (turn_id, sequence) 索引。
      const cursor = after === null ? sql`` : sql`and e.sequence > ${after}`
      const rows = await sql`
        select e.id, e.turn_id as "turnId", e.owner_id as "ownerId", e.project_id as "projectId", e.sequence,
          e.execution_generation as "executionGeneration",
          e.type, e.created_at as "createdAt", e.payload
        from agent_turn_events e join project_members m on m.project_id = e.project_id
        where e.turn_id = ${turnId} and e.project_id = ${projectId} and e.owner_id = ${userId} and m.user_id = ${userId}
          ${cursor}
        order by e.sequence asc limit ${limit}
      `
      return rows.map((row) => ({ ...row, payload: asJson(row.payload) }))
    },

    /**
     * 跨项目扫描超过租约未推进的非终态 Turn，供派生任务队列回收孤儿。
     * 不做成员校验：清扫是系统行为，没有发起它的用户（与 readAgentTurnForWorker 同理）。
     */
    async listStaleAgentTurns(options = {}) {
      const { olderThan, after, limit } = normalizeStaleTurnQuery(options)
      const cursor = after === null ? sql`` : sql`
        and (updated_at > ${after.updatedAt} or (updated_at = ${after.updatedAt} and id > ${after.id}))
      `
      const rows = await sql`
        select id, updated_at as "updatedAt", payload from agent_turns
        where status = any(${sql.array([...reclaimableAgentTurnStatuses])}) and updated_at < ${olderThan}
          ${cursor}
        order by updated_at asc, id asc limit ${limit}
      `
      return rows.map((row) => ({ ...asPayload(row), updatedAt: Number(row.updatedAt) }))
    },

    async enqueueAgentSubagentActivation(userId, rawCommand) {
      const startCandidate = rawCommand?.kind === 'start'
        ? materializeAgentSubagentEnqueueCommand(userId, rawCommand)
        : undefined
      const subagentId = startCandidate?.subagentId ?? rawCommand?.subagentId ?? ''
      return sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${subagentId}, 6))`
        const locked = await lockedAgentSubagent(tx, subagentId)
        const projectId = locked?.subagent?.projectId ?? startCandidate?.projectId ?? rawCommand?.projectId
        const [membership] = await tx`
          select role from project_members where project_id = ${projectId ?? ''} and user_id = ${userId} for share
        `
        assertProjectPermission(membership?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
        const observedAt = await generationObservedAt(tx)
        const preexistingActivation = locked
          ? await lockedAgentSubagentActivation(tx, subagentId, {
              idempotencyKey: rawCommand?.idempotencyKey ?? '',
            })
          : undefined
        const materialized = materializeAgentSubagentEnqueueCommand(
          locked?.subagent?.ownerId ?? userId,
          {
          ...clone(rawCommand),
          ...(rawCommand?.kind === 'followup' ? {
            sequence: preexistingActivation?.activation.sequence
              ?? (Number(locked?.subagent?.lastEnqueuedSequence) + 1 || 1),
            cancelGeneration: Number(locked?.subagent?.cancelGeneration) || 0,
          } : {}),
          observedAt,
          },
        )
        const existingActivation = preexistingActivation
          ?? await lockedAgentSubagentActivation(tx, subagentId, {
            idempotencyKey: materialized.idempotencyKey,
          })
        const [turnRow] = existingActivation
          ? await tx`select payload from agent_turns where id = ${existingActivation.activation.turnId} for update`
          : []
        const rootTurnId = locked?.subagent?.rootTurnId ?? materialized.rootTurnId
        const [rootTurn] = await tx`
          select owner_id as "ownerId", project_id as "projectId", status, payload
          from agent_turns where id = ${rootTurnId ?? ''} for update
        `
        if (!rootTurn || rootTurn.ownerId !== (locked?.subagent?.ownerId ?? userId)
          || rootTurn.projectId !== projectId) {
          throw productError('Subagent 根 Turn 不存在。', 'AGENT_SUBAGENT_ROOT_TURN_NOT_FOUND')
        }
        assertAgentSubagentRootTurnFence(
          { ...asPayload(rootTurn), status: rootTurn.status },
          materialized.rootExecution,
        )
        const decision = agentSubagentEnqueueDecision(
          locked?.subagent,
          existingActivation?.activation,
          { ...materialized, observedAt, existingTurn: asPayload(turnRow) },
        )
        if (decision.changed) {
          if (decision.session) {
            await tx`
              insert into agent_sessions (id, owner_id, project_id, updated_at, payload)
              values (${decision.session.id}, ${decision.subagent.ownerId}, ${projectId}, ${decision.session.updatedAt}, ${tx.json(decision.session)}::jsonb)
            `
          }
          if (decision.inputMessage) {
            await tx`
              insert into agent_messages (id, owner_id, project_id, session_id, updated_at, payload)
              values (
                ${decision.inputMessage.id}, ${decision.subagent.ownerId}, ${projectId}, ${decision.subagent.sessionId},
                ${decision.inputMessage.updatedAt}, ${tx.json(decision.inputMessage)}::jsonb
              )
            `
            await tx`
              update agent_sessions set
                updated_at = greatest(updated_at, ${decision.inputMessage.updatedAt}),
                payload = jsonb_set(
                  payload, '{updatedAt}',
                  to_jsonb(greatest(updated_at, ${decision.inputMessage.updatedAt})), true
                )
              where id = ${decision.subagent.sessionId} and project_id = ${projectId}
            `
          }
          await tx`
            insert into agent_turns (
              id, owner_id, project_id, session_id, idempotency_key, status, updated_at, payload,
              request_hash, request_hash_version, execution_version, lease_token, lease_expires_at, last_sequence
            ) values (
              ${decision.turn.id}, ${decision.subagent.ownerId}, ${projectId}, ${decision.turn.sessionId},
              ${decision.turn.idempotencyKey}, ${decision.turn.status}, ${decision.turn.updatedAt},
              ${tx.json(decision.turn)}::jsonb, ${decision.turn.requestHash},
              ${decision.turn.requestHashVersion}, 0, null, null, 0
            )
          `
          await persistAgentSubagent(tx, decision.subagent)
          await persistAgentSubagentActivation(tx, decision.activation)
          await insertAudit(tx, {
            actorId: userId,
            action: `agent-subagent.${materialized.kind}`,
            projectId,
            targetId: decision.subagent.id,
            createdAt: observedAt,
            detail: { activationId: decision.activation.id, sequence: decision.activation.sequence },
          })
        }
        return clone(publicAgentSubagentDecision(decision))
      })
    },

    async readAgentSubagent(userId, subagentId) {
      const [row] = await sql`
        select s.id, s.owner_id as "ownerId", s.project_id as "projectId",
          s.root_turn_id as "rootTurnId", s.parent_session_id as "parentSessionId",
          s.session_id as "sessionId", s.status, s.cancel_generation as "cancelGeneration",
          s.last_enqueued_sequence as "lastEnqueuedSequence",
          s.settled_through_sequence as "settledThroughSequence",
          s.dispatch_generation as "dispatchGeneration",
          s.dispatch_activation_sequence as "dispatchActivationSequence",
          s.dispatch_lease_expires_at as "dispatchLeaseExpiresAt",
          s.idempotency_key as "idempotencyKey", s.request_hash as "requestHash",
          s.created_at as "createdAt", s.updated_at as "updatedAt", s.payload
        from agent_subagents s join project_members m on m.project_id = s.project_id
        where s.id = ${subagentId} and m.user_id = ${userId}
      `
      return publicAgentSubagent(agentSubagentFromRow(row, { includeLease: false }))
    },

    async readAgentSubagentForWorker(subagentId) {
      const [row] = await sql`
        select id, owner_id as "ownerId", project_id as "projectId",
          root_turn_id as "rootTurnId", parent_session_id as "parentSessionId",
          session_id as "sessionId", status, cancel_generation as "cancelGeneration",
          last_enqueued_sequence as "lastEnqueuedSequence",
          settled_through_sequence as "settledThroughSequence",
          dispatch_generation as "dispatchGeneration",
          dispatch_activation_sequence as "dispatchActivationSequence",
          dispatch_lease_token as "dispatchLeaseToken",
          dispatch_lease_expires_at as "dispatchLeaseExpiresAt",
          idempotency_key as "idempotencyKey", request_hash as "requestHash",
          created_at as "createdAt", updated_at as "updatedAt", payload
        from agent_subagents where id = ${subagentId}
      `
      return agentSubagentFromRow(row)
    },

    async listAgentSubagentsForRootTurnPage(userId, projectId, rootTurnId, options = {}) {
      const [membership] = await sql`
        select 1 from project_members where project_id = ${projectId} and user_id = ${userId}
      `
      if (!membership) return undefined
      const { afterId, limit } = normalizeAgentEntityIdPage(options)
      const cursor = afterId === null ? sql`` : sql`and id collate "C" > ${afterId} collate "C"`
      const rows = await sql`
        select id, owner_id as "ownerId", project_id as "projectId",
          root_turn_id as "rootTurnId", parent_session_id as "parentSessionId",
          session_id as "sessionId", status, cancel_generation as "cancelGeneration",
          last_enqueued_sequence as "lastEnqueuedSequence",
          settled_through_sequence as "settledThroughSequence",
          dispatch_generation as "dispatchGeneration",
          dispatch_activation_sequence as "dispatchActivationSequence",
          dispatch_lease_expires_at as "dispatchLeaseExpiresAt",
          idempotency_key as "idempotencyKey", request_hash as "requestHash",
          created_at as "createdAt", updated_at as "updatedAt", payload
        from agent_subagents
        where project_id = ${projectId} and root_turn_id = ${rootTurnId} ${cursor}
        order by id collate "C" asc limit ${limit}
      `
      return rows.map((row) => publicAgentSubagent(agentSubagentFromRow(row, { includeLease: false })))
    },

    async listAgentSubagentActivations(userId, subagentId, options = {}) {
      const [subagent] = await sql`
        select s.project_id from agent_subagents s join project_members m on m.project_id = s.project_id
        where s.id = ${subagentId} and m.user_id = ${userId}
      `
      if (!subagent) return undefined
      const { afterSequence, limit } = normalizeAgentSubagentActivationPage(options)
      const rows = await sql`
        select subagent_id as "subagentId", sequence, turn_id as "turnId",
          input_message_id as "inputMessageId", result_message_id as "resultMessageId",
          source_turn_id as "sourceTurnId", idempotency_key as "idempotencyKey",
          request_hash as "requestHash", subagent_generation as "subagentGeneration",
          execution_generation as "executionGeneration",
          execution_cancel_generation as "executionCancelGeneration",
          execution_lease_token as "executionLeaseToken",
          execution_lease_expires_at as "executionLeaseExpiresAt",
          created_at as "createdAt", updated_at as "updatedAt", settled_at as "settledAt", payload
        from agent_subagent_activations
        where subagent_id = ${subagentId} and sequence > ${afterSequence}
        order by sequence asc limit ${limit}
      `
      return rows.map((row) => publicAgentSubagentActivation(agentSubagentActivationFromRow(row)))
    },

    async listAgentSubagentActivationsForWorker(subagentId, options = {}) {
      const [subagent] = await sql`select 1 from agent_subagents where id = ${subagentId}`
      if (!subagent) return undefined
      const { afterSequence, limit } = normalizeAgentSubagentActivationPage(options)
      const rows = await sql`
        select activation.subagent_id as "subagentId", activation.sequence,
          activation.turn_id as "turnId", activation.input_message_id as "inputMessageId",
          activation.result_message_id as "resultMessageId", activation.source_turn_id as "sourceTurnId",
          activation.idempotency_key as "idempotencyKey", activation.request_hash as "requestHash",
          activation.subagent_generation as "subagentGeneration",
          activation.execution_generation as "executionGeneration",
          activation.execution_cancel_generation as "executionCancelGeneration",
          activation.execution_lease_token as "executionLeaseToken",
          activation.execution_lease_expires_at as "executionLeaseExpiresAt",
          activation.created_at as "createdAt", activation.updated_at as "updatedAt",
          activation.settled_at as "settledAt", activation.payload, turn.payload as "turnPayload"
        from agent_subagent_activations activation
        join agent_turns turn on turn.id = activation.turn_id
        where activation.subagent_id = ${subagentId} and activation.sequence > ${afterSequence}
        order by activation.sequence asc limit ${limit}
      `
      return rows.map((row) => ({
        activation: agentSubagentActivationFromRow(row),
        turn: asJson(row.turnPayload),
      }))
    },

    async listRunnableAgentSubagents(options = {}) {
      const [clock] = await sql`select floor(extract(epoch from clock_timestamp()) * 1000)::bigint as "observedAt"`
      const { now: observedAt, after, limit } = normalizeRunnableAgentSubagentPage({
        ...options,
        now: Number(clock.observedAt),
      })
      const cursor = after === null ? sql`` : sql`
        and (subagent.updated_at > ${after.updatedAt}
          or (subagent.updated_at = ${after.updatedAt}
            and subagent.id collate "C" > ${after.id} collate "C"))
      `
      const rows = await sql`
        select subagent.id, subagent.owner_id as "ownerId", subagent.project_id as "projectId",
          subagent.root_turn_id as "rootTurnId", subagent.parent_session_id as "parentSessionId",
          subagent.session_id as "sessionId", subagent.status,
          subagent.cancel_generation as "cancelGeneration",
          subagent.last_enqueued_sequence as "lastEnqueuedSequence",
          subagent.settled_through_sequence as "settledThroughSequence",
          subagent.dispatch_generation as "dispatchGeneration",
          subagent.dispatch_activation_sequence as "dispatchActivationSequence",
          subagent.dispatch_lease_token as "dispatchLeaseToken",
          subagent.dispatch_lease_expires_at as "dispatchLeaseExpiresAt",
          subagent.idempotency_key as "idempotencyKey", subagent.request_hash as "requestHash",
          subagent.created_at as "createdAt", subagent.updated_at as "updatedAt", subagent.payload,
          activation.payload as "activationPayload", turn.payload as "turnPayload"
        from agent_subagents subagent
        join agent_subagent_activations activation
          on activation.subagent_id = subagent.id
          and activation.sequence = subagent.settled_through_sequence + 1
        join agent_turns turn on turn.id = activation.turn_id
        where subagent.status in ('active', 'cancelling')
          and subagent.settled_through_sequence < subagent.last_enqueued_sequence
          and (
            subagent.status = 'cancelling'
            or activation.payload->>'status' = 'queued'
            or (
              activation.payload->>'status' = 'running'
              and activation.payload->'execution'->>'leaseExpiresAt' ~ '^[0-9]+$'
              and (activation.payload->'execution'->>'leaseExpiresAt')::bigint <= ${observedAt}
            )
          )
          ${cursor}
        order by subagent.updated_at asc, subagent.id collate "C" asc limit ${limit}
      `
      return rows.map((row) => ({
        subagent: agentSubagentFromRow(row),
        activation: asJson(row.activationPayload),
        turn: asJson(row.turnPayload),
      }))
    },

    async claimAgentSubagentActivation(command) {
      return sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${command?.subagentId ?? ''}, 6))`
        const locked = await lockedAgentSubagent(tx, command?.subagentId ?? '')
        if (!locked) return { kind: 'missing', changed: false }
        const headSequence = Number(locked.subagent.settledThroughSequence) + 1
        const lockedActivation = await lockedAgentSubagentActivation(tx, locked.subagent.id, {
          sequence: headSequence,
        })
        const observedAt = await generationObservedAt(tx)
        const decision = agentSubagentActivationClaimDecision(
          locked.subagent,
          lockedActivation?.activation,
          { ...clone(command), observedAt },
        )
        if (decision.changed) {
          await persistAgentSubagent(tx, decision.subagent)
          await persistAgentSubagentActivation(tx, decision.activation)
        }
        const [turnRow] = decision.activation
          ? await tx`select payload from agent_turns where id = ${decision.activation.turnId}`
          : []
        return clone({ ...decision, turn: asPayload(turnRow) })
      })
    },

    async settleAgentSubagentActivation(command) {
      return sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${command?.subagentId ?? ''}, 6))`
        const locked = await lockedAgentSubagent(tx, command?.subagentId ?? '')
        if (!locked) return { kind: 'missing', changed: false }
        const [activationRow] = await tx`
          select subagent_id as "subagentId", sequence, turn_id as "turnId",
            input_message_id as "inputMessageId", result_message_id as "resultMessageId",
            source_turn_id as "sourceTurnId", idempotency_key as "idempotencyKey",
            request_hash as "requestHash", subagent_generation as "subagentGeneration",
            execution_generation as "executionGeneration",
            execution_cancel_generation as "executionCancelGeneration",
            execution_lease_token as "executionLeaseToken",
            execution_lease_expires_at as "executionLeaseExpiresAt",
            created_at as "createdAt", updated_at as "updatedAt", settled_at as "settledAt", payload
          from agent_subagent_activations
          where subagent_id = ${locked.subagent.id} and payload->>'id' = ${command?.activationId ?? ''}
          for update
        `
        const activation = agentSubagentActivationFromRow(activationRow)
        const [turnRow] = activation
          ? await tx`select payload from agent_turns where id = ${activation.turnId} for update`
          : []
        const turn = asPayload(turnRow)
        const observedAt = await generationObservedAt(tx)
        const decision = agentSubagentActivationSettleDecision(
          locked.subagent,
          activation,
          turn,
          { ...clone(command), observedAt },
        )
        if (decision.changed) {
          const [existingMessage] = await tx`
            select project_id as "projectId", session_id as "sessionId", payload
            from agent_messages where id = ${decision.resultMessage.id} for update
          `
          if (existingMessage && (
            existingMessage.projectId !== decision.subagent.projectId
            || existingMessage.sessionId !== decision.subagent.sessionId
            || asPayload(existingMessage)?.turnId !== decision.turn.id
          )) throw productError('Subagent 结果消息标识冲突。', 'AGENT_SUBAGENT_RESULT_MESSAGE_CONFLICT')
          if (!existingMessage) {
            await tx`
              insert into agent_messages (id, owner_id, project_id, session_id, updated_at, payload)
              values (
                ${decision.resultMessage.id}, ${decision.subagent.ownerId},
                ${decision.subagent.projectId}, ${decision.subagent.sessionId},
                ${decision.resultMessage.updatedAt}, ${tx.json(decision.resultMessage)}::jsonb
              )
            `
          }
          await tx`
            update agent_sessions set
              updated_at = greatest(updated_at, ${decision.resultMessage.updatedAt}),
              payload = jsonb_set(
                payload, '{updatedAt}',
                to_jsonb(greatest(updated_at, ${decision.resultMessage.updatedAt})), true
              )
            where id = ${decision.subagent.sessionId} and project_id = ${decision.subagent.projectId}
          `
          decision.subagent = { ...decision.subagent, dispatch: undefined, updatedAt: observedAt }
          await persistAgentSubagentActivation(tx, decision.activation)
          await persistAgentSubagent(tx, decision.subagent)
        }
        const nextSequence = Number(decision.subagent?.settledThroughSequence) + 1
        const next = decision.subagent?.status === 'active'
          && nextSequence <= Number(decision.subagent.lastEnqueuedSequence)
          ? await lockedAgentSubagentActivation(tx, decision.subagent.id, { sequence: nextSequence })
          : undefined
        const queuedNext = next?.activation?.status === 'queued' ? next : undefined
        const [nextTurnRow] = queuedNext
          ? await tx`select payload from agent_turns where id = ${next.activation.turnId}`
          : []
        const nextTurn = asPayload(nextTurnRow)
        return clone({
          ...decision,
          ...(queuedNext && nextTurn
            ? { nextActivation: { activation: queuedNext.activation, turn: nextTurn } }
            : {}),
        })
      })
    },

    async requestAgentSubagentCancellation(userId, command) {
      return sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${command?.subagentId ?? ''}, 6))`
        const locked = await lockedAgentSubagent(tx, command?.subagentId ?? '')
        if (!locked || locked.subagent.projectId !== command?.projectId) {
          return { kind: 'missing', changed: false }
        }
        const [membership] = await tx`
          select role from project_members
          where project_id = ${locked.subagent.projectId} and user_id = ${userId} for share
        `
        assertProjectPermission(membership?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
        const head = Number(locked.subagent.settledThroughSequence) < Number(locked.subagent.lastEnqueuedSequence)
          ? await lockedAgentSubagentActivation(tx, locked.subagent.id, {
              sequence: Number(locked.subagent.settledThroughSequence) + 1,
            })
          : undefined
        const observedAt = await generationObservedAt(tx)
        const decision = agentSubagentCancellationRequestDecision(
          locked.subagent,
          head?.activation,
          { ...clone(command), observedAt },
        )
        if (decision.changed) {
          decision.subagent = { ...decision.subagent, dispatch: undefined }
          await persistAgentSubagent(tx, decision.subagent)
          if (decision.activation) await persistAgentSubagentActivation(tx, decision.activation)
          await insertAudit(tx, {
            actorId: userId,
            action: decision.subagent.status === 'cancelled'
              ? 'agent-subagent.cancelled'
              : 'agent-subagent.cancelling',
            projectId: decision.subagent.projectId,
            targetId: decision.subagent.id,
            createdAt: observedAt,
            detail: { cancelGeneration: decision.subagent.cancelGeneration },
          })
        }
        return clone(publicAgentSubagentDecision(decision))
      })
    },

    async finalizeAgentSubagentCancellation(userId, command) {
      return sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${command?.subagentId ?? ''}, 6))`
        const locked = await lockedAgentSubagent(tx, command?.subagentId ?? '')
        if (!locked || locked.subagent.projectId !== command?.projectId) {
          return { kind: 'missing', changed: false }
        }
        const [membership] = await tx`
          select role from project_members
          where project_id = ${locked.subagent.projectId} and user_id = ${userId} for share
        `
        assertProjectPermission(membership?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
        const activationRows = await tx`
          select activation.subagent_id as "subagentId", activation.sequence,
            activation.turn_id as "turnId", activation.input_message_id as "inputMessageId",
            activation.result_message_id as "resultMessageId", activation.source_turn_id as "sourceTurnId",
            activation.idempotency_key as "idempotencyKey", activation.request_hash as "requestHash",
            activation.subagent_generation as "subagentGeneration",
            activation.execution_generation as "executionGeneration",
            activation.execution_cancel_generation as "executionCancelGeneration",
            activation.execution_lease_token as "executionLeaseToken",
            activation.execution_lease_expires_at as "executionLeaseExpiresAt",
            activation.created_at as "createdAt", activation.updated_at as "updatedAt",
            activation.settled_at as "settledAt", activation.payload, turn.payload as "turnPayload"
          from agent_subagent_activations activation
          join agent_turns turn on turn.id = activation.turn_id
          where activation.subagent_id = ${locked.subagent.id}
            and activation.sequence > ${locked.subagent.settledThroughSequence}
          order by activation.sequence asc for update of activation, turn
        `
        const activations = activationRows.map(agentSubagentActivationFromRow)
        const turns = activationRows.map((row) => asJson(row.turnPayload))
        const observedAt = await generationObservedAt(tx)
        const decision = agentSubagentCancellationFinalizeDecision(
          locked.subagent,
          activations,
          turns,
          { ...clone(command), observedAt },
        )
        if (decision.changed) {
          for (const [index, resultMessage] of decision.resultMessages.entries()) {
            const activation = decision.activations[index]
            const [existingMessage] = await tx`
              select project_id as "projectId", session_id as "sessionId", payload
              from agent_messages where id = ${resultMessage.id} for update
            `
            if (existingMessage && (
              existingMessage.projectId !== decision.subagent.projectId
              || existingMessage.sessionId !== decision.subagent.sessionId
              || asPayload(existingMessage)?.turnId !== activation.turnId
            )) throw productError('Subagent 取消结果消息标识冲突。', 'AGENT_SUBAGENT_RESULT_MESSAGE_CONFLICT')
            if (!existingMessage) {
              await tx`
                insert into agent_messages (id, owner_id, project_id, session_id, updated_at, payload)
                values (
                  ${resultMessage.id}, ${decision.subagent.ownerId}, ${decision.subagent.projectId},
                  ${decision.subagent.sessionId}, ${resultMessage.updatedAt}, ${tx.json(resultMessage)}::jsonb
                )
              `
            }
            await tx`
              update agent_sessions set
                updated_at = greatest(updated_at, ${resultMessage.updatedAt}),
                payload = jsonb_set(
                  payload, '{updatedAt}',
                  to_jsonb(greatest(updated_at, ${resultMessage.updatedAt})), true
                )
              where id = ${decision.subagent.sessionId} and project_id = ${decision.subagent.projectId}
            `
            await persistAgentSubagentActivation(tx, activation)
          }
          decision.subagent = { ...decision.subagent, dispatch: undefined }
          await persistAgentSubagent(tx, decision.subagent)
          await insertAudit(tx, {
            actorId: userId,
            action: 'agent-subagent.cancelled',
            projectId: decision.subagent.projectId,
            targetId: decision.subagent.id,
            createdAt: observedAt,
            detail: { cancelGeneration: decision.subagent.cancelGeneration },
          })
        }
        return clone(publicAgentSubagentDecision(decision))
      })
    },

    // Worker 侧：找出含失败分支的 Run。用 jsonb 存在性过滤，不把全部 Run 拉回内存筛。
    async listRunsWithFailedBranches(options = {}) {
      const { after, limit } = normalizeUpdatedAtIdRecoveryPage(options)
      const cursor = after === null ? sql`` : sql`
        and (r.updated_at > ${after.updatedAt}
          or (r.updated_at = ${after.updatedAt} and r.id > ${after.id}))
      `
      const rows = await sql`
        select r.id, r.owner_id, r.project_id, r.updated_at as "updatedAt" from agent_runs r
        where r.status in ('partial', 'failed')
          and exists (
            select 1 from jsonb_array_elements(coalesce(r.payload->'branches', '[]'::jsonb)) as branch
            where branch->>'status' = 'failed'
          )
          ${cursor}
        order by r.updated_at asc, r.id asc limit ${limit}
      `
      return rows.map((row) => ({
        id: row.id,
        runId: row.id,
        ownerId: row.owner_id,
        projectId: row.project_id,
        updatedAt: Number(row.updatedAt),
      }))
    },

    // Worker 侧：找出仍有未收口工作流运行的项目。用 jsonb 路径过滤而不是把全部
    // 项目拉回来在内存里筛 —— 后者在项目数增长后会把清扫变成全表扫描。
    async listProjectsWithActiveWorkflowRuns({ limit = 25 } = {}) {
      const rows = await sql`
        select p.id as project_id, m.user_id as owner_id
        from projects p
        join project_members m on m.project_id = p.id and m.role = 'owner'
        where exists (
          select 1 from jsonb_array_elements(coalesce(p.document->'productionWorkflowRuns', '[]'::jsonb)) as run
          where run->>'status' in ('queued', 'running')
        )
        order by p.updated_at desc limit ${Math.max(1, Math.min(limit, 200))}
      `
      return rows.map((row) => ({ projectId: row.project_id, ownerId: row.owner_id }))
    },

    async putAgentReviewTask(userId, task) {
      const role = await memberRole(task.projectId, userId)
      assertProjectPermission(role, 'read', 'PROJECT_READ_FORBIDDEN')
      return sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${task.id}, 5))`
        const [row] = await tx`
          select owner_id as "ownerId", project_id as "projectId", run_id as "runId", payload
          from agent_review_tasks where id = ${task.id} for update
        `
        const [clock] = await tx`
          select floor(extract(epoch from clock_timestamp()) * 1000)::bigint as "observedAt"
        `
        const existing = row ? {
          ...asPayload(row), id: task.id, ownerId: row.ownerId,
          projectId: row.projectId, runId: row.runId,
        } : undefined
        const decision = agentReviewTaskPutDecision(existing, {
          ...clone(task), ownerId: task.ownerId ?? userId,
        }, { observedAt: Number(clock.observedAt) })
        if (decision.kind === 'conflict') {
          throw productError('评审任务身份冲突。', 'AGENT_REVIEW_TASK_ID_CONFLICT')
        }
        if (decision.changed) await persistAgentReviewExecutionDecision(tx, decision.task)
        return clone(decision.task)
      })
    },

    async claimAgentReviewExecution(userId, command) {
      return sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${command?.id ?? ''}, 5))`
        const [row] = await tx`
          select owner_id as "ownerId", project_id as "projectId", run_id as "runId", payload
          from agent_review_tasks where id = ${command?.id ?? ''} for update
        `
        if (row && row.ownerId !== userId) return { kind: 'missing', changed: false }
        const [clock] = await tx`
          select floor(extract(epoch from clock_timestamp()) * 1000)::bigint as "observedAt"
        `
        const existing = row ? {
          ...asPayload(row), id: command.id, ownerId: row.ownerId,
          projectId: row.projectId, runId: row.runId,
        } : undefined
        const decision = agentReviewExecutionClaimDecision(existing, {
          ...clone(command), observedAt: Number(clock.observedAt),
        })
        if (decision.changed) await persistAgentReviewExecutionDecision(tx, decision.task)
        return clone(decision)
      })
    },

    async commitAgentReviewExecution(userId, command) {
      return sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${command?.id ?? ''}, 5))`
        const [row] = await tx`
          select owner_id as "ownerId", project_id as "projectId", run_id as "runId", payload
          from agent_review_tasks where id = ${command?.id ?? ''} for update
        `
        if (row && row.ownerId !== userId) return { kind: 'missing', changed: false }
        const [clock] = await tx`
          select floor(extract(epoch from clock_timestamp()) * 1000)::bigint as "observedAt"
        `
        const existing = row ? {
          ...asPayload(row), id: command.id, ownerId: row.ownerId,
          projectId: row.projectId, runId: row.runId,
        } : undefined
        const decision = committedAgentReviewExecution(existing, {
          ...clone(command), observedAt: Number(clock.observedAt),
        })
        if (decision.changed) await persistAgentReviewExecutionDecision(tx, decision.task)
        return clone(decision)
      })
    },

    async requestAgentReviewCancellation(userId, command) {
      return sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${command?.id ?? ''}, 5))`
        const [row] = await tx`
          select owner_id as "ownerId", project_id as "projectId", run_id as "runId", payload
          from agent_review_tasks where id = ${command?.id ?? ''} for update
        `
        if (!row || row.projectId !== command?.projectId) return { kind: 'missing', changed: false }
        const [membership] = await tx`
          select role from project_members
          where project_id = ${row.projectId} and user_id = ${userId}
          for share
        `
        assertProjectPermission(membership?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
        const [clock] = await tx`
          select floor(extract(epoch from clock_timestamp()) * 1000)::bigint as "observedAt"
        `
        const existing = {
          ...asPayload(row), id: command.id, ownerId: row.ownerId,
          projectId: row.projectId, runId: row.runId,
        }
        const decision = agentReviewCancellationRequestDecision(existing, {
          ...clone(command), requestedBy: userId, observedAt: Number(clock.observedAt),
        })
        if (decision.changed) {
          await persistAgentReviewExecutionDecision(tx, decision.task)
          await insertAudit(tx, {
            actorId: userId,
            action: decision.task.status === 'cancelled'
              ? 'agent-review.cancelled'
              : 'agent-review.cancelling',
            projectId: row.projectId,
            targetId: command.id,
          })
        }
        return clone(decision)
      })
    },

    async finalizeAgentReviewCancellation(userId, command) {
      return sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${command?.id ?? ''}, 5))`
        const [row] = await tx`
          select owner_id as "ownerId", project_id as "projectId", run_id as "runId", payload
          from agent_review_tasks where id = ${command?.id ?? ''} for update
        `
        if (!row || row.ownerId !== userId || row.projectId !== command?.projectId) {
          return { kind: 'missing', changed: false }
        }
        const [clock] = await tx`
          select floor(extract(epoch from clock_timestamp()) * 1000)::bigint as "observedAt"
        `
        const observedAt = Number(clock.observedAt)
        const existing = {
          ...asPayload(row), id: command.id, ownerId: row.ownerId,
          projectId: row.projectId, runId: row.runId,
        }
        const decision = agentReviewCancellationFinalizeDecision(existing, {
          ...clone(command),
          observedAt,
          proof: { ...clone(command?.proof), observedAt },
        })
        if (decision.changed) {
          await persistAgentReviewExecutionDecision(tx, decision.task)
          await insertAudit(tx, {
            actorId: userId,
            action: 'agent-review.cancelled',
            projectId: row.projectId,
            targetId: command.id,
          })
        }
        return clone(decision)
      })
    },

    async resolveAgentReviewOutcomeUnknown(userId, command) {
      return sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${command?.id ?? ''}, 5))`
        const [row] = await tx`
          select owner_id as "ownerId", project_id as "projectId", run_id as "runId", payload
          from agent_review_tasks where id = ${command?.id ?? ''} for update
        `
        if (!row || row.projectId !== command?.projectId) return { kind: 'missing', changed: false }
        const [membership] = await tx`
          select role from project_members
          where project_id = ${row.projectId} and user_id = ${userId}
          for share
        `
        assertProjectPermission(membership?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
        if (command?.action === 'retry_once') {
          assertProjectPermission(membership?.role, 'create-generation', 'PROJECT_WRITE_FORBIDDEN')
        }
        const [clock] = await tx`
          select floor(extract(epoch from clock_timestamp()) * 1000)::bigint as "observedAt"
        `
        const existing = {
          ...asPayload(row), id: command.id, ownerId: row.ownerId,
          projectId: row.projectId, runId: row.runId,
        }
        const decision = agentReviewOutcomeReconciliationDecision(existing, {
          ...clone(command), actorId: userId, observedAt: Number(clock.observedAt),
        })
        if (decision.changed) {
          await persistAgentReviewExecutionDecision(tx, decision.task)
          await insertAudit(tx, {
            actorId: userId,
            action: 'agent-review.reconciled',
            projectId: row.projectId,
            targetId: command.id,
            detail: { action: command.action, status: decision.task.status },
          })
        }
        return clone(decision)
      })
    },

    async commitAgentReviewHumanDecisions(userId, command) {
      return sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${command?.id ?? ''}, 5))`
        const [row] = await tx`
          select owner_id as "ownerId", project_id as "projectId", run_id as "runId", payload
          from agent_review_tasks where id = ${command?.id ?? ''} for update
        `
        if (!row) return { kind: 'missing', changed: false }
        const [membership] = await tx`
          select role from project_members
          where project_id = ${row.projectId} and user_id = ${userId}
          for share
        `
        assertProjectPermission(membership?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
        const retryRunCandidates = Array.isArray(command?.retryRunCandidates)
          ? command.retryRunCandidates
          : []
        const requestedDecisions = Array.isArray(command?.decisions) ? command.decisions : []
        if (requestedDecisions.some((entry) => entry?.decision === 'retry_requested')
          || retryRunCandidates.length) {
          assertProjectPermission(membership?.role, 'create-generation', 'PROJECT_WRITE_FORBIDDEN')
        }
        const [clock] = await tx`
          select floor(extract(epoch from clock_timestamp()) * 1000)::bigint as "observedAt"
        `
        const existing = {
          ...asPayload(row), id: command.id, ownerId: row.ownerId,
          projectId: row.projectId, runId: row.runId,
        }
        const candidateRunIds = [...new Set(retryRunCandidates
          .map((candidate) => candidate?.run?.id)
          .filter((id) => typeof id === 'string' && id))]
          .sort()
        const existingRunsById = new Map()
        for (const runId of candidateRunIds) {
          await tx`select pg_advisory_xact_lock(hashtextextended(${runId}, 0))`
          const [runRow] = await tx`
            select owner_id as "ownerId", project_id as "projectId", status,
              updated_at as "updatedAt", payload
            from agent_runs where id = ${runId} for update
          `
          if (runRow) {
            existingRunsById.set(runId, {
              ...asPayload(runRow),
              id: runId,
              ownerId: runRow.ownerId,
              projectId: runRow.projectId,
              status: runRow.status,
              updatedAt: Number(runRow.updatedAt),
            })
          }
        }
        const decision = agentReviewRetryMaterializationDecision(existing, {
          ...clone(command), actorId: userId, observedAt: Number(clock.observedAt),
        }, existingRunsById)
        if (decision.changed) {
          const runsToInsert = decision.runsToInsert
            .slice()
            .sort((left, right) => left.id.localeCompare(right.id))
          for (const run of runsToInsert) {
            await tx`
              insert into agent_runs (id, owner_id, project_id, status, updated_at, payload)
              values (
                ${run.id}, ${run.ownerId}, ${run.projectId}, ${run.status},
                ${run.updatedAt}, ${tx.json(run)}::jsonb
              )
            `
          }
          await persistAgentReviewExecutionDecision(tx, decision.task)
        }
        const { runsToInsert: _runsToInsert, retryRuns, ...outcome } = decision
        return clone({ ...outcome, retryRuns })
      })
    },

    async readAgentReviewTask(userId, taskId) {
      const [row] = await sql`
        select t.payload from agent_review_tasks t
        join project_members m on m.project_id = t.project_id
        where t.id = ${taskId} and m.user_id = ${userId}
      `
      return row ? asPayload(row) : undefined
    },

    async readAgentReviewTaskForWorker(taskId) {
      const [row] = await sql`
        select payload from agent_review_tasks where id = ${taskId}
      `
      return row ? asPayload(row) : undefined
    },

    async listAgentReviewTasksForRun(userId, projectId, runId) {
      if (!await memberRole(projectId, userId)) return undefined
      const rows = await sql`
        select payload from agent_review_tasks
        where project_id = ${projectId} and run_id = ${runId}
        order by updated_at desc limit 50
      `
      return rows.map(asPayload)
    },

    // Worker 侧：跨项目扫描未收口的评审任务，因此不做成员校验（与 listStaleAgentTurns 同构）。
    async listPendingAgentReviewTasks(options = {}) {
      const { olderThan, after, limit } = normalizePendingAgentReviewRecoveryPage(options)
      const cursor = after === null ? sql`` : sql`
        and (t.updated_at > ${after.updatedAt}
          or (t.updated_at = ${after.updatedAt} and t.id > ${after.id}))
      `
      const rows = await sql`
        select t.id, t.updated_at as "updatedAt", t.payload from agent_review_tasks t
        where t.status in ('queued', 'running', 'cancelling') and t.updated_at <= ${olderThan}
          ${cursor}
        order by t.updated_at asc, t.id asc limit ${limit}
      `
      return rows.map((row) => ({ ...asPayload(row), id: row.id, updatedAt: Number(row.updatedAt) }))
    },

    async putAgentReview(userId, review) {
      const role = await memberRole(review.projectId, userId)
      assertProjectPermission(role, 'read', 'PROJECT_READ_FORBIDDEN')
      const payload = { ...clone(review), ownerId: userId, updatedAt: Number(review.updatedAt) || now() }
      return sql.begin(async (tx) => {
        const [run] = await tx`select project_id as "projectId", owner_id as "ownerId" from agent_runs where id = ${review.runId}`
        if (!run || run.projectId !== review.projectId || run.ownerId !== userId) throw productError('Agent Run 不属于当前项目。', 'AGENT_RUN_NOT_FOUND')
        await tx`
          insert into agent_reviews (id, owner_id, project_id, run_id, locale, status, updated_at, payload)
          values (${review.id}, ${userId}, ${review.projectId}, ${review.runId}, ${review.locale ?? 'zh-CN'}, ${review.status ?? 'pending'}, ${payload.updatedAt}, ${tx.json(payload)}::jsonb)
          on conflict (project_id, run_id, locale) do update set status = excluded.status, updated_at = excluded.updated_at, payload = excluded.payload
        `
        const [stored] = await tx`select payload from agent_reviews where project_id = ${review.projectId} and run_id = ${review.runId} and locale = ${review.locale ?? 'zh-CN'}`
        await insertAudit(tx, { actorId: userId, action: 'agent-review.updated', projectId: review.projectId, targetId: review.id })
        return clone(asPayload(stored))
      })
    },

    async readAgentReview(userId, projectId, runId, locale = 'zh-CN') {
      const rows = await sql`
        select r.payload from agent_reviews r join project_members m on m.project_id = r.project_id
        where r.project_id = ${projectId} and r.run_id = ${runId} and r.locale = ${locale}
          and r.owner_id = ${userId} and m.user_id = ${userId}
      `
      return asPayload(rows[0])
    },

    async listAgentReviewsForRun(userId, projectId, runId) {
      const rows = await sql`
        select r.payload from agent_reviews r join project_members m on m.project_id = r.project_id
        where r.project_id = ${projectId} and r.run_id = ${runId} and r.owner_id = ${userId} and m.user_id = ${userId}
        order by r.updated_at desc
      `
      return rows.map(asPayload)
    },

    async putAgentReviewDecision(userId, projectId, reviewId, decision, decisionNote = '') {
      const role = await memberRole(projectId, userId)
      assertProjectPermission(role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      return sql.begin(async (tx) => {
        const [row] = await tx`select payload from agent_reviews where id = ${reviewId} and project_id = ${projectId} for update`
        if (!row) throw productError('未找到 Agent 评审。', 'AGENT_REVIEW_NOT_FOUND')
        if (!['pending', 'accepted', 'rejected', 'retry_requested'].includes(decision)) throw productError('评审决策无效。', 'AGENT_REVIEW_DECISION_INVALID')
        const payload = { ...asPayload(row), status: decision, decisionNote: String(decisionNote ?? '').slice(0, 500), decidedBy: userId, updatedAt: now() }
        await tx`update agent_reviews set status = ${decision}, updated_at = ${payload.updatedAt}, payload = ${tx.json(payload)}::jsonb where id = ${reviewId} and project_id = ${projectId}`
        await insertAudit(tx, { actorId: userId, action: `agent-review.${decision}`, projectId, targetId: reviewId })
        return clone(payload)
      })
    },

    async readGenerationJob(userId, jobId) {
      const [row] = await sql`select payload from generation_jobs where id = ${jobId} and owner_id = ${userId}`
      return asPayload(row)
    },

    async listGenerationJobsForProject(userId, projectId, limit = 60) {
      const rows = await sql`
        select g.payload
        from generation_jobs g join project_members m on m.project_id = g.project_id
        where g.project_id = ${projectId} and g.owner_id = ${userId} and m.user_id = ${userId}
        order by g.updated_at desc
        limit ${Math.max(1, Math.min(limit, 120))}
      `
      return rows.map(asPayload)
    },

    async listGenerationJobsForAgentRunPage(userId, projectId, runId, options = {}) {
      const { afterId, limit } = normalizeAgentEntityIdPage(options)
      const cursor = afterId === null ? sql`` : sql`and g.id > ${afterId}`
      const rows = await sql`
        select g.payload
        from generation_jobs g join project_members m on m.project_id = g.project_id
        where g.project_id = ${projectId} and g.owner_id = ${userId} and m.user_id = ${userId}
          and g.payload->'agentRun'->>'runId' = ${runId} ${cursor}
        order by g.id asc limit ${limit}
      `
      return rows.map(asPayload)
    },

    async readGenerationJobForWorker(jobId) {
      const [row] = await sql`select payload from generation_jobs where id = ${jobId}`
      return asPayload(row)
    },

    async listRecoverableGenerationJobs(options = {}) {
      const { after, limit } = normalizeUpdatedAtIdRecoveryPage(options)
      const cursor = after === null ? sql`` : sql`
        and (g.updated_at > ${after.updatedAt}
          or (g.updated_at = ${after.updatedAt} and g.id > ${after.id}))
      `
      const rows = await sql`
        select g.id, g.updated_at as "updatedAt", g.payload from generation_jobs g
        where (g.status = 'queued' or g.payload->>'projectWritebackPending' = 'true')
          ${cursor}
        order by g.updated_at asc, g.id asc limit ${limit}
      `
      return rows.map((row) => ({ ...asPayload(row), id: row.id, updatedAt: Number(row.updatedAt) }))
    },

    async recoverGenerationJobs() {
      const queued = await sql`
        select payload from generation_jobs
        where status = 'queued' or payload->>'projectWritebackPending' = 'true'
        order by updated_at asc
      `
      return queued.map(asPayload)
    },

    async recoverStaleGenerationJobs(staleAfterMs = 90_000) {
      const staleThresholdMs = Math.max(30_000, staleAfterMs)
      const running = await sql`
        with db_clock as (
          select floor(extract(epoch from clock_timestamp()) * 1000)::bigint as observed_at
        )
        select job.payload from generation_jobs job cross join db_clock
        where status = 'running'
          and (
            (lease_expires_at is not null and lease_expires_at <= db_clock.observed_at)
            or (lease_expires_at is null and updated_at <= db_clock.observed_at - ${staleThresholdMs})
          )
        order by updated_at asc
      `
      return running.map(asPayload)
    },

    async createMediaObject(ownerId, projectId, { id = `media_${randomUUID()}`, storageKey, contentType, byteSize }) {
      await sql`insert into media_objects (id, project_id, owner_id, storage_key, content_type, byte_size, created_at) values (${id}, ${projectId}, ${ownerId}, ${storageKey}, ${contentType}, ${byteSize}, ${now()})`
      return { id, storageKey, contentType, byteSize }
    },

    async readMediaObject(userId, mediaId) {
      const [row] = await sql`
        select o.id, o.project_id as "projectId", o.storage_key as "storageKey", o.content_type as "contentType", o.byte_size as "byteSize"
        from media_objects o join project_members m on m.project_id = o.project_id
        where o.id = ${mediaId} and m.user_id = ${userId}
      `
      return row ? { ...row, byteSize: Number(row.byteSize) } : undefined
    },

    async listAuditEvents(userId, projectId, limit = 100) {
      const [role, [project]] = await Promise.all([
        memberRole(projectId, userId),
        sql`select id from projects where id = ${projectId}`,
      ])
      if (!project) return undefined
      assertProjectPermission(role, 'read-audit', 'PROJECT_AUDIT_FORBIDDEN')
      const rows = await sql`
        select id, actor_id as "actorId", action, project_id as "projectId", target_id as "targetId", detail, created_at as "createdAt"
        from audit_events where project_id = ${projectId} order by created_at desc limit ${Math.max(1, Math.min(limit, 500))}
      `
      return rows.map((row) => ({ ...row, createdAt: Number(row.createdAt), detail: asJson(row.detail) }))
    },

    async listWorkspaceAuditEvents(userId, limit = 100) {
      const [user] = await sql`select role, status from app_users where id = ${userId}`
      assertWorkspacePermission(user, 'read-audit', 'WORKSPACE_AUDIT_FORBIDDEN')
      const rows = await sql`
        select id, actor_id as "actorId", action, project_id as "projectId", target_id as "targetId", detail, created_at as "createdAt"
        from audit_events order by created_at desc limit ${Math.max(1, Math.min(limit, 500))}
      `
      return rows.map((row) => ({ ...row, createdAt: Number(row.createdAt), detail: asJson(row.detail) }))
    },

    async recordSecurityAuditEvent(userId, action, detail = {}) {
      const [user] = await sql`select id, status from app_users where id = ${userId}`
      if (!user || user.status === 'disabled') throw productError('登录状态无效。', 'AUTH_REQUIRED')
      await insertAudit(sql, { actorId: userId, action, detail })
      return { action }
    },

    async close() {
      await sql.end({ timeout: 5 })
    },
  }

  return store
}
