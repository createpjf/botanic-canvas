import { randomUUID } from 'node:crypto'
import { agentThreadSummaryCompareAndSetDecision, canvasGraphConflictCode, canvasMutationConflictCode, canvasSyncEpochStaleError, normalizeAgentEntityIdPage, normalizeCanvasGraphMutation, normalizePendingAgentReviewRecoveryPage, normalizeStaleTurnQuery, normalizeTurnEventPage, normalizeUpdatedAtIdRecoveryPage, persistedAgentSkillVersion } from './productStoreContract.mjs'
import { createClient } from '@supabase/supabase-js'
import { isRetryableSupabaseError, retrySupabaseOperation } from './supabaseRetry.mjs'
import { decodeAuthAssurance } from './authAssurance.mjs'
import { assertProjectPermission, assertWorkspacePermission, projectPermissionDecision } from './authorization.mjs'
import { sendResendInviteEmails } from './resendEmailService.mjs'
import { artifactIndexLimits, artifactsFromActionReceipt, artifactsFromAgentMessage, artifactsFromDocument, artifactsFromGenerationJob, generationArtifactRefreshReport, generationArtifactsFromJobReport } from './botanicArtifactIndex.mjs'
import { agentStateFromDocument, applyAgentSessionReadReceipts, compareAndSetAgentSessionSettings, mergeAgentStateIntoDocument, normalizeAgentSessionSettingsCommand, shouldApplyAgentEntityWrite, stripAgentMessagesFromDocument, validateAgentEntityWriteTimestamp, validateAgentMemoryEntity, validateAgentMessageEntity, validateAgentSessionEntity, validateAgentSessionReadReceipt } from './botanicAgentPersistence.mjs'
import { agentMessageListOptions, encodeAgentMessageCursor, normalizeAgentSessionListLimit } from './agentMessagePersistence.mjs'
import { observeProductStoreRead, timedProductStoreRead } from './productStoreMetrics.mjs'
import { collaborationActivitiesForMember, collaborationActivityListOptions, validateCollaborationActivity } from './collaborationActivityPersistence.mjs'
import {
  agentSubagentEnqueueDecision,
  materializeAgentSubagentEnqueueCommand,
  normalizeAgentSubagentActivationPage,
  normalizeRunnableAgentSubagentPage,
  publicAgentSubagent,
  publicAgentSubagentActivation,
} from './agentSubagentPersistence.mjs'
import {
  materializeAgentContextCommand,
  normalizeAgentContextCompactionPage,
  publicAgentContextCompaction,
} from './agentContextPersistence.mjs'
import { BotanicAgentSkillError } from './botanicAgentSkill.mjs'

const now = () => Date.now()
const clone = (value) => structuredClone(value)
const terminalTurnStatuses = new Set(['waiting_user', 'completed', 'failed', 'cancelled'])
function withoutTerminalTurnOutputPreview(value) {
  const result = clone(value)
  if (terminalTurnStatuses.has(result?.turn?.status)) delete result.turn.outputPreview
  return result
}
const postgrestQuotedValue = (value) => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`

function productError(message, code = 'PRODUCT_STORE_ERROR') {
  const error = new Error(message)
  error.code = code
  return error
}

function fail(error, fallback = 'Supabase 数据操作失败。') {
  if (!error) return
  if (error.code === 'WORKSPACE_STORE_TIMEOUT') throw error
  if (typeof error.message === 'string' && error.message.includes('工作区数据库响应超时')) {
    throw productError('工作区数据库响应超时，请稍后重试。', 'WORKSPACE_STORE_TIMEOUT')
  }
  throw productError(error.message || fallback, error.code)
}

function userFromProfile(profile) {
  return profile ? { id: profile.id, email: profile.email, name: profile.display_name, role: profile.workspace_role } : undefined
}

function agentSubagentFromSupabaseRow(row, { includeLease = true } = {}) {
  if (!row) return undefined
  const dispatch = row.dispatch_activation_sequence === null || row.dispatch_activation_sequence === undefined
    ? undefined
    : {
        ...(row.payload?.dispatch ?? {}),
        generation: Number(row.dispatch_generation),
        activationSequence: Number(row.dispatch_activation_sequence),
        ...(includeLease ? { leaseToken: row.dispatch_lease_token } : {}),
        leaseExpiresAt: new Date(row.dispatch_lease_expires_at).getTime(),
      }
  return {
    ...clone(row.payload ?? {}),
    id: row.id,
    ownerId: row.owner_id,
    projectId: row.project_id,
    rootTurnId: row.root_turn_id,
    ...(row.parent_session_id ? { parentSessionId: row.parent_session_id } : {}),
    sessionId: row.session_id,
    status: row.status,
    cancelGeneration: Number(row.cancel_generation),
    lastEnqueuedSequence: Number(row.last_enqueued_sequence),
    settledThroughSequence: Number(row.settled_through_sequence),
    ...(dispatch ? { dispatch } : {}),
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
  }
}

function agentSubagentActivationFromSupabaseRow(row, { includeLease = true } = {}) {
  if (!row) return undefined
  const stored = clone(row.payload ?? {})
  const { execution: storedExecution, ...payload } = stored
  const execution = row.execution_lease_token
    ? {
        ...(storedExecution ?? {}),
        generation: Number(row.execution_generation),
        cancelGeneration: Number(row.execution_cancel_generation),
        ...(includeLease ? { leaseToken: row.execution_lease_token } : {}),
        leaseExpiresAt: new Date(row.execution_lease_expires_at).getTime(),
      }
    : undefined
  return {
    ...payload,
    subagentId: row.subagent_id,
    sequence: Number(row.sequence),
    turnId: row.turn_id,
    inputMessageId: row.input_message_id,
    resultMessageId: row.result_message_id,
    sourceTurnId: row.source_turn_id,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    cancelGeneration: Number(row.subagent_generation),
    ...(execution ? { execution } : {}),
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
    ...(row.settled_at ? { settledAt: new Date(row.settled_at).getTime() } : {}),
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

function projectDocumentSummary(document) {
  const nodes = Array.isArray(document?.nodes) ? document.nodes : []
  const images = nodes
    .filter((node) => node?.type === 'result' && typeof node?.data?.image === 'string')
    .map((node) => node.data.image)
  return { nodeCount: nodes.length, resultCount: images.length, coverImage: images.at(-1) }
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

/**
 * Supabase ProductStore。Auth 由 Supabase 管理；所有服务端数据写入使用 secret
 * key，浏览器凭 JWT 访问时仍受数据库与 Storage RLS 保护。
 */
export function createSupabaseProductStore({ url, secretKey, bootstrapEmail, inviteRedirectTo, emailService }) {
  if (!url || !secretKey) throw new Error('SUPABASE_URL 与 SUPABASE_SECRET_KEY 未配置。')
  const storageTimeoutMs = 8_000
  const timedFetch = async (input, init = {}) => {
    const timeoutController = new AbortController()
    const timeoutId = setTimeout(() => timeoutController.abort(), storageTimeoutMs)
    const signal = init.signal
      ? AbortSignal.any([init.signal, timeoutController.signal])
      : timeoutController.signal
    try {
      return await fetch(input, { ...init, signal })
    } catch (caught) {
      if (timeoutController.signal.aborted) {
        throw productError('工作区数据库响应超时，请稍后重试。', 'WORKSPACE_STORE_TIMEOUT')
      }
      throw caught
    } finally {
      clearTimeout(timeoutId)
    }
  }
  const supabase = createClient(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { fetch: timedFetch },
  })

  // Supabase-js 将 HTTP 5xx 放在 result.error 中而非抛出；统一转换后才可重试。
  async function supabaseRequest(operation) {
    try {
      return await retrySupabaseOperation(async () => {
        const result = await operation()
        if (result?.error && isRetryableSupabaseError(result.error)) throw result.error
        return result
      })
    } catch (error) {
      return { data: undefined, error }
    }
  }

  async function profileForAuthUser(authUser) {
    const email = authUser.email ?? ''
    const displayName = typeof authUser.user_metadata?.display_name === 'string' && authUser.user_metadata.display_name.trim()
      ? authUser.user_metadata.display_name.trim()
      : email.split('@')[0] || 'Botanic Member'
    let { data: profile, error } = await supabaseRequest(() => supabase.from('profiles').select('*').eq('id', authUser.id).maybeSingle())
    fail(error)
    if (!profile) {
      const { count, error: countError } = await supabaseRequest(() => supabase.from('profiles').select('*', { count: 'exact', head: true }))
      fail(countError)
      const workspaceRole = (bootstrapEmail && email.toLowerCase() === bootstrapEmail.toLowerCase()) || !Number(count) ? 'owner' : 'member'
      const { data, error: insertError } = await supabaseRequest(() => supabase
        .from('profiles')
        .upsert({ id: authUser.id, email, display_name: displayName, workspace_role: workspaceRole }, { onConflict: 'id' })
        .select('*')
        .single())
      fail(insertError)
      profile = data
    }
    if (bootstrapEmail && email.toLowerCase() === bootstrapEmail.toLowerCase() && profile.workspace_role !== 'owner') {
      const { count, error: ownerCountError } = await supabaseRequest(() => supabase
        .from('profiles').select('*', { count: 'exact', head: true }).eq('workspace_role', 'owner'))
      fail(ownerCountError)
      if (!Number(count)) {
        const { data, error: promoteError } = await supabaseRequest(() => supabase
          .from('profiles').update({ workspace_role: 'owner' }).eq('id', authUser.id).select('*').single())
        fail(promoteError)
        profile = data
      }
    }
    return profile
  }

  async function memberRole(projectId, userId) {
    const { data, error } = await supabaseRequest(() => supabase.from('project_members').select('role').eq('project_id', projectId).eq('user_id', userId).maybeSingle())
    fail(error)
    return data?.role
  }

  async function insertAudit({ actorId, action, projectId, targetId, detail = {} }) {
    const { error } = await supabaseRequest(() => supabase.from('audit_events').insert({
      id: `audit_${randomUUID()}`, actor_id: actorId, action, project_id: projectId ?? null,
      target_id: targetId ?? null, detail,
    }))
    fail(error)
  }

  async function inviteAuthUser(email, name, welcome = true) {
    const options = {
      data: { display_name: name || email },
      ...(inviteRedirectTo ? { redirectTo: inviteRedirectTo } : {}),
    }
    if (!emailService) {
      const { data, error } = await supabase.auth.admin.inviteUserByEmail(email, options)
      fail(error, '邀请成员失败。')
      if (!data?.user) throw productError('邀请成员失败。', 'USER_CREATE_FAILED')
      return data.user
    }

    const { data, error } = await supabase.auth.admin.generateLink({ type: 'invite', email, options })
    fail(error, '验证链接生成失败。')
    if (!data?.user?.id || typeof data.properties?.action_link !== 'string') {
      throw productError('验证链接生成失败。', 'USER_INVITE_LINK_FAILED')
    }
    try {
      await sendResendInviteEmails({
        emailService,
        userId: data.user.id,
        email,
        name,
        actionLink: data.properties.action_link,
        welcome,
      })
    } catch (caught) {
      const failure = productError('邀请邮件发送失败，请稍后重试。', 'USER_INVITE_EMAIL_FAILED')
      failure.cause = caught
      throw failure
    }
    return data.user
  }

  const missingAgentEntityTable = (error) => error?.code === '42P01' || error?.code === 'PGRST205'
  const missingAgentEntityRpc = (error) => error?.code === '42883' || error?.code === 'PGRST202'

  async function collectSupabaseRows(buildQuery, maximum = 40_000) {
    const rows = []
    for (let offset = 0; offset < maximum; offset += 1000) {
      const result = await supabaseRequest(() => buildQuery().range(offset, Math.min(offset + 999, maximum - 1)))
      if (result.error) return result
      rows.push(...(result.data ?? []))
      if ((result.data ?? []).length < 1000) break
    }
    return { data: rows, error: undefined }
  }

  async function readAgentStateRows(projectId, userId, options = {}) {
    const startedAt = Date.now()
    const includeMessages = options.includeMessages !== false
    const includeSubagents = options.includeSubagents === true
    try {
    const sessionQuery = () => {
      let query = supabase.from('agent_sessions').select('payload').eq('project_id', projectId)
      if (!includeSubagents) query = query.or('payload->>kind.is.null,payload->>kind.neq.subagent')
      return query.order('updated_at', { ascending: false }).limit(80)
    }
    const results = await Promise.all([
      supabaseRequest(sessionQuery),
      includeMessages
        ? collectSupabaseRows(() => supabase.from('agent_messages').select('session_id,updated_at,payload').eq('project_id', projectId).order('updated_at', { ascending: false }))
        : Promise.resolve({ data: [], error: undefined }),
      supabaseRequest(() => supabase.from('agent_memory_items').select('id,deleted_at,payload').eq('project_id', projectId).order('updated_at', { ascending: false }).limit(200)),
      supabaseRequest(() => supabase.from('agent_runs').select('payload').eq('project_id', projectId).order('updated_at', { ascending: false }).limit(60)),
      userId
        ? supabaseRequest(() => supabase.from('agent_session_read_receipts').select('session_id,message_id,updated_at').eq('project_id', projectId).eq('user_id', userId))
        : Promise.resolve({ data: [], error: undefined }),
    ])
    if (results.slice(0, 4).some((result) => missingAgentEntityTable(result.error))) {
      observeProductStoreRead('readAgentStateRows', {
        projectId, userId, includeMessages, durationMs: Date.now() - startedAt, ok: true, sessionCount: 0, messageRowCount: 0,
      })
      return { sessions: [], messages: [], memory: [], deletedMemoryIds: [], runs: [] }
    }
    results.slice(0, 4).forEach((result) => fail(result.error))
    if (results[4].error && !missingAgentEntityTable(results[4].error)) fail(results[4].error)
    const [sessions, rawMessages, memory, runs] = results.map((result) => result.data ?? [])
    const visibleSessionIds = new Set(sessions.map((row) => row.payload?.id).filter(Boolean))
    const messages = includeSubagents
      ? rawMessages
      : rawMessages.filter((row) => visibleSessionIds.has(row.session_id))
    const receipts = results[4].error ? [] : results[4].data ?? []
    const result = {
      sessions: applyAgentSessionReadReceipts(sessions.map((row) => clone(row.payload)), receipts.map((row) => ({
        sessionId: row.session_id,
        messageId: row.message_id,
        updatedAt: new Date(row.updated_at).getTime(),
      }))),
      messages: messages.map((row) => ({ sessionId: row.session_id, updatedAt: new Date(row.updated_at).getTime(), message: clone(row.payload) })),
      memory: memory.filter((row) => !row.deleted_at).map((row) => clone(row.payload)),
      deletedMemoryIds: memory.filter((row) => row.deleted_at).map((row) => row.id),
      runs: runs.map((row) => clone(row.payload)),
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

  async function syncLegacyReadingReceipts(userId, projectId, extracted) {
    for (const session of extracted.sessions) {
      if (!session.readingAnchorMessageId || session.readingAnchorUpdatedAt === undefined) continue
      const messageExists = extracted.messages.some((entry) => entry.sessionId === session.id && entry.message.id === session.readingAnchorMessageId)
      if (!messageExists) continue
      const { error } = await supabaseRequest(() => supabase.rpc('botanic_put_agent_session_read_receipt', {
        p_user_id: userId,
        p_project_id: projectId,
        p_session_id: session.id,
        p_message_id: session.readingAnchorMessageId,
        p_updated_at: new Date(session.readingAnchorUpdatedAt).toISOString(),
      }))
      if (missingAgentEntityRpc(error) || missingAgentEntityTable(error)) return
      fail(error)
    }
  }

  async function upsertArtifactRecords(userId, projectId, artifacts) {
    for (let offset = 0; offset < artifacts.length; offset += 500) {
      const batch = artifacts.slice(offset, offset + 500)
      const rows = batch.map((artifact) => ({
        id: artifact.id,
        kind: artifact.kind,
        source_kind: artifact.origin.type,
        run_id: artifact.provenance.runId ?? null,
        job_id: artifact.origin.jobId ?? null,
        created_at: new Date(artifact.createdAt).toISOString(),
        updated_at: new Date(artifact.updatedAt).toISOString(),
        payload: artifact,
      }))
      const { error } = await supabaseRequest(() => supabase.rpc('botanic_upsert_agent_artifacts_monotonic', {
        p_actor_id: userId,
        p_project_id: projectId,
        p_artifacts: rows,
      }))
      if (missingAgentEntityRpc(error) || missingAgentEntityTable(error)) return false
      fail(error)
    }
    return true
  }

  async function refreshGenerationArtifactRecords(userId, job, document) {
    const conversion = generationArtifactsFromJobReport(job, { document })
    const written = await upsertArtifactRecords(userId, job.projectId, conversion.artifacts)
    if (!written) return generationArtifactRefreshReport(conversion, [])
    const { data, error } = await supabaseRequest(() => supabase.from('agent_artifacts')
      .select('id').eq('project_id', job.projectId).eq('job_id', job.id))
    fail(error)
    return generationArtifactRefreshReport(conversion, data ?? [])
  }

  async function syncAgentStateFromDocument(userId, document, previousDocument) {
    const extracted = agentStateFromDocument(document)
    const sessionRows = extracted.sessions.map((session) => ({
      id: session.id, owner_id: userId, project_id: document.id,
      updated_at: new Date(session.updatedAt).toISOString(), payload: session,
    }))
    const messageRows = extracted.messages.map((entry) => ({
      id: entry.message.id, owner_id: userId, project_id: document.id, session_id: entry.sessionId,
      updated_at: new Date(entry.updatedAt).toISOString(), payload: entry.message,
    }))
    const memoryRows = extracted.memory.map((memory) => ({
      id: memory.id, owner_id: userId, project_id: document.id,
      updated_at: new Date(memory.updatedAt).toISOString(), deleted_at: null, payload: memory,
    }))
    const runRows = extracted.runs.map((run) => ({
      id: run.id, owner_id: userId, project_id: document.id, status: run.status,
      updated_at: new Date(Number(run.updatedAt) || now()).toISOString(), payload: { ...run, ownerId: userId, projectId: document.id },
    }))
    const previousMemoryIds = new Set((Array.isArray(previousDocument?.agentMemory) ? previousDocument.agentMemory : []).map((item) => item?.id).filter(Boolean))
    const nextMemoryIds = new Set(extracted.memory.map((item) => item.id))
    const removedIds = [...previousMemoryIds].filter((id) => !nextMemoryIds.has(id))
    const deletedAt = new Date().toISOString()
    const deletedMemoryRows = removedIds.map((id) => ({ id, deleted_at: deletedAt }))

    // 派生字段必须由数据库在同一事务中保留；两个能力标记使旧的同名
    // 7/8/9 参数 RPC 不会被 PostgREST 误匹配，缺迁移时拒绝非原子降级。
    const { error: rpcError } = await supabaseRequest(() => supabase.rpc('botanic_sync_agent_entities', {
      p_owner_id: userId,
      p_project_id: document.id,
      p_sessions: sessionRows,
      p_messages: messageRows,
      p_memory: memoryRows,
      p_runs: runRows,
      p_deleted_memory: deletedMemoryRows,
      p_preserve_thread_summary: true,
      p_preserve_entity_references: true,
      p_insert_sessions_only: true,
    }))
    if (rpcError) {
      if (missingAgentEntityRpc(rpcError)) {
        throw productError('Agent 派生字段原子写入迁移尚未部署。', 'AGENT_DERIVED_FIELDS_ATOMIC_WRITE_REQUIRED')
      }
      if (rpcError.code === '23514' && String(rpcError.message).includes('AGENT_MESSAGE_TURN_ID_CONFLICT')) {
        throw productError('Agent 消息已绑定其他 Turn。', 'AGENT_MESSAGE_TURN_ID_CONFLICT')
      }
      if (rpcError.code === '23514' && String(rpcError.message).includes('AGENT_MESSAGE_ROLE_CONFLICT')) {
        throw productError('Agent 消息作者角色不可改绑。', 'AGENT_MESSAGE_ROLE_CONFLICT')
      }
      if (rpcError.code === '23514' && String(rpcError.message).includes('AGENT_MESSAGE_TURN_REQUEST_CONFLICT')) {
        throw productError('Agent 消息已绑定其他 Turn 请求快照。', 'AGENT_MESSAGE_TURN_REQUEST_CONFLICT')
      }
      if (rpcError.code === '23514' && String(rpcError.message).includes('AGENT_MESSAGE_ENTITY_REFERENCES_CONFLICT')) {
        throw productError('Agent Turn 结果业务引用发生冲突。', 'AGENT_MESSAGE_ENTITY_REFERENCES_CONFLICT')
      }
      fail(rpcError)
    }
    await syncLegacyReadingReceipts(userId, document.id, extracted)
    await upsertArtifactRecords(userId, document.id, artifactsFromDocument(document))
  }

  async function assertAgentDerivedFieldWriterAvailable(userId, projectId) {
    const { error } = await supabaseRequest(() => supabase.rpc('botanic_sync_agent_entities', {
      p_owner_id: userId,
      p_project_id: projectId,
      p_sessions: [],
      p_messages: [],
      p_memory: [],
      p_runs: [],
      p_deleted_memory: [],
      p_preserve_thread_summary: true,
      p_preserve_entity_references: true,
      p_insert_sessions_only: true,
    }))
    if (missingAgentEntityRpc(error)) {
      throw productError('Agent 派生字段原子写入迁移尚未部署。', 'AGENT_DERIVED_FIELDS_ATOMIC_WRITE_REQUIRED')
    }
    fail(error)
  }

  async function generationFenceRpc(name, args) {
    const { data, error } = await supabaseRequest(() => supabase.rpc(name, args))
    if (error) {
      if (missingAgentEntityRpc(error)) {
        throw productError('Generation Job 执行围栏迁移尚未部署。', 'GENERATION_JOB_ATOMIC_FENCE_REQUIRED')
      }
      if (error.code === '22023') {
        throw productError('Generation Job 状态转换参数无效。', 'GENERATION_JOB_TRANSITION_INVALID')
      }
      fail(error)
    }
    return clone(data)
  }

  async function agentReviewFenceRpc(name, args) {
    const { data, error } = await supabaseRequest(() => supabase.rpc(name, args))
    if (error) {
      if (missingAgentEntityRpc(error) || missingAgentEntityTable(error)) {
        throw productError('Agent Review 执行围栏迁移尚未部署。', 'AGENT_REVIEW_ATOMIC_FENCE_REQUIRED')
      }
      if (error.code === '22023') {
        throw productError('Agent Review 状态转换参数无效。', 'AGENT_REVIEW_TRANSITION_INVALID')
      }
      fail(error)
    }
    return clone(data)
  }

  async function agentReviewHumanDecisionRpc(name, args) {
    const { data, error } = await supabaseRequest(() => supabase.rpc(name, args))
    if (error) {
      if (missingAgentEntityRpc(error) || missingAgentEntityTable(error)) {
        throw productError(
          'Agent Review retry 原子提交迁移尚未部署。',
          'AGENT_REVIEW_RETRY_ATOMIC_REQUIRED',
        )
      }
      if (error.code === '42501') {
        throw productError('你没有提交该评审决定的权限。', 'PROJECT_WRITE_FORBIDDEN')
      }
      if (error.code === '22023') {
        throw productError('Agent Review 状态转换参数无效。', 'AGENT_REVIEW_TRANSITION_INVALID')
      }
      fail(error)
    }
    if (!data || typeof data !== 'object' || !Array.isArray(data.retryRuns)) {
      throw productError(
        'Agent Review retry 原子提交响应格式无效。',
        'AGENT_REVIEW_RETRY_ATOMIC_RESPONSE_INVALID',
      )
    }
    return clone(data)
  }

  async function agentSubagentRpc(name, args) {
    const { data, error } = await supabaseRequest(() => supabase.rpc(name, args))
    if (error) {
      if (missingAgentEntityRpc(error) || missingAgentEntityTable(error)) {
        throw productError('AgentSubagent 原子运行时迁移尚未部署。', 'AGENT_SUBAGENT_ATOMIC_RUNTIME_REQUIRED')
      }
      if (error.code === '42501') {
        throw productError('你没有操作该 Subagent 的权限。', 'PROJECT_WRITE_FORBIDDEN')
      }
      if (error.code === '22023') {
        throw productError('AgentSubagent 状态转换参数无效。', 'AGENT_SUBAGENT_TRANSITION_INVALID')
      }
      if (error.code === 'PSS05') {
        throw productError('Subagent 根 Turn 不存在。', 'AGENT_SUBAGENT_ROOT_TURN_NOT_FOUND')
      }
      if (error.code === 'PSS06') {
        throw productError(
          'Agent Turn 已进入取消或失败状态，不能再派发 Subagent。',
          'AGENT_TURN_DELEGATION_CANCELLED',
        )
      }
      if (error.code === 'PSS07') {
        throw productError('Agent Turn 执行权已过期，不能派发 Subagent。', 'AGENT_SUBAGENT_ROOT_EXECUTION_STALE')
      }
      if (error.code === 'PSS08') {
        throw productError('Agent Turn 尚未取得执行权，不能派发 Subagent。', 'AGENT_SUBAGENT_ROOT_TURN_NOT_READY')
      }
      if (['PSS01', 'PSS03'].includes(error.code)) {
        throw productError(error.message || 'AgentSubagent 持久化冲突。', 'AGENT_SUBAGENT_PERSISTENCE_CONFLICT')
      }
      fail(error)
    }
    return clone(data)
  }

  const agentSubagentColumns = [
    'id', 'owner_id', 'project_id', 'root_turn_id', 'parent_session_id', 'session_id',
    'status', 'cancel_generation', 'last_enqueued_sequence', 'settled_through_sequence',
    'dispatch_generation', 'dispatch_activation_sequence', 'dispatch_lease_token',
    'dispatch_lease_expires_at', 'idempotency_key', 'request_hash', 'payload',
    'created_at', 'updated_at',
  ].join(',')
  const agentSubagentActivationColumns = [
    'subagent_id', 'sequence', 'turn_id', 'input_message_id', 'result_message_id',
    'source_turn_id', 'idempotency_key', 'request_hash', 'subagent_generation',
    'execution_generation', 'execution_cancel_generation', 'execution_lease_token',
    'execution_lease_expires_at',
    'payload', 'created_at', 'updated_at', 'settled_at',
  ].join(',')

  async function readSupabaseSubagentForRuntime(subagentId) {
    const { data, error } = await supabaseRequest(() => supabase.from('agent_subagents')
      .select(agentSubagentColumns).eq('id', subagentId).maybeSingle())
    if (missingAgentEntityTable(error)) {
      throw productError('AgentSubagent 原子运行时迁移尚未部署。', 'AGENT_SUBAGENT_ATOMIC_RUNTIME_REQUIRED')
    }
    fail(error)
    return data ? agentSubagentFromSupabaseRow(data) : undefined
  }

  async function recoveryKeysetRpc(name, args) {
    const { data, error } = await supabaseRequest(() => supabase.rpc(name, args))
    if (error) {
      if (missingAgentEntityRpc(error) || missingAgentEntityTable(error)) {
        throw productError('Agent Recovery 稳定分页迁移尚未部署。', 'AGENT_RECOVERY_KEYSET_REQUIRED')
      }
      if (error.code === '22023') {
        throw productError('Agent Recovery 分页参数无效。', 'AGENT_RECOVERY_CURSOR_INVALID')
      }
      fail(error)
    }
    if (!Array.isArray(data)) {
      throw productError('Agent Recovery 分页响应格式无效。', 'AGENT_RECOVERY_KEYSET_RESPONSE_INVALID')
    }
    return data.map(clone)
  }

  async function projectGenerationJob(userId, job, options = {}) {
    const { updateAgentRun = true, recordAudit = true, syncArtifacts = true } = options
    let artifactReady = true
    if (syncArtifacts) {
      try {
        const [{ data: project, error: projectError }, { data: graph, error: graphError }] = await Promise.all([
          supabaseRequest(() => supabase.from('projects').select('document').eq('id', job.projectId).maybeSingle()),
          supabaseRequest(() => supabase.from('canvas_graphs').select('graph').eq('project_id', job.projectId).maybeSingle()),
        ])
        fail(projectError)
        fail(graphError)
        const document = project?.document
          ? { ...clone(project.document), ...clone(graph?.graph ?? {}) }
          : undefined
        artifactReady = (await refreshGenerationArtifactRecords(userId, job, document)).status === 'passed'
      } catch (caught) {
        artifactReady = false
        console.warn(`[artifact-index] generation sync deferred for ${job.id}: ${caught instanceof Error ? caught.message : String(caught)}`)
      }
    }
    const terminalNeedsArtifacts = ['succeeded', 'failed'].includes(job.status) && Boolean(job.outputs?.length)
    if (updateAgentRun && job.agentRun?.runId && (!terminalNeedsArtifacts || !syncArtifacts || artifactReady)) {
      const { data, error } = await supabaseRequest(() => supabase.rpc('botanic_project_generation_job_to_agent_run', {
        p_owner_id: userId,
        p_project_id: job.projectId,
        p_job: clone(job),
      }))
      if (error) {
        if (missingAgentEntityRpc(error)) {
          throw productError('Generation Job 的 Agent Run 原子投影迁移尚未部署。', 'GENERATION_JOB_ATOMIC_FENCE_REQUIRED')
        }
        if (error.code === '42501') throw productError('你没有更新该 Agent Run 的权限。', 'PROJECT_WRITE_FORBIDDEN')
        if (error.code === '22023') throw productError('Generation Job 的 Agent Run 投影参数无效。', 'GENERATION_JOB_TRANSITION_INVALID')
        fail(error)
      }
      if (!data) throw productError('未找到关联的 Agent Run。', 'AGENT_RUN_NOT_FOUND')
    }
    // 审计不可用不能让已成功的原子状态转换在客户端表现为失败。
    if (recordAudit) {
      try {
        await insertAudit({
          actorId: userId,
          action: `generation.${job.status}`,
          projectId: job.projectId,
          targetId: job.id,
          detail: { model: job.settings?.model, batchCount: job.batchCount },
        })
      } catch (error) {
        console.warn(`[generation] audit deferred for ${job.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return clone(job)
  }

  return {
    authProvider: 'supabase',

    async authenticate(accessToken) {
      if (!accessToken) return undefined
      const { data, error } = await supabaseRequest(() => supabase.auth.getUser(accessToken))
      if (error || !data.user) return undefined
      return userFromProfile(await profileForAuthUser(data.user))
    },

    async authAssurance(accessToken) {
      if (!accessToken) return undefined
      const { data, error } = await supabaseRequest(() => supabase.auth.getUser(accessToken))
      if (error || !data?.user) return undefined
      return decodeAuthAssurance(accessToken)
    },

    async createUser(actorId, { email, name, role = 'member' }) {
      const { data: actor, error: actorError } = await supabase.from('profiles').select('workspace_role').eq('id', actorId).maybeSingle()
      fail(actorError)
      assertWorkspacePermission({ role: actor?.workspace_role, status: 'active' }, 'manage-members', 'USER_CREATE_FORBIDDEN')
      const authUser = await inviteAuthUser(email, name)
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .upsert({ id: authUser.id, email, display_name: name || email, workspace_role: role }, { onConflict: 'id' })
        .select('*')
        .single()
      fail(profileError)
      await insertAudit({ actorId, action: 'member.invited', targetId: profile.id, detail: { email, role } })
      return userFromProfile(profile)
    },

    async listProjects(userId) {
      return timedProductStoreRead('listProjects', { userId }, async () => {
      // 与 Postgres Adapter 一样：列表只读图谱，不拉整份 document JSONB。
      const { data, error } = await supabase
        .from('project_members')
        .select('role, projects!inner(id, name, updated_at, revision)')
        .eq('user_id', userId)
      fail(error)
      const projectIds = (data ?? []).map((row) => row.projects.id)
      const graphResult = projectIds.length
        ? await supabase.from('canvas_graphs').select('project_id, graph, revision, updated_at').in('project_id', projectIds)
        : { data: [], error: null }
      fail(graphResult.error)
      const graphByProject = new Map((graphResult.data ?? []).map((entry) => [entry.project_id, entry]))
      return (data ?? []).map((row) => {
        const entry = graphByProject.get(row.projects.id)
        const graph = entry?.graph ?? { nodes: [], edges: [] }
        return {
          id: row.projects.id,
          name: row.projects.name,
          updatedAt: Math.max(
            new Date(row.projects.updated_at).getTime(),
            entry?.updated_at ? new Date(entry.updated_at).getTime() : 0,
          ),
          revision: row.projects.revision,
          graphRevision: entry?.revision ?? 1,
          ...projectDocumentSummary(graph),
          role: row.role,
        }
      }).sort((a, b) => b.updatedAt - a.updatedAt)
      })
    },

    async readProject(userId, projectId) {
      return timedProductStoreRead('readProject', { projectId, userId }, async () => {
        const role = await memberRole(projectId, userId)
        if (!role) return undefined
        const [{ data, error }, graphResult, agentState] = await Promise.all([
          supabase.from('projects').select('document, revision, updated_at').eq('id', projectId).maybeSingle(),
          supabase.from('canvas_graphs').select('graph, revision, sync_protocol_epoch, updated_at').eq('project_id', projectId).maybeSingle(),
          readAgentStateRows(projectId, userId, { includeMessages: false }),
        ])
        fail(error)
        fail(graphResult.error)
        if (!data) return undefined
        const graph = graphResult.data?.graph ?? canvasGraph(data.document)
        const updatedAt = Math.max(
          Number(data.document.updatedAt ?? 0),
          data.updated_at ? new Date(data.updated_at).getTime() : 0,
          graphResult.data?.updated_at ? new Date(graphResult.data.updated_at).getTime() : 0,
        )
        return {
          document: mergeAgentStateIntoDocument({ ...clone(data.document), ...clone(graph), updatedAt }, agentState, { includeMessages: false }),
          revision: data.revision,
          graphRevision: graphResult.data?.revision ?? 1,
          syncProtocolEpoch: Number(graphResult.data?.sync_protocol_epoch ?? 1),
          readMetrics: { messageRowCount: 0, sessionCount: agentState.sessions?.length ?? 0 },
        }
      })
    },

    async projectAccess(userId, projectId) {
      const [{ data: project, error: projectError }, role] = await Promise.all([
        supabase.from('projects').select('id').eq('id', projectId).maybeSingle(),
        memberRole(projectId, userId),
      ])
      fail(projectError)
      return { exists: Boolean(project), role }
    },

    async canEditProject(userId, projectId) {
      const role = await memberRole(projectId, userId)
      return projectPermissionDecision(role, 'edit') === 'allow'
    },

    async readCanvasSyncProtocolEpoch(userId, projectId) {
      if (!await memberRole(projectId, userId)) return undefined
      const { data, error } = await supabase.from('canvas_graphs')
        .select('sync_protocol_epoch').eq('project_id', projectId).maybeSingle()
      fail(error)
      return data ? Number(data.sync_protocol_epoch ?? 1) : undefined
    },

    /**
     * ponytail: PostgREST 无事务，这里用 CAS 重试 ×5（指数退避）近似原子更新，
     * 热点冲突持续时的升级路径是新增 SQL 内行锁合并的 patch RPC。
     * 与 PG/本地 Adapter 同一契约：mutate 拿到最新合并文档，返回 undefined 表示无需写入。
     */
    async updateProjectDocument(userId, projectId, mutate) {
      for (let attempt = 0; ; attempt += 1) {
        const project = await this.readProject(userId, projectId)
        if (!project) return undefined
        const next = mutate(clone(project.document))
        if (!next) return undefined
        try {
          return await this.writeProject(userId, next, project.revision, project.graphRevision)
        } catch (caught) {
          if ((caught?.code !== 'PROJECT_CONFLICT' && caught?.code !== 'CANVAS_GRAPH_CONFLICT') || attempt >= 4) throw caught
          await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, 100 * (2 ** attempt))))
        }
      }
    },

    async writeProject(userId, document, expectedRevision, expectedGraphRevision) {
      // 项目 RPC 一旦成功就不能回滚；先证明派生字段安全同步能力已部署，
      // 避免缺迁移时先把带旧 Summary 的兼容文档写成功再报错。
      await assertAgentDerivedFieldWriterAvailable(userId, document.id)
      const [{ data: previous, error: previousError }, { data: graphEntry, error: graphError }] = await Promise.all([
        supabaseRequest(() => supabase.from('projects').select('document').eq('id', document.id).maybeSingle()),
        supabaseRequest(() => supabase.from('canvas_graphs').select('graph, sync_protocol_epoch').eq('project_id', document.id).maybeSingle()),
      ])
      fail(previousError)
      fail(graphError)
      const syncProtocolEpoch = Number(graphEntry?.sync_protocol_epoch ?? 1)
      if (syncProtocolEpoch >= 2 && !sameGraph(graphEntry?.graph ?? canvasGraph(previous?.document), canvasGraph(document))) {
        throw canvasSyncEpochStaleError(syncProtocolEpoch)
      }
      const rpcDocument = { ...stripAgentMessagesFromDocument(document) }
      if (syncProtocolEpoch >= 2) {
        delete rpcDocument.nodes
        delete rpcDocument.edges
      }
      const { data, error } = await supabase.rpc('botanic_write_project_document', {
        p_actor: userId,
        p_document: rpcDocument,
        p_expected_revision: Number.isInteger(expectedRevision) ? expectedRevision : null,
        p_expected_graph_revision: syncProtocolEpoch >= 2
          ? null
          : Number.isInteger(expectedGraphRevision) ? expectedGraphRevision : null,
      }).single()
      if (error?.code === '40001') throw productError('项目已被其他成员更新，请刷新后再保存。', 'PROJECT_CONFLICT')
      if (error?.code === 'BG001') {
        if (syncProtocolEpoch >= 2) throw canvasSyncEpochStaleError(syncProtocolEpoch)
        throw productError('画布已被其他成员更新，请刷新后再保存。', 'CANVAS_GRAPH_CONFLICT')
      }
      if (error?.code === '55000') {
        const staleEpoch = Number(error.details)
        throw canvasSyncEpochStaleError(Number.isInteger(staleEpoch) && staleEpoch > 0 ? staleEpoch : syncProtocolEpoch)
      }
      if (error?.code === '42501') throw productError('你没有编辑该项目的权限。', 'PROJECT_WRITE_FORBIDDEN')
      fail(error, '项目保存失败。')
      try {
        await syncAgentStateFromDocument(userId, document, previous?.document)
      } catch (caught) {
        if (caught?.code === 'AGENT_DERIVED_FIELDS_ATOMIC_WRITE_REQUIRED'
          || caught?.code === 'AGENT_MESSAGE_TURN_ID_CONFLICT') throw caught
        // Supabase RPC 已原子保存兼容文档；实体双写失败不能把已成功的项目保存
        // 伪装成失败。读取仍会回退旧字段，下一次写入继续补偿。
        console.warn(`[agent-persistence] entity sync deferred for ${document.id}: ${caught instanceof Error ? caught.message : String(caught)}`)
      }
      return {
        document: clone(data.document),
        revision: data.revision,
        graphRevision: data.graph_revision,
        syncProtocolEpoch: Number(data.sync_protocol_epoch ?? syncProtocolEpoch),
        created: data.created,
      }
    },

    async deleteProject(userId, projectId) {
      assertProjectPermission(await memberRole(projectId, userId), 'delete-project', 'PROJECT_DELETE_FORBIDDEN')
      const { data: project, error: projectError } = await supabase.from('projects').select('name').eq('id', projectId).maybeSingle()
      fail(projectError)
      if (!project) return false
      const { error: mediaError } = await supabase.from('media_objects').delete().eq('project_id', projectId)
      fail(mediaError)
      const { error } = await supabase.from('projects').delete().eq('id', projectId)
      fail(error)
      await insertAudit({ actorId: userId, action: 'project.deleted', targetId: projectId, detail: { name: project.name } })
      return true
    },

    async addProjectMember(actorId, projectId, userId, role) {
      assertProjectPermission(await memberRole(projectId, actorId), 'manage-members', 'PROJECT_MEMBER_FORBIDDEN')
      const { data: profile, error: profileError } = await supabase.from('profiles').select('id').eq('id', userId).maybeSingle()
      fail(profileError)
      if (!profile) throw productError('未找到成员。', 'USER_NOT_FOUND')
      const { error } = await supabase.from('project_members').upsert({ project_id: projectId, user_id: userId, role }, { onConflict: 'project_id,user_id' })
      fail(error)
      const { error: updateError } = await supabase.from('projects').update({ updated_at: new Date().toISOString() }).eq('id', projectId)
      fail(updateError)
      await insertAudit({ actorId, action: 'project.member.upserted', projectId, targetId: userId, detail: { role } })
    },

    async loadCanvasCollaboration(userId, projectId) {
      const { data, error } = await supabase.rpc('botanic_load_canvas_collaboration', {
        p_actor: userId,
        p_project_id: projectId,
      }).maybeSingle()
      fail(error)
      if (!data) return undefined
      return {
        graph: clone(data.graph),
        graphRevision: data.graph_revision,
        syncProtocolEpoch: Number(data.sync_protocol_epoch ?? 1),
        snapshot: data.snapshot ?? undefined,
        updates: data.updates ?? [],
        updatedAt: new Date(data.updated_at).getTime(),
      }
    },

    async appendCanvasGraphUpdate(userId, projectId, input) {
      const { update, graph, mutationId, payloadHash, expectedGraphRevision, syncProtocolEpoch } = normalizeCanvasGraphMutation(input)
      const { data, error } = await supabase.rpc('botanic_append_canvas_graph_update', {
        p_actor: userId,
        p_project_id: projectId,
        p_update_base64: update,
        p_graph: graph,
        p_mutation_id: mutationId,
        p_payload_sha256: payloadHash,
        p_expected_graph_revision: expectedGraphRevision ?? null,
        p_sync_protocol_epoch: syncProtocolEpoch ?? null,
      }).single()
      if (error?.code === '42501') throw productError('你没有编辑该项目的权限。', 'PROJECT_WRITE_FORBIDDEN')
      if (error?.code === '40001') throw productError('画布已被其他成员更新，请重新同步。', canvasGraphConflictCode)
      if (error?.code === '22000') throw productError('画布协作提交身份已绑定到其他更新。', canvasMutationConflictCode)
      if (error?.code === '55000') {
        const syncProtocolEpoch = Number(error.details)
        throw canvasSyncEpochStaleError(Number.isInteger(syncProtocolEpoch) && syncProtocolEpoch > 0 ? syncProtocolEpoch : undefined)
      }
      fail(error, '画布协作更新保存失败。')
      return {
        graphRevision: data.graph_revision,
        mutationRevision: data.mutation_revision,
        updateCount: data.update_count,
        updatedAt: new Date(data.updated_at).getTime(),
        duplicate: data.duplicate,
        ...(data.committed_update ? { update: data.committed_update } : {}),
      }
    },

    async compactCanvasGraphUpdates(userId, projectId, { snapshot, graph, expectedGraphRevision }) {
      if (typeof snapshot !== 'string' || !snapshot || !Array.isArray(graph?.nodes) || !Array.isArray(graph?.edges)) {
        throw new TypeError('画布协作快照格式无效。')
      }
      if (expectedGraphRevision !== undefined
        && (!Number.isInteger(expectedGraphRevision) || expectedGraphRevision < 1)) {
        throw new TypeError('画布协作 expectedGraphRevision 无效。')
      }
      const { data, error } = await supabase.rpc('botanic_compact_canvas_graph_updates', {
        p_actor: userId,
        p_project_id: projectId,
        p_snapshot: snapshot,
        p_graph: graph,
        p_expected_graph_revision: expectedGraphRevision ?? null,
      }).single()
      if (error?.code === '42501') throw productError('你没有编辑该项目的权限。', 'PROJECT_WRITE_FORBIDDEN')
      if (error?.code === '40001') throw productError('画布已被其他成员更新，请重新同步。', canvasGraphConflictCode)
      fail(error, '画布协作快照保存失败。')
      return { graphRevision: data.graph_revision, updatedAt: new Date(data.updated_at).getTime() }
    },

    async readGlobalAssetLibrary(_userId, id) {
      // 品牌素材库属于整个工作区，而非单个项目。新成员在首次创建或加入项目
      // 前也需要读取它，否则客户端会尝试初始化并被写权限拦截，卡在加载状态。
      const { data, error } = await supabase.from('global_asset_libraries').select('library').eq('id', id).maybeSingle()
      fail(error)
      return data ? clone(data.library) : undefined
    },

    async writeGlobalAssetLibrary(userId, library) {
      const { data: profile, error: profileError } = await supabase.from('profiles').select('workspace_role').eq('id', userId).maybeSingle()
      fail(profileError)
      assertWorkspacePermission({ role: profile?.workspace_role, status: 'active' }, 'manage-library', 'LIBRARY_WRITE_FORBIDDEN')
      const { error } = await supabase.from('global_asset_libraries').upsert({ id: library.id, library, updated_at: new Date().toISOString() }, { onConflict: 'id' })
      fail(error)
      await insertAudit({ actorId: userId, action: 'brand-library.updated', targetId: library.id })
      return clone(library)
    },

    async deleteGlobalAsset(userId, assetId) {
      const { data: profile, error: profileError } = await supabase.from('profiles').select('workspace_role').eq('id', userId).maybeSingle()
      fail(profileError)
      assertWorkspacePermission({ role: profile?.workspace_role, status: 'active' }, 'manage-library', 'LIBRARY_WRITE_FORBIDDEN')
      const { data, error } = await supabase.from('global_asset_libraries').select('library').eq('id', 'global-brand-assets').maybeSingle()
      fail(error)
      if (!data) return { deleted: false, library: undefined }
      const assets = data.library.assets.filter((asset) => asset.id !== assetId)
      const deleted = assets.length !== data.library.assets.length
      const library = deleted ? { ...data.library, assets, updatedAt: now() } : data.library
      if (deleted) {
        const { error: updateError } = await supabase.from('global_asset_libraries').update({ library, updated_at: new Date().toISOString() }).eq('id', 'global-brand-assets')
        fail(updateError)
        await insertAudit({ actorId: userId, action: 'brand-asset.deleted', targetId: assetId })
      }
      return { deleted, library: clone(library) }
    },

    async readAgentState(userId, projectId, options = {}) {
      if (!await memberRole(projectId, userId)) return undefined
      const state = await readAgentStateRows(projectId, userId, options)
      const hydrated = mergeAgentStateIntoDocument({ agentSessions: [], agentMemory: [], agentRuns: [] }, state)
      return { sessions: hydrated.agentSessions, memory: hydrated.agentMemory, runs: hydrated.agentRuns }
    },

    async listAgentSessions(userId, projectId, options = {}) {
      if (!await memberRole(projectId, userId)) return undefined
      const limit = normalizeAgentSessionListLimit(options.limit)
      const state = await readAgentStateRows(projectId, userId, {
        includeMessages: false,
        includeSubagents: options.includeSubagents === true,
      })
      return state.sessions.slice(0, limit).map((session) => ({ ...session, messages: [] }))
    },

    async readAgentSession(userId, projectId, sessionId, options = {}) {
      if (!await memberRole(projectId, userId)) return undefined
      const { data, error } = await supabaseRequest(() => supabase
        .from('agent_sessions')
        .select('payload')
        .eq('project_id', projectId)
        .eq('id', sessionId)
        .maybeSingle())
      fail(error)
      if (options.includeSubagents !== true && data?.payload?.kind === 'subagent') return undefined
      return data ? { ...clone(data.payload), messages: [] } : undefined
    },

    async listAgentSessionMessages(userId, projectId, sessionId, options = {}) {
      if (!await memberRole(projectId, userId)) return undefined
      const { data: sessionRow, error: sessionError } = await supabase.from('agent_sessions').select('id').eq('project_id', projectId).eq('id', sessionId).maybeSingle()
      fail(sessionError)
      if (!sessionRow) return undefined
      const page = agentMessageListOptions(options)
      let messageQuery = supabase.from('agent_messages')
        .select('id,updated_at,payload')
        .eq('project_id', projectId)
        .eq('session_id', sessionId)
        .order('updated_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(page.limit)
      if (page.before) {
        const beforeTimestamp = new Date(page.before.updatedAt).toISOString()
        messageQuery = messageQuery.or(`updated_at.lt.${beforeTimestamp},and(updated_at.eq.${beforeTimestamp},id.lt.${postgrestQuotedValue(page.before.id)})`)
      }
      const { data: rows, error } = await supabaseRequest(() => messageQuery)
      fail(error)
      const messages = (rows ?? []).map((row) => clone(row.payload)).reverse()
      const oldest = rows?.at(-1)
      return {
        messages,
        nextBefore: rows?.length === page.limit && oldest
          ? encodeAgentMessageCursor({
            id: oldest.id,
            updatedAt: new Date(oldest.updated_at).getTime(),
            createdAt: new Date(oldest.updated_at).getTime(),
          })
          : undefined,
        readMetrics: { messageCount: messages.length },
      }
    },

    async listCollaborationActivities(userId, projectId, options = 100) {
      if (!await memberRole(projectId, userId)) return undefined
      const page = collaborationActivityListOptions(options)
      let activityQuery = supabase.from('collaboration_activities')
        .select('payload')
        .eq('project_id', projectId)
        .order('occurred_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(page.limit)
      if (page.before) {
        const beforeTimestamp = new Date(page.before.occurredAt).toISOString()
        activityQuery = activityQuery.or(`occurred_at.lt.${beforeTimestamp},and(occurred_at.eq.${beforeTimestamp},id.lt.${postgrestQuotedValue(page.before.id)})`)
      }
      const [{ data: activities, error: activityError }, { data: receipt, error: receiptError }] = await Promise.all([
        supabaseRequest(() => activityQuery),
        supabaseRequest(() => supabase.from('collaboration_activity_receipts').select('read_at,cleared_at,updated_at').eq('user_id', userId).eq('project_id', projectId).maybeSingle()),
      ])
      fail(activityError)
      fail(receiptError)
      const memberReceipt = receipt ? {
        readAt: new Date(receipt.read_at).getTime(),
        clearedAt: new Date(receipt.cleared_at).getTime(),
        updatedAt: new Date(receipt.updated_at).getTime(),
      } : undefined
      return collaborationActivitiesForMember((activities ?? []).map((row) => clone(row.payload)), memberReceipt, userId, page)
    },

    async putCollaborationActivity(userId, projectId, input) {
      assertProjectPermission(await memberRole(projectId, userId), 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const { data: existing, error: existingError } = await supabaseRequest(() => supabase.from('collaboration_activities').select('payload').eq('project_id', projectId).eq('id', input?.id ?? '').maybeSingle())
      fail(existingError)
      if (existing) return clone(existing.payload)
      const { data: actor, error: actorError } = await supabaseRequest(() => supabase.from('profiles').select('display_name').eq('id', userId).maybeSingle())
      fail(actorError)
      const activity = validateCollaborationActivity(input, { actorId: userId, actorName: actor?.display_name })
      const { error } = await supabaseRequest(() => supabase.from('collaboration_activities').upsert({
        project_id: projectId,
        id: activity.id,
        actor_id: userId,
        occurred_at: new Date(activity.occurredAt).toISOString(),
        payload: activity,
      }, { onConflict: 'project_id,id', ignoreDuplicates: true }))
      fail(error)
      return clone(activity)
    },

    async putCollaborationActivityReceipt(userId, projectId, input) {
      assertProjectPermission(await memberRole(projectId, userId), 'read', 'PROJECT_READ_FORBIDDEN')
      const timestamp = now()
      const { data, error } = await supabaseRequest(() => supabase.rpc('botanic_put_collaboration_activity_receipt', {
        p_user_id: userId,
        p_project_id: projectId,
        p_action: input?.action,
        p_timestamp: new Date(timestamp).toISOString(),
      }))
      fail(error)
      const receipt = Array.isArray(data) ? data[0] : data
      return {
        readAt: new Date(receipt.read_at).getTime(),
        clearedAt: new Date(receipt.cleared_at).getTime(),
        updatedAt: new Date(receipt.updated_at).getTime(),
      }
    },

    async putAgentSessionReadReceipt(userId, projectId, sessionId, input) {
      assertProjectPermission(await memberRole(projectId, userId), 'read', 'PROJECT_READ_FORBIDDEN')
      const serverTime = now()
      const requestedTimestamp = input?.updatedAt === undefined
        ? serverTime
        : validateAgentEntityWriteTimestamp(input.updatedAt, { now: serverTime })
      const receipt = validateAgentSessionReadReceipt({ ...input, sessionId, updatedAt: requestedTimestamp }, { now: serverTime })
      const [{ data: session, error: sessionError }, { data: message, error: messageError }] = await Promise.all([
        supabaseRequest(() => supabase.from('agent_sessions').select('id').eq('id', sessionId).eq('project_id', projectId).maybeSingle()),
        supabaseRequest(() => supabase.from('agent_messages').select('id').eq('id', receipt.messageId).eq('project_id', projectId).eq('session_id', sessionId).maybeSingle()),
      ])
      fail(sessionError)
      fail(messageError)
      if (!session) throw productError('未找到 Agent 会话。', 'AGENT_SESSION_NOT_FOUND')
      if (!message) throw productError('目标消息已不存在。', 'AGENT_MESSAGE_NOT_FOUND')
      const { data, error } = await supabaseRequest(() => supabase.rpc('botanic_put_agent_session_read_receipt', {
        p_user_id: userId,
        p_project_id: projectId,
        p_session_id: sessionId,
        p_message_id: receipt.messageId,
        p_updated_at: new Date(receipt.updatedAt).toISOString(),
      }))
      fail(error)
      const stored = Array.isArray(data) ? data[0] : data
      return stored ? {
        sessionId: stored.session_id,
        messageId: stored.message_id,
        updatedAt: new Date(stored.updated_at).getTime(),
      } : clone(receipt)
    },

    async compareAndSetAgentSessionSettings(userId, projectId, command) {
      assertProjectPermission(await memberRole(projectId, userId), 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const normalized = normalizeAgentSessionSettingsCommand(command, { now: now() })
      const { data, error } = await supabaseRequest(() => supabase.rpc('botanic_compare_and_set_agent_session_settings', {
        p_actor_id: userId,
        p_project_id: projectId,
        p_session_id: normalized.sessionId,
        p_expected_revision: normalized.expectedRevision,
        p_changes: normalized.changes,
        p_created_at: normalized.createdAt,
      }))
      if (error) {
        if (missingAgentEntityRpc(error)) {
          throw productError('Agent Session CAS 迁移尚未部署。', 'AGENT_SESSION_SETTINGS_CAS_REQUIRED')
        }
        if (error.code === '23505') throw productError('Agent 会话标识已被其他项目使用。', 'AGENT_SESSION_ID_CONFLICT')
        if (error.code === '42501') throw productError('你没有编辑该项目的权限。', 'PROJECT_WRITE_FORBIDDEN')
        if (error.code === '22023') throw productError('Agent Session 设置变更无效。', 'INVALID_AGENT_SESSION_SETTINGS')
        fail(error)
      }
      const decision = Array.isArray(data) ? data[0] : data
      if (decision?.changed) {
        await insertAudit({
          actorId: userId,
          action: decision.kind === 'created' ? 'agent-session.created' : 'agent-session.updated',
          projectId,
          targetId: normalized.sessionId,
        })
      }
      return clone(decision)
    },

    async putAgentSession(userId, projectId, input) {
      assertProjectPermission(await memberRole(projectId, userId), 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const timestampValue = now()
      const session = validateAgentSessionEntity({ ...input, updatedAt: timestampValue }, { now: timestampValue })
      const { data, error } = await supabaseRequest(() => supabase.rpc('botanic_put_agent_session', {
        p_actor_id: userId,
        p_project_id: projectId,
        p_session: session,
        p_updated_at: new Date(timestampValue).toISOString(),
      }))
      if (error) {
        if (missingAgentEntityRpc(error)) {
          throw productError('Agent 派生字段原子写入迁移尚未部署。', 'AGENT_DERIVED_FIELDS_ATOMIC_WRITE_REQUIRED')
        }
        if (error.code === '23505') throw productError('Agent 会话标识已被其他项目使用。', 'AGENT_SESSION_ID_CONFLICT')
        if (error.code === '42501') throw productError('你没有编辑该项目的权限。', 'PROJECT_WRITE_FORBIDDEN')
        fail(error)
      }
      const stored = data?.payload ?? data
      await insertAudit({ actorId: userId, action: data?.created ? 'agent-session.created' : 'agent-session.updated', projectId, targetId: session.id })
      return clone(stored)
    },

    async compareAndSetAgentThreadSummary(userId, command) {
      const inputDecision = agentThreadSummaryCompareAndSetDecision(undefined, command)
      if (inputDecision.kind === 'invalid') return clone(inputDecision)
      const { data, error } = await supabaseRequest(() => supabase.rpc('botanic_compare_and_set_agent_thread_summary', {
        p_actor_id: userId,
        p_session_id: command?.sessionId,
        p_expected_updated_at: command?.expectedUpdatedAt ?? null,
        p_summary: command?.summary,
      }))
      if (error) {
        if (missingAgentEntityRpc(error)) {
          throw Object.assign(productError('Agent Thread Summary CAS 迁移尚未部署。', 'AGENT_THREAD_SUMMARY_CAS_REQUIRED'), { statusCode: 503 })
        }
        if (error.code === '42501') throw productError('你没有更新该 Agent 会话摘要的权限。', 'PROJECT_WRITE_FORBIDDEN')
        if (error.code === '22023') return { kind: 'invalid', changed: false }
        fail(error)
      }
      return clone(data)
    },

    async readAgentContextState(userId, projectId, sessionId) {
      if (!await memberRole(projectId, userId)) return undefined
      const { data: session, error: sessionError } = await supabaseRequest(() => supabase
        .from('agent_sessions').select('id').eq('id', sessionId).eq('project_id', projectId).maybeSingle())
      fail(sessionError)
      if (!session) return undefined
      const { data, error } = await supabaseRequest(() => supabase
        .from('agent_context_states').select('payload')
        .eq('session_id', sessionId).eq('project_id', projectId).maybeSingle())
      if (error && missingAgentEntityTable(error)) {
        throw productError('Agent Context V2 迁移尚未部署。', 'AGENT_CONTEXT_PERSISTENCE_REQUIRED')
      }
      fail(error)
      return data?.payload ? clone(data.payload) : {
        version: 2, sessionId, projectId, revision: 0, updatedAt: 0,
      }
    },

    async listAgentContextCompactions(userId, projectId, sessionId, options = {}) {
      if (!await memberRole(projectId, userId)) return undefined
      const { data: session, error: sessionError } = await supabaseRequest(() => supabase
        .from('agent_sessions').select('id').eq('id', sessionId).eq('project_id', projectId).maybeSingle())
      fail(sessionError)
      if (!session) return undefined
      const page = normalizeAgentContextCompactionPage(options)
      const { data, error } = await supabaseRequest(() => supabase
        .from('agent_context_compactions')
        .select('sequence,created_at,payload')
        .eq('project_id', projectId)
        .eq('session_id', sessionId)
        .not('compaction_id', 'is', null)
        .gt('sequence', page.afterSequence)
        .order('sequence', { ascending: true })
        .limit(page.limit))
      if (error && missingAgentEntityTable(error)) {
        throw productError('Agent Context V2 迁移尚未部署。', 'AGENT_CONTEXT_PERSISTENCE_REQUIRED')
      }
      fail(error)
      const compactions = (data ?? [])
        .map((row) => publicAgentContextCompaction({
          ...clone(row.payload),
          sequence: Number(row.sequence),
          createdAt: new Date(row.created_at).getTime(),
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
      const { data, error } = await supabaseRequest(() => supabase.rpc(
        'botanic_compare_and_set_agent_context_state',
        { p_actor_id: userId, p_command: command },
      ))
      if (error) {
        if (missingAgentEntityRpc(error)) {
          throw productError('Agent Context V2 原子 CAS 迁移尚未部署。', 'AGENT_CONTEXT_PERSISTENCE_REQUIRED')
        }
        if (error.code === '42501') {
          throw productError('你没有更新该 Agent Context 的权限。', 'PROJECT_WRITE_FORBIDDEN')
        }
        fail(error)
      }
      return clone(data)
    },

    async putAgentMessage(userId, projectId, sessionId, input) {
      assertProjectPermission(await memberRole(projectId, userId), 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const timestampValue = now()
      const message = validateAgentMessageEntity(input, { now: timestampValue })
      const { data, error } = await supabaseRequest(() => supabase.rpc('botanic_put_agent_message', {
        p_actor_id: userId,
        p_project_id: projectId,
        p_session_id: sessionId,
        p_message: message,
        p_updated_at: new Date(message.updatedAt).toISOString(),
        p_preserve_entity_references: true,
      }))
      if (error) {
        if (missingAgentEntityRpc(error)) {
          throw productError('Agent 派生字段原子写入迁移尚未部署。', 'AGENT_DERIVED_FIELDS_ATOMIC_WRITE_REQUIRED')
        }
        if (error.code === '23514' && String(error.message).includes('AGENT_MESSAGE_TURN_ID_CONFLICT')) {
          throw productError('Agent 消息已绑定其他 Turn。', 'AGENT_MESSAGE_TURN_ID_CONFLICT')
        }
        if (error.code === '23514' && String(error.message).includes('AGENT_MESSAGE_ROLE_CONFLICT')) {
          throw productError('Agent 消息作者角色不可改绑。', 'AGENT_MESSAGE_ROLE_CONFLICT')
        }
        if (error.code === '23514' && String(error.message).includes('AGENT_MESSAGE_TURN_REQUEST_CONFLICT')) {
          throw productError('Agent 消息已绑定其他 Turn 请求快照。', 'AGENT_MESSAGE_TURN_REQUEST_CONFLICT')
        }
        if (error.code === '23514' && String(error.message).includes('AGENT_MESSAGE_ENTITY_REFERENCES_CONFLICT')) {
          throw productError('Agent Turn 结果业务引用发生冲突。', 'AGENT_MESSAGE_ENTITY_REFERENCES_CONFLICT')
        }
        if (error.code === '23503') throw productError('未找到 Agent 会话。', 'AGENT_SESSION_NOT_FOUND')
        if (error.code === '23505') throw productError('Agent 消息标识已被其他会话使用。', 'AGENT_MESSAGE_ID_CONFLICT')
        if (error.code === '42501') throw productError('你没有编辑该项目的权限。', 'PROJECT_WRITE_FORBIDDEN')
        fail(error)
      }
      const stored = data?.payload ?? data
      try {
        await upsertArtifactRecords(userId, projectId, artifactsFromAgentMessage(stored, { sessionId, updatedAt: stored.updatedAt }))
      } catch (caught) {
        console.warn(`[artifact-index] message sync deferred for ${message.id}: ${caught instanceof Error ? caught.message : String(caught)}`)
      }
      await insertAudit({ actorId: userId, action: data?.created ? 'agent-message.created' : 'agent-message.updated', projectId, targetId: message.id, detail: { sessionId } })
      return clone(stored)
    },

    async putAgentMemoryItem(userId, projectId, input) {
      assertProjectPermission(await memberRole(projectId, userId), 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const serverTime = now()
      const requestedTimestamp = input?.updatedAt === undefined
        ? serverTime
        : validateAgentEntityWriteTimestamp(input.updatedAt, { now: serverTime })
      const memory = validateAgentMemoryEntity({ ...input, updatedAt: requestedTimestamp }, { now: serverTime })
      const timestampValue = validateAgentEntityWriteTimestamp(memory.updatedAt, { now: serverTime })
      const { data: existing, error: readError } = await supabaseRequest(() => supabase.from('agent_memory_items')
        .select('project_id,updated_at,deleted_at,payload').eq('id', memory.id).maybeSingle())
      fail(readError)
      if (existing && existing.project_id !== projectId) throw productError('Agent 记忆标识已被其他项目使用。', 'AGENT_MEMORY_ID_CONFLICT')
      if (existing?.deleted_at) throw productError('该 Agent 记忆已删除，请创建新的记忆。', 'AGENT_MEMORY_DELETED')
      if (existing && !shouldApplyAgentEntityWrite(existing, memory, { tombstoneWinsTie: true })) {
        return clone(existing.payload)
      }
      const { error } = await supabaseRequest(() => supabase.from('agent_memory_items').upsert({
        id: memory.id, owner_id: userId, project_id: projectId,
        updated_at: new Date(timestampValue).toISOString(), deleted_at: null, payload: memory,
      }, { onConflict: 'id' }))
      fail(error)
      await insertAudit({ actorId: userId, action: existing ? 'agent-memory.updated' : 'agent-memory.created', projectId, targetId: memory.id })
      return clone(memory)
    },

    async deleteAgentMemoryItem(userId, projectId, memoryId) {
      assertProjectPermission(await memberRole(projectId, userId), 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const { data: existing, error: readError } = await supabaseRequest(() => supabase.from('agent_memory_items')
        .select('id').eq('id', memoryId).eq('project_id', projectId).is('deleted_at', null).maybeSingle())
      fail(readError)
      if (!existing) return false
      const timestampIso = new Date().toISOString()
      const { error } = await supabaseRequest(() => supabase.from('agent_memory_items')
        .update({ deleted_at: timestampIso, updated_at: timestampIso }).eq('id', memoryId).eq('project_id', projectId))
      fail(error)
      await insertAudit({ actorId: userId, action: 'agent-memory.deleted', projectId, targetId: memoryId })
      return true
    },

    async listAgentArtifacts(userId, projectId, { limit = 100, before } = {}) {
      if (!await memberRole(projectId, userId)) return undefined
      const maximum = Math.max(1, Math.min(Number(limit) || 100, artifactIndexLimits.page))
      const baseQuery = () => supabase.from('agent_artifacts').select('payload,created_at')
        .eq('project_id', projectId)
        .order('created_at', { ascending: false })
        .order('id', { ascending: true })
      const beforeTimestamp = Number(before?.createdAt)
      const mapRows = (rows) => (rows ?? []).map((row) => ({
        ...clone(row.payload),
        createdAt: new Date(row.created_at).getTime(),
      }))
      if (!Number.isFinite(beforeTimestamp) || typeof before?.id !== 'string') {
        let query = baseQuery().limit(maximum)
        if (Number.isFinite(beforeTimestamp)) query = query.lt('created_at', new Date(beforeTimestamp).toISOString())
        const { data, error } = await supabaseRequest(() => query)
        if (missingAgentEntityTable(error)) return []
        fail(error)
        return mapRows(data)
      }
      const timestampIso = new Date(beforeTimestamp).toISOString()
      const { data: sameTimestamp, error: sameTimestampError } = await supabaseRequest(() => baseQuery()
        .eq('created_at', timestampIso).gt('id', before.id).limit(maximum))
      if (missingAgentEntityTable(sameTimestampError)) return []
      fail(sameTimestampError)
      if ((sameTimestamp ?? []).length >= maximum) return mapRows(sameTimestamp)
      const { data: older, error: olderError } = await supabaseRequest(() => baseQuery()
        .lt('created_at', timestampIso).limit(maximum - (sameTimestamp ?? []).length))
      fail(olderError)
      return mapRows([...(sameTimestamp ?? []), ...(older ?? [])])
    },

    async putAgentSkill(userId, skill) {
      const { data, error } = await supabaseRequest(() => supabase.rpc('botanic_put_agent_skill', {
        p_actor_id: userId,
        p_skill: skill,
      }))
      if (error) {
        if (missingAgentEntityRpc(error)) {
          throw new BotanicAgentSkillError(
            503,
            'AGENT_SKILL_ATOMIC_PERSISTENCE_REQUIRED',
            'Agent Skill 原子版本写入迁移尚未部署。',
          )
        }
        if (error.code === '42501') {
          throw new BotanicAgentSkillError(403, 'PROJECT_WRITE_FORBIDDEN', '你没有编辑该项目 Skill 的权限。')
        }
        fail(error)
      }
      if (data?.kind === 'conflict' || data?.kind === 'invalid') {
        const messages = {
          AGENT_SKILL_ID_CONFLICT: 'Skill 标识已被其他项目使用。',
          AGENT_SKILL_VERSION_STALE: 'Skill 写入版本已过期。',
          AGENT_SKILL_VERSION_CONFLICT: 'Skill 同一版本不得改写执行内容。',
          AGENT_SKILL_HISTORY_CONFLICT: 'Skill 历史版本不得覆盖、截断或跳号。',
          AGENT_SKILL_VERSION_HASH_MISMATCH: 'Skill 版本快照与内容摘要不一致。',
          INVALID_AGENT_SKILL_VERSION: 'Skill 持久化快照无效。',
        }
        const code = typeof data.code === 'string' ? data.code : 'INVALID_AGENT_SKILL_VERSION'
        const statusCode = code === 'INVALID_AGENT_SKILL_VERSION' ? 400 : 409
        throw new BotanicAgentSkillError(statusCode, code, messages[code] ?? messages.INVALID_AGENT_SKILL_VERSION)
      }
      if (!data?.payload || !['write', 'replay'].includes(data.kind)) {
        throw productError('Agent Skill 原子写入未返回权威快照。', 'AGENT_SKILL_ATOMIC_WRITE_INVALID')
      }
      return clone(data.payload)
    },

    async listAgentSkills(userId, projectId) {
      if (!await memberRole(projectId, userId)) return undefined
      const { data, error } = await supabaseRequest(() => supabase.from('agent_skills').select('payload')
        .eq('project_id', projectId).eq('status', 'active').order('updated_at', { ascending: false }))
      fail(error)
      return (data ?? []).map((row) => clone(row.payload))
    },

    async readAgentSkillVersion(userId, projectId, skillId, version) {
      if (!await memberRole(projectId, userId)) return undefined
      const { data, error } = await supabaseRequest(() => supabase.from('agent_skills').select('payload')
        .eq('project_id', projectId).eq('id', skillId).maybeSingle())
      fail(error)
      const snapshot = persistedAgentSkillVersion(data?.payload, version)
      return snapshot ? clone({ projectId, skillId, ...snapshot }) : undefined
    },

    async putAgentActionReceipt(userId, receipt) {
      const role = await memberRole(receipt.projectId, userId)
      assertProjectPermission(role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const payload = { ...clone(receipt), ownerId: userId }
      // 旧完成写入只允许首次 insert；唯一键负责与新 claim 竞争，绝不 upsert 覆盖。
      const { error } = await supabaseRequest(() => supabase.from('agent_action_receipts').insert({
        id: receipt.id,
        owner_id: userId,
        project_id: receipt.projectId,
        created_at: new Date(receipt.createdAt).toISOString(),
        payload,
      }))
      if (error?.code === '23505') {
        const { data: existing, error: readError } = await supabaseRequest(() => supabase.from('agent_action_receipts')
          .select('payload').eq('id', receipt.id).eq('owner_id', userId).eq('project_id', receipt.projectId).maybeSingle())
        fail(readError)
        if (!existing) throw productError('Agent 行动回执冲突。', 'AGENT_ACTION_RECEIPT_CONFLICT')
        return clone(existing.payload)
      }
      fail(error)
      try {
        await upsertArtifactRecords(userId, receipt.projectId, artifactsFromActionReceipt(receipt))
      } catch (caught) {
        console.warn(`[artifact-index] action sync deferred for ${receipt.id}: ${caught instanceof Error ? caught.message : String(caught)}`)
      }
      try {
        await insertAudit({ actorId: userId, action: 'agent-action.succeeded', projectId: receipt.projectId, targetId: receipt.id, detail: { toolCallId: receipt.toolCallId } })
      } catch (caught) {
        console.warn(`[agent-action] audit deferred for ${receipt.id}: ${caught instanceof Error ? caught.message : String(caught)}`)
      }
      return clone(payload)
    },

    async readAgentActionReceipt(userId, receiptId) {
      const { data, error } = await supabaseRequest(() => supabase.from('agent_action_receipts')
        .select('payload').eq('id', receiptId).eq('owner_id', userId).maybeSingle())
      fail(error)
      if (!data || !await memberRole(data.payload.projectId, userId)) return undefined
      return clone(data.payload)
    },

    async claimAgentActionReceipt(userId, claim) {
      const { data, error } = await supabaseRequest(() => supabase.rpc('botanic_claim_agent_action_receipt', {
        p_owner_id: userId,
        p_receipt_id: claim.id,
        p_project_id: claim.projectId,
        p_claim: claim,
      }))
      if (error) {
        if (missingAgentEntityRpc(error)) {
          throw productError('Agent 行动原子 claim 迁移尚未部署。', 'AGENT_ACTION_ATOMIC_CLAIM_REQUIRED')
        }
        if (error.code === '42501') throw productError('你没有执行该 Agent 行动的权限。', 'PROJECT_WRITE_FORBIDDEN')
        if (error.code === '22023') throw productError('Agent 行动回执格式无效。', 'AGENT_ACTION_RECEIPT_INVALID')
        fail(error)
      }
      return clone(data)
    },

    async settleAgentActionReceipt(userId, settlement) {
      const { data, error } = await supabaseRequest(() => supabase.rpc('botanic_settle_agent_action_receipt', {
        p_owner_id: userId,
        p_receipt_id: settlement.id,
        p_project_id: settlement.projectId,
        p_settlement: settlement,
      }))
      if (error) {
        if (missingAgentEntityRpc(error)) {
          throw productError('Agent 行动原子 settle 迁移尚未部署。', 'AGENT_ACTION_ATOMIC_CLAIM_REQUIRED')
        }
        if (error.code === 'PAA01') throw productError('Agent 行动执行租约已失效。', 'AGENT_ACTION_LEASE_STALE')
        if (error.code === 'PAA02') throw productError('未找到 Agent 行动回执。', 'AGENT_ACTION_RECEIPT_NOT_FOUND')
        if (error.code === '22023') throw productError('Agent 行动回执格式无效。', 'AGENT_ACTION_RECEIPT_INVALID')
        fail(error)
      }
      return clone(data)
    },

    async resolveAgentActionReceipt(userId, command) {
      const { data, error } = await supabaseRequest(() => supabase.rpc('botanic_resolve_agent_action_receipt', {
        p_owner_id: userId,
        p_receipt_id: command?.id,
        p_project_id: command?.projectId,
        p_command: command,
      }))
      if (error) {
        if (missingAgentEntityRpc(error)) {
          throw productError('Agent 行动人工调和迁移尚未部署。', 'AGENT_ACTION_RECONCILIATION_REQUIRED')
        }
        if (error.code === '42501') throw productError('你没有调和该 Agent 行动的权限。', 'PROJECT_WRITE_FORBIDDEN')
        if (error.code === '22023') throw productError('Agent 行动调和参数无效。', 'AGENT_ACTION_RECONCILIATION_INVALID')
        fail(error)
      }
      return clone(data)
    },

    async consumeAgentActionManualRetryAuthorization(userId, command) {
      const { data, error } = await supabaseRequest(() => supabase.rpc('botanic_consume_agent_action_manual_retry', {
        p_owner_id: userId,
        p_receipt_id: command?.id,
        p_project_id: command?.projectId,
        p_command: command,
      }))
      if (error) {
        if (missingAgentEntityRpc(error)) {
          throw productError('Agent 行动人工重试迁移尚未部署。', 'AGENT_ACTION_RECONCILIATION_REQUIRED')
        }
        if (error.code === '42501') throw productError('你没有重试该 Agent 行动的权限。', 'PROJECT_WRITE_FORBIDDEN')
        if (error.code === '22023') throw productError('Agent 行动重试授权参数无效。', 'AGENT_ACTION_MANUAL_RETRY_INVALID')
        fail(error)
      }
      return clone(data)
    },

    async putGenerationJob(userId, job, { updateAgentRun = true, recordAudit = true } = {}) {
      const decision = await generationFenceRpc('botanic_put_generation_job_guarded', {
        p_owner_id: userId,
        p_job_id: job.id,
        p_project_id: job.projectId,
        p_job: clone(job),
      })
      if (decision?.changed) {
        await projectGenerationJob(userId, decision.job, { updateAgentRun, recordAudit, syncArtifacts: true })
      }
      return clone(decision?.job)
    },

    async claimGenerationJobExecution(jobId, claim) {
      const decision = await generationFenceRpc('botanic_claim_generation_job_execution', {
        p_job_id: jobId,
        p_claim: clone(claim),
      })
      if (decision?.changed) {
        await projectGenerationJob(decision.job.ownerId, decision.job, {
          updateAgentRun: false,
          recordAudit: false,
          syncArtifacts: false,
        })
      }
      return decision
    },

    async commitGenerationJobExecution(userId, command) {
      const decision = await generationFenceRpc('botanic_commit_generation_job_execution', {
        p_owner_id: userId,
        p_job_id: command?.id,
        p_project_id: command?.projectId,
        p_command: clone(command),
      })
      if (decision?.changed) {
        await projectGenerationJob(userId, decision.job, {
          updateAgentRun: command.updateAgentRun !== false,
          recordAudit: command.recordAudit !== false,
          syncArtifacts: false,
        })
      }
      return decision
    },

    async cancelGenerationJobExecution(userId, command) {
      const decision = await generationFenceRpc('botanic_cancel_generation_job_execution', {
        p_owner_id: userId,
        p_job_id: command?.id,
        p_project_id: command?.projectId,
        p_command: clone(command),
      })
      if (decision?.changed) await projectGenerationJob(userId, decision.job)
      return decision
    },

    async acknowledgeGenerationJobCancellation(userId, command) {
      return generationFenceRpc('botanic_acknowledge_generation_job_cancellation', {
        p_owner_id: userId,
        p_job_id: command?.id,
        p_project_id: command?.projectId,
        p_command: clone(command),
      })
    },

    async compareAndSetGenerationJob(userId, command) {
      const decision = await generationFenceRpc('botanic_compare_and_set_generation_job', {
        p_owner_id: userId,
        p_job_id: command?.id,
        p_project_id: command?.projectId,
        p_command: clone(command),
      })
      if (decision?.changed) {
        await projectGenerationJob(userId, decision.job, {
          updateAgentRun: command.updateAgentRun !== false,
          recordAudit: command.recordAudit !== false,
        })
      }
      return decision
    },

    async refreshGenerationArtifacts(userId, jobId) {
      const { data: jobRow, error: jobError } = await supabaseRequest(() => supabase.from('generation_jobs')
        .select('payload').eq('id', jobId).eq('owner_id', userId).maybeSingle())
      fail(jobError)
      if (!jobRow) return false
      const job = clone(jobRow.payload)
      if (!await memberRole(job.projectId, userId)) return false
      const [{ data: project, error: projectError }, { data: graph, error: graphError }] = await Promise.all([
        supabaseRequest(() => supabase.from('projects').select('document').eq('id', job.projectId).maybeSingle()),
        supabaseRequest(() => supabase.from('canvas_graphs').select('graph').eq('project_id', job.projectId).maybeSingle()),
      ])
      fail(projectError)
      fail(graphError)
      if (!project) return false
      return refreshGenerationArtifactRecords(userId, job, {
        ...clone(project.document), ...clone(graph?.graph ?? {}),
      })
    },

    async putAgentRun(userId, run) {
      const role = await memberRole(run.projectId, userId)
      assertProjectPermission(role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const payload = { ...clone(run), ownerId: userId, updatedAt: Number(run.updatedAt) || now() }
      const row = {
        id: run.id,
        owner_id: userId,
        project_id: run.projectId,
        status: run.status,
        updated_at: new Date(payload.updatedAt).toISOString(),
        payload,
      }
      let stored
      const { data: rpcData, error: rpcError } = await supabaseRequest(() => supabase.rpc('botanic_put_agent_run', {
        p_owner_id: userId,
        p_run: row,
      }))
      if (!rpcError) {
        stored = rpcData
      } else {
        if (!missingAgentEntityRpc(rpcError)) fail(rpcError)
        // 缺失行无法通过先读后写获得并发保护；RPC 未部署时必须失败关闭，
        // 不能退回普通 upsert，否则首次创建仍可能被迟到快照覆盖。
        throw productError('Agent Run 原子写入迁移尚未部署。', 'AGENT_RUN_ATOMIC_WRITE_REQUIRED')
      }
      if (stored?.updatedAt === payload.updatedAt && stored?.status === payload.status) {
        try {
          await insertAudit({ actorId: userId, action: `agent-run.${run.status}`, projectId: run.projectId, targetId: run.id })
        } catch (caught) {
          console.warn(`[agent-run] audit deferred for ${run.id}: ${caught instanceof Error ? caught.message : String(caught)}`)
        }
      }
      return clone(stored)
    },

    async readAgentRun(userId, runId) {
      const { data, error } = await supabaseRequest(() => supabase.from('agent_runs').select('payload').eq('id', runId).eq('owner_id', userId).maybeSingle())
      fail(error)
      if (!data || !await memberRole(data.payload.projectId, userId)) return undefined
      return clone(data.payload)
    },

    async readAgentRunForWorker(runId) {
      const { data, error } = await supabaseRequest(() => supabase.from('agent_runs').select('payload').eq('id', runId).maybeSingle())
      fail(error)
      return data ? clone(data.payload) : undefined
    },

    async claimAgentBranchRetry(userId, command) {
      const role = await memberRole(command?.projectId, userId)
      assertProjectPermission(role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const { data, error } = await supabaseRequest(() => supabase.rpc('botanic_claim_agent_branch_retry', {
        p_owner_id: userId,
        p_command: clone(command),
      }))
      if (error) {
        if (missingAgentEntityRpc(error)) {
          throw productError('Agent 分支重试原子迁移尚未部署。', 'AGENT_BRANCH_RETRY_ATOMIC_WRITE_REQUIRED')
        }
        if (error.code === '42501') throw productError('你没有重试该 Agent 分支的权限。', 'PROJECT_WRITE_FORBIDDEN')
        if (error.code === '22023') throw productError('Agent 分支重试身份无效。', 'AGENT_BRANCH_RETRY_INVALID')
        fail(error)
      }
      if (data?.changed) {
        try {
          await insertAudit({
            actorId: userId,
            action: 'agent-run.branch-retry-claimed',
            projectId: command.projectId,
            targetId: command.runId,
          })
        } catch (caught) {
          console.warn(`[agent-run] branch retry audit deferred for ${command.runId}: ${caught instanceof Error ? caught.message : String(caught)}`)
        }
      }
      return clone(data)
    },

    async listQueuedAgentRunsForRecovery(options = {}) {
      const { afterId, limit } = normalizeAgentEntityIdPage(options)
      let query = supabase.from('agent_runs').select('payload').eq('status', 'queued')
      if (afterId !== null) query = query.gt('id', afterId)
      const { data, error } = await supabaseRequest(() => query.order('id', { ascending: true }).limit(limit))
      fail(error)
      return (data ?? []).map((row) => clone(row.payload))
    },

    async listAgentRunsForProject(userId, projectId, limit = 30) {
      if (!await memberRole(projectId, userId)) return undefined
      const { data, error } = await supabaseRequest(() => supabase.from('agent_runs').select('payload')
        .eq('project_id', projectId).eq('owner_id', userId)
        .order('updated_at', { ascending: false }).limit(Math.max(1, Math.min(limit, 60))))
      fail(error)
      return (data ?? []).map((row) => clone(row.payload))
    },

    async listAgentRunsForTurn(userId, projectId, turnId, limit = 20) {
      if (!await memberRole(projectId, userId)) return undefined
      const { data, error } = await supabaseRequest(() => supabase.from('agent_runs').select('payload')
        .eq('project_id', projectId).eq('owner_id', userId).eq('payload->>turnId', turnId)
        // createdAt 不是独立列，只能按 payload 取；毫秒时间戳位数一致，文本序等于数值序。
        .order('payload->>createdAt', { ascending: true }).limit(Math.max(1, Math.min(limit, 60))))
      fail(error)
      return (data ?? []).map((row) => clone(row.payload))
    },

    async listAgentRunsForTurnPage(userId, projectId, turnId, options = {}) {
      if (!await memberRole(projectId, userId)) return undefined
      const { afterId, limit } = normalizeAgentEntityIdPage(options)
      let query = supabase.from('agent_runs').select('payload')
        .eq('project_id', projectId).eq('owner_id', userId).eq('payload->>turnId', turnId)
      if (afterId !== null) query = query.gt('id', afterId)
      const { data, error } = await supabaseRequest(() => query.order('id', { ascending: true }).limit(limit))
      fail(error)
      return (data ?? []).map((row) => clone(row.payload))
    },

    async claimAgentTurnExecution(userId, claim) {
      const { data, error } = await supabaseRequest(() => supabase.rpc('botanic_claim_agent_turn_execution', {
        p_owner_id: userId,
        p_turn_id: claim?.turn?.id,
        p_project_id: claim?.turn?.projectId,
        p_claim: claim,
      }))
      if (error) {
        if (missingAgentEntityRpc(error)) {
          throw productError('Agent Turn 原子 claim 迁移尚未部署。', 'AGENT_TURN_ATOMIC_CLAIM_REQUIRED')
        }
        if (error.code === '42501') throw productError('你没有执行该 Agent Turn 的权限。', 'PROJECT_READ_FORBIDDEN')
        if (error.code === '22023') throw productError('Agent Turn 执行参数无效。', 'AGENT_TURN_EXECUTION_INVALID')
        fail(error)
      }
      return clone(data)
    },

    async commitAgentTurnExecution(userId, command) {
      const previewCommit = Object.hasOwn(command ?? {}, 'outputPreview')
      const rpcName = previewCommit
        ? 'botanic_commit_agent_turn_output_preview'
        : 'botanic_commit_agent_turn_execution'
      const { data, error } = await supabaseRequest(() => supabase.rpc(rpcName, {
        p_owner_id: userId,
        p_turn_id: command?.id,
        p_project_id: command?.projectId,
        p_command: command,
      }))
      if (error) {
        if (missingAgentEntityRpc(error)) {
          throw productError(
            previewCommit ? 'Agent Turn 输出预览迁移尚未部署。' : 'Agent Turn 原子 commit 迁移尚未部署。',
            'AGENT_TURN_ATOMIC_CLAIM_REQUIRED',
          )
        }
        if (error.code === 'PAT01') throw productError('Agent Turn 执行租约已失效。', 'AGENT_TURN_LEASE_STALE')
        if (error.code === 'PAT02') throw productError('未找到 Agent Turn。', 'AGENT_TURN_NOT_FOUND')
        if (error.code === 'PAT03') throw productError('Agent Turn 事件标识冲突。', 'AGENT_TURN_EVENT_CONFLICT')
        if (error.code === '22023') throw productError('Agent Turn 执行参数无效。', 'AGENT_TURN_EXECUTION_INVALID')
        fail(error)
      }
      return withoutTerminalTurnOutputPreview(data)
    },

    async requestAgentTurnCancellation(userId, request) {
      const { data, error } = await supabaseRequest(() => supabase.rpc('botanic_request_agent_turn_cancellation', {
        p_owner_id: userId,
        p_turn_id: request?.id,
        p_project_id: request?.projectId,
        p_request: request,
      }))
      if (error) {
        if (missingAgentEntityRpc(error)) {
          throw productError('Agent Turn 原子取消迁移尚未部署。', 'AGENT_TURN_ATOMIC_CLAIM_REQUIRED')
        }
        if (error.code === 'PAT02') throw productError('未找到 Agent Turn。', 'AGENT_TURN_NOT_FOUND')
        if (error.code === 'PAT03') throw productError('Agent Turn 事件标识冲突。', 'AGENT_TURN_EVENT_CONFLICT')
        if (error.code === '42501') throw productError('你没有取消该 Agent Turn 的权限。', 'PROJECT_READ_FORBIDDEN')
        if (error.code === '22023') throw productError('Agent Turn 取消参数无效。', 'AGENT_TURN_EXECUTION_INVALID')
        fail(error)
      }
      return clone(data)
    },

    async finalizeAgentTurnCancellation(userId, command) {
      const { data, error } = await supabaseRequest(() => supabase.rpc('botanic_finalize_agent_turn_cancellation', {
        p_owner_id: userId,
        p_turn_id: command?.id,
        p_project_id: command?.projectId,
        p_command: command,
      }))
      if (error) {
        if (missingAgentEntityRpc(error)) {
          throw productError('Agent Turn 取消收口迁移尚未部署。', 'AGENT_TURN_ATOMIC_CLAIM_REQUIRED')
        }
        if (error.code === 'PAT02') throw productError('未找到 Agent Turn。', 'AGENT_TURN_NOT_FOUND')
        if (error.code === 'PAT03') throw productError('Agent Turn 事件标识冲突。', 'AGENT_TURN_EVENT_CONFLICT')
        if (error.code === '22023') throw productError('Agent Turn 取消收口参数无效。', 'AGENT_TURN_EXECUTION_INVALID')
        fail(error)
      }
      return withoutTerminalTurnOutputPreview(data)
    },

    async putAgentTurn(userId, turn) {
      const role = await memberRole(turn.projectId, userId)
      assertProjectPermission(role, 'read', 'PROJECT_READ_FORBIDDEN')
      const timestamp = Number(turn.updatedAt) || now()
      const payload = { ...clone(turn), ownerId: userId, updatedAt: timestamp }
      // generic/legacy put 与 claim 共用数据库锁；先读再 REST upsert 会在两个调用间
      // 抹掉并发建立的 execution token/generation，因此缺 RPC 时必须失败关闭。
      const { data, error } = await supabaseRequest(() => supabase.rpc('botanic_put_agent_turn_compatible', {
        p_owner_id: userId,
        p_turn_id: turn.id,
        p_project_id: turn.projectId,
        p_turn: payload,
      }))
      if (error) {
        if (missingAgentEntityRpc(error)) {
          throw productError('Agent Turn 原子兼容写入迁移尚未部署。', 'AGENT_TURN_ATOMIC_WRITE_REQUIRED')
        }
        if (error.code === 'PAT04') throw productError('Agent Turn 标识或请求绑定冲突。', 'AGENT_TURN_ID_CONFLICT')
        if (error.code === '42501') throw productError('你没有读取该项目的权限。', 'PROJECT_READ_FORBIDDEN')
        if (error.code === '22023') throw productError('Agent Turn 兼容写入参数无效。', 'AGENT_TURN_EXECUTION_INVALID')
        fail(error)
      }
      return clone(data)
    },

    async readAgentTurn(userId, turnId) {
      const { data, error } = await supabaseRequest(() => supabase.from('agent_turns').select('payload,project_id,owner_id')
        .eq('id', turnId).eq('owner_id', userId).maybeSingle())
      fail(error)
      if (!data || !await memberRole(data.project_id, userId)) return undefined
      return clone(data.payload)
    },

    async readAgentTurnForWorker(turnId) {
      const { data, error } = await supabaseRequest(() => supabase.from('agent_turns').select('payload').eq('id', turnId).maybeSingle())
      fail(error)
      return data ? clone(data.payload) : undefined
    },

    async listAgentTurnsForProject(userId, projectId, limit = 30) {
      if (!await memberRole(projectId, userId)) return undefined
      const { data, error } = await supabaseRequest(() => supabase.from('agent_turns').select('payload')
        .eq('project_id', projectId).eq('owner_id', userId)
        .order('updated_at', { ascending: false }).limit(Math.max(1, Math.min(Number(limit) || 30, 100))))
      fail(error)
      return (data ?? []).map((row) => clone(row.payload))
    },

    /**
     * 跨项目扫描超过租约未推进的非终态 Turn，供派生任务队列回收孤儿。
     * 不做成员校验：清扫是系统行为，没有发起它的用户（与 readAgentTurnForWorker 同理）。
     */
    async listStaleAgentTurns(options = {}) {
      const { olderThan, after, limit } = normalizeStaleTurnQuery(options)
      const { data, error } = await supabaseRequest(() => supabase.rpc('botanic_list_stale_agent_turns', {
        p_older_than_ms: olderThan,
        p_after_updated_at_ms: after?.updatedAt ?? null,
        p_after_id: after?.id ?? null,
        p_limit: limit,
      }))
      if (error) {
        if (missingAgentEntityRpc(error)) {
          throw productError('Agent Turn 稳定恢复分页迁移尚未部署。', 'AGENT_TURN_RECOVERY_PAGINATION_REQUIRED')
        }
        fail(error)
      }
      return (data ?? []).map(clone)
    },

    async appendAgentTurnEvent(userId, projectId, event) {
      const role = await memberRole(projectId, userId)
      assertProjectPermission(role, 'read', 'PROJECT_READ_FORBIDDEN')
      const { data: turn, error: turnError } = await supabaseRequest(() => supabase.from('agent_turns').select('owner_id,project_id')
        .eq('id', event.turnId).maybeSingle())
      fail(turnError)
      if (!turn || turn.owner_id !== userId || turn.project_id !== projectId) throw productError('未找到 Agent Turn。', 'AGENT_TURN_NOT_FOUND')
      const { data: stored, error } = await supabaseRequest(() => supabase.from('agent_turn_events').upsert({
        id: event.id,
        turn_id: event.turnId,
        owner_id: userId,
        project_id: projectId,
        sequence: event.sequence,
        type: event.type,
        created_at: new Date(event.createdAt || now()).toISOString(),
        payload: event.payload ?? null,
      }, { onConflict: 'turn_id,sequence', ignoreDuplicates: true }).select('id,turn_id,owner_id,project_id,sequence,type,created_at,payload').maybeSingle())
      fail(error)
      return stored ? {
        id: stored.id,
        turnId: stored.turn_id,
        ownerId: stored.owner_id,
        projectId: stored.project_id,
        sequence: stored.sequence,
        type: stored.type,
        createdAt: new Date(stored.created_at).getTime(),
        ...(stored.payload ? { payload: clone(stored.payload) } : {}),
      } : clone(event)
    },

    /**
     * `after` 是 `(turnId, sequence)` 游标：只返回该序号之后的事件，
     * 断线重连据此续读而不必重新拉全量。
     */
    async listAgentTurnEvents(userId, projectId, turnId, options = {}) {
      if (!await memberRole(projectId, userId)) return undefined
      const { after, limit } = normalizeTurnEventPage(options)
      const { data, error } = await supabaseRequest(() => {
        const query = supabase.from('agent_turn_events')
          .select('id,turn_id,owner_id,project_id,sequence,type,created_at,payload')
          .eq('turn_id', turnId).eq('project_id', projectId).eq('owner_id', userId)
        return (after === null ? query : query.gt('sequence', after))
          .order('sequence', { ascending: true }).limit(limit)
      })
      fail(error)
      return (data ?? []).map((row) => ({
        id: row.id,
        turnId: row.turn_id,
        ownerId: row.owner_id,
        projectId: row.project_id,
        sequence: row.sequence,
        type: row.type,
        createdAt: new Date(row.created_at).getTime(),
        ...(row.payload ? { payload: clone(row.payload) } : {}),
      }))
    },

    async enqueueAgentSubagentActivation(userId, rawCommand) {
      const start = rawCommand?.kind === 'start'
        ? materializeAgentSubagentEnqueueCommand(userId, rawCommand)
        : undefined
      const subagentId = start?.subagentId ?? rawCommand?.subagentId ?? ''
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const existingSubagent = await readSupabaseSubagentForRuntime(subagentId)
        let existingActivation
        if (existingSubagent) {
          const { data, error } = await supabaseRequest(() => supabase.from('agent_subagent_activations')
            .select(agentSubagentActivationColumns)
            .eq('subagent_id', subagentId)
            .eq('idempotency_key', rawCommand?.idempotencyKey ?? '')
            .maybeSingle())
          fail(error)
          existingActivation = data ? agentSubagentActivationFromSupabaseRow(data) : undefined
        }
        const sequence = existingActivation?.sequence
          ?? (Number(existingSubagent?.lastEnqueuedSequence) + 1 || 1)
        const materialized = start ?? materializeAgentSubagentEnqueueCommand(
          existingSubagent?.ownerId ?? userId,
          {
            ...clone(rawCommand),
            sequence,
            cancelGeneration: Number(existingSubagent?.cancelGeneration) || 0,
          },
        )
        let existingTurn
        if (existingActivation) {
          const { data, error } = await supabaseRequest(() => supabase.from('agent_turns')
            .select('payload').eq('id', existingActivation.turnId).maybeSingle())
          fail(error)
          existingTurn = data?.payload
        }
        const materialization = agentSubagentEnqueueDecision(
          existingSubagent,
          existingActivation,
          { ...materialized, existingTurn },
        )
        if (['missing', 'inactive'].includes(materialization.kind)) {
          return publicAgentSubagentDecision(materialization)
        }
        const rpcCommand = {
          ...materialized,
          subagent: materialization.subagent ?? existingSubagent ?? {},
          activation: materialization.activation ?? existingActivation ?? {},
          session: materialization.session ?? {},
          inputMessage: materialization.inputMessage ?? {},
          turn: materialization.turn ?? existingTurn ?? materialized.candidate.turn,
        }
        const outcome = await agentSubagentRpc('botanic_enqueue_agent_subagent_activation', {
          p_actor_id: userId,
          p_command: rpcCommand,
        })
        if (outcome?.kind !== 'retry') return publicAgentSubagentDecision(outcome)
      }
      throw productError('Subagent 并发入队未能取得稳定序号，请重试。', 'AGENT_SUBAGENT_PERSISTENCE_CONFLICT')
    },

    async claimAgentSubagentActivation(command) {
      return agentSubagentRpc('botanic_claim_agent_subagent_activation', { p_command: command })
    },

    async settleAgentSubagentActivation(command) {
      return agentSubagentRpc('botanic_settle_agent_subagent_activation', { p_command: command })
    },

    async readAgentSubagent(userId, subagentId) {
      const raw = await readSupabaseSubagentForRuntime(subagentId)
      if (!raw || !await memberRole(raw.projectId, userId)) return undefined
      return publicAgentSubagent(raw)
    },

    async readAgentSubagentForWorker(subagentId) {
      return readSupabaseSubagentForRuntime(subagentId)
    },

    async listAgentSubagentsForRootTurnPage(userId, projectId, rootTurnId, options = {}) {
      if (!await memberRole(projectId, userId)) return undefined
      const { afterId, limit } = normalizeAgentEntityIdPage(options)
      const { data, error } = await supabaseRequest(() => supabase.rpc(
        'botanic_list_agent_subagents_for_root_turn',
        {
          p_actor_id: userId,
          p_project_id: projectId,
          p_root_turn_id: rootTurnId,
          p_after_id: afterId,
          p_limit: limit,
        },
      ))
      if (error?.code === '42501') return undefined
      if (missingAgentEntityRpc(error) || missingAgentEntityTable(error)) {
        throw productError(
          'AgentSubagent 根 Turn 分页迁移尚未部署。',
          'AGENT_SUBAGENT_ROOT_TURN_PAGE_REQUIRED',
        )
      }
      fail(error)
      if (!Array.isArray(data)) {
        throw productError(
          'AgentSubagent 根 Turn 分页响应格式无效。',
          'AGENT_SUBAGENT_ROOT_TURN_PAGE_INVALID',
        )
      }
      return data.map(publicAgentSubagent)
    },

    async listAgentSubagentActivations(userId, subagentId, options = {}) {
      const subagent = await readSupabaseSubagentForRuntime(subagentId)
      if (!subagent || !await memberRole(subagent.projectId, userId)) return undefined
      const { afterSequence, limit } = normalizeAgentSubagentActivationPage(options)
      const { data, error } = await supabaseRequest(() => supabase.from('agent_subagent_activations')
        .select(agentSubagentActivationColumns)
        .eq('subagent_id', subagentId)
        .gt('sequence', afterSequence)
        .order('sequence', { ascending: true })
        .limit(limit))
      fail(error)
      return (data ?? []).map((row) => publicAgentSubagentActivation(
        agentSubagentActivationFromSupabaseRow(row),
      ))
    },

    async listAgentSubagentActivationsForWorker(subagentId, options = {}) {
      if (!await readSupabaseSubagentForRuntime(subagentId)) return undefined
      const { afterSequence, limit } = normalizeAgentSubagentActivationPage(options)
      const { data, error } = await supabaseRequest(() => supabase.from('agent_subagent_activations')
        .select(agentSubagentActivationColumns)
        .eq('subagent_id', subagentId)
        .gt('sequence', afterSequence)
        .order('sequence', { ascending: true })
        .limit(limit))
      fail(error)
      const activations = (data ?? []).map(agentSubagentActivationFromSupabaseRow)
      if (!activations.length) return []
      const { data: turns, error: turnError } = await supabaseRequest(() => supabase.from('agent_turns')
        .select('id,payload').in('id', activations.map((activation) => activation.turnId)))
      fail(turnError)
      const turnById = new Map((turns ?? []).map((row) => [row.id, clone(row.payload)]))
      return activations.map((activation) => ({ activation, turn: turnById.get(activation.turnId) }))
    },

    async listRunnableAgentSubagents(options = {}) {
      const page = normalizeRunnableAgentSubagentPage(options)
      const data = await agentSubagentRpc('botanic_list_runnable_agent_subagents', {
        p_older_than_ms: page.now,
        p_after_updated_at_ms: page.after?.updatedAt ?? null,
        p_after_id: page.after?.id ?? null,
        p_limit: page.limit,
      })
      if (!Array.isArray(data)) {
        throw productError('AgentSubagent 恢复分页响应格式无效。', 'AGENT_SUBAGENT_RECOVERY_RESPONSE_INVALID')
      }
      return data
    },

    async requestAgentSubagentCancellation(userId, command) {
      const result = await agentSubagentRpc('botanic_request_agent_subagent_cancellation', {
        p_actor_id: userId,
        p_command: command,
      })
      return publicAgentSubagentDecision(result)
    },

    async finalizeAgentSubagentCancellation(userId, command) {
      const result = await agentSubagentRpc('botanic_finalize_agent_subagent_cancellation', {
        p_actor_id: userId,
        p_command: command,
      })
      return publicAgentSubagentDecision(result)
    },

    async listRunsWithFailedBranches(options = {}) {
      const { after, limit } = normalizeUpdatedAtIdRecoveryPage(options)
      return recoveryKeysetRpc('botanic_list_runs_with_failed_branches', {
        p_after_updated_at_ms: after?.updatedAt ?? null,
        p_after_id: after?.id ?? null,
        p_limit: limit,
      })
    },

    // PostgREST 无法表达「jsonb 数组里存在某状态」，因此按最近更新的项目取一批再
    // 本地筛。上限刻意保守：这条路径只服务周期清扫，不是热路径。
    async listProjectsWithActiveWorkflowRuns({ limit = 25 } = {}) {
      const active = new Set(['queued', 'running'])
      const { data, error } = await supabaseRequest(() => supabase.from('projects')
        .select('id, document, project_members!inner(user_id, role)')
        .eq('project_members.role', 'owner')
        .order('updated_at', { ascending: false })
        .limit(Math.max(1, Math.min(limit * 8, 400))))
      fail(error)
      return (data ?? [])
        .filter((row) => (row.document?.productionWorkflowRuns ?? []).some((run) => active.has(run?.status)))
        .slice(0, Math.max(1, Math.min(limit, 200)))
        .map((row) => ({ projectId: row.id, ownerId: row.project_members?.[0]?.user_id }))
        .filter((entry) => entry.ownerId)
    },

    async putAgentReviewTask(userId, task) {
      const role = await memberRole(task.projectId, userId)
      assertProjectPermission(role, 'read', 'PROJECT_READ_FORBIDDEN')
      const decision = await agentReviewFenceRpc('botanic_put_agent_review_task_guarded', {
        p_owner_id: task.ownerId ?? userId,
        p_task_id: task.id,
        p_project_id: task.projectId,
        p_task: clone(task),
      })
      return clone(decision?.task)
    },

    async claimAgentReviewExecution(userId, command) {
      return agentReviewFenceRpc('botanic_claim_agent_review_execution', {
        p_owner_id: userId,
        p_task_id: command?.id,
        p_project_id: command?.projectId,
        p_claim: clone(command),
      })
    },

    async commitAgentReviewExecution(userId, command) {
      return agentReviewFenceRpc('botanic_commit_agent_review_execution', {
        p_owner_id: userId,
        p_task_id: command?.id,
        p_project_id: command?.projectId,
        p_command: clone(command),
      })
    },

    async requestAgentReviewCancellation(userId, command) {
      return agentReviewFenceRpc('botanic_request_agent_review_cancellation', {
        p_actor_id: userId,
        p_task_id: command?.id,
        p_project_id: command?.projectId,
        p_command: { ...clone(command), requestedBy: userId },
      })
    },

    async finalizeAgentReviewCancellation(userId, command) {
      return agentReviewFenceRpc('botanic_finalize_agent_review_cancellation', {
        p_owner_id: userId,
        p_task_id: command?.id,
        p_project_id: command?.projectId,
        p_command: clone(command),
      })
    },

    async resolveAgentReviewOutcomeUnknown(userId, command) {
      return agentReviewFenceRpc('botanic_resolve_agent_review_outcome_unknown', {
        p_actor_id: userId,
        p_task_id: command?.id,
        p_project_id: command?.projectId,
        p_command: { ...clone(command), actorId: userId },
      })
    },

    async commitAgentReviewHumanDecisions(userId, command) {
      return agentReviewHumanDecisionRpc('botanic_commit_agent_review_human_decisions', {
        p_actor_id: userId,
        p_task_id: command?.id,
        p_project_id: command?.projectId,
        p_command: clone(command),
        p_contract_version: 2,
      })
    },

    async readAgentReviewTask(userId, taskId) {
      const { data, error } = await supabaseRequest(() => supabase.from('agent_review_tasks')
        .select('payload, project_id').eq('id', taskId).maybeSingle())
      fail(error)
      if (!data) return undefined
      return await memberRole(data.project_id, userId) ? clone(data.payload) : undefined
    },

    async readAgentReviewTaskForWorker(taskId) {
      const { data, error } = await supabaseRequest(() => supabase.from('agent_review_tasks')
        .select('payload').eq('id', taskId).maybeSingle())
      fail(error)
      return data ? clone(data.payload) : undefined
    },

    async listAgentReviewTasksForRun(userId, projectId, runId) {
      if (!await memberRole(projectId, userId)) return undefined
      const { data, error } = await supabaseRequest(() => supabase.from('agent_review_tasks').select('payload')
        .eq('project_id', projectId).eq('run_id', runId).order('updated_at', { ascending: false }).limit(50))
      fail(error)
      return (data ?? []).map((row) => clone(row.payload))
    },

    async listPendingAgentReviewTasks(options = {}) {
      const { olderThan, after, limit } = normalizePendingAgentReviewRecoveryPage(options)
      return recoveryKeysetRpc('botanic_list_pending_agent_review_tasks', {
        p_older_than_ms: olderThan,
        p_after_updated_at_ms: after?.updatedAt ?? null,
        p_after_id: after?.id ?? null,
        p_limit: limit,
      })
    },

    async putAgentReview(userId, review) {
      const role = await memberRole(review.projectId, userId)
      assertProjectPermission(role, 'read', 'PROJECT_READ_FORBIDDEN')
      const { data: run, error: runError } = await supabaseRequest(() => supabase.from('agent_runs').select('owner_id,project_id').eq('id', review.runId).maybeSingle())
      fail(runError)
      if (!run || run.owner_id !== userId || run.project_id !== review.projectId) throw productError('Agent Run 不属于当前项目。', 'AGENT_RUN_NOT_FOUND')
      const timestamp = Number(review.updatedAt) || now()
      const payload = { ...clone(review), ownerId: userId, updatedAt: timestamp }
      const { error } = await supabaseRequest(() => supabase.from('agent_reviews').upsert({
        id: review.id,
        owner_id: userId,
        project_id: review.projectId,
        run_id: review.runId,
        locale: review.locale ?? 'zh-CN',
        status: review.status ?? 'pending',
        updated_at: new Date(timestamp).toISOString(),
        payload,
      }, { onConflict: 'project_id,run_id,locale' }))
      fail(error)
      await insertAudit({ actorId: userId, action: 'agent-review.updated', projectId: review.projectId, targetId: review.id })
      return clone(payload)
    },

    async readAgentReview(userId, projectId, runId, locale = 'zh-CN') {
      if (!await memberRole(projectId, userId)) return undefined
      const { data, error } = await supabaseRequest(() => supabase.from('agent_reviews').select('payload')
        .eq('project_id', projectId).eq('run_id', runId).eq('locale', locale).eq('owner_id', userId).maybeSingle())
      fail(error)
      return data ? clone(data.payload) : undefined
    },

    async listAgentReviewsForRun(userId, projectId, runId) {
      if (!await memberRole(projectId, userId)) return undefined
      const { data, error } = await supabaseRequest(() => supabase.from('agent_reviews').select('payload')
        .eq('project_id', projectId).eq('run_id', runId).eq('owner_id', userId).order('updated_at', { ascending: false }))
      fail(error)
      return (data ?? []).map((row) => clone(row.payload))
    },

    async putAgentReviewDecision(userId, projectId, reviewId, decision, decisionNote = '') {
      const role = await memberRole(projectId, userId)
      assertProjectPermission(role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      if (!['pending', 'accepted', 'rejected', 'retry_requested'].includes(decision)) throw productError('评审决策无效。', 'AGENT_REVIEW_DECISION_INVALID')
      const { data: current, error: readError } = await supabaseRequest(() => supabase.from('agent_reviews').select('payload').eq('id', reviewId).eq('project_id', projectId).maybeSingle())
      fail(readError)
      if (!current) throw productError('未找到 Agent 评审。', 'AGENT_REVIEW_NOT_FOUND')
      const payload = { ...clone(current.payload), status: decision, decisionNote: String(decisionNote ?? '').slice(0, 500), decidedBy: userId, updatedAt: now() }
      const { error } = await supabaseRequest(() => supabase.from('agent_reviews').update({ status: decision, updated_at: new Date(payload.updatedAt).toISOString(), payload }).eq('id', reviewId).eq('project_id', projectId))
      fail(error)
      await insertAudit({ actorId: userId, action: `agent-review.${decision}`, projectId, targetId: reviewId })
      return clone(payload)
    },

    async readGenerationJob(userId, jobId) {
      const { data, error } = await supabaseRequest(() => supabase.from('generation_jobs').select('payload').eq('id', jobId).eq('owner_id', userId).maybeSingle())
      fail(error)
      return data ? clone(data.payload) : undefined
    },

    async listGenerationJobsForProject(userId, projectId, limit = 60) {
      if (!await memberRole(projectId, userId)) return undefined
      const { data, error } = await supabaseRequest(() => supabase
        .from('generation_jobs').select('payload').eq('project_id', projectId).eq('owner_id', userId)
        .order('updated_at', { ascending: false }).limit(Math.max(1, Math.min(limit, 120))))
      fail(error)
      return (data ?? []).map((row) => clone(row.payload))
    },

    async listGenerationJobsForAgentRunPage(userId, projectId, runId, options = {}) {
      if (!await memberRole(projectId, userId)) return undefined
      const { afterId, limit } = normalizeAgentEntityIdPage(options)
      let query = supabase.from('generation_jobs').select('payload')
        .eq('project_id', projectId).eq('owner_id', userId)
        .eq('payload->agentRun->>runId', runId)
      if (afterId !== null) query = query.gt('id', afterId)
      const { data, error } = await supabaseRequest(() => query.order('id', { ascending: true }).limit(limit))
      fail(error)
      return (data ?? []).map((row) => clone(row.payload))
    },

    async readGenerationJobForWorker(jobId) {
      const { data, error } = await supabaseRequest(() => supabase.from('generation_jobs').select('payload').eq('id', jobId).maybeSingle())
      fail(error)
      return data ? clone(data.payload) : undefined
    },

    async listRecoverableGenerationJobs(options = {}) {
      const { after, limit } = normalizeUpdatedAtIdRecoveryPage(options)
      return recoveryKeysetRpc('botanic_list_recoverable_generation_jobs', {
        p_after_updated_at_ms: after?.updatedAt ?? null,
        p_after_id: after?.id ?? null,
        p_limit: limit,
      })
    },

    async recoverGenerationJobs() {
      const [queuedResult, pendingResult] = await Promise.all([
        supabaseRequest(() => supabase.from('generation_jobs').select('payload').eq('status', 'queued').order('updated_at', { ascending: true })),
        supabaseRequest(() => supabase.from('generation_jobs').select('payload').eq('payload->>projectWritebackPending', 'true').order('updated_at', { ascending: true })),
      ])
      fail(queuedResult.error)
      fail(pendingResult.error)
      const jobs = [...(queuedResult.data ?? []), ...(pendingResult.data ?? [])]
      return [...new Map(jobs.map((row) => [row.payload.id, row])).values()].map((row) => clone(row.payload))
    },

    async recoverStaleGenerationJobs(staleAfterMs = 90_000) {
      const jobs = await generationFenceRpc('botanic_recover_stale_generation_jobs', {
        p_stale_after_ms: Math.max(30_000, staleAfterMs),
      })
      return Array.isArray(jobs) ? jobs.map(clone) : []
    },

    async createMediaObject(ownerId, projectId, { id, storageKey, contentType, byteSize }) {
      const mediaId = id ?? `media_${randomUUID()}`
      const { error } = await supabase.from('media_objects').insert({
        id: mediaId, project_id: projectId, owner_id: ownerId, storage_key: storageKey,
        content_type: contentType, byte_size: byteSize,
      })
      fail(error)
      return { id: mediaId, storageKey, contentType, byteSize }
    },

    async readMediaObject(userId, mediaId) {
      const { data, error } = await supabase.from('media_objects').select('*').eq('id', mediaId).maybeSingle()
      fail(error)
      if (!data || !await memberRole(data.project_id, userId)) return undefined
      return {
        id: data.id,
        projectId: data.project_id,
        storageKey: data.storage_key,
        contentType: data.content_type,
        byteSize: Number(data.byte_size),
      }
    },

    async listAuditEvents(userId, projectId, limit = 100) {
      const [{ data: project, error: projectError }, role] = await Promise.all([
        supabase.from('projects').select('id').eq('id', projectId).maybeSingle(),
        memberRole(projectId, userId),
      ])
      fail(projectError)
      if (!project) return undefined
      assertProjectPermission(role, 'read-audit', 'PROJECT_AUDIT_FORBIDDEN')
      const { data, error } = await supabase
        .from('audit_events').select('*').eq('project_id', projectId).order('created_at', { ascending: false }).limit(Math.max(1, Math.min(limit, 500)))
      fail(error)
      return (data ?? []).map((row) => ({
        id: row.id, actorId: row.actor_id, action: row.action, projectId: row.project_id,
        targetId: row.target_id, detail: clone(row.detail), createdAt: new Date(row.created_at).getTime(),
      }))
    },

    async listWorkspaceAuditEvents(userId, limit = 100) {
      const { data: profile, error: profileError } = await supabase.from('profiles').select('workspace_role').eq('id', userId).maybeSingle()
      fail(profileError)
      assertWorkspacePermission({ role: profile?.workspace_role, status: 'active' }, 'read-audit', 'WORKSPACE_AUDIT_FORBIDDEN')
      const { data, error } = await supabase
        .from('audit_events').select('*').order('created_at', { ascending: false }).limit(Math.max(1, Math.min(limit, 500)))
      fail(error)
      return (data ?? []).map((row) => ({
        id: row.id, actorId: row.actor_id, action: row.action, projectId: row.project_id,
        targetId: row.target_id, detail: clone(row.detail), createdAt: new Date(row.created_at).getTime(),
      }))
    },

    async recordSecurityAuditEvent(userId, action, detail = {}) {
      const { data: profile, error } = await supabase.from('profiles').select('id').eq('id', userId).maybeSingle()
      fail(error)
      if (!profile) throw productError('登录状态无效。', 'AUTH_REQUIRED')
      await insertAudit({ actorId: userId, action, detail })
      return { action }
    },

    async close() {},
  }
}
