import assert from 'node:assert/strict'
import test from 'node:test'
import { issueRealtimeTicket, verifyRealtimeTicket } from './realtimeTicket.mjs'

test('短期实时票据只授权指定用户与项目', () => {
  const ticket = issueRealtimeTicket({
    userId: 'user-1',
    projectId: 'project-1',
    secret: 'test-secret',
    now: 1_000,
    lifetimeMs: 30_000,
  })

  assert.deepEqual(verifyRealtimeTicket(ticket, {
    projectId: 'project-1',
    secret: 'test-secret',
    now: 2_000,
  }), { userId: 'user-1', projectId: 'project-1' })
  assert.equal(verifyRealtimeTicket(ticket, {
    projectId: 'project-2',
    secret: 'test-secret',
    now: 2_000,
  }), undefined)
})

test('实时票据被篡改或过期后失效', () => {
  const ticket = issueRealtimeTicket({
    userId: 'user-1',
    projectId: 'project-1',
    secret: 'test-secret',
    now: 1_000,
    lifetimeMs: 30_000,
  })

  assert.equal(verifyRealtimeTicket(`${ticket}broken`, {
    projectId: 'project-1',
    secret: 'test-secret',
    now: 2_000,
  }), undefined)
  assert.equal(verifyRealtimeTicket(ticket, {
    projectId: 'project-1',
    secret: 'test-secret',
    now: 31_001,
  }), undefined)
})
