import {
  botanicAgentAssistantMessageProvenance,
  updateBotanicAgentAction,
  type BotanicAgentActionProposal,
  type BotanicAgentMessage,
  type BotanicAgentSession,
} from '../../domain/agent.ts'

type AgentActionPatch = Partial<Pick<
  BotanicAgentActionProposal,
  'status' | 'receiptIdempotencyKey' | 'preparedRetryIdempotencyKey' | 'manualRetryResumeAvailable' | 'error' | 'result'
>>

export type AgentMessagePatch = Partial<Pick<
  BotanicAgentMessage,
  'kind' | 'content' | 'runId' | 'turnId' | 'turnCancellationRequestedAt' | 'turnRequestSnapshot' | 'status' | 'feedback'
  | 'plan' | 'question' | 'composition' | 'deliveryStatus' | 'review' | 'sourceMessageId' | 'sourceNodeIds'
  | 'targetArtifactVersionId' | 'planFingerprint'
>>

type AppendMessageInput = Omit<BotanicAgentMessage, 'id' | 'createdAt'> & { id?: string; createdAt?: number }

export function upsertBotanicAgentMessageProjection(input: {
  message: AppendMessageInput
  session?: BotanicAgentSession
  activeTurnInputMessage?: BotanicAgentMessage | null
  append: (message: AppendMessageInput) => string
  update: (message: BotanicAgentMessage, patch: AgentMessagePatch) => BotanicAgentMessage
}) {
  const source = input.message.role === 'assistant' && input.message.turnId
    ? (input.activeTurnInputMessage?.turnId === input.message.turnId
        ? input.activeTurnInputMessage
        : input.session?.messages.find((message) => message.role === 'user' && message.turnId === input.message.turnId))
    : undefined
  const message = {
    ...input.message,
    ...botanicAgentAssistantMessageProvenance(source, input.message.turnId),
  }
  const existing = message.id?.trim()
    ? input.session?.messages.find((candidate) => candidate.id === message.id?.trim())
    : undefined
  if (!existing) return input.append(message)
  input.update(existing, {
    kind: message.kind, content: message.content, runId: message.runId, turnId: message.turnId,
    turnCancellationRequestedAt: message.turnCancellationRequestedAt, status: message.status,
    feedback: message.feedback, plan: message.plan, question: message.question,
    composition: message.composition, review: message.review, sourceMessageId: message.sourceMessageId,
    sourceNodeIds: message.sourceNodeIds, targetArtifactVersionId: message.targetArtifactVersionId,
    planFingerprint: message.planFingerprint,
  })
  return existing.id
}

/**
 * 计划提交与 Turn 投影的状态变化不能只改本地兼容视图：每次变更都把完整 Message
 * 交给同一离线队列，且 updatedAt 严格递增，刷新才能恢复 runId/Stop 意图/最终结果。
 */
export function persistBotanicAgentMessageUpdate(input: {
  session: BotanicAgentSession
  message: BotanicAgentMessage
  patch: AgentMessagePatch
  /** 完整 Message 本地 upsert；跨设备 API-only 投影在 Canvas Store 中可能尚不存在。 */
  onUpsertMessage: (sessionId: string, message: BotanicAgentMessage) => void
  onUpdateMessage: (sessionId: string, messageId: string, patch: AgentMessagePatch) => void
  persistMessage: (message: BotanicAgentMessage) => void
  now?: number
}): BotanicAgentMessage {
  const updatedAt = Math.max(
    input.now ?? Date.now(),
    Number(input.message.updatedAt ?? input.message.createdAt) + 1,
  )
  const updatedMessage = { ...input.message, ...input.patch, updatedAt }
  input.onUpsertMessage(input.session.id, updatedMessage)
  input.onUpdateMessage(input.session.id, input.message.id, input.patch)
  input.persistMessage(updatedMessage)
  return updatedMessage
}

/**
 * 同一次行动状态变更既更新本地兼容视图，也把完整 Message 交给独立实体持久化。
 * updatedAt 严格递增，避免同一毫秒内的 running → 终态被服务端版本合并吞掉。
 */
export function persistBotanicAgentActionMessageUpdate(input: {
  session: BotanicAgentSession
  message: BotanicAgentMessage
  actionId: string
  patch: AgentActionPatch
  onUpsertMessage: (sessionId: string, message: BotanicAgentMessage) => void
  onUpdateAction: (sessionId: string, messageId: string, actionId: string, patch: AgentActionPatch) => void
  persistMessage: (message: BotanicAgentMessage) => void
  now?: number
}): BotanicAgentMessage {
  if (!input.message.plan?.actions?.some((action) => action.id === input.actionId)) return input.message
  const updatedAt = Math.max(
    input.now ?? Date.now(),
    Number(input.message.updatedAt ?? input.message.createdAt) + 1,
  )
  const sourceSession = {
    ...input.session,
    messages: input.session.messages.map((message) => (
      message.id === input.message.id ? input.message : message
    )),
  }
  const updatedSession = updateBotanicAgentAction(
    sourceSession,
    input.message.id,
    input.actionId,
    input.patch,
    updatedAt,
  )
  const updatedMessage = updatedSession.messages.find((message) => message.id === input.message.id)
  if (!updatedMessage) return input.message
  input.onUpsertMessage(input.session.id, updatedMessage)
  input.onUpdateAction(input.session.id, input.message.id, input.actionId, input.patch)
  input.persistMessage(updatedMessage)
  return updatedMessage
}
