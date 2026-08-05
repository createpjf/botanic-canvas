import type { BotanicAgentMentionQuery } from '../../domain/agent'
import type { GenerationSettings } from '../../domain/canvas'

export type AgentComposerState = {
  instruction: string
  error: string
  lastFailedInstruction: string
  lastFailedPlanMessageId: string
  mentionQuery?: BotanicAgentMentionQuery
  pendingGenerationOverrides: Partial<Pick<GenerationSettings, 'model' | 'aspectRatio' | 'resolution'>>
}

export const initialAgentComposerState: AgentComposerState = {
  instruction: '',
  error: '',
  lastFailedInstruction: '',
  lastFailedPlanMessageId: '',
  pendingGenerationOverrides: {},
}

export function agentComposerStateReducer(
  state: AgentComposerState,
  patch: Partial<AgentComposerState>,
): AgentComposerState {
  return { ...state, ...patch }
}
