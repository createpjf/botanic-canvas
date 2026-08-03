import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyBotanicAgentRequest } from './agentChatContract.ts'

test('Agent 将日常对话、Prompt、检索和生图请求分流', () => {
  assert.equal(classifyBotanicAgentRequest('你能做什么？'), 'conversation')
  assert.equal(classifyBotanicAgentRequest('帮我生成一份电商海报 Prompt'), 'prompt')
  assert.equal(classifyBotanicAgentRequest('查一下项目里有哪些场景素材'), 'research')
  assert.equal(classifyBotanicAgentRequest('保持人物不变，换一个海边场景', true), 'generation')
  assert.equal(classifyBotanicAgentRequest('你能做什么？', true), 'conversation')
})
