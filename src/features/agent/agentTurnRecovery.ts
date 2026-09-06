import type { BotanicAgentMessage } from '../../domain/agent.ts'
import {
  revalidateMissingBotanicAgentTurn,
  retryBotanicAgentTurnRecovery,
} from '../../domain/agentTurnObservation.ts'
import type {
  observePersistentBotanicAgentTurn,
  streamBotanicAgentTurn,
} from '../../lib/agentApi.ts'
import type { AgentTurnTimelineReadResult } from '../../lib/agentTurnTimelineEventReader.ts'

/** Turn → Run POST 交接时仍按计划的原 Turn 停止，不借用另一条最新任务。 */
export function resolveAgentStopTarget(messages: readonly BotanicAgentMessage[], input: {
  activeTurnId?: string; activeInputMessage?: BotanicAgentMessage | null; submittingMessageId?: string
}) {
  const submitting = messages.find((message) => message.id === input.submittingMessageId)
  const turnId = input.activeTurnId || submitting?.plan?.turnId
  const inputMessage = input.activeInputMessage && (!turnId || !input.activeInputMessage.turnId || input.activeInputMessage.turnId === turnId)
    ? input.activeInputMessage
    : turnId ? messages.find((message) => message.role === 'user' && message.turnRequestSnapshot && message.turnId === turnId) : undefined
  return { turnId, inputMessage }
}

/** 失败文案不是失败事实；重试前先读原 Turn，禁止重放有副作用的过程。 */
export function failedAgentTurnRecoveryDecision(
  read: AgentTurnTimelineReadResult,
  runId?: string,
): 'task' | 'observe' | 'retry' | 'inspect' | 'blocked' {
  if (runId) return 'task'
  if (!read.turn) return 'blocked'
  if (['AGENT_TOOL_OUTCOME_UNKNOWN', 'AGENT_ACTION_OUTCOME_UNKNOWN', 'AGENT_REVIEW_OUTCOME_UNKNOWN'].includes(read.turn.error?.code ?? '')) return 'inspect'
  if (['queued', 'running', 'cancelling', 'waiting_user', 'completed'].includes(read.turn.status)) return 'observe'
  if (read.turn.status !== 'failed' || read.truncated || read.hasNonReadTool !== false || read.turn.result
    || !['PROVIDER_TIMEOUT', 'PROVIDER_RATE_LIMITED', 'PROVIDER_UNAVAILABLE', 'PROVIDER_STREAM_CLOSED', 'PROVIDER_STREAM_MALFORMED', 'REQUEST_TIMEOUT'].includes(read.turn.error?.code ?? '')) return 'blocked'
  // 任何非只读工具都留给其自身的 receipt/人工恢复入口，不能重跑整轮。
  return read.events.some((event) => event.type === 'tool' && event.toolCall.risk !== 'read') ? 'blocked' : 'retry'
}

/**
 * pending Message 的唯一恢复 seam：先观察 durable Turn，缺失时才用同一稳定请求补提交。
 * UI 只负责事件投影，不再拥有 revalidate/submit/cancel 的顺序规则。
 */
export async function recoverPendingAgentTurn({
  projectId,
  message,
  request,
  initialTurnId,
  signal,
  onEvent,
  onAccepted,
  ensureMessageDurable,
  cancellationRequested,
  ensureCancellation,
  submitTurn,
  observeTurn,
  createError,
}: {
  projectId: string
  message: BotanicAgentMessage
  request: Parameters<typeof streamBotanicAgentTurn>[0]
  initialTurnId: string
  signal: AbortSignal
  onEvent: NonNullable<Parameters<typeof streamBotanicAgentTurn>[1]>['onEvent']
  onAccepted: (turnId: string) => void
  ensureMessageDurable: (message: BotanicAgentMessage) => Promise<unknown>
  cancellationRequested: () => boolean
  ensureCancellation: (turnId: string, signal: AbortSignal) => Promise<unknown>
  submitTurn: typeof streamBotanicAgentTurn
  observeTurn: typeof observePersistentBotanicAgentTurn
  createError: (message: string, status: number, code: string) => Error
}) {
  if (!initialTurnId && !message.turnRequestSnapshot) {
    throw createError(
      '旧版待提交消息缺少 Agent Turn 请求快照，已停止恢复以避免改错图。',
      409,
      'AGENT_TURN_REQUEST_SNAPSHOT_MISSING',
    )
  }
  let observedTurnId = initialTurnId
  let revalidateByStableSubmission = false
  const submitStableRequest = async () => {
    if (message.turnRequestSnapshot) await ensureMessageDurable(message)
    return submitTurn(request, {
      signal,
      onEvent,
      onAccepted: (turnId) => {
        observedTurnId = turnId
        onAccepted(turnId)
      },
    })
  }
  const turn = await retryBotanicAgentTurnRecovery({
    signal,
    attempt: () => {
      if (!observedTurnId || revalidateByStableSubmission) return submitStableRequest()
      return revalidateMissingBotanicAgentTurn({
        observe: () => observeTurn(observedTurnId, projectId, {
          signal,
          onEvent,
          missingTurnTimeoutMs: 2_000,
        }),
        markRevalidation: () => { revalidateByStableSubmission = true },
        submit: submitStableRequest,
      })
    },
  })
  const finalTurnId = turn.runtimeTurnId ?? observedTurnId
  if (!finalTurnId || (initialTurnId && finalTurnId !== initialTurnId)) {
    throw createError('Agent 回合身份校验失败。', 409, 'AGENT_TURN_IDENTITY_MISMATCH')
  }
  if (cancellationRequested()) {
    await ensureCancellation(finalTurnId, signal)
    await observeTurn(finalTurnId, projectId, { signal })
    throw createError('Agent 回合已取消。', 0, 'AGENT_TURN_CANCELLED')
  }
  return { turn, turnId: finalTurnId }
}
