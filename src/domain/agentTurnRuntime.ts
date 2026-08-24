/**
 * Agent Turn Runtime V2 的跨端合同。
 *
 * Turn 是一次用户意图解析/执行回合；Run 仍然是生成执行权威，不能用 Turn
 * 覆盖 Run 的状态。事件只描述可恢复的生命周期，不包含原始思维链。
 */
export type AgentTurnStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export type AgentTurnKind = 'chat' | 'generation' | 'composition' | 'clarification'

export type AgentTurnEventType =
  | 'turn.started'
  | 'turn.provider'
  | 'turn.tool'
  | 'turn.completed'
  | 'turn.failed'
  | 'turn.cancelled'

export type AgentTurnEvent = {
  id: string
  turnId: string
  sequence: number
  type: AgentTurnEventType
  createdAt: number
  payload?: {
    step?: number
    toolName?: string
    toolCallId?: string
    status?: string
    code?: string
    kind?: AgentTurnKind
  }
}

export type AgentTurnRecord = {
  id: string
  version: 2
  projectId: string
  ownerId: string
  sessionId?: string
  requestId?: string
  idempotencyKey: string
  status: AgentTurnStatus
  createdAt: number
  updatedAt: number
  result?: Record<string, unknown>
  error?: { code: string; message: string }
}
