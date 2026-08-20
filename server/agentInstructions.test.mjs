import assert from 'node:assert/strict'
import test from 'node:test'
import { readBotanicAgentInstructions } from './agentInstructions.mjs'

test('Agent 每种模式都加载通用人格与对应模式规则', async () => {
  const conversation = await readBotanicAgentInstructions('conversation')
  assert.match(conversation, /# Botanic Agent/)
  assert.match(conversation, /# Botanic Agent Soul/)
  assert.match(conversation, /# 日常对话模式/)
  assert.match(conversation, /没有生成、提交或写画布的工具/)
  assert.match(conversation, /不得发明系统中不存在的执行流程/)
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
