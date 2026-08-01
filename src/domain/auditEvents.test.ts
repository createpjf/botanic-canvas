import assert from 'node:assert/strict'
import test from 'node:test'
import { auditEventCategory, auditEventDetail, auditEventLabel, filterAuditEvents, type WorkspaceAuditEvent } from './auditEvents.ts'

const events: WorkspaceAuditEvent[] = [
  { id: '1', actorId: 'owner', action: 'security.mfa.enabled', createdAt: 3 },
  { id: '2', actorId: 'owner', action: 'project.member.upserted', projectId: 'project-a', targetId: 'user-b', createdAt: 2 },
  { id: '3', actorId: 'editor', action: 'generation.succeeded', projectId: 'project-a', detail: { requestId: 'req-1' }, createdAt: 1 },
]

test('审计事件按账户、成员、项目和生成分类', () => {
  assert.equal(auditEventCategory('security.password.changed'), 'account')
  assert.equal(auditEventCategory('project.member.upserted'), 'member')
  assert.equal(auditEventCategory('generation.succeeded'), 'generation')
  assert.equal(auditEventCategory('project.updated'), 'project')
  assert.deepEqual(filterAuditEvents(events, 'member').map((event) => event.id), ['2'])
})

test('审计事件使用用户可读文案并保留关联请求', () => {
  assert.equal(auditEventLabel('security.mfa.enabled'), '启用二步验证')
  assert.equal(auditEventLabel('custom.action'), 'custom · action')
  assert.equal(auditEventDetail(events[1]), '项目 project-a · 对象 user-b')
  assert.equal(auditEventDetail(events[2]), '项目 project-a · 请求 req-1')
})
