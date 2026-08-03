import type { BotanicAgentMessage } from './agent'

export type BotanicAgentChatMode = 'conversation' | 'prompt' | 'research'
export type BotanicAgentRequestRoute = BotanicAgentChatMode | 'generation'

export type BotanicAgentChatRequestInput = {
  projectId: string
  plannerModel?: string
  mode: BotanicAgentChatMode
  messages: Pick<BotanicAgentMessage, 'role' | 'content'>[]
  contextNodeIds: string[]
}

export type BotanicAgentChatToolCall = {
  id: string
  name: string
  label: string
  risk: 'read' | 'write' | 'costly' | 'external'
  status: 'pending' | 'running' | 'awaiting_confirmation' | 'succeeded' | 'failed'
  requiresConfirmation: boolean
  error?: string
}

export type BotanicAgentChatResponse = {
  answer: string
  mode: BotanicAgentChatMode
  plannerModel?: string
  toolCalls?: BotanicAgentChatToolCall[]
  sources?: string[]
}

/**
 * 通用 Agent 先路由，再决定是否进入生图 Planner；显式 Prompt/检索请求不应误触发生成。
 */
export function classifyBotanicAgentRequest(value: string, hasGenerationTarget = false): BotanicAgentRequestRoute {
  const text = value.trim()
  if (/(?:prompt|提示词|提示语|提示词生成|写一段.*(?:提示|prompt)|润色提示)/iu.test(text)) return 'prompt'
  if (/(?:检索|搜索|查找|查一下|研究|资料|联网|外部来源|项目里|画布中|有哪些素材|哪些节点|多少个节点)/iu.test(text)) return 'research'
  if (/(?:你是谁|你能做什么|如何使用|怎么使用|怎么用|请解释|解释一下|日常聊天|闲聊)/iu.test(text)) return 'conversation'
  if (hasGenerationTarget || /(?:生成|生图|出图|图片|画面|换场景|换模特|换商品|换动作|换风格|重做|变体|批量)/iu.test(text)) return 'generation'
  return 'conversation'
}

export function buildBotanicAgentChatRequest(input: BotanicAgentChatRequestInput) {
  return {
    projectId: input.projectId,
    ...(input.plannerModel ? { plannerModel: input.plannerModel } : {}),
    mode: input.mode,
    messages: input.messages.slice(-16).map((message) => ({ role: message.role, content: message.content })),
    contextNodeIds: [...new Set(input.contextNodeIds)].slice(0, 32),
  }
}
