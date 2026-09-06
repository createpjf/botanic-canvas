import type { BotanicAgentStreamEvent } from '../domain/agentChatStream.ts'
import type { BotanicAgentTurnResult } from '../domain/agentTurnContract.ts'
import {
  agentTurnEventAsStreamEvent,
  monotonicAgentTurnEventDecision,
  type BotanicAgentTurnObservationPage,
} from '../domain/agentTurnObservation.ts'

const pageLimit = 200
const defaultMaximumPages = 5

function readerError(message: string, code: string) {
  return Object.assign(new Error(message), { status: 409, code })
}

export type AgentTurnTimelineReadResult = {
  events: BotanicAgentStreamEvent[]
  turn?: BotanicAgentTurnObservationPage['turn']
  hasNonReadTool?: boolean
  truncated: boolean
  nextAfter?: number
}

/** 只读、分页且有硬上限的 Turn Event reader；超过上限必须显式返回续读游标。 */
export async function readAgentTurnTimelineEvents(input: {
  turnId: string
  projectId: string
  signal?: AbortSignal
  after?: number
  maximumPages?: number
  readPage: (
    path: string,
    signal?: AbortSignal,
  ) => Promise<BotanicAgentTurnObservationPage<BotanicAgentTurnResult>>
}): Promise<AgentTurnTimelineReadResult> {
  const turnId = input.turnId.trim()
  if (!turnId) return { events: [], truncated: false }
  let after = Number(input.after ?? 0)
  if (!Number.isSafeInteger(after) || after < 0) throw readerError('Agent 回合事件游标无效。', 'INVALID_AGENT_TURN_CURSOR')
  const maximumPages = Number(input.maximumPages ?? defaultMaximumPages)
  if (!Number.isSafeInteger(maximumPages) || maximumPages < 1 || maximumPages > defaultMaximumPages) {
    throw readerError('Agent 回合事件页数无效。', 'INVALID_AGENT_TURN_LIMIT')
  }
  const events: BotanicAgentStreamEvent[] = []
  let turn: BotanicAgentTurnObservationPage['turn'] | undefined
  let hasNonReadTool = false
  for (let pageIndex = 0; pageIndex < maximumPages; pageIndex += 1) {
    if (input.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    const page = await input.readPage(
      `/api/agent-turns/${encodeURIComponent(turnId)}?after=${after}&limit=${pageLimit}`,
      input.signal,
    )
    if (page.turn.projectId !== input.projectId || page.turn.id !== turnId) {
      throw readerError('Agent 回合身份校验失败。', 'AGENT_TURN_IDENTITY_MISMATCH')
    }
    turn = page.turn
    let deliveredSequence = after
    for (const event of page.events.slice(0, pageLimit)) {
      // 展示清洗器会为旧工具补默认 risk；恢复判断不能把“缺失”当成只读证据。
      if (event.type === 'turn.tool' && event.payload?.risk !== 'read') hasNonReadTool = true
      const decision = monotonicAgentTurnEventDecision(deliveredSequence, event)
      if (!decision.deliver) continue
      deliveredSequence = decision.lastSequence
      const projected = agentTurnEventAsStreamEvent(event)
      if (projected) events.push(projected)
    }
    const nextAfter = Math.max(deliveredSequence, Number(page.cursor.after) || 0)
    if (!page.cursor.hasMore) return { events, turn, hasNonReadTool, truncated: false }
    if (nextAfter <= after) {
      throw readerError('Agent 回合事件游标未推进。', 'AGENT_TURN_EVENT_CURSOR_STALLED')
    }
    after = nextAfter
  }
  return { events, turn, hasNonReadTool, truncated: true, nextAfter: after }
}
