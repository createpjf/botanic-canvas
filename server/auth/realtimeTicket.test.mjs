import assert from 'node:assert/strict'
import test from 'node:test'
import { issueRealtimeTicket, verifyRealtimeTicket } from './realtimeTicket.mjs'

test('短期实时票据只授权指定用户与项目', () => {
  const ticket = issueRealtimeTicket({
    userId: 'user-1',
    projectId: 'project-1',
    origin: 'https://botanic-canvas.vercel.app',
    secret: 'test-secret',
    now: 1_000,
    lifetimeMs: 30_000,
  })

  assert.deepEqual(verifyRealtimeTicket(ticket, {
    projectId: 'project-1',
    origin: 'https://botanic-canvas.vercel.app',
    secret: 'test-secret',
    now: 2_000,
  }), { userId: 'user-1', projectId: 'project-1' })
  assert.equal(verifyRealtimeTicket(ticket, {
    projectId: 'project-2',
    origin: 'https://botanic-canvas.vercel.app',
    secret: 'test-secret',
    now: 2_000,
  }), undefined)
})

test('实时票据安全携带成员显示名', () => {
  const ticket = issueRealtimeTicket({
    userId: 'user-1', actorName: ' Mia ', projectId: 'project-1',
    origin: 'https://botanic-canvas.vercel.app', secret: 'test-secret', now: 1_000,
  })
  assert.deepEqual(verifyRealtimeTicket(ticket, {
    projectId: 'project-1', origin: 'https://botanic-canvas.vercel.app', secret: 'test-secret', now: 2_000,
  }), { userId: 'user-1', actorName: 'Mia', projectId: 'project-1' })
})

test('实时票据被篡改或过期后失效', () => {
  const ticket = issueRealtimeTicket({
    userId: 'user-1',
    projectId: 'project-1',
    origin: 'https://botanic-canvas.vercel.app',
    secret: 'test-secret',
    now: 1_000,
    lifetimeMs: 30_000,
  })

  assert.equal(verifyRealtimeTicket(`${ticket}broken`, {
    projectId: 'project-1',
    origin: 'https://botanic-canvas.vercel.app',
    secret: 'test-secret',
    now: 2_000,
  }), undefined)
  assert.equal(verifyRealtimeTicket(ticket, {
    projectId: 'project-1',
    origin: 'https://botanic-canvas.vercel.app',
    secret: 'test-secret',
    now: 31_001,
  }), undefined)
})

test('浏览器实时票据只能从签发时的 Origin 建立连接', () => {
  const ticket = issueRealtimeTicket({
    userId: 'user-1',
    projectId: 'project-1',
    origin: 'https://botanic-canvas.vercel.app',
    secret: 'test-secret',
    now: 1_000,
  })

  assert.deepEqual(verifyRealtimeTicket(ticket, {
    projectId: 'project-1',
    origin: 'https://botanic-canvas.vercel.app',
    secret: 'test-secret',
    now: 2_000,
  }), { userId: 'user-1', projectId: 'project-1' })
  assert.equal(verifyRealtimeTicket(ticket, {
    projectId: 'project-1',
    origin: 'https://attacker.example',
    secret: 'test-secret',
    now: 2_000,
  }), undefined)
})

test('实时票据拒绝缺失或不可解析的 Origin，避免签发可跨来源重放的票据', () => {
  assert.throws(() => issueRealtimeTicket({
    userId: 'user-1', projectId: 'project-1', secret: 'test-secret',
  }), /Origin 无效/)
  assert.throws(() => issueRealtimeTicket({
    userId: 'user-1', projectId: 'project-1', origin: 'null', secret: 'test-secret',
  }), /Origin 无效/)
})
