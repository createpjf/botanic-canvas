import assert from 'node:assert/strict'
import test from 'node:test'
import {
  agentStateFromDocument,
  mergeAgentStateIntoDocument,
  validateAgentMemoryEntity,
  validateAgentMessageEntity,
  validateAgentSessionEntity,
} from './botanicAgentPersistence.mjs'

const session = (id, updatedAt, messages = []) => ({
  id, title: id, executionMode: 'manual', contextNodeIds: [], messages,
  createdAt: 10, updatedAt,
})

const message = (id, content, createdAt) => ({
  id, role: 'user', kind: 'text', content, createdAt,
})

test('Agent 文档状态被拆成独立 Session、Message、Memory 与 Run 实体', () => {
  const state = agentStateFromDocument({
    agentSessions: [session('session-a', 20, [message('message-a', '第一条', 11)])],
    agentMemory: [{ id: 'memory-a', kind: 'rule', content: '  保持   品牌色  ', sourceNodeIds: ['node-a'], createdAt: 12, updatedAt: 12 }],
    agentRuns: [{ id: 'run-a', status: 'queued', updatedAt: 13 }],
  })

  assert.deepEqual(state.sessions[0], {
    id: 'session-a', title: 'session-a', executionMode: 'manual', contextNodeIds: [], createdAt: 10, updatedAt: 20,
  })
  assert.equal(state.messages[0].sessionId, 'session-a')
  assert.equal(state.messages[0].message.content, '第一条')
  assert.equal(state.memory[0].content, '保持 品牌色')
  assert.equal(state.runs[0].id, 'run-a')
})

test('独立实体按 ID 合并，不因旧文档缺少并发新增消息而丢失', () => {
  const merged = mergeAgentStateIntoDocument({
    agentSessions: [session('session-a', 20, [message('message-a', '设备 A', 11)])],
    agentMemory: [],
    agentRuns: [],
    activeAgentSessionId: 'session-a',
  }, {
    sessions: [session('session-a', 30)],
    messages: [
      { sessionId: 'session-a', updatedAt: 20, message: message('message-a', '设备 A', 11) },
      { sessionId: 'session-a', updatedAt: 30, message: message('message-b', '设备 B', 12) },
    ],
  })

  assert.deepEqual(merged.agentSessions[0].messages.map((item) => item.id), ['message-a', 'message-b'])
  assert.equal(merged.agentSessions[0].updatedAt, 30)
})

test('独立消息按自身 updatedAt 合并，旧会话时间戳不会覆盖另一设备的新内容', () => {
  const merged = mergeAgentStateIntoDocument({
    agentSessions: [session('session-a', 400, [{
      ...message('message-a', '设备 A 旧内容', 100),
      updatedAt: 100,
    }])],
    agentMemory: [],
    agentRuns: [],
    activeAgentSessionId: 'session-a',
  }, {
    sessions: [session('session-a', 300)],
    messages: [{
      sessionId: 'session-a',
      updatedAt: 300,
      message: { ...message('message-a', '设备 B 新内容', 100), updatedAt: 300 },
    }],
  })

  assert.equal(merged.agentSessions[0].messages[0].content, '设备 B 新内容')
  assert.equal(merged.agentSessions[0].messages[0].updatedAt, 300)
})

test('独立 Memory 墓碑会覆盖旧 CanvasDocument 中的已删除记忆', () => {
  const merged = mergeAgentStateIntoDocument({
    agentSessions: [], agentRuns: [],
    agentMemory: [{ id: 'memory-a', kind: 'avoid', content: '不要暖色', sourceNodeIds: [], createdAt: 10, updatedAt: 10 }],
  }, { deletedMemoryIds: ['memory-a'] })

  assert.deepEqual(merged.agentMemory, [])
})

test('Agent 实体验证拒绝越界类型与超长消息', () => {
  assert.throws(() => validateAgentSessionEntity({ id: 's', title: 'S', executionMode: 'unsafe' }))
  assert.throws(() => validateAgentMemoryEntity({ id: 'm', kind: 'secret', content: 'x' }))
  assert.throws(() => validateAgentMessageEntity({ id: 'm', role: 'system', kind: 'text', content: 'x' }))
  assert.throws(() => validateAgentMessageEntity({ id: 'm', role: 'user', kind: 'text', content: 'x'.repeat(64_001), createdAt: 1 }))
})
