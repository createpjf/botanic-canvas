import assert from 'node:assert/strict'
import test from 'node:test'
import {
  agentMessageListOptions,
  decodeAgentMessageCursor,
  encodeAgentMessageCursor,
} from '../server/agentMessagePersistence.mjs'

test('Agent 消息游标编码与解码', () => {
  const cursor = encodeAgentMessageCursor({ id: 'message-a', updatedAt: 120, createdAt: 100 })
  assert.ok(cursor)
  assert.deepEqual(decodeAgentMessageCursor(cursor), { updatedAt: 120, id: 'message-a' })
  assert.throws(() => decodeAgentMessageCursor('broken'), /分页游标无效/)
})

test('Agent 消息分页参数默认 limit 50', () => {
  assert.equal(agentMessageListOptions().limit, 50)
  assert.equal(agentMessageListOptions({ limit: 200 }).limit, 200)
  assert.equal(agentMessageListOptions({ limit: 999 }).limit, 200)
})
