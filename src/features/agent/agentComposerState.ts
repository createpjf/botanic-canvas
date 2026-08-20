import type { BotanicAgentMentionQuery } from '../../domain/agent'
import type { BotanicAgentInstructionOptions } from '../../domain/agentInstructionRouting'
import type { GenerationSizeOverride } from '../../domain/generationOutputSize'

/** 指令选项的形状由路由领域模块拥有；这里只是重试命令沿用的别名。 */
export type AgentInstructionRetryOptions = BotanicAgentInstructionOptions

export type AgentFailedInstruction = {
  instruction: string
  options: AgentInstructionRetryOptions
}

export type AgentComposerState = {
  instruction: string
  error: string
  lastFailedInstruction: string
  lastFailedCommand?: AgentFailedInstruction
  lastFailedPlanMessageId: string
  mentionQuery?: BotanicAgentMentionQuery
  pendingGenerationOverrides: GenerationSizeOverride
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
