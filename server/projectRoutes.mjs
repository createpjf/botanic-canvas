import { applyCanvasDocumentPatch } from './canvas/canvasDocumentPatch.mjs'
import { requireProjectPermission } from './projectAuthorization.mjs'
import { projectCapabilities } from './authorization.mjs'
import { collaborationChangeFromDocuments, decodeCollaborationActivityCursor, encodeCollaborationActivityCursor } from './collaborationActivityPersistence.mjs'
import { filterAuditEvents } from './agent/action/agentActionGovernance.mjs'
import { canvasMutationConflictCode, canvasSyncEpochStaleCode } from './store/productStoreContract.mjs'

const projectWritePermissionCodes = new Set(['PROJECT_ACCESS_FORBIDDEN', 'PROJECT_WRITE_FORBIDDEN'])

/**
 * 项目、项目文档、成员与项目审计的 HTTP 模块。
 * 项目版本与图谱版本在这里共同校验，避免组合根重复实现冲突语义。
 */
export function createProjectRouteHandler({
  config,
  productStore,
  mediaService,
  json,
  error,
  readJson,
  text,
  enumValue,
  requireUser,
  requireSensitiveSession,
  enforceRateLimit,
  publishProjectUpdated,
  commitCanvasUpdate,
  expectedGraphRevision,
  projectResponseHeaders,
}) {
  return async function handleProjectRoute(request, response, url, routeMatches) {
    const {
      document: documentMatch,
      projectCanvasSync: canvasSyncMatch,
      project: projectMatch,
      projectMembers: memberMatch,
      projectAudit: auditMatch,
      projectCollaborationActivities: collaborationActivitiesMatch,
      projectCollaborationReceipt: collaborationReceiptMatch,
    } = routeMatches

    if (url.pathname === '/api/projects') {
      if (request.method === 'GET') {
        const user = await requireUser(request)
        return json(response, 200, { projects: await productStore.listProjects(user.id) })
      }
      if (request.method === 'POST') {
        const user = await requireUser(request)
        const body = await readJson(request)
        const document = body?.document
        if (!document || typeof document.id !== 'string' || typeof document.name !== 'string') {
          return error(response, 400, 'INVALID_DOCUMENT', '新建项目格式无效。')
        }
        try {
          await requireProjectPermission(productStore, user.id, document.id, 'edit', { allowMissing: true })
          const normalized = await mediaService.normalizeDocument(document, { ownerId: user.id, projectId: document.id })
          const saved = await productStore.writeProject(user.id, normalized)
          await publishProjectUpdated(saved, user.id)
          return json(response, saved.created ? 201 : 200, saved, projectResponseHeaders(saved))
        } catch (caught) {
          if (caught?.code === 'MEDIA_VALIDATION_FAILED') return error(response, 400, caught.code, caught.message)
          if (caught?.code === 'PROJECT_CONFLICT' || caught?.code === 'CANVAS_GRAPH_CONFLICT' || caught?.code === canvasSyncEpochStaleCode) return error(response, 409, caught.code, caught.message)
          if (projectWritePermissionCodes.has(caught?.code)) return error(response, 403, 'PROJECT_CREATE_FORBIDDEN', caught instanceof Error ? caught.message : '无法新建项目。')
          throw caught
        }
      }
      return json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '项目集合接口不支持该请求方法。' } }, {
        Allow: 'GET, POST',
      })
    }

    if (canvasSyncMatch) {
      if (request.method !== 'POST') {
        return json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Canvas Sync 资源只接受提交请求。' } }, { Allow: 'POST' })
      }
      const user = await requireUser(request)
      const projectId = decodeURIComponent(canvasSyncMatch[1])
      await requireProjectPermission(productStore, user.id, projectId, 'edit')
      const body = await readJson(request, 720_000, 'Canvas Sync 请求过大。')
      if (body?.type !== 'canvas.crdt.update'
        || body.projectId !== projectId
        || typeof body.mutationId !== 'string'
        || !/^[A-Za-z0-9._:-]{1,200}$/.test(body.mutationId)
        || typeof body.update !== 'string'
        || !body.update
        || body.update.length > 700_000
        || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.update)
        || (body.syncProtocolEpoch !== undefined
          && (!Number.isInteger(body.syncProtocolEpoch) || body.syncProtocolEpoch < 1))) {
        return error(response, 400, 'INVALID_CANVAS_SYNC_UPDATE', 'Canvas Sync 增量格式无效。')
      }
      try {
        const committed = await commitCanvasUpdate({
          projectId,
          userId: user.id,
          actorName: user.name,
          mutationId: body.mutationId,
          update: body.update,
          syncProtocolEpoch: body.syncProtocolEpoch,
        })
        return json(response, 200, committed)
      } catch (caught) {
        if (caught?.code === canvasSyncEpochStaleCode) return error(response, 409, caught.code, caught.message)
        if (caught?.code === canvasMutationConflictCode) return error(response, 409, caught.code, caught.message)
        if (caught?.code === 'INVALID_CANVAS_SYNC_UPDATE') return error(response, 400, caught.code, caught.message)
        throw caught
      }
    }

    if (projectMatch && request.method === 'PATCH') {
      const user = await requireUser(request)
      const projectId = decodeURIComponent(projectMatch[1])
      await requireProjectPermission(productStore, user.id, projectId, 'edit')
      const body = await readJson(request)
      const name = text(body?.name, '项目名称', 60)
      const current = await productStore.readProject(user.id, projectId)
      if (!current) return error(response, 404, 'PROJECT_NOT_FOUND', '未找到项目或你没有访问权限。')
      const expected = request.headers['if-match']?.replaceAll('"', '')
      const expectedRevision = expected && /^\d+$/.test(expected) ? Number(expected) : current.revision
      try {
        const saved = await productStore.writeProject(user.id, {
          ...current.document,
          name,
          updatedAt: Date.now(),
        }, expectedRevision, current.graphRevision)
        const change = collaborationChangeFromDocuments(current.document, saved.document)
        if (change) {
          try {
            await productStore.putCollaborationActivity(user.id, projectId, { id: `project-${user.id}-${saved.revision}`, ...change })
          } catch {
            // 协作历史是派生读模型；写入失败不能把已成功的项目写入伪装成失败。
          }
        }
        await publishProjectUpdated(saved, user.id)
        return json(response, 200, saved, projectResponseHeaders(saved))
      } catch (caught) {
        if (caught?.code === 'PROJECT_CONFLICT' || caught?.code === 'CANVAS_GRAPH_CONFLICT' || caught?.code === canvasSyncEpochStaleCode) return error(response, 409, caught.code, caught.message)
        if (projectWritePermissionCodes.has(caught?.code)) return error(response, 403, 'PROJECT_RENAME_FORBIDDEN', caught instanceof Error ? caught.message : '无法重命名项目。')
        throw caught
      }
    }

    if (projectMatch && request.method === 'DELETE') {
      const user = await requireUser(request)
      await requireSensitiveSession(request)
      const projectId = decodeURIComponent(projectMatch[1])
      await requireProjectPermission(productStore, user.id, projectId, 'delete-project')
      try {
        const deleted = await productStore.deleteProject(user.id, projectId)
        if (!deleted) return error(response, 404, 'PROJECT_NOT_FOUND', '未找到项目或你没有删除权限。')
        return json(response, 204)
      } catch (caught) {
        if (caught?.code === 'PROJECT_DELETE_FORBIDDEN') return error(response, 403, 'PROJECT_DELETE_FORBIDDEN', caught instanceof Error ? caught.message : '没有删除项目的权限。')
        throw caught
      }
    }

    if (documentMatch && request.method === 'GET') {
      const user = await requireUser(request)
      const projectId = decodeURIComponent(documentMatch[1])
      // 随读模型下发**调用者在本项目的能力集合**（Epic 10）。此前客户端只知道工作区
      // 角色（owner/member），不知道自己在某个项目里是不是 viewer，因此无法隐藏
      // 点不动的入口。给能力而不是角色：界面拿角色再映射一遍就成了第二份权威。
      //
      // 权限守卫已经查过一次成员表并返回 access，直接复用，不再重复查询。
      const access = await requireProjectPermission(productStore, user.id, projectId, 'read')
      const project = await productStore.readProject(user.id, projectId)
      if (!project) return error(response, 404, 'PROJECT_NOT_FOUND', '未找到项目或你没有访问权限。')
      return json(response, 200, {
        ...project,
        capabilities: projectCapabilities(access?.role),
      }, projectResponseHeaders(project))
    }

    if (documentMatch && request.method === 'PUT') {
      const user = await requireUser(request)
      const projectId = decodeURIComponent(documentMatch[1])
      await requireProjectPermission(productStore, user.id, projectId, 'edit', { allowMissing: true })
      const document = await readJson(request)
      if (!document || document.id !== projectId || typeof document.name !== 'string') return error(response, 400, 'INVALID_DOCUMENT', '项目文档格式无效。')
      const expected = request.headers['if-match']?.replaceAll('"', '')
      const expectedRevision = expected && /^\d+$/.test(expected) ? Number(expected) : undefined
      const graphRevision = expectedGraphRevision(request, undefined)
      try {
        const current = await productStore.readProject(user.id, projectId)
        // 已存在项目的生产工作流由专用 API 拥有；兼容 PUT 客户端也不能用旧整文档覆盖。
        const protectedDocument = current ? {
          ...document,
          productionWorkflows: current.document.productionWorkflows ?? [],
          productionWorkflowRuns: current.document.productionWorkflowRuns ?? [],
        } : document
        const normalized = await mediaService.normalizeDocument(protectedDocument, { ownerId: user.id, projectId })
        const saved = await productStore.writeProject(user.id, normalized, expectedRevision, graphRevision)
        const change = current ? collaborationChangeFromDocuments(current.document, saved.document) : undefined
        if (change) {
          try {
            await productStore.putCollaborationActivity(user.id, projectId, { id: `project-${user.id}-${saved.revision}`, ...change })
          } catch {
            // 协作历史是派生读模型；权威项目文档仍以本次成功写入为准。
          }
        }
        await publishProjectUpdated(saved, user.id)
        return json(response, saved.created ? 201 : 200, saved, projectResponseHeaders(saved))
      } catch (caught) {
        if (caught?.code === 'MEDIA_VALIDATION_FAILED') return error(response, 400, caught.code, caught.message)
        if (caught?.code === 'PROJECT_CONFLICT' || caught?.code === 'CANVAS_GRAPH_CONFLICT' || caught?.code === canvasSyncEpochStaleCode) return error(response, 409, caught.code, caught.message)
        if (projectWritePermissionCodes.has(caught?.code)) {
          return error(response, 403, 'PROJECT_WRITE_FORBIDDEN', caught instanceof Error ? caught.message : '没有编辑项目的权限。')
        }
        throw caught
      }
    }

    if (documentMatch && request.method === 'PATCH') {
      const user = await requireUser(request)
      const projectId = decodeURIComponent(documentMatch[1])
      await requireProjectPermission(productStore, user.id, projectId, 'edit')
      const expected = request.headers['if-match']?.replaceAll('"', '')
      const expectedRevision = expected && /^\d+$/.test(expected) ? Number(expected) : undefined
      const graphRevision = expectedGraphRevision(request, undefined)
      try {
        const current = await productStore.readProject(user.id, projectId)
        if (!current) return error(response, 404, 'PROJECT_NOT_FOUND', '未找到项目或你没有访问权限。')
        const patch = await readJson(request)
        const document = applyCanvasDocumentPatch(current.document, patch)
        const normalized = await mediaService.normalizeDocument(document, { ownerId: user.id, projectId })
        const saved = await productStore.writeProject(user.id, normalized, expectedRevision, graphRevision)
        const change = collaborationChangeFromDocuments(current.document, saved.document)
        if (change) {
          try {
            await productStore.putCollaborationActivity(user.id, projectId, { id: `project-${user.id}-${saved.revision}`, ...change })
          } catch {
            // 协作历史是派生读模型；权威项目文档仍以本次成功写入为准。
          }
        }
        await publishProjectUpdated(saved, user.id)
        return json(response, 200, saved, projectResponseHeaders(saved))
      } catch (caught) {
        if (caught?.code === 'MEDIA_VALIDATION_FAILED') return error(response, 400, caught.code, caught.message)
        if (caught?.code === 'PROJECT_CONFLICT' || caught?.code === 'CANVAS_GRAPH_CONFLICT' || caught?.code === canvasSyncEpochStaleCode) return error(response, 409, caught.code, caught.message)
        if (caught instanceof TypeError) return error(response, 400, 'INVALID_DOCUMENT_PATCH', caught.message)
        if (projectWritePermissionCodes.has(caught?.code)) {
          return error(response, 403, 'PROJECT_WRITE_FORBIDDEN', caught instanceof Error ? caught.message : '没有编辑项目的权限。')
        }
        throw caught
      }
    }

    if (memberMatch && request.method === 'POST') {
      const user = await requireUser(request)
      await requireSensitiveSession(request)
      const projectId = decodeURIComponent(memberMatch[1])
      await requireProjectPermission(productStore, user.id, projectId, 'manage-members')
      if (!await enforceRateLimit(response, {
        scope: 'member-mutation', subject: user.id,
        limit: config.security.memberMutationsPerHour, windowMs: 60 * 60_000,
      })) return true
      const body = await readJson(request)
      try {
        await productStore.addProjectMember(user.id, projectId, text(body?.userId, '成员', 160), enumValue(body?.role, ['owner', 'editor', 'viewer'], '成员角色'))
        return json(response, 204)
      } catch (caught) {
        if (caught?.code === 'PROJECT_MEMBER_FORBIDDEN') return error(response, 403, 'PROJECT_MEMBER_FORBIDDEN', caught instanceof Error ? caught.message : '成员权限更新失败。')
        throw caught
      }
    }

    if (auditMatch && request.method === 'GET') {
      const user = await requireUser(request)
      const projectId = decodeURIComponent(auditMatch[1])
      await requireProjectPermission(productStore, user.id, projectId, 'read-audit')
      const events = await productStore.listAuditEvents(user.id, projectId, Number(url.searchParams.get('limit') ?? 100))
      if (!events) return error(response, 404, 'PROJECT_NOT_FOUND', '未找到项目或你没有访问权限。')
      return json(response, 200, { events: filterAuditEvents(events, {
        action: url.searchParams.get('action') || undefined,
        actorId: url.searchParams.get('actorId') || undefined,
        result: url.searchParams.get('result') || undefined,
      }) })
    }

    if (collaborationActivitiesMatch && request.method === 'GET') {
      const user = await requireUser(request)
      const projectId = decodeURIComponent(collaborationActivitiesMatch[1])
      await requireProjectPermission(productStore, user.id, projectId, 'read')
      const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 30, 100))
      let before
      try { before = decodeCollaborationActivityCursor(url.searchParams.get('before') ?? undefined) } catch {
        return error(response, 400, 'INVALID_COLLABORATION_CURSOR', '协作动态分页游标无效。')
      }
      const page = await productStore.listCollaborationActivities(user.id, projectId, { limit: limit + 1, before })
      const activities = page?.slice(0, limit)
      if (!activities) return error(response, 404, 'PROJECT_NOT_FOUND', '未找到项目或你没有访问权限。')
      return json(response, 200, {
        activities,
        nextBefore: page.length > limit ? encodeCollaborationActivityCursor(activities.at(-1)) : undefined,
      })
    }

    if (collaborationReceiptMatch && request.method === 'PATCH') {
      const user = await requireUser(request)
      const projectId = decodeURIComponent(collaborationReceiptMatch[1])
      await requireProjectPermission(productStore, user.id, projectId, 'read')
      const body = await readJson(request)
      const action = enumValue(body?.action, ['read', 'clear'], '协作回执操作')
      return json(response, 200, { receipt: await productStore.putCollaborationActivityReceipt(user.id, projectId, { action }) })
    }

    return false
  }
}
