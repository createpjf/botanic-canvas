import assert from 'node:assert/strict'
import test from 'node:test'
import type { BotanicAgentSession } from './agent.ts'
import { mergeCollaborativeAgentSessions } from './agentCollaboration.ts'

const session = (overrides: Partial<BotanicAgentSession> = {}): BotanicAgentSession => ({
  id: 'session-1', title: '对话', executionMode: 'auto', contextNodeIds: [], messages: [], createdAt: 1, updatedAt: 2,
  ...overrides,
})

test('远端 Agent 会话更新保留本机投递状态与尚未送达消息', () => {
  const merged = mergeCollaborativeAgentSessions([
    session({ messages: [
      { id: 'message-1', role: 'user', kind: 'text', content: '已提交', createdAt: 10, deliveryStatus: 'syncing' },
      { id: 'message-2', role: 'user', kind: 'text', content: '离线草稿', createdAt: 20, deliveryStatus: 'waiting_network' },
    ] }),
  ], [
    session({ title: '远端标题', updatedAt: 30, messages: [
      { id: 'message-1', role: 'user', kind: 'text', content: '已提交', createdAt: 10 },
      { id: 'message-remote', role: 'assistant', kind: 'text', content: '远端回复', createdAt: 15 },
    ] }),
  ])

  assert.equal(merged[0].title, '远端标题')
  assert.deepEqual(merged[0].messages.map(({ id, deliveryStatus }) => ({ id, deliveryStatus })), [
    { id: 'message-1', deliveryStatus: 'syncing' },
    { id: 'message-remote', deliveryStatus: undefined },
    { id: 'message-2', deliveryStatus: 'waiting_network' },
  ])
})

test('远端已删除的同步消息不被本地旧状态复活', () => {
  const merged = mergeCollaborativeAgentSessions([
    session({ messages: [{ id: 'message-old', role: 'user', kind: 'text', content: '旧消息', createdAt: 10, deliveryStatus: 'synced' }] }),
  ], [session({ updatedAt: 30 })])
  assert.deepEqual(merged[0].messages, [])
})

test('已回答的确认卡不被远端旧 pending 快照重新展开', () => {
  const question = {
    id: 'clarification-1',
    question: '确认后继续整理 Prompt，不会立刻出图。',
    originalInstruction: '优化这段人物摄影 Prompt',
    fields: [{ id: 'prompt_direction' as const, label: 'Prompt 优化方向', required: true, options: [] }],
  }
  const merged = mergeCollaborativeAgentSessions([
    session({
      messages: [{
        id: 'message-question',
        role: 'assistant',
        kind: 'question',
        content: question.question,
        createdAt: 10,
        updatedAt: 40,
        status: 'answered',
        question,
      }],
    }),
  ], [
    session({
      updatedAt: 50,
      messages: [{
        id: 'message-question',
        role: 'assistant',
        kind: 'question',
        content: question.question,
        createdAt: 10,
        updatedAt: 10,
        status: 'pending',
        question,
      }],
    }),
  ])

  assert.equal(merged[0].messages[0].status, 'answered')
  assert.equal(merged[0].messages[0].updatedAt, 40)
})
