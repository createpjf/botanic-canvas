import type { BotanicAgentStreamEvent } from '../domain/agentChatStream.ts'
import type { BotanicAgentTurnResult } from '../domain/agentTurnContract.ts'
import {
  agentTurnEventAsStreamEvent,
  monotonicAgentTurnEventDecision,
  type BotanicAgentTurnObservationPage,
} from '../domain/agentTurnObservation.ts'

const pageLimit = 200
const maximumPages = 5

function readerError(message: string, code: string) {
  return Object.assign(new Error(message), { status: 409, code })
}

export type AgentTurnTimelineReadResult = {
  events: BotanicAgentStreamEvent[]
  truncated: boolean
  nextAfter?: number
}

/** 只读、分页且有硬上限的 Turn Event reader；超过上限必须显式返回续读游标。 */
export async function readAgentTurnTimelineEvents(input: {
  turnId: string
  projectId: string
  signal?: AbortSignal
  readPage: (
    path: string,
    signal?: AbortSignal,
  ) => Promise<BotanicAgentTurnObservationPage<BotanicAgentTurnResult>>
}): Promise<AgentTurnTimelineReadResult> {
  const turnId = input.turnId.trim()
  if (!turnId) return { events: [], truncated: false }
  let after = 0
  const events: BotanicAgentStreamEvent[] = []
  for (let pageIndex = 0; pageIndex < maximumPages; pageIndex += 1) {
    if (input.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    const page = await input.readPage(
      `/api/agent-turns/${encodeURIComponent(turnId)}?after=${after}&limit=${pageLimit}`,
      input.signal,
    )
    if (page.turn.projectId !== input.projectId || page.turn.id !== turnId) {
      throw readerError('Agent 回合身份校验失败。', 'AGENT_TURN_IDENTITY_MISMATCH')
    }
    let deliveredSequence = after
    for (const event of page.events.slice(0, pageLimit)) {
      const decision = monotonicAgentTurnEventDecision(deliveredSequence, event)
      if (!decision.deliver) continue
      deliveredSequence = decision.lastSequence
      const projected = agentTurnEventAsStreamEvent(event)
      if (projected) events.push(projected)
    }
    const nextAfter = Math.max(deliveredSequence, Number(page.cursor.after) || 0)
    if (!page.cursor.hasMore) return { events, truncated: false }
    if (nextAfter <= after) {
      throw readerError('Agent 回合事件游标未推进。', 'AGENT_TURN_EVENT_CURSOR_STALLED')
    }
    after = nextAfter
  }
  return { events, truncated: true, nextAfter: after }
}
