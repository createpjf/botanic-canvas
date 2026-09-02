// @ts-check
import { generationIdempotencyKey } from './generationIdempotency.mjs'
import { validateBotanicAgentTurnInput } from './botanicAgentTurn.mjs'
import { agentTurnLastSequence, publicAgentTurn } from './botanicAgentTurnRuntime.mjs'
import { AGENT_PROTOCOL_VERSION } from './agentProtocol.mjs'
import { publicAgentRun } from './botanicAgentRun.mjs'
import { requireProjectPermission } from './projectAuthorization.mjs'

function routeFailure(caught) {
  return /** @type {Error & { code?: string, statusCode?: number }} */ (
    caught instanceof Error ? caught : new Error('Agent 请求失败。')
  )
}

const terminalTurnStatuses = new Set(['completed', 'failed', 'cancelled'])

/** `done` 是业务终态；仍需 GET 观察的 Turn 用 handoff 结束当前传输连接。 */
export function agentTurnStreamSettlementEvent({ turnId, projectId, execution }) {
  const runtimeTurn = execution?.turn
  if (terminalTurnStatuses.has(runtimeTurn?.status)) {
    return {
      type: 'done',
      turn: execution.result ?? runtimeTurn?.result,
      runtimeTurn,
    }
  }
  return {
    type: 'handoff',
    turnId,
    runtimeTurn,
    observer: { url: `/api/agent-turns/${encodeURIComponent(turnId)}?after=0` },
    projectId,
  }
}

/** HTTP Adapter：只处理 Turn 的传输协议，提交权威归 agentTurnSubmission。 */
export function createAgentTurnHttpAdapter({
  config,
  productStore,
  json,
  error,
  readJson,
  requireUser,
  enforceRateLimit,
  createSse,
  turnSubmission,
  cancellationService,
  publishAgentRunUpdated,
}) {
  const methodNotAllowed = (response, message, allow) => json(
    response,
    405,
    { error: { code: 'METHOD_NOT_ALLOWED', message } },
    { Allow: allow },
  )

  return async function handleAgentTurnRoute({ request, response, url, routeMatches, requestId }) {
    const {
      agentTurns: agentTurnsMatch,
      agentTurnStream: agentTurnStreamMatch,
      agentTurn: agentTurnMatch,
      agentTurnCancel: agentTurnCancelMatch,
    } = routeMatches
    if (!agentTurnsMatch && !agentTurnStreamMatch && !agentTurnMatch && !agentTurnCancelMatch) return false

    // Protocol v1(CS2):缺版本按 v1 兼容;显式传入未知版本 fail closed,
    // 不让新客户端拿旧语义静默解释。
    const requestedProtocol = request.headers['x-agent-protocol-version']
    if (requestedProtocol !== undefined && Number(requestedProtocol) !== AGENT_PROTOCOL_VERSION) {
      return error(response, 400, 'AGENT_PROTOCOL_VERSION_UNSUPPORTED', `Agent 协议版本不受支持,当前为 v${AGENT_PROTOCOL_VERSION}。`)
    }

    if (agentTurnsMatch || agentTurnStreamMatch) {
      const streaming = Boolean(agentTurnStreamMatch)
      if (request.method !== 'POST') return methodNotAllowed(response, 'Agent Turn 资源只接受提交请求。', 'POST')
      const user = await requireUser(request)
      if (!await enforceRateLimit(response, {
        scope: 'agent-chat',
        subject: user.id,
        limit: config.security.agentChatsPerFiveMinutes,
        windowMs: 5 * 60_000,
      })) return true
      if (!config.flockApiBaseUrl || !config.flockApiKey || !config.flockTextModel) {
        return error(response, 503, 'PROVIDER_NOT_CONFIGURED', 'Agent 服务尚未配置。')
      }
      const idempotencyKey = generationIdempotencyKey(request.headers['idempotency-key'])
      if (!idempotencyKey) {
        return error(response, 400, 'INVALID_IDEMPOTENCY_KEY', 'Agent Turn 提交标识无效，请重试。')
      }
      const validatedInput = validateBotanicAgentTurnInput(await readJson(
        request,
        config.maximumPromptRefinementRequestBytes,
        'Agent Turn 请求过大，请精简后重试。',
      ))
      if (!validatedInput.sessionId && config.agentLegacyClientHistory !== true) {
        return error(response, 426, 'AGENT_THREAD_CONTEXT_REQUIRED', 'Agent Turn 必须使用会话与当前消息的稳定身份。')
      }
      const legacySessionId = typeof request.headers['x-agent-session-id'] === 'string'
        ? request.headers['x-agent-session-id']
        : undefined
      const sse = streaming ? createSse(response) : undefined
      const pendingTurnEvents = []
      let acceptedSent = false
      let submission
      try {
        submission = await turnSubmission().submitCanonical({
          userId: user.id,
          validatedInput,
          legacySessionId,
          requestId,
          idempotencyKey,
          onEvent: (event) => {
            if (!sse) return
            if (!acceptedSent) pendingTurnEvents.push(event)
            else sse.send(event)
          },
        })
      } catch (caught) {
        const failure = routeFailure(caught)
        if (failure.code === 'AGENT_THREAD_SUMMARY_CAS_REQUIRED') throw caught
        const statusCode = Number(failure.statusCode)
        if (!Number.isInteger(statusCode)) throw caught
        return error(
          response,
          statusCode,
          failure.code ?? 'AGENT_TURN_PREPARATION_FAILED',
          failure.message || 'Agent 回合准备失败。',
        )
      }
      const { turnId } = submission
      sse?.start()
      try {
        const durableTurn = await submission.accepted
        if (!sse) return json(response, 202, {
          protocolVersion: AGENT_PROTOCOL_VERSION,
          runtimeTurn: publicAgentTurn(durableTurn),
          observer: { url: `/api/agent-turns/${encodeURIComponent(turnId)}?after=0` },
        })
        sse.send({
          type: 'accepted',
          turnId,
          runtimeTurn: { id: turnId, projectId: validatedInput.projectId },
          observer: { url: `/api/agent-turns/${encodeURIComponent(turnId)}?after=0` },
        })
        acceptedSent = true
        for (const event of pendingTurnEvents.splice(0)) sse.send(event)
        const execution = await submission.execution
        if (response.destroyed) return true
        sse.send(agentTurnStreamSettlementEvent({
          turnId,
          projectId: validatedInput.projectId,
          execution,
        }))
        return sse.end()
      } catch (caught) {
        if (response.destroyed) return true
        const failure = routeFailure(caught)
        const statusCode = Number.isInteger(Number(failure.statusCode)) ? Number(failure.statusCode) : 502
        if (sse?.started) {
          sse.send({
            type: 'error',
            code: failure.code ?? 'AGENT_TURN_FAILED',
            message: failure.message || 'Agent 回合未完成，请重试。',
          })
          return sse.end()
        }
        return error(
          response,
          statusCode,
          failure.code ?? 'AGENT_TURN_FAILED',
          failure.message || 'Agent 回合未完成，请重试。',
        )
      } finally {
        sse?.end()
      }
    }

    if (agentTurnCancelMatch) {
      if (request.method !== 'POST') return methodNotAllowed(response, 'Agent Turn 取消资源只接受提交请求。', 'POST')
      const user = await requireUser(request)
      const turnId = decodeURIComponent(agentTurnCancelMatch[1])
      const turn = await productStore.readAgentTurn(user.id, turnId)
      if (!turn) return error(response, 404, 'AGENT_TURN_NOT_FOUND', '未找到该 Agent Turn。')
      // 取消是有副作用的深取消（级联 linked Run / Subagent）。readAgentTurn 目前按
      // owner 作用域读，这里再显式断言一次：将来 Turn 若开放项目级可见，这条边界
      // 不能跟着放开——项目成员也不能打断别人正在执行的回合。
      if (turn.ownerId !== user.id) {
        return error(response, 403, 'AGENT_TURN_CANCEL_FORBIDDEN', '只有发起者能取消该 Agent 回合。')
      }
      await requireProjectPermission(productStore, user.id, turn.projectId, 'read')
      const cancellation = await cancellationService().cancelAgentTurn({
        userId: user.id,
        projectId: turn.projectId,
        turnId,
        requestedBy: user.id,
      })
      const cancelled = await productStore.readAgentTurn(user.id, turnId) ?? turn
      const linkedRuns = await productStore.listAgentRunsForTurn(user.id, turn.projectId, turnId) ?? []
      await Promise.allSettled(linkedRuns.map((run) => publishAgentRunUpdated?.({
        projectId: turn.projectId,
        run: publicAgentRun(run),
      })))
      return json(response, 200, { turn: publicAgentTurn(cancelled), cancellation })
    }

    if (request.method !== 'GET') return methodNotAllowed(response, 'Agent Turn 资源只支持读取。', 'GET')
    const user = await requireUser(request)
    const turn = await productStore.readAgentTurn(user.id, decodeURIComponent(agentTurnMatch[1]))
    if (!turn) return error(response, 404, 'AGENT_TURN_NOT_FOUND', '未找到该 Agent Turn。')
    await requireProjectPermission(productStore, user.id, turn.projectId, 'read')
    const rawAfter = url.searchParams.get('after')
    const rawLimit = url.searchParams.get('limit')
    if (rawAfter !== null && !/^\d+$/.test(rawAfter)) {
      return error(response, 400, 'INVALID_AGENT_TURN_CURSOR', 'Agent Turn 事件游标无效。')
    }
    if (rawLimit !== null && !/^\d+$/.test(rawLimit)) {
      return error(response, 400, 'INVALID_AGENT_TURN_LIMIT', 'Agent Turn 事件数量无效。')
    }
    const after = rawAfter === null ? undefined : Number(rawAfter)
    const limit = rawLimit === null ? 100 : Number(rawLimit)
    if (!Number.isSafeInteger(after ?? 0) || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      return error(response, 400, 'INVALID_AGENT_TURN_CURSOR', 'Agent Turn 续读参数无效。')
    }
    const eventPage = await productStore.listAgentTurnEvents(user.id, turn.projectId, turn.id, {
      ...(after !== undefined ? { after } : {}),
      limit: limit + 1,
    }) ?? []
    const turnEvents = eventPage.slice(0, limit)
    const linkedRuns = await productStore.listAgentRunsForTurn(user.id, turn.projectId, turn.id) ?? []
    return json(response, 200, {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      turn: publicAgentTurn(turn, {
        lastSequence: agentTurnLastSequence(turnEvents),
        linkedRunIds: linkedRuns.map((run) => run.id),
      }),
      events: turnEvents,
      cursor: {
        after: turnEvents.length ? agentTurnLastSequence(turnEvents) : (after ?? 0),
        hasMore: eventPage.length > limit,
      },
    })
  }
}
