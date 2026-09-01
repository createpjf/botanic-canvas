import {
  normalizeBotanicAgentContextNodeIds,
  readBotanicAgentMentionQuery,
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

export type AgentDismissedMention = BotanicAgentMentionQuery & { token: string }

export type AgentComposerState = {
  instruction: string
  caret: number
  error: string
  lastFailedInstruction: string
  lastFailedCommand?: AgentFailedInstruction
  lastFailedPlanMessageId: string
  mentionQuery?: BotanicAgentMentionQuery
  dismissedMention?: AgentDismissedMention
  pendingGenerationOverrides: GenerationSizeOverride
  /** 失败 Run 恢复暂存的权威快照引用；下一次发送随指令结构化下发后清空。 */
  pendingRecoveryContextSnapshot?: BotanicAgentContextSnapshot[]
}

export const initialAgentComposerState: AgentComposerState = {
  instruction: '',
  caret: 0,
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


export type AgentComposerPersistedDraft = {
  instruction: string
  caret: number
}

export const AGENT_COMPOSER_DRAFT_MAX_CHARS = 8_192

export function agentComposerDraftStorageKey(projectId: string, sessionId: string) {
  return `botanic-agent-draft:v1:${encodeURIComponent(projectId)}:${encodeURIComponent(sessionId)}`
}

/** sessionStorage 只保存文本+caret;任何坏 JSON/越界内容 fail closed。 */
export function readAgentComposerDraft(
  storage: Pick<Storage, 'getItem'> | undefined,
  key: string,
): AgentComposerPersistedDraft | undefined {
  if (!storage || !key) return undefined
  try {
    const parsed = JSON.parse(storage.getItem(key) ?? 'null') as Partial<AgentComposerPersistedDraft> | null
    if (!parsed || typeof parsed.instruction !== 'string' || parsed.instruction.length > AGENT_COMPOSER_DRAFT_MAX_CHARS) return undefined
    const caret = Number(parsed.caret)
    if (!Number.isSafeInteger(caret) || caret < 0 || caret > parsed.instruction.length) return undefined
    return { instruction: parsed.instruction, caret }
  } catch {
    return undefined
  }
}

export function writeAgentComposerDraft(
  storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined,
  key: string,
  draft: AgentComposerPersistedDraft,
) {
  if (!storage || !key) return false
  try {
    if (!draft.instruction) {
      storage.removeItem(key)
      return true
    }
    const instruction = draft.instruction.slice(0, AGENT_COMPOSER_DRAFT_MAX_CHARS)
    const caret = Math.max(0, Math.min(instruction.length, Number(draft.caret) || 0))
    storage.setItem(key, JSON.stringify({ instruction, caret }))
    return true
  } catch {
    return false
  }
}

export function createAgentComposerState(draft?: AgentComposerPersistedDraft): AgentComposerState {
  return {
    ...initialAgentComposerState,
    instruction: draft?.instruction ?? '',
    caret: draft?.caret ?? 0,
    pendingGenerationOverrides: {},
  }
}

export function dismissAgentComposerMention(value: string, mention?: BotanicAgentMentionQuery): AgentDismissedMention | undefined {
  if (!mention) return undefined
  return { ...mention, token: value.slice(mention.start, mention.end) }
}

/**
 * Esc 后同一 token 保持关闭;只有该 token 文本/范围发生变化才恢复 popup。
 * 返回 dismissal 让 caller 保存在 per-session Composer state。
 */
export function resolveAgentComposerMention(
  value: string,
  caret: number,
  dismissed?: AgentDismissedMention,
): { mentionQuery?: BotanicAgentMentionQuery; dismissedMention?: AgentDismissedMention } {
  const mentionQuery = readBotanicAgentMentionQuery(value, caret)
  if (!dismissed) return mentionQuery ? { mentionQuery } : {}
  const tokenStillPresent = value.slice(dismissed.start, dismissed.end) === dismissed.token
  if (!tokenStillPresent) return mentionQuery ? { mentionQuery } : {}
  const same = mentionQuery
    && mentionQuery.trigger === dismissed.trigger
    && mentionQuery.start === dismissed.start
    && mentionQuery.end === dismissed.end
    && value.slice(mentionQuery.start, mentionQuery.end) === dismissed.token
  return {
    ...(same || !mentionQuery ? {} : { mentionQuery }),
    dismissedMention: dismissed,
  }
}


export type AgentComposerStates = Record<string, AgentComposerState>

export function reduceAgentComposerStates(
  states: AgentComposerStates,
  input: { key: string; base: AgentComposerState; patch: Partial<AgentComposerState> },
): AgentComposerStates {
  const current = states[input.key] ?? input.base
  return { ...states, [input.key]: agentComposerStateReducer(current, input.patch) }
}
