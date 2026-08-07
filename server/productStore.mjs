import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { assertProjectPermission, assertWorkspacePermission, projectPermissionDecision } from './authorization.mjs'
import { artifactIndexLimits, artifactsFromActionReceipt, artifactsFromAgentMessage, artifactsFromDocument, artifactsFromGenerationJob } from './botanicArtifactIndex.mjs'
import { applyGenerationJobToAgentRun } from './botanicAgentRun.mjs'
import { agentStateFromDocument, applyAgentSessionReadReceipts, mergeAgentStateIntoDocument, shouldApplyAgentEntityWrite, shouldApplyAgentRunWrite, validateAgentEntityWriteTimestamp, validateAgentMemoryEntity, validateAgentMessageEntity, validateAgentSessionEntity, validateAgentSessionReadReceipt } from './botanicAgentPersistence.mjs'
import { collaborationActivitiesForMember, nextCollaborationReceipt, validateCollaborationActivity } from './collaborationActivityPersistence.mjs'

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
    agentRuns: [],
    agentSessions: [],
    agentSessionReadReceipts: [],
    collaborationActivities: [],
    collaborationActivityReceipts: [],
    agentMessages: [],
    agentMemoryItems: [],
    agentArtifacts: [],
    agentSkills: [],
    agentActionReceipts: [],
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
  backfillArtifactIndexes()
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

  function agentStateForProject(projectId, userId) {
    const sessions = state.agentSessions.filter((item) => item.projectId === projectId).map((item) => clone(item.payload))
    const receipts = userId
      ? state.agentSessionReadReceipts.filter((item) => item.projectId === projectId && item.userId === userId).map((item) => clone(item.payload))
      : []
    return {
      sessions: userId ? applyAgentSessionReadReceipts(sessions, receipts) : sessions,
      messages: state.agentMessages.filter((item) => item.projectId === projectId).map((item) => ({
        sessionId: item.sessionId, updatedAt: item.updatedAt, message: clone(item.payload),
      })),
      memory: state.agentMemoryItems.filter((item) => item.projectId === projectId && !item.deletedAt).map((item) => clone(item.payload)),
      deletedMemoryIds: state.agentMemoryItems.filter((item) => item.projectId === projectId && item.deletedAt).map((item) => item.id),
      runs: state.agentRuns.filter((item) => item.projectId === projectId).map(clone),
    }
  }

  function upsertArtifactRecords(projectId, ownerId, artifacts) {
    for (const artifact of artifacts) {
      const existing = state.agentArtifacts.find((item) => item.projectId === projectId && item.id === artifact.id)
      if (existing && Number(existing.updatedAt ?? 0) > Number(artifact.updatedAt ?? 0)) continue
      const indexedCreatedAt = existing ? Math.min(existing.createdAt, artifact.createdAt) : artifact.createdAt
      const record = {
        id: artifact.id,
        projectId,
        ownerId: existing?.ownerId ?? ownerId,
        kind: artifact.kind,
        sourceKind: artifact.origin.type,
        runId: artifact.provenance.runId,
        jobId: artifact.origin.jobId,
        createdAt: indexedCreatedAt,
        updatedAt: artifact.updatedAt,
        payload: { ...clone(artifact), createdAt: indexedCreatedAt },
      }
      if (existing) Object.assign(existing, record)
      else state.agentArtifacts.push(record)
    }
  }

  function backfillArtifactIndexes() {
    for (const project of state.projects) {
      const ownerId = project.members.find((member) => member.role === 'owner')?.userId ?? project.members[0]?.userId
      if (!ownerId) continue
      const graph = state.canvasGraphs.find((item) => item.projectId === project.id)?.graph
      const document = mergeAgentStateIntoDocument({ ...project.document, ...(graph ?? {}) }, agentStateForProject(project.id))
      const generationJobs = state.generationJobs.filter((job) => job.projectId === project.id)
      upsertArtifactRecords(project.id, ownerId, artifactsFromDocument(document, { generationJobs }))
      for (const receipt of state.agentActionReceipts.filter((item) => item.projectId === project.id)) {
        upsertArtifactRecords(project.id, receipt.ownerId ?? ownerId, artifactsFromActionReceipt(receipt))
      }
    }
  }

  function syncAgentStateFromDocument(userId, document, previousDocument) {
    const extracted = agentStateFromDocument(document)
    for (const session of extracted.sessions) {
      const existing = state.agentSessions.find((item) => item.id === session.id)
      if (existing && existing.projectId !== document.id) throw productError('Agent 会话标识已被其他项目使用。', 'AGENT_SESSION_ID_CONFLICT')
      const payload = { id: session.id, projectId: document.id, ownerId: existing?.ownerId ?? userId, updatedAt: session.updatedAt, payload: clone(session) }
      if (!existing) state.agentSessions.push(payload)
      else if (session.updatedAt >= existing.updatedAt) Object.assign(existing, payload)
    }
    for (const entry of extracted.messages) {
      const existing = state.agentMessages.find((item) => item.id === entry.message.id)
      if (existing && (existing.projectId !== document.id || existing.sessionId !== entry.sessionId)) {
        throw productError('Agent 消息标识已被其他会话使用。', 'AGENT_MESSAGE_ID_CONFLICT')
      }
      const payload = {
        id: entry.message.id, projectId: document.id, sessionId: entry.sessionId,
        ownerId: existing?.ownerId ?? userId, updatedAt: entry.updatedAt, payload: clone(entry.message),
      }
      if (!existing) state.agentMessages.push(payload)
      else if (entry.updatedAt >= existing.updatedAt) Object.assign(existing, payload)
    }
    // 旧 CanvasDocument 的共享阅读位置只在迁移时归属本次写入成员；
    // 之后所有更新都走成员级回执，避免继续污染共享 Session。
    for (const session of extracted.sessions) {
      if (!session.readingAnchorMessageId || session.readingAnchorUpdatedAt === undefined) continue
      const messageExists = extracted.messages.some((entry) => entry.sessionId === session.id && entry.message.id === session.readingAnchorMessageId)
      if (!messageExists) continue
      const receipt = {
        sessionId: session.id,
        messageId: session.readingAnchorMessageId,
        updatedAt: session.readingAnchorUpdatedAt,
      }
      const existing = state.agentSessionReadReceipts.find((item) => item.userId === userId && item.projectId === document.id && item.sessionId === session.id)
      if (!existing) state.agentSessionReadReceipts.push({ userId, projectId: document.id, sessionId: session.id, updatedAt: receipt.updatedAt, payload: receipt })
      else if (receipt.updatedAt > existing.updatedAt) Object.assign(existing, { updatedAt: receipt.updatedAt, payload: receipt })
    }
    const previousMemoryIds = new Set((Array.isArray(previousDocument?.agentMemory) ? previousDocument.agentMemory : []).map((item) => item?.id).filter(Boolean))
    const nextMemoryIds = new Set(extracted.memory.map((item) => item.id))
    for (const removedId of previousMemoryIds) {
      if (nextMemoryIds.has(removedId)) continue
      const existing = state.agentMemoryItems.find((item) => item.id === removedId && item.projectId === document.id)
      if (existing) existing.deletedAt = now()
    }
    for (const memory of extracted.memory) {
      const existing = state.agentMemoryItems.find((item) => item.id === memory.id)
      if (existing && existing.projectId !== document.id) throw productError('Agent 记忆标识已被其他项目使用。', 'AGENT_MEMORY_ID_CONFLICT')
      const payload = {
        id: memory.id, projectId: document.id, ownerId: existing?.ownerId ?? userId,
        updatedAt: memory.updatedAt, deletedAt: undefined, payload: clone(memory),
      }
      if (!existing) state.agentMemoryItems.push(payload)
      else if (memory.updatedAt >= existing.updatedAt) Object.assign(existing, payload)
    }
    for (const run of extracted.runs) {
      const existing = state.agentRuns.find((item) => item.id === run.id)
      if (existing && existing.projectId !== document.id) throw productError('Agent Run 标识已被其他项目使用。', 'AGENT_RUN_ID_CONFLICT')
      const payload = { ...clone(run), projectId: document.id, ownerId: existing?.ownerId ?? userId }
      if (!existing) state.agentRuns.push(payload)
      // CanvasDocument 仅负责首次兼容迁移；已有独立 Run 始终是执行状态权威。
    }
    upsertArtifactRecords(document.id, userId, artifactsFromDocument(document))
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
        document: mergeAgentStateIntoDocument({
          ...clone(project.document),
          ...clone(graph.graph),
          updatedAt: Math.max(project.document.updatedAt ?? 0, project.updatedAt, graph.updatedAt ?? 0),
        }, agentStateForProject(projectId, userId)),
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
        const previousDocument = existing.document
        syncAgentStateFromDocument(userId, document, previousDocument)
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
      syncAgentStateFromDocument(userId, document)
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
      state.agentRuns = state.agentRuns.filter((item) => item.projectId !== projectId)
      state.agentSessions = state.agentSessions.filter((item) => item.projectId !== projectId)
      state.agentSessionReadReceipts = state.agentSessionReadReceipts.filter((item) => item.projectId !== projectId)
      state.collaborationActivities = state.collaborationActivities.filter((item) => item.projectId !== projectId)
      state.collaborationActivityReceipts = state.collaborationActivityReceipts.filter((item) => item.projectId !== projectId)
      state.agentMessages = state.agentMessages.filter((item) => item.projectId !== projectId)
      state.agentMemoryItems = state.agentMemoryItems.filter((item) => item.projectId !== projectId)
      state.agentArtifacts = state.agentArtifacts.filter((item) => item.projectId !== projectId)
      state.agentSkills = state.agentSkills.filter((item) => item.projectId !== projectId)
      state.agentActionReceipts = state.agentActionReceipts.filter((item) => item.projectId !== projectId)
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

    readAgentState(userId, projectId) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project || !canAccess(project, userId)) return undefined
      const hydrated = mergeAgentStateIntoDocument({ agentSessions: [], agentMemory: [], agentRuns: [] }, agentStateForProject(projectId, userId))
      return {
        sessions: hydrated.agentSessions,
        memory: hydrated.agentMemory,
        runs: hydrated.agentRuns,
      }
    },

    listCollaborationActivities(userId, projectId, limit = 100) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project || !canAccess(project, userId)) return undefined
      const receipt = state.collaborationActivityReceipts.find((item) => item.userId === userId && item.projectId === projectId)
      return collaborationActivitiesForMember(
        state.collaborationActivities.filter((item) => item.projectId === projectId).map((item) => item.payload),
        receipt?.payload,
        userId,
        limit,
      )
    },

    putCollaborationActivity(userId, projectId, input) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project) throw productError('未找到项目。', 'PROJECT_NOT_FOUND')
      assertProjectPermission(project.members.find((item) => item.userId === userId)?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const existing = state.collaborationActivities.find((item) => item.projectId === projectId && item.id === input?.id)
      if (existing) return clone(existing.payload)
      const actor = state.users.find((item) => item.id === userId)
      const activity = validateCollaborationActivity(input, { actorId: userId, actorName: actor?.name })
      state.collaborationActivities.push({ id: activity.id, projectId, occurredAt: activity.occurredAt, payload: activity })
      if (state.collaborationActivities.length > 20_000) state.collaborationActivities.splice(0, state.collaborationActivities.length - 20_000)
      save()
      return clone(activity)
    },

    putCollaborationActivityReceipt(userId, projectId, input) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project || !canAccess(project, userId)) throw productError('未找到项目。', 'PROJECT_NOT_FOUND')
      const existing = state.collaborationActivityReceipts.find((item) => item.userId === userId && item.projectId === projectId)
      const receipt = nextCollaborationReceipt(existing?.payload, input?.action)
      const record = { userId, projectId, updatedAt: receipt.updatedAt, payload: receipt }
      if (existing) Object.assign(existing, record)
      else state.collaborationActivityReceipts.push(record)
      save()
      return clone(receipt)
    },

    putAgentSessionReadReceipt(userId, projectId, sessionId, input) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project) throw productError('未找到项目。', 'PROJECT_NOT_FOUND')
      assertProjectPermission(project.members.find((item) => item.userId === userId)?.role, 'read', 'PROJECT_READ_FORBIDDEN')
      const session = state.agentSessions.find((item) => item.id === sessionId && item.projectId === projectId)
      if (!session) throw productError('未找到 Agent 会话。', 'AGENT_SESSION_NOT_FOUND')
      const serverTime = now()
      const timestampValue = input?.updatedAt === undefined
        ? serverTime
        : validateAgentEntityWriteTimestamp(input.updatedAt, { now: serverTime })
      const receipt = validateAgentSessionReadReceipt({ ...input, sessionId, updatedAt: timestampValue }, { now: serverTime })
      const message = state.agentMessages.find((item) => item.id === receipt.messageId && item.projectId === projectId && item.sessionId === sessionId)
      if (!message) throw productError('目标消息已不存在。', 'AGENT_MESSAGE_NOT_FOUND')
      const existing = state.agentSessionReadReceipts.find((item) => item.userId === userId && item.projectId === projectId && item.sessionId === sessionId)
      if (existing && existing.updatedAt >= receipt.updatedAt) return clone(existing.payload)
      const record = { userId, projectId, sessionId, updatedAt: receipt.updatedAt, payload: receipt }
      if (existing) Object.assign(existing, record)
      else state.agentSessionReadReceipts.push(record)
      save()
      return clone(receipt)
    },

    putAgentSession(userId, projectId, input) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project) throw productError('未找到项目。', 'PROJECT_NOT_FOUND')
      assertProjectPermission(project.members.find((item) => item.userId === userId)?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const timestamp = Number.isFinite(Number(input?.updatedAt)) ? Number(input.updatedAt) : now()
      const session = validateAgentSessionEntity({ ...input, updatedAt: timestamp }, { now: timestamp })
      const existing = state.agentSessions.find((item) => item.id === session.id)
      if (existing && existing.projectId !== projectId) throw productError('Agent 会话标识已被其他项目使用。', 'AGENT_SESSION_ID_CONFLICT')
      if (existing && existing.updatedAt >= session.updatedAt) return clone(existing.payload)
      const record = { id: session.id, projectId, ownerId: existing?.ownerId ?? userId, updatedAt: timestamp, payload: session }
      if (existing) Object.assign(existing, record)
      else state.agentSessions.push(record)
      audit({ actorId: userId, action: existing ? 'agent-session.updated' : 'agent-session.created', projectId, targetId: session.id })
      save()
      return clone(session)
    },

    putAgentMessage(userId, projectId, sessionId, input) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project) throw productError('未找到项目。', 'PROJECT_NOT_FOUND')
      assertProjectPermission(project.members.find((item) => item.userId === userId)?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const session = state.agentSessions.find((item) => item.id === sessionId && item.projectId === projectId)
      if (!session) throw productError('未找到 Agent 会话。', 'AGENT_SESSION_NOT_FOUND')
      const timestamp = Number.isFinite(Number(input?.updatedAt)) ? Number(input.updatedAt) : now()
      const message = validateAgentMessageEntity({ ...input, updatedAt: timestamp }, { now: timestamp })
      const existing = state.agentMessages.find((item) => item.id === message.id)
      if (existing && (existing.projectId !== projectId || existing.sessionId !== sessionId)) {
        throw productError('Agent 消息标识已被其他会话使用。', 'AGENT_MESSAGE_ID_CONFLICT')
      }
      if (existing && existing.updatedAt >= message.updatedAt) return clone(existing.payload)
      const record = { id: message.id, projectId, sessionId, ownerId: existing?.ownerId ?? userId, updatedAt: timestamp, payload: message }
      if (existing) Object.assign(existing, record)
      else state.agentMessages.push(record)
      session.updatedAt = Math.max(session.updatedAt, timestamp)
      session.payload.updatedAt = session.updatedAt
      upsertArtifactRecords(projectId, userId, artifactsFromAgentMessage(message, { sessionId, updatedAt: timestamp }))
      audit({ actorId: userId, action: existing ? 'agent-message.updated' : 'agent-message.created', projectId, targetId: message.id, detail: { sessionId } })
      save()
      return clone(message)
    },

    putAgentMemoryItem(userId, projectId, input) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project) throw productError('未找到项目。', 'PROJECT_NOT_FOUND')
      assertProjectPermission(project.members.find((item) => item.userId === userId)?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const serverTime = now()
      const requestedTimestamp = input?.updatedAt === undefined
        ? serverTime
        : validateAgentEntityWriteTimestamp(input.updatedAt, { now: serverTime })
      const memory = validateAgentMemoryEntity({ ...input, updatedAt: requestedTimestamp }, { now: serverTime })
      const timestamp = validateAgentEntityWriteTimestamp(memory.updatedAt, { now: serverTime })
      const existing = state.agentMemoryItems.find((item) => item.id === memory.id)
      if (existing && existing.projectId !== projectId) throw productError('Agent 记忆标识已被其他项目使用。', 'AGENT_MEMORY_ID_CONFLICT')
      if (existing?.deletedAt) throw productError('该 Agent 记忆已删除，请创建新的记忆。', 'AGENT_MEMORY_DELETED')
      if (existing && !shouldApplyAgentEntityWrite(existing, memory, { tombstoneWinsTie: true })) {
        return clone(existing.payload)
      }
      const record = { id: memory.id, projectId, ownerId: existing?.ownerId ?? userId, updatedAt: timestamp, deletedAt: undefined, payload: memory }
      if (existing) Object.assign(existing, record)
      else state.agentMemoryItems.push(record)
      audit({ actorId: userId, action: existing ? 'agent-memory.updated' : 'agent-memory.created', projectId, targetId: memory.id })
      save()
      return clone(memory)
    },

    deleteAgentMemoryItem(userId, projectId, memoryId) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project) throw productError('未找到项目。', 'PROJECT_NOT_FOUND')
      assertProjectPermission(project.members.find((item) => item.userId === userId)?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const existing = state.agentMemoryItems.find((item) => item.id === memoryId && item.projectId === projectId)
      if (!existing || existing.deletedAt) return false
      existing.deletedAt = now()
      existing.updatedAt = existing.deletedAt
      audit({ actorId: userId, action: 'agent-memory.deleted', projectId, targetId: memoryId })
      save()
      return true
    },

    listAgentArtifacts(userId, projectId, { limit = 100, before } = {}) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project || !canAccess(project, userId)) return undefined
      const maximum = Math.max(1, Math.min(Number(limit) || 100, artifactIndexLimits.page))
      const beforeTimestamp = Number.isFinite(Number(before?.createdAt)) ? Number(before.createdAt) : Number.POSITIVE_INFINITY
      const beforeId = typeof before?.id === 'string' ? before.id : undefined
      return state.agentArtifacts
        .filter((artifact) => artifact.projectId === projectId && (
          artifact.createdAt < beforeTimestamp
          || (beforeId !== undefined && artifact.createdAt === beforeTimestamp && artifact.id.localeCompare(beforeId) > 0)
        ))
        .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
        .slice(0, maximum)
        .map((artifact) => ({ ...clone(artifact.payload), createdAt: artifact.createdAt }))
    },

    putAgentSkill(userId, skill) {
      const project = state.projects.find((item) => item.id === skill.projectId)
      if (!project) throw productError('未找到项目。', 'PROJECT_NOT_FOUND')
      assertProjectPermission(project.members.find((item) => item.userId === userId)?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const timestamp = now()
      const existing = state.agentSkills.find((item) => item.id === skill.id)
      if (existing && existing.projectId !== skill.projectId) throw productError('Skill 标识已被其他项目使用。', 'AGENT_SKILL_ID_CONFLICT')
      const payload = {
        ...clone(skill),
        ownerId: userId,
        createdAt: Number(existing?.createdAt ?? skill.createdAt) || timestamp,
        updatedAt: timestamp,
      }
      if (existing) Object.assign(existing, payload)
      else state.agentSkills.push(payload)
      audit({ actorId: userId, action: existing ? 'agent-skill.updated' : 'agent-skill.created', projectId: skill.projectId, targetId: skill.id })
      save()
      return clone(payload)
    },

    listAgentSkills(userId, projectId) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project || !canAccess(project, userId)) return undefined
      return state.agentSkills
        .filter((skill) => skill.projectId === projectId && skill.status !== 'archived')
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .map(clone)
    },

    putAgentActionReceipt(userId, receipt) {
      const project = state.projects.find((item) => item.id === receipt.projectId)
      if (!project) throw productError('未找到项目。', 'PROJECT_NOT_FOUND')
      assertProjectPermission(project.members.find((item) => item.userId === userId)?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const existing = state.agentActionReceipts.find((item) => item.id === receipt.id)
      if (existing && (existing.ownerId !== userId || existing.projectId !== receipt.projectId)) {
        throw productError('Agent 行动回执冲突。', 'AGENT_ACTION_RECEIPT_CONFLICT')
      }
      const payload = { ...clone(receipt), ownerId: userId }
      if (existing) Object.assign(existing, payload)
      else state.agentActionReceipts.push(payload)
      upsertArtifactRecords(receipt.projectId, userId, artifactsFromActionReceipt(receipt))
      audit({ actorId: userId, action: 'agent-action.succeeded', projectId: receipt.projectId, targetId: receipt.id, detail: { toolCallId: receipt.toolCallId } })
      save()
      return clone(payload)
    },

    readAgentActionReceipt(userId, receiptId) {
      const receipt = state.agentActionReceipts.find((item) => item.id === receiptId && item.ownerId === userId)
      if (!receipt) return undefined
      const project = state.projects.find((item) => item.id === receipt.projectId)
      return project && canAccess(project, userId) ? clone(receipt) : undefined
    },

    putGenerationJob(userId, job) {
      const persistedJob = { ...clone(job), ownerId: userId, updatedAt: now() }
      const existing = state.generationJobs.find((item) => item.id === job.id)
      if (existing) Object.assign(existing, persistedJob)
      else state.generationJobs.push(persistedJob)
      if (persistedJob.agentRun?.runId) {
        const runIndex = state.agentRuns.findIndex((item) => item.id === persistedJob.agentRun.runId && item.ownerId === userId)
        if (runIndex >= 0) state.agentRuns[runIndex] = applyGenerationJobToAgentRun(state.agentRuns[runIndex], persistedJob)
      }
      const project = state.projects.find((item) => item.id === persistedJob.projectId)
      const graph = state.canvasGraphs.find((item) => item.projectId === persistedJob.projectId)?.graph
      if (project) upsertArtifactRecords(persistedJob.projectId, userId, artifactsFromGenerationJob(persistedJob, {
        document: { ...project.document, ...(graph ?? {}) },
      }))
      audit({ actorId: userId, action: `generation.${job.status}`, projectId: job.projectId, targetId: job.id, detail: { model: job.settings?.model, batchCount: job.batchCount } })
      save()
    },

    refreshGenerationArtifacts(userId, jobId) {
      const job = state.generationJobs.find((item) => item.id === jobId && item.ownerId === userId)
      if (!job) return false
      const project = state.projects.find((item) => item.id === job.projectId)
      if (!project || !canAccess(project, userId)) return false
      const graph = state.canvasGraphs.find((item) => item.projectId === job.projectId)?.graph
      upsertArtifactRecords(job.projectId, userId, artifactsFromGenerationJob(job, {
        document: { ...project.document, ...(graph ?? {}) },
      }))
      save()
      return true
    },

    putAgentRun(userId, run) {
      const project = state.projects.find((item) => item.id === run.projectId)
      if (!project) throw productError('未找到项目。', 'PROJECT_NOT_FOUND')
      assertProjectPermission(project.members.find((item) => item.userId === userId)?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const payload = { ...clone(run), ownerId: userId, updatedAt: Number(run.updatedAt) || now() }
      const existing = state.agentRuns.find((item) => item.id === run.id)
      if (existing && (existing.projectId !== run.projectId || existing.ownerId !== userId)) {
        throw productError('Agent Run 标识已被其他项目使用。', 'AGENT_RUN_ID_CONFLICT')
      }
      if (existing && !shouldApplyAgentRunWrite(existing, payload)) return clone(existing)
      if (existing) Object.assign(existing, payload)
      else state.agentRuns.push(payload)
      audit({ actorId: userId, action: `agent-run.${run.status}`, projectId: run.projectId, targetId: run.id })
      save()
      return clone(payload)
    },

    readAgentRun(userId, runId) {
      const run = state.agentRuns.find((item) => item.id === runId)
      if (!run || run.ownerId !== userId) return undefined
      const project = state.projects.find((item) => item.id === run.projectId)
      return project && canAccess(project, userId) ? clone(run) : undefined
    },

    readAgentRunForWorker(runId) {
      const run = state.agentRuns.find((item) => item.id === runId)
      return run ? clone(run) : undefined
    },

    listAgentRunsForProject(userId, projectId, limit = 30) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project || !canAccess(project, userId)) return undefined
      return state.agentRuns
        .filter((run) => run.ownerId === userId && run.projectId === projectId)
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, Math.max(1, Math.min(limit, 60)))
        .map(clone)
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
        if (job.status === 'queued' || job.projectWritebackPending) recovered.push(clone(job))
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
