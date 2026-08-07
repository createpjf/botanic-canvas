import type { BotanicAgentMentionQuery } from '../../domain/agent'
import type { GenerationSettings } from '../../domain/canvas'

export type AgentInstructionRetryOptions = {
  generationOverrides?: Partial<Pick<GenerationSettings, 'model' | 'aspectRatio' | 'resolution'>>
  clarificationAnswers?: Record<string, string>
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
  pendingGenerationOverrides: Partial<Pick<GenerationSettings, 'model' | 'aspectRatio' | 'resolution'>>
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
