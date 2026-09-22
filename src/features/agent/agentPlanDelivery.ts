import { botanicAgentPendingConfirmationCount, resolveBotanicAgentExecutionDecision } from '../../domain/agent.ts'
import type { BotanicAgentConfirmationWaiver, BotanicAgentExecutionMode, BotanicAgentMessage, BotanicAgentPlan } from '../../domain/agent.ts'

/** 四种生成路径共享交付规则；各 plan builder 仍拥有其专属语义。 */
export async function deliverAgentPlan(input: {
  plan: BotanicAgentPlan
  execution: { mode: BotanicAgentExecutionMode; waivers?: readonly BotanicAgentConfirmationWaiver[] }
  identity?: Pick<Partial<BotanicAgentMessage>, 'id' | 'turnId' | 'sourceMessageId'>
}, delivery: {
  canDeliver: () => boolean
  publish: (message: BotanicAgentMessage) => string
  onPending: () => void
  confirm: (message: BotanicAgentMessage) => Promise<unknown>
}) {
  if (!delivery.canDeliver()) return
  const { plan, execution } = input
  const decision = resolveBotanicAgentExecutionDecision({
    ...execution, settingsComplete: true, pendingActionCount: botanicAgentPendingConfirmationCount(plan.actions),
    outputCount: plan.output.count, allowAutoSubmit: !plan.requiresGenerationConfirmation,
  })
  const message: BotanicAgentMessage = {
    id: input.identity?.id ?? `agent-message-${crypto.randomUUID()}`, ...input.identity,
    role: 'assistant', kind: 'plan', plan, status: 'pending', content: plan.summary, createdAt: Date.now(),
  }
  const messageId = delivery.publish(message)
  if (!messageId) return
  if (delivery.canDeliver()) {
    delivery.onPending()
    if (decision.action === 'auto_submit') await delivery.confirm({ ...message, id: messageId })
  }
  return { messageId, decision }
}
