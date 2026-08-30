import type { BotanicAgentMessage } from '../../domain/agent.ts'
import {
  revalidateMissingBotanicAgentTurn,
  retryBotanicAgentTurnRecovery,
} from '../../domain/agentTurnObservation.ts'
import type {
  observePersistentBotanicAgentTurn,
  streamBotanicAgentTurn,
} from '../../lib/agentApi.ts'

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
