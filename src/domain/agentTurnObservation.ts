import type { AgentToolCallTrace } from './agent.ts'
import type { BotanicAgentStreamEvent } from './agentChatStream.ts'
import type { BotanicAgentTurnResult } from './agentTurnContract.ts'
import type { TimelineStepKind, TimelineToolPresentation } from './agentTimeline.ts'
import { safeTimelineWebSources } from './agentTimelineWebSources.ts'
import { AGENT_TOOL_CALL_PUBLIC_RISK_VALUES, AGENT_TOOL_CALL_PUBLIC_STATUS_VALUES } from './agentProtocol.generated.ts'

/**
 * 浏览器断线/刷新后必须用同一条用户 Message 找回同一 Turn；随机请求键会静默重跑模型。
 * 这里只绑定稳定身份，不绑定会随上下文刷新变化的派生字段；服务端 requestHash 仍负责拒绝冲突。
 */
export async function botanicAgentTurnRequestKey(input: {
  projectId: string
  sessionId?: string
  inputMessage?: { id: string }
}) {
  if (!input.sessionId || !input.inputMessage?.id) return undefined
  const identity = JSON.stringify([input.projectId, input.sessionId, input.inputMessage.id])
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity))
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `agent-turn-${hex}`
}

/**
 * 非流提交的 202 handoff：durable 身份必须先交给 Stop，再从 0 续读完整事件。
 * 用注入 observer 表达顺序，HTTP 模块只负责把真实请求接进来。
 */
export async function continueBotanicAgentTurnSubmission<T>(input: {
  runtimeTurn?: { id?: string }
  result?: T
  onAccepted?: (turnId: string) => void
  observe: (cursor: { turnId: string; after: number }) => Promise<T>
}): Promise<T | undefined> {
  const turnId = input.runtimeTurn?.id?.trim() ?? ''
  if (turnId) input.onAccepted?.(turnId)
  if (input.result !== undefined) return input.result
  if (turnId) return input.observe({ turnId, after: 0 })
  return undefined
}

export type BotanicAgentTurnRuntimeStatus =
  | 'queued'
  | 'running'
  | 'waiting_user'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type BotanicAgentObservedTurn<TResult = BotanicAgentTurnResult> = {
  id: string
  projectId: string
  status: BotanicAgentTurnRuntimeStatus
  result?: TResult
  error?: { code?: string; message?: string }
  lastSequence?: number
}

export type BotanicAgentTurnEventRecord = {
  id?: string
  turnId?: string
  projectId?: string
  sequence?: number
  type?: string
  createdAt?: number
  payload?: Record<string, unknown>
}

export type BotanicAgentTurnObservationPage<TResult = BotanicAgentTurnResult> = {
  turn: BotanicAgentObservedTurn<TResult>
  events: BotanicAgentTurnEventRecord[]
  cursor: { after: number; hasMore: boolean }
}

type BotanicAgentTurnLinkedMessage = {
  id: string
  role: 'user' | 'assistant'
  turnId?: string
  turnCancellationRequestedAt?: number
  status?: 'pending' | 'answered' | 'submitted' | 'failed'
  createdAt: number
}

/**
 * Turn 结果消息使用稳定身份，刷新、重复 observer 与离线队列重放都会合并到同一条消息。
 * Turn ID 由服务端生成且受 160 字符实体上限约束；当前前缀仍留有充足空间。
 */
export function botanicAgentTurnProjectionMessageId(turnId: string) {
  return `agent-turn-result-${turnId}`
}

/**
 * observer ownership 绑定用户 Message，不绑定会在 accepted 时回写的 turnId。
 * 否则 message:id → turnId 的正常转换会触发 effect cleanup，把自己的 observer abort。
 */
export function botanicAgentTurnRecoveryKey(message?: { id?: string }) {
  const messageId = message?.id?.trim() ?? ''
  return messageId ? `message:${messageId}` : ''
}

/**
 * 找出最早一条「已有 durable Turn、尚无助手投影」的用户消息。
 * 一次只恢复一轮，让追加结果后再自然推进下一轮，避免刷新时并发投影打乱会话顺序。
 */
export function pendingBotanicAgentTurnProjection<T extends BotanicAgentTurnLinkedMessage>(
  messages: readonly T[],
): T | undefined {
  const projectedTurnIds = new Set(messages.flatMap((message) => (
    message.role === 'assistant'
      && message.turnId?.trim()
      && message.id === botanicAgentTurnProjectionMessageId(message.turnId.trim())
      && ['pending', 'answered', 'submitted', 'failed'].includes(message.status ?? '')
      ? [message.turnId.trim()]
      : []
  )))
  return messages
    .filter((message) => (
      message.role === 'user'
      && message.status !== 'failed'
      && (
        Boolean(message.turnId?.trim())
        || message.status === 'pending'
        || Number.isFinite(message.turnCancellationRequestedAt)
      )
      && (!message.turnId?.trim() || !projectedTurnIds.has(message.turnId.trim()))
    ))
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))[0]
}

export type BotanicAgentTurnTimelineHydrationTarget = {
  messageId: string
  turnId: string
}

/**
 * 已有稳定助手投影说明 Turn 业务结果已经落盘，不应再进入 pending execute。
 * 时间线只按需回读当前消息页中尚未 hydrate 的最新几轮；调用方限制并发，并分批覆盖当前消息集合。
 */
export function botanicAgentTurnTimelineHydrationTargets(
  messages: readonly BotanicAgentTurnLinkedMessage[],
  attemptedTurnIds: ReadonlySet<string>,
  limit = 2,
): BotanicAgentTurnTimelineHydrationTarget[] {
  const cap = Number.isInteger(limit) ? Math.min(4, Math.max(0, limit)) : 2
  if (!cap) return []
  const targets: BotanicAgentTurnTimelineHydrationTarget[] = []
  const selectedTurnIds = new Set<string>()
  for (let index = messages.length - 1; index >= 0 && targets.length < cap; index -= 1) {
    const message = messages[index]
    const turnId = message?.turnId?.trim() ?? ''
    if (message?.role !== 'assistant' || !turnId) continue
    if (message.id !== botanicAgentTurnProjectionMessageId(turnId)) continue
    if (attemptedTurnIds.has(turnId) || selectedTurnIds.has(turnId)) continue
    selectedTurnIds.add(turnId)
    targets.push({ messageId: message.id, turnId })
  }
  return targets
}

/** Stop 可能在 observer 已启动后才落入 Message/ref；终态投影前必须重新读取一次。 */
export function hasBotanicAgentTurnCancellationIntent(
  message: Pick<BotanicAgentTurnLinkedMessage, 'turnCancellationRequestedAt'>,
  transientRequestedAt?: number,
) {
  return Number.isFinite(message.turnCancellationRequestedAt) || Number.isFinite(transientRequestedAt)
}

/** generation 首轮与刷新恢复共用同一份 continuation，避免漏掉模型给出的设置提示。 */
export function botanicAgentTurnGenerationContinuation(
  turn: Extract<BotanicAgentTurnResult, { kind: 'generation' }>,
  turnId: string,
) {
  return {
    // null 是显式的“初始生成无父结果”；undefined 是旧版未知快照，
    // 两者不能混同，否则旧 targeted Turn 会被错当成新建图。
    targetNodeId: turn.selectedResultNodeId === null
      ? null
      : turn.selectedResultNodeId?.trim() || undefined,
    resolvedGeneration: {
      mediaKind: turn.mediaKind,
      prompt: turn.prompt,
      ...(turn.intent ? { intent: turn.intent } : {}),
      ...(turn.count ? { count: turn.count } : {}),
      ...(turn.duration ? { duration: turn.duration } : {}),
      ...(turn.variants?.length ? { variants: turn.variants } : {}),
      ...(turn.axisLabel ? { variationAxisLabel: turn.axisLabel } : {}),
      turnId,
    },
    ...(turn.settingsHint && Object.keys(turn.settingsHint).length
      ? { generationOverrides: { ...turn.settingsHint } }
      : {}),
  }
}

/**
 * generation continuation 只能使用 Turn 快照中的目标。null 表示当轮本来就是
 * 初始生成；指定节点已删除或不可用时明确失败，禁止猜测当前选中。
 */
export function resolveBotanicAgentContinuationTarget<T>(
  targetNodeId: string | null | undefined,
  resolveTarget: (nodeId: string) => T | undefined,
): T | undefined {
  if (targetNodeId === null) return undefined
  if (targetNodeId === undefined) {
    const error = new Error('旧 Agent 回合缺少原选中结果的稳定身份，已停止恢复以避免改错图。')
    Object.assign(error, { code: 'AGENT_TURN_TARGET_IDENTITY_MISSING' })
    throw error
  }
  const normalizedTargetNodeId = targetNodeId.trim()
  const target = normalizedTargetNodeId ? resolveTarget(normalizedTargetNodeId) : undefined
  if (target) return target
  const error = new Error('原 Agent 回合选择的结果已不存在，已停止恢复以避免改错图。')
  Object.assign(error, { code: 'AGENT_TURN_TARGET_NOT_FOUND' })
  throw error
}

/** Harness terminal 码:重试不会改变结局,必须停止恢复并显示原因。 */
const TERMINAL_TURN_RECOVERY_CODES = new Set([
  'AGENT_TURN_DEADLINE_EXCEEDED',
  'AGENT_TURN_RESUME_LIMIT_REACHED',
  'AGENT_SKILL_SNAPSHOT_MISMATCH',
  'AGENT_TOOL_OUTCOME_UNKNOWN',
])

export function isRetryableBotanicAgentTurnRecoveryError(caught: unknown) {
  const source = caught as { status?: unknown; code?: unknown } | undefined
  const status = Number(source?.status)
  const code = typeof source?.code === 'string' ? source.code : ''
  if (TERMINAL_TURN_RECOVERY_CODES.has(code)) return false
  if (status === 0) {
    return !code
      || code === 'STREAM_DISCONNECTED'
      || code === 'REQUEST_TIMEOUT'
      || code === 'AGENT_MESSAGE_NOT_DURABLE'
  }
  if (status === 404) return !code || code === 'AGENT_TURN_NOT_FOUND'
  return status === 408 || status === 425 || status === 429 || status >= 500
}

/** 历史 Message 可能指向旧版 link→claim 留下的缺失 Turn；短暂 404 仍先等待副本可见。 */
export function shouldRevalidateMissingBotanicAgentTurn(
  caught: unknown,
  elapsedMs: number,
  timeoutMs: number,
) {
  return Number((caught as { status?: unknown } | undefined)?.status) === 404
    && Number.isFinite(timeoutMs)
    && timeoutMs >= 0
    && elapsedMs >= timeoutMs
}

/**
 * bounded GET 确认持续缺失后，用同一 Message 派生的稳定 key 再 POST 一次。服务端若有
 * immutable request snapshot 会复用；若只是历史 orphan 则 409 fail closed，绝不重建语义。
 */
export async function revalidateMissingBotanicAgentTurn<T>(input: {
  observe: () => Promise<T>
  submit: () => Promise<T>
  markRevalidation?: () => void
}) {
  try {
    return await input.observe()
  } catch (caught) {
    if (Number((caught as { status?: unknown } | undefined)?.status) !== 404) throw caught
    input.markRevalidation?.()
    return input.submit()
  }
}

async function waitForTurnRecoveryRetry(signal: AbortSignal | undefined, attempt: number) {
  if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, Math.min(500 * (2 ** Math.max(0, attempt - 1)), 5_000))
    signal?.addEventListener('abort', () => {
      clearTimeout(timeout)
      reject(new DOMException('The operation was aborted.', 'AbortError'))
    }, { once: true })
  })
}

/**
 * pending Message 是 durable 恢复意图：404 只说明 Turn 暂不可见，断网只说明本次
 * 观察失败。始终复用同一 Message 派生的稳定 key，直到拿到结果或服务端明确拒绝。
 */
export async function retryBotanicAgentTurnRecovery<T>(input: {
  attempt: () => Promise<T>
  signal?: AbortSignal
  wait?: (signal?: AbortSignal, attempt?: number) => Promise<void>
}): Promise<T> {
  let attempt = 0
  for (;;) {
    if (input.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    attempt += 1
    try {
      return await input.attempt()
    } catch (caught) {
      if (!isRetryableBotanicAgentTurnRecoveryError(caught)) throw caught
      await (input.wait ?? waitForTurnRecoveryRetry)(input.signal, attempt)
    }
  }
}

/**
 * Stop 的行为归属：durable Turn 必须走服务端深取消并保留 observer；Turn 已提交但
 * accepted 身份尚未到达时登记“拿到即取消”，只有普通旧规划/对话请求才中断本地 HTTP。
 */
export async function stopBotanicAgentPlanning(input: {
  turnId?: string
  turnIdentityPending?: boolean
  cancelTurn: (turnId: string) => Promise<unknown>
  cancelWhenAccepted?: () => void
  abortLocalRequest: () => void
}): Promise<
  | { kind: 'cancelling'; turnId: string }
  | { kind: 'awaiting_turn_identity' }
  | { kind: 'aborted_local' }
> {
  const turnId = input.turnId?.trim()
  if (turnId) {
    await input.cancelTurn(turnId)
    return { kind: 'cancelling', turnId }
  }
  if (input.turnIdentityPending) {
    input.cancelWhenAccepted?.()
    return { kind: 'awaiting_turn_identity' }
  }
  input.abortLocalRequest()
  return { kind: 'aborted_local' }
}

export function settleBotanicAgentCancellationSession(input: {
  currentSessionId: string
  operationSessionId: string
  turnIdentityKnown: boolean
  recoveryPending: boolean
}) {
  if (input.turnIdentityKnown || input.recoveryPending) return input.currentSessionId
  return input.currentSessionId === input.operationSessionId ? '' : input.currentSessionId
}

function retryableCancellationError(caught: unknown) {
  const status = Number((caught as { status?: unknown } | undefined)?.status)
  return status === 0 || status === 404 || status === 408 || status === 425
    || status === 429 || status >= 500
}

async function waitForCancellationRetry(signal?: AbortSignal, attempt = 1) {
  if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, Math.min(600 * (2 ** Math.max(0, attempt - 1)), 5_000))
    signal?.addEventListener('abort', () => {
      clearTimeout(timeout)
      reject(new DOMException('The operation was aborted.', 'AbortError'))
    }, { once: true })
  })
}

/**
 * 404 可能是 durable claim 尚未在当前实例可见，status=0 则只是传输失败；二者都
 * 不能证明已取消。保留 observer 与 Message 上的 Stop 意图，直到深取消被服务端接受。
 */
export async function retryBotanicAgentTurnCancellation(input: {
  turnId: string
  cancelTurn: (turnId: string) => Promise<unknown>
  signal?: AbortSignal
  wait?: (signal?: AbortSignal, attempt?: number) => Promise<void>
  maximumAttempts?: number
}) {
  const turnId = input.turnId.trim()
  if (!turnId) throw new TypeError('Agent Turn 取消缺少身份。')
  const maximumAttempts = Math.max(1, Math.min(input.maximumAttempts ?? 6, 20))
  const exhausted = () => Object.assign(new Error('暂时无法确认 Agent 回合已取消；取消意图已保存，请稍后重试。'), {
    code: 'AGENT_TURN_CANCELLATION_RETRY_EXHAUSTED',
    status: 0,
  })
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    if (input.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    try {
      const result = await input.cancelTurn(turnId)
      if ((result as { turn?: { status?: string } } | undefined)?.turn?.status === 'cancelling') {
        if (attempt === maximumAttempts) throw exhausted()
        await (input.wait ?? waitForCancellationRetry)(input.signal, attempt)
        continue
      }
      return { kind: 'cancelling' as const, turnId }
    } catch (caught) {
      if (!retryableCancellationError(caught)) throw caught
      if (attempt === maximumAttempts) throw exhausted()
      await (input.wait ?? waitForCancellationRetry)(input.signal, attempt)
    }
  }
  throw exhausted()
}

/**
 * 新服务端只在 durable claim 且请求绑定一致后发送 `accepted`。此判断仍兼容滚动发布
 * 中的旧服务：旧端若先 accepted 后才发现意图冲突，客户端必须拒绝续读旧 Turn。
 */
export function agentTurnStreamFailureMustReject(code?: string) {
  return code === 'AGENT_TURN_INTENT_CONFLICT'
}

/**
 * SSE 与 observer 共用的单调游标判定。反代重连可能重复边界上的最后一帧；带稳定
 * sequence 的事件只交付严格递增项。实时 reasoning/answer 没有 sequence，不能因
 * durable 去重而被丢弃。
 */
export function monotonicAgentTurnEventDecision(
  lastSequence: number,
  event: { sequence?: number },
): { deliver: boolean; lastSequence: number } {
  if (!Number.isInteger(event.sequence)) return { deliver: true, lastSequence }
  const sequence = Number(event.sequence)
  return sequence > lastSequence
    ? { deliver: true, lastSequence: sequence }
    : { deliver: false, lastSequence }
}

const toolRisks: ReadonlySet<string> = new Set(AGENT_TOOL_CALL_PUBLIC_RISK_VALUES)
const toolStatuses: ReadonlySet<string> = new Set(AGENT_TOOL_CALL_PUBLIC_STATUS_VALUES)
const presentationKinds = new Set<TimelineStepKind>(['search', 'fetch', 'read_skill', 'connect_runtime', 'subagent', 'read', 'write', 'other'])

function stringValue(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function boundedStringValue(value: unknown, maximumLength: number, fallback = '') {
  const normalized = stringValue(value)
  return normalized && normalized.length <= maximumLength ? normalized : fallback
}

function safePresentation(value: unknown): TimelineToolPresentation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const kind = presentationKinds.has(raw.kind as TimelineStepKind) ? raw.kind as TimelineStepKind : undefined
  const title = boundedStringValue(raw.title, 120)
  if (!kind || !title) return undefined
  const count = Number.isInteger(raw.count) && Number(raw.count) >= 0 && Number(raw.count) <= 10_000
    ? Number(raw.count)
    : undefined
  const sources = safeTimelineWebSources(raw.sources)
  return {
    kind,
    title,
    ...(count !== undefined ? { count } : {}),
    ...(sources?.length ? { sources } : {}),
  }
}

/** 把持久化事件恢复成 UI 已认识的安全事件；生命周期事件不进入工具时间线。 */
export function agentTurnEventAsStreamEvent(event: BotanicAgentTurnEventRecord): BotanicAgentStreamEvent | undefined {
  if (event.type !== 'turn.tool' || !event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) return undefined
  const payload = event.payload
  const name = boundedStringValue(payload.toolName, 120, 'agent_tool')
  const label = boundedStringValue(payload.label, 120, name)
  const risk = toolRisks.has(payload.risk as AgentToolCallTrace['risk']) ? payload.risk as AgentToolCallTrace['risk'] : 'read'
  const status = toolStatuses.has(payload.status as AgentToolCallTrace['status']) ? payload.status as AgentToolCallTrace['status'] : 'running'
  const summary = boundedStringValue(payload.summary, 120)
  const presentation = safePresentation(payload.presentation)
  return {
    type: 'tool',
    step: Number.isInteger(payload.step) && Number(payload.step) >= 0 && Number(payload.step) <= 64 ? Number(payload.step) : 0,
    ...(Number.isInteger(event.sequence) ? { sequence: Number(event.sequence) } : {}),
    toolCall: {
      id: boundedStringValue(payload.toolCallId, 160, `turn-tool-${Number(event.sequence) || 0}`),
      name,
      label,
      risk,
      status,
      requiresConfirmation: false,
      ...(summary ? { summary } : {}),
    },
    ...(presentation ? { presentation } : {}),
  }
}

export type AgentTurnObservationSettlement<TResult = BotanicAgentTurnResult> =
  | { kind: 'pending' }
  | { kind: 'resolved'; result: TResult }
  | { kind: 'failed'; code: string; message: string }

/** 必须先排空事件页，再按 Turn 权威状态结算，避免终态页遗漏尚未投影的工具事件。 */
export function settleAgentTurnObservation<TResult = BotanicAgentTurnResult>(
  page: BotanicAgentTurnObservationPage<TResult>,
): AgentTurnObservationSettlement<TResult> {
  if (page.cursor.hasMore) return { kind: 'pending' }
  if (page.turn.status === 'completed' || page.turn.status === 'waiting_user') {
    if (page.turn.result) return { kind: 'resolved', result: page.turn.result }
    return { kind: 'failed', code: 'AGENT_TURN_RESULT_MISSING', message: 'Agent 回合已结束，但结果不可用。' }
  }
  if (page.turn.status === 'failed') {
    return {
      kind: 'failed',
      code: stringValue(page.turn.error?.code, 'AGENT_TURN_FAILED'),
      message: stringValue(page.turn.error?.message, 'Agent 回合未完成，请重试。'),
    }
  }
  if (page.turn.status === 'cancelled') {
    return {
      kind: 'failed',
      code: stringValue(page.turn.error?.code, 'AGENT_TURN_CANCELLED'),
      message: stringValue(page.turn.error?.message, 'Agent 回合已取消。'),
    }
  }
  return { kind: 'pending' }
}
