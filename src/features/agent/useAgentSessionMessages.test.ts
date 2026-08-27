import assert from 'node:assert/strict'
import test from 'node:test'
import type { BotanicAgentMessage } from '../../domain/agent.ts'
import { mergeAgentMessages } from '../../domain/agentMessageReadModel.ts'

test('full local upsert 用更新 updatedAt 立即压过 API 旧正文', () => {
  const apiMessage: BotanicAgentMessage = {
    id: 'stable-projection', role: 'assistant', kind: 'notice', content: 'API 旧投影',
    createdAt: 10, updatedAt: 500, status: 'answered', turnId: 'turn-stable',
  }
  const staleStoreMessage: BotanicAgentMessage = {
    ...apiMessage, content: 'Store 更旧副本', updatedAt: 100,
  }
  assert.equal(mergeAgentMessages([apiMessage], [staleStoreMessage])[0].content, 'API 旧投影')

  const locallyUpserted: BotanicAgentMessage = {
    ...apiMessage, content: '本地权威终态', updatedAt: 501, status: 'failed',
  }
  const merged = mergeAgentMessages([apiMessage], [locallyUpserted])[0]
  assert.equal(merged.content, '本地权威终态')
  assert.equal(merged.status, 'failed')
  assert.equal(merged.updatedAt, 501)
})
