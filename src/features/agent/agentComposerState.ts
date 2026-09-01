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
import type { AgentQueuedInstruction } from './agentComposerQueue.ts'

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
  queuedInstructions: AgentQueuedInstruction[]
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
  queuedInstructions: [],
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


export type AgentComposerHistoryState = {
  cursor?: number
  recalledText?: string
}

export type AgentComposerHistoryNavigation = {
  handled: boolean
  state: AgentComposerHistoryState
  text?: string
  caret?: number
}

export const initialAgentComposerHistoryState: AgentComposerHistoryState = {}

/**
 * Shell-style history:空输入可进入;召回后只有文本未改且 caret 在边界才继续,
 * 不劫持普通多行 Up/Down。越过最新恢复空草稿。
 */
export function navigateAgentComposerHistory(input: {
  state: AgentComposerHistoryState
  entries: readonly string[]
  direction: 'older' | 'newer'
  text: string
  caret: number
}): AgentComposerHistoryNavigation {
  const entries = input.entries.map((entry) => entry.trim()).filter(Boolean)
  if (!entries.length) return { handled: false, state: input.state }
  const browsing = input.state.cursor !== undefined
  if (input.text) {
    const atBoundary = input.caret === 0 || input.caret === input.text.length
    if (!atBoundary || input.state.recalledText !== input.text) return { handled: false, state: input.state }
  } else if (!browsing && input.direction === 'newer') {
    return { handled: false, state: input.state }
  }

  if (input.direction === 'older') {
    const cursor = input.state.cursor === undefined
      ? entries.length - 1
      : Math.max(0, input.state.cursor - 1)
    const text = entries[cursor]
    return { handled: true, state: { cursor, recalledText: text }, text, caret: text.length }
  }

  const current = input.state.cursor
  if (current === undefined) return { handled: false, state: input.state }
  if (current + 1 >= entries.length) {
    return { handled: true, state: {}, text: '', caret: 0 }
  }
  const cursor = current + 1
  const text = entries[cursor]
  return { handled: true, state: { cursor, recalledText: text }, text, caret: text.length }
}

function normalizedSuggestionText(value: string) {
  return value.normalize('NFKC').trim().toLocaleLowerCase()
}

/** exact > prefix > substring > ordered subsequence;中文按字符工作。-1 表示不匹配。 */
export function agentSuggestionFuzzyScore(value: string, query: string) {
  const source = normalizedSuggestionText(value)
  const target = normalizedSuggestionText(query)
  if (!target) return 0
  if (source === target) return 1_000
  if (source.startsWith(target)) return 800 - Math.min(200, source.length - target.length)
  const containedAt = source.indexOf(target)
  if (containedAt >= 0) return 600 - Math.min(200, containedAt * 4)
  let sourceIndex = 0
  let score = 300
  let previous = -2
  for (const character of target) {
    const found = source.indexOf(character, sourceIndex)
    if (found < 0) return -1
    score += found === previous + 1 ? 12 : Math.max(1, 8 - (found - sourceIndex))
    previous = found
    sourceIndex = found + 1
  }
  return score - Math.min(100, source.length - target.length)
}

export function rankAgentSuggestions<T>(
  items: readonly T[],
  query: string,
  searchable: (item: T) => readonly string[],
): T[] {
  if (!query.trim()) return [...items]
  return items
    .map((item, index) => ({
      item,
      index,
      score: Math.max(...searchable(item).map((value) => agentSuggestionFuzzyScore(value, query))),
    }))
    .filter((entry) => entry.score >= 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.item)
}
