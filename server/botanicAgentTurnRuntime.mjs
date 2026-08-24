import { createHash, randomUUID } from 'node:crypto'

const terminalStatuses = new Set(['completed', 'failed', 'cancelled'])

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function stableId(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 32)
}

function safeError(caught) {
  return {
    code: typeof caught?.code === 'string' ? caught.code : 'AGENT_TURN_FAILED',
    message: typeof caught?.message === 'string' ? caught.message.slice(0, 500) : 'Agent 回合未完成，请重试。',
  }
}

function persistedResult(result) {
  if (!result || typeof result !== 'object') return undefined
  const safe = clone(result)
  // 原始思维链只允许跟随当轮实时响应，不能进入 Turn、事件或消息持久化。
  delete safe.reasoning
  return safe
}

function eventPayload(event) {
  if (event?.type !== 'tool') return undefined
  const toolCall = event.toolCall ?? {}
  return {
    step: Number.isInteger(event.step) ? event.step : undefined,
    toolName: typeof toolCall.name === 'string' ? toolCall.name.slice(0, 120) : undefined,
    toolCallId: typeof toolCall.id === 'string' ? toolCall.id.slice(0, 160) : undefined,
    status: typeof toolCall.status === 'string' ? toolCall.status : undefined,
  }
}

function publicTurn(turn) {
  if (!turn) return undefined
  const result = {
    id: turn.id,
    version: 2,
    projectId: turn.projectId,
    ownerId: turn.ownerId,
    ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
    ...(turn.requestId ? { requestId: turn.requestId } : {}),
    idempotencyKey: turn.idempotencyKey,
    status: turn.status,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
    ...(turn.result ? { result: clone(turn.result) } : {}),
    ...(turn.error ? { error: clone(turn.error) } : {}),
  }
  return result
}

export function agentTurnIdForIdempotency(userId, projectId, idempotencyKey) {
  return `turn_${stableId(`${userId}:${projectId}:${idempotencyKey}`)}`
}

export function createAgentTurnRecord({ id, ownerId, projectId, sessionId, requestId, idempotencyKey, now = Date.now() }) {
  if (!id || !ownerId || !projectId || !idempotencyKey) throw new TypeError('Agent Turn 缺少幂等边界。')
  return {
    id,
    version: 2,
    ownerId,
    projectId,
    ...(sessionId ? { sessionId } : {}),
    ...(requestId ? { requestId } : {}),
    idempotencyKey,
    status: 'running',
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Turn Runtime 的唯一执行 seam。解析器可以是视觉回合、文本回合或测试替身；
 * 运行时只负责幂等、生命周期、可恢复事件和“不持久化思维链”这一边界。
 */
export function createBotanicAgentTurnRuntime({ productStore, now = () => Date.now() } = {}) {
  if (!productStore) throw new TypeError('Agent Turn Runtime 缺少 ProductStore。')
  const activeTurns = new Map()
  const cancelledTurns = new Set()

  const append = async (userId, projectId, turnId, sequence, type, payload) => {
    const event = {
      id: `turn_event_${randomUUID()}`,
      turnId,
      projectId,
      sequence,
      type,
      createdAt: now(),
      ...(payload ? { payload: clone(payload) } : {}),
    }
    await productStore.appendAgentTurnEvent(userId, projectId, event)
    return event
  }

  async function execute({ userId, projectId, sessionId, requestId, id, idempotencyKey, resolve, resolveOptions = {}, onEvent } = {}) {
    if (typeof resolve !== 'function') throw new TypeError('Agent Turn Runtime 缺少解析器。')
    const activeKey = `${userId}:${projectId}:${id}`
    const active = activeTurns.get(activeKey)
    if (active) return active
    const run = (async () => {
    const existing = await productStore.readAgentTurn(userId, id)
    if (existing && existing.projectId !== projectId) throw Object.assign(new Error('Agent Turn 不属于当前项目。'), { code: 'AGENT_TURN_PROJECT_MISMATCH', statusCode: 409 })
    if (existing && terminalStatuses.has(existing.status)) {
      return { turn: publicTurn(existing), events: await productStore.listAgentTurnEvents(userId, projectId, id) }
    }

    const turn = existing ?? createAgentTurnRecord({ id, ownerId: userId, projectId, sessionId, requestId, idempotencyKey, now: now() })
    if (turn.status !== 'running') {
      turn.status = 'running'
      turn.updatedAt = now()
      turn.error = undefined
      await productStore.putAgentTurn(userId, turn)
    } else if (!existing) {
      await productStore.putAgentTurn(userId, turn)
    }

    let sequence = ((await productStore.listAgentTurnEvents(userId, projectId, id)) ?? []).reduce((max, event) => Math.max(max, Number(event.sequence) || 0), 0)
    if (!sequence) await append(userId, projectId, id, ++sequence, 'turn.started', { status: 'running' })
    const liveEvents = []
    const pendingEventWrites = []
    let persistedEventChain = Promise.resolve()
    const notify = (event) => {
      try { onEvent?.(event) } catch { /* 展示层异常不得中断执行。 */ }
    }
    const emit = (event) => {
      const eventSequence = ++sequence
      const envelope = { ...clone(event), turnId: id, eventId: `turn_live_${randomUUID()}`, sequence: eventSequence }
      liveEvents.push(envelope)
      const payload = eventPayload(event)
      // 工具事件先落到追加式 Event Store，再交给 SSE；非持久化的 reasoning/answer
      // 也排在前一个工具写入之后，避免客户端看到尚未可恢复的步骤顺序。
      const persisted = payload
        ? persistedEventChain.then(() => append(userId, projectId, id, eventSequence, 'turn.tool', payload))
        : persistedEventChain
      if (payload) persistedEventChain = persisted
      const delivery = persisted.then(() => notify(envelope))
      pendingEventWrites.push(delivery)
    }

    try {
      const result = await resolve({ ...resolveOptions, onEvent: emit })
      if (cancelledTurns.has(activeKey) || (await productStore.readAgentTurn(userId, id))?.status === 'cancelled') {
        throw Object.assign(new Error('用户取消了 Agent 回合。'), { code: 'AGENT_TURN_CANCELLED', statusCode: 499 })
      }
      await Promise.all(pendingEventWrites)
      const saved = {
        ...turn,
        status: 'completed',
        updatedAt: now(),
        result: persistedResult(result),
        error: undefined,
      }
      await productStore.putAgentTurn(userId, saved)
      await append(userId, projectId, id, ++sequence, 'turn.completed', { kind: result?.kind })
      const persistedEvents = await productStore.listAgentTurnEvents(userId, projectId, id)
      return {
        turn: publicTurn(saved),
        result: clone(result),
        // 工具步骤已在 persistedEvents 中，当前回合的 reasoning/answer 只随实时响应保留。
        events: [...(persistedEvents ?? []), ...liveEvents.filter((event) => event.type !== 'tool')],
      }
    } catch (caught) {
      const error = safeError(caught)
      const cancelled = error.code === 'REQUEST_CANCELLED' || error.code === 'ABORT_ERR' || error.code === 'AGENT_TURN_CANCELLED'
      const saved = {
        ...turn,
        status: cancelled ? 'cancelled' : 'failed',
        updatedAt: now(),
        error,
      }
      await productStore.putAgentTurn(userId, saved)
      await append(userId, projectId, id, ++sequence, cancelled ? 'turn.cancelled' : 'turn.failed', error)
      throw Object.assign(caught instanceof Error ? caught : new Error(error.message), { code: error.code, statusCode: caught?.statusCode ?? (cancelled ? 499 : 502), turn: publicTurn(saved), events: liveEvents })
    }
    })()
    activeTurns.set(activeKey, run)
    try { return await run } finally {
      activeTurns.delete(activeKey)
      cancelledTurns.delete(activeKey)
    }
  }

  async function cancel({ userId, projectId, turnId, reason = '用户取消了 Agent 回合。' } = {}) {
    const turn = await productStore.readAgentTurn(userId, turnId)
    if (!turn || turn.projectId !== projectId) return undefined
    if (terminalStatuses.has(turn.status)) return publicTurn(turn)
    const activeKey = `${userId}:${projectId}:${turnId}`
    const isActive = activeTurns.has(activeKey)
    if (isActive) cancelledTurns.add(activeKey)
    const saved = { ...turn, status: 'cancelled', updatedAt: now(), error: { code: 'AGENT_TURN_CANCELLED', message: reason } }
    await productStore.putAgentTurn(userId, saved)
    // 活跃解析器会在收到 AbortSignal 后统一追加终态事件；这里不要抢占同一
    // sequence，否则 Postgres 的唯一约束会把真实解析错误改写成取消冲突。
    if (isActive) return publicTurn(saved)
    const events = await productStore.listAgentTurnEvents(userId, projectId, turnId)
    const sequence = events.reduce((max, event) => Math.max(max, Number(event.sequence) || 0), 0)
    await append(userId, projectId, turnId, sequence + 1, 'turn.cancelled', saved.error)
    return publicTurn(saved)
  }

  return { execute, cancel, publicTurn }
}

export { publicTurn as publicAgentTurn }
