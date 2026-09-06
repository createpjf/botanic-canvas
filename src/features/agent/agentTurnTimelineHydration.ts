import type { BotanicAgentStreamEvent } from '../../domain/agentChatStream.ts'
import type { BotanicAgentMessage } from '../../domain/agent.ts'
import {
  botanicAgentTurnTimelineHydrationTargets,
  type BotanicAgentTurnTimelineHydrationTarget,
  type BotanicAgentObservedTurn,
} from '../../domain/agentTurnObservation.ts'
import {
  reduceAgentTimeline,
  type AgentTimelineState,
} from '../../domain/agentTimeline.ts'
import { joinTimelineTiming, timelineOperationTiming, validTimestamp } from '../../domain/agentTimelineTiming.ts'

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

/** 历史事件不以读取时刻充当执行时刻，也不因分页结束替工具制造终态。 */
function appendHydratedTools(current: AgentTimelineState, events: readonly BotanicAgentStreamEvent[]) {
  let timeline = current
  for (const event of events) {
    if (event.type === 'attempt') {
      if (timeline.references?.attemptId !== event.attemptId) timeline = { ...timeline, references: undefined }
      continue
    }
    if (event.type === 'references') {
      timeline = { ...timeline, references: { attemptId: event.attemptId, items: event.items } }
      continue
    }
    if (event.type !== 'tool') continue
    const at = validTimestamp(event.occurredAt)
    const previous = timeline.blocks.filter((block) => block.type === 'step')
    const next = reduceAgentTimeline(timeline, {
      type: 'tool', step: event.step, toolCall: event.toolCall,
      ...(event.presentation ? { presentation: event.presentation } : {}), receivedAt: at ?? 0,
    })
    timeline = { ...timeline, blocks: next.blocks.map((block) => {
      if (block.type !== 'step' || !block.sourceToolIds.includes(event.toolCall.id)) return block
      const prior = previous.find((item) => item.id === block.id)
      return { ...block,
        startedAt: prior && !prior.sourceToolIds.includes(event.toolCall.id)
          ? prior.startedAt : prior?.startedAt ?? (event.toolCall.status === 'running' ? at : undefined),
        endedAt: block.status === 'running' ? undefined : at ?? prior?.endedAt,
      }
    }) }
  }
  return timeline
}

/** 从只读 Turn Events 重建工具时间线；不消费结果，也不触发 Turn 执行。 */
export function agentTurnTimelineFromHydrationEvents(
  events: readonly BotanicAgentStreamEvent[],
  _receivedAt = Date.now(),
  truncation?: AgentTimelineState['truncation'],
): AgentTimelineState | undefined {
  const timeline = appendHydratedTools({ blocks: [], timing: { live: false } }, events)
  if (!timeline.references && !timeline.blocks.some((block) => block.type === 'step')) {
    return truncation ? { blocks: [], truncation } : undefined
  }
  return { ...timeline, ...(truncation ? { truncation } : {}) }
}

export function agentTurnTimelineFromHydrationRead(result: {
  events: readonly BotanicAgentStreamEvent[]
  truncated: boolean
  nextAfter?: number
  turn?: Pick<BotanicAgentObservedTurn, 'status' | 'createdAt' | 'updatedAt'>
}, receivedAt = Date.now()) {
  const timeline = agentTurnTimelineFromHydrationEvents(
    result.events,
    receivedAt,
    result.truncated && result.nextAfter !== undefined
      ? { loadedCount: result.events.length, nextAfter: result.nextAfter }
      : undefined,
  )
  return timeline && result.turn ? { ...timeline, timing: { ...timelineOperationTiming(result.turn), live: false } } : timeline
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
    timing: preserved.some((block) => block.id.startsWith('exec:')) && current.timing
      ? joinTimelineTiming(hydrated.timing, current.timing) : hydrated.timing,
    ...((hydrated.references ?? current.references) ? { references: hydrated.references ?? current.references } : {}),
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


/** 继续读取:新事件直接 reduce 进已有Timeline,稳定tool id原地更新且旧raw items不丢。 */
export function appendAgentTurnTimelineHydrationRead(
  current: AgentTimelineState,
  result: { events: readonly BotanicAgentStreamEvent[]; truncated: boolean; nextAfter?: number; turn?: Pick<BotanicAgentObservedTurn, 'status' | 'createdAt' | 'updatedAt'> },
  _receivedAt = Date.now(),
): AgentTimelineState {
  const timeline = appendHydratedTools(current, result.events)
  const loadedCount = (current.truncation?.loadedCount ?? 0) + result.events.length
  return {
    ...timeline,
    ...(result.turn ? { timing: timeline.blocks.some((block) => block.id.startsWith('exec:')) && current.timing
      ? joinTimelineTiming(timelineOperationTiming(result.turn), current.timing)
      : { ...timelineOperationTiming(result.turn), live: false } } : {}),
    ...(result.truncated && result.nextAfter !== undefined
      ? { truncation: { loadedCount, nextAfter: result.nextAfter } }
      : { truncation: undefined }),
  }
}
