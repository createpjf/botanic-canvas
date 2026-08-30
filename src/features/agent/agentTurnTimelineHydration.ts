import type { BotanicAgentStreamEvent } from '../../domain/agentChatStream.ts'
import type { BotanicAgentMessage } from '../../domain/agent.ts'
import {
  botanicAgentTurnTimelineHydrationTargets,
  type BotanicAgentTurnTimelineHydrationTarget,
} from '../../domain/agentTurnObservation.ts'
import {
  createAgentTimeline,
  reduceAgentTimeline,
  type AgentTimelineState,
} from '../../domain/agentTimeline.ts'

export type AgentTurnTimelineHydrationAttemptState = 'loading' | 'terminal' | 'transient'

/** Run timeline 不参与去重；只有独立 hydration 状态能阻止/恢复 Turn Event GET。 */
export function beginAgentTurnTimelineHydrationBatch(
  messages: readonly BotanicAgentMessage[],
  attempts: Map<string, AgentTurnTimelineHydrationAttemptState>,
  limit: number,
) {
  const targets = botanicAgentTurnTimelineHydrationTargets(
    messages,
    new Set(attempts.keys()),
    limit,
  )
  for (const target of targets) attempts.set(target.turnId, 'loading')
  return targets
}

export function releaseAbortedAgentTurnTimelineHydrations(
  targets: readonly BotanicAgentTurnTimelineHydrationTarget[],
  attempts: Map<string, AgentTurnTimelineHydrationAttemptState>,
) {
  for (const target of targets) {
    if (attempts.get(target.turnId) === 'loading') attempts.delete(target.turnId)
  }
}

/** 从只读 Turn Events 重建工具时间线；不消费结果，也不触发 Turn 执行。 */
export function agentTurnTimelineFromHydrationEvents(
  events: readonly BotanicAgentStreamEvent[],
  receivedAt = Date.now(),
  truncation?: AgentTimelineState['truncation'],
): AgentTimelineState | undefined {
  let timeline = createAgentTimeline(receivedAt)
  for (const event of events) {
    if (event.type !== 'tool') continue
    timeline = reduceAgentTimeline(timeline, {
      type: 'tool',
      step: event.step,
      toolCall: event.toolCall,
      ...(event.presentation ? { presentation: event.presentation } : {}),
      receivedAt,
    })
  }
  if (!timeline.blocks.some((block) => block.type === 'step')) {
    return truncation ? { blocks: [], truncation } : undefined
  }
  return { ...reduceAgentTimeline(timeline, { type: 'done', receivedAt }), ...(truncation ? { truncation } : {}) }
}

export function agentTurnTimelineFromHydrationRead(result: {
  events: readonly BotanicAgentStreamEvent[]
  truncated: boolean
  nextAfter?: number
}, receivedAt = Date.now()) {
  return agentTurnTimelineFromHydrationEvents(
    result.events,
    receivedAt,
    result.truncated && result.nextAfter !== undefined
      ? { loadedCount: result.events.length, nextAfter: result.nextAfter }
      : undefined,
  )
}

/** 并发期间 Run 投影可能先到；合并时保留它的执行步骤，不覆盖权威运行状态。 */
export function mergeHydratedAgentTurnTimeline(
  current: AgentTimelineState | undefined,
  hydrated: AgentTimelineState,
): AgentTimelineState {
  if (!current) return hydrated
  const hydratedIds = new Set(hydrated.blocks.map((block) => block.id))
  const raw = hydrated.blocks.find((block) => block.type === 'raw_group')
  const hydratedBody = hydrated.blocks.filter((block) => block.type !== 'raw_group')
  const preserved = current.blocks.filter((block) => (
    block.type !== 'thinking'
    && block.type !== 'raw_group'
    && !hydratedIds.has(block.id)
  ))
  return {
    blocks: [...hydratedBody, ...preserved, ...(raw ? [raw] : [])],
    ...(hydrated.truncation ? { truncation: hydrated.truncation } : {}),
  }
}

export function agentTurnTimelineHydrationFailureDisposition(
  caught: unknown,
): 'cancelled' | 'terminal' | 'retry_later' {
  if (caught instanceof Error && caught.name === 'AbortError') return 'cancelled'
  const status = Number((caught as { status?: unknown } | undefined)?.status)
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) return 'terminal'
  return 'retry_later'
}
