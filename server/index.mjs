import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { createGenerationProcessor } from './generationProcessor.mjs'
import { createGenerationQueue } from './generationQueue.mjs'
import { GenerationError, persistedGenerationJob, publicGenerationJob, validateGenerationInput } from './generationProvider.mjs'
import { createProductRuntime, loadLocalEnv, runtimeConfig } from './runtime.mjs'

loadLocalEnv()
const config = runtimeConfig()
const runtime = await createProductRuntime(config)
const { productStore, mediaService } = runtime
const redisQueue = createGenerationQueue(config.redisUrl)
const localProcessor = !redisQueue && !config.production
  ? createGenerationProcessor({ productStore, mediaService, config })
  : undefined

if (config.production && !redisQueue) throw new Error('生产环境必须配置 REDIS_URL；内存任务队列只用于本地原型。')

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

function parseCookies(request) {
  return Object.fromEntries((request.headers.cookie ?? '').split(';').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const divider = entry.indexOf('=')
    return divider === -1 ? [entry, ''] : [entry.slice(0, divider), decodeURIComponent(entry.slice(divider + 1))]
  }))
}

function accessTokenFromRequest(request) {
  const authorization = request.headers.authorization
  if (authorization?.startsWith('Bearer ')) return authorization.slice('Bearer '.length).trim()
  return parseCookies(request).botanic_session
}

async function requireUser(request) {
  const user = await productStore.authenticate(accessTokenFromRequest(request))
  if (!user) throw new HttpError(401, 'AUTH_REQUIRED', '请先登录 Botanic 工作区。')
  return user
}

function sessionCookie(token, request, maxAge) {
  const secure = request.headers['x-forwarded-proto']?.split(',')[0]?.trim() === 'https'
  return [
    `botanic_session=${encodeURIComponent(token)}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax', secure ? 'Secure' : '',
    `Max-Age=${maxAge}`,
  ].filter(Boolean).join('; ')
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > config.maximumRequestBytes) throw new HttpError(413, 'REQUEST_TOO_LARGE', '本次素材过大，请减少图片数量或压缩后重试。')
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
  if (typeof media.body.pipe === 'function') return media.body.pipe(response)
  return Readable.fromWeb(media.body).pipe(response)
}

for (const queued of await productStore.recoverGenerationJobs()) {
  try {
    await enqueue(queued.id)
  } catch (caught) {
    console.error(`[generation] queue recovery failed for ${queued.id}: ${caught instanceof Error ? caught.message : String(caught)}`)
  }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    const documentMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/document$/)
    const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/)
    const memberMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/members$/)
    const auditMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/audit$/)
    const assetMatch = url.pathname.match(/^\/api\/global-assets\/([^/]+)$/)
    const jobMatch = url.pathname.match(/^\/api\/generation-jobs\/([^/]+)(?:\/(cancel))?$/)
    const mediaMatch = url.pathname.match(/^\/api\/media\/([^/]+)$/)

    if (request.method === 'GET' && url.pathname === '/api/health') {
      return json(response, 200, {
        status: 'ok', provider: 'openai-images', configured: Boolean(config.apiKey),
        maxBatchCount: config.maximumBatchCount, models: config.models,
        persistence: runtime.persistence, auth: runtime.authProvider, queue: redisQueue ? 'redis' : 'local-prototype', media: mediaService.enabled ? 'storage' : 'inline-prototype',
      })
    }

    if (request.method === 'POST' && url.pathname === '/api/session') {
      if (runtime.authProvider === 'supabase') return error(response, 410, 'SUPABASE_AUTH_REQUIRED', '请使用 Supabase Auth 登录。')
      const body = await readJson(request)
      const accessToken = text(body?.accessToken, '访问令牌', 512)
      const user = await productStore.authenticate(accessToken)
      if (!user) return error(response, 401, 'INVALID_ACCESS_TOKEN', '访问令牌无效。')
      return json(response, 200, { user }, { 'Set-Cookie': sessionCookie(accessToken, request, 60 * 60 * 12) })
    }
    if (request.method === 'GET' && url.pathname === '/api/session') {
      return json(response, 200, { user: await productStore.authenticate(accessTokenFromRequest(request)) ?? null })
    }
    if (request.method === 'DELETE' && url.pathname === '/api/session') {
      return json(response, 204, undefined, { 'Set-Cookie': sessionCookie('', request, 0) })
    }

    if (request.method === 'POST' && url.pathname === '/api/users') {
      const user = await requireUser(request)
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

    if (request.method === 'GET' && url.pathname === '/api/projects') {
      const user = await requireUser(request)
      return json(response, 200, { projects: await productStore.listProjects(user.id) })
    }
    if (projectMatch && request.method === 'DELETE') {
      const user = await requireUser(request)
      try {
        const deleted = await productStore.deleteProject(user.id, decodeURIComponent(projectMatch[1]))
        if (!deleted) return error(response, 404, 'PROJECT_NOT_FOUND', '未找到项目或你没有删除权限。')
        return json(response, 204)
      } catch (caught) {
        return error(response, 403, 'PROJECT_DELETE_FORBIDDEN', caught instanceof Error ? caught.message : '没有删除项目的权限。')
      }
    }
    if (documentMatch && request.method === 'GET') {
      const user = await requireUser(request)
      const project = await productStore.readProject(user.id, decodeURIComponent(documentMatch[1]))
      if (!project) return error(response, 404, 'PROJECT_NOT_FOUND', '未找到项目或你没有访问权限。')
      return json(response, 200, project, { ETag: `"${project.revision}"` })
    }
    if (documentMatch && request.method === 'PUT') {
      const user = await requireUser(request)
      const projectId = decodeURIComponent(documentMatch[1])
      const document = await readJson(request)
      if (!document || document.id !== projectId || typeof document.name !== 'string') return error(response, 400, 'INVALID_DOCUMENT', '项目文档格式无效。')
      const expected = request.headers['if-match']?.replaceAll('"', '')
      const expectedRevision = expected && /^\d+$/.test(expected) ? Number(expected) : undefined
      try {
        const normalized = await mediaService.normalizeDocument(document, { ownerId: user.id, projectId })
        const saved = await productStore.writeProject(user.id, normalized, expectedRevision)
        return json(response, saved.created ? 201 : 200, saved, { ETag: `"${saved.revision}"` })
      } catch (caught) {
        if (caught?.code === 'PROJECT_CONFLICT') return error(response, 409, 'PROJECT_CONFLICT', caught.message)
        return error(response, 403, 'PROJECT_WRITE_FORBIDDEN', caught instanceof Error ? caught.message : '没有编辑项目的权限。')
      }
    }
    if (memberMatch && request.method === 'POST') {
      const user = await requireUser(request)
      const body = await readJson(request)
      try {
        await productStore.addProjectMember(user.id, decodeURIComponent(memberMatch[1]), text(body?.userId, '成员', 160), enumValue(body?.role, ['owner', 'editor', 'viewer'], '成员角色'))
        return json(response, 204)
      } catch (caught) {
        return error(response, 403, 'PROJECT_MEMBER_FORBIDDEN', caught instanceof Error ? caught.message : '成员权限更新失败。')
      }
    }
    if (auditMatch && request.method === 'GET') {
      const user = await requireUser(request)
      const events = await productStore.listAuditEvents(user.id, decodeURIComponent(auditMatch[1]), Number(url.searchParams.get('limit') ?? 100))
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
    if (assetMatch && request.method === 'DELETE') {
      const user = await requireUser(request)
      try {
        return json(response, 200, await productStore.deleteGlobalAsset(user.id, decodeURIComponent(assetMatch[1])))
      } catch (caught) {
        return error(response, 403, 'LIBRARY_WRITE_FORBIDDEN', caught instanceof Error ? caught.message : '没有编辑品牌素材库的权限。')
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/generation-jobs') {
      const user = await requireUser(request)
      if (!config.apiKey) return error(response, 503, 'PROVIDER_NOT_CONFIGURED', '真实生图尚未配置：请设置 OPENAI_API_KEY。')
      const rawInput = await readJson(request)
      const input = validateGenerationInput(rawInput, { models: config.models, maximumBatchCount: config.maximumBatchCount, maximumReferenceBytes: config.maximumReferenceBytes })
      if (!await productStore.canEditProject(user.id, input.projectId)) return error(response, 403, 'PROJECT_GENERATION_FORBIDDEN', '你没有在该项目中发起生成的权限。')
      const timestamp = Date.now()
      const job = {
        id: `job_${randomUUID()}`, ownerId: user.id, projectId: input.projectId, status: 'queued', kind: input.kind,
        createdAt: timestamp, updatedAt: timestamp, batchCount: input.batchCount, settings: input.settings,
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
      const user = await requireUser(request)
      const media = await mediaService.read(user.id, decodeURIComponent(mediaMatch[1]))
      if (!media) return error(response, 404, 'MEDIA_NOT_FOUND', '未找到媒体文件或你没有访问权限。')
      return streamMedia(response, media)
    }
    return error(response, 404, 'NOT_FOUND', '接口不存在。')
  } catch (caught) {
    const failure = caught instanceof HttpError || caught instanceof GenerationError
      ? caught
      : new HttpError(500, 'INTERNAL_ERROR', '服务发生未预期错误。')
    return error(response, failure.statusCode, failure.code, failure.message)
  }
})

server.listen(config.port, '0.0.0.0', () => console.log(`Botanic service listening on http://0.0.0.0:${config.port}`))

async function shutdown() {
  server.close()
  await redisQueue?.close()
  await mediaService.close()
  await productStore.close?.()
}
process.once('SIGTERM', () => void shutdown())
process.once('SIGINT', () => void shutdown())
