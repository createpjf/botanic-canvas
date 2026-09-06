import { canonicalHash } from '../../canonicalHash.mjs'
import { estimateAgentContextTokens, truncateAgentContextText } from './agentContextBudget.mjs'

const OVERFLOW_RETRY_TOKEN_BUDGET = 6_000
const OVERFLOW_TOOL_CONTENT_TOKEN_BUDGET = 128
const OVERFLOW_HISTORY_MESSAGE_TOKEN_BUDGET = 512

function conversationEntryTokens(entry) {
  return estimateAgentContextTokens(JSON.stringify(entry)) + 4
}

function compactedHistoricalToolArguments(raw) {
  let identity = typeof raw === 'string' ? raw : ''
  try { identity = JSON.parse(identity) } catch { /* 损坏参数仍用原文哈希定格。 */ }
  return JSON.stringify({
    _botanicCompacted: true,
    argumentsHash: canonicalHash(identity),
  })
}

function groupedAgentConversation(messages) {
  const systems = []
  const groups = []
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message?.role === 'system') {
      systems.push(structuredClone(message))
      continue
    }
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      const callIds = new Set(message.tool_calls.map((call) => call?.id).filter(Boolean))
      const paired = []
      let cursor = index + 1
      while (cursor < messages.length && messages[cursor]?.role === 'tool') {
        if (callIds.has(messages[cursor].tool_call_id)) paired.push(structuredClone(messages[cursor]))
        cursor += 1
      }
      groups.push({ kind: 'tool', messages: [structuredClone(message), ...paired] })
      index = cursor - 1
      continue
    }
    // 孤立 tool message 不能在严格重试里单独保留，否则 Provider
    // 会因 assistant tool_call 缺失而拒绝整轮。
    if (message?.role === 'tool') continue
    groups.push({ kind: 'message', messages: [structuredClone(message)] })
  }
  return { systems, groups }
}

function compactAgentConversationGroup(group, { preserveContent = false } = {}) {
  if (group.kind === 'tool') {
    const [assistant, ...toolMessages] = group.messages
    const assistantContent = typeof assistant.content === 'string'
      ? truncateAgentContextText(assistant.content, OVERFLOW_TOOL_CONTENT_TOKEN_BUDGET, { marker: '…' }).text
      : assistant.content
    return {
      kind: 'tool',
      messages: [{
        ...assistant,
        content: assistantContent,
        tool_calls: assistant.tool_calls.map((call) => ({
          ...call,
          function: {
            ...call.function,
            arguments: compactedHistoricalToolArguments(call?.function?.arguments),
          },
        })),
      }, ...toolMessages.map((message) => ({
        ...message,
        content: truncateAgentContextText(
          typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? null),
          OVERFLOW_TOOL_CONTENT_TOKEN_BUDGET,
          { marker: '…' },
        ).text,
      }))],
    }
  }
  const [message] = group.messages
  if (preserveContent || typeof message?.content !== 'string') return group
  return {
    kind: group.kind,
    messages: [{
      ...message,
      content: truncateAgentContextText(
        message.content,
        OVERFLOW_HISTORY_MESSAGE_TOKEN_BUDGET,
        { marker: '…' },
      ).text,
    }],
  }
}

/**
 * 只用于 Provider 明确报 context overflow 的同一 model step 重试。
 * system 与当前用户输入保持原样；历史 tool_call + tool message 作为
 * 原子组保留，不会产生孤立 tool message，也不会再执行工具。
 */
export function strictOverflowRetryConversation(messages) {
  const { systems, groups } = groupedAgentConversation(messages)
  const latestUserIndex = groups.findLastIndex((group) => (
    group.messages.some((message) => message?.role === 'user')
  ))
  const latestGroupIndex = groups.length - 1
  const required = new Set([latestUserIndex, latestGroupIndex].filter((index) => index >= 0))
  const compactGroups = groups.map((group, index) => compactAgentConversationGroup(group, {
    preserveContent: index === latestUserIndex,
  }))
  const originalTokens = messages.reduce((sum, message) => sum + conversationEntryTokens(message), 0)
  const systemTokens = systems.reduce((sum, message) => sum + conversationEntryTokens(message), 0)
  const groupTokens = compactGroups.map((group) => (
    group.messages.reduce((sum, message) => sum + conversationEntryTokens(message), 0)
  ))
  const requiredTokens = [...required].reduce((sum, index) => sum + groupTokens[index], systemTokens)
  const target = Math.max(
    requiredTokens,
    Math.min(OVERFLOW_RETRY_TOKEN_BUDGET, Math.max(1, Math.floor(originalTokens * 0.6))),
  )
  let used = systemTokens
  let optionalWindowClosed = false
  const selected = new Set()
  for (let index = compactGroups.length - 1; index >= 0; index -= 1) {
    if (required.has(index)) {
      selected.add(index)
      used += groupTokens[index]
      continue
    }
    if (optionalWindowClosed || used + groupTokens[index] > target) {
      optionalWindowClosed = true
      continue
    }
    selected.add(index)
    used += groupTokens[index]
  }
  return [
    ...systems,
    ...compactGroups.flatMap((group, index) => selected.has(index) ? group.messages : []),
  ]
}
