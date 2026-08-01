import { createHash } from 'node:crypto'
import Redis from 'ioredis'

function subjectDigest(subject) {
  return createHash('sha256').update(String(subject || 'anonymous')).digest('hex').slice(0, 24)
}

function memoryCounter(now) {
  const counters = new Map()
  return {
    async increment(key, windowMs, cost) {
      const timestamp = now()
      const current = counters.get(key)
      if (!current || current.expiresAt <= timestamp) {
        const next = { value: cost, expiresAt: timestamp + windowMs }
        counters.set(key, next)
        return next
      }
      current.value += cost
      return current
    },
    close() {},
  }
}

function redisCounter(redisUrl, fallback, onFallback) {
  const redis = new Redis(redisUrl, {
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  })
  let connected = false
  let warned = false
  redis.on('error', () => undefined)

  async function increment(key, windowMs, cost) {
    try {
      if (!connected) {
        await redis.connect()
        connected = true
      }
      const value = Number(await redis.eval(
        "local value = redis.call('INCRBY', KEYS[1], ARGV[1]); if redis.call('PTTL', KEYS[1]) < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[2]); end; return value",
        1,
        key,
        cost,
        windowMs,
      ))
      const ttl = Math.max(1, Number(await redis.pttl(key)))
      return { value, expiresAt: Date.now() + ttl }
    } catch (error) {
      connected = false
      if (!warned) {
        warned = true
        onFallback?.(error)
      }
      return fallback.increment(key, windowMs, cost)
    }
  }

  return {
    increment,
    async close() {
      if (redis.status === 'ready') await redis.quit().catch(() => redis.disconnect())
      else redis.disconnect()
    },
  }
}

export function createSecurityControls({ redisUrl, now = () => Date.now(), onFallback } = {}) {
  const fallback = memoryCounter(now)
  const counter = redisUrl ? redisCounter(redisUrl, fallback, onFallback) : fallback

  return {
    async consume({ scope, subject, limit, windowMs, cost = 1 }) {
      const normalizedCost = Math.max(1, Math.floor(cost))
      const timestamp = now()
      const windowId = Math.floor(timestamp / windowMs)
      const ttlMs = Math.max(1, windowMs - (timestamp % windowMs))
      const key = `botanic:security:${scope}:${subjectDigest(subject)}:${windowId}`
      const state = await counter.increment(key, ttlMs, normalizedCost)
      const allowed = state.value <= limit
      return {
        allowed,
        remaining: Math.max(0, limit - state.value),
        retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((state.expiresAt - now()) / 1_000)),
      }
    },
    close: () => counter.close(),
  }
}

export function clientAddress(request) {
  const forwarded = request.headers['x-forwarded-for']
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded
  return value?.split(',')[0]?.trim() || request.socket.remoteAddress || 'unknown'
}

export function securityResponseHeaders({ secure = false } = {}) {
  return {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    ...(secure ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  }
}

export function sensitiveActionDecision({ required, authProvider, role, aal }) {
  if (!required || authProvider !== 'supabase' || role !== 'owner') return 'allowed'
  return aal === 'aal2' ? 'allowed' : 'mfa-required'
}
