import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { assertProjectPermission, assertWorkspacePermission, projectPermissionDecision } from './authorization.mjs'

const schemaVersion = 1

function now() {
  return Date.now()
}

function hashAccessToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

function clone(value) {
  return structuredClone(value)
}

function productError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

function publicUser(user) {
  return user ? {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status ?? 'active',
    createdAt: user.createdAt,
  } : undefined
}

function canvasGraph(document) {
  return {
    nodes: clone(Array.isArray(document?.nodes) ? document.nodes : []),
    edges: clone(Array.isArray(document?.edges) ? document.edges : []),
  }
}

function sameGraph(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function projectDocumentSummary(document) {
  const nodes = Array.isArray(document?.nodes) ? document.nodes : []
  const images = nodes
    .filter((node) => node?.type === 'result' && typeof node?.data?.image === 'string')
    .map((node) => node.data.image)
  return { nodeCount: nodes.length, resultCount: images.length, coverImage: images.at(-1) }
}

function initialState() {
  return {
    schemaVersion,
    users: [],
    accessTokens: [],
    projects: [],
    canvasGraphs: [],
    globalAssetLibraries: [],
    generationJobs: [],
    auditEvents: [],
  }
}

/**
 * 单实例持久化模块。
 *
 * 调用方只知道“用户、项目、任务、审计”四类读写；原子文件写入、令牌散列与
 * 重启恢复均封装在此处。生产部署应将 dataPath 放在持久卷上；未来替换为
 * PostgreSQL 时保持这个 Interface，不把数据访问复杂度扩散回路由层。
 */
export function createProductStore({ dataPath, bootstrapAccessToken, bootstrapEmail = 'owner@botanic.local' }) {
  if (!bootstrapAccessToken) throw new Error('BOTANIC_BOOTSTRAP_ACCESS_TOKEN 未配置，拒绝启动受保护的产品服务。')

  const path = resolve(dataPath)
  mkdirSync(dirname(path), { recursive: true })
  let state = loadState(path)
  ensureBootstrapUser(state, bootstrapAccessToken, bootstrapEmail)
  persist(path, state)

  function save() {
    persist(path, state)
  }

  function audit({ actorId, action, projectId, targetId, detail = {} }) {
    const event = {
      id: `audit_${randomUUID()}`,
      actorId,
      action,
      projectId,
      targetId,
      detail: clone(detail),
      createdAt: now(),
    }
    state.auditEvents.push(event)
    // 审计日志只保留最近 20,000 条，避免单机 MVP 无限增长；正式环境应归档到日志系统。
    if (state.auditEvents.length > 20_000) state.auditEvents.splice(0, state.auditEvents.length - 20_000)
    return event
  }

  function authenticatedUser(accessToken) {
    if (!accessToken) return undefined
    const token = state.accessTokens.find((item) => item.tokenHash === hashAccessToken(accessToken) && !item.revokedAt)
    if (!token) return undefined
    return state.users.find((item) => item.id === token.userId && item.status !== 'disabled')
  }

  function canAccess(project, userId, allowedRoles = ['owner', 'editor', 'viewer']) {
    const member = project.members.find((item) => item.userId === userId)
    return member && allowedRoles.includes(member.role) ? member : undefined
  }

  function publicProject(project) {
    const graphEntry = state.canvasGraphs.find((item) => item.projectId === project.id)
    const summary = projectDocumentSummary(graphEntry ? { ...project.document, ...graphEntry.graph } : project.document)
    return {
      id: project.id,
      name: project.name,
      updatedAt: Math.max(project.updatedAt, graphEntry?.updatedAt ?? 0),
      revision: project.revision,
      graphRevision: graphEntry?.graphRevision ?? 1,
      ...summary,
      role: project.members.find((item) => item.userId === project.lastAccessedBy)?.role,
    }
  }

  function ensureCanvasGraph(project) {
    let entry = state.canvasGraphs.find((item) => item.projectId === project.id)
    if (!entry) {
      entry = {
        projectId: project.id,
        graph: {
          ...canvasGraph(project.document),
        },
        graphRevision: 1,
        updates: [],
        updatedAt: project.updatedAt,
      }
      state.canvasGraphs.push(entry)
      save()
    }
    return entry
  }

  return {
    authenticate(accessToken) {
      const user = authenticatedUser(accessToken)
      return publicUser(user)
    },

    createUser(actorId, { email, name, role = 'member', accessToken }) {
      const actor = state.users.find((item) => item.id === actorId)
      assertWorkspacePermission(actor, 'manage-members', 'USER_CREATE_FORBIDDEN')
      if (!email || !accessToken) throw new Error('成员邮箱与访问令牌不能为空。')
      if (state.users.some((item) => item.email.toLowerCase() === email.toLowerCase())) throw new Error('该成员已存在。')
      const user = { id: `usr_${randomUUID()}`, email, name: name || email, role, status: 'active', createdAt: now() }
      state.users.push(user)
      state.accessTokens.push({ id: `token_${randomUUID()}`, userId: user.id, tokenHash: hashAccessToken(accessToken), createdAt: now() })
      audit({ actorId, action: 'member.created', targetId: user.id, detail: { email: user.email, role } })
      save()
      return publicUser(user)
    },

    listUsers(actorId) {
      const actor = state.users.find((item) => item.id === actorId)
      assertWorkspacePermission(actor, 'manage-members', 'USER_MANAGE_FORBIDDEN')
      return state.users
        .slice()
        .sort((left, right) => Number(left.createdAt ?? 0) - Number(right.createdAt ?? 0))
        .map(publicUser)
    },

    updateUser(actorId, targetId, updates) {
      const actor = state.users.find((item) => item.id === actorId)
      assertWorkspacePermission(actor, 'manage-members', 'USER_MANAGE_FORBIDDEN')
      const target = state.users.find((item) => item.id === targetId)
      if (!target) throw productError('未找到该工作区成员。', 'USER_NOT_FOUND')
      const nextRole = updates?.role ?? target.role
      const nextStatus = updates?.status ?? target.status ?? 'active'
      if (!['owner', 'member'].includes(nextRole) || !['active', 'disabled'].includes(nextStatus)) {
        throw productError('成员更新参数无效。', 'USER_UPDATE_INVALID')
      }
      if (target.role === 'owner' && (nextRole !== 'owner' || nextStatus === 'disabled')) {
        const activeOwners = state.users.filter((item) => item.role === 'owner' && item.status !== 'disabled')
        if (activeOwners.length <= 1) throw productError('工作区必须保留至少一名启用的所有者。', 'LAST_OWNER_REQUIRED')
      }
      target.role = nextRole
      target.status = nextStatus
      if (nextStatus === 'disabled') {
        for (const token of state.accessTokens) {
          if (token.userId === target.id && !token.revokedAt) token.revokedAt = now()
        }
      }
      audit({ actorId, action: 'member.updated', targetId, detail: { role: nextRole, status: nextStatus } })
      save()
      return publicUser(target)
    },

    listProjects(userId) {
      return state.projects
        .filter((project) => canAccess(project, userId))
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .map((project) => ({
          ...publicProject(project),
          role: canAccess(project, userId)?.role,
        }))
    },

    readProject(userId, projectId) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project || !canAccess(project, userId)) return undefined
      project.lastAccessedBy = userId
      const graph = ensureCanvasGraph(project)
      return {
        document: {
          ...clone(project.document),
          ...clone(graph.graph),
          updatedAt: Math.max(project.document.updatedAt ?? 0, project.updatedAt, graph.updatedAt ?? 0),
        },
        revision: project.revision,
        graphRevision: graph.graphRevision,
      }
    },

    projectAccess(userId, projectId) {
      const project = state.projects.find((item) => item.id === projectId)
      return {
        exists: Boolean(project),
        role: project?.members.find((item) => item.userId === userId)?.role,
      }
    },

    canEditProject(userId, projectId) {
      const project = state.projects.find((item) => item.id === projectId)
      const role = project?.members.find((item) => item.userId === userId)?.role
      return projectPermissionDecision(role, 'edit') === 'allow'
    },

    writeProject(userId, document, expectedRevision, expectedGraphRevision) {
      const existing = state.projects.find((item) => item.id === document.id)
      if (existing) {
        const member = existing.members.find((item) => item.userId === userId)
        assertProjectPermission(member?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
        if (Number.isInteger(expectedRevision) && expectedRevision !== existing.revision) {
          const conflict = new Error('项目已被其他成员更新，请刷新后再保存。')
          conflict.code = 'PROJECT_CONFLICT'
          throw conflict
        }
        const graph = ensureCanvasGraph(existing)
        const nextGraph = canvasGraph(document)
        const graphChanged = !sameGraph(graph.graph, nextGraph)
        if (graphChanged && Number.isInteger(expectedGraphRevision) && expectedGraphRevision !== graph.graphRevision) {
          const conflict = new Error('画布图谱已被其他成员更新，请刷新后再保存。')
          conflict.code = 'CANVAS_GRAPH_CONFLICT'
          throw conflict
        }
        if (graphChanged) {
          graph.graph = nextGraph
          graph.graphRevision += 1
          graph.updatedAt = now()
        }
        existing.document = clone(document)
        existing.name = document.name
        existing.updatedAt = now()
        existing.revision += 1
        audit({ actorId: userId, action: 'project.updated', projectId: existing.id, detail: { revision: existing.revision } })
        save()
        return {
          document: { ...clone(existing.document), ...clone(graph.graph) },
          revision: existing.revision,
          graphRevision: graph.graphRevision,
          created: false,
        }
      }

      const project = {
        id: document.id,
        name: document.name,
        document: clone(document),
        members: [{ userId, role: 'owner', addedAt: now() }],
        revision: 1,
        createdAt: now(),
        updatedAt: now(),
      }
      state.projects.push(project)
      state.canvasGraphs.push({
        projectId: project.id,
        graph: canvasGraph(document),
        graphRevision: 1,
        updates: [],
        updatedAt: project.updatedAt,
      })
      audit({ actorId: userId, action: 'project.created', projectId: project.id })
      save()
      return { document: clone(project.document), revision: project.revision, graphRevision: 1, created: true }
    },

    deleteProject(userId, projectId) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project) return false
      assertProjectPermission(project.members.find((item) => item.userId === userId)?.role, 'delete', 'PROJECT_DELETE_FORBIDDEN')
      state.projects = state.projects.filter((item) => item.id !== projectId)
      state.canvasGraphs = state.canvasGraphs.filter((item) => item.projectId !== projectId)
      state.generationJobs = state.generationJobs.filter((item) => item.projectId !== projectId)
      audit({ actorId: userId, action: 'project.deleted', targetId: projectId, detail: { name: project.name } })
      save()
      return true
    },

    addProjectMember(actorId, projectId, userId, role) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project) throw productError('未找到项目。', 'PROJECT_NOT_FOUND')
      assertProjectPermission(project.members.find((item) => item.userId === actorId)?.role, 'manage-members', 'PROJECT_MEMBER_FORBIDDEN')
      const user = state.users.find((item) => item.id === userId)
      if (!user) throw new Error('未找到成员。')
      const member = project.members.find((item) => item.userId === userId)
      if (member) member.role = role
      else project.members.push({ userId, role, addedAt: now() })
      project.updatedAt = now()
      project.revision += 1
      audit({ actorId, action: 'project.member.upserted', projectId, targetId: userId, detail: { role } })
      save()
    },

    loadCanvasCollaboration(userId, projectId) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project || !canAccess(project, userId)) return undefined
      const entry = ensureCanvasGraph(project)
      return clone({
        graph: entry.graph,
        graphRevision: entry.graphRevision,
        snapshot: entry.snapshot,
        updates: entry.updates,
        updatedAt: entry.updatedAt,
      })
    },

    appendCanvasGraphUpdate(userId, projectId, { update, graph }) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project) throw productError('未找到项目。', 'PROJECT_NOT_FOUND')
      assertProjectPermission(project.members.find((item) => item.userId === userId)?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      if (typeof update !== 'string' || !update || !Array.isArray(graph?.nodes) || !Array.isArray(graph?.edges)) {
        throw new TypeError('画布协作更新格式无效。')
      }
      const entry = ensureCanvasGraph(project)
      entry.graph = clone(graph)
      entry.graphRevision += 1
      entry.updates.push(update)
      entry.updatedAt = now()
      save()
      return { graphRevision: entry.graphRevision, updatedAt: entry.updatedAt, updateCount: entry.updates.length }
    },

    compactCanvasGraphUpdates(userId, projectId, { snapshot, graph }) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project) throw productError('未找到项目。', 'PROJECT_NOT_FOUND')
      assertProjectPermission(project.members.find((item) => item.userId === userId)?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      if (typeof snapshot !== 'string' || !snapshot || !Array.isArray(graph?.nodes) || !Array.isArray(graph?.edges)) {
        throw new TypeError('画布协作快照格式无效。')
      }
      const entry = ensureCanvasGraph(project)
      entry.graph = clone(graph)
      entry.snapshot = snapshot
      entry.updates = []
      entry.updatedAt = now()
      save()
      return { graphRevision: entry.graphRevision, updatedAt: entry.updatedAt }
    },

    readGlobalAssetLibrary(userId, id) {
      const user = state.users.find((item) => item.id === userId)
      if (!user || user.status === 'disabled') return undefined
      const library = state.globalAssetLibraries.find((item) => item.id === id)
      return library ? clone(library.library) : undefined
    },

    writeGlobalAssetLibrary(userId, library) {
      const user = state.users.find((item) => item.id === userId)
      assertWorkspacePermission(user, 'manage-library', 'LIBRARY_WRITE_FORBIDDEN')
      const existing = state.globalAssetLibraries.find((item) => item.id === library.id)
      if (existing) {
        existing.library = clone(library)
        existing.updatedAt = now()
      } else {
        state.globalAssetLibraries.push({ id: library.id, library: clone(library), updatedAt: now() })
      }
      audit({ actorId: userId, action: 'brand-library.updated', targetId: library.id })
      save()
      return clone(library)
    },

    deleteGlobalAsset(userId, assetId) {
      const libraryEntry = state.globalAssetLibraries.find((item) => item.id === 'global-brand-assets')
      if (!libraryEntry) return { deleted: false, library: undefined }
      const user = state.users.find((item) => item.id === userId)
      assertWorkspacePermission(user, 'manage-library', 'LIBRARY_WRITE_FORBIDDEN')
      const assets = libraryEntry.library.assets.filter((asset) => asset.id !== assetId)
      const deleted = assets.length !== libraryEntry.library.assets.length
      if (deleted) {
        libraryEntry.library = { ...libraryEntry.library, assets, updatedAt: now() }
        libraryEntry.updatedAt = now()
        audit({ actorId: userId, action: 'brand-asset.deleted', targetId: assetId })
        save()
      }
      return { deleted, library: clone(libraryEntry.library) }
    },

    putGenerationJob(userId, job) {
      const existing = state.generationJobs.find((item) => item.id === job.id)
      if (existing) Object.assign(existing, clone(job), { updatedAt: now() })
      else state.generationJobs.push({ ...clone(job), ownerId: userId, updatedAt: now() })
      audit({ actorId: userId, action: `generation.${job.status}`, projectId: job.projectId, targetId: job.id, detail: { model: job.settings?.model, batchCount: job.batchCount } })
      save()
    },

    readGenerationJob(userId, jobId) {
      const job = state.generationJobs.find((item) => item.id === jobId)
      return job && job.ownerId === userId ? clone(job) : undefined
    },

    listGenerationJobsForProject(userId, projectId, limit = 60) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project || !canAccess(project, userId)) return undefined
      return state.generationJobs
        .filter((job) => job.ownerId === userId && job.projectId === projectId)
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, Math.max(1, Math.min(limit, 120)))
        .map(clone)
    },

    // 仅显式本地原型队列使用；生产 Worker 使用 PostgreSQL Adapter 的同名方法。
    readGenerationJobForWorker(jobId) {
      const job = state.generationJobs.find((item) => item.id === jobId)
      return job ? clone(job) : undefined
    },

    recoverGenerationJobs() {
      const recovered = []
      for (const job of state.generationJobs) {
        if (job.status === 'queued') recovered.push(clone(job))
        if (job.status === 'running') {
          job.status = 'failed'
          job.error = '生成服务已重启，正在执行的任务已安全终止，请原配方重试。'
          job.updatedAt = now()
          audit({ actorId: job.ownerId, action: 'generation.interrupted', projectId: job.projectId, targetId: job.id })
        }
      }
      save()
      return recovered
    },

    recoverStaleGenerationJobs() {
      return []
    },

    listAuditEvents(userId, projectId, limit = 100) {
      if (!projectId) throw productError('项目审计必须指定项目。', 'PROJECT_AUDIT_FORBIDDEN')
      const project = state.projects.find((item) => item.id === projectId)
      if (!project) return undefined
      assertProjectPermission(project.members.find((item) => item.userId === userId)?.role, 'read-audit', 'PROJECT_AUDIT_FORBIDDEN')
      return state.auditEvents
        .filter((event) => !projectId || event.projectId === projectId)
        .slice(-Math.max(1, Math.min(limit, 500)))
        .reverse()
        .map(clone)
    },

    listWorkspaceAuditEvents(userId, limit = 100) {
      const user = state.users.find((item) => item.id === userId)
      assertWorkspacePermission(user, 'read-audit', 'WORKSPACE_AUDIT_FORBIDDEN')
      return state.auditEvents
        .slice(-Math.max(1, Math.min(limit, 500)))
        .reverse()
        .map(clone)
    },

    recordSecurityAuditEvent(userId, action, detail = {}) {
      const user = state.users.find((item) => item.id === userId)
      if (!user || user.status === 'disabled') throw productError('登录状态无效。', 'AUTH_REQUIRED')
      const event = audit({ actorId: userId, action, detail })
      save()
      return clone(event)
    },
  }
}

function loadState(path) {
  if (!existsSync(path)) return initialState()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || parsed.schemaVersion !== schemaVersion) throw new Error('schema mismatch')
    return {
      ...initialState(),
      ...parsed,
      users: Array.isArray(parsed.users)
        ? parsed.users.map((user) => ({ ...user, status: user.status ?? 'active' }))
        : [],
    }
  } catch {
    throw new Error(`无法读取产品数据文件：${path}`)
  }
}

function persist(path, state) {
  const temporaryPath = `${path}.${process.pid}.tmp`
  writeFileSync(temporaryPath, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 })
  renameSync(temporaryPath, path)
}

function ensureBootstrapUser(state, accessToken, email) {
  const tokenHash = hashAccessToken(accessToken)
  if (state.accessTokens.some((item) => item.tokenHash === tokenHash && !item.revokedAt)) return
  let owner = state.users.find((item) => item.role === 'owner')
  if (!owner) {
    owner = { id: `usr_${randomUUID()}`, email, name: 'Botanic Owner', role: 'owner', status: 'active', createdAt: now() }
    state.users.push(owner)
  }
  state.accessTokens.push({ id: `token_${randomUUID()}`, userId: owner.id, tokenHash, createdAt: now() })
}
