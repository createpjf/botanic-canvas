import { createHash, randomUUID } from 'node:crypto'
import {
  agentTurnRequestHash,
  agentTurnRequestHashVersion,
  currentAgentTurnRequestHashVersion,
  storedAgentTurnRequestBinding,
} from './agentTurnRequestIdentity.mjs'
import { validateAgentEntityReferences, validateAgentToolEntityReferences } from '../../agentEntityReferences.mjs'
import { withBotanicSpan } from '../../observability/executionTelemetry.mjs'
import { AGENT_SEMANTIC_EVENT_NAMES, writeAgentSemanticEvent } from '../../observability/agentSemanticEvent.mjs'
import { registerAgentDiagnosticGauge } from '../../observability/agentRuntimeDiagnostics.mjs'
import { createAgentTurnOutputPreview, agentTurnOutputPreviewEventPayload, normalizeAgentTurnOutputPreview } from './agentTurnOutputPreview.mjs'
import { agentTurnToolEventPayload } from './agentTurnToolEvent.mjs'

// completed Turn 仍可能拥有后续创建的 linked Run / Job；显式深取消必须能从
// completed 进入 cancelling，才能撤销这些已授权但尚未完成的下游任务。
const terminalStatuses = new Set(['failed', 'cancelled'])

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
  if (safe.entityReferences !== undefined) {
    safe.entityReferences = validateAgentEntityReferences(safe.entityReferences)
  }
  if (Array.isArray(safe.toolCalls)) {
    safe.toolCalls = safe.toolCalls.map((toolCall) => {
      if (toolCall?.entityReferences === undefined) return toolCall
      return {
        ...toolCall,
        entityReferences: validateAgentToolEntityReferences(toolCall.name, toolCall.entityReferences),
      }
    })
  }
  return safe
}

/**
 * @param {unknown} turn
 * @param {{ lastSequence?: number, linkedRunIds?: string[] }} [links] 读模型补充项。
 *   `lastSequence` 是客户端续读的起点：不暴露它，客户端只能重新拉取全部事件才知道
 *   自己读到哪。当前它由事件推导而非持久化，因此需要调用方传入；落库后此参数可以移除。
 *
 *   `linkedRunIds` 是这次回合确认出的 Run。它**故意**不持久化在 Turn 上：`execute()`
 *   把 `turn` 整条覆盖写回，反向写入会被那次覆盖清掉。权威边是 `run.turnId`，这里
 *   按它派生，因此不存在两侧不一致的状态。
 */
function publicTurn(turn, links = {}) {
  if (!turn) return undefined
  const outputPreview = ['running', 'cancelling'].includes(turn.status)
    ? normalizeAgentTurnOutputPreview(turn.outputPreview, turn.outputPreview?.updatedAt)
    : undefined
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
    ...(Number.isInteger(turn.lastSequence)
      ? { lastSequence: turn.lastSequence }
      : (Number.isInteger(links.lastSequence) ? { lastSequence: links.lastSequence } : {})),
    ...(Array.isArray(links.linkedRunIds) ? { linkedRunIds: [...links.linkedRunIds] } : {}),
    ...(outputPreview ? { outputPreview: clone(outputPreview) } : {}),
    ...(turn.result ? { result: clone(turn.result) } : {}),
    ...(turn.error ? { error: clone(turn.error) } : {}),
  }
  return result
}

/** 事件列表里的最大序号。恢复与读模型共用，避免两处各写一遍 reduce。 */
export function agentTurnLastSequence(events) {
  return (Array.isArray(events) ? events : [])
    .reduce((max, event) => Math.max(max, Number(event?.sequence) || 0), 0)
}

export function agentTurnIdForIdempotency(userId, projectId, idempotencyKey) {
  return `turn_${stableId(`${userId}:${projectId}:${idempotencyKey}`)}`
}

/**
 * 请求快照里不允许出现媒体字节。图片经稳定媒体标识进入解析器，快照只存标识；
 * 递归检查是因为上下文与 Prompt 结构是嵌套的，浅层检查挡不住。
 * 与 `botanicAgentRun.mjs` 的 `containsMediaPayload` 同一条边界。
 */
function containsMediaPayload(value) {
  if (!value || typeof value !== 'object') return false
  for (const [key, entry] of Object.entries(value)) {
    if (['image', 'dataurl', 'buffer', 'bytes'].includes(key.toLowerCase())) return true
    if (containsMediaPayload(entry)) return true
  }
  return false
}

/**
 * 可重放的请求快照。没有它，非终态 Turn 的恢复无从下手 —— Turn 记录原先只有身份
 * 与生命周期字段，重建解析器输入所需的 locale、挂载 Skill、上下文节点全都不在。
 *
 * 只保留重建输入所需的字段，不保留解析产物：`result` 由生命周期字段承载，
 * 原始 reasoning 始终不落盘（ADR 0004）。
 */
export function agentTurnRequestSnapshot(request) {
  if (!request || typeof request !== 'object') return undefined
  if (containsMediaPayload(request)) {
    throw Object.assign(new TypeError('Agent Turn 请求快照不能包含媒体字节。'), { code: 'AGENT_TURN_MEDIA_FORBIDDEN' })
  }
  return clone(request)
}

/** Turn lifetime（H3A）：默认 600s，clamp 60–900s。与 lease 无关：lease 是执行权，这是业务时限。 */
export const DEFAULT_AGENT_TURN_LIFETIME_MS = 600_000
export function boundedAgentTurnLifetimeMs(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_AGENT_TURN_LIFETIME_MS
  return Math.max(60_000, Math.min(parsed, 900_000))
}

/**
 * Turn 的业务期限。deadlineAt 在 Turn 顶层、与 createdAt 同级：绝不进入 request，
 * 因此不影响 request intent/hash；相同幂等键重试命中原 Turn 和原 deadline；
 * reclaim 后不重置。旧 Turn 没有该字段时用 createdAt 兼容推导。
 */
export function agentTurnDeadlineAt(turn, lifetimeMs) {
  const explicit = Number(turn?.deadlineAt)
  if (Number.isSafeInteger(explicit) && explicit > 0) return explicit
  const createdAt = Number(turn?.createdAt)
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0) return undefined
  return createdAt + boundedAgentTurnLifetimeMs(lifetimeMs)
}

export function createAgentTurnRecord(input) {
  const { id, ownerId, projectId, sessionId, requestId, idempotencyKey, request, now = Date.now(), lifetimeMs } = input ?? {}
  if (!id || !ownerId || !projectId || !idempotencyKey) throw new TypeError('Agent Turn 缺少幂等边界。')
  const snapshot = agentTurnRequestSnapshot(request)
  return {
    id,
    version: 2,
    ownerId,
    projectId,
    ...(sessionId ? { sessionId } : {}),
    ...(requestId ? { requestId } : {}),
    idempotencyKey,
    requestHashVersion: currentAgentTurnRequestHashVersion,
    requestHash: agentTurnRequestHash(snapshot, currentAgentTurnRequestHashVersion),
    ...(snapshot ? { request: snapshot } : {}),
    status: 'queued',
    lastSequence: 0,
    createdAt: now,
    updatedAt: now,
    deadlineAt: now + boundedAgentTurnLifetimeMs(lifetimeMs),
  }
}

/**
 * Turn Runtime 的唯一执行 seam。解析器可以是视觉回合、文本回合或测试替身；
 * 运行时只负责幂等、生命周期、可恢复事件和“不持久化思维链”这一边界。
 */
/** 恢复代际上限（H3A）：generation 1–3 可进业务 resolver；4 只允许 terminal-only 收口。 */
const MAX_AGENT_TURN_BUSINESS_GENERATION = 3

export function createBotanicAgentTurnRuntime({
  productStore,
  localCancelRegistry,
  now = () => Date.now(),
  leaseMs = 120_000,
  heartbeatMs = 30_000,
  turnLifetimeMs = DEFAULT_AGENT_TURN_LIFETIME_MS,
  durabilityDrainMs = 15_000,
  semanticWriter = writeAgentSemanticEvent,
} = {}) {
  if (!productStore) throw new TypeError('Agent Turn Runtime 缺少 ProductStore。')
  const activeTurns = new Map()
  const cancelledTurns = new Set()
  // content-free 诊断(CS3):只暴露计数,事实仍归本模块所有。
  registerAgentDiagnosticGauge('agent.turns.active', () => activeTurns.size)
  registerAgentDiagnosticGauge('agent.turns.pending_cancel_acks', () => cancelledTurns.size)
  if (localCancelRegistry) registerAgentDiagnosticGauge('agent.turns.local_cancel_handles', () => localCancelRegistry.size)
  const boundedLeaseMs = Math.max(30_000, Math.min(Number(leaseMs) || 120_000, 900_000))
  const boundedHeartbeatMs = Math.max(10, Math.min(Number(heartbeatMs) || 30_000, Math.floor(boundedLeaseMs / 2)))
  const boundedTurnLifetimeMs = boundedAgentTurnLifetimeMs(turnLifetimeMs)
  const boundedDurabilityDrainMs = Math.max(10, Math.min(Number(durabilityDrainMs) || 15_000, 30_000))

  const executionError = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode })
  const recordPreviewSummary = (outcome, reason, summary = {}) => {
    try { semanticWriter(AGENT_SEMANTIC_EVENT_NAMES.HARNESS_LIFECYCLE, {
      kind: 'preview', outcome, reason,
      writeCount: Math.max(0, Number(summary.writeCount) || 0),
      maxCharCount: Math.max(0, Number(summary.maxCharCount) || 0),
      nonEmptyCount: typeof summary.text === 'string' && summary.text.trim() ? 1 : 0,
    }) } catch { /* metrics旁路fail-open */ }
  }
  const event = (turnId, projectId, type, payload) => ({
    id: `turn_event_${randomUUID()}`,
    turnId,
    projectId,
    type,
    createdAt: now(),
    ...(payload ? { payload: clone(payload) } : {}),
  })

  async function execute({
    userId,
    projectId,
    sessionId,
    requestId,
    id,
    idempotencyKey,
    request,
    resolve,
    resolveOptions = {},
    onEvent,
    allowTakeover = false,
  } = {}) {
    if (typeof resolve !== 'function') throw new TypeError('Agent Turn Runtime 缺少解析器。')
    if (typeof productStore.claimAgentTurnExecution !== 'function'
      || typeof productStore.commitAgentTurnExecution !== 'function') {
      throw new TypeError('Agent Turn Runtime 缺少原子执行权 Interface。')
    }
    const activeKey = `${userId}:${projectId}:${id}`
    const candidate = createAgentTurnRecord({
      id,
      ownerId: userId,
      projectId,
      sessionId,
      requestId,
      idempotencyKey,
      request,
      now: now(),
      lifetimeMs: boundedTurnLifetimeMs,
    })
    const active = activeTurns.get(activeKey)
    if (active) {
      if (active.requestHash !== candidate.requestHash) {
        throw executionError('AGENT_TURN_INTENT_CONFLICT', '同一回合提交标识已绑定到不同请求。')
      }
      return active.promise
    }

    const run = (async () => {
      const leaseToken = `agent_turn_lease_${randomUUID()}`
      const claim = await productStore.claimAgentTurnExecution(userId, {
        turn: candidate,
        leaseToken,
        leaseDurationMs: boundedLeaseMs,
        allowTakeover,
      })
      if (claim?.kind === 'conflict') {
        throw executionError('AGENT_TURN_INTENT_CONFLICT', '同一回合提交标识已绑定到不同请求。')
      }
      if (claim?.kind === 'replay') {
        const persistedEvents = await productStore.listAgentTurnEvents(userId, projectId, id)
        return { turn: publicTurn(claim.turn), events: persistedEvents ?? [] }
      }
      if (['in_progress', 'stale', 'waiting_user', 'cancelling'].includes(claim?.kind)) {
        const persistedEvents = await productStore.listAgentTurnEvents(userId, projectId, id)
        return {
          turn: publicTurn(claim.turn),
          events: persistedEvents ?? [],
          ...(claim.kind === 'in_progress' ? { inProgress: true } : {}),
          ...(claim.kind === 'stale' ? { recoveryRequired: true } : {}),
          ...(claim.kind === 'waiting_user' ? { waitingUser: true } : {}),
          ...(claim.kind === 'cancelling' ? { cancelling: true } : {}),
        }
      }
      if (claim?.kind !== 'claimed' || !claim.turn?.execution) {
        throw executionError('AGENT_TURN_CLAIM_FAILED', '无法取得 Agent 回合执行权。', 503)
      }

      let turn = claim.turn
      const executionGeneration = turn.execution.generation
      // 业务期限与恢复代际（H3A）。deadline 从 Turn 顶层读取，reclaim 不重置;
      // 旧 Turn 无该字段时按 createdAt 兼容推导。
      const deadlineAt = agentTurnDeadlineAt(turn, boundedTurnLifetimeMs)
      // cancel_observed（H7 0B）:durable 取消请求 → 本地执行者 abort 的传播延迟。
      // 只有权威记录存在 cancellation.requestedAt 才 emit(heartbeat 失租等
      // 非取消 abort 不产生事件);每次执行至多一次,旁路 fail-open。
      let cancelObservedEmitted = false
      const observeCancellationAbort = () => {
        if (cancelObservedEmitted) return
        cancelObservedEmitted = true
        const observedAt = now()
        void productStore.readAgentTurn(userId, id).then((authoritative) => {
          const requestedAt = Number(authoritative?.cancellation?.requestedAt)
          if (!['cancelling', 'cancelled'].includes(authoritative?.status)) return
          if (!Number.isSafeInteger(requestedAt) || requestedAt <= 0) return
          writeAgentSemanticEvent(AGENT_SEMANTIC_EVENT_NAMES.HARNESS_LIFECYCLE, {
            kind: 'cancel',
            outcome: 'cancel_observed',
            projectId,
            turnId: id,
            generation: executionGeneration,
            durationMs: Math.max(0, observedAt - requestedAt),
          })
        }).catch(() => undefined)
      }
      // AbortController 由权威 Runtime 拥有，而不是 HTTP 连接拥有。浏览器断线只会
      // 失去观察通道；只有 durable cancel fence 或跨实例 cancel signal 才能中止 Provider。
      const controller = new AbortController()
      controller.signal.addEventListener('abort', observeCancellationAbort, { once: true })
      const pendingDeliveries = []
      const persistedRunningToolCallIds = new Set()
      let persistedEventChain = Promise.resolve()
      let heartbeatFailure
      let heartbeatTriggeredAbort = false
      let heartbeatInFlight = Promise.resolve()

      const drainPersistence = async (settled = false) => {
        const remainingMs = typeof deadlineAt === 'number' ? Math.max(0, deadlineAt - now()) : boundedDurabilityDrainMs
        const timeoutMs = Math.min(boundedDurabilityDrainMs, remainingMs)
        let timeout
        try {
          await Promise.race([
            settled
              ? Promise.allSettled([heartbeatInFlight, ...pendingDeliveries])
              : Promise.all([heartbeatInFlight, ...pendingDeliveries]),
            new Promise((_, reject) => {
              timeout = setTimeout(() => reject(executionError(
                'AGENT_TURN_DURABILITY_UNAVAILABLE',
                'Agent 回合持久化收尾超时，请稍后恢复。',
                503,
              )), timeoutMs)
            }),
          ])
        } finally {
          clearTimeout(timeout)
        }
      }

      const notify = (entry) => {
        try { onEvent?.(entry) } catch { /* 展示层异常不得中断权威执行。 */ }
      }
      const commit = async (input = {}) => {
        const { status = 'running', checkpoint, result, error, turnEvent, signalId, releaseBasis } = input
        const command = {
          id,
          projectId,
          leaseToken,
          executionGeneration,
          status,
          ...(Object.hasOwn(input, 'checkpoint') ? { checkpoint: clone(checkpoint) } : {}),
          ...(Object.hasOwn(input, 'outputPreview') ? { outputPreview: clone(input.outputPreview) } : {}),
          ...(result !== undefined ? { result: clone(result) } : {}),
          ...(error !== undefined ? { error: clone(error) } : {}),
          ...(turnEvent ? { event: turnEvent } : {}),
          ...(signalId ? { signalId } : {}),
          ...(releaseBasis ? { releaseBasis } : {}),
        }
        const committed = await productStore.commitAgentTurnExecution(userId, command)
        if (committed?.kind === 'stale' || committed?.kind === 'missing' || committed?.kind === 'conflict') {
          throw executionError('AGENT_TURN_LEASE_STALE', 'Agent 回合执行权已由其他实例接管。')
        }
        if (['cancelling', 'cancellation_heartbeat', 'cancellation_acknowledged'].includes(committed?.kind)) {
          if (committed.turn) turn = committed.turn
          return committed
        }
        if (!['committed', 'replay'].includes(committed?.kind)) {
          throw executionError('AGENT_TURN_COMMIT_FAILED', 'Agent 回合状态暂时无法提交。', 503)
        }
        turn = committed.turn
        return committed
      }
      const acknowledgeCancellationExit = async () => {
        const authoritative = await productStore.readAgentTurn(userId, id).catch(() => undefined)
        if (authoritative?.status !== 'cancelling'
          || authoritative.cancellation?.signalRequired !== true
          || authoritative.cancellation?.workerReleased === true
          || typeof authoritative.cancellation.signalId !== 'string') return
        const acknowledged = await commit({
          status: 'running',
          signalId: authoritative.cancellation.signalId,
          releaseBasis: 'worker_exit',
        })
        if (!['cancellation_acknowledged', 'replay'].includes(acknowledged?.kind)) {
          throw executionError(
            'AGENT_TURN_CANCEL_ACK_FAILED',
            'Agent 回合执行者退出证明暂时无法持久化。',
            503,
          )
        }
      }
      const trackPersistence = (persist) => {
        const delivery = persistedEventChain.then(persist)
        // Resolver 允许 fire-and-forget emit / saveCheckpoint。立即挂 rejection
        // observer，避免 Store 很快失败而 terminal barrier 尚未开始等待时触发
        // unhandledRejection；原 promise 仍保留拒绝态，终态 barrier 会据此失败。
        void delivery.catch(() => undefined)
        // 失败也要先完成本次尝试再排下一项，既保持顺序，又避免一项失败让后续
        // 永远只继承 rejected chain、连 durable 收口的机会都没有。
        persistedEventChain = delivery.then(() => undefined, () => undefined)
        pendingDeliveries.push(delivery)
        return delivery
      }

      // Terminal-only 收口（H3A）：generation 4 的 claim 只允许提交具名失败，
      // 不得再调用 Provider/tool；旧 generation Worker 已无权收口的 Turn 由它终结。
      // 任何 generation > 4 都不该出现——上一代已终态化;若出现同样只做终态。
      if (executionGeneration > MAX_AGENT_TURN_BUSINESS_GENERATION) {
        writeAgentSemanticEvent(AGENT_SEMANTIC_EVENT_NAMES.HARNESS_LIFECYCLE, {
          kind: 'provider', outcome: 'resume_limit', projectId, turnId: id, generation: executionGeneration,
        })
        const resumeError = {
          code: 'AGENT_TURN_RESUME_LIMIT_REACHED',
          message: 'Agent 回合恢复次数已达上限，已停止执行。',
        }
        await commit({
          status: 'failed',
          error: resumeError,
          turnEvent: event(id, projectId, 'turn.failed', resumeError),
        })
        throw executionError(resumeError.code, resumeError.message, 409)
      }
      // 业务期限（H3A）：deadline 已过时不再启动 resolver;具名失败,不伪装 Provider 错。
      if (typeof deadlineAt === 'number' && now() >= deadlineAt) {
        writeAgentSemanticEvent(AGENT_SEMANTIC_EVENT_NAMES.HARNESS_LIFECYCLE, {
          kind: 'provider', outcome: 'deadline_exceeded', projectId, turnId: id, generation: executionGeneration,
        })
        const deadlineError = {
          code: 'AGENT_TURN_DEADLINE_EXCEEDED',
          message: 'Agent 回合已超过本轮时限，已停止执行。',
        }
        await commit({
          status: 'failed',
          error: deadlineError,
          turnEvent: event(id, projectId, 'turn.failed', deadlineError),
        })
        throw executionError(deadlineError.code, deadlineError.message, 504)
      }

      // 首次 accepted/started 事件与 running 状态同一 fenced commit；Store 分配 sequence。
      if (!Number(turn.lastSequence)) {
        const started = await commit({
          status: 'running',
          turnEvent: event(id, projectId, 'turn.started', { status: 'running' }),
        })
        if (started.kind === 'cancelling') {
          await acknowledgeCancellationExit()
          throw executionError('AGENT_TURN_CANCELLED', '用户取消了 Agent 回合。', 499)
        }
      }
      if (localCancelRegistry && !localCancelRegistry.register(id, controller)) {
        // DB generation 已完成 takeover，仍占着本地句柄的一定是旧执行者；先中止它，
        // 避免其继续占用 Provider。新 generation 本轮不与它并跑，交给下一次恢复接管。
        localCancelRegistry.abort(id)
        throw executionError('AGENT_TURN_LOCAL_EXECUTION_CONFLICT', '本实例已有该 Agent 回合的执行句柄。', 409)
      }
      try {
      // Redis cancel 可能恰好早于 register 到达：共享 Registry 当时还没有句柄，
      // 因而无法记住那次 abort。登记后补读 durable fence，随后到达的信号则由
      // Registry 接住，这两步合起来封住「已取消却启动 Provider」的窄竞态。
      const registeredTurn = await productStore.readAgentTurn(userId, id)
      if (['cancelling', 'cancelled'].includes(registeredTurn?.status)) controller.abort()
      // claim/started 与句柄登记之间收到本地取消时，cancelledTurns 已经留下事实；
      // 登记后立刻补 abort，不能让这个极窄窗口漏进 Provider。
      if (cancelledTurns.has(activeKey)) controller.abort()

      const maintainHeartbeat = async () => {
        let committed = await commit({
          status: 'running',
          ...(turn.status === 'cancelling' && turn.cancellation?.signalId
            ? { signalId: turn.cancellation.signalId }
            : {}),
        })
        if (committed.kind === 'cancelling') {
          controller.abort()
          if (turn.cancellation?.signalRequired === true && turn.cancellation.signalId) {
            committed = await commit({
              status: 'running',
              signalId: turn.cancellation.signalId,
            })
          }
        }
        if (committed.kind === 'cancellation_heartbeat') controller.abort()
        return committed
      }
      const heartbeatTimer = setInterval(() => {
        if (heartbeatFailure) return
        heartbeatInFlight = heartbeatInFlight.then(async () => {
          await maintainHeartbeat()
        }).catch((caught) => {
          heartbeatFailure = caught
          heartbeatTriggeredAbort = true
          // 心跳无法续租后，旧 executor 已不再具备继续产生副作用的安全边界。
          // 立即传递 abort，不等 Provider 自然返回后才发现 lease 已过期。
          controller.abort(caught)
        })
      }, boundedHeartbeatMs)
      heartbeatTimer.unref?.()

      const outputPreview = createAgentTurnOutputPreview({
        initialPreview: turn.outputPreview,
        persist: (snapshot) => trackPersistence(async () => {
          const previewEvent = event(
            id,
            projectId,
            'turn.output_preview.updated',
            agentTurnOutputPreviewEventPayload(snapshot),
          )
          previewEvent.id = `turn_preview_${stableId(`${id}:${executionGeneration}:${snapshot.revision}`)}`
          const committed = await commit({ status: 'running', outputPreview: snapshot, turnEvent: previewEvent })
          if (committed.kind === 'cancelling') {
            throw executionError('AGENT_TURN_CANCELLED', '用户取消了 Agent 回合。', 499)
          }
          const stored = committed.turn?.outputPreview ?? snapshot
          const envelope = {
            type: 'answer_snapshot', turnId: id, eventId: previewEvent.id,
            attemptId: stored.attemptId, revision: stored.revision, step: stored.step,
            text: stored.text, ...(stored.truncated ? { truncated: true } : {}),
            ...(Number.isInteger(committed.event?.sequence) ? { sequence: committed.event.sequence } : {}),
          }
          notify(envelope)
          return stored
        }),
      })

      const emit = (rawEvent) => {
        const persistLiveEvent = () => {
          const envelope = { ...clone(rawEvent), turnId: id, eventId: `turn_live_${randomUUID()}` }
          const payload = agentTurnToolEventPayload(rawEvent)
          const repeatedRunning = payload?.status === 'running'
            && payload.toolCallId
            && persistedRunningToolCallIds.has(payload.toolCallId)
          if (repeatedRunning) return persistedEventChain.then(() => notify(envelope))
          if (payload?.status === 'running' && payload.toolCallId) {
            persistedRunningToolCallIds.add(payload.toolCallId)
          }
          return trackPersistence(async () => {
            if (payload) {
              const committed = await commit({
                status: 'running',
                turnEvent: event(id, projectId, 'turn.tool', payload),
              })
              if (committed.kind === 'cancelling') {
                throw executionError('AGENT_TURN_CANCELLED', '用户取消了 Agent 回合。', 499)
              }
              if (Number.isInteger(committed.event?.sequence)) envelope.sequence = committed.event.sequence
            }
            notify(envelope)
          })
        }
        if (rawEvent?.type === 'tool') {
          const previewDelivery = outputPreview.observe(rawEvent)
          const liveDelivery = persistLiveEvent()
          return Promise.all([previewDelivery, liveDelivery])
        }
        const liveDelivery = persistLiveEvent()
        const previewDelivery = outputPreview.observe(rawEvent)
        return Promise.all([liveDelivery, previewDelivery])
      }

      const saveCheckpoint = (checkpoint) => {
        return trackPersistence(async () => {
          const committed = await commit({ status: 'running', checkpoint })
          if (committed.kind === 'cancelling') {
            throw executionError('AGENT_TURN_CANCELLED', '用户取消了 Agent 回合。', 499)
          }
          return clone(turn.checkpoint)
        })
      }

      try {
        // Resolver 只能观察当前已 claim 的权威身份。放在 resolveOptions 之后覆盖，且冻结
        // 对象，避免传输层伪造 root Turn 后把 Durable Subagent 挂到错误的取消树上。
        const runtimeIdentity = Object.freeze({
          userId,
          projectId,
          turnId: id,
          ...(requestId ? { requestId } : {}),
          ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
          executionGeneration,
          leaseToken,
        })
        const result = await withBotanicSpan('botanic.agent.turn', {
          kind: 'internal',
          attributes: {
            'botanic.component': 'worker',
            'botanic.phase': 'turn',
            'botanic.request.id': requestId,
            'botanic.project.id': projectId,
            'botanic.session.id': turn.sessionId,
            'botanic.turn.id': id,
            'botanic.execution.generation': executionGeneration,
          },
        }, () => resolve({
          ...resolveOptions,
          runtimeIdentity,
          requireDurableAttemptReset: true,
          // 明确覆盖调用方可能携带的 request.signal；传输层无权拥有 Turn 生命周期。
          signal: controller.signal,
          deadlineAt,
          onEvent: emit,
          ...(turn.checkpoint ? { resumeCheckpoint: clone(turn.checkpoint) } : {}),
          saveCheckpoint,
        }))
        const previewSummary = outputPreview.snapshot()
        outputPreview.discard()
        clearInterval(heartbeatTimer)
        await drainPersistence()
        if (heartbeatFailure) throw heartbeatFailure
        const authoritative = await productStore.readAgentTurn(userId, id)
        if (cancelledTurns.has(activeKey) || ['cancelling', 'cancelled'].includes(authoritative?.status)) {
          throw executionError('AGENT_TURN_CANCELLED', '用户取消了 Agent 回合。', 499)
        }
        const waitingUser = result?.kind === 'clarification'
        const completed = await commit({
          status: waitingUser ? 'waiting_user' : 'completed',
          result: persistedResult(result),
          turnEvent: event(
            id,
            projectId,
            waitingUser ? 'turn.waiting_user' : 'turn.completed',
            { kind: result?.kind },
          ),
        })
        if (completed.kind === 'cancelling') {
          throw executionError('AGENT_TURN_CANCELLED', '用户取消了 Agent 回合。', 499)
        }
        recordPreviewSummary('preview_settled', waitingUser ? 'WAITING_USER' : 'COMPLETED', previewSummary)
        const persistedEvents = await productStore.listAgentTurnEvents(userId, projectId, id)
        return {
          turn: publicTurn(turn),
          result: clone(result),
          // reasoning/answer 只随实时连接存在；持久化 Event 仅含安全工具摘要。
          events: persistedEvents ?? [],
        }
      } catch (caught) {
        const previewSummary = outputPreview.snapshot()
        outputPreview.discard()
        clearInterval(heartbeatTimer)
        // resolver 可能在 emit 后立刻失败。先等已排队的事件 commit 收口，再写终态，
        // 避免 terminal commit 抢先后让迟到的 running/tool commit 反向制造竞态。
        let drainFailure
        try { await drainPersistence(true) } catch (caughtDrain) { drainFailure = caughtDrain }
        // heartbeat abort 会让下游先抛 ABORT_ERR，但真实失败来源仍是
        // 续租提交。以 heartbeatFailure 为准，避免把存储/失租故障误记为用户取消。
        const failureSource = heartbeatFailure ?? drainFailure ?? caught
        const error = safeError(failureSource)
        const authoritative = await productStore.readAgentTurn(userId, id).catch(() => undefined)
        if (error.code === 'AGENT_TURN_LEASE_STALE') {
          throw Object.assign(failureSource instanceof Error ? failureSource : new Error(error.message), {
            code: error.code,
            statusCode: 409,
            turn: publicTurn(authoritative),
            events: [],
          })
        }
        const heartbeatObservedCancellation = heartbeatFailure?.code === 'AGENT_TURN_CANCELLED'
        const durableCancellation = cancelledTurns.has(activeKey)
          || heartbeatObservedCancellation
          || (!heartbeatTriggeredAbort && controller.signal.aborted)
          || ['cancelling', 'cancelled'].includes(authoritative?.status)
        // 只有 durable fence / Runtime 自有 AbortController 能证明这是深取消。
        // resolver 单独返回 ABORT_ERR / REQUEST_CANCELLED 只是执行失败，不能伪造
        // cancelled。真正的取消终态唯一由 finalizeCancellation 在下游传播完成后提交。
        if (durableCancellation) {
          if (authoritative) turn = authoritative
          throw Object.assign(failureSource instanceof Error ? failureSource : new Error(error.message), {
            code: 'AGENT_TURN_CANCELLED',
            statusCode: failureSource?.statusCode ?? 499,
            turn: publicTurn(authoritative ?? turn),
            events: [],
          })
        }
        let settled
        try {
          settled = await commit({
            status: 'failed',
            error,
            turnEvent: event(id, projectId, 'turn.failed', error),
          })
        } catch (settleError) {
          if (settleError?.code !== 'AGENT_TURN_LEASE_STALE') throw settleError
          turn = (await productStore.readAgentTurn(userId, id).catch(() => undefined)) ?? turn
        }
        const saved = settled?.turn ?? turn
        const cancellationWon = settled?.kind === 'cancelling'
        if (!cancellationWon && settled?.kind === 'committed') {
          recordPreviewSummary('preview_settled', 'FAILED', previewSummary)
        }
        throw Object.assign(failureSource instanceof Error ? failureSource : new Error(error.message), {
          code: cancellationWon ? 'AGENT_TURN_CANCELLED' : error.code,
          statusCode: failureSource?.statusCode ?? (cancellationWon ? 499 : 502),
          turn: publicTurn(saved),
          events: [],
        })
      }
      } finally {
        localCancelRegistry?.release(id, controller)
        try {
          await acknowledgeCancellationExit()
        } catch (caught) {
          // 不伪造 ack：持久化失败时保留 cancelling，最终只能等待 DB lease 过期。
          console.error(`[agent-turn] cancellation acknowledgement deferred for ${id}: ${caught instanceof Error ? caught.message : String(caught)}`)
        }
      }
    })()

    activeTurns.set(activeKey, { requestHash: candidate.requestHash, promise: run })
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
    if (typeof productStore.requestAgentTurnCancellation !== 'function') {
      throw executionError('AGENT_TURN_ATOMIC_CANCEL_REQUIRED', 'Agent Turn 原子取消迁移尚未部署。', 503)
    }
    const requested = await productStore.requestAgentTurnCancellation(userId, {
      id: turnId,
      projectId,
      reason,
      event: event(turnId, projectId, 'turn.cancelling', { code: 'AGENT_TURN_CANCELLED', message: reason }),
    })
    // durable fence 必须先于 abort。否则 Store 写失败会留下权威 running，随后 Sweep
    // 可能把一个用户已点取消、但只在内存里中止过的 Turn 当孤儿恢复。
    if (['cancelling', 'cancelled'].includes(requested?.turn?.status)) {
      if (activeTurns.has(activeKey)) cancelledTurns.add(activeKey)
      localCancelRegistry?.abort(turnId)
    }
    return publicTurn(requested?.turn ?? turn)
  }

  /** linked Run / Job 已完成 durable 取消后，把无活动执行者的 Turn 原子收口为 cancelled。 */
  async function finalizeCancellation({ userId, projectId, turnId, reason = '用户取消了 Agent 回合。' } = {}) {
    if (typeof productStore.finalizeAgentTurnCancellation !== 'function') {
      throw executionError('AGENT_TURN_ATOMIC_FINALIZE_REQUIRED', 'Agent Turn 原子取消收口迁移尚未部署。', 503)
    }
    const before = await productStore.readAgentTurn(userId, turnId)
    const finalized = await productStore.finalizeAgentTurnCancellation(userId, {
      id: turnId,
      projectId,
      reason,
      event: event(turnId, projectId, 'turn.cancelled', { code: 'AGENT_TURN_CANCELLED', message: reason }),
    })
    if (finalized?.kind === 'finalized') {
      recordPreviewSummary('preview_cancelled', 'CANCELLED', {
        writeCount: before?.outputPreview?.revision,
        maxCharCount: before?.outputPreview?.text?.length,
        text: before?.outputPreview?.text,
      })
    }
    return publicTurn(finalized?.turn ?? (finalized?.id ? finalized : undefined))
  }

  /** Sweep 对不可重放孤儿的 fenced 收口；先取得新 generation，旧实例随后无法覆盖。 */
  async function fail({ turn: sourceTurn, error } = {}) {
    if (!sourceTurn?.id || !sourceTurn?.ownerId || !sourceTurn?.projectId) {
      throw new TypeError('Agent Turn 失败收口缺少身份。')
    }
    if (typeof productStore.claimAgentTurnExecution !== 'function'
      || typeof productStore.commitAgentTurnExecution !== 'function') {
      throw new TypeError('Agent Turn Runtime 缺少原子执行权 Interface。')
    }
    // Sweep 传入的是扫描快照，不能把它（更不能把调用方临时补入的 request）当权威。
    // 先复读持久记录；随后所有 binding / fence 都只从这份记录取得。
    const authoritative = await productStore.readAgentTurn(sourceTurn.ownerId, sourceTurn.id)
    if (!authoritative || authoritative.projectId !== sourceTurn.projectId) return undefined
    if (terminalStatuses.has(authoritative.status) || authoritative.status === 'completed') {
      return publicTurn(authoritative)
    }

    const failureEvent = () => event(sourceTurn.id, sourceTurn.projectId, 'turn.failed', error)
    const commitFailure = async ({ leaseToken, executionGeneration }) => {
      try {
        const committed = await productStore.commitAgentTurnExecution(sourceTurn.ownerId, {
          id: sourceTurn.id,
          projectId: sourceTurn.projectId,
          leaseToken,
          executionGeneration,
          status: 'failed',
          error: clone(error),
          event: failureEvent(),
        })
        return publicTurn(committed?.turn ?? authoritative)
      } catch (caught) {
        // takeover / cancel 可能恰好抢在 commit 前。它们不是本次失败收口成功；
        // 复读真实状态交给 Sweep 计数，绝不把竞态误报成 failed。
        if (!['AGENT_TURN_LEASE_STALE', 'AGENT_TURN_NOT_FOUND'].includes(caught?.code)) throw caught
        return publicTurn(await productStore.readAgentTurn(sourceTurn.ownerId, sourceTurn.id))
      }
    }

    const storedVersion = agentTurnRequestHashVersion(authoritative)
    const storedHash = typeof authoritative.requestHash === 'string' && authoritative.requestHash.trim()
      ? authoritative.requestHash
      : undefined
    const derivedBinding = storedAgentTurnRequestBinding(authoritative)
    let claimTurn
    if (storedHash && storedVersion) {
      claimTurn = authoritative
    } else if (derivedBinding) {
      // 旧记录没有 hash 时，只从已存 immutable request 派生当前 binding。
      // Adapter 会在同一 claim 锁/事务内再次按旧版本比较，然后原子回填。
      claimTurn = {
        ...authoritative,
        requestHashVersion: currentAgentTurnRequestHashVersion,
        requestHash: agentTurnRequestHash(authoritative.request, currentAgentTurnRequestHashVersion),
      }
    }

    // 极早期 legacy Turn 既没有 request binding，也可能已经有执行 fence。此时不能
    // 伪造 request 来 claim；用持久化的原 generation/token 做一次条件终态提交。
    // takeover 先胜出时该提交会 stale，从而安全失败关闭。
    const persistedGeneration = Number(authoritative.execution?.generation)
    const persistedLeaseToken = typeof authoritative.execution?.leaseToken === 'string'
      ? authoritative.execution.leaseToken
      : ''
    if (!claimTurn && Number.isInteger(persistedGeneration) && persistedGeneration > 0 && persistedLeaseToken) {
      return commitFailure({ leaseToken: persistedLeaseToken, executionGeneration: persistedGeneration })
    }

    if (!claimTurn) {
      // claim 前时代的旧 Turn 可能连 execution 都没有。普通新输入无法通过 claim 的
      // missing-binding 校验，因此这里只允许把权威旧记录写成失败，再立即复读确认；
      // 若 Adapter 发现并发 execution 已建立，会保留该 execution，Sweep 也不会误计。
      const saved = await productStore.putAgentTurn(sourceTurn.ownerId, {
        ...authoritative,
        status: 'failed',
        updatedAt: now(),
        error: clone(error),
      })
      const verified = await productStore.readAgentTurn(sourceTurn.ownerId, sourceTurn.id).catch(() => saved)
      return publicTurn(verified ?? saved)
    }

    const leaseToken = `agent_turn_lease_${randomUUID()}`
    const claim = await productStore.claimAgentTurnExecution(sourceTurn.ownerId, {
      turn: claimTurn,
      leaseToken,
      leaseDurationMs: boundedLeaseMs,
      allowTakeover: true,
    })
    if (claim?.kind === 'replay') return publicTurn(claim.turn)
    if (claim?.kind !== 'claimed') return publicTurn(claim?.turn)
    return commitFailure({
      leaseToken,
      executionGeneration: claim.turn.execution.generation,
    })
  }

  return { execute, cancel, finalizeCancellation, fail, publicTurn }
}

export { publicTurn as publicAgentTurn }
