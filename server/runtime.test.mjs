import assert from 'node:assert/strict'
import test from 'node:test'
import { runtimeConfig } from './runtime.mjs'

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

test('安全策略支持独立配置 MFA、API 限流、Agent 规划与每日生成输出配额', () => {
  const keys = ['SECURITY_REQUIRE_OWNER_MFA', 'SECURITY_API_REQUESTS_PER_MINUTE', 'SECURITY_AGENT_PLANS_PER_5_MINUTES', 'SECURITY_GENERATION_OUTPUTS_PER_DAY']
  const original = new Map(keys.map((key) => [key, process.env[key]]))
  try {
    process.env.SECURITY_REQUIRE_OWNER_MFA = 'true'
    process.env.SECURITY_API_REQUESTS_PER_MINUTE = '900'
    process.env.SECURITY_AGENT_PLANS_PER_5_MINUTES = '18'
    process.env.SECURITY_GENERATION_OUTPUTS_PER_DAY = '120'

    assert.deepEqual(runtimeConfig('/tmp/botanic-runtime-test').security, {
      apiRequestsPerMinute: 900,
      agentPlansPerFiveMinutes: 18,
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

test('Agent Planner 默认只暴露三种已确认的 Flock 模型', () => {
  const keys = ['FLOCK_TEXT_MODEL', 'FLOCK_AGENT_MODELS']
  const original = new Map(keys.map((key) => [key, process.env[key]]))
  try {
    delete process.env.FLOCK_TEXT_MODEL
    delete process.env.FLOCK_AGENT_MODELS
    const config = runtimeConfig('/tmp/botanic-runtime-test')
    assert.equal(config.flockTextModel, 'deepseek-v4-pro')
    assert.deepEqual(config.flockAgentModels, ['deepseek-v4-pro', 'deepseek-v4-flash', 'kimi-k3'])
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
