import type { AgentTimelineState } from '../domain/agentTimeline'
import { agentTimelineOrbState } from '../domain/agentTimeline'
import { AgentToolOrb } from './AgentToolOrb'

/**
 * Agent 思考 pill 内的球体。固定 breathing（MetalForge thinking-orbs `style=breathe`）。
 * 文案仍是「思考了 Ns」；工具行各自用 AgentToolOrb，不在这里抢 searching。
 */

export type AgentThinkingOrbProps = {
  timeline?: AgentTimelineState
  label?: string
  className?: string
}

export function AgentThinkingOrb({ className }: AgentThinkingOrbProps) {
  return (
    <AgentToolOrb
      state={agentTimelineOrbState({ surface: 'thinking' })}
      className={['agent-thinking-orb', className].filter(Boolean).join(' ')}
      speed={1.5}
    />
  )
}
