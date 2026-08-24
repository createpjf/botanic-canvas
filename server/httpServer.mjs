import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { createGenerationProcessor } from './generationProcessor.mjs'
import { GenerationError } from './generationProvider.mjs'
import { PromptRefinementError } from './promptRefinementProvider.mjs'
import { BotanicAgentPlannerError } from './botanicAgentPlanner.mjs'
import { BotanicAgentChatError } from './botanicAgentChat.mjs'
import { BotanicAgentSkillError } from './botanicAgentSkill.mjs'
import { BotanicAgentRunError } from './botanicAgentRun.mjs'
import { AgentToolRuntimeError } from './agentToolRuntime.mjs'
import { McpClientError } from './mcpClient.mjs'
import { createAgentRunEventSubscriber } from './agentRunEventBus.mjs'
import { createCanvasRealtimeEventPublisher, createCanvasRealtimeEventSubscriber } from './canvasRealtimeEventBus.mjs'
import { createProjectRealtimeHub } from './realtimeHub.mjs'
import { publishProjectUpdatedSafely } from './projectUpdatePublisher.mjs'
import { clientAddress, securityResponseHeaders, sensitiveActionDecision } from './securityControls.mjs'
import { accessTokenFromRequest } from './requestAuth.mjs'
import { ProjectAuthorizationError } from './projectAuthorization.mjs'
import { matchBotanicHttpRoutes } from './httpRouteTable.mjs'
import { createSessionRouteHandler } from './sessionRoutes.mjs'
import { createProjectRouteHandler } from './projectRoutes.mjs'
import { createGenerationRouteHandler } from './generationRoutes.mjs'
import { createGenerationSubmissionService } from './generationSubmissionService.mjs'
import { createProductionWorkflowRouteHandler } from './productionWorkflowRoutes.mjs'
import { createAccountRouteHandler } from './accountRoutes.mjs'
import { createLibraryRouteHandler } from './libraryRoutes.mjs'
import { createRealtimeTicketRouteHandler } from './realtimeTicketRoutes.mjs'
import { createPromptMediaRouteHandler } from './promptMediaRoutes.mjs'
import { createAgentRouteHandler } from './agentRoutes.mjs'
import { createAgentRunGenerationService } from './agentRunGenerationService.mjs'
import { writeAgentRunOperationalEvent } from './agentRunObservability.mjs'

export function createBotanicHttpServer({
  config,
  runtime,
  redisQueue,
  agentRunEvents,
  securityControls,
  configuredMcpTools = {},
}) {
const { productStore, mediaService } = runtime
let realtimeHub
let agentRunEventSubscriber
let canvasRealtimeEventPublisher
let canvasRealtimeEventSubscriber
async function publishAgentRunUpdated(event) {
  if (config.redisUrl) return agentRunEvents.publish(event)
  realtimeHub?.publishAgentRunUpdated(event)
}
async function publishCollaborationActivity(event) {
  if (config.redisUrl) return agentRunEvents.publishCollaborationActivity(event)
  realtimeHub?.publishCollaborationActivity(event)
}
async function publishGenerationProjectUpdated(event) {
  if (config.redisUrl) return agentRunEvents.publishProjectUpdated?.(event)
  return realtimeHub?.publishProjectUpdated(event)
}
const localProcessor = !redisQueue && !config.production
  ? createGenerationProcessor({ productStore, mediaService, config, publishAgentRunUpdated, publishProjectUpdated: publishGenerationProjectUpdated, observeAgentRun })
  : undefined
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
  return true
}

function error(response, statusCode, code, message) {
  return json(response, statusCode, { error: { code, message } })
}

function observeAgentRun(input) {
  writeAgentRunOperationalEvent(input)
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
  if (!productStoreSupports(productStore, 'authAssurance')) {
    throw new HttpError(503, 'MFA_ASSURANCE_UNAVAILABLE', '当前登录存储无法验证二步认证状态。')
  }
  const assurance = await productStore.authAssurance(accessTokenFromRequest(request))
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

function agentEntityHttpError(caught) {
  if (caught?.code === 'INVALID_AGENT_ENTITY') return new HttpError(400, caught.code, caught.message)
  if (caught?.code === 'AGENT_SESSION_NOT_FOUND') return new HttpError(404, caught.code, caught.message)
  if (caught?.code === 'AGENT_MEMORY_DELETED') return new HttpError(409, caught.code, caught.message)
  if (typeof caught?.code === 'string' && /^(AGENT_(SESSION|MESSAGE|MEMORY|RUN|ENTITY)_ID_CONFLICT)$/.test(caught.code)) {
    return new HttpError(409, caught.code, caught.message)
  }
  return undefined
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

const handleSessionRoute = createSessionRouteHandler({
  runtime,
  productStore,
  json,
  error,
  readJson,
  text,
  sessionCookie,
})

const handleProjectRoute = createProjectRouteHandler({
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
  securityControls,
  publishProjectUpdated,
  expectedGraphRevision,
  projectResponseHeaders,
})

const submitGeneration = createGenerationSubmissionService({
  config,
  productStore,
  securityControls,
  enqueue,
})

const handleGenerationRoute = createGenerationRouteHandler({
  config,
  productStore,
  redisQueue,
  json,
  error,
  readJson,
  requireUser,
  submitGeneration,
  publishProjectUpdated,
  projectResponseHeaders,
})

const handleProductionWorkflowRoute = createProductionWorkflowRouteHandler({
  productStore,
  json,
  error,
  readJson,
  requireUser,
  submitGeneration,
  redisQueue,
  publishProjectUpdated,
})

const handleAccountRoute = createAccountRouteHandler({
  config, runtime, productStore, json, error, readJson, text, enumValue,
  requireUser, requireSensitiveSession, enforceRateLimit,
})
const handleLibraryRoute = createLibraryRouteHandler({ productStore, json, error, readJson, requireUser })
const handleRealtimeTicketRoute = createRealtimeTicketRouteHandler({
  config, productStore, json, readJson, text, requireUser, enforceRateLimit, HttpError,
})
const handlePromptMediaRoute = createPromptMediaRouteHandler({
  config, productStore, mediaService, json, error, readJson, text, requireUser,
  enforceRateLimit, streamMedia, HttpError,
})
const agentRunGeneration = createAgentRunGenerationService({
  config,
  productStore,
  securityControls,
  enqueue,
  publishProjectUpdated,
  publishAgentRunUpdated,
})
const handleAgentRoute = createAgentRouteHandler({
  config, productStore, redisQueue, configuredMcpTools, json, error, readJson, text,
  requireUser, enforceRateLimit, agentRunGeneration, publishAgentRunUpdated,
  enqueue, publishProjectUpdated, publishCollaborationActivity, observeAgentRun,
  mediaService,
  consumeWebResearchQuota: async (userId) => {
    const result = await securityControls.consume({
      scope: 'web-research',
      subject: userId,
      limit: config.security.webResearchPerMinute,
      windowMs: 60_000,
    })
    if (!result.allowed) {
      console.warn(JSON.stringify({ event: 'security.rate_limited', scope: 'web-research', retryAfterSeconds: result.retryAfterSeconds }))
    }
    return result
  },
})

const handleRequest = async (request, response) => {
  const requestId = randomUUID()
  response.setHeader('X-Request-ID', requestId)
  const forwardedProtocol = request.headers['x-forwarded-proto']?.split(',')[0]?.trim()
  for (const [name, value] of Object.entries(securityResponseHeaders({ secure: forwardedProtocol === 'https' || Boolean(request.socket.encrypted) }))) {
    response.setHeader(name, value)
  }
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    const routeMatches = matchBotanicHttpRoutes(url.pathname)
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
        agentPlanner: {
          provider: 'flock-api',
          configured: Boolean(config.flockApiBaseUrl && config.flockApiKey && config.flockTextModel),
          model: config.flockTextModel || undefined,
          models: config.flockAgentModels,
        },
        agentFeatures: config.agentFeatureFlags,
        agentMcp: {
          configured: Object.keys(configuredMcpTools).length > 0,
          toolCount: Object.keys(configuredMcpTools).length,
        },
      })
    }

    if (await handleRealtimeTicketRoute(request, response, url)) return

    if (await handleSessionRoute(request, response, url)) return
    if (await handleAccountRoute(request, response, url, routeMatches, requestId)) return

    if (await handleProjectRoute(request, response, url, routeMatches)) return
    if (await handleGenerationRoute(request, response, url, routeMatches)) return
    if (await handleProductionWorkflowRoute(request, response, url, routeMatches)) return
    if (await handleLibraryRoute(request, response, url, routeMatches)) return
    if (await handleAgentRoute(request, response, url, routeMatches, requestId)) return

    if (await handlePromptMediaRoute(request, response, url, routeMatches)) return
    return error(response, 404, 'NOT_FOUND', '接口不存在。')
  } catch (caught) {
    const agentEntityFailure = agentEntityHttpError(caught)
    const failure = caught instanceof HttpError || caught instanceof ProjectAuthorizationError || caught instanceof GenerationError || caught instanceof PromptRefinementError || caught instanceof BotanicAgentPlannerError || caught instanceof BotanicAgentChatError || caught instanceof BotanicAgentRunError || caught instanceof BotanicAgentSkillError || caught instanceof AgentToolRuntimeError || caught instanceof McpClientError
      ? caught
      : agentEntityFailure
        ? agentEntityFailure
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
}

const server = createServer(handleRequest)

async function start() {
  try {
    for (const queued of await productStore.recoverGenerationJobs()) {
      await enqueue(queued.id)
    }
  } catch (caught) {
    // 队列恢复不是 API 启动前置条件；数据库短暂波动不能让登录、项目与媒体服务整体不可用。
    console.error(`[generation] queue recovery deferred: ${caught instanceof Error ? caught.message : String(caught)}`)
  }

  canvasRealtimeEventPublisher = createCanvasRealtimeEventPublisher(config.redisUrl, { eventSecret: config.realtimeEventSecret })
  realtimeHub = createProjectRealtimeHub({
    server,
    productStore,
    ticketSecret: config.realtimeTicketSecret,
    crossInstancePublisher: canvasRealtimeEventPublisher,
  })
  canvasRealtimeEventSubscriber = await createCanvasRealtimeEventSubscriber(config.redisUrl, {
    onCanvasUpdate: (event) => void realtimeHub.receiveCanvasUpdate(event).catch(() => undefined),
    onPresence: (event) => void realtimeHub.receivePresence(event).catch(() => undefined),
  }, { eventSecret: config.realtimeEventSecret })
  agentRunEventSubscriber = await createAgentRunEventSubscriber(
    config.redisUrl,
    (event) => realtimeHub.publishAgentRunUpdated(event),
    {
      onCollaborationActivity: (event) => realtimeHub.publishCollaborationActivity(event),
      onProjectUpdated: (event) => void realtimeHub.publishProjectUpdated(event).catch((caught) => {
        // Worker 的权威写入已完成；实时旁路失败不得形成未处理拒绝并拉垮 API 进程。
        console.error(`[realtime] worker project update deferred: ${caught instanceof Error ? caught.message : String(caught)}`)
      }),
    },
  )
  await new Promise((resolveStart, rejectStart) => {
    const onError = (caught) => rejectStart(caught)
    server.once('error', onError)
    server.listen(config.port, '0.0.0.0', () => {
      server.off('error', onError)
      console.log(`Botanic service listening on http://0.0.0.0:${config.port}`)
      resolveStart()
    })
  })
  return server
}

async function close() {
  if (server.listening) await new Promise((resolveClose, rejectClose) => server.close((caught) => caught ? rejectClose(caught) : resolveClose()))
  await realtimeHub?.close()
  await canvasRealtimeEventSubscriber?.close()
  await canvasRealtimeEventPublisher?.close()
  await agentRunEventSubscriber?.close()
  await agentRunEvents.close()
  await redisQueue?.close()
  await securityControls.close()
  await mediaService.close()
  if (productStoreSupports(productStore, 'lifecycle')) await productStore.close()
}

return { server, handleRequest, start, close }
}
