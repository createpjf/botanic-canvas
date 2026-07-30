import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

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

function initialState() {
  return {
    schemaVersion,
    users: [],
    accessTokens: [],
    projects: [],
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
    return state.users.find((item) => item.id === token.userId)
  }

  function canAccess(project, userId, allowedRoles = ['owner', 'editor', 'viewer']) {
    const member = project.members.find((item) => item.userId === userId)
    return member && allowedRoles.includes(member.role) ? member : undefined
  }

  function publicProject(project) {
    return {
      id: project.id,
      name: project.name,
      updatedAt: project.updatedAt,
      revision: project.revision,
      role: project.members.find((item) => item.userId === project.lastAccessedBy)?.role,
    }
  }

  return {
    authenticate(accessToken) {
      const user = authenticatedUser(accessToken)
      return user ? { id: user.id, email: user.email, name: user.name, role: user.role } : undefined
    },

    createUser(actorId, { email, name, role = 'member', accessToken }) {
      const actor = state.users.find((item) => item.id === actorId)
      if (!actor || actor.role !== 'owner') throw new Error('只有工作区所有者可以创建成员。')
      if (!email || !accessToken) throw new Error('成员邮箱与访问令牌不能为空。')
      if (state.users.some((item) => item.email.toLowerCase() === email.toLowerCase())) throw new Error('该成员已存在。')
      const user = { id: `usr_${randomUUID()}`, email, name: name || email, role, createdAt: now() }
      state.users.push(user)
      state.accessTokens.push({ id: `token_${randomUUID()}`, userId: user.id, tokenHash: hashAccessToken(accessToken), createdAt: now() })
      audit({ actorId, action: 'member.created', targetId: user.id, detail: { email: user.email, role } })
      save()
      return { id: user.id, email: user.email, name: user.name, role: user.role }
    },

    listProjects(userId) {
      return state.projects
        .filter((project) => canAccess(project, userId))
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .map((project) => ({
          id: project.id,
          name: project.name,
          updatedAt: project.updatedAt,
          revision: project.revision,
          role: canAccess(project, userId)?.role,
        }))
    },

    readProject(userId, projectId) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project || !canAccess(project, userId)) return undefined
      project.lastAccessedBy = userId
      return { document: clone(project.document), revision: project.revision }
    },

    canEditProject(userId, projectId) {
      const project = state.projects.find((item) => item.id === projectId)
      return Boolean(project && canAccess(project, userId, ['owner', 'editor']))
    },

    writeProject(userId, document, expectedRevision) {
      const existing = state.projects.find((item) => item.id === document.id)
      if (existing) {
        const member = canAccess(existing, userId, ['owner', 'editor'])
        if (!member) throw new Error('你没有编辑该项目的权限。')
        if (Number.isInteger(expectedRevision) && expectedRevision !== existing.revision) {
          const conflict = new Error('项目已被其他成员更新，请刷新后再保存。')
          conflict.code = 'PROJECT_CONFLICT'
          throw conflict
        }
        existing.document = clone(document)
        existing.name = document.name
        existing.updatedAt = now()
        existing.revision += 1
        audit({ actorId: userId, action: 'project.updated', projectId: existing.id, detail: { revision: existing.revision } })
        save()
        return { document: clone(existing.document), revision: existing.revision, created: false }
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
      audit({ actorId: userId, action: 'project.created', projectId: project.id })
      save()
      return { document: clone(project.document), revision: project.revision, created: true }
    },

    deleteProject(userId, projectId) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project) return false
      if (!canAccess(project, userId, ['owner'])) throw new Error('只有项目所有者可以删除项目。')
      state.projects = state.projects.filter((item) => item.id !== projectId)
      state.generationJobs = state.generationJobs.filter((item) => item.projectId !== projectId)
      audit({ actorId: userId, action: 'project.deleted', targetId: projectId, detail: { name: project.name } })
      save()
      return true
    },

    addProjectMember(actorId, projectId, userId, role) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project || !canAccess(project, actorId, ['owner'])) throw new Error('只有项目所有者可以管理成员。')
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

    readGlobalAssetLibrary(userId, id) {
      // 访问过任何项目的成员均可读取工作区品牌素材库。
      if (!state.projects.some((project) => canAccess(project, userId))) return undefined
      const library = state.globalAssetLibraries.find((item) => item.id === id)
      return library ? clone(library.library) : undefined
    },

    writeGlobalAssetLibrary(userId, library) {
      const hasWorkspaceAccess = state.projects.some((project) => canAccess(project, userId, ['owner', 'editor']))
      if (!hasWorkspaceAccess && state.projects.length) throw new Error('你没有编辑品牌素材库的权限。')
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
      const canEdit = state.projects.some((project) => canAccess(project, userId, ['owner', 'editor']))
      if (!canEdit) throw new Error('你没有编辑品牌素材库的权限。')
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

    listAuditEvents(userId, projectId, limit = 100) {
      const project = projectId ? state.projects.find((item) => item.id === projectId) : undefined
      if (projectId && (!project || !canAccess(project, userId))) return undefined
      return state.auditEvents
        .filter((event) => !projectId || event.projectId === projectId)
        .slice(-Math.max(1, Math.min(limit, 500)))
        .reverse()
        .map(clone)
    },
  }
}

function loadState(path) {
  if (!existsSync(path)) return initialState()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || parsed.schemaVersion !== schemaVersion) throw new Error('schema mismatch')
    return { ...initialState(), ...parsed }
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
    owner = { id: `usr_${randomUUID()}`, email, name: 'Botanic Owner', role: 'owner', createdAt: now() }
    state.users.push(owner)
  }
  state.accessTokens.push({ id: `token_${randomUUID()}`, userId: owner.id, tokenHash, createdAt: now() })
}
