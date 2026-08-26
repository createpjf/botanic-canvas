import type { AgentTimelineState } from '../domain/agentTimeline'

export type AgentThinkingOrbState = 'composing' | 'searching'

/** 有 running 的 search/fetch 步时用 searching，否则 composing（贴近 MetalForge converge）。 */
export function resolveAgentThinkingOrbState(timeline?: AgentTimelineState): AgentThinkingOrbState {
  if (!timeline) return 'composing'
  const searching = timeline.blocks.some((block) => (
    block.type === 'step'
    && block.status === 'running'
    && (block.kind === 'search' || block.kind === 'fetch')
  ))
  return searching ? 'searching' : 'composing'
}
