import type { AgentToolCallTrace, BotanicAgentClarificationResponse, BotanicAgentPlan, BotanicAgentReasoningEntry } from './agent'
import type { BotanicAgentChatResponse } from './agentChatContract'
import type { BotanicAgentTurnResult } from './agentTurnContract'
import type { TimelineToolPresentation, AgentTimelineEvent } from './agentTimeline'
import { readAgentReferenceUsage, type AgentReferenceUsageItem } from './agentReferenceUsage.ts'
import type { ProductLocale } from '../i18n/core'
import { AGENT_STREAM_EVENT_TYPE_VALUES } from './agentProtocol.generated.ts'
import { timelineOperationTiming, validTimestamp } from './agentTimelineTiming.ts'

/**
 * Agent 实时通道的事件契约（chat / turn / plan 共用）。
 *
 * `tool` 仅在服务端 registry.execute 前发 running、后发终态；禁止客户端预插成功。
 * `done` 携带与一次性接口一致的业务体——实时通道只改变“什么时候到”，不改变结果本身。
 * 原始 `reasoning_content` 默认不下发；摘要级 why 经 tool.summary 展示。
 */
/**
 * `sequence` 是 `(turnId, sequence)` 稳定游标的客户端一侧。断线重连时客户端凭它
 * 续读，因此它必须随事件体下发 —— 只写 SSE 的 `id:` 行不够：本仓库用 fetch 手工
 * 解析而不是原生 EventSource，`Last-Event-ID` 需要我们自己带上去。
 */
export type BotanicAgentStreamEvent = ({ sequence?: number; attemptId?: string; occurredAt?: number }) & (
  | { type: 'attempt'; action: 'start'; attemptId: string }
  | {
      type: 'accepted'
      turnId: string
      runtimeTurn: { id: string; projectId: string; createdAt?: number }
      observer: { url: string }
    }
  | {
      type: 'handoff'
      turnId: string
      runtimeTurn?: {
        id: string
        status: 'queued' | 'running' | 'waiting_user' | 'cancelling' | 'completed' | 'failed' | 'cancelled'
        projectId: string
        createdAt?: number
      }
      observer: { url: string }
    }
  | { type: 'reasoning'; step: number; delta: string; chunkIndex?: number }
  | { type: 'answer'; step: number; delta: string; chunkIndex?: number }
  | { type: 'answer_snapshot'; attemptId: string; revision: number; step: number; text: string; truncated?: boolean }
  | { type: 'tool'; step: number; toolCall: AgentToolCallTrace; presentation?: TimelineToolPresentation }
  | { type: 'references'; attemptId: string; items: AgentReferenceUsageItem[] }
  | {
      type: 'done'
      response?: BotanicAgentChatResponse
      turn?: BotanicAgentTurnResult
      /** Turn Runtime V2 的持久化生命周期快照；旧客户端可忽略。 */
      runtimeTurn?: {
        id: string
        status: 'queued' | 'running' | 'waiting_user' | 'cancelling' | 'completed' | 'failed' | 'cancelled'
        projectId: string
        updatedAt?: number
        createdAt?: number
      }
      result?: BotanicAgentTurnResult
      plan?: BotanicAgentPlan
      clarification?: BotanicAgentClarificationResponse['clarification']
      reasoning?: BotanicAgentReasoningEntry[]
    }
  | { type: 'error'; code?: string; message?: string }
)

/** 对话流事件；与 BotanicAgentStreamEvent 同构，保留别名以免旧导入断裂。 */
export type BotanicAgentChatStreamEvent = BotanicAgentStreamEvent

const streamEventTypes: ReadonlySet<string> = new Set(AGENT_STREAM_EVENT_TYPE_VALUES)

function parseStreamEvent(payload: string): BotanicAgentStreamEvent[] {
  try {
    const value = JSON.parse(payload) as Record<string, unknown>
    if (!value || typeof value !== 'object' || typeof value.type !== 'string') return []
    if (!streamEventTypes.has(value.type)) return []
    if (value.type === 'references') {
      const references = readAgentReferenceUsage(value)
      return references ? [{ ...references, type: 'references',
        ...(typeof value.sequence === 'number' ? { sequence: value.sequence } : {}),
        ...(typeof value.occurredAt === 'number' ? { occurredAt: value.occurredAt } : {}),
      }] : []
    }
    return [value as BotanicAgentStreamEvent]
  } catch {
    // 心跳、注释或截断片段不应中断整轮读取。
    return []
  }
}

/**
 * 浏览器在 SSE 读到一半被掐断时，经常抛出 `network error` / `Failed to fetch`，
 * 而不是服务端那句中文错误。展示层只消费这一句，不能把原生英文漏给用户。
 */
export function botanicAgentChatTransportErrorMessage(
  caught: unknown,
  options: { idleTimedOut?: boolean; fallback?: string; locale?: ProductLocale } = {},
) {
  const fallback = options.fallback ?? (options.locale === 'en' ? 'Agent is temporarily unavailable. Try again shortly.' : 'Agent 暂时无法回答，请稍后重试。')
  const disconnected = options.locale === 'en' ? 'Agent connection was interrupted. Try again.' : 'Agent 对话连接中断，请重试。'
  if (options.idleTimedOut) return disconnected
  const name = caught instanceof Error ? caught.name : ''
  const message = caught instanceof Error ? caught.message.trim() : ''
  if (
    name === 'AbortError'
    || name === 'TimeoutError'
    || /^(network error|failed to fetch|fetch failed|load failed|the network connection was lost\.?|networkerror when attempting to fetch resource\.?|the user aborted a request\.?|the operation was aborted\.?|signal is aborted without reason)$/i.test(message)
  ) {
    return disconnected
  }
  if (options.locale === 'en') return fallback
  return message || fallback
}

/** 流协议到时间线的边界映射；使用服务端事件时间，缺少时才取接收时间。 */
export function agentTimelineEventFromStream(
  event: BotanicAgentChatStreamEvent,
  receivedAt: number,
): AgentTimelineEvent {
  const eventAt = Number.isSafeInteger(event.occurredAt) && Number(event.occurredAt) >= 0
    ? Number(event.occurredAt)
    : receivedAt
  if (event.type === 'attempt') return { type: 'attempt', action: 'start', attemptId: event.attemptId, receivedAt: eventAt }
  if (event.type === 'references') return { type: 'references', attemptId: event.attemptId, items: event.items, receivedAt: eventAt }
  if (event.type === 'handoff' || event.type === 'accepted') return {
    type: 'handoff', receivedAt: eventAt,
    ...(validTimestamp(event.runtimeTurn?.createdAt) !== undefined ? { startedAt: validTimestamp(event.runtimeTurn?.createdAt) } : {}),
  }
  if (event.type === 'reasoning' || event.type === 'answer') return {
    type: event.type, step: event.step, delta: event.delta,
    ...(event.attemptId ? { attemptId: event.attemptId } : {}),
    ...(event.chunkIndex === undefined ? {} : { chunkIndex: event.chunkIndex }), receivedAt: eventAt,
  }
  if (event.type === 'answer_snapshot') return {
    type: 'answer_snapshot', attemptId: event.attemptId, revision: event.revision,
    step: event.step, text: event.text, ...(event.truncated ? { truncated: true } : {}), receivedAt: eventAt,
  }
  if (event.type === 'tool') return {
    type: event.type, step: event.step, toolCall: event.toolCall,
    ...(event.attemptId ? { attemptId: event.attemptId } : {}),
    ...(event.presentation ? { presentation: event.presentation } : {}), receivedAt: eventAt,
  }
  if (event.type === 'error') return { type: 'error', ...(event.message ? { message: event.message } : {}), receivedAt: eventAt }
  return { type: 'done', receivedAt: eventAt, ...(event.runtimeTurn ? { timing: timelineOperationTiming(event.runtimeTurn) } : {}) }
}

/** SSE 文本读取器：容忍跨块、CRLF、注释及截断；解码与网络由调用方负责。 */
export function createBotanicAgentChatStreamReader() {
  let buffer = ''
  let dataLines: string[] = []
  let pendingId: string | undefined
  let lastEventId = ''

  const flushEvent = (): BotanicAgentStreamEvent[] => {
    if (!dataLines.length) {
      pendingId = undefined
      return []
    }
    const payload = dataLines.join('\n')
    dataLines = []
    const parsed = parseStreamEvent(payload)
    // 只有成功派发的事件才推进游标。一条解析失败的事件如果推进了 lastEventId，
    // 重连时会从它之后续读，那条事件就被永久跳过了。
    if (parsed.length && pendingId !== undefined) lastEventId = pendingId
    pendingId = undefined
    return parsed
  }

  return {
    /**
     * 最近一条成功派发事件的 SSE id。重连时作为 `Last-Event-ID` 带回服务端；
     * 尚未收到任何可解析事件时为空字符串。
     */
    get lastEventId() { return lastEventId },
    /** 送入一段已解码的文本，返回其中完整的事件。 */
    push(chunk: string): BotanicAgentStreamEvent[] {
      buffer += chunk
      const events: BotanicAgentStreamEvent[] = []
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '')
        buffer = buffer.slice(newlineIndex + 1)
        if (!line) events.push(...flushEvent())
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
        // id: 归属它所在的那个事件，因此先暂存，等事件派发时再决定是否推进游标。
        else if (line.startsWith('id:')) pendingId = line.slice(3).replace(/^ /, '')
        // 其余字段（event / retry / 注释行）当前不需要。
        newlineIndex = buffer.indexOf('\n')
      }
      return events
    },
    /** 流结束时调用；处理最后一个没有空行收尾的事件。 */
    flush(): BotanicAgentStreamEvent[] {
      const tail = buffer.replace(/\r$/, '')
      buffer = ''
      if (tail.startsWith('data:')) dataLines.push(tail.slice(5).replace(/^ /, ''))
      return flushEvent()
    },
  }
}
