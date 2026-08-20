import assert from 'node:assert/strict'
import test from 'node:test'
import { readBotanicAgentInstructions } from './agentInstructions.mjs'

test('Agent 每种模式都加载通用人格与对应模式规则', async () => {
  const conversation = await readBotanicAgentInstructions('conversation')
  assert.match(conversation, /# Botanic Agent/)
  assert.match(conversation, /# Botanic Agent Soul/)
  assert.match(conversation, /# 日常对话模式/)
  // 同一份对话规则被纯聊天链路与带生成工具的回合解析器共用，能力必须以工具列表为准，
  // 不能绝对断言「没有生成工具」，否则会和回合指令要求调用生成工具直接冲突。
  assert.match(conversation, /以工具列表为准/)
  assert.match(conversation, /不得发明系统中不存在的执行流程/)
  // 多版本与数量规则要在每种模式都在场：它决定变体声明与追问数量的行为。
  assert.match(conversation, /## 多版本与数量/)
  // 工具纪律同样跨模式：填 why、只调用列表里的工具、提问要走提问工具。
  assert.match(conversation, /## 工具纪律/)
  // 对话链路的只读工具必须点名，否则该读的时候模型不知道调什么。
  assert.match(conversation, /ontology_read/)
  // 是否自动提交由系统执行模式决定，规则不能写死成「一定要用户确认」。
  assert.match(conversation, /由系统的执行模式决定/)
  assert.doesNotMatch(conversation, /# 生图规划模式/)

  const prompt = await readBotanicAgentInstructions('prompt')
  assert.match(prompt, /# Creative Brief 交互规则/)
  assert.match(prompt, /# Prompt 生成模式/)
  assert.match(prompt, /# Prompt Refiner/)
  assert.doesNotMatch(prompt, /# Botanic Agent Planner/)

  const generation = await readBotanicAgentInstructions('generation')
  assert.match(generation, /# Creative Brief 交互规则/)
  assert.match(generation, /# 生图规划模式/)
  assert.match(generation, /# Botanic Agent Planner/)
  assert.doesNotMatch(generation, /# Prompt Refiner/)
})

test('Agent 英文界面只改变新回复语言，保留用户与项目原文', async () => {
  const instructions = await readBotanicAgentInstructions('generation', 'en')
  assert.match(instructions, /Use concise, natural English/)
  assert.match(instructions, /Preserve them in their original language/)
  assert.match(instructions, /Do not translate stable IDs/)
})
