import type {
  BotanicAgentExecutionMode,
  BotanicAgentIntent,
  BotanicAgentMessageMention,
  BotanicAgentRuntimePhase,
} from '../../domain/agent.ts'
import type { GenerationSizeOverride } from '../../domain/generationOutputSize.ts'
import type { AgentContextItem, AgentDockTarget } from './agentWorkspace.types.ts'

export const AGENT_COMPOSER_QUEUE_LIMIT = 3

export type AgentInstructionExecutionSnapshot = {
  plannerModel: string
  executionMode: BotanicAgentExecutionMode
  mountedSkillIds: string[]
  sessionContextNodeIds: string[]
  contextItems: AgentContextItem[]
  targetNodeId: string | null
  groupId: string
  intent?: BotanicAgentIntent
  generationOverrides: GenerationSizeOverride
}

export type AgentQueuedInstruction = {
  id: string
  instruction: string
  content: string
  mentions: BotanicAgentMessageMention[]
  queuedAt: number
  snapshot: AgentInstructionExecutionSnapshot
}

export function enqueueAgentInstruction(
  queue: readonly AgentQueuedInstruction[],
  item: AgentQueuedInstruction,
) {
  if (queue.length >= AGENT_COMPOSER_QUEUE_LIMIT) return { queue: [...queue], accepted: false as const }
  return { queue: [...queue, item], accepted: true as const }
}

export function removeAgentQueuedInstruction(queue: readonly AgentQueuedInstruction[], id: string) {
  return queue.filter((item) => item.id !== id)
}

export function shiftAgentQueuedInstruction(queue: readonly AgentQueuedInstruction[]) {
  const [item, ...rest] = queue
  return { item, queue: rest }
}

export function agentQueuedInstructionPreview(item: AgentQueuedInstruction, maximum = 72) {
  const value = item.content.trim() || item.instruction.trim()
  return value.length <= maximum ? value : `${value.slice(0, Math.max(1, maximum - 1))}…`
}


export type AgentResolvedInstructionExecutionContext = AgentInstructionExecutionSnapshot & { target?: AgentDockTarget }

export function resolveAgentInstructionExecutionContext(input: {
  snapshot?: AgentInstructionExecutionSnapshot
  current: AgentInstructionExecutionSnapshot
  currentTarget?: AgentDockTarget
  explicitTargetProvided: boolean
  explicitTargetNodeId?: string | null
  generationOverrides?: GenerationSizeOverride
  resolveTarget: (nodeId?: string | null) => AgentDockTarget | undefined
}): AgentResolvedInstructionExecutionContext {
  const source = input.snapshot ?? input.current
  const targetBound = input.explicitTargetProvided || input.snapshot !== undefined
  const targetNodeId = input.explicitTargetProvided ? input.explicitTargetNodeId : input.snapshot?.targetNodeId
  const target = targetBound ? input.resolveTarget(targetNodeId) : input.currentTarget
  return {
    ...source,
    mountedSkillIds: [...source.mountedSkillIds],
    sessionContextNodeIds: [...source.sessionContextNodeIds],
    contextItems: source.contextItems.map((item) => ({ ...item })),
    targetNodeId: target?.id ?? null,
    generationOverrides: { ...(input.generationOverrides ?? source.generationOverrides) },
    ...(target ? { target } : {}),
  }
}


export function agentInstructionQueueSettlement(input: {
  queueLength: number
  planning: boolean
  runtimePhase: BotanicAgentRuntimePhase
  instruction: string
}): 'wait' | 'execute' | 'restore' {
  if (!input.queueLength || input.planning) return 'wait'
  if (input.runtimePhase === 'completed') return 'execute'
  if ((input.runtimePhase === 'failed' || input.runtimePhase === 'idle') && !input.instruction.trim()) return 'restore'
  return 'wait'
}
