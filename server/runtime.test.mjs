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
