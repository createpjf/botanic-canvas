import type { BotanicAgentMessage } from './agent.ts'

/**
 * 独立 Message HTTP seam 的安全 DTO。离线队列重放完整消息时，durable Turn 关联与
 * 用户 Stop 意图必须同行；漏掉任一字段都会让刷新后的观察器失去恢复依据。
 */
export function persistentBotanicAgentMessageBody(message: BotanicAgentMessage) {
  return {
    id: message.id,
    role: message.role,
    kind: message.kind,
    content: message.content,
    ...(message.mentions?.length ? { mentions: message.mentions } : {}),
    ...(message.prompt === undefined ? {} : { prompt: message.prompt }),
    createdAt: message.createdAt,
    ...(message.updatedAt === undefined ? {} : { updatedAt: message.updatedAt }),
    ...(message.plan === undefined ? {} : { plan: message.plan }),
    ...(message.question === undefined ? {} : { question: message.question }),
    ...(message.composition === undefined ? {} : { composition: message.composition }),
    ...(message.runId === undefined ? {} : { runId: message.runId }),
    ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
    ...(message.turnCancellationRequestedAt === undefined
      ? {}
      : { turnCancellationRequestedAt: message.turnCancellationRequestedAt }),
    ...(message.turnRequestSnapshot === undefined
      ? {}
      : { turnRequestSnapshot: message.turnRequestSnapshot }),
    ...(message.status === undefined ? {} : { status: message.status }),
    ...(message.feedback === undefined ? {} : { feedback: message.feedback }),
  }
}
