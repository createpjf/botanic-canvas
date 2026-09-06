import type { BotanicAgentMessage, BotanicAgentRun } from './agent.ts'
import { agentPlanCancellationRun } from './agentPlanCancellation.ts'

/** 普通正文按版本合并；同一确认与稳定 Turn 的后续投影不能被客户端时钟回退。 */
export function mergeAgentMessages(
  apiMessages: BotanicAgentMessage[],
  storeMessages: BotanicAgentMessage[],
  runs: readonly BotanicAgentRun[] = [],
) {
  const byId = new Map(apiMessages.map((message) => [message.id, message]))
  for (const message of storeMessages) {
    const existing = byId.get(message.id)
    const turnId = existing?.turnId ?? message.turnId
    if (existing?.kind === 'question' && message.kind === 'question'
      && existing.question?.id && existing.question.id !== message.question?.id
      && (message.status === 'answered' || message.status === 'submitted')) continue
    if (existing && turnId && message.id === `agent-turn-result-${turnId}`
      && existing.role === 'assistant' && message.role === 'assistant') {
      if (existing.status === 'failed' && message.status !== 'failed') continue
      if ((message.status === 'failed' && existing.status !== 'failed')
        || (existing.kind === 'question' && (message.plan || message.runId))) {
        byId.set(message.id, message)
        continue
      }
      if (message.kind === 'question' && (existing.plan || existing.runId)) continue
    }
    if (message.kind === 'question' && existing?.kind === 'text' && existing.prompt?.trim()) continue
    if (existing?.kind === 'question' && message.kind === 'text' && message.prompt?.trim()) {
      byId.set(message.id, message)
      continue
    }
    if (existing?.kind === 'question' && message.kind === 'question'
      && existing.question?.id && existing.question.id === message.question?.id) {
      const existingAnswered = existing.status === 'answered' || existing.status === 'submitted'
      const incomingAnswered = message.status === 'answered' || message.status === 'submitted'
      if (existingAnswered && (incomingAnswered || message.status === 'pending')) continue
      if (existing.status === 'pending' && incomingAnswered) {
        byId.set(message.id, message)
        continue
      }
    }
    const messageTime = Number(message.updatedAt ?? message.createdAt ?? 0)
    const existingTime = Number(existing?.updatedAt ?? existing?.createdAt ?? 0)
    if (!existing || messageTime >= existingTime) byId.set(message.id, message)
  }
  const ordered = [...byId.values()].sort(
    (left, right) => Number(left.createdAt ?? 0) - Number(right.createdAt ?? 0)
      || left.id.localeCompare(right.id),
  )
  // 同一操作的确认答案先于被原位更新的回复；不改 createdAt，也不按正文/相邻位置猜关联。
  const operationKey = (message: BotanicAgentMessage) => {
    const turnId = message.turnId ?? message.question?.resolvedGeneration?.turnId ?? message.plan?.turnId
    return turnId ? `turn:${turnId}` : message.sourceMessageId ? `input:${message.sourceMessageId}` : undefined
  }
  const lastAnswer = new Map<string, number>()
  ordered.forEach((message, index) => {
    const key = operationKey(message)
    if (key && message.role === 'user' && message.id.startsWith('agent-answer-')) lastAnswer.set(key, index)
  })
  const deferred = new Map<number, BotanicAgentMessage[]>()
  const visible: BotanicAgentMessage[] = []
  ordered.forEach((message, index) => {
    const key = operationKey(message)
    const answerIndex = key && message.role === 'assistant' ? lastAnswer.get(key) : undefined
    if (answerIndex !== undefined && answerIndex > index) {
      deferred.set(answerIndex, [...(deferred.get(answerIndex) ?? []), message])
    } else visible.push(message, ...(deferred.get(index) ?? []))
  })
  return visible.map((message) => {
    if (message.role !== 'assistant' || message.kind !== 'plan' || !message.plan) return message
    // 确认回包丢失不等于未创建任务；复用冻结提交身份核对，不能按“最新Run”猜关联。
    const turnId = message.turnId ?? message.plan.turnId
    const turnMatches = !message.runId && turnId && (!message.plan.turnId || message.plan.turnId === turnId)
      ? runs.filter((run) => run.plan?.turnId === turnId) : []
    const run = agentPlanCancellationRun(message, runs) ?? (turnMatches.length === 1 ? turnMatches[0] : undefined)
    return run && (message.runId !== run.id || message.status !== 'submitted')
      ? { ...message, runId: run.id, status: 'submitted' as const }
      : message
  })
}
