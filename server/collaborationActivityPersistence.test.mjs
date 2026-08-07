import assert from 'node:assert/strict'
import test from 'node:test'
import { collaborationChangeFromDocuments, nextCollaborationReceipt } from './collaborationActivityPersistence.mjs'

const document = (overrides = {}) => ({ name: '项目', nodes: [], edges: [], agentSessions: [], agentRuns: [], ...overrides })

test('持久化协作历史不会为无意义自动保存制造记录', () => {
  assert.equal(collaborationChangeFromDocuments(document(), document()), undefined)
})

test('持久化协作历史保留对话和任务定位', () => {
  const conversation = collaborationChangeFromDocuments(document(), document({
    agentSessions: [{ id: 'session-1', title: '海边方向', messages: [{ id: 'message-1' }] }],
  }))
  assert.deepEqual(conversation, {
    kind: 'conversation', summary: '更新了对话「海边方向」',
    target: { kind: 'message', sessionId: 'session-1', messageId: 'message-1' },
  })

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
