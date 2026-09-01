import { useCallback, useState, type Dispatch, type SetStateAction } from 'react'
import type { BotanicAgentMessage } from '../../domain/agent.ts'
import type { AgentTimelineState } from '../../domain/agentTimeline.ts'
import { readPersistentBotanicAgentTurnEvents } from '../../lib/agentApi.ts'
import { appendAgentTurnTimelineHydrationRead } from './agentTurnTimelineHydration.ts'

export function useAgentTimelineContinuation(input: {
  projectId: string
  isCurrentProject: () => boolean
  setTimelines: Dispatch<SetStateAction<Record<string, AgentTimelineState>>>
  onError: (message: string) => void
  locale: 'zh-CN' | 'en'
}) {
  const [loadingTurnIds, setLoadingTurnIds] = useState<Set<string>>(() => new Set())
  const loadMore = useCallback(async (message: BotanicAgentMessage, timeline: AgentTimelineState) => {
    const turnId = message.turnId?.trim()
    const after = timeline.truncation?.nextAfter
    if (!turnId || after === undefined || loadingTurnIds.has(turnId)) return
    setLoadingTurnIds((current) => new Set(current).add(turnId))
    try {
      const result = await readPersistentBotanicAgentTurnEvents(turnId, input.projectId, { after, maximumPages: 5 })
      if (!input.isCurrentProject()) return
      input.setTimelines((current) => ({
        ...current,
        [message.id]: appendAgentTurnTimelineHydrationRead(current[message.id] ?? timeline, result),
      }))
    } catch {
      if (input.isCurrentProject()) input.onError(input.locale === 'en' ? 'Unable to load more activity.' : '暂时无法加载更多活动。')
    } finally {
      setLoadingTurnIds((current) => {
        const next = new Set(current); next.delete(turnId); return next
      })
    }
  }, [input, loadingTurnIds])
  return { loadingTurnIds, loadMore }
}
