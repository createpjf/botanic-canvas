import {
  normalizeBotanicAgentContextNodeIds,
  type BotanicAgentContextSnapshot,
  type BotanicAgentMentionQuery,
  type BotanicAgentMessage,
  type BotanicAgentSession,
} from '../../domain/agent.ts'
import type { BotanicAgentInstructionOptions } from '../../domain/agentInstructionRouting'
import type { GenerationSizeOverride } from '../../domain/generationOutputSize'

/** 指令选项的形状由路由领域模块拥有；这里只是重试命令沿用的别名。 */
export type AgentInstructionRetryOptions = BotanicAgentInstructionOptions

export type AgentFailedInstruction = {
  instruction: string
  options: AgentInstructionRetryOptions
  sourceMessageId?: string
  requestId?: string
  turnId?: string
}

export function resolveAgentRetrySourceMessage(
  messages: BotanicAgentMessage[],
  sourceMessageId?: string,
): BotanicAgentMessage | undefined {
  if (!sourceMessageId) return undefined
  return messages.find((message) => message.role === 'user' && message.id === sourceMessageId)
}

export function nextAgentSuggestionIndex(
  current: number,
  count: number,
  key: 'ArrowDown' | 'ArrowUp',
) {
  if (count < 1) return 0
  return (current + (key === 'ArrowDown' ? 1 : -1) + count) % count
}

export function applyAgentSessionContextChange(input: {
  session?: BotanicAgentSession
  nodeIds: string[]
  locale: 'zh-CN' | 'en'
  onChange: (sessionId: string, nodeIds: string[]) => void
  onError: (message: string) => void
}) {
  if (!input.session) return false
  try {
    input.onChange(input.session.id, normalizeBotanicAgentContextNodeIds(input.nodeIds))
    input.onError('')
    return true
  } catch {
    input.onError(input.locale === 'en'
      ? 'You can select up to 32 context items. Remove one before adding another.'
      : '上下文最多选择 32 项，请先移除一项再添加。')
    return false
  }
}

export type AgentComposerState = {
  instruction: string
  error: string
  lastFailedInstruction: string
  lastFailedCommand?: AgentFailedInstruction
  lastFailedPlanMessageId: string
  mentionQuery?: BotanicAgentMentionQuery
  pendingGenerationOverrides: GenerationSizeOverride
  /** 失败 Run 恢复暂存的权威快照引用；下一次发送随指令结构化下发后清空。 */
  pendingRecoveryContextSnapshot?: BotanicAgentContextSnapshot[]
}

export const initialAgentComposerState: AgentComposerState = {
  instruction: '',
  error: '',
  lastFailedInstruction: '',
  lastFailedCommand: undefined,
  lastFailedPlanMessageId: '',
  pendingGenerationOverrides: {},
}

export function agentComposerStateReducer(
  state: AgentComposerState,
  patch: Partial<AgentComposerState>,
): AgentComposerState {
  return { ...state, ...patch }
}
