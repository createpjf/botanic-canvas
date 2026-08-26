import { ThinkingOrb, type OrbState } from 'thinking-orbs'
import type { AgentTimelineState } from '../domain/agentTimeline'

/**
 * Agent 思考 pill 内的 thinking-orbs 封装。
 * 仅由 UI 决定 state；不进 domain，不碰 Store。
 */

export type AgentThinkingOrbProps = {
  /** 有 running 的 search/fetch 步时用 searching，否则 composing（贴近 MetalForge converge）。 */
  timeline?: AgentTimelineState
  label?: string
  className?: string
}

export function resolveAgentThinkingOrbState(timeline?: AgentTimelineState): OrbState {
  if (!timeline) return 'composing'
  const searching = timeline.blocks.some((block) => (
    block.type === 'step'
    && block.status === 'running'
    && (block.kind === 'search' || block.kind === 'fetch')
  ))
  return searching ? 'searching' : 'composing'
}

export function AgentThinkingOrb({ timeline, label, className }: AgentThinkingOrbProps) {
  const state = resolveAgentThinkingOrbState(timeline)
  return (
    <span className={['agent-thinking-orb', className].filter(Boolean).join(' ')} aria-hidden="true">
      <ThinkingOrb
        state={state}
        size={20}
        theme="light"
        speed={1.5}
        aria-label={label}
      />
    </span>
  )
}
