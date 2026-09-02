import Redis from 'ioredis'
import { ProviderCircuitBreaker } from '../generation/generationGovernance.mjs'

const FAILURE_SCRIPT = `
local failures = redis.call('HINCRBY', KEYS[1], 'failures', 1)
redis.call('HSET', KEYS[1], 'lastErrorCode', ARGV[1])
if failures >= tonumber(ARGV[2]) then
  redis.call('HSET', KEYS[1], 'state', 'open', 'openedAt', ARGV[3])
else
  redis.call('HSET', KEYS[1], 'state', 'closed')
end
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return failures
`

const REQUEST_SCRIPT = `
local state = redis.call('HGET', KEYS[1], 'state') or 'closed'
local openedAt = tonumber(redis.call('HGET', KEYS[1], 'openedAt') or '0')
local probeUntil = tonumber(redis.call('HGET', KEYS[1], 'probeUntil') or '0')
local now = tonumber(ARGV[1])
local cooldown = tonumber(ARGV[2])
local lease = tonumber(ARGV[3])
if state == 'open' and now - openedAt < cooldown then return {0, 'open'} end
if (state == 'open' or state == 'half-open') and probeUntil > now then return {0, 'half-open'} end
if state == 'open' or state == 'half-open' then
  redis.call('HSET', KEYS[1], 'state', 'half-open', 'probeUntil', now + lease)
  redis.call('PEXPIRE', KEYS[1], cooldown * 4)
  return {1, 'half-open'}
end
return {1, 'closed'}
`

export function createProviderHealthMonitor({
  redisUrl,
  failureThreshold = 3,
  cooldownMs = 30_000,
  probeLeaseMs = 10_000,
  onFallback,
} = {}) {
  const local = new ProviderCircuitBreaker({ failureThreshold, cooldownMs })
  if (!redisUrl) return { ...local, canRequest: local.canRequest.bind(local), recordFailure: local.recordFailure.bind(local), recordSuccess: local.recordSuccess.bind(local), close() {} }
  const redis = new Redis(redisUrl, { enableOfflineQueue: false, lazyConnect: true, maxRetriesPerRequest: 1 })
  let connected = false
  let warned = false
  redis.on('error', () => undefined)
  const key = (provider) => `botanic:provider-health:${provider}`
  async function ready() {
    if (!connected) {
      await redis.connect()
      connected = true
    }
  }
  async function fallback(error, operation) {
    connected = false
    if (!warned) {
      warned = true
      onFallback?.(error)
    }
    return operation()
  }
  return {
    async canRequest(provider) {
      try {
        await ready()
        const result = await redis.eval(REQUEST_SCRIPT, 1, key(provider), Date.now(), cooldownMs, probeLeaseMs)
        return { allowed: Number(result[0]) === 1, state: String(result[1]) }
      } catch (error) {
        return fallback(error, () => local.canRequest(provider))
      }
    },
    async recordFailure(provider, error = {}) {
      try {
        await ready()
        await redis.eval(FAILURE_SCRIPT, 1, key(provider), error.code ?? 'PROVIDER_UNAVAILABLE', failureThreshold, Date.now(), cooldownMs * 4)
      } catch (caught) {
        return fallback(caught, () => local.recordFailure(provider, error))
      }
    },
    async recordSuccess(provider) {
      try {
        await ready()
        await redis.del(key(provider))
      } catch (error) {
        return fallback(error, () => local.recordSuccess(provider))
      }
    },
    async close() {
      if (redis.status === 'ready') await redis.quit().catch(() => redis.disconnect())
      else redis.disconnect()
    },
  }
}
