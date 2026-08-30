// @ts-check
import {
  agentCompatibilityResult,
  createAgentCompatibilityRuntimeRequest,
  resolveBotanicAgentRuntimeRequest,
} from './agentRuntimeRequest.mjs'
import { publicAgentTurn } from './botanicAgentTurnRuntime.mjs'

/** 旧 plan/chat/intent 的深模块：兼容响应不再拥有另一套 Turn 生命周期。 */
export function createAgentCompatibilityTurn({
  config,
  productStore,
  turnSubmission,
  durableSubagentRunner,
  observeAgentContext,
  persistUsageAnchor,
}) {
  return async function executeCompatibilityTurn({
    operation,
    request,
    response,
    user,
    projectId,
    sessionId,
    requestId,
    idempotencyKey,
    input,
    resolveOptions,
    sse,
  }) {
    let detach = () => {}
    let observerDetached = false
    const detached = new Promise((resolve) => {
      detach = () => {
        if (observerDetached) return
        observerDetached = true
        resolve({ kind: 'detached' })
      }
    })
    const detachOnAbortedRequest = () => detach()
    const detachOnClosedResponse = () => {
      if (!response.writableEnded) detach()
    }
    request.once('aborted', detachOnAbortedRequest)
    response.once('close', detachOnClosedResponse)
    if (request.aborted || response.destroyed) detach()
    const runtimeRequest = createAgentCompatibilityRuntimeRequest(operation, input)
    const pendingTurnEvents = []
    let acceptedSent = false
    const submission = turnSubmission().submit({
      userId: user.id,
      projectId,
      ...(sessionId ? { sessionId } : {}),
      requestId,
      idempotencyKey,
      request: runtimeRequest,
      resolve: (runtimeOptions) => resolveBotanicAgentRuntimeRequest(runtimeRequest, config, runtimeOptions),
      resolveOptions: {
        ...resolveOptions,
        subagentRunner: durableSubagentRunner,
        observeAgentContext,
        ...(sessionId ? {
          persistAgentContextUsageAnchor: persistUsageAnchor({ userId: user.id, projectId, sessionId }),
        } : {}),
      },
      onEvent: (event) => {
        if (!sse || observerDetached) return
        if (!acceptedSent) pendingTurnEvents.push(event)
        else sse.send(event)
      },
    })
    const { turnId, execution } = submission
    try {
      const durableOutcome = await Promise.race([
        submission.accepted.then((turn) => ({ kind: 'durable', turn })),
        detached,
      ])
      if (durableOutcome.kind === 'detached') return { detached: true }
      const durableTurn = durableOutcome.turn
      if (sse && !response.destroyed) {
        sse.send({
          type: 'accepted',
          turnId,
          runtimeTurn: { id: turnId, projectId },
          observer: { url: `/api/agent-turns/${encodeURIComponent(turnId)}?after=0` },
        })
        acceptedSent = true
        for (const event of pendingTurnEvents.splice(0)) sse.send(event)
      }
      if (durableTurn.result) return {
        body: agentCompatibilityResult(operation, durableTurn.result),
        runtimeTurn: publicAgentTurn(durableTurn),
      }
      const prefer = String(request.headers.prefer ?? '').toLowerCase()
      if (!sse && prefer.split(',').some((item) => item.trim() === 'respond-async')) return {
        pending: true,
        runtimeTurn: publicAgentTurn(durableTurn),
        observer: { url: `/api/agent-turns/${encodeURIComponent(turnId)}?after=0` },
      }
      const executionOutcome = await Promise.race([
        execution.then((value) => ({ kind: 'execution', value })),
        detached,
      ])
      if (executionOutcome.kind === 'detached') return { detached: true }
      let result = executionOutcome.value.result ?? executionOutcome.value.turn?.result
      let runtimeTurn = executionOutcome.value.turn
      const observationDeadline = Date.now() + 65_000
      while (!result && Date.now() < observationDeadline) {
        const wait = await Promise.race([
          new Promise((resolve) => setTimeout(() => resolve({ kind: 'tick' }), 250)),
          detached,
        ])
        if (wait.kind === 'detached') return { detached: true }
        const observed = await productStore.readAgentTurn(user.id, turnId)
        if (!observed) continue
        runtimeTurn = publicAgentTurn(observed)
        result = observed.result
        if (observed.status === 'failed' || observed.status === 'cancelled') {
          throw Object.assign(new Error(observed.error?.message ?? 'Agent Runtime 未完成。'), {
            code: observed.error?.code ?? (observed.status === 'cancelled'
              ? 'AGENT_TURN_CANCELLED'
              : 'AGENT_TURN_FAILED'),
            statusCode: observed.status === 'cancelled' ? 499 : 502,
          })
        }
      }
      if (!result) throw Object.assign(new Error('Agent Runtime 仍在执行，请使用同一提交键继续观察。'), {
        code: 'AGENT_RUNTIME_IN_PROGRESS',
        statusCode: 425,
        runtimeTurn: runtimeTurn ?? publicAgentTurn(durableTurn),
      })
      return {
        body: agentCompatibilityResult(operation, result),
        runtimeTurn: runtimeTurn ?? publicAgentTurn(durableTurn),
      }
    } finally {
      request.off('aborted', detachOnAbortedRequest)
      response.off('close', detachOnClosedResponse)
    }
  }
}
