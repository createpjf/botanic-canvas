import assert from 'node:assert/strict'
import test from 'node:test'
import {
  collaborationActivitiesForMember,
  collaborationChangeFromDocuments,
  decodeCollaborationActivityCursor,
  encodeCollaborationActivityCursor,
  nextCollaborationReceipt,
} from './collaborationActivityPersistence.mjs'

const document = (overrides = {}) => ({ name: '项目', nodes: [], edges: [], agentSessions: [], agentRuns: [], ...overrides })

test('持久化协作历史不会为无意义自动保存制造记录', () => {
  assert.equal(collaborationChangeFromDocuments(document(), document()), undefined)
})

test('持久化协作历史不再从文档内嵌消息派生对话记录', () => {
  assert.equal(collaborationChangeFromDocuments(document(), document({
    agentSessions: [{ id: 'session-1', title: '海边方向', messages: [{ id: 'message-1' }] }],
  })), undefined)
})

test('持久化协作历史保留任务定位', () => {
  const task = collaborationChangeFromDocuments(document(), document({
    agentRuns: [{ id: 'run-1', status: 'running', updatedAt: 2, plan: { summary: '海边生成' } }],
  }))
  assert.deepEqual(task, {
    kind: 'task', summary: '更新了任务「海边生成」', target: { kind: 'task', runId: 'run-1' },
  })
})

test('成员已读与清空时间只向前推进', () => {
  assert.deepEqual(nextCollaborationReceipt({ readAt: 500, clearedAt: 400, updatedAt: 550 }, 'read', 300), {
    readAt: 500, clearedAt: 400, updatedAt: 550,
  })
  assert.deepEqual(nextCollaborationReceipt({ readAt: 500, clearedAt: 400 }, 'clear', 600), {
    readAt: 600, clearedAt: 600, updatedAt: 600,
  })
})

test('协作历史游标在相同时间戳下仍稳定分页且不重复', () => {
  const activities = ['a', 'b', 'c'].map((id) => ({
    id: `activity-${id}`, actorId: 'member-2', actorName: 'Mia', kind: 'canvas', summary: id, occurredAt: 100, count: 1,
  }))
  const first = collaborationActivitiesForMember(activities, undefined, 'member-1', { limit: 2 })
  assert.deepEqual(first.map((activity) => activity.id), ['activity-c', 'activity-b'])
  const cursor = encodeCollaborationActivityCursor(first.at(-1))
  assert.deepEqual(decodeCollaborationActivityCursor(cursor), { occurredAt: 100, id: 'activity-b' })
  const second = collaborationActivitiesForMember(activities, undefined, 'member-1', {
    limit: 2,
    before: decodeCollaborationActivityCursor(cursor),
  })
  assert.deepEqual(second.map((activity) => activity.id), ['activity-a'])
  assert.throws(() => decodeCollaborationActivityCursor('broken-cursor'), /分页游标无效/)
})
