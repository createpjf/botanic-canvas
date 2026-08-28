import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveAgentModelContextPolicy } from './agentModelContextPolicy.mjs'
import {
  agentContextMessageCursorHash,
  agentContextMessageEntries,
  resolveAgentContextCompaction,
  validAgentContextCompaction,
} from './agentContextCompaction.mjs'

const message = (id, role, content, updatedAt) => ({
  id, role, kind: 'text', content, createdAt: updatedAt, updatedAt,
})

const policy = resolveAgentModelContextPolicy('test-model', {
  models: {
    'test-model': {
      contextWindowTokens: 4_096,
      outputReserveTokens: 512,
      safetyMarginTokens: 128,
      autoCompactRatio: 0.5,
      retainRecentRatio: 0.1,
    },
  },
})

test('Context Compaction 只替换连续旧前缀并保留当前用户原文', () => {
  const messages = Array.from({ length: 12 }, (_, index) => message(
    `m-${index + 1}`,
    index % 2 ? 'assistant' : 'user',
    `消息 ${index + 1} ${'中'.repeat(300)}`,
    index + 1,
  ))
  const result = resolveAgentContextCompaction({
    sessionId: 'session-1', messages, currentMessageId: 'm-11', policy,
  })
  assert.equal(result.kind, 'candidate')
  assert.ok(result.compaction.replacedMessageRevisions.length > 0)
  assert.ok(result.compaction.replacedMessageRevisions.length < messages.length)
  assert.deepEqual(
    result.compaction.replacedMessageRevisions.map((entry) => entry.messageId),
    messages.slice(0, result.compaction.replacedMessageRevisions.length).map((entry) => entry.id),
  )
  assert.equal(result.retainedEntries.some((entry) => entry.id === 'm-11' && entry.content.includes('中')), true)
  assert.ok(result.compaction.meterAfter.inputTokens < result.compaction.meterBefore.inputTokens)
  assert.equal(JSON.stringify(result.compaction).includes('消息 1'), false, 'ledger 不复制原始消息')
})

test('已提交 checkpoint 仅在 policy 与每条原始 Message revision 都匹配时复用', () => {
  const messages = Array.from({ length: 10 }, (_, index) => message(
    `m-${index + 1}`, index % 2 ? 'assistant' : 'user', `目标 ${index + 1} ${'a'.repeat(300)}`, index + 1,
  ))
  const first = resolveAgentContextCompaction({
    sessionId: 'session-2', messages, currentMessageId: 'm-9', policy, force: true,
  })
  assert.equal(first.kind, 'candidate')
  assert.equal(validAgentContextCompaction(agentContextMessageEntries(messages), first.compaction, policy), true)

  const reused = resolveAgentContextCompaction({
    sessionId: 'session-2', messages, currentMessageId: 'm-9', policy,
    existingCompaction: first.compaction,
  })
  assert.equal(reused.kind, 'reused')
  assert.equal(reused.checkpoint.contentHash, first.checkpoint.contentHash)

  const revised = messages.map((entry) => entry.id === 'm-1' ? { ...entry, content: '修订后的目标' } : entry)
  assert.equal(validAgentContextCompaction(agentContextMessageEntries(revised), first.compaction, policy), false)
  const rebuilt = resolveAgentContextCompaction({
    sessionId: 'session-2', messages: revised, currentMessageId: 'm-9', policy, force: true,
    existingCompaction: first.compaction,
  })
  assert.equal(rebuilt.kind, 'candidate')
  assert.notEqual(rebuilt.compaction.id, first.compaction.id)
})

test('manual trigger 可在低压时强制压缩，短会话明确 no_change', () => {
  const longEnough = Array.from({ length: 6 }, (_, index) => message(
    `m-${index + 1}`, index % 2 ? 'assistant' : 'user', `短消息 ${index + 1} ${'内'.repeat(120)}`, index + 1,
  ))
  const forced = resolveAgentContextCompaction({
    sessionId: 'session-manual', messages: longEnough, currentMessageId: 'm-5',
    policy, force: true, trigger: 'manual',
  })
  assert.equal(forced.kind, 'candidate')
  assert.equal(forced.compaction.trigger, 'manual')

  const short = resolveAgentContextCompaction({
    sessionId: 'session-short',
    messages: [message('m-1', 'user', '只有一条', 1)],
    currentMessageId: 'm-1', policy, force: true, trigger: 'manual',
  })
  assert.equal(short.kind, 'no_change')
  assert.equal(short.reason, 'no_replaceable_history')
})

test('Message cursor hash 绑定 id 与内容 revision，不受对象引用影响', () => {
  const source = [message('m-1', 'user', '目标', 1), message('m-2', 'assistant', '回答', 2)]
  const entries = agentContextMessageEntries(source)
  assert.equal(agentContextMessageCursorHash(structuredClone(entries)), agentContextMessageCursorHash(entries))
  const revised = agentContextMessageEntries([{ ...source[0], content: '新目标' }, source[1]])
  assert.notEqual(agentContextMessageCursorHash(revised), agentContextMessageCursorHash(entries))
})
