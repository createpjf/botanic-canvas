// @ts-check

import {
  buildThreadSummaryCheckpoint,
  hasThreadSummaryFactProvenance,
  renderThreadSummary,
  shouldCompactThread,
} from './agentThreadSummary.mjs'
import { agentEntityLimits } from './botanicAgentPersistence.mjs'
import { decodeAgentMessageCursor } from './agentMessagePersistence.mjs'
import {
  AGENT_CONTEXT_MESSAGE_OVERHEAD_TOKENS,
  AGENT_THREAD_CONTEXT_TOKEN_BUDGET,
  AGENT_THREAD_SUMMARY_TOKEN_BUDGET,
  agentContextMessageTokens,
  estimateAgentContextTokens,
  truncateAgentContextText,
} from './agentContextBudget.mjs'

const MODEL_MESSAGE_LIMIT = 16
const MODEL_MESSAGE_TEXT_LIMIT = 4000
const THREAD_HISTORY_PAGE_LIMIT = 200

export class AgentThreadContextError extends Error {
  constructor(code, message, statusCode) {
    super(message)
    this.name = 'AgentThreadContextError'
    this.code = code
    this.statusCode = statusCode
  }
}

export async function compareAndSetDerivedAgentThreadSummary({ productStore, userId, session, summary }) {
  if (typeof productStore?.compareAndSetAgentThreadSummary !== 'function') {
    throw new TypeError('Agent Thread Summary CAS Interface 缺失。')
  }
  const outcome = await productStore.compareAndSetAgentThreadSummary(userId, {
    sessionId: session.id,
    expectedUpdatedAt: session.threadSummary?.updatedAt ?? null,
    summary,
  })
  if (
    (outcome?.kind === 'updated' && outcome.changed === true)
    || (outcome?.kind === 'conflict' && outcome.changed === false)
  ) return outcome
  throw new AgentThreadContextError(
    'AGENT_THREAD_SUMMARY_CAS_REJECTED',
    'Agent Thread Summary CAS 返回了不受支持的结果。',
    409,
  )
}

function assertInputMessage(inputMessage) {
  if (
    !inputMessage
    || typeof inputMessage !== 'object'
    || Array.isArray(inputMessage)
    || typeof inputMessage.id !== 'string'
    || !inputMessage.id.trim()
    || inputMessage.role !== 'user'
    || typeof inputMessage.content !== 'string'
  ) {
    throw new AgentThreadContextError(
      'AGENT_THREAD_INPUT_INVALID',
      'Agent 当前输入必须是有稳定标识的用户消息。',
      400,
    )
  }
}

function authoritativeMessages(session, inputMessage) {
  const seen = new Set()
  const history = []
  for (const candidate of Array.isArray(session?.messages) ? session.messages : []) {
    if (
      !candidate
      || typeof candidate.id !== 'string'
      || !candidate.id.trim()
      || !['user', 'assistant'].includes(candidate.role)
      || typeof candidate.content !== 'string'
      || seen.has(candidate.id)
    ) continue
    seen.add(candidate.id)
    history.push(structuredClone(candidate))
  }
  const persistedInputIndex = history.findIndex((message) => message.id === inputMessage.id)
  const persistedInput = persistedInputIndex >= 0 ? history[persistedInputIndex] : undefined
  if (persistedInput && (
    persistedInput.role !== 'user'
    || (!persistedInput.content.trim() && !persistedInput.mentions?.length)
  )) {
    throw new AgentThreadContextError(
      'AGENT_THREAD_INPUT_CONFLICT',
      '当前消息标识已属于其它消息，无法安全重放本轮输入。',
      409,
    )
  }
  // 同一消息可能已经由离线队列先一步写入。此时服务端记录胜出，不能让请求体
  // 用相同 ID 改写模型即将看到的内容。较旧 pending Message 的首次 POST 可能晚于
  // 后续消息抵达；该请求的线性化点只能到自身（含），绝不能读取“未来消息”。
  const boundedHistory = persistedInputIndex >= 0
    ? history.slice(0, persistedInputIndex + 1)
    : history
  const messages = [...boundedHistory]
  if (!persistedInput) messages.push(structuredClone(inputMessage))
  const sourceInput = persistedInput ?? inputMessage
  const authoritativeInput = {
    id: sourceInput.id,
    role: 'user',
    kind: 'text',
    content: sourceInput.content,
    ...(Array.isArray(sourceInput.mentions) && sourceInput.mentions.length
      ? { mentions: structuredClone(sourceInput.mentions) }
      : {}),
    ...(Number.isFinite(Number(sourceInput.createdAt)) ? { createdAt: Number(sourceInput.createdAt) } : {}),
    ...(Number.isFinite(Number(sourceInput.updatedAt)) ? { updatedAt: Number(sourceInput.updatedAt) } : {}),
    ...(typeof sourceInput.turnId === 'string' && sourceInput.turnId.trim()
      ? { turnId: sourceInput.turnId.trim() }
      : {}),
    ...(Number.isFinite(Number(sourceInput.turnCancellationRequestedAt))
      ? { turnCancellationRequestedAt: Number(sourceInput.turnCancellationRequestedAt) }
      : {}),
    ...(sourceInput.turnRequestSnapshot && typeof sourceInput.turnRequestSnapshot === 'object'
      ? { turnRequestSnapshot: structuredClone(sourceInput.turnRequestSnapshot) }
      : {}),
  }
  return {
    history: boundedHistory,
    messages,
    hasFutureMessages: persistedInputIndex >= 0 && persistedInputIndex < history.length - 1,
    // Route 用这份权威实体在 accepted 前绑定稳定 Turn。若离线队列已经写入，必须
    // 保留服务端版本；尚未写入时才采用本轮已校验的用户输入。
    inputMessage: authoritativeInput,
  }
}

function mentionOnlyInstruction(mentions, locale) {
  if (!Array.isArray(mentions) || !mentions.length) return ''
  const hasSkill = mentions.some((mention) => mention?.kind === 'skill')
  const hasReference = mentions.some((mention) => mention?.kind === 'reference')
  if (locale === 'en') {
    if (hasSkill && hasReference) return 'Follow the mounted Skills and referenced assets.'
    if (hasSkill) return 'Follow the mounted Skills.'
    return 'Use the referenced assets.'
  }
  if (hasSkill && hasReference) return '按已挂载 Skill 与已引用素材处理。'
  if (hasSkill) return '按已挂载 Skill 执行。'
  return '按已引用素材处理。'
}

function projectedMessageContent(message, locale, currentMessageId) {
  const content = message.content.trim() || mentionOnlyInstruction(message.mentions, locale)
  return message.id === currentMessageId
    ? content
    : content.slice(0, MODEL_MESSAGE_TEXT_LIMIT)
}

function modelProjection(messages, locale, summaryBudget, currentMessageId) {
  const normalized = messages
    .map((message) => ({
      id: message.id,
      role: message.role,
      content: projectedMessageContent(message, locale, currentMessageId),
    }))
    .filter((message) => message.content)
  const candidates = normalized.slice(-MODEL_MESSAGE_LIMIT)
  const remainingBudget = Math.max(
    0,
    AGENT_THREAD_CONTEXT_TOKEN_BUDGET - summaryBudget.estimatedTokens,
  )
  let remaining = remainingBudget
  const selected = []
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index]
    const tokens = agentContextMessageTokens(candidate)
    // candidates 最后一条是 authoritativeMessages 截止后的当前输入。
    // 它必须保留；单条字符上限 + Summary 上限保证它不会撑破总预算。
    if (candidate.id === currentMessageId || tokens <= remaining) {
      selected.unshift(candidate)
      remaining = Math.max(0, remaining - tokens)
      continue
    }
    // 保留连续的最新窗口；不跳过一条大消息去拼更旧的小消息。
    break
  }
  const projectedMessages = selected.map(({ role, content }) => ({ role, content }))
  const messageTokens = selected.reduce((sum, message) => sum + agentContextMessageTokens(message), 0)
  return {
    messages: projectedMessages,
    contextBudget: {
      limit: AGENT_THREAD_CONTEXT_TOKEN_BUDGET,
      estimatedTokens: summaryBudget.estimatedTokens + messageTokens,
      messageTokens,
      summaryTokens: summaryBudget.estimatedTokens,
      summaryLimit: summaryBudget.limit,
      summaryTruncated: summaryBudget.truncated,
      summaryOmittedCharacters: summaryBudget.omittedCharacters,
      omittedMessages: normalized.length - selected.length,
    },
  }
}

/**
 * 首次建摘要时回溯 ProductStore 允许保留的整个会话窗口。
 *
 * 上限与 `agentEntityLimits.messagesPerSession` 同源，最多 200 + 200 + 100，
 * 避免一个存量会话把回合请求变成无界扫描。旧页读取失败时保留
 * 已取到的权威窗口供当轮使用，但不写回不完整检查点，下轮仍可重试回溯。
 */
async function backfillInitialSummaryHistory({ productStore, userId, projectId, sessionId, firstPage }) {
  const history = [...(firstPage.messages ?? [])]
  let nextBefore = firstPage.nextBefore
  const seenCursors = new Set()
  let complete = true

  while (nextBefore && history.length < agentEntityLimits.messagesPerSession) {
    if (seenCursors.has(nextBefore)) {
      complete = false
      break
    }
    seenCursors.add(nextBefore)
    const remaining = agentEntityLimits.messagesPerSession - history.length
    try {
      const older = await productStore.listAgentSessionMessages(userId, projectId, sessionId, {
        limit: Math.min(THREAD_HISTORY_PAGE_LIMIT, remaining),
        before: decodeAgentMessageCursor(nextBefore),
      })
      if (!older) {
        complete = false
        break
      }
      history.unshift(...(older.messages ?? []))
      nextBefore = older.nextBefore
    } catch {
      complete = false
      break
    }
  }

  return { history, complete }
}

/**
 * 服务端拥有的线程投影 Module。
 *
 * Interface 只接受当前用户消息；历史一律从 ProductStore 的权威 Session/Message
 * 读取。摘要是可丢失的派生层，失败不能降级成信任客户端历史。
 */
export function createAgentThreadContext(dependencies) {
  const { productStore } = dependencies ?? {}
  const now = typeof dependencies?.now === 'function' ? dependencies.now : () => Date.now()
  if (
    typeof productStore?.listAgentSessions !== 'function'
    || typeof productStore?.listAgentSessionMessages !== 'function'
    || typeof productStore?.compareAndSetAgentThreadSummary !== 'function'
  ) {
    throw new TypeError('Agent Thread Context 缺少 ProductStore 会话、消息分页或 Summary CAS Interface。')
  }

  return Object.freeze({
    async resolve(input) {
      const { userId, projectId, sessionId, inputMessage, locale } = input ?? {}
      assertInputMessage(inputMessage)
      const sessions = await productStore.listAgentSessions(userId, projectId, { limit: 80 })
      const storedSession = (sessions ?? []).find((candidate) => candidate?.id === sessionId)
      if (!storedSession) {
        throw new AgentThreadContextError(
          'AGENT_SESSION_NOT_FOUND',
          '未找到当前 Agent 会话，无法建立权威线程上下文。',
          404,
        )
      }
      const page = await productStore.listAgentSessionMessages(userId, projectId, sessionId, {
        limit: THREAD_HISTORY_PAGE_LIMIT,
      })
      if (!page) {
        throw new AgentThreadContextError(
          'AGENT_SESSION_NOT_FOUND',
          '未找到当前 Agent 会话，无法建立权威线程上下文。',
          404,
        )
      }
      const firstPageMessages = page.messages ?? []
      const inputInFirstPage = firstPageMessages.some((message) => message?.id === inputMessage.id)
      const legacyThreadSummary = Boolean(storedSession.threadSummary)
        && !hasThreadSummaryFactProvenance(storedSession.threadSummary)
      let summaryHistory = firstPageMessages
      let summaryHistoryComplete = storedSession.threadSummary && !legacyThreadSummary
        ? true
        : !page.nextBefore
      let historyCompleteForRebuild = !page.nextBefore
      let historyPositionUnresolved = false
      // 无摘要时需要完整回溯建首个检查点；有摘要但当前输入
      // 不在最新页时，也必须有界回溯定位它，否则会把整个最新页
      // 误当成该旧 Turn 的“过去”。
      if (page.nextBefore && (!storedSession.threadSummary || legacyThreadSummary || !inputInFirstPage)) {
        const backfill = await backfillInitialSummaryHistory({
          productStore, userId, projectId, sessionId, firstPage: page,
        })
        summaryHistory = backfill.history
        historyCompleteForRebuild = backfill.complete
        if (!storedSession.threadSummary || legacyThreadSummary) summaryHistoryComplete = backfill.complete
        if (!backfill.complete && !summaryHistory.some((message) => message?.id === inputMessage.id)) {
          // 无法证明当前 ID 是全新输入还是旧页中的延迟提交。
          // 安全退化为仅当前输入，不读取可能属于未来的最新页。
          summaryHistory = []
          historyPositionUnresolved = true
        }
      }
      const session = { ...storedSession, messages: summaryHistory }

      const {
        history,
        messages,
        hasFutureMessages,
        inputMessage: authoritativeInputMessage,
      } = authoritativeMessages(session, inputMessage)
      // Session Summary 是会话当前最新的派生检查点，不是任意历史 Turn
      // 都能读的 MVCC 版本。旧 pending Message 后面已有新消息时，该摘要
      // 可能已经固化了未来目标/决策/实体；必须从当轮截止历史无 previous
      // 重建，且不得回写覆盖当前 Session 的更新摘要。
      const historicalCutoff = hasFutureMessages || historyPositionUnresolved
      const rebuildLegacyFromFullHistory = legacyThreadSummary && historyCompleteForRebuild
      const previousThreadSummary = historicalCutoff || rebuildLegacyFromFullHistory
        ? undefined
        : session.threadSummary
      let threadSummary = previousThreadSummary
      // 当前 inputMessage 还可能只在浏览器 outbox，尚未成为权威 Message。它进入本轮
      // 模型尾部，但只有持久化历史可以进入长期检查点。
      // 从零重建摘要必须拥有截止点之前的完整有界历史；
      // previous 存在的正常最新 Turn 可以只做增量。
      if (shouldCompactThread(history) && (previousThreadSummary || historyCompleteForRebuild)) {
        const checkpointAt = Math.max(
          (Number(session.updatedAt) || 0) + 1,
          (Number(session.threadSummary?.updatedAt) || 0) + 1,
          Number(now()) || Date.now(),
        )
        const derived = buildThreadSummaryCheckpoint({
          messages: history,
          previous: previousThreadSummary,
          now: checkpointAt,
          fullHistory: historyCompleteForRebuild,
        })
        if (derived) threadSummary = derived
        if (
          derived
          && derived !== previousThreadSummary
          && summaryHistoryComplete
          && !historicalCutoff
        ) {
          await compareAndSetDerivedAgentThreadSummary({ productStore, userId, session, summary: derived })
        }
      }

      const contextLocale = authoritativeInputMessage.turnRequestSnapshot?.locale ?? locale
      const renderedThreadSummary = renderThreadSummary(threadSummary, { locale: contextLocale })
      const currentProjectedContent = projectedMessageContent(
        authoritativeInputMessage,
        contextLocale,
        authoritativeInputMessage.id,
      )
      const currentInputTokens = estimateAgentContextTokens(currentProjectedContent)
        + AGENT_CONTEXT_MESSAGE_OVERHEAD_TOKENS
      if (currentInputTokens > AGENT_THREAD_CONTEXT_TOKEN_BUDGET) {
        throw new AgentThreadContextError(
          'AGENT_THREAD_INPUT_TOO_LARGE',
          'Agent 当前输入超过可支持的线程上下文预算，请精简后重试。',
          413,
        )
      }
      const effectiveSummaryLimit = Math.min(
        AGENT_THREAD_SUMMARY_TOKEN_BUDGET,
        AGENT_THREAD_CONTEXT_TOKEN_BUDGET - currentInputTokens,
      )
      const boundedThreadSummary = truncateAgentContextText(
        renderedThreadSummary,
        effectiveSummaryLimit,
      )
      const projection = modelProjection(
        messages,
        contextLocale,
        { ...boundedThreadSummary, limit: effectiveSummaryLimit },
        authoritativeInputMessage.id,
      )
      const projectedMessages = projection.messages
      const threadSummaryText = boundedThreadSummary.text
      const threadContextSnapshot = {
        version: 1,
        messages: structuredClone(projectedMessages),
        ...(threadSummary ? {
          threadSummary: structuredClone(threadSummary),
          threadSummaryText,
        } : {}),
        contextBudget: structuredClone(projection.contextBudget),
      }
      return {
        // Message 先于 Turn durable 时，快照 locale 才是该请求的不可变语言身份；
        // 当前页面的 locale 可能已经变化，不能影响 mention-only 模型投影。
        messages: projectedMessages,
        inputMessage: authoritativeInputMessage,
        ...(threadSummary ? {
          threadSummary: structuredClone(threadSummary),
          threadSummaryText,
        } : {}),
        contextBudget: projection.contextBudget,
        threadContextSnapshot,
      }
    },
  })
}
