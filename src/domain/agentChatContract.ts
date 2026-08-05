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
  /** Prompt 模式的可执行结果；后续生成不从普通解释文字猜测。 */
  prompt?: string
  mode: BotanicAgentChatMode
  plannerModel?: string
  toolCalls?: BotanicAgentChatToolCall[]
  sources?: string[]
}

const refersToPreviousPrompt = /(?:这个|上面的?|刚才的?|上一条|该).{0,8}(?:prompt|提示词|提示语)|(?:按照|按|使用|用|基于|拿).{0,6}(?:这个|上面的?|刚才的?|上一条|该).{0,8}(?:生成|生图|出图|做一张|来一张)/iu

export function resolveBotanicAgentGenerationPrompt(
  instruction: string,
  messages: Pick<BotanicAgentMessage, 'role' | 'content' | 'prompt'>[],
) {
  const cleanInstruction = instruction.trim()
  if (!refersToPreviousPrompt.test(cleanInstruction)) return cleanInstruction
  const promptMessage = [...messages].reverse().find((message) => message.role === 'assistant' && message.prompt?.trim())
  return promptMessage?.prompt?.trim() || cleanInstruction
}

/**
 * 通用 Agent 先路由，再决定是否进入生图 Planner；显式 Prompt/检索请求不应误触发生成。
 */
export function classifyBotanicAgentRequest(value: string, hasGenerationTarget = false): BotanicAgentRequestRoute {
  const text = value.trim()
  const asksAboutPreviousOutcome = /(?:没有|没|未).{0,8}(?:生成|生图|出图|结果)|(?:刚才|之前|上次)?.{0,6}(?:为什么|为何|怎么).{0,16}(?:没|未|不).{0,6}(?:成功|生成|反应|结果)|(?:效果|结果|这张|这个).{0,10}(?:好吗|如何|怎么样|是否|吗|呢|呀)\s*[?？]?$/iu.test(text)
  if (asksAboutPreviousOutcome) return 'conversation'
  const explicitlyUsesPromptForGeneration = /(?:按照|使用|用|基于|拿).{0,16}(?:prompt|提示词|提示语).{0,16}(?:生成|生图|出图|做一张|来一张)/iu.test(text)
  if (explicitlyUsesPromptForGeneration) return 'generation'
  if (/(?:prompt|提示词|提示语|提示词生成|写一段.*(?:提示|prompt)|润色提示)/iu.test(text)) return 'prompt'
  if (/(?:检索|搜索|查找|查一下|研究|资料|联网|外部来源|项目里|画布中|有哪些素材|哪些节点|多少个节点)/iu.test(text)) return 'research'
  if (/(?:你是谁|你能做什么|如何使用|怎么使用|怎么用|请解释|解释一下|日常聊天|闲聊)/iu.test(text)) return 'conversation'
  const changesVisual = /(?:换|替换|改|调整).{0,16}(?:场景|背景|模特|商品|动作|风格|光线|构图)/iu.test(text)
  if ((hasGenerationTarget && /(?:保持|继续|再来|重试|重新|换|替换|调整)/iu.test(text))
    || changesVisual
    || /(?:生成|生图|出图|图片|画面|换场景|换模特|换商品|换动作|换风格|重做|变体|批量)/iu.test(text)) return 'generation'
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
