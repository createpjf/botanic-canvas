import type { BotanicAgentMentionQuery, BotanicAgentResolvedGeneration, BotanicCreativeBrief } from '../../domain/agent'
import type { GenerationSizeOverride } from '../../domain/generationOutputSize'

export type AgentInstructionRetryOptions = {
  generationOverrides?: GenerationSizeOverride
  clarificationAnswers?: Record<string, string>
  creativeBrief?: BotanicCreativeBrief
  sourcePromptMessageId?: string
  /** 上一轮已由服务端判定的生成结论；重放追问时据此直接进入生成，不再二次分类。 */
  resolvedGeneration?: BotanicAgentResolvedGeneration
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
