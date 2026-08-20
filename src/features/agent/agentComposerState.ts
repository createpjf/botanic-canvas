import type { BotanicAgentMentionQuery, BotanicCreativeBrief } from '../../domain/agent'
import type { GenerationSizeOverride } from '../../domain/generationOutputSize'

export type AgentInstructionRetryOptions = {
  generationOverrides?: GenerationSizeOverride
  clarificationAnswers?: Record<string, string>
  creativeBrief?: BotanicCreativeBrief
  sourcePromptMessageId?: string
}

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
