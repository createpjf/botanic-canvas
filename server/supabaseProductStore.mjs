import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { isRetryableSupabaseError, retrySupabaseOperation } from './supabaseRetry.mjs'

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

  return {
    authProvider: 'supabase',

    async authenticate(accessToken) {
      if (!accessToken) return undefined
      const { data, error } = await supabaseRequest(() => supabase.auth.getUser(accessToken))
      if (error || !data.user) return undefined
      return userFromProfile(await profileForAuthUser(data.user))
    },

    async createUser(actorId, { email, name, role = 'member' }) {
      const { data: actor, error: actorError } = await supabase.from('profiles').select('workspace_role').eq('id', actorId).maybeSingle()
      fail(actorError)
      if (actor?.workspace_role !== 'owner') throw productError('只有工作区所有者可以邀请成员。', 'USER_CREATE_FORBIDDEN')
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
      return (data ?? []).map((row) => ({
        id: row.projects.id,
        name: row.projects.name,
        updatedAt: new Date(row.projects.updated_at).getTime(),
        revision: row.projects.revision,
        ...projectDocumentSummary(row.projects.document),
        role: row.role,
      })).sort((a, b) => b.updatedAt - a.updatedAt)
    },

    async readProject(userId, projectId) {
      const role = await memberRole(projectId, userId)
      if (!role) return undefined
      const { data, error } = await supabase.from('projects').select('document, revision').eq('id', projectId).maybeSingle()
      fail(error)
      return data ? { document: clone(data.document), revision: data.revision } : undefined
    },

    async canEditProject(userId, projectId) {
      const role = await memberRole(projectId, userId)
      return role === 'owner' || role === 'editor'
    },

    async writeProject(userId, document, expectedRevision) {
      const { data, error } = await supabase.rpc('botanic_write_project_document', {
        p_actor: userId,
        p_document: document,
        p_expected_revision: Number.isInteger(expectedRevision) ? expectedRevision : null,
      }).single()
      if (error?.code === '40001') throw productError('项目已被其他成员更新，请刷新后再保存。', 'PROJECT_CONFLICT')
      if (error?.code === '42501') throw productError('你没有编辑该项目的权限。', 'PROJECT_WRITE_FORBIDDEN')
      fail(error, '项目保存失败。')
      return { document: clone(data.document), revision: data.revision, created: data.created }
    },

    async deleteProject(userId, projectId) {
      if (await memberRole(projectId, userId) !== 'owner') throw productError('只有项目所有者可以删除项目。', 'PROJECT_DELETE_FORBIDDEN')
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
      if (await memberRole(projectId, actorId) !== 'owner') throw productError('只有项目所有者可以管理成员。', 'PROJECT_MEMBER_FORBIDDEN')
      const { data: profile, error: profileError } = await supabase.from('profiles').select('id').eq('id', userId).maybeSingle()
      fail(profileError)
      if (!profile) throw productError('未找到成员。', 'USER_NOT_FOUND')
      const { error } = await supabase.from('project_members').upsert({ project_id: projectId, user_id: userId, role }, { onConflict: 'project_id,user_id' })
      fail(error)
      const { error: updateError } = await supabase.from('projects').update({ updated_at: new Date().toISOString() }).eq('id', projectId)
      fail(updateError)
      await insertAudit({ actorId, action: 'project.member.upserted', projectId, targetId: userId, detail: { role } })
    },

    async readGlobalAssetLibrary(_userId, id) {
      // 品牌素材库属于整个工作区，而非单个项目。新成员在首次创建或加入项目
      // 前也需要读取它，否则客户端会尝试初始化并被写权限拦截，卡在加载状态。
      const { data, error } = await supabase.from('global_asset_libraries').select('library').eq('id', id).maybeSingle()
      fail(error)
      return data ? clone(data.library) : undefined
    },

    async writeGlobalAssetLibrary(userId, library) {
      const { data: membership, error: membershipError } = await supabase
        .from('project_members').select('role').eq('user_id', userId).in('role', ['owner', 'editor']).limit(1)
      fail(membershipError)
      const { count, error: countError } = await supabase.from('projects').select('*', { count: 'exact', head: true })
      fail(countError)
      if (!membership?.length && Number(count)) throw productError('你没有编辑品牌素材库的权限。', 'LIBRARY_WRITE_FORBIDDEN')
      const { error } = await supabase.from('global_asset_libraries').upsert({ id: library.id, library, updated_at: new Date().toISOString() }, { onConflict: 'id' })
      fail(error)
      await insertAudit({ actorId: userId, action: 'brand-library.updated', targetId: library.id })
      return clone(library)
    },

    async deleteGlobalAsset(userId, assetId) {
      const { data: membership, error: membershipError } = await supabase
        .from('project_members').select('role').eq('user_id', userId).in('role', ['owner', 'editor']).limit(1)
      fail(membershipError)
      if (!membership?.length) throw productError('你没有编辑品牌素材库的权限。', 'LIBRARY_WRITE_FORBIDDEN')
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

    async putGenerationJob(userId, job) {
      const payload = { ...clone(job), ownerId: userId, updatedAt: now() }
      const { error } = await supabaseRequest(() => supabase.from('generation_jobs').upsert({
        id: job.id, owner_id: userId, project_id: job.projectId, status: job.status,
        updated_at: new Date(payload.updatedAt).toISOString(), payload,
      }, { onConflict: 'id' }))
      fail(error)
      // 审计不可用不能让已成功幂等写入的生成任务在客户端表现为失败。
      try {
        await insertAudit({ actorId: userId, action: `generation.${job.status}`, projectId: job.projectId, targetId: job.id, detail: { model: job.settings?.model, batchCount: job.batchCount } })
      } catch (error) {
        console.warn(`[generation] audit deferred for ${job.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
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
      const { data, error } = await supabaseRequest(() => supabase.from('generation_jobs').select('payload').eq('status', 'queued').order('updated_at', { ascending: true }))
      fail(error)
      return (data ?? []).map((row) => clone(row.payload))
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
      if (!await memberRole(projectId, userId)) return undefined
      const { data, error } = await supabase
        .from('audit_events').select('*').eq('project_id', projectId).order('created_at', { ascending: false }).limit(Math.max(1, Math.min(limit, 500)))
      fail(error)
      return (data ?? []).map((row) => ({
        id: row.id, actorId: row.actor_id, action: row.action, projectId: row.project_id,
        targetId: row.target_id, detail: clone(row.detail), createdAt: new Date(row.created_at).getTime(),
      }))
    },

    async close() {},
  }
}
