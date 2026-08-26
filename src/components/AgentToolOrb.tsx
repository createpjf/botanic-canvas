import { ThinkingOrb } from 'thinking-orbs'
import type { AgentTimelineOrbState } from '../domain/agentTimeline'
import { prefersReducedMotion } from './gsapMotion'

/**
 * Agent 工具行进行中图标：只播 thinking-orbs 的 state 动画。
 * 文案仍由时间线标题负责；本组件 aria-hidden，不读 Store。
 */

export type AgentToolOrbProps = {
  state: AgentTimelineOrbState
  className?: string
  /** 默认 1；思考 pill 可略快。 */
  speed?: number
}

export function AgentToolOrb({ state, className, speed = 1 }: AgentToolOrbProps) {
  return (
    <span
      className={['agent-tool-orb', className].filter(Boolean).join(' ')}
      aria-hidden="true"
      style={{ color: '#2a5238' }}
    >
      <ThinkingOrb
        state={state}
        size={20}
        theme="light"
        speed={speed}
        paused={prefersReducedMotion()}
      />
    </span>
  )
}
