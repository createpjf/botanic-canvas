import assert from 'node:assert/strict'
import test from 'node:test'
import {
  agentStateFromDocument,
  mergeAgentStateIntoDocument,
  shouldApplyAgentEntityWrite,
  shouldApplyAgentRunWrite,
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

test('Agent 会话阅读锚点会进入独立实体并在跨设备读取时保留', () => {
  const state = agentStateFromDocument({
    agentSessions: [{
      ...session('session-reading', 40, [message('message-reading', '停在这里', 30)]),
      readingAnchorMessageId: 'message-reading',
      readingAnchorUpdatedAt: 40,
    }],
    agentMemory: [],
    agentRuns: [],
  })

  assert.equal(state.sessions[0].readingAnchorMessageId, 'message-reading')
  assert.equal(state.sessions[0].readingAnchorUpdatedAt, 40)
  const merged = mergeAgentStateIntoDocument({ agentSessions: [], agentMemory: [], agentRuns: [] }, state)
  assert.equal(merged.agentSessions[0].readingAnchorMessageId, 'message-reading')
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

test('仅存在于独立实体表的 Agent Run 会进入兼容文档', () => {
  const merged = mergeAgentStateIntoDocument({
    agentSessions: [], agentMemory: [], agentRuns: [],
  }, {
    runs: [{ id: 'run-entity-only', status: 'running', updatedAt: 30 }],
  })

  assert.deepEqual(merged.agentRuns, [{ id: 'run-entity-only', status: 'running', updatedAt: 30 }])
})

test('独立 Agent Run 是权威状态，不被更新的兼容文档回退', () => {
  const merged = mergeAgentStateIntoDocument({
    agentSessions: [], agentMemory: [],
    agentRuns: [{
      id: 'run-authoritative', status: 'awaiting_confirmation', updatedAt: 500,
      plan: { rootRecipe: { prompt: '完整本地配方' } },
    }],
  }, {
    runs: [{ id: 'run-authoritative', status: 'running', updatedAt: 100 }],
  })

  assert.equal(merged.agentRuns[0].status, 'running')
  assert.equal(merged.agentRuns[0].updatedAt, 100)
  assert.equal(merged.agentRuns[0].plan.rootRecipe.prompt, '完整本地配方')
})

test('历史 Agent Run 非法状态在写入独立实体前回退到等待确认', () => {
  const state = agentStateFromDocument({
    agentSessions: [], agentMemory: [],
    agentRuns: [{ id: 'run-invalid', status: 'future_status', updatedAt: 13 }],
  })

  assert.equal(state.runs[0].status, 'awaiting_confirmation')
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

test('Prompt 消息的结构化结果会随独立消息保留', () => {
  const result = validateAgentMessageEntity({
    id: 'message-prompt', role: 'assistant', kind: 'text', content: '可直接使用的 Prompt',
    prompt: '保持人物和服装，替换为海边场景。', createdAt: 1,
  }, { now: 2 })

  assert.equal(result.prompt, '保持人物和服装，替换为海边场景。')
  assert.throws(() => validateAgentMessageEntity({
    id: 'message-prompt', role: 'assistant', kind: 'text', content: 'x', prompt: 'x'.repeat(12_001), createdAt: 1,
  }, { now: 2 }))
})

test('Postgres/Supabase 使用同一时间戳冲突规则，Memory 墓碑永久胜出', () => {
  assert.equal(shouldApplyAgentEntityWrite(undefined, { updatedAt: 20 }), true)
  assert.equal(shouldApplyAgentEntityWrite({ updatedAt: 20 }, { updatedAt: 19 }), false)
  assert.equal(shouldApplyAgentEntityWrite({ updatedAt: '20' }, { updatedAt: 19 }), false)
  assert.equal(shouldApplyAgentEntityWrite({ updatedAt: 20 }, { updatedAt: 20 }), true)
  assert.equal(shouldApplyAgentEntityWrite(
    { updatedAt: '2026-08-04T08:00:00.000Z', deletedAt: '2026-08-04T08:00:00.000Z' },
    { updatedAt: '2026-08-04T08:00:00.000Z' },
    { tombstoneWinsTie: true },
  ), false)
  assert.equal(shouldApplyAgentEntityWrite(
    { updatedAt: 20, deletedAt: 20 },
    { updatedAt: 21 },
    { tombstoneWinsTie: true },
  ), false)
})

test('Agent Run 拒绝旧或更新的本地待确认状态覆盖已执行实体', () => {
  assert.equal(shouldApplyAgentRunWrite(undefined, { status: 'awaiting_confirmation', updatedAt: 500 }), true)
  assert.equal(shouldApplyAgentRunWrite(
    { status: 'queued', updatedAt: 200 },
    { status: 'awaiting_confirmation', updatedAt: 100 },
  ), false)
  assert.equal(shouldApplyAgentRunWrite(
    { status: 'running', updatedAt: 200 },
    { status: 'awaiting_confirmation', updatedAt: 500 },
  ), false)
  assert.equal(shouldApplyAgentRunWrite(
    { status: 'queued', updatedAt: 200 },
    { status: 'running', updatedAt: 300 },
  ), true)
})
