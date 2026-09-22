import type { BotanicAgentMessage } from '../../domain/agent.ts'
import { retryBotanicAgentTurnCancellation, stopBotanicAgentPlanning } from '../../domain/agentTurnObservation.ts'

type ActiveTurn = {
  controller: AbortController
  turnId?: string
  message?: BotanicAgentMessage
  awaitingIdentity: boolean
  stopRequested: boolean
}

/** 一个会话的提交/重挂共享观察所有权；只有显式 Stop 可以请求 durable cancellation。 */
export function createAgentTurnLifecycle(input: {
  isCurrentScope: () => boolean
  cancelTurn: (turnId: string) => Promise<unknown>
  onCancellationChange?: (pending: boolean) => void
}) {
  let active: ActiveTurn | undefined
  const intents = new Map<string, number>()
  const cancellations = new Map<string, Promise<unknown>>()
  const cancelled = new Set<string>()
  const ensureCancelled = (turnId: string, signal?: AbortSignal) => {
    if (cancelled.has(turnId)) return Promise.resolve()
    const existing = cancellations.get(turnId)
    if (existing) return existing
    if (input.isCurrentScope()) input.onCancellationChange?.(true)
    const pending = retryBotanicAgentTurnCancellation({ turnId, signal, cancelTurn: input.cancelTurn })
      .then((result) => { cancelled.add(turnId); return result })
      .finally(() => {
        cancellations.delete(turnId)
        if (!cancellations.size && input.isCurrentScope()) input.onCancellationChange?.(false)
      })
    cancellations.set(turnId, pending)
    return pending
  }
  const detach = () => { active?.controller.abort(); active = undefined }
  return {
    isCurrentScope: input.isCurrentScope,
    get active() {
      return active ? { turnId: active.turnId, message: active.message, awaitingIdentity: active.awaitingIdentity } : undefined
    },
    begin(options: { message?: BotanicAgentMessage; turnId?: string; awaitingIdentity?: boolean } = {}) {
      detach()
      const turn: ActiveTurn = { ...options, controller: new AbortController(), awaitingIdentity: Boolean(options.awaitingIdentity), stopRequested: false }
      active = turn
      const ownsScope = () => active === turn && input.isCurrentScope()
      const isCurrent = () => ownsScope() && !turn.controller.signal.aborted
      return {
        signal: turn.controller.signal,
        isCurrent,
        bindMessage(message: BotanicAgentMessage) {
          if (!isCurrent()) return
          turn.message = message
          turn.awaitingIdentity = !turn.turnId
        },
        accept(turnId: string) {
          if (!isCurrent()) return
          if (turn.turnId && turn.turnId !== turnId) throw Object.assign(new Error('Agent 回合身份校验失败。'), { code: 'AGENT_TURN_IDENTITY_MISMATCH', status: 409 })
          turn.turnId = turnId
          turn.awaitingIdentity = false
        },
        cancellationRequested: () => turn.stopRequested || (turn.message
          ? intents.has(turn.message.id) || Number.isFinite(turn.message.turnCancellationRequestedAt) : false),
        release() {
          const owned = ownsScope()
          if (active === turn) active = undefined
          return owned
        },
        abort() { turn.controller.abort(); if (active === turn) active = undefined },
      }
    },
    cancellationRequestedAt: (messageId: string) => intents.get(messageId),
    rememberCancellation: (messageId: string, requestedAt: number) => { intents.set(messageId, requestedAt) },
    isCancelling: (turnId: string) => cancellations.has(turnId),
    ensureCancelled,
    stop(turnId?: string) {
      const turn = active
      return stopBotanicAgentPlanning({
        turnId: turnId || turn?.turnId, turnIdentityPending: turn?.awaitingIdentity,
        cancelTurn: (id) => ensureCancelled(id, turn?.controller.signal),
        cancelWhenAccepted: () => { if (turn) turn.stopRequested = true },
        abortLocalRequest: () => turn?.controller.abort(),
      })
    },
    detach,
  }
}
