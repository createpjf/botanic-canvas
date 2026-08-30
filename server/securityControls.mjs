import { createHash } from 'node:crypto'
import Redis from 'ioredis'

function subjectDigest(subject) {
  return createHash('sha256').update(String(subject || 'anonymous')).digest('hex').slice(0, 24)
}

function memoryCounter(now) {
  const counters = new Map()
  const reservations = new Map()
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
    async reserveMany(reservationKey, entries, ttlMs) {
      const timestamp = now()
      const previous = reservations.get(reservationKey)
      if (previous && previous.expiresAt > timestamp) return { allowed: true, reused: true }
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index]
        const current = counters.get(entry.key)
        const value = current && current.expiresAt > timestamp ? current.value : 0
        if (value + entry.cost > entry.limit) return { allowed: false, reused: false, failedIndex: index, remaining: Math.max(0, entry.limit - value) }
      }
      for (const entry of entries) {
        const current = counters.get(entry.key)
        if (!current || current.expiresAt <= timestamp) counters.set(entry.key, { value: entry.cost, expiresAt: timestamp + ttlMs })
        else current.value += entry.cost
      }
      reservations.set(reservationKey, { entries, expiresAt: timestamp + ttlMs })
      return { allowed: true, reused: false }
    },
    async releaseMany(reservationKey) {
      const reservation = reservations.get(reservationKey)
      if (!reservation || reservation.expiresAt <= now()) return { released: false }
      for (const entry of reservation.entries) {
        const current = counters.get(entry.key)
        if (current) current.value = Math.max(0, current.value - entry.cost)
      }
      reservations.delete(reservationKey)
      return { released: true }
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

  async function reserveMany(reservationKey, entries, ttlMs) {
    try {
      if (!connected) {
        await redis.connect()
        connected = true
      }
      const keys = [reservationKey, ...entries.map((entry) => entry.key)]
      const args = [ttlMs, ...entries.flatMap((entry) => [entry.cost, entry.limit])]
      const result = await redis.eval(
        "if redis.call('EXISTS', KEYS[1]) == 1 then return {1, 1, 0, 0}; end; "
        + "for i=2,#KEYS do local value=tonumber(redis.call('GET', KEYS[i]) or '0'); local cost=tonumber(ARGV[(i-2)*2+2]); local limit=tonumber(ARGV[(i-2)*2+3]); if value+cost>limit then return {0,0,i-1,math.max(0,limit-value)}; end; end; "
        + "for i=2,#KEYS do local cost=ARGV[(i-2)*2+2]; redis.call('INCRBY',KEYS[i],cost); if redis.call('PTTL',KEYS[i])<0 then redis.call('PEXPIRE',KEYS[i],ARGV[1]); end; end; redis.call('SET',KEYS[1],'1','PX',ARGV[1]); return {1,0,0,0}",
        keys.length,
        ...keys,
        ...args,
      )
      return { allowed: Number(result[0]) === 1, reused: Number(result[1]) === 1, failedIndex: Math.max(0, Number(result[2]) - 1), remaining: Number(result[3]) }
    } catch (error) {
      connected = false
      if (!warned) {
        warned = true
        onFallback?.(error)
      }
      return fallback.reserveMany(reservationKey, entries, ttlMs)
    }
  }

  async function releaseMany(reservationKey, entries) {
    try {
      if (!connected) {
        await redis.connect()
        connected = true
      }
      const keys = [reservationKey, ...entries.map((entry) => entry.key)]
      const result = await redis.eval(
        "if redis.call('EXISTS',KEYS[1])==0 then return 0; end; "
        + "for i=2,#KEYS do local value=tonumber(redis.call('GET',KEYS[i]) or '0'); local cost=tonumber(ARGV[i-1]); if value<=cost then redis.call('DEL',KEYS[i]); else redis.call('DECRBY',KEYS[i],cost); end; end; redis.call('DEL',KEYS[1]); return 1",
        keys.length,
        ...keys,
        ...entries.map((entry) => entry.cost),
      )
      return { released: Number(result) === 1 }
    } catch (error) {
      connected = false
      if (!warned) {
        warned = true
        onFallback?.(error)
      }
      return fallback.releaseMany(reservationKey, entries)
    }
  }

  return {
    increment,
    reserveMany,
    releaseMany,
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
    async reserveMany({ reservationId, entries, windowMs }) {
      if (!reservationId || !Array.isArray(entries) || !entries.length) throw new Error('预算预留参数无效。')
      const timestamp = now()
      const windowId = Math.floor(timestamp / windowMs)
      const ttlMs = Math.max(1, windowMs - (timestamp % windowMs))
      const normalized = entries.map((entry) => ({
        key: `botanic:security:${entry.scope}:${subjectDigest(entry.subject)}:${windowId}`,
        limit: Math.max(0, Math.floor(entry.limit)),
        cost: Math.max(1, Math.floor(entry.cost)),
      }))
      const reservationKey = `botanic:security:reservation:${subjectDigest(reservationId)}:${windowId}`
      const result = await counter.reserveMany(reservationKey, normalized, ttlMs)
      return {
        allowed: result.allowed,
        reused: Boolean(result.reused),
        reservedAt: timestamp,
        failedScope: result.allowed ? undefined : entries[result.failedIndex]?.scope,
        remaining: result.remaining,
        retryAfterSeconds: result.allowed ? 0 : Math.max(1, Math.ceil(ttlMs / 1_000)),
      }
    },
    async releaseMany({ reservationId, entries, windowMs, reservedAt }) {
      if (!reservationId || !Array.isArray(entries) || !entries.length) throw new Error('预算释放参数无效。')
      const timestamp = Number.isFinite(Number(reservedAt)) ? Number(reservedAt) : now()
      const windowId = Math.floor(timestamp / windowMs)
      const normalized = entries.map((entry) => ({
        key: `botanic:security:${entry.scope}:${subjectDigest(entry.subject)}:${windowId}`,
        cost: Math.max(1, Math.floor(entry.cost)),
      }))
      return counter.releaseMany(
        `botanic:security:reservation:${subjectDigest(reservationId)}:${windowId}`,
        normalized,
      )
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
