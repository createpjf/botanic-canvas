import assert from 'node:assert/strict'
import test from 'node:test'
import type { BotanicAgentSession } from './agent.ts'
import { mergeCollaborativeAgentSessions, overlayLocalAgentSessionMessages, reconcileAgentSessionsAfterDocumentSync, stripAgentSessionMessages } from './agentCollaboration.ts'

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

test('本机更新的会话标题不被较旧的远端快照回退', () => {
  const merged = mergeCollaborativeAgentSessions(
    [session({ title: '夜景方案', updatedAt: 80 })],
    [session({ title: '新建对话', updatedAt: 20 })],
  )
  assert.equal(merged[0].title, '夜景方案')
  assert.equal(merged[0].updatedAt, 80)

  const tied = mergeCollaborativeAgentSessions(
    [session({ title: '夜景方案', updatedAt: 20 })],
    [session({ title: '新建对话', updatedAt: 20 })],
  )
  assert.equal(tied[0].title, '夜景方案')
})

test('文档读模型无消息时叠回本机消息，有消息时不覆盖远端权威', () => {
  const local = [session({ messages: [
    { id: 'message-local', role: 'user', kind: 'text', content: '本机', createdAt: 10, deliveryStatus: 'syncing' },
  ] })]
  const emptyRemote = overlayLocalAgentSessionMessages([session({ title: '远端', updatedAt: 30 })], local)
  assert.equal(emptyRemote[0].messages[0].id, 'message-local')

  const populatedRemote = overlayLocalAgentSessionMessages([
    session({ messages: [{ id: 'message-remote', role: 'assistant', kind: 'text', content: '远端', createdAt: 15 }] }),
  ], local)
  assert.deepEqual(populatedRemote[0].messages.map((message) => message.id), ['message-remote'])
})

test('保存回写后的文档同步保留本机尚未送达的消息', () => {
  const local = [session({ messages: [
    { id: 'message-pending', role: 'user', kind: 'text', content: '草稿', createdAt: 20, deliveryStatus: 'waiting_network' },
  ] })]
  const reconciled = reconcileAgentSessionsAfterDocumentSync(local, [session({ title: '已保存', updatedAt: 40 })])
  assert.equal(reconciled[0].title, '已保存')
  assert.equal(reconciled[0].messages[0].id, 'message-pending')
})

test('剥离文档内嵌消息只清空 messages', () => {
  const stripped = stripAgentSessionMessages({
    id: 'project-1',
    agentSessions: [session({ messages: [{ id: 'message-1', role: 'user', kind: 'text', content: '旧', createdAt: 1 }] })],
  })
  assert.deepEqual(stripped.agentSessions[0].messages, [])
  assert.equal(stripped.agentSessions[0].id, 'session-1')
})
