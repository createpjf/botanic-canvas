import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { createGenerationProcessor } from './generationProcessor.mjs'
import { createGenerationQueue } from './generationQueue.mjs'
import { GenerationError, persistedGenerationJob, publicGenerationJob, validateGenerationInput } from './generationProvider.mjs'
import { reconcileGenerationResults } from './generationResultReconciliation.mjs'
import { PromptRefinementError, refinePrompt, validatePromptRefinementInput } from './promptRefinementProvider.mjs'
import { applyCanvasDocumentPatch } from './canvasDocumentPatch.mjs'
import { generationIdempotencyKey, generationJobIdForIdempotency } from './generationIdempotency.mjs'
import { createProductRuntime, loadLocalEnv, runtimeConfig } from './runtime.mjs'
import { generationTimeoutForModel, providerForModel } from './generationModels.mjs'
import { createProjectRealtimeHub } from './realtimeHub.mjs'
import { publishProjectUpdatedSafely } from './projectUpdatePublisher.mjs'
import { issueRealtimeTicket } from './realtimeTicket.mjs'
import { clientAddress, createSecurityControls, securityResponseHeaders, sensitiveActionDecision } from './securityControls.mjs'
import { accessTokenFromRequest } from './requestAuth.mjs'
import { ProjectAuthorizationError, requireProjectPermission } from './projectAuthorization.mjs'

loadLocalEnv()
const config = runtimeConfig()
const runtime = await createProductRuntime(config)
const { productStore, mediaService } = runtime
const redisQueue = createGenerationQueue(config.redisUrl)
const securityControls = createSecurityControls({
  redisUrl: config.redisUrl,
  onFallback: (caught) => console.error(`[security] Redis limiter fallback: ${caught instanceof Error ? caught.message : String(caught)}`),
})
const localProcessor = !redisQueue && !config.production
  ? createGenerationProcessor({ productStore, mediaService, config })
  : undefined
const accountSecurityAuditActions = new Set([
  'security.password.changed',
  'security.mfa.enabled',
  'security.mfa.disabled',
  'security.sessions.revoked',
])

if (config.production && !redisQueue) throw new Error('生产环境必须配置 REDIS_URL；内存任务队列只用于本地原型。')
if (!config.realtimeTicketSecret) throw new Error('实时服务必须配置 REALTIME_TICKET_SECRET。')

class HttpError extends Error {
  constructor(statusCode, code, message) {
    super(message)
    this.statusCode = statusCode
    this.code = code
  }
}

function json(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  })
  response.end(statusCode === 204 ? undefined : JSON.stringify(body))
}

function error(response, statusCode, code, message) {
  json(response, statusCode, { error: { code, message } })
}

async function enforceRateLimit(response, input) {
  const result = await securityControls.consume(input)
  if (result.allowed) return true
  console.warn(JSON.stringify({ event: 'security.rate_limited', scope: input.scope, retryAfterSeconds: result.retryAfterSeconds }))
  json(response, 429, { error: { code: 'RATE_LIMITED', message: '操作过于频繁，请稍后重试。' } }, {
    'Retry-After': String(result.retryAfterSeconds),
  })
  return false
}

async function requireUser(request, options) {
  const user = await productStore.authenticate(accessTokenFromRequest(request, {
    allowMediaCookie: runtime.authProvider !== 'supabase' || options?.allowMediaCookie,
  }))
  if (!user) throw new HttpError(401, 'AUTH_REQUIRED', '请先登录 Botanic 工作区。')
  return user
}

async function requireSensitiveSession(request) {
  if (!config.security.requireOwnerMfa || runtime.authProvider !== 'supabase') return
  const assurance = await productStore.authAssurance?.(accessTokenFromRequest(request))
  if (sensitiveActionDecision({
    required: config.security.requireOwnerMfa,
    authProvider: runtime.authProvider,
    role: 'owner',
    aal: assurance?.aal,
  }) === 'mfa-required') {
    console.warn(JSON.stringify({ event: 'security.mfa_required', authProvider: runtime.authProvider }))
    throw new HttpError(403, 'MFA_REQUIRED', '此操作需要二步验证，请先在账户安全中完成验证。')
  }
}

function sessionCookie(token, request, maxAge) {
  const secure = request.headers['x-forwarded-proto']?.split(',')[0]?.trim() === 'https'
  return [
    `botanic_session=${encodeURIComponent(token)}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax', secure ? 'Secure' : '',
    `Max-Age=${maxAge}`,
  ].filter(Boolean).join('; ')
}

async function readJson(request, maximumBytes = config.maximumRequestBytes, tooLargeMessage = '本次素材过大，请减少图片数量或压缩后重试。') {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maximumBytes) throw new HttpError(413, 'REQUEST_TOO_LARGE', tooLargeMessage)
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'INVALID_JSON', '请求 JSON 格式无效。')
  }
}

function text(value, name, maximumLength = 6000) {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, 'INVALID_REQUEST', `${name}不能为空。`)
  if (value.length > maximumLength) throw new HttpError(400, 'INVALID_REQUEST', `${name}过长。`)
  return value.trim()
}

function enumValue(value, allowed, name) {
  if (!allowed.includes(value)) throw new HttpError(400, 'INVALID_REQUEST', `${name}不支持。`)
  return value
}

async function enqueue(jobId) {
  if (redisQueue) return redisQueue.enqueue(jobId)
  if (!localProcessor) throw new HttpError(503, 'QUEUE_NOT_CONFIGURED', '生成队列尚未配置：生产环境请设置 REDIS_URL。')
  queueMicrotask(() => void localProcessor(jobId))
}

async function streamMedia(response, media) {
  response.writeHead(200, {
    'Content-Type': media.contentType ?? 'application/octet-stream',
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  })
  // Supabase Storage download() returns a Buffer. Readable.fromWeb() only
  // accepts a Web ReadableStream and would crash the whole API process here.
  if (Buffer.isBuffer(media.body) || media.body instanceof Uint8Array) {
    response.end(media.body)
    return
  }
  if (typeof media.body.pipe === 'function') return media.body.pipe(response)
  if (typeof media.body?.getReader === 'function') return Readable.fromWeb(media.body).pipe(response)
  throw new Error('不支持的媒体流类型。')
}

try {
  for (const queued of await productStore.recoverGenerationJobs()) {
    await enqueue(queued.id)
  }
} catch (caught) {
  // 队列恢复不是 API 启动前置条件；数据库短暂波动不能让登录、项目与媒体服务整体不可用。
  console.error(`[generation] queue recovery deferred: ${caught instanceof Error ? caught.message : String(caught)}`)
}

let realtimeHub
async function publishProjectUpdated(saved, actorId) {
  await publishProjectUpdatedSafely(realtimeHub, saved, actorId)
}

function expectedGraphRevision(request, fallback) {
  const header = Array.isArray(request.headers['x-canvas-graph-revision'])
    ? request.headers['x-canvas-graph-revision'][0]
    : request.headers['x-canvas-graph-revision']
  return typeof header === 'string' && /^\d+$/.test(header) ? Number(header) : fallback
}

function projectResponseHeaders(saved) {
  return {
    ETag: `"${saved.revision}"`,
    'X-Canvas-Graph-Revision': String(saved.graphRevision ?? 1),
  }
}

const server = createServer(async (request, response) => {
  const requestId = randomUUID()
  response.setHeader('X-Request-ID', requestId)
  const forwardedProtocol = request.headers['x-forwarded-proto']?.split(',')[0]?.trim()
  for (const [name, value] of Object.entries(securityResponseHeaders({ secure: forwardedProtocol === 'https' || Boolean(request.socket.encrypted) }))) {
    response.setHeader(name, value)
  }
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    const documentMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/document$/)
    const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/)
    const memberMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/members$/)
    const auditMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/audit$/)
    const projectGenerationJobsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/generation-jobs$/)
    const projectGenerationReconcileMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/reconcile-generation-results$/)
    const assetMatch = url.pathname.match(/^\/api\/global-assets\/([^/]+)$/)
    const jobMatch = url.pathname.match(/^\/api\/generation-jobs\/([^/]+)(?:\/(cancel))?$/)
    const mediaMatch = url.pathname.match(/^\/api\/media\/([^/]+)$/)
    const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/)

    if (url.pathname !== '/api/health' && url.pathname.startsWith('/api/') && !await enforceRateLimit(response, {
      scope: 'api',
      subject: clientAddress(request),
      limit: config.security.apiRequestsPerMinute,
      windowMs: 60_000,
    })) return

    if (request.method === 'GET' && url.pathname === '/api/health') {
      return json(response, 200, {
        status: 'ok', provider: 'multi-provider', configured: Boolean(config.modelOptions?.length),
        maxBatchCount: config.maximumBatchCount, models: config.models, modelOptions: config.modelOptions,
        persistence: runtime.persistence, auth: runtime.authProvider, queue: redisQueue ? 'redis' : 'local-prototype', media: mediaService.enabled ? 'storage' : 'inline-prototype',
        promptRefinement: {
          provider: 'flock-api',
          configured: Boolean(config.flockApiBaseUrl && config.flockApiKey && config.flockTextModel),
          model: config.flockTextModel || undefined,
        },
      })
    }

    if (request.method === 'POST' && url.pathname === '/api/realtime/ticket') {
      const user = await requireUser(request)
      if (!await enforceRateLimit(response, {
        scope: 'realtime-ticket', subject: user.id,
        limit: config.security.realtimeTicketsPerMinute, windowMs: 60_000,
      })) return
      const body = await readJson(request, 16 * 1024, '实时订阅请求过大。')
      const projectId = text(body?.projectId, '项目', 160)
      await requireProjectPermission(productStore, user.id, projectId, 'read')
      const requestOrigin = Array.isArray(request.headers.origin) ? request.headers.origin[0] : request.headers.origin
      let parsedOrigin
      try { parsedOrigin = requestOrigin ? new URL(requestOrigin) : undefined } catch { parsedOrigin = undefined }
      if (!parsedOrigin || !['http:', 'https:'].includes(parsedOrigin.protocol)) {
        throw new HttpError(403, 'REALTIME_ORIGIN_REQUIRED', '实时连接必须来自受信任的网页来源。')
      }
      const forwardedProtocol = request.headers['x-forwarded-proto']?.split(',')[0]?.trim()
      const protocol = forwardedProtocol || (request.socket.encrypted ? 'https' : 'http')
      const realtimeOrigin = config.realtimePublicUrl || `${protocol}://${request.headers.host}`
      return json(response, 201, {
        ticket: issueRealtimeTicket({
          userId: user.id,
          projectId,
          origin: parsedOrigin.origin,
          secret: config.realtimeTicketSecret,
        }),
        expiresIn: 30,
        websocketUrl: new URL('/api/realtime', realtimeOrigin).toString(),
      })
    }

    if (request.method === 'POST' && url.pathname === '/api/session') {
      if (runtime.authProvider === 'supabase') {
        // Supabase 的访问令牌只存在于前端存储；图片标签无法携带 Bearer Header。
        // 登录后同步一份同源 HttpOnly Cookie，供 /api/media 的 <img> 请求鉴权。
        const accessToken = accessTokenFromRequest(request)
        const user = await productStore.authenticate(accessToken)
        if (!user) return error(response, 401, 'INVALID_ACCESS_TOKEN', '登录状态无效，请重新登录。')
        return json(response, 200, { user }, { 'Set-Cookie': sessionCookie(accessToken, request, 60 * 60) })
      }
      const body = await readJson(request)
      const accessToken = text(body?.accessToken, '访问令牌', 512)
      const user = await productStore.authenticate(accessToken)
      if (!user) return error(response, 401, 'INVALID_ACCESS_TOKEN', '访问令牌无效。')
      return json(response, 200, { user }, { 'Set-Cookie': sessionCookie(accessToken, request, 60 * 60 * 12) })
    }
    if (request.method === 'GET' && url.pathname === '/api/session') {
      return json(response, 200, { user: await productStore.authenticate(accessTokenFromRequest(request, { allowMediaCookie: runtime.authProvider !== 'supabase' })) ?? null })
    }
    if (request.method === 'DELETE' && url.pathname === '/api/session') {
      return json(response, 204, undefined, { 'Set-Cookie': sessionCookie('', request, 0) })
    }

    if (request.method === 'GET' && url.pathname === '/api/users') {
      const user = await requireUser(request)
      try {
        return json(response, 200, { users: await productStore.listUsers(user.id) })
      } catch (caught) {
        return error(response, 403, caught?.code ?? 'USER_MANAGE_FORBIDDEN', caught instanceof Error ? caught.message : '无法读取工作区成员。')
      }
    }
    if (request.method === 'POST' && url.pathname === '/api/users') {
      const user = await requireUser(request)
      await requireSensitiveSession(request)
      if (!await enforceRateLimit(response, {
        scope: 'member-mutation', subject: user.id,
        limit: config.security.memberMutationsPerHour, windowMs: 60 * 60_000,
      })) return
      const body = await readJson(request)
      try {
        const member = await productStore.createUser(user.id, {
          email: text(body?.email, '成员邮箱', 320), name: typeof body?.name === 'string' ? body.name.trim() : undefined,
          role: enumValue(body?.role ?? 'member', ['owner', 'member'], '成员角色'),
          ...(runtime.authProvider === 'supabase' ? {} : { accessToken: text(body?.accessToken, '成员访问令牌', 512) }),
        })
        return json(response, 201, { user: member })
      } catch (caught) {
        return error(response, 403, 'USER_CREATE_FORBIDDEN', caught instanceof Error ? caught.message : '成员创建失败。')
      }
    }
    if (userMatch && request.method === 'PATCH') {
      const user = await requireUser(request)
      await requireSensitiveSession(request)
      if (!await enforceRateLimit(response, {
        scope: 'member-mutation', subject: user.id,
        limit: config.security.memberMutationsPerHour, windowMs: 60 * 60_000,
      })) return
      const body = await readJson(request, 16 * 1024, '成员更新请求过大。')
      const updates = {
        ...(body?.role === undefined ? {} : { role: enumValue(body.role, ['owner', 'member'], '工作区角色') }),
        ...(body?.status === undefined ? {} : { status: enumValue(body.status, ['active', 'disabled'], '成员状态') }),
      }
      if (!Object.keys(updates).length) return error(response, 400, 'USER_UPDATE_INVALID', '请选择要修改的成员角色或状态。')
      try {
        const saved = await productStore.updateUser(user.id, decodeURIComponent(userMatch[1]), updates)
        return json(response, 200, { user: saved })
      } catch (caught) {
        const statusCode = caught?.code === 'USER_NOT_FOUND' ? 404 : 403
        return error(response, statusCode, caught?.code ?? 'USER_MANAGE_FORBIDDEN', caught instanceof Error ? caught.message : '成员更新失败。')
      }
    }

    if (request.method === 'GET' && url.pathname === '/api/audit') {
      const user = await requireUser(request)
      try {
        const events = await productStore.listWorkspaceAuditEvents(user.id, Number(url.searchParams.get('limit') ?? 100))
        return json(response, 200, { events })
      } catch (caught) {
        return error(response, 403, caught?.code ?? 'WORKSPACE_AUDIT_FORBIDDEN', caught instanceof Error ? caught.message : '无法读取工作区审计日志。')
      }
    }
    if (request.method === 'POST' && url.pathname === '/api/account/security-events') {
      const user = await requireUser(request)
      const body = await readJson(request, 8 * 1024, '安全审计请求过大。')
      const action = enumValue(body?.action, [...accountSecurityAuditActions], '安全事件')
      await productStore.recordSecurityAuditEvent(user.id, action, { requestId, source: 'client-confirmed' })
      return json(response, 204)
    }

    if (request.method === 'GET' && url.pathname === '/api/projects') {
      const user = await requireUser(request)
      return json(response, 200, { projects: await productStore.listProjects(user.id) })
    }
    if (request.method === 'POST' && url.pathname === '/api/projects') {
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
    if (projectGenerationJobsMatch && request.method === 'GET') {
      const user = await requireUser(request)
      const projectId = decodeURIComponent(projectGenerationJobsMatch[1])
      await requireProjectPermission(productStore, user.id, projectId, 'read')
      const jobs = await productStore.listGenerationJobsForProject(user.id, projectId, Number(url.searchParams.get('limit') ?? 60))
      if (!jobs) return error(response, 404, 'PROJECT_NOT_FOUND', '未找到项目或你没有访问权限。')
      return json(response, 200, { jobs: jobs.map(publicGenerationJob) })
    }
    if (projectGenerationReconcileMatch && request.method === 'POST') {
      const user = await requireUser(request)
      const projectId = decodeURIComponent(projectGenerationReconcileMatch[1])
      await requireProjectPermission(productStore, user.id, projectId, 'edit')
      const project = await productStore.readProject(user.id, projectId)
      if (!project) return error(response, 404, 'PROJECT_NOT_FOUND', '未找到项目或你没有访问权限。')
      const jobs = await productStore.listGenerationJobsForProject(user.id, projectId, 120)
      const reconciled = reconcileGenerationResults(project.document, jobs ?? [])
      if (!reconciled.changed) return json(response, 200, { ...project, changed: false }, projectResponseHeaders(project))
      try {
        const saved = await productStore.writeProject(user.id, reconciled.document, project.revision, project.graphRevision)
        await publishProjectUpdated(saved, user.id)
        return json(response, 200, { ...saved, changed: true }, projectResponseHeaders(saved))
      } catch (caught) {
        if (caught?.code === 'PROJECT_CONFLICT' || caught?.code === 'CANVAS_GRAPH_CONFLICT') return error(response, 409, caught.code, caught.message)
        return error(response, 403, 'PROJECT_WRITE_FORBIDDEN', caught instanceof Error ? caught.message : '历史结果回填失败。')
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
      })) return
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

    if (request.method === 'GET' && url.pathname === '/api/global-assets') {
      const user = await requireUser(request)
      return json(response, 200, { library: await productStore.readGlobalAssetLibrary(user.id, 'global-brand-assets') })
    }
    if (request.method === 'PUT' && url.pathname === '/api/global-assets') {
      const user = await requireUser(request)
      const body = await readJson(request)
      if (!body?.library || body.library.id !== 'global-brand-assets') return error(response, 400, 'INVALID_LIBRARY', '品牌素材库格式无效。')
      try {
        return json(response, 200, { library: await productStore.writeGlobalAssetLibrary(user.id, body.library) })
      } catch (caught) {
        return error(response, 403, 'LIBRARY_WRITE_FORBIDDEN', caught instanceof Error ? caught.message : '没有编辑品牌素材库的权限。')
      }
    }
    if (request.method === 'GET' && url.pathname === '/api/workflow-templates') {
      const user = await requireUser(request)
      return json(response, 200, { library: await productStore.readGlobalAssetLibrary(user.id, 'global-workflow-templates') })
    }
    if (request.method === 'PUT' && url.pathname === '/api/workflow-templates') {
      const user = await requireUser(request)
      const body = await readJson(request)
      if (!body?.library || body.library.id !== 'global-workflow-templates' || !Array.isArray(body.library.templates)) {
        return error(response, 400, 'INVALID_WORKFLOW_TEMPLATE_LIBRARY', '工作流模板库格式无效。')
      }
      try {
        return json(response, 200, { library: await productStore.writeGlobalAssetLibrary(user.id, body.library) })
      } catch (caught) {
        return error(response, 403, 'WORKFLOW_TEMPLATE_WRITE_FORBIDDEN', caught instanceof Error ? caught.message : '没有编辑共享工作流模板库的权限。')
      }
    }
    if (assetMatch && request.method === 'DELETE') {
      const user = await requireUser(request)
      try {
        return json(response, 200, await productStore.deleteGlobalAsset(user.id, decodeURIComponent(assetMatch[1])))
      } catch (caught) {
        return error(response, 403, 'LIBRARY_WRITE_FORBIDDEN', caught instanceof Error ? caught.message : '没有编辑品牌素材库的权限。')
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/prompt-refinements') {
      const user = await requireUser(request)
      if (!await enforceRateLimit(response, {
        scope: 'prompt-refinement', subject: user.id,
        limit: config.security.promptRefinementsPerFiveMinutes, windowMs: 5 * 60_000,
      })) return
      if (!config.flockApiBaseUrl || !config.flockApiKey || !config.flockTextModel) {
        return error(response, 503, 'PROMPT_PROVIDER_NOT_CONFIGURED', '提示词润色尚未配置 Flock API。')
      }
      const rawInput = await readJson(request, config.maximumPromptRefinementRequestBytes, '提示词润色请求过大，请精简后重试。')
      const input = validatePromptRefinementInput(rawInput)
      await requireProjectPermission(productStore, user.id, input.projectId, 'edit')
      const refinementController = new AbortController()
      const cancelRefinement = () => refinementController.abort()
      const cancelOnClosedResponse = () => {
        if (!response.writableEnded) cancelRefinement()
      }
      request.once('aborted', cancelRefinement)
      response.once('close', cancelOnClosedResponse)
      if (request.aborted || response.destroyed) cancelRefinement()
      try {
        const result = await refinePrompt(input, config, { signal: refinementController.signal })
        if (refinementController.signal.aborted || response.destroyed) return
        return json(response, 200, result)
      } catch (caught) {
        if (refinementController.signal.aborted || response.destroyed) return
        throw caught
      } finally {
        request.off('aborted', cancelRefinement)
        response.off('close', cancelOnClosedResponse)
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/generation-jobs') {
      const user = await requireUser(request)
      const idempotencyKey = generationIdempotencyKey(request.headers['idempotency-key'])
      if (!idempotencyKey) return error(response, 400, 'INVALID_IDEMPOTENCY_KEY', '任务提交标识无效，请刷新页面后重试。')
      const rawInput = await readJson(request)
      const input = validateGenerationInput(rawInput, {
        models: config.modelOptions?.length ? config.modelOptions : config.models,
        maximumBatchCount: config.maximumBatchCount,
        maximumReferenceBytes: config.maximumReferenceBytes,
      })
      const selectedModel = providerForModel(config.modelOptions ?? [], input.settings.model)
      if (!selectedModel) return error(response, 503, 'PROVIDER_NOT_CONFIGURED', '所选生成模型尚未配置，请检查对应供应商 API Key。')
      await requireProjectPermission(productStore, user.id, input.projectId, 'edit')
      const id = generationJobIdForIdempotency(user.id, idempotencyKey)
      const existing = await productStore.readGenerationJob(user.id, id)
      if (existing) return json(response, 202, publicGenerationJob(existing))
      if (!await enforceRateLimit(response, {
        scope: 'generation-output', subject: user.id,
        limit: config.security.generationOutputsPerDay, windowMs: 24 * 60 * 60_000,
        cost: input.batchCount,
      })) return
      const timestamp = Date.now()
      const job = {
        id, ownerId: user.id, projectId: input.projectId, status: 'queued', kind: input.kind,
        createdAt: timestamp, updatedAt: timestamp, batchCount: input.batchCount, settings: input.settings,
        provider: selectedModel.provider === 'minimax'
          ? selectedModel.mediaKind === 'video' ? 'minimax-video' : 'minimax-image'
          : 'openai-images',
        refinementMode: input.refinementMode,
        idempotencyKey,
        outputs: [], error: undefined, rawInput,
      }
      await productStore.putGenerationJob(user.id, persistedGenerationJob(job))
      try {
        await enqueue(job.id)
      } catch (caught) {
        const failed = { ...job, status: 'failed', error: '生成任务无法进入队列，请检查 Redis Worker 后重试。', updatedAt: Date.now() }
        await productStore.putGenerationJob(user.id, persistedGenerationJob(failed))
        return error(response, 503, 'QUEUE_UNAVAILABLE', failed.error)
      }
      return json(response, 202, publicGenerationJob(job))
    }
    if (jobMatch && request.method === 'GET' && !jobMatch[2]) {
      const user = await requireUser(request)
      const job = await productStore.readGenerationJob(user.id, decodeURIComponent(jobMatch[1]))
      if (!job) return error(response, 404, 'JOB_NOT_FOUND', '未找到该真实生成任务。')
      const maximumTaskDurationMs = generationTimeoutForModel(config.modelOptions ?? [], job.settings?.model, {
        imageTimeoutMs: config.generationTimeoutMs ?? 5 * 60_000,
        videoTimeoutMs: config.videoGenerationTimeoutMs ?? 20 * 60_000,
      })
      if ((job.status === 'queued' || job.status === 'running') && Date.now() - job.createdAt >= maximumTaskDurationMs) {
        const failed = {
          ...job,
          status: 'failed',
          error: '生成任务超过模型等待时限，已停止，请稍后重试。',
          updatedAt: Date.now(),
        }
        await productStore.putGenerationJob(user.id, persistedGenerationJob(failed))
        if (job.status === 'queued') await redisQueue?.cancel(job.id)
        return json(response, 200, publicGenerationJob(failed))
      }
      return json(response, 200, publicGenerationJob(job))
    }
    if (jobMatch && request.method === 'POST' && jobMatch[2] === 'cancel') {
      const user = await requireUser(request)
      const jobId = decodeURIComponent(jobMatch[1])
      const job = await productStore.readGenerationJob(user.id, jobId)
      if (!job) return error(response, 404, 'JOB_NOT_FOUND', '未找到该真实生成任务。')
      if (job.status === 'queued' || job.status === 'running') {
        const cancelled = { ...job, status: 'cancelled', error: undefined, updatedAt: Date.now() }
        await productStore.putGenerationJob(user.id, persistedGenerationJob(cancelled))
        await redisQueue?.cancel(jobId)
        return json(response, 200, publicGenerationJob(cancelled))
      }
      return json(response, 200, publicGenerationJob(job))
    }
    if (mediaMatch && request.method === 'GET') {
      const user = await requireUser(request, { allowMediaCookie: true })
      const mediaId = decodeURIComponent(mediaMatch[1])
      const signedUrl = await mediaService.signedUrl(user.id, mediaId)
      if (signedUrl) {
        response.writeHead(302, {
          Location: signedUrl,
          'Cache-Control': 'private, no-store',
          Vary: 'Cookie, Authorization',
        })
        response.end()
        return
      }
      const media = await mediaService.read(user.id, mediaId)
      if (!media) return error(response, 404, 'MEDIA_NOT_FOUND', '未找到媒体文件或你没有访问权限。')
      return streamMedia(response, media)
    }
    return error(response, 404, 'NOT_FOUND', '接口不存在。')
  } catch (caught) {
    const failure = caught instanceof HttpError || caught instanceof ProjectAuthorizationError || caught instanceof GenerationError || caught instanceof PromptRefinementError
      ? caught
      : caught?.code === 'WORKSPACE_STORE_TIMEOUT'
        ? new HttpError(503, 'WORKSPACE_STORE_TIMEOUT', caught.message)
      : new HttpError(500, 'INTERNAL_ERROR', '服务发生未预期错误。')
    if (failure.statusCode >= 500) {
      console.error(JSON.stringify({
        event: 'api.failure', requestId, method: request.method, path: request.url,
        code: failure.code, detail: caught instanceof Error ? caught.message : String(caught),
      }))
    }
    return error(response, failure.statusCode, failure.code, failure.message)
  }
})

realtimeHub = createProjectRealtimeHub({
  server,
  productStore,
  ticketSecret: config.realtimeTicketSecret,
})

server.listen(config.port, '0.0.0.0', () => console.log(`Botanic service listening on http://0.0.0.0:${config.port}`))

async function shutdown() {
  server.close()
  await realtimeHub.close()
  await redisQueue?.close()
  await securityControls.close()
  await mediaService.close()
  await productStore.close?.()
}
process.once('SIGTERM', () => void shutdown())
process.once('SIGINT', () => void shutdown())
