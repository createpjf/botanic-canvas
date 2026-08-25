import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadLocalEnv, runtimeConfig } from './runtime.mjs'

test('实时票据只使用独立签名密钥，不复用数据库或工作区凭据', () => {
  const keys = [
    'REALTIME_TICKET_SECRET',
    'SUPABASE_SECRET_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'BOTANIC_BOOTSTRAP_ACCESS_TOKEN',
    'NODE_ENV',
  ]
  const original = new Map(keys.map((key) => [key, process.env[key]]))
  try {
    delete process.env.REALTIME_TICKET_SECRET
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    process.env.SUPABASE_SECRET_KEY = 'database-secret'
    process.env.BOTANIC_BOOTSTRAP_ACCESS_TOKEN = 'workspace-secret'
    process.env.NODE_ENV = 'development'

    assert.equal(runtimeConfig('/tmp/botanic-runtime-test').realtimeTicketSecret, undefined)
    process.env.REALTIME_TICKET_SECRET = 'dedicated-realtime-secret'
    assert.equal(runtimeConfig('/tmp/botanic-runtime-test').realtimeTicketSecret, 'dedicated-realtime-secret')
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('安全策略支持独立配置 MFA、API 与 Agent 对话/规划限流及每日生成输出配额', () => {
  const keys = ['SECURITY_REQUIRE_OWNER_MFA', 'SECURITY_API_REQUESTS_PER_MINUTE', 'SECURITY_MEDIA_UPLOADS_PER_MINUTE', 'SECURITY_AGENT_PLANS_PER_5_MINUTES', 'SECURITY_AGENT_CHATS_PER_5_MINUTES', 'SECURITY_WEB_RESEARCH_PER_MINUTE', 'SECURITY_GENERATION_OUTPUTS_PER_DAY']
  const original = new Map(keys.map((key) => [key, process.env[key]]))
  try {
    process.env.SECURITY_REQUIRE_OWNER_MFA = 'true'
    process.env.SECURITY_API_REQUESTS_PER_MINUTE = '900'
    process.env.SECURITY_MEDIA_UPLOADS_PER_MINUTE = '24'
    process.env.SECURITY_AGENT_PLANS_PER_5_MINUTES = '18'
    process.env.SECURITY_AGENT_CHATS_PER_5_MINUTES = '36'
    process.env.SECURITY_WEB_RESEARCH_PER_MINUTE = '12'
    process.env.SECURITY_GENERATION_OUTPUTS_PER_DAY = '120'

    assert.deepEqual(runtimeConfig('/tmp/botanic-runtime-test').security, {
      apiRequestsPerMinute: 900,
      mediaUploadsPerMinute: 24,
      agentPlansPerFiveMinutes: 18,
      agentChatsPerFiveMinutes: 36,
      webResearchPerMinute: 12,
      generationOutputsPerDay: 120,
      memberMutationsPerHour: 20,
      promptRefinementsPerFiveMinutes: 30,
      realtimeTicketsPerMinute: 60,
      requireOwnerMfa: true,
    })
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('认证提供方显式支持无停机 Hybrid 迁移模式', () => {
  const original = process.env.BOTANIC_AUTH_PROVIDER
  try {
    process.env.BOTANIC_AUTH_PROVIDER = 'hybrid'
    assert.equal(runtimeConfig('/tmp/botanic-runtime-test').authProvider, 'hybrid')
    process.env.BOTANIC_AUTH_PROVIDER = 'access-token'
    assert.equal(runtimeConfig('/tmp/botanic-runtime-test').authProvider, 'access-token')
    process.env.BOTANIC_AUTH_PROVIDER = 'invalid'
    assert.equal(runtimeConfig('/tmp/botanic-runtime-test').authProvider, 'supabase')
  } finally {
    if (original === undefined) delete process.env.BOTANIC_AUTH_PROVIDER
    else process.env.BOTANIC_AUTH_PROVIDER = original
  }
})

test('生产 Web 回跳地址会让 Railway API 进入生产邀请保护', () => {
  const keys = ['NODE_ENV', 'RAILWAY_ENVIRONMENT_NAME', 'RAILWAY_PROJECT_ID', 'BOTANIC_WEB_URL', 'SUPABASE_INVITE_REDIRECT_TO']
  const original = new Map(keys.map((key) => [key, process.env[key]]))
  try {
    delete process.env.NODE_ENV
    delete process.env.RAILWAY_ENVIRONMENT_NAME
    delete process.env.RAILWAY_PROJECT_ID
    process.env.BOTANIC_WEB_URL = 'https://botanic-canvas.vercel.app/'
    process.env.SUPABASE_INVITE_REDIRECT_TO = 'http://localhost:8080'
    const config = runtimeConfig('/tmp/botanic-runtime-test')
    assert.equal(config.production, true)
    assert.equal(config.supabase.inviteRedirectTo, 'https://botanic-canvas.vercel.app/')
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('Agent Planner 默认只暴露三种已确认的 Flock 模型', () => {
  const keys = ['FLOCK_TEXT_MODEL', 'FLOCK_AGENT_MODELS', 'AGENT_VISION_MODEL']
  const original = new Map(keys.map((key) => [key, process.env[key]]))
  try {
    delete process.env.FLOCK_TEXT_MODEL
    delete process.env.FLOCK_AGENT_MODELS
    delete process.env.AGENT_VISION_MODEL
    const config = runtimeConfig('/tmp/botanic-runtime-test')
    assert.equal(config.flockTextModel, 'deepseek-v4-pro')
    assert.deepEqual(config.flockAgentModels, ['deepseek-v4-pro', 'deepseek-v4-flash', 'kimi-k3'])
    assert.equal(config.agentVisionModel, 'gemini-3.6-flash')
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('联网搜索默认走 Tavily REST，MCP 地址会被忽略', () => {
  const keys = ['BOTANIC_WEB_SEARCH_API_KEY', 'BOTANIC_WEB_SEARCH_URL']
  const original = new Map(keys.map((key) => [key, process.env[key]]))
  try {
    process.env.BOTANIC_WEB_SEARCH_API_KEY = 'test-search-key'
    process.env.BOTANIC_WEB_SEARCH_URL = 'https://mcp.tavily.com/mcp/?tavilyApiKey=secret'
    const config = runtimeConfig('/tmp/botanic-runtime-test')
    assert.equal(config.webSearch.apiKey, 'test-search-key')
    assert.equal(config.webSearch.searchUrl, 'https://api.tavily.com/search')
    assert.equal(config.webSearch.extractUrl, 'https://api.tavily.com/extract')
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('.env 里同名键重复时以最先出现的为准，并且必须报出来', async () => {
  // 这与 shell 的直觉相反，而且原本完全静默：往文件末尾追加一份新配置的人会看到
  // 「我改了但没生效」且没有任何线索。实测踩过——追加了本地 DATABASE_URL，
  // 上面那行 Neon 的仍然生效，本地库一张表都没建。
  const dir = mkdtempSync(join(tmpdir(), 'botanic-env-'))
  writeFileSync(join(dir, '.env'), [
    'SMOKE_DUP_KEY=first',
    '# 注释里的 SMOKE_DUP_KEY=ignored 不算',
    'SMOKE_DUP_KEY=second',
    'SMOKE_ONLY_ONCE=value',
  ].join('\n'))
  const warnings = []
  const originalWarn = console.warn
  console.warn = (message) => warnings.push(String(message))
  const previous = process.env.SMOKE_DUP_KEY
  try {
    delete process.env.SMOKE_DUP_KEY
    delete process.env.SMOKE_ONLY_ONCE
    loadLocalEnv(dir)
    assert.equal(process.env.SMOKE_DUP_KEY, 'first', '先出现的胜出')
    assert.equal(process.env.SMOKE_ONLY_ONCE, 'value')
    assert.ok(
      warnings.some((line) => /SMOKE_DUP_KEY/u.test(line) && /最先出现/u.test(line)),
      `重复必须被报出来，实际：${JSON.stringify(warnings)}`,
    )
    // 只出现一次的键不该被误报。
    assert.equal(warnings.some((line) => /SMOKE_ONLY_ONCE/u.test(line)), false)
  } finally {
    console.warn = originalWarn
    if (previous === undefined) delete process.env.SMOKE_DUP_KEY
    else process.env.SMOKE_DUP_KEY = previous
    delete process.env.SMOKE_ONLY_ONCE
    rmSync(dir, { recursive: true, force: true })
  }
})
