import type { AgentToolCallTrace, BotanicAgentClarificationResponse, BotanicAgentPlan, BotanicAgentReasoningEntry } from './agent'
import type { BotanicAgentChatResponse } from './agentChatContract'
import type { BotanicAgentTurnResult } from './agentTurnContract'
import type { TimelineToolPresentation } from './agentTimeline'
import type { ProductLocale } from '../i18n/core'

/**
 * Agent 实时通道的事件契约（chat / turn / plan 共用）。
 *
 * `tool` 仅在服务端 registry.execute 前发 running、后发终态；禁止客户端预插成功。
 * `done` 携带与一次性接口一致的业务体——实时通道只改变“什么时候到”，不改变结果本身。
 * 原始 `reasoning_content` 默认不下发；摘要级 why 经 tool.summary 展示。
 */
export type BotanicAgentStreamEvent =
  | { type: 'reasoning'; step: number; delta: string }
  | { type: 'answer'; step: number; delta: string }
  | { type: 'tool'; step: number; toolCall: AgentToolCallTrace; presentation?: TimelineToolPresentation }
  | {
      type: 'done'
      response?: BotanicAgentChatResponse
      turn?: BotanicAgentTurnResult
      /** Turn Runtime V2 的持久化生命周期快照；旧客户端可忽略。 */
      runtimeTurn?: {
        id: string
        status: 'running' | 'completed' | 'failed' | 'cancelled'
        projectId: string
        updatedAt: number
        createdAt: number
      }
      result?: BotanicAgentTurnResult
      plan?: BotanicAgentPlan
      clarification?: BotanicAgentClarificationResponse['clarification']
      reasoning?: BotanicAgentReasoningEntry[]
    }
  | { type: 'error'; code?: string; message?: string }

/** 对话流事件；与 BotanicAgentStreamEvent 同构，保留别名以免旧导入断裂。 */
export type BotanicAgentChatStreamEvent = BotanicAgentStreamEvent

const streamEventTypes = new Set(['reasoning', 'answer', 'tool', 'done', 'error'])

function parseStreamEvent(payload: string): BotanicAgentStreamEvent[] {
  try {
    const value = JSON.parse(payload) as { type?: unknown }
    if (!value || typeof value !== 'object' || typeof value.type !== 'string') return []
    if (!streamEventTypes.has(value.type)) return []
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

/**
 * SSE 文本读取器。按事件边界解析，容忍跨网络块切断的行、CRLF、注释行与多行 data；
 * 无法解析的事件被跳过而不是让整轮失败。它是纯函数状态机，解码与网络留给调用方。
 */
export function createBotanicAgentChatStreamReader() {
  let buffer = ''
  let dataLines: string[] = []

  const flushEvent = (): BotanicAgentStreamEvent[] => {
    if (!dataLines.length) return []
    const payload = dataLines.join('\n')
    dataLines = []
    return parseStreamEvent(payload)
  }

  return {
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
        // 其余字段（event / id / retry / 注释行）当前不需要。
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
