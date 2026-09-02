import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createProductStore } from './store/productStore.mjs'
import { createPostgresProductStore } from './store/postgresProductStore.mjs'
import { createObjectStore } from './media/objectStore.mjs'
import { createMediaService } from './media/mediaService.mjs'
import { createSupabaseProductStore } from './store/supabaseProductStore.mjs'
import { createSupabaseObjectStore } from './media/supabaseObjectStore.mjs'
import { createSupabaseAuthPostgresStore } from './supabaseAuthPostgresStore.mjs'
import { createGenerationModelCatalog } from './generation/generationModels.mjs'
import { parseMcpToolConfigurations } from './mcpClient.mjs'
import { resolveTavilyExtractUrl, resolveTavilySearchUrl } from './agent/tools/agentWebResearch.mjs'
import { resolveInviteRedirectTo } from './auth/inviteRedirect.mjs'
import { createResendEmailService } from './resendEmailService.mjs'
import { assertProductStoreContract } from './store/productStoreContract.mjs'
import { createRolloutFlags, resolveAgentFeatureFlags } from './featureFlags.mjs'
import { parseAgentModelContextPolicies } from './agent/model/agentModelContextPolicy.mjs'
import { resolveBotanicTelemetryConfig } from './observability/botanicTelemetry.mjs'

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) return fallback
  return Math.min(maximum, Math.max(minimum, parsed))
}

function optionalBudget(value) {
  if (value === undefined || value === '') return Number.POSITIVE_INFINITY
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : Number.POSITIVE_INFINITY
}

export function loadLocalEnv(rootDir = process.cwd()) {
  const envPath = resolve(rootDir, '.env')
  if (!existsSync(envPath)) return
  // 同一个键在 .env 里出现多次时，**先出现的胜出**（下面遇到已设置的就跳过）。
  // 这与 shell 的直觉相反，而且完全静默 —— 往文件末尾追加一份新配置的人会看到
  // 「我改了但没生效」，且没有任何线索。实测踩过：追加了本地 DATABASE_URL，
  // 上面那行 Neon 的仍然生效，本地库一张表都没建。至少要报出来。
  const seen = new Set()
  const duplicates = new Set()
  for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/)
    if (match) {
      if (seen.has(match[1])) duplicates.add(match[1])
      seen.add(match[1])
    }
    // 已显式设置的变量不被 .env 覆盖，**包括显式设成空串**：`FOO= node ...` 的意思是
    // 「这次不要 FOO」，而不是「请从 .env 里补一个」。此前用真值判断，空串会被当成
    // 没设过，于是没有任何办法在不改文件的前提下临时关掉某个配置。
    if (!match || process.env[match[1]] !== undefined) continue
    process.env[match[1]] = match[2].trim().replace(/^("|')(.*)\1$/, '$2')
  }
  for (const key of duplicates) {
    console.warn(`[env] .env 里 ${key} 出现多次，**以最先出现的那行为准**；后面的被忽略。`)
  }
}

export function runtimeConfig(rootDir = process.cwd()) {
  const requestedAuthProvider = process.env.BOTANIC_AUTH_PROVIDER
  const authProvider = ['access-token', 'hybrid', 'supabase'].includes(requestedAuthProvider)
    ? requestedAuthProvider
    : 'supabase'
  const openAIModels = [...new Set((process.env.OPENAI_IMAGE_MODELS ?? process.env.OPENAI_IMAGE_MODEL ?? 'gpt-image-2')
    .split(',').map((model) => model.trim()).filter(Boolean))]
  const miniMaxImageModels = [...new Set((process.env.MINIMAX_IMAGE_MODELS ?? 'image-01')
    .split(',').map((model) => model.trim()).filter(Boolean))]
  const miniMaxVideoModels = [...new Set((process.env.MINIMAX_VIDEO_MODELS ?? 'MiniMax-H3')
    .split(',').map((model) => model.trim()).filter(Boolean))]
  const flockImageModels = [...new Set((process.env.FLOCK_IMAGE_MODELS ?? '')
    .split(',').map((model) => model.trim()).filter(Boolean))]
  const flockAgentModels = [...new Set((process.env.FLOCK_AGENT_MODELS ?? 'deepseek-v4-flash-vision-exp,kimi-k3,gemini-3.7-flash,glm-5')
    .split(',').map((model) => model.trim()).filter(Boolean))]
  const flockTextModel = (process.env.FLOCK_TEXT_MODEL ?? '').trim() || flockAgentModels[0] || ''
  // 服务端总闸门：客户端还必须逐会话明确请求。打开后原文也只随当轮响应下发，
  // 不写入 Message、Plan、Run、Turn Event 或 Artifact。
  const agentRawReasoning = (process.env.AGENT_RAW_REASONING ?? '').trim().toLowerCase() === 'true'
  // Runtime 环内 ephemeral 压缩才可开；默认关。不进入 Coordinator CAS / Shadow / 手动压缩。
  const agentContextLlmSummary = (process.env.AGENT_CONTEXT_LLM_SUMMARY ?? '').trim().toLowerCase() === 'true'
  const publicAppUrl = process.env.BOTANIC_WEB_URL ?? process.env.PUBLIC_APP_URL
  // Railway 不一定自动注入 NODE_ENV；正式 Web 回跳地址也应将 API 视为生产环境。
  const production = process.env.NODE_ENV === 'production'
    || Boolean(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PROJECT_ID)
    || /^https:\/\//i.test(publicAppUrl ?? '')
  const declaredModelOptions = createGenerationModelCatalog({
    openAIApiKey: process.env.OPENAI_API_KEY,
    openAIModels,
    miniMaxApiKey: process.env.MINIMAX_API_KEY,
    miniMaxImageModels,
    miniMaxVideoModels,
    flockApiKey: process.env.FLOCK_API_KEY,
    flockImageModels,
    includeUnavailable: true,
    flockNanoBananaEnabled: (process.env.FLOCK_NANO_BANANA_ENABLED ?? '').trim().toLowerCase() === 'true',
  })
  const modelOptions = declaredModelOptions.filter((model) => model.available !== false)
  const unavailableModelOptions = declaredModelOptions.filter((model) => model.available === false)
  return {
    rootDir,
    port: Number(process.env.PORT ?? 8787),
    production,
    databaseUrl: process.env.DATABASE_URL,
    redisUrl: process.env.REDIS_URL,
    authProvider,
    storageProvider: process.env.BOTANIC_STORAGE_PROVIDER === 's3' ? 's3' : 'supabase',
    supabase: {
      url: process.env.SUPABASE_URL,
      secretKey: process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY,
      bucket: process.env.SUPABASE_STORAGE_BUCKET ?? 'botanic-media',
      inviteRedirectTo: resolveInviteRedirectTo({
        configured: process.env.SUPABASE_INVITE_REDIRECT_TO,
        publicAppUrl,
        production,
      }),
    },
    resend: {
      apiKey: process.env.RESEND_API_KEY,
      from: process.env.RESEND_FROM_EMAIL,
      replyTo: process.env.RESEND_REPLY_TO,
    },
    apiBaseUrl: (process.env.IMAGE_API_BASE_URL ?? 'https://api.openai.com').replace(/\/$/, ''),
    apiKey: process.env.OPENAI_API_KEY,
    miniMaxApiBaseUrl: (process.env.MINIMAX_API_BASE_URL ?? 'https://api.minimax.io').replace(/\/$/, ''),
    miniMaxApiKey: process.env.MINIMAX_API_KEY,
    modelOptions,
    unavailableModelOptions,
    models: modelOptions.length ? modelOptions.map((model) => model.id) : openAIModels,
    flockApiBaseUrl: (process.env.FLOCK_API_BASE_URL ?? 'https://api.flock.io/v1').replace(/\/$/, ''),
    flockApiKey: process.env.FLOCK_API_KEY,
    flockTextModel,
    flockAgentModels,
    // 看图走同一个 Flock 网关；置空即关闭视觉识别，Agent 回到只有节点元数据的状态。
    agentVisionModel: (process.env.AGENT_VISION_MODEL ?? 'gemini-3.7-flash').trim(),
    // 子 Agent 并行调研（Epic 11）。**默认关闭**：一次派发会额外产生 2–3 次模型调用，
    // 而这条路径不需要用户逐次确认。要开就得明确指定一个模型，不从主模型隐式继承 ——
    // 隐式继承意味着任何一次配置调整都可能在无人察觉时把它打开。
    agentSubagentModel: (process.env.AGENT_SUBAGENT_MODEL ?? '').trim(),
    // Subagent 使用独立队列，避免长时调研占住生成或派生任务槽位。
    agentSubagentConcurrency: boundedInteger(process.env.AGENT_SUBAGENT_CONCURRENCY, 2, 1, 8),
    // 模型窗口不会按产品名猜测；未显式配置的模型回到 legacy 8k input 安全预算。
    agentModelContextPolicies: parseAgentModelContextPolicies(
      process.env.AGENT_MODEL_CONTEXT_POLICIES_JSON,
    ),
    agentRawReasoning,
    agentContextLlmSummary,
    agentLegacyClientHistory: process.env.AGENT_LEGACY_CLIENT_HISTORY === 'true',
    telemetry: resolveBotanicTelemetryConfig(process.env),
    agentFeatureFlags: resolveAgentFeatureFlags(process.env),
    // 升级期灰度闸门。与上一行的 kill switch 语义相反：默认全关，支持按项目/用户放量。
    rolloutFlags: createRolloutFlags(process.env),
    promptRefinementTimeoutMs: Number(process.env.PROMPT_REFINEMENT_TIMEOUT_MS ?? 30000),
    // Agent 规划与对话包含受控上下文读取和多轮工具调用；给它足够时间，
    // 避免浏览器先于 Provider 报“工作区超时”。客户端仍有独立的 60 秒上限。
    agentPlannerTimeoutMs: Number(process.env.AGENT_PLANNER_TIMEOUT_MS ?? 55000),
    // Turn 业务时限（H3A）：单次 Provider call 之外的整轮寿命；写入 Turn 顶层 deadlineAt。
    agentTurnLifetimeMs: boundedInteger(process.env.AGENT_TURN_LIFETIME_MS, 600_000, 60_000, 900_000),
    agentMcpTools: parseMcpToolConfigurations(process.env.BOTANIC_MCP_TOOLS_JSON),
    webSearch: {
      apiKey: (process.env.BOTANIC_WEB_SEARCH_API_KEY ?? '').trim(),
      searchUrl: resolveTavilySearchUrl(process.env.BOTANIC_WEB_SEARCH_URL),
      extractUrl: resolveTavilyExtractUrl(process.env.BOTANIC_WEB_SEARCH_URL),
    },
    maximumBatchCount: Number(process.env.MAX_GENERATION_BATCH ?? 8),
    maximumReferenceBytes: 8 * 1024 * 1024,
    maximumRequestBytes: 32 * 1024 * 1024,
    maximumPromptRefinementRequestBytes: 64 * 1024,
    // 图片任务保持 5 分钟上限；H3 是异步视频任务，官方耗时明显更长，独立使用 20 分钟上限。
    generationTimeoutMs: Math.min(5 * 60_000, Math.max(10_000, Number(process.env.GENERATION_TIMEOUT_MS ?? 5 * 60_000))),
    videoGenerationTimeoutMs: Math.min(30 * 60_000, Math.max(60_000, Number(process.env.VIDEO_GENERATION_TIMEOUT_MS ?? 20 * 60_000))),
    // DB lease 是跨实例执行权；Provider 长调用期间由 heartbeat 续租。上限与 Store
    // 状态机一致，heartbeat 最终还会在 Processor 内被夹到 lease/2 以内。
    generationExecutionLeaseMs: boundedInteger(process.env.GENERATION_EXECUTION_LEASE_MS, 120_000, 30_000, 900_000),
    generationExecutionHeartbeatMs: boundedInteger(process.env.GENERATION_EXECUTION_HEARTBEAT_MS, 30_000, 1_000, 300_000),
    // 父任务由 Worker 消费，批量变体/候选作为子任务受控并发执行。
    workerConcurrency: boundedInteger(process.env.GENERATION_WORKER_CONCURRENCY, 3, 1, 8),
    generationVariantConcurrency: boundedInteger(process.env.GENERATION_VARIANT_CONCURRENCY, 3, 1, 8),
    generationBudgets: {
      workspace: optionalBudget(process.env.GENERATION_WORKSPACE_BUDGET_UNITS),
      project: optionalBudget(process.env.GENERATION_PROJECT_BUDGET_UNITS),
      member: optionalBudget(process.env.GENERATION_MEMBER_BUDGET_UNITS),
    },
    providerFailureThreshold: boundedInteger(process.env.GENERATION_PROVIDER_FAILURE_THRESHOLD, 3, 1, 20),
    providerCircuitCooldownMs: boundedInteger(process.env.GENERATION_PROVIDER_CIRCUIT_COOLDOWN_MS, 30_000, 1_000, 30 * 60_000),
    providerFallbackModelIds: [...new Set((process.env.GENERATION_PROVIDER_FALLBACK_MODELS ?? '')
      .split(',').map((model) => model.trim()).filter(Boolean))],
    bootstrapAccessToken: process.env.BOTANIC_BOOTSTRAP_ACCESS_TOKEN ?? (process.env.NODE_ENV === 'production' ? '' : 'botanic-local-dev'),
    bootstrapEmail: process.env.SUPABASE_BOOTSTRAP_OWNER_EMAIL ?? process.env.BOTANIC_BOOTSTRAP_EMAIL,
    realtimeTicketSecret: process.env.REALTIME_TICKET_SECRET,
    // 行动审批与实时票据分开命名；未单独配置时沿用已必需的实时密钥，保持旧部署可启动。
    agentActionApprovalSecret: process.env.AGENT_ACTION_APPROVAL_SECRET ?? process.env.REALTIME_TICKET_SECRET,
    realtimeEventSecret: process.env.REALTIME_EVENT_SECRET ?? process.env.REALTIME_TICKET_SECRET,
    realtimePublicUrl: process.env.REALTIME_PUBLIC_URL,
    security: {
      apiRequestsPerMinute: boundedInteger(process.env.SECURITY_API_REQUESTS_PER_MINUTE, 600, 60, 10_000),
      mediaUploadsPerMinute: boundedInteger(process.env.SECURITY_MEDIA_UPLOADS_PER_MINUTE, 30, 1, 1_000),
      agentPlansPerFiveMinutes: boundedInteger(process.env.SECURITY_AGENT_PLANS_PER_5_MINUTES, 20, 1, 1_000),
      agentChatsPerFiveMinutes: boundedInteger(process.env.SECURITY_AGENT_CHATS_PER_5_MINUTES, 40, 1, 1_000),
      webResearchPerMinute: boundedInteger(process.env.SECURITY_WEB_RESEARCH_PER_MINUTE, 20, 1, 1_000),
      generationOutputsPerDay: boundedInteger(process.env.SECURITY_GENERATION_OUTPUTS_PER_DAY, 100, 1, 10_000),
      memberMutationsPerHour: boundedInteger(process.env.SECURITY_MEMBER_MUTATIONS_PER_HOUR, 20, 1, 1_000),
      promptRefinementsPerFiveMinutes: boundedInteger(process.env.SECURITY_PROMPT_REFINEMENTS_PER_5_MINUTES, 30, 1, 1_000),
      realtimeTicketsPerMinute: boundedInteger(process.env.SECURITY_REALTIME_TICKETS_PER_MINUTE, 60, 1, 1_000),
      requireOwnerMfa: process.env.SECURITY_REQUIRE_OWNER_MFA === 'true',
    },
    localDataPath: resolve(rootDir, process.env.BOTANIC_DATA_PATH ?? 'server/.data/product.json'),
    s3: {
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION ?? 'us-east-1',
      bucket: process.env.S3_BUCKET,
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
    },
  }
}

export async function createProductRuntime(config = runtimeConfig()) {
  const useSupabase = Boolean(config.supabase.url && config.supabase.secretKey)
  const useAccessTokenAuth = config.authProvider === 'access-token'
  const useHybridAuth = config.authProvider === 'hybrid'
  const useSupabaseAuth = config.authProvider === 'supabase' || useHybridAuth
  const useS3Storage = config.storageProvider === 's3'
  const usePostgres = Boolean(config.databaseUrl)
  const emailService = createResendEmailService(config.resend)
  if (config.production && !usePostgres) throw new Error('生产环境必须配置 DATABASE_URL。')
  if (config.production && useSupabaseAuth && !useSupabase) throw new Error('Supabase 登录模式必须配置 SUPABASE_URL 与 SUPABASE_SECRET_KEY。')
  const selectedProductStore = usePostgres
    ? await createPostgresProductStore({
        databaseUrl: config.databaseUrl,
        bootstrapAccessToken: useAccessTokenAuth || useHybridAuth ? config.bootstrapAccessToken : undefined,
        bootstrapEmail: config.bootstrapEmail,
      })
    : useSupabase
      ? createSupabaseProductStore({
        url: config.supabase.url,
        secretKey: config.supabase.secretKey,
        bootstrapEmail: config.bootstrapEmail,
        inviteRedirectTo: config.supabase.inviteRedirectTo,
        emailService,
      })
      : createProductStore({ dataPath: config.localDataPath, bootstrapAccessToken: config.bootstrapAccessToken, bootstrapEmail: config.bootstrapEmail })
  const productStore = assertProductStoreContract(selectedProductStore, {
    adapter: usePostgres ? 'PostgresProductStore' : useSupabase ? 'SupabaseProductStore' : 'LocalProductStore',
  })

  const authenticatedStore = usePostgres && useSupabase && useSupabaseAuth
    ? createSupabaseAuthPostgresStore({
        productStore,
        url: config.supabase.url,
        secretKey: config.supabase.secretKey,
        bootstrapEmail: config.bootstrapEmail,
        inviteRedirectTo: config.supabase.inviteRedirectTo,
        allowLegacyTokens: useHybridAuth,
        emailService,
      })
    : productStore
  assertProductStoreContract(authenticatedStore, { adapter: 'AuthenticatedProductStore' })

  if (!useS3Storage && useSupabase) {
    const objectStore = createSupabaseObjectStore({
      url: config.supabase.url,
      secretKey: config.supabase.secretKey,
      bucket: config.supabase.bucket,
    })
    return {
      config,
      productStore: authenticatedStore,
      mediaService: createMediaService({ productStore: authenticatedStore, objectStore, maximumUploadBytes: config.maximumReferenceBytes }),
      persistence: usePostgres ? 'postgres' : 'supabase',
      authProvider: config.authProvider,
    }
  }
  const configuredObjectStore = [config.s3.endpoint, config.s3.bucket, config.s3.accessKeyId, config.s3.secretAccessKey].every(Boolean)
  if (config.production && !configuredObjectStore) throw new Error('Railway 媒体存储未配置：请设置 S3_ENDPOINT、S3_BUCKET 与对象存储凭据。')
  const objectStore = configuredObjectStore ? await createObjectStore(config.s3) : undefined
  const mediaService = createMediaService({ productStore: authenticatedStore, objectStore, maximumUploadBytes: config.maximumReferenceBytes })
  return { config, productStore: authenticatedStore, mediaService, persistence: usePostgres ? 'postgres' : 'file', authProvider: config.authProvider }
}
