import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { isRetryableSupabaseError, retrySupabaseOperation } from './supabaseRetry.mjs'
import { decodeAuthAssurance } from './authAssurance.mjs'
import { assertProjectPermission, assertWorkspacePermission, projectPermissionDecision } from './authorization.mjs'
import { artifactIndexLimits, artifactsFromActionReceipt, artifactsFromAgentMessage, artifactsFromDocument, artifactsFromGenerationJob } from './botanicArtifactIndex.mjs'
import { applyGenerationJobToAgentRun } from './botanicAgentRun.mjs'
import { agentStateFromDocument, applyAgentSessionReadReceipts, mergeAgentStateIntoDocument, shouldApplyAgentEntityWrite, validateAgentEntityWriteTimestamp, validateAgentMemoryEntity, validateAgentMessageEntity, validateAgentSessionEntity, validateAgentSessionReadReceipt } from './botanicAgentPersistence.mjs'

const now = () => Date.now()
const clone = (value) => structuredClone(value)

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

/**
 * Supabase ProductStore。Auth 由 Supabase 管理；所有服务端数据写入使用 secret
 * key，浏览器凭 JWT 访问时仍受数据库与 Storage RLS 保护。
 */
export function createSupabaseProductStore({ url, secretKey, bootstrapEmail, inviteRedirectTo }) {
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

  async function readAgentStateRows(projectId, userId) {
    const results = await Promise.all([
      supabaseRequest(() => supabase.from('agent_sessions').select('payload').eq('project_id', projectId).order('updated_at', { ascending: false }).limit(80)),
      collectSupabaseRows(() => supabase.from('agent_messages').select('session_id,updated_at,payload').eq('project_id', projectId).order('updated_at', { ascending: true })),
      supabaseRequest(() => supabase.from('agent_memory_items').select('id,deleted_at,payload').eq('project_id', projectId).order('updated_at', { ascending: false }).limit(200)),
      supabaseRequest(() => supabase.from('agent_runs').select('payload').eq('project_id', projectId).order('updated_at', { ascending: false }).limit(60)),
      userId
        ? supabaseRequest(() => supabase.from('agent_session_read_receipts').select('session_id,message_id,updated_at').eq('project_id', projectId).eq('user_id', userId))
        : Promise.resolve({ data: [], error: undefined }),
    ])
    if (results.slice(0, 4).some((result) => missingAgentEntityTable(result.error))) {
      return { sessions: [], messages: [], memory: [], deletedMemoryIds: [], runs: [] }
    }
    results.slice(0, 4).forEach((result) => fail(result.error))
    if (results[4].error && !missingAgentEntityTable(results[4].error)) fail(results[4].error)
    const [sessions, messages, memory, runs] = results.map((result) => result.data ?? [])
    const receipts = results[4].error ? [] : results[4].data ?? []
    return {
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
      const ids = batch.map((artifact) => artifact.id)
      const { data: existingRows, error: readError } = await supabaseRequest(() => supabase.from('agent_artifacts')
        .select('id,owner_id,created_at,updated_at').eq('project_id', projectId).in('id', ids))
      if (missingAgentEntityTable(readError)) return false
      fail(readError)
      const existingById = new Map((existingRows ?? []).map((row) => [row.id, row]))
      const rows = batch.filter((artifact) => {
        const existing = existingById.get(artifact.id)
        return !existing || artifact.updatedAt >= new Date(existing.updated_at).getTime()
      }).map((artifact) => {
        const existing = existingById.get(artifact.id)
        const indexedCreatedAt = Math.min(
          artifact.createdAt,
          existing?.created_at ? new Date(existing.created_at).getTime() : artifact.createdAt,
        )
        return {
          project_id: projectId,
          id: artifact.id,
          owner_id: existing?.owner_id ?? userId,
          kind: artifact.kind,
          source_kind: artifact.origin.type,
          run_id: artifact.provenance.runId ?? null,
          job_id: artifact.origin.jobId ?? null,
          created_at: new Date(indexedCreatedAt).toISOString(),
          updated_at: new Date(artifact.updatedAt).toISOString(),
          payload: { ...artifact, createdAt: indexedCreatedAt },
        }
      })
      if (!rows.length) continue
      const { error } = await supabaseRequest(() => supabase.from('agent_artifacts').upsert(rows, { onConflict: 'project_id,id' }))
      if (missingAgentEntityTable(error)) return false
      fail(error)
    }
    return true
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

    // 新项目通过 RPC 在单个事务中完成 LWW 合并。旧项目未迁移时才走下方兼容路径。
    const { error: rpcError } = await supabaseRequest(() => supabase.rpc('botanic_sync_agent_entities', {
      p_owner_id: userId,
      p_project_id: document.id,
      p_sessions: sessionRows,
      p_messages: messageRows,
      p_memory: memoryRows,
      p_runs: runRows,
      p_deleted_memory: deletedMemoryRows,
    }))
    if (!rpcError) {
      await syncLegacyReadingReceipts(userId, document.id, extracted)
      await upsertArtifactRecords(userId, document.id, artifactsFromDocument(document))
      return
    }
    if (!missingAgentEntityRpc(rpcError)) fail(rpcError)

    for (const [table, rows] of [
      ['agent_sessions', sessionRows], ['agent_messages', messageRows],
      ['agent_memory_items', memoryRows], ['agent_runs', runRows],
    ]) {
      if (!rows.length) continue
      for (let offset = 0; offset < rows.length; offset += 500) {
        const batch = rows.slice(offset, offset + 500)
        const existingColumns = table === 'agent_messages'
          ? 'id,project_id,session_id,updated_at'
          : table === 'agent_memory_items'
            ? 'id,project_id,updated_at,deleted_at'
            : 'id,project_id,updated_at'
        const { data: existingRows, error: conflictError } = await supabaseRequest(() => supabase.from(table).select(existingColumns).in('id', batch.map((row) => row.id)))
        if (missingAgentEntityTable(conflictError)) return
        fail(conflictError)
        if ((existingRows ?? []).some((row) => row.project_id !== document.id
          || (table === 'agent_messages' && row.session_id !== batch.find((item) => item.id === row.id)?.session_id))) {
          throw productError('Agent 实体标识已被其他项目使用。', 'AGENT_ENTITY_ID_CONFLICT')
        }
        const existingById = new Map((existingRows ?? []).map((row) => [row.id, row]))
        const safeRows = batch.filter((row) => {
          const existing = existingById.get(row.id)
          if (table === 'agent_runs') return !existing
          return shouldApplyAgentEntityWrite(existing, row, {
            tombstoneWinsTie: table === 'agent_memory_items',
          })
        })
        if (!safeRows.length) continue
        const { error } = await supabaseRequest(() => supabase.from(table).upsert(safeRows, { onConflict: 'id' }))
        if (missingAgentEntityTable(error)) return
        fail(error)
      }
    }
    if (removedIds.length) {
      const { error } = await supabaseRequest(() => supabase.from('agent_memory_items')
        .update({ deleted_at: deletedAt, updated_at: deletedAt })
        .eq('project_id', document.id)
        .in('id', removedIds)
        .lte('updated_at', deletedAt))
      if (!missingAgentEntityTable(error)) fail(error)
    }
    await syncLegacyReadingReceipts(userId, document.id, extracted)
    await upsertArtifactRecords(userId, document.id, artifactsFromDocument(document))
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
      const { data, error } = await supabase.auth.admin.inviteUserByEmail(email, {
        data: { display_name: name || email },
        ...(inviteRedirectTo ? { redirectTo: inviteRedirectTo } : {}),
      })
      fail(error, '邀请成员失败。')
      if (!data.user) throw productError('邀请成员失败。', 'USER_CREATE_FAILED')
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .upsert({ id: data.user.id, email, display_name: name || email, workspace_role: role }, { onConflict: 'id' })
        .select('*')
        .single()
      fail(profileError)
      await insertAudit({ actorId, action: 'member.invited', targetId: profile.id, detail: { email, role } })
      return userFromProfile(profile)
    },

    async listProjects(userId) {
      const { data, error } = await supabase
        .from('project_members')
        .select('role, projects!inner(id, name, updated_at, revision, document)')
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
        const document = { ...row.projects.document, ...(entry?.graph ?? canvasGraph(row.projects.document)) }
        return {
          id: row.projects.id,
          name: row.projects.name,
          updatedAt: Math.max(
            new Date(row.projects.updated_at).getTime(),
            entry?.updated_at ? new Date(entry.updated_at).getTime() : 0,
          ),
          revision: row.projects.revision,
          graphRevision: entry?.revision ?? 1,
          ...projectDocumentSummary(document),
          role: row.role,
        }
      }).sort((a, b) => b.updatedAt - a.updatedAt)
    },

    async readProject(userId, projectId) {
      const role = await memberRole(projectId, userId)
      if (!role) return undefined
      const [{ data, error }, graphResult, agentState] = await Promise.all([
        supabase.from('projects').select('document, revision, updated_at').eq('id', projectId).maybeSingle(),
        supabase.from('canvas_graphs').select('graph, revision, updated_at').eq('project_id', projectId).maybeSingle(),
        readAgentStateRows(projectId, userId),
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
        document: mergeAgentStateIntoDocument({ ...clone(data.document), ...clone(graph), updatedAt }, agentState),
        revision: data.revision,
        graphRevision: graphResult.data?.revision ?? 1,
      }
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

    async writeProject(userId, document, expectedRevision, expectedGraphRevision) {
      const { data: previous, error: previousError } = await supabaseRequest(() => supabase.from('projects').select('document').eq('id', document.id).maybeSingle())
      fail(previousError)
      const { data, error } = await supabase.rpc('botanic_write_project_document', {
        p_actor: userId,
        p_document: document,
        p_expected_revision: Number.isInteger(expectedRevision) ? expectedRevision : null,
        p_expected_graph_revision: Number.isInteger(expectedGraphRevision) ? expectedGraphRevision : null,
      }).single()
      if (error?.code === '40001') throw productError('项目已被其他成员更新，请刷新后再保存。', 'PROJECT_CONFLICT')
      if (error?.code === 'BG001') throw productError('画布已被其他成员更新，请刷新后再保存。', 'CANVAS_GRAPH_CONFLICT')
      if (error?.code === '42501') throw productError('你没有编辑该项目的权限。', 'PROJECT_WRITE_FORBIDDEN')
      fail(error, '项目保存失败。')
      try {
        await syncAgentStateFromDocument(userId, document, previous?.document)
      } catch (caught) {
        // Supabase RPC 已原子保存兼容文档；实体双写失败不能把已成功的项目保存
        // 伪装成失败。读取仍会回退旧字段，下一次写入继续补偿。
        console.warn(`[agent-persistence] entity sync deferred for ${document.id}: ${caught instanceof Error ? caught.message : String(caught)}`)
      }
      return { document: clone(data.document), revision: data.revision, graphRevision: data.graph_revision, created: data.created }
    },

    async deleteProject(userId, projectId) {
      assertProjectPermission(await memberRole(projectId, userId), 'delete', 'PROJECT_DELETE_FORBIDDEN')
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
      if (!await memberRole(projectId, userId)) return undefined
      const [{ data: graphEntry, error: graphError }, { data: updates, error: updatesError }] = await Promise.all([
        supabase.from('canvas_graphs').select('graph, revision, yjs_snapshot, updated_at').eq('project_id', projectId).maybeSingle(),
        supabase.from('canvas_graph_updates').select('update_base64').eq('project_id', projectId).order('id', { ascending: true }),
      ])
      fail(graphError)
      fail(updatesError)
      if (!graphEntry) return undefined
      return {
        graph: clone(graphEntry.graph),
        graphRevision: graphEntry.revision,
        snapshot: graphEntry.yjs_snapshot ?? undefined,
        updates: (updates ?? []).map((entry) => entry.update_base64),
        updatedAt: new Date(graphEntry.updated_at).getTime(),
      }
    },

    async appendCanvasGraphUpdate(userId, projectId, { update, graph }) {
      if (typeof update !== 'string' || !update || !Array.isArray(graph?.nodes) || !Array.isArray(graph?.edges)) {
        throw new TypeError('画布协作更新格式无效。')
      }
      const { data, error } = await supabase.rpc('botanic_append_canvas_graph_update', {
        p_actor: userId,
        p_project_id: projectId,
        p_update_base64: update,
        p_graph: graph,
      }).single()
      if (error?.code === '42501') throw productError('你没有编辑该项目的权限。', 'PROJECT_WRITE_FORBIDDEN')
      fail(error, '画布协作更新保存失败。')
      return {
        graphRevision: data.graph_revision,
        updateCount: data.update_count,
        updatedAt: new Date(data.updated_at).getTime(),
      }
    },

    async compactCanvasGraphUpdates(userId, projectId, { snapshot, graph }) {
      if (typeof snapshot !== 'string' || !snapshot || !Array.isArray(graph?.nodes) || !Array.isArray(graph?.edges)) {
        throw new TypeError('画布协作快照格式无效。')
      }
      const { data, error } = await supabase.rpc('botanic_compact_canvas_graph_updates', {
        p_actor: userId,
        p_project_id: projectId,
        p_snapshot: snapshot,
        p_graph: graph,
      }).single()
      if (error?.code === '42501') throw productError('你没有编辑该项目的权限。', 'PROJECT_WRITE_FORBIDDEN')
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

    async readAgentState(userId, projectId) {
      if (!await memberRole(projectId, userId)) return undefined
      const state = await readAgentStateRows(projectId, userId)
      const hydrated = mergeAgentStateIntoDocument({ agentSessions: [], agentMemory: [], agentRuns: [] }, state)
      return { sessions: hydrated.agentSessions, memory: hydrated.agentMemory, runs: hydrated.agentRuns }
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

    async putAgentSession(userId, projectId, input) {
      assertProjectPermission(await memberRole(projectId, userId), 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const timestampValue = now()
      const session = validateAgentSessionEntity({ ...input, updatedAt: timestampValue }, { now: timestampValue })
      const { data: existing, error: readError } = await supabaseRequest(() => supabase.from('agent_sessions').select('project_id').eq('id', session.id).maybeSingle())
      fail(readError)
      if (existing && existing.project_id !== projectId) throw productError('Agent 会话标识已被其他项目使用。', 'AGENT_SESSION_ID_CONFLICT')
      const { error } = await supabaseRequest(() => supabase.from('agent_sessions').upsert({
        id: session.id, owner_id: userId, project_id: projectId,
        updated_at: new Date(timestampValue).toISOString(), payload: session,
      }, { onConflict: 'id' }))
      fail(error)
      await insertAudit({ actorId: userId, action: existing ? 'agent-session.updated' : 'agent-session.created', projectId, targetId: session.id })
      return clone(session)
    },

    async putAgentMessage(userId, projectId, sessionId, input) {
      assertProjectPermission(await memberRole(projectId, userId), 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const timestampValue = now()
      const message = validateAgentMessageEntity(input, { now: timestampValue })
      const [{ data: session, error: sessionError }, { data: existing, error: readError }] = await Promise.all([
        supabaseRequest(() => supabase.from('agent_sessions').select('payload').eq('id', sessionId).eq('project_id', projectId).maybeSingle()),
        supabaseRequest(() => supabase.from('agent_messages').select('project_id,session_id').eq('id', message.id).maybeSingle()),
      ])
      fail(sessionError)
      fail(readError)
      if (!session) throw productError('未找到 Agent 会话。', 'AGENT_SESSION_NOT_FOUND')
      if (existing && (existing.project_id !== projectId || existing.session_id !== sessionId)) {
        throw productError('Agent 消息标识已被其他会话使用。', 'AGENT_MESSAGE_ID_CONFLICT')
      }
      const timestampIso = new Date(timestampValue).toISOString()
      const [{ error }, { error: sessionWriteError }] = await Promise.all([
        supabaseRequest(() => supabase.from('agent_messages').upsert({
          id: message.id, owner_id: userId, project_id: projectId, session_id: sessionId,
          updated_at: timestampIso, payload: message,
        }, { onConflict: 'id' })),
        supabaseRequest(() => supabase.from('agent_sessions').update({
          updated_at: timestampIso, payload: { ...session.payload, updatedAt: timestampValue },
        }).eq('id', sessionId).eq('project_id', projectId)),
      ])
      fail(error)
      fail(sessionWriteError)
      try {
        await upsertArtifactRecords(userId, projectId, artifactsFromAgentMessage(message, { sessionId, updatedAt: timestampValue }))
      } catch (caught) {
        console.warn(`[artifact-index] message sync deferred for ${message.id}: ${caught instanceof Error ? caught.message : String(caught)}`)
      }
      await insertAudit({ actorId: userId, action: existing ? 'agent-message.updated' : 'agent-message.created', projectId, targetId: message.id, detail: { sessionId } })
      return clone(message)
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
      const role = await memberRole(skill.projectId, userId)
      assertProjectPermission(role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const { data: existing, error: readError } = await supabaseRequest(() => supabase.from('agent_skills').select('project_id,payload').eq('id', skill.id).maybeSingle())
      fail(readError)
      if (existing && existing.project_id !== skill.projectId) throw productError('Skill 标识已被其他项目使用。', 'AGENT_SKILL_ID_CONFLICT')
      const timestamp = now()
      const payload = {
        ...clone(skill), ownerId: userId,
        createdAt: Number(existing?.payload?.createdAt ?? skill.createdAt) || timestamp,
        updatedAt: timestamp,
      }
      const { error } = await supabaseRequest(() => supabase.from('agent_skills').upsert({
        id: skill.id, owner_id: userId, project_id: skill.projectId, status: payload.status,
        updated_at: new Date(timestamp).toISOString(), payload,
      }, { onConflict: 'id' }))
      fail(error)
      await insertAudit({ actorId: userId, action: existing ? 'agent-skill.updated' : 'agent-skill.created', projectId: skill.projectId, targetId: skill.id })
      return clone(payload)
    },

    async listAgentSkills(userId, projectId) {
      if (!await memberRole(projectId, userId)) return undefined
      const { data, error } = await supabaseRequest(() => supabase.from('agent_skills').select('payload')
        .eq('project_id', projectId).eq('status', 'active').order('updated_at', { ascending: false }))
      fail(error)
      return (data ?? []).map((row) => clone(row.payload))
    },

    async putAgentActionReceipt(userId, receipt) {
      const role = await memberRole(receipt.projectId, userId)
      assertProjectPermission(role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const { data: existing, error: readError } = await supabaseRequest(() => supabase.from('agent_action_receipts')
        .select('owner_id,project_id').eq('id', receipt.id).maybeSingle())
      fail(readError)
      if (existing && (existing.owner_id !== userId || existing.project_id !== receipt.projectId)) {
        throw productError('Agent 行动回执冲突。', 'AGENT_ACTION_RECEIPT_CONFLICT')
      }
      const payload = { ...clone(receipt), ownerId: userId }
      const { error } = await supabaseRequest(() => supabase.from('agent_action_receipts').upsert({
        id: receipt.id,
        owner_id: userId,
        project_id: receipt.projectId,
        created_at: new Date(receipt.createdAt).toISOString(),
        payload,
      }, { onConflict: 'id' }))
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

    async putGenerationJob(userId, job) {
      const payload = { ...clone(job), ownerId: userId, updatedAt: now() }
      const { error } = await supabaseRequest(() => supabase.from('generation_jobs').upsert({
        id: job.id, owner_id: userId, project_id: job.projectId, status: job.status,
        updated_at: new Date(payload.updatedAt).toISOString(), payload,
      }, { onConflict: 'id' }))
      fail(error)
      if (payload.agentRun?.runId) {
        const { data: runRow, error: runReadError } = await supabaseRequest(() => supabase.from('agent_runs').select('payload').eq('id', payload.agentRun.runId).eq('owner_id', userId).maybeSingle())
        fail(runReadError)
        if (runRow) {
          const run = applyGenerationJobToAgentRun(clone(runRow.payload), payload)
          const { error: runWriteError } = await supabaseRequest(() => supabase.from('agent_runs').update({
            status: run.status,
            updated_at: new Date(run.updatedAt).toISOString(),
            payload: run,
          }).eq('id', run.id).eq('owner_id', userId))
          fail(runWriteError)
        }
      }
      try {
        const [{ data: project, error: projectError }, { data: graph, error: graphError }] = await Promise.all([
          supabase.from('projects').select('document').eq('id', job.projectId).maybeSingle(),
          supabase.from('canvas_graphs').select('graph').eq('project_id', job.projectId).maybeSingle(),
        ])
        fail(projectError)
        fail(graphError)
        const document = project?.document
          ? { ...clone(project.document), ...clone(graph?.graph ?? {}) }
          : undefined
        await upsertArtifactRecords(userId, job.projectId, artifactsFromGenerationJob(payload, { document }))
      } catch (caught) {
        console.warn(`[artifact-index] generation sync deferred for ${job.id}: ${caught instanceof Error ? caught.message : String(caught)}`)
      }
      // 审计不可用不能让已成功幂等写入的生成任务在客户端表现为失败。
      try {
        await insertAudit({ actorId: userId, action: `generation.${job.status}`, projectId: job.projectId, targetId: job.id, detail: { model: job.settings?.model, batchCount: job.batchCount } })
      } catch (error) {
        console.warn(`[generation] audit deferred for ${job.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
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
      return upsertArtifactRecords(userId, job.projectId, artifactsFromGenerationJob(job, {
        document: { ...clone(project.document), ...clone(graph?.graph ?? {}) },
      }))
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

    async listAgentRunsForProject(userId, projectId, limit = 30) {
      if (!await memberRole(projectId, userId)) return undefined
      const { data, error } = await supabaseRequest(() => supabase.from('agent_runs').select('payload')
        .eq('project_id', projectId).eq('owner_id', userId)
        .order('updated_at', { ascending: false }).limit(Math.max(1, Math.min(limit, 60))))
      fail(error)
      return (data ?? []).map((row) => clone(row.payload))
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

    async readGenerationJobForWorker(jobId) {
      const { data, error } = await supabaseRequest(() => supabase.from('generation_jobs').select('payload').eq('id', jobId).maybeSingle())
      fail(error)
      return data ? clone(data.payload) : undefined
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
      const staleBefore = new Date(now() - Math.max(30_000, staleAfterMs)).toISOString()
      const { data, error } = await supabaseRequest(() => supabase
        .from('generation_jobs').select('payload').eq('status', 'running').lte('updated_at', staleBefore).order('updated_at', { ascending: true }))
      fail(error)
      return (data ?? []).map((row) => clone(row.payload))
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
