import assert from 'node:assert/strict'
import test from 'node:test'
import { buildBotanicAgentChatRequest } from './agentChatContract.ts'

test('通用 Agent 对话请求只发送有限消息与节点 ID', () => {
  const request = buildBotanicAgentChatRequest({
    projectId: 'project-chat',
    plannerModel: 'kimi-k3',
    mode: 'research',
    messages: Array.from({ length: 18 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const, content: `消息 ${index}` })),
    contextNodeIds: ['node-a', 'node-a', 'node-b'],
  })

  assert.equal(request.messages.length, 16)
  assert.deepEqual(request.messages[0], { role: 'user', content: '消息 2' })
  assert.deepEqual(request.contextNodeIds, ['node-a', 'node-b'])
  assert.doesNotMatch(JSON.stringify(request), /image|data:image|base64|url/i)
})
