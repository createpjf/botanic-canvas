import assert from 'node:assert/strict'
import test from 'node:test'
import Redis from 'ioredis'
import { createSecurityControls, sensitiveActionDecision, securityResponseHeaders } from './securityControls.mjs'

test('固定窗口限流在额度耗尽后返回重试时间，窗口结束后恢复', async () => {
  let timestamp = 10_000
  const security = createSecurityControls({ now: () => timestamp })

  assert.deepEqual(await security.consume({ scope: 'prompt', subject: 'user-1', limit: 2, windowMs: 1_000 }), {
    allowed: true,
    remaining: 1,
    retryAfterSeconds: 0,
  })
  assert.equal((await security.consume({ scope: 'prompt', subject: 'user-1', limit: 2, windowMs: 1_000 })).allowed, true)
  assert.deepEqual(await security.consume({ scope: 'prompt', subject: 'user-1', limit: 2, windowMs: 1_000 }), {
    allowed: false,
    remaining: 0,
    retryAfterSeconds: 1,
  })

  timestamp = 11_001
  assert.equal((await security.consume({ scope: 'prompt', subject: 'user-1', limit: 2, windowMs: 1_000 })).allowed, true)
})

test('生成输出配额按候选数量计费，且不同用户相互隔离', async () => {
  const security = createSecurityControls({ now: () => 20_000 })

  assert.equal((await security.consume({ scope: 'generation-output', subject: 'user-1', limit: 4, windowMs: 86_400_000, cost: 3 })).allowed, true)
  assert.equal((await security.consume({ scope: 'generation-output', subject: 'user-1', limit: 4, windowMs: 86_400_000, cost: 2 })).allowed, false)
  assert.equal((await security.consume({ scope: 'generation-output', subject: 'user-2', limit: 4, windowMs: 86_400_000, cost: 4 })).allowed, true)
})

test('Redis 首次并发限流请求共享同一次连接', async (context) => {
  let connectCalls = 0
  let fallbackCalls = 0
  context.mock.method(Redis.prototype, 'connect', async function () {
    if (++connectCalls > 1) throw new Error('Redis is already connecting/connected')
    this.status = 'ready'
  })
  context.mock.method(Redis.prototype, 'eval', async () => 1)
  context.mock.method(Redis.prototype, 'pttl', async () => 1_000)
  context.mock.method(Redis.prototype, 'quit', async function () { this.status = 'end' })
  const security = createSecurityControls({ redisUrl: 'redis://test', onFallback: () => { fallbackCalls += 1 } })

  await Promise.all([
    security.consume({ scope: 'prompt', subject: 'user-1', limit: 2, windowMs: 1_000 }),
    security.consume({ scope: 'prompt', subject: 'user-2', limit: 2, windowMs: 1_000 }),
  ])
  assert.equal(connectCalls, 1)
  assert.equal(fallbackCalls, 0)
  await security.close()
})

test('多维预算预留保持原子且同一任务只记一次', async () => {
  const security = createSecurityControls({ now: () => 20_000 })
  const input = {
    reservationId: 'job-a', windowMs: 86_400_000,
    entries: [
      { scope: 'workspace-budget', subject: 'workspace', limit: 10, cost: 4 },
      { scope: 'member-budget', subject: 'member-a', limit: 5, cost: 4 },
    ],
  }
  assert.equal((await security.reserveMany(input)).allowed, true)
  assert.equal((await security.reserveMany(input)).reused, true)
  assert.equal((await security.reserveMany({
    ...input, reservationId: 'job-b',
    entries: input.entries.map((entry) => ({ ...entry, cost: 2 })),
  })).allowed, false)
  assert.equal((await security.reserveMany({
    ...input, reservationId: 'job-c',
    entries: input.entries.map((entry) => ({ ...entry, cost: 1 })),
  })).allowed, true)
})

test('多维预算可幂等释放并恢复全部 counter', async () => {
  const security = createSecurityControls({ now: () => 20_000 })
  const input = {
    reservationId: 'job-release', windowMs: 86_400_000,
    entries: [
      { scope: 'workspace-budget', subject: 'workspace', limit: 4, cost: 4 },
      { scope: 'member-budget', subject: 'member-a', limit: 4, cost: 4 },
    ],
  }
  const reservation = await security.reserveMany(input)
  assert.equal((await security.releaseMany({ ...input, reservedAt: reservation.reservedAt })).released, true)
  assert.equal((await security.releaseMany({ ...input, reservedAt: reservation.reservedAt })).released, false)
  assert.equal((await security.reserveMany({ ...input, reservationId: 'job-after-release' })).allowed, true)
})

test('安全响应头限制嗅探、嵌入、权限与跨站来源泄露', () => {
  assert.deepEqual(securityResponseHeaders({ secure: true }), {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  })
})

test('正式 Supabase Owner 敏感操作在启用策略后必须达到 AAL2', () => {
  assert.equal(sensitiveActionDecision({ required: true, authProvider: 'supabase', role: 'owner', aal: 'aal1' }), 'mfa-required')
  assert.equal(sensitiveActionDecision({ required: true, authProvider: 'supabase', role: 'owner', aal: 'aal2' }), 'allowed')
  assert.equal(sensitiveActionDecision({ required: true, authProvider: 'access-token', role: 'owner' }), 'allowed')
  assert.equal(sensitiveActionDecision({ required: false, authProvider: 'supabase', role: 'owner', aal: 'aal1' }), 'allowed')
})
