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
import { AgentActionExecutionError } from './agentActionExecution.mjs'
import { AgentActionReconciliationError } from './agentActionReconciliation.mjs'
import { McpClientError } from './mcpClient.mjs'
// 能力探测：`authAssurance` 与 `lifecycle` 两处都用它，此前漏了导入 ——
// 结果是启用 MFA 的部署一请求就 500、且优雅关闭必抛 ReferenceError。
import { productStoreSupports } from './productStoreContract.mjs'
import { createAgentRunEventSubscriber } from './agentRunEventBus.mjs'
import { createLocalCancelRegistry } from './localCancelRegistry.mjs'
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
import { createBotanicAgentTurnRuntime } from './botanicAgentTurnRuntime.mjs'
import { createAgentSubagentRunner } from './agentSubagentRunner.mjs'
import { createAgentSubagentProjectRegistry } from './agentSubagentRegistry.mjs'
import { createAgentSubagentProcessor } from './agentSubagentProcessor.mjs'
import { createAgentSubagentCancellation } from './agentSubagentCancellation.mjs'
import { createAgentSubagentRecovery } from './agentSubagentRecovery.mjs'
import { AgentSubagentServiceError, createAgentSubagentService } from './agentSubagentService.mjs'
import { createAgentRunGenerationService } from './agentRunGenerationService.mjs'
import { writeAgentRunOperationalEvent } from './agentRunObservability.mjs'
import { AgentDelegationFenceError } from './agentCancellationService.mjs'
import { abortMatchingGenerationJobCancellation } from './generationCancellation.mjs'
import { createGenerationRecoverySweep } from './generationRecoverySweep.mjs'
import {
  injectAgentTraceContext,
  withExtractedAgentTraceContext,
} from './agentTraceContext.mjs'
import {
  activeBotanicTraceFields,
  setBotanicHttpSpanStatus,
  withBotanicSpan,
} from './executionTelemetry.mjs'
import { agentContextRolloutHealth } from './agentContextRollout.mjs'
import { captureException as captureSentryException } from './sentry.mjs'

export function createBotanicHttpServer({
  config,
  runtime,
  redisQueue,
  agentSubagentQueue,
  agentRunEvents,
  securityControls,
  configuredMcpTools = {},
  reportError = captureSentryException,
}) {
const { productStore, mediaService } = runtime
const configuredMcpToolCount = typeof configuredMcpTools?.catalog === 'function'
  ? configuredMcpTools.catalog().length
  : Object.values(configuredMcpTools ?? {}).filter((value) => typeof value === 'function').length
let realtimeHub
let agentRunEventSubscriber
let canvasRealtimeEventPublisher
let canvasRealtimeEventSubscriber
let localSubagentRecoveryTimer
// API 本地原型与跨实例订阅共用句柄表；生产由 Redis 信号触发，local prototype
// 则由同一 publish seam 直接触发，二者保持相同取消语义。
const localJobCancelRegistry = createLocalCancelRegistry()
const localTurnCancelRegistry = createLocalCancelRegistry()
async function publishAgentCancellation(event) {
  if (event?.scope === 'job') {
    await abortMatchingGenerationJobCancellation({
      productStore,
      cancelRegistry: localJobCancelRegistry,
      event,
    })
  }
  if (event?.scope === 'turn') localTurnCancelRegistry.abort(event.id)
  await agentRunEvents?.publishCancel?.(event)
}
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
  ? createGenerationProcessor({
      productStore, mediaService, config,
      cancelRegistry: localJobCancelRegistry,
      publishAgentRunUpdated,
      publishProjectUpdated: publishGenerationProjectUpdated,
      observeAgentRun,
    })
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
  const traceFields = activeBotanicTraceFields()
  writeAgentRunOperationalEvent({
    ...input,
    w3cTraceId: traceFields.traceId,
    w3cSpanId: traceFields.spanId,
    traceFlags: traceFields.traceFlags,
  }, console, { semanticLogger: console })
}

async function consumeWebResearchQuota(userId, projectId, capability = 'execute-external-tool') {
  const result = await securityControls.consume({
    scope: 'web-research',
    subject: `workspace-default:${projectId ?? 'unknown'}:${userId}:${capability}`,
    limit: config.security.webResearchPerMinute,
    windowMs: 60_000,
  })
  if (!result.allowed) {
    console.warn(JSON.stringify({ event: 'security.rate_limited', scope: 'web-research', retryAfterSeconds: result.retryAfterSeconds }))
  }
  return result
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

function shapedBusinessHttpError(caught) {
  const statusCode = caught?.statusCode
  if (!Number.isInteger(statusCode) || statusCode < 400 || statusCode > 599) return undefined
  if (typeof caught?.code !== 'string' || !caught.code) return undefined
  return new HttpError(statusCode, caught.code, caught.message)
}

function agentEntityHttpError(caught) {
  // 幂等冲突是业务 409，不能落进 INTERNAL_ERROR 触发客户端自动重试风暴。
  if (caught?.code === 'AGENT_RUN_IDEMPOTENCY_CONFLICT') return new HttpError(409, caught.code, caught.message)
  if (caught?.code === 'INVALID_AGENT_ENTITY') return new HttpError(400, caught.code, caught.message)
  if (caught?.code === 'AGENT_SESSION_NOT_FOUND') return new HttpError(404, caught.code, caught.message)
  if (caught?.code === 'AGENT_MESSAGE_NOT_FOUND') return new HttpError(409, caught.code, caught.message)
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

let sweepRecoverableGenerationJobs
function generationRecoverySweep() {
  sweepRecoverableGenerationJobs ??= createGenerationRecoverySweep({
    productStore,
    enqueue,
    observe: (event) => console.error(JSON.stringify(event)),
  })
  return sweepRecoverableGenerationJobs
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
  mediaService,
})

const handleGenerationRoute = createGenerationRouteHandler({
  config,
  productStore,
  redisQueue,
  publishCancel: publishAgentCancellation,
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
  publishCancel: publishAgentCancellation,
  mediaService,
  modelOptions: config.modelOptions ?? [],
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
  mediaService,
})
const hasAgentSubagentStore = [
  'enqueueAgentSubagentActivation',
  'readAgentSubagent',
  'listAgentSubagentActivations',
  'claimAgentSubagentActivation',
  'settleAgentSubagentActivation',
  'requestAgentSubagentCancellation',
  'finalizeAgentSubagentCancellation',
  'listAgentSubagentActivationsForWorker',
  'readAgentSubagentForWorker',
  'listRunnableAgentSubagents',
  'listAgentSubagentsForRootTurnPage',
].every((method) => typeof productStore?.[method] === 'function')
const subagentTurnRuntime = hasAgentSubagentStore
  ? createBotanicAgentTurnRuntime({ productStore, localCancelRegistry: localTurnCancelRegistry })
  : undefined
const subagentRunner = hasAgentSubagentStore
  ? createAgentSubagentRunner({ runtimeConfig: config })
  : undefined
const subagentCancellation = hasAgentSubagentStore
  ? createAgentSubagentCancellation({
      productStore,
      turnRuntime: subagentTurnRuntime,
      publishCancel: publishAgentCancellation,
      observe: observeAgentRun,
    })
  : undefined
let localSubagentProcessor
async function createSubagentRegistry({ userId, projectId }) {
  return createAgentSubagentProjectRegistry({
    productStore,
    config,
    userId,
    projectId,
    consumeWebResearchQuota,
  })
}
async function dispatchSubagentActivation(identity) {
  if (agentSubagentQueue) return agentSubagentQueue.enqueue(identity)
  if (!localSubagentProcessor) {
    throw new AgentSubagentServiceError('AGENT_SUBAGENT_QUEUE_UNAVAILABLE', 'Subagent 执行队列尚未配置。', 503)
  }
  queueMicrotask(() => void localSubagentProcessor(identity).catch((caught) => {
    console.error(`[agent-subagent] local activation deferred: ${caught instanceof Error ? caught.message : String(caught)}`)
  }))
  return true
}
if (hasAgentSubagentStore && subagentRunner && !agentSubagentQueue && !config.production) {
  localSubagentProcessor = createAgentSubagentProcessor({
    productStore,
    turnRuntime: subagentTurnRuntime,
    runSubagent: subagentRunner,
    buildRegistry: ({ descriptor }) => createSubagentRegistry({
      userId: descriptor.ownerId,
      projectId: descriptor.projectId,
    }),
    enqueue: dispatchSubagentActivation,
    convergeCancellation: (descriptor) => subagentCancellation.converge(descriptor),
    observe: observeAgentRun,
  })
}
if (config.production && config.agentSubagentModel && !agentSubagentQueue) {
  throw new Error('生产环境启用 Subagent 时必须配置独立 Redis 队列。')
}
const agentSubagentService = hasAgentSubagentStore
  ? createAgentSubagentService({
      productStore,
      config,
      createRegistry: createSubagentRegistry,
      dispatchActivation: dispatchSubagentActivation,
      cancellation: subagentCancellation,
    })
  : undefined
// 路由与跨实例取消订阅方共用同一张执行句柄表；两者拿不到同一个表，落在非执行
// 实例的取消就只能事后丢弃结果而不是真正中止（ADR 0004）。
const handleAgentRoute = createAgentRouteHandler({
  config, productStore, redisQueue, configuredMcpTools, json, error, readJson, text,
  requireUser, enforceRateLimit, agentRunGeneration, publishAgentRunUpdated,
  enqueue, publishProjectUpdated, publishCollaborationActivity, observeAgentRun,
  // 分支重试服务需要不写 HTTP 响应的限流原语：工具调用方没有 response 可写。
  securityControls,
  mediaService, localCancelRegistry: localTurnCancelRegistry,
  publishCancel: publishAgentCancellation,
  consumeWebResearchQuota,
  agentSubagentService,
})

const handleRequestCore = async (request, response) => {
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
        maxBatchCount: config.maximumBatchCount, models: config.models,
        modelOptions: [...(config.modelOptions ?? []), ...(config.unavailableModelOptions ?? [])],
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
        agentContext: {
          ...agentContextRolloutHealth(config.agentFeatureFlags, config.rolloutFlags),
          configuredModelPolicies: Object.keys(config.agentModelContextPolicies?.models ?? {}).length,
          defaultPolicyConfigured: Boolean(config.agentModelContextPolicies?.default),
        },
        telemetry: {
          enabled: Boolean(config.telemetry?.enabled),
          traces: config.telemetry?.enabled ? 'otlp' : 'disabled',
          genAiSemconv: config.telemetry?.genAiDevelopmentSemconv ? 'development' : 'disabled',
        },
        // 只回显全局开启的灰度闸门名。按项目/用户放量的白名单内容不出现在这里，
        // 否则健康检查会泄漏参与灰度的项目与用户标识。
        rolloutFlags: config.rolloutFlags?.enabledFor() ?? [],
        agentMcp: {
          configured: configuredMcpToolCount > 0,
          toolCount: configuredMcpToolCount,
        },
        agentSubagent: {
          configured: Boolean(subagentRunner),
          model: config.agentSubagentModel || undefined,
          queue: agentSubagentQueue ? 'redis' : localSubagentProcessor ? 'local-prototype' : 'disabled',
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
    const failure = request.aborted === true
      ? new HttpError(499, 'CLIENT_ABORTED', '请求已中断。')
      : caught instanceof HttpError || caught instanceof ProjectAuthorizationError || caught instanceof GenerationError || caught instanceof PromptRefinementError || caught instanceof BotanicAgentPlannerError || caught instanceof BotanicAgentChatError || caught instanceof BotanicAgentRunError || caught instanceof BotanicAgentSkillError || caught instanceof AgentToolRuntimeError || caught instanceof AgentActionExecutionError || caught instanceof AgentActionReconciliationError || caught instanceof McpClientError || caught instanceof AgentDelegationFenceError || caught instanceof AgentSubagentServiceError
      ? caught
      : agentEntityFailure
        ? agentEntityFailure
      : caught?.code === 'WORKSPACE_STORE_TIMEOUT'
        ? new HttpError(503, 'WORKSPACE_STORE_TIMEOUT', caught.message)
      : shapedBusinessHttpError(caught)
        ?? new HttpError(500, 'INTERNAL_ERROR', '服务发生未预期错误。')
    if (failure.statusCode >= 500) {
      reportError(caught, {
        tags: {
          component: 'api',
          error_code: failure.code,
          method: request.method ?? 'UNKNOWN',
        },
        contexts: { request: { id: requestId } },
      })
      console.error(JSON.stringify({
        event: 'api.failure', requestId, method: request.method,
        code: failure.code,
      }))
    }
    return error(response, failure.statusCode, failure.code, failure.message)
  }
}

const handleRequest = (request, response) => withExtractedAgentTraceContext(
  request.headers,
  () => withBotanicSpan(`HTTP ${request.method ?? 'UNKNOWN'}`, {
    kind: 'server',
    automaticSuccessStatus: false,
    attributes: {
      'http.request.method': request.method ?? 'UNKNOWN',
      'url.scheme': request.socket?.encrypted ? 'https' : 'http',
      'botanic.component': 'api',
      'botanic.phase': 'api',
    },
  }, async (span) => {
    const carrier = injectAgentTraceContext()
    if (carrier.traceparent && !response.headersSent) response.setHeader('traceparent', carrier.traceparent)
    const result = await handleRequestCore(request, response)
    try {
      span?.setAttribute('http.response.status_code', response.statusCode)
      setBotanicHttpSpanStatus(span, response.statusCode)
    } catch { /* telemetry isolation */ }
    return result
  }),
)

const server = createServer(handleRequest)

async function start() {
  try {
    await generationRecoverySweep()()
  } catch (caught) {
    // 队列恢复不是 API 启动前置条件；数据库短暂波动不能让登录、项目与媒体服务整体不可用。
    console.error(`[generation] queue recovery deferred: ${caught instanceof Error ? caught.message : String(caught)}`)
  }

  if (localSubagentProcessor) {
    const recoverSubagents = createAgentSubagentRecovery({
      productStore,
      enqueue: dispatchSubagentActivation,
      observe: (event) => console.error(JSON.stringify(event)),
    })
    const recover = () => void recoverSubagents().catch((caught) => {
      console.error(`[agent-subagent] local recovery deferred: ${caught instanceof Error ? caught.message : String(caught)}`)
    })
    recover()
    localSubagentRecoveryTimer = setInterval(recover, 30_000)
    localSubagentRecoveryTimer.unref()
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
      // 别的实例发来的取消：如果这个 Turn 正在本实例执行，就地中止；不在本实例
      // 则忽略（另一个实例会处理，或由孤儿清扫收敛）。
      onCancel: (event) => {
        if (event.scope !== 'turn') return
        localTurnCancelRegistry.abort(event.id)
      },
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
  if (localSubagentRecoveryTimer) clearInterval(localSubagentRecoveryTimer)
  if (server.listening) await new Promise((resolveClose, rejectClose) => server.close((caught) => caught ? rejectClose(caught) : resolveClose()))
  await realtimeHub?.close()
  await canvasRealtimeEventSubscriber?.close()
  await canvasRealtimeEventPublisher?.close()
  await agentRunEventSubscriber?.close()
  await agentRunEvents.close()
  await redisQueue?.close()
  await agentSubagentQueue?.close()
  await securityControls.close()
  await mediaService.close()
  if (productStoreSupports(productStore, 'lifecycle')) await productStore.close()
}

return { server, handleRequest, start, close }
}
