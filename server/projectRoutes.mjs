import { applyCanvasDocumentPatch } from './canvasDocumentPatch.mjs'
import { requireProjectPermission } from './projectAuthorization.mjs'

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
  expectedGraphRevision,
  projectResponseHeaders,
}) {
  return async function handleProjectRoute(request, response, url, routeMatches) {
    const {
      document: documentMatch,
      project: projectMatch,
      projectMembers: memberMatch,
      projectAudit: auditMatch,
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
          if (caught?.code === 'PROJECT_CONFLICT' || caught?.code === 'CANVAS_GRAPH_CONFLICT') return error(response, 409, caught.code, caught.message)
          return error(response, 403, 'PROJECT_CREATE_FORBIDDEN', caught instanceof Error ? caught.message : '无法新建项目。')
        }
      }
      return json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '项目集合接口不支持该请求方法。' } }, {
        Allow: 'GET, POST',
      })
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
        await publishProjectUpdated(saved, user.id)
        return json(response, 200, saved, projectResponseHeaders(saved))
      } catch (caught) {
        if (caught?.code === 'PROJECT_CONFLICT' || caught?.code === 'CANVAS_GRAPH_CONFLICT') return error(response, 409, caught.code, caught.message)
        return error(response, 403, 'PROJECT_RENAME_FORBIDDEN', caught instanceof Error ? caught.message : '无法重命名项目。')
      }
    }

    if (projectMatch && request.method === 'DELETE') {
      const user = await requireUser(request)
      await requireSensitiveSession(request)
      const projectId = decodeURIComponent(projectMatch[1])
      await requireProjectPermission(productStore, user.id, projectId, 'delete')
      try {
        const deleted = await productStore.deleteProject(user.id, projectId)
        if (!deleted) return error(response, 404, 'PROJECT_NOT_FOUND', '未找到项目或你没有删除权限。')
        return json(response, 204)
      } catch (caught) {
        return error(response, 403, 'PROJECT_DELETE_FORBIDDEN', caught instanceof Error ? caught.message : '没有删除项目的权限。')
      }
    }

    if (documentMatch && request.method === 'GET') {
      const user = await requireUser(request)
      const projectId = decodeURIComponent(documentMatch[1])
      await requireProjectPermission(productStore, user.id, projectId, 'read')
      const project = await productStore.readProject(user.id, projectId)
      if (!project) return error(response, 404, 'PROJECT_NOT_FOUND', '未找到项目或你没有访问权限。')
      return json(response, 200, project, projectResponseHeaders(project))
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
        const normalized = await mediaService.normalizeDocument(document, { ownerId: user.id, projectId })
        const saved = await productStore.writeProject(user.id, normalized, expectedRevision, graphRevision)
        await publishProjectUpdated(saved, user.id)
        return json(response, saved.created ? 201 : 200, saved, projectResponseHeaders(saved))
      } catch (caught) {
        if (caught?.code === 'MEDIA_VALIDATION_FAILED') return error(response, 400, caught.code, caught.message)
        if (caught?.code === 'PROJECT_CONFLICT' || caught?.code === 'CANVAS_GRAPH_CONFLICT') return error(response, 409, caught.code, caught.message)
        return error(response, 403, 'PROJECT_WRITE_FORBIDDEN', caught instanceof Error ? caught.message : '没有编辑项目的权限。')
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
        await publishProjectUpdated(saved, user.id)
        return json(response, 200, saved, projectResponseHeaders(saved))
      } catch (caught) {
        if (caught?.code === 'MEDIA_VALIDATION_FAILED') return error(response, 400, caught.code, caught.message)
        if (caught?.code === 'PROJECT_CONFLICT' || caught?.code === 'CANVAS_GRAPH_CONFLICT') return error(response, 409, caught.code, caught.message)
        if (caught instanceof TypeError) return error(response, 400, 'INVALID_DOCUMENT_PATCH', caught.message)
        return error(response, 403, 'PROJECT_WRITE_FORBIDDEN', caught instanceof Error ? caught.message : '没有编辑项目的权限。')
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
        return error(response, 403, 'PROJECT_MEMBER_FORBIDDEN', caught instanceof Error ? caught.message : '成员权限更新失败。')
      }
    }

    if (auditMatch && request.method === 'GET') {
      const user = await requireUser(request)
      const projectId = decodeURIComponent(auditMatch[1])
      await requireProjectPermission(productStore, user.id, projectId, 'read-audit')
      const events = await productStore.listAuditEvents(user.id, projectId, Number(url.searchParams.get('limit') ?? 100))
      if (!events) return error(response, 404, 'PROJECT_NOT_FOUND', '未找到项目或你没有访问权限。')
      return json(response, 200, { events })
    }

    return false
  }
}
