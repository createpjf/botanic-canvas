import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyBotanicAgentRequest, resolveBotanicAgentGenerationPrompt } from './agentChatContract.ts'

test('Agent 将日常对话、Prompt、检索和生图请求分流', () => {
  assert.equal(classifyBotanicAgentRequest('你能做什么？'), 'conversation')
  assert.equal(classifyBotanicAgentRequest('帮我生成一份电商海报 Prompt'), 'prompt')
  assert.equal(classifyBotanicAgentRequest('查一下项目里有哪些场景素材'), 'research')
  assert.equal(classifyBotanicAgentRequest('保持人物不变，换一个海边场景', true), 'generation')
  assert.equal(classifyBotanicAgentRequest('你能做什么？', true), 'conversation')
})

test('Agent 不会把生成状态追问或效果评价当成新的生图请求', () => {
  assert.equal(classifyBotanicAgentRequest('没有生成呀？'), 'conversation')
  assert.equal(classifyBotanicAgentRequest('没有生成呀？', true), 'conversation')
  assert.equal(classifyBotanicAgentRequest('刚才为什么没成功？', true), 'conversation')
  assert.equal(classifyBotanicAgentRequest('这个效果好吗？', true), 'conversation')
})

test('Agent 区分 Prompt 写作与明确使用上一条 Prompt 生成', () => {
  assert.equal(classifyBotanicAgentRequest('请帮我写一个海边人像 Prompt'), 'prompt')
  assert.equal(classifyBotanicAgentRequest('请把上面的 Prompt 给我'), 'prompt')
  assert.equal(classifyBotanicAgentRequest('按照上面的 Prompt 生成一张'), 'generation')
  assert.equal(classifyBotanicAgentRequest('用这个提示词直接出图'), 'generation')
})

test('Agent 执行“按这个生成”时只继承最新的结构化 Prompt', () => {
  const messages = [
    { role: 'assistant' as const, content: '这是一段解释，不应该被执行。' },
    { role: 'assistant' as const, content: '海边人像 Prompt', prompt: '保持人物和服装，替换为柔和夕阳海边场景。' },
  ]
  assert.equal(
    resolveBotanicAgentGenerationPrompt('按照上面的 Prompt 生成一张', messages),
    '保持人物和服装，替换为柔和夕阳海边场景。',
  )
  assert.equal(
    resolveBotanicAgentGenerationPrompt('按照这个直接生成一张', messages),
    '保持人物和服装，替换为柔和夕阳海边场景。',
  )
  assert.equal(
    resolveBotanicAgentGenerationPrompt('按照上面的 Prompt 生成一张', [{ role: 'assistant', content: '只有解释' }]),
    '按照上面的 Prompt 生成一张',
  )
  assert.equal(resolveBotanicAgentGenerationPrompt('换成森林背景', messages), '换成森林背景')
})
