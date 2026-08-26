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
  // Prompt 模式也走对话链路的只读工具，必须点名，不能只说「先检索」。
  assert.match(prompt, /project_memory_search/)
  assert.match(prompt, /skill_search/)

  const research = await readBotanicAgentInstructions('research')
  assert.match(research, /# 项目检索模式/)
  // 检索模式的主力就是这四个只读工具，不点名等于让模型自己猜。
  assert.match(research, /ontology_read/)
  assert.match(research, /project_memory_search/)
  assert.match(research, /asset_group_search/)
  assert.match(research, /skill_search/)

  const generation = await readBotanicAgentInstructions('generation')
  assert.match(generation, /# Creative Brief 交互规则/)
  assert.match(generation, /# 生图规划模式/)
  assert.match(generation, /# Botanic Agent Planner/)
  assert.doesNotMatch(generation, /# Prompt Refiner/)
})

test('指令层点名结构化字段的真实落点，避免规则与工具契约脱节', async () => {
  const conversation = await readBotanicAgentInstructions('conversation')
  assert.match(conversation, /## 字段落点/)
  // 多版本必须落到生成工具的 variants / axisLabel，而不是写进共享 prompt。
  assert.match(conversation, /`variants`/)
  assert.match(conversation, /`axisLabel`/)
  assert.match(conversation, /`count`/)
  // 计划工具没有数量与变体参数，写清楚才不会让模型用枚举凑多版本。
  assert.match(conversation, /这个工具没有数量和变体参数/)
  // 任务状态的权威是持久化记录：本轮有对应读取工具就先查，没有才请用户看面板。
  // 指令必须是条件式——运维工具只在注入读取器的链路（回合）存在，对话链路没有。
  assert.match(conversation, /`generationJobs`/)
  assert.doesNotMatch(conversation, /当前没有检索工具/)
  assert.match(conversation, /agent_run_read/)
  assert.match(conversation, /任务状态与运维/)
  // 节点自带的角色、媒介与状态是模型能用的判断依据。
  assert.match(conversation, /`mediaKind`/)
  assert.match(conversation, /`status`/)
  // Composer 挂载的 Skill 是本轮已确认规则，不是还要再检索的目录项。
  assert.match(conversation, /用户在输入框挂载的 Skill/)
  assert.match(conversation, /skill_create_propose/)

  const generation = await readBotanicAgentInstructions('generation')
  // 变体轴与取值是 Brief 的承载字段，且确认一次长期有效。
  assert.match(generation, /variation\.axisKey/)
  assert.match(generation, /variation\.values/)
  assert.match(generation, /确认一次即长期有效/)
  assert.match(generation, /originalInstruction/)
})

test('Agent 英文界面只改变新回复语言，保留用户与项目原文', async () => {
  const instructions = await readBotanicAgentInstructions('generation', 'en')
  assert.match(instructions, /Use concise, natural English/)
  assert.match(instructions, /Preserve them in their original language/)
  assert.match(instructions, /Do not translate stable IDs/)
})
