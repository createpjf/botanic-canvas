import { buildBotanicAgentPlanRequest, completeBotanicAgentPlan, type BotanicAgentPlanRequestInput, type BotanicAgentPlanResponse } from '../domain/agentPlanContract'
import { buildBotanicAgentChatRequest, type BotanicAgentChatRequestInput, type BotanicAgentChatResponse } from '../domain/agentChatContract'
import { botanicAgentChatTransportErrorMessage, createBotanicAgentChatStreamReader, type BotanicAgentChatStreamEvent, type BotanicAgentStreamEvent } from '../domain/agentChatStream'
import type { BotanicAgentRunReview } from '../domain/agentReviewContract'
import type { AgentReviewDecision, AgentReviewTaskSnapshot } from '../domain/agentReviewPresentation'
import type { AgentReviewReconciliationAction } from '../domain/agentReviewPresentation'
import { buildBotanicAgentTurnRequest, type BotanicAgentTurnRequestInput, type BotanicAgentTurnResult } from '../domain/agentTurnContract'
import {
  agentTurnStreamFailureMustReject,
  agentTurnEventAsStreamEvent,
  botanicAgentTurnOutputPreviewAsStreamEvent,
  botanicAgentTurnRequestKey,
  continueBotanicAgentTurnSubmission,
  monotonicAgentTurnEventDecision,
  settleAgentTurnObservation,
  shouldRevalidateMissingBotanicAgentTurn,
  type BotanicAgentObservedTurn,
  type BotanicAgentTurnObservationPage,
} from '../domain/agentTurnObservation'
import { ProductApiError, productAuthorizationHeader, productRequest } from './productSession'
import type { AgentToolCallTrace, BotanicAgentReasoningEntry, BotanicAgentActionProposal, BotanicAgentActionReconciliationDecision, BotanicAgentActionReconciliationStatus, BotanicAgentActionResult, BotanicAgentClarificationResponse, BotanicAgentManualRetryAuthorization, BotanicAgentMemoryItem, BotanicAgentMessage, BotanicAgentPlan, BotanicAgentRunSnapshot, BotanicAgentSession, BotanicAgentSkill, BotanicAgentSkillCatalogItem, BotanicIndexedArtifact } from '../domain/agent'
import type { BotanicAgentBranchVariation } from '../domain/agentVariations'
import type { BotanicAgentCompositionItem } from '../domain/agentCreativeComposition'
import { readProductLocale, type ProductLocale } from '../i18n/core'
import { canonicalImageFormatSentenceList, isCanonicalImageFormat } from '../domain/mediaFormats'
import { persistentBotanicAgentMessageBody } from '../domain/agentMessagePersistence'
import { readAgentTurnTimelineEvents } from './agentTurnTimelineEventReader'
import { captureSentryMessage } from './sentry.ts'

const agentActionsRequiringApproval = new Set([
  'generation_submit', 'mcp_call', 'agent_branch_retry', 'review_retry', 'workflow_run_retry_failed',
])

export type AgentRunCreationBranch = {
  id: string
  label: string
  assetId?: string
  variation?: BotanicAgentBranchVariation
  /** 成套方案条目：分支自带媒体类型与定稿 Prompt。 */
  item?: BotanicAgentCompositionItem
}

export async function forkBotanicAgentRun(input: { runId: string; branchId?: string; promptDelta: string }) {
  const response = await productRequest<{ run: BotanicAgentRunSnapshot; reused?: boolean }>(`/api/agent-runs/${encodeURIComponent(input.runId)}/fork`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey('agent-fork') },
    body: JSON.stringify({ branchId: input.branchId, promptDelta: input.promptDelta }),
  })
  return response
}

export async function compareBotanicAgentRun(runId: string) {
  const response = await productRequest<{ comparison: { runId: string; projectId: string; status: string; branches: Array<{ id: string; label: string; status: string; outputCount: number; jobCount: number }> } }>(`/api/agent-runs/${encodeURIComponent(runId)}/compare`)
  return response.comparison
}

function agentApiCopy(locale: ProductLocale) {
  return locale === 'en' ? {
    mediaRead: 'Unable to read the reference image. Add it again.', mediaType: `Agent reference images support ${canonicalImageFormatSentenceList('en')} only.`, planTimeout: 'Agent planning is taking longer than expected. Try again shortly; the canvas was not changed.', turnTimeout: 'Agent is taking longer than expected to understand the request. Try again shortly; the canvas was not changed.', chatTimeout: 'Agent is taking longer than expected to organize the context. Try again shortly; the canvas was not changed.', streamUnavailable: 'Agent live connection is unavailable.', chatIncomplete: 'Agent did not complete the response. Try again.', streamEnded: 'Agent live connection ended unexpectedly.', reviewTimeout: 'The result review is taking longer than expected. This round was skipped; your generated results are unaffected.',
  } : {
    mediaRead: '参考图片读取失败，请重新添加该图片。', mediaType: `Agent 参考图仅支持 ${canonicalImageFormatSentenceList('zh-CN')}。`, planTimeout: 'Agent 规划响应较慢，请稍后重试；当前画布内容未被修改。', turnTimeout: 'Agent 正在理解你的意图，响应较慢，请稍后重试；当前画布内容未被修改。', chatTimeout: 'Agent 正在整理上下文，响应较慢，请稍后重试；当前画布内容未被修改。', streamUnavailable: 'Agent 实时通道不可用。', chatIncomplete: 'Agent 对话未完成，请重试。', streamEnded: 'Agent 实时通道意外结束。', reviewTimeout: '结果评审响应较慢，已跳过本轮点评；生成结果不受影响。',
  }
}

function blobAsDataUrl(blob: Blob) {
  const copy = agentApiCopy(readProductLocale())
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(copy.mediaRead))
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error(copy.mediaRead))
    reader.readAsDataURL(blob)
  })
}

export async function persistAgentReferenceMedia(projectId: string, source: string) {
  const copy = agentApiCopy(readProductLocale())
  let dataUrl = source
  if (!source.startsWith('data:image/')) {
    const response = await fetch(source, { credentials: 'include' })
    if (!response.ok) throw new Error(copy.mediaRead)
    const blob = await response.blob()
    // 这里的字节即将被发去生成接口——校验应该按 canonical 词表而不是 upload
    // 词表，即便当前两者恰好相同。误用 upload 词表是个哨兵地雷：以后放宽
    // upload（PR-B）而不动 canonical 时，这里会静默跟着放宽，等接口拒绝。
    if (!isCanonicalImageFormat(blob.type)) {
      throw new Error(copy.mediaType)
    }
    dataUrl = await blobAsDataUrl(blob)
  }
  const response = await productRequest<{ image: string }>(`/api/projects/${encodeURIComponent(projectId)}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl }),
  })
  return response.image
}

function idempotencyKey(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`
}

/**
 * `onReasoning` 只用于把当轮运行说明喂给运行轨迹。它刻意不进入返回的计划——
 * 计划会被原样持久化，而提供方原始推理只允许在当轮实时展示。
 */
export async function requestBotanicAgentPlan(
  input: BotanicAgentPlanRequestInput,
  signal?: AbortSignal,
  onReasoning?: (entries: BotanicAgentReasoningEntry[]) => void,
  requestKey = idempotencyKey('agent-plan'),
  onAccepted?: (turnId: string) => void,
  onEvent?: (event: BotanicAgentStreamEvent) => void,
) {
  const copy = agentApiCopy(input.locale)
  const response = await productRequest<{
    plan?: Extract<BotanicAgentPlanResponse, { plan: unknown }>['plan']
    clarification?: BotanicAgentClarificationResponse['clarification']
    reasoning?: BotanicAgentReasoningEntry[]
    runtimeTurn?: BotanicAgentObservedTurn<PersistentAgentPlanResult>
  }>('/api/agent-plans', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept-Language': input.locale,
      'Idempotency-Key': requestKey,
      Prefer: 'respond-async',
    },
    body: JSON.stringify(buildBotanicAgentPlanRequest(input)),
    signal,
    timeoutMs: 60_000,
    timeoutMessage: copy.planTimeout,
  })
  const runtimeTurnId = response.runtimeTurn?.id?.trim()
  if (runtimeTurnId) onAccepted?.(runtimeTurnId)
  if (response.reasoning?.length) onReasoning?.(response.reasoning)
  if (response.clarification) {
    return { kind: 'clarification', clarification: response.clarification } satisfies BotanicAgentClarificationResponse
  }
  if (response.plan) return completeBotanicAgentPlan(response.plan, input)
  if (runtimeTurnId) {
    return observePersistentAgentPlan(runtimeTurnId, input, { signal, onEvent })
  }
  throw new ProductApiError(copy.streamEnded, 0, 'AGENT_TURN_RESULT_MISSING')
}

/**
 * 回合结果加上它的运行时身份。Run 创建时带上 `runtimeTurnId`，Turn 侧才能反查
 * 这次确认产生了哪些 Run —— 服务端一直在返回 `runtimeTurn`，此前被客户端丢掉了。
 */
export type BotanicAgentTurnOutcome = BotanicAgentTurnResult & { runtimeTurnId?: string }

type PersistentAgentPlanResult =
  | {
      kind: 'plan'
      runtimeOperation: 'plan'
      plan: Extract<BotanicAgentPlanResponse, { plan: unknown }>['plan']
    }
  | {
      kind: 'clarification'
      runtimeOperation: 'plan'
      clarification: BotanicAgentClarificationResponse['clarification']
    }

type PersistentAgentChatResult = {
  kind: 'chat'
  runtimeOperation: 'chat'
  response: BotanicAgentChatResponse
}

function withRuntimeTurnId(result: BotanicAgentTurnResult, runtimeTurn: unknown): BotanicAgentTurnOutcome {
  const id = (runtimeTurn as { id?: unknown } | undefined)?.id
  return typeof id === 'string' && id ? Object.assign({}, result, { runtimeTurnId: id }) : result
}

async function waitForAgentTurnObservation(signal?: AbortSignal, delayMs = 600) {
  if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }
    const timeoutId = window.setTimeout(finish, delayMs)
    const abort = () => {
      window.clearTimeout(timeoutId)
      reject(new DOMException('The operation was aborted.', 'AbortError'))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

function retryableTurnObservationError(caught: unknown) {
  return caught instanceof ProductApiError
    && (caught.status === 0 || caught.status === 404 || caught.status === 408 || caught.status === 429 || caught.status >= 500)
}

/** SSE 只是观察通道；断线后从持久化 Turn 事件游标续读，绝不重新执行模型。 */
async function observeAgentRuntimeResult<TResult>(input: {
  turnId: string
  projectId: string
  signal?: AbortSignal
  after?: number
  onEvent?: (event: BotanicAgentStreamEvent) => void
  missingTurnError?: ProductApiError
  missingTurnTimeoutMs?: number
}): Promise<{ result: TResult; turn: BotanicAgentObservedTurn<TResult> }> {
  let after = Number.isInteger(input.after) ? Number(input.after) : 0
  let deliveredPreviewRevision = 0
  let activePreviewObserverRecorded = false
  let previewRecoveryRecorded = false
  const startedAt = Date.now()
  for (;;) {
    if (input.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    let page: BotanicAgentTurnObservationPage<TResult>
    try {
      page = await productRequest<BotanicAgentTurnObservationPage<TResult>>(
        `/api/agent-turns/${encodeURIComponent(input.turnId)}?after=${after}&limit=200`,
        { signal: input.signal },
      )
    } catch (caught) {
      if (input.signal?.aborted || !retryableTurnObservationError(caught)) throw caught
      if (shouldRevalidateMissingBotanicAgentTurn(
        caught,
        Date.now() - startedAt,
        Number(input.missingTurnTimeoutMs),
      )) throw caught
      // 新服务端只在 durable claim 可读后发送 accepted；单次 404 可能只是副本/路由
      // 短暂不可见，不能据此伪造取消或丢掉 Stop 意图。只有 SSE 已给出明确失败且
      // durable 读持续十秒仍不可见时，才把原失败交给调用方；普通 observer 继续等。
      if (caught instanceof ProductApiError && caught.status === 404
        && input.missingTurnError
        && Date.now() - startedAt >= 10_000) {
        throw input.missingTurnError
      }
      await waitForAgentTurnObservation(input.signal)
      continue
    }
    if (page.turn.projectId !== input.projectId || page.turn.id !== input.turnId) {
      throw new ProductApiError('Agent 回合身份校验失败。', 409, 'AGENT_TURN_IDENTITY_MISMATCH')
    }
    if (!activePreviewObserverRecorded && ['running', 'cancelling'].includes(page.turn.status)) {
      activePreviewObserverRecorded = true
      captureSentryMessage('agent_turn_preview_observer_started', {
        component: 'agent-preview', level: 'info', tags: { operation: 'turn_observer' },
      })
    }
    const previewEvent = botanicAgentTurnOutputPreviewAsStreamEvent(page.turn, deliveredPreviewRevision)
    if (previewEvent) {
      deliveredPreviewRevision = previewEvent.revision
      input.onEvent?.(previewEvent)
      if (!previewRecoveryRecorded) {
        previewRecoveryRecorded = true
        captureSentryMessage('agent_turn_preview_recovered', {
          component: 'agent-preview', level: 'info', tags: { operation: 'turn_observer' },
        })
      }
    }
    let deliveredSequence = after
    for (const event of page.events) {
      const decision = monotonicAgentTurnEventDecision(deliveredSequence, event)
      // 代理/SSE 重连可能把边界上的最后一条再送一次；游标是单调的，同序号或
      // 更早的 durable 事件一律不再投影。无 sequence 的事件仍照常交付。
      if (!decision.deliver) continue
      deliveredSequence = decision.lastSequence
      const projected = agentTurnEventAsStreamEvent(event)
      if (projected) input.onEvent?.(projected)
    }
    after = Math.max(deliveredSequence, Number(page.cursor.after) || 0)
    const settlement = settleAgentTurnObservation(page)
    if (settlement.kind === 'resolved') {
      return { result: settlement.result, turn: page.turn }
    }
    if (settlement.kind === 'failed') {
      input.onEvent?.({ type: 'error', code: settlement.code, message: settlement.message })
      throw new ProductApiError(settlement.message, 0, settlement.code)
    }
    if (!page.cursor.hasMore) await waitForAgentTurnObservation(input.signal)
  }
}

async function observeBotanicAgentTurn(input: {
  turnId: string
  projectId: string
  signal?: AbortSignal
  after?: number
  onEvent?: (event: BotanicAgentStreamEvent) => void
  missingTurnError?: ProductApiError
  missingTurnTimeoutMs?: number
}): Promise<BotanicAgentTurnOutcome> {
  const observed = await observeAgentRuntimeResult<BotanicAgentTurnResult>(input)
  input.onEvent?.({ type: 'done', result: observed.result })
  return withRuntimeTurnId(observed.result, observed.turn)
}

/**
 * 已完成消息的时间线补水只读 GET Turn Events。它不等待终态、不 POST、不调用
 * observer execute path；页数与事件数均有硬上限，游标停滞立即失败。
 */
export async function readPersistentBotanicAgentTurnEvents(
  turnId: string,
  projectId: string,
  options: { signal?: AbortSignal; after?: number; maximumPages?: number } = {},
) {
  return readAgentTurnTimelineEvents({
    turnId,
    projectId,
    signal: options.signal,
    after: options.after,
    maximumPages: options.maximumPages,
    readPage: (path, signal) => productRequest(path, { signal }),
  })
}

function planFromPersistentRuntimeResult(
  result: PersistentAgentPlanResult,
  input: BotanicAgentPlanRequestInput,
) {
  if (result.runtimeOperation !== 'plan') {
    throw new ProductApiError('Agent 规划回合身份校验失败。', 409, 'AGENT_TURN_OPERATION_MISMATCH')
  }
  return result.kind === 'clarification'
    ? ({ kind: 'clarification', clarification: result.clarification } satisfies BotanicAgentClarificationResponse)
    : completeBotanicAgentPlan(result.plan, input)
}

async function observePersistentAgentPlan(
  turnId: string,
  input: BotanicAgentPlanRequestInput,
  options: {
    signal?: AbortSignal
    after?: number
    onEvent?: (event: BotanicAgentStreamEvent) => void
    missingTurnError?: ProductApiError
  } = {},
) {
  const observed = await observeAgentRuntimeResult<PersistentAgentPlanResult>({
    turnId,
    projectId: input.projectId,
    ...options,
  })
  const result = planFromPersistentRuntimeResult(observed.result, input)
  if ('kind' in result && result.kind === 'clarification') {
    options.onEvent?.({ type: 'done', clarification: result.clarification })
  } else {
    options.onEvent?.({ type: 'done', plan: result as BotanicAgentPlan })
  }
  return result
}

async function observePersistentAgentChat(
  turnId: string,
  input: BotanicAgentChatRequestInput,
  options: {
    signal?: AbortSignal
    after?: number
    onEvent?: (event: BotanicAgentStreamEvent) => void
    missingTurnError?: ProductApiError
  } = {},
) {
  const observed = await observeAgentRuntimeResult<PersistentAgentChatResult>({
    turnId,
    projectId: input.projectId,
    ...options,
  })
  if (observed.result.kind !== 'chat' || observed.result.runtimeOperation !== 'chat') {
    throw new ProductApiError('Agent 对话回合身份校验失败。', 409, 'AGENT_TURN_OPERATION_MISMATCH')
  }
  options.onEvent?.({ type: 'done', response: observed.result.response })
  return observed.result.response
}

export function observePersistentBotanicAgentTurn(
  turnId: string,
  projectId: string,
  options: {
    signal?: AbortSignal
    after?: number
    onEvent?: (event: BotanicAgentStreamEvent) => void
    missingTurnTimeoutMs?: number
  } = {},
) {
  return observeBotanicAgentTurn({ turnId, projectId, ...options })
}

export function cancelPersistentBotanicAgentTurn(turnId: string) {
  return productRequest<{ turn: BotanicAgentObservedTurn; cancellation?: unknown }>(
    `/api/agent-turns/${encodeURIComponent(turnId)}/cancel`,
    { method: 'POST' },
  )
}

export async function requestBotanicAgentTurn(
  input: BotanicAgentTurnRequestInput,
  signal?: AbortSignal,
  requestKey?: string,
  onEvent?: (event: BotanicAgentStreamEvent) => void,
  onAccepted?: (turnId: string) => void,
) {
  const copy = agentApiCopy(input.locale)
  const stableRequestKey = requestKey ?? await botanicAgentTurnRequestKey(input) ?? idempotencyKey('agent-turn')
  const response = await productRequest<{ turn?: BotanicAgentTurnResult; runtimeTurn?: BotanicAgentObservedTurn }>('/api/agent-turns', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept-Language': input.locale, 'Idempotency-Key': stableRequestKey },
    body: JSON.stringify(buildBotanicAgentTurnRequest(input)),
    signal,
    timeoutMs: 60_000,
    timeoutMessage: copy.turnTimeout,
  })
  const continuation = await continueBotanicAgentTurnSubmission({
    runtimeTurn: response.runtimeTurn,
    ...(response.turn ? { result: withRuntimeTurnId(response.turn, response.runtimeTurn) } : {}),
    onAccepted,
    observe: ({ turnId, after }) => observeBotanicAgentTurn({
      turnId,
      projectId: input.projectId,
      signal,
      // 普通 202 响应没有交付过任何事件；不能从服务端末游标开始，否则会跳过整段轨迹。
      after,
      onEvent,
    }),
  })
  if (continuation) return continuation
  throw new ProductApiError(copy.streamEnded, 0, 'AGENT_TURN_RESULT_MISSING')
}

function settlePlanFromStreamDone(event: Extract<BotanicAgentStreamEvent, { type: 'done' }>, input: BotanicAgentPlanRequestInput) {
  if (event.clarification) {
    return { kind: 'clarification', clarification: event.clarification } satisfies BotanicAgentClarificationResponse
  }
  if (event.plan) return completeBotanicAgentPlan(event.plan, input)
  return undefined
}

/**
 * 规划实时通道：工具步经 SSE 进对话时间线，done 再携带计划/澄清卡。
 * 首事件前失败回退一次性接口；已开始推送后失败不得重跑模型。
 */
export async function streamBotanicAgentPlan(
  input: BotanicAgentPlanRequestInput,
  options: {
    signal?: AbortSignal
    onEvent?: (event: BotanicAgentStreamEvent) => void
    onReasoning?: (entries: BotanicAgentReasoningEntry[]) => void
    requestKey?: string
    onAccepted?: (turnId: string) => void
  } = {},
): Promise<BotanicAgentPlan | BotanicAgentClarificationResponse> {
  const copy = agentApiCopy(input.locale)
  const requestKey = options.requestKey ?? idempotencyKey('agent-plan')
  let settled: BotanicAgentPlan | BotanicAgentClarificationResponse | undefined
  let accepted: Extract<BotanicAgentStreamEvent, { type: 'accepted' }> | undefined
  let lastSequence = 0
  let streamFailure: ProductApiError | undefined
  try {
    await streamBotanicAgentEndpoint({
      path: '/api/agent-plans/stream',
      body: JSON.stringify(buildBotanicAgentPlanRequest(input)),
      locale: input.locale,
      signal: options.signal,
      headers: { 'Idempotency-Key': requestKey },
      onEvent: (event) => {
        if (event.type === 'accepted') {
          accepted = event
          options.onAccepted?.(event.turnId)
          return
        }
        const decision = monotonicAgentTurnEventDecision(lastSequence, event)
        if (!decision.deliver) return
        lastSequence = decision.lastSequence
        if (event.type === 'error' && accepted) {
          streamFailure = new ProductApiError(
            event.message ?? copy.chatIncomplete,
            agentTurnStreamFailureMustReject(event.code) ? 409 : 502,
            event.code,
          )
          return
        }
        if (event.type === 'done') {
          settled = settlePlanFromStreamDone(event, input)
          if (event.reasoning?.length) options.onReasoning?.(event.reasoning)
        }
        options.onEvent?.(event)
      },
    })
  } catch (caught) {
    if (options.signal?.aborted) throw caught
    if (settled) return settled
    if (accepted) {
      if (agentTurnStreamFailureMustReject(streamFailure?.code)) throw streamFailure
      return observePersistentAgentPlan(accepted.turnId, input, {
        signal: options.signal,
        after: lastSequence,
        onEvent: options.onEvent,
        missingTurnError: streamFailure,
      })
    }
    // accepted 前也复用同一提交键；respond-async 返回 durable 身份后直接进入 observer。
    return requestBotanicAgentPlan(
      input,
      options.signal,
      options.onReasoning,
      requestKey,
      options.onAccepted,
      options.onEvent,
    )
  }
  if (!settled && accepted) {
    if (agentTurnStreamFailureMustReject(streamFailure?.code)) throw streamFailure
    return observePersistentAgentPlan(accepted.turnId, input, {
      signal: options.signal,
      after: lastSequence,
      onEvent: options.onEvent,
      missingTurnError: streamFailure,
    })
  }
  if (!settled) throw new ProductApiError(copy.streamEnded, 0)
  return settled
}

/**
 * 回合实时通道：只读/生成意图工具步进时间线，done 携带与 /api/agent-intent 一致的 turn。
 */
export async function streamBotanicAgentTurn(
  input: BotanicAgentTurnRequestInput,
  options: {
    signal?: AbortSignal
    onEvent?: (event: BotanicAgentStreamEvent) => void
    onAccepted?: (turnId: string) => void
  } = {},
): Promise<BotanicAgentTurnOutcome> {
  const copy = agentApiCopy(input.locale)
  const requestKey = await botanicAgentTurnRequestKey(input) ?? idempotencyKey('agent-turn')
  let settled: BotanicAgentTurnOutcome | undefined
  let accepted: Extract<BotanicAgentStreamEvent, { type: 'accepted' }> | undefined
  let lastSequence = 0
  let streamFailure: ProductApiError | undefined
  try {
    await streamBotanicAgentEndpoint({
      path: '/api/agent-turns/stream',
      body: JSON.stringify(buildBotanicAgentTurnRequest(input)),
      locale: input.locale,
      headers: { 'Idempotency-Key': requestKey },
      signal: options.signal,
      onEvent: (event) => {
        if (event.type === 'accepted') {
          accepted = event
          options.onAccepted?.(event.turnId)
          return
        }
        const decision = monotonicAgentTurnEventDecision(lastSequence, event)
        // fetch SSE 没有原生 EventSource 的 Last-Event-ID 去重；部分反代重连会把
        // 最后一帧再送一次。只交付严格递增的 durable 事件，避免工具时间线重复。
        if (!decision.deliver) return
        lastSequence = decision.lastSequence
        // accepted 后以持久化 Turn 为状态权威；SSE error 只代表当前观察通道结束，
        // 由续读结果统一投影一次终态错误，避免 UI 收到两张错误卡。
        if (event.type === 'error' && accepted) {
          streamFailure = new ProductApiError(
            event.message ?? copy.chatIncomplete,
            agentTurnStreamFailureMustReject(event.code) ? 409 : 502,
            event.code,
          )
          return
        }
        if (event.type === 'done') {
          const result = event.result ?? event.turn
          if (result) settled = withRuntimeTurnId(result, event.runtimeTurn)
        }
        options.onEvent?.(event)
      },
    })
  } catch (caught) {
    if (options.signal?.aborted) throw caught
    if (settled) return settled
    if (accepted) {
      if (agentTurnStreamFailureMustReject(streamFailure?.code)) throw streamFailure
      return observeBotanicAgentTurn({
        turnId: accepted.turnId,
        projectId: input.projectId,
        signal: options.signal,
        after: lastSequence,
        onEvent: options.onEvent,
        missingTurnError: streamFailure,
      })
    }
    return requestBotanicAgentTurn(input, options.signal, requestKey, options.onEvent, options.onAccepted)
  }
  if (!settled && accepted) {
    if (agentTurnStreamFailureMustReject(streamFailure?.code)) throw streamFailure
    return observeBotanicAgentTurn({
      turnId: accepted.turnId,
      projectId: input.projectId,
      signal: options.signal,
      after: lastSequence,
      onEvent: options.onEvent,
      missingTurnError: streamFailure,
    })
  }
  if (!settled) throw new ProductApiError(copy.streamEnded, 0)
  return settled
}

/** 实时对话通道。它只改变“回答什么时候到”，不改变回答本身。 */

export async function requestBotanicAgentChat(
  input: BotanicAgentChatRequestInput,
  signal?: AbortSignal,
  requestKey = idempotencyKey('agent-chat'),
  onAccepted?: (turnId: string) => void,
  onEvent?: (event: BotanicAgentStreamEvent) => void,
) {
  const copy = agentApiCopy(input.locale)
  const response = await productRequest<{
    response?: BotanicAgentChatResponse
    runtimeTurn?: BotanicAgentObservedTurn<PersistentAgentChatResult>
  }>('/api/agent-chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept-Language': input.locale,
      'Idempotency-Key': requestKey,
      Prefer: 'respond-async',
    },
    body: JSON.stringify(buildBotanicAgentChatRequest(input)),
    signal,
    timeoutMs: 60_000,
    timeoutMessage: copy.chatTimeout,
  })
  const runtimeTurnId = response.runtimeTurn?.id?.trim()
  if (runtimeTurnId) onAccepted?.(runtimeTurnId)
  if (response.response) return response.response
  if (runtimeTurnId) return observePersistentAgentChat(runtimeTurnId, input, { signal, onEvent })
  throw new ProductApiError(copy.streamEnded, 0, 'AGENT_TURN_RESULT_MISSING')
}

/** 实时通道的静默上限：这么久没有任何事件就判定连接已死，回退或报错。 */
const agentChatStreamIdleTimeoutMs = 60_000

/**
 * 共享 SSE 读取：chat / turn / plan 共用。首事件前失败由调用方决定是否回退一次性接口；
 * 已开始推送后失败带 STREAM_DISCONNECTED，禁止悄悄重跑模型。
 */
async function streamBotanicAgentEndpoint(input: {
  path: string
  body: string
  locale: ProductLocale
  signal?: AbortSignal
  onEvent?: (event: BotanicAgentStreamEvent) => void
  headers?: Record<string, string>
}) {
  const copy = agentApiCopy(input.locale)
  let received = false
  const controller = new AbortController()
  const abortFromCaller = () => controller.abort()
  if (input.signal?.aborted) controller.abort()
  else input.signal?.addEventListener('abort', abortFromCaller, { once: true })
  let inactivityTimer = window.setTimeout(() => controller.abort(), agentChatStreamIdleTimeoutMs)
  const keepAlive = () => {
    window.clearTimeout(inactivityTimer)
    inactivityTimer = window.setTimeout(() => controller.abort(), agentChatStreamIdleTimeoutMs)
  }
  try {
    const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'text/event-stream', 'Accept-Language': input.locale })
    for (const [key, value] of Object.entries(input.headers ?? {})) headers.set(key, value)
    for (const [key, value] of Object.entries(await productAuthorizationHeader())) headers.set(key, value)
    const response = await fetch(input.path, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: input.body,
      signal: controller.signal,
    })
    if (!response.ok || !response.body) throw new ProductApiError(copy.streamUnavailable, response.status)
    for await (const event of readAgentChatStream(response.body, keepAlive)) {
      received = true
      input.onEvent?.(event)
      if (event.type === 'error') {
        throw new ProductApiError(
          botanicAgentChatTransportErrorMessage(new Error(event.message ?? ''), { fallback: copy.chatIncomplete, locale: input.locale }),
          502,
          event.code,
        )
      }
    }
  } catch (caught) {
    if (input.signal?.aborted) throw caught
    if (received) {
      const idleTimedOut = controller.signal.aborted
      captureSentryMessage('agent_stream_interrupted', {
        component: 'agent-stream',
        level: 'error',
        tags: {
          operation: input.path.replace(/^\/api\//u, '').replace(/\/stream$/u, ''),
          error_code: caught instanceof ProductApiError && caught.code
            ? caught.code
            : idleTimedOut ? 'REQUEST_TIMEOUT' : 'STREAM_DISCONNECTED',
        },
      })
      if (caught instanceof ProductApiError) {
        throw new ProductApiError(
          botanicAgentChatTransportErrorMessage(caught, { idleTimedOut, fallback: caught.message, locale: input.locale }),
          caught.status,
          caught.code === 'STREAM_DISCONNECTED' || caught.code === 'REQUEST_TIMEOUT' ? caught.code : (idleTimedOut ? 'REQUEST_TIMEOUT' : 'STREAM_DISCONNECTED'),
        )
      }
      throw new ProductApiError(
        botanicAgentChatTransportErrorMessage(caught, { idleTimedOut, locale: input.locale }),
        0,
        idleTimedOut ? 'REQUEST_TIMEOUT' : 'STREAM_DISCONNECTED',
      )
    }
    throw caught
  } finally {
    window.clearTimeout(inactivityTimer)
    input.signal?.removeEventListener('abort', abortFromCaller)
  }
}

/**
 * 实时对话通道。done 事件携带的响应体与一次性接口完全一致。
 * 任何在收到首个事件之前的失败都退回一次性接口。
 */
export async function streamBotanicAgentChat(
  input: BotanicAgentChatRequestInput,
  options: {
    signal?: AbortSignal
    onEvent?: (event: BotanicAgentChatStreamEvent) => void
    requestKey?: string
    onAccepted?: (turnId: string) => void
  } = {},
): Promise<BotanicAgentChatResponse> {
  const copy = agentApiCopy(input.locale)
  const requestKey = options.requestKey ?? idempotencyKey('agent-chat')
  let settled: BotanicAgentChatResponse | undefined
  let accepted: Extract<BotanicAgentStreamEvent, { type: 'accepted' }> | undefined
  let lastSequence = 0
  let streamFailure: ProductApiError | undefined
  try {
    await streamBotanicAgentEndpoint({
      path: '/api/agent-chat/stream',
      body: JSON.stringify(buildBotanicAgentChatRequest(input)),
      locale: input.locale,
      signal: options.signal,
      headers: { 'Idempotency-Key': requestKey },
      onEvent: (event) => {
        if (event.type === 'accepted') {
          accepted = event
          options.onAccepted?.(event.turnId)
          return
        }
        const decision = monotonicAgentTurnEventDecision(lastSequence, event)
        if (!decision.deliver) return
        lastSequence = decision.lastSequence
        if (event.type === 'error' && accepted) {
          streamFailure = new ProductApiError(
            event.message ?? copy.chatIncomplete,
            agentTurnStreamFailureMustReject(event.code) ? 409 : 502,
            event.code,
          )
          return
        }
        if (event.type === 'done' && event.response) settled = event.response
        options.onEvent?.(event)
      },
    })
  } catch (caught) {
    if (options.signal?.aborted) throw caught
    if (settled) return settled
    if (accepted) {
      if (agentTurnStreamFailureMustReject(streamFailure?.code)) throw streamFailure
      return observePersistentAgentChat(accepted.turnId, input, {
        signal: options.signal,
        after: lastSequence,
        onEvent: options.onEvent,
        missingTurnError: streamFailure,
      })
    }
    return requestBotanicAgentChat(
      input,
      options.signal,
      requestKey,
      options.onAccepted,
      options.onEvent,
    )
  }
  if (!settled && accepted) {
    if (agentTurnStreamFailureMustReject(streamFailure?.code)) throw streamFailure
    return observePersistentAgentChat(accepted.turnId, input, {
      signal: options.signal,
      after: lastSequence,
      onEvent: options.onEvent,
      missingTurnError: streamFailure,
    })
  }
  if (!settled) throw new ProductApiError(copy.streamEnded, 0)
  return settled
}

async function* readAgentChatStream(
  body: ReadableStream<Uint8Array>,
  onActivity?: () => void,
): AsyncGenerator<BotanicAgentChatStreamEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const stream = createBotanicAgentChatStreamReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      // 心跳注释不算业务事件，但证明连接还活着，必须重置空闲超时。
      onActivity?.()
      yield* stream.push(decoder.decode(value, { stream: true }))
    }
    yield* stream.flush()
  } finally {
    reader.releaseLock()
  }
}

/**
 * Agent 消息独立持久化 seam。PUT 的实体 ID 与 Idempotency-Key 在断线重放时保持不变，
 * 因此服务端可将重复送达合并为同一条消息。
 */
export async function submitPersistentBotanicAgentMessage(input: {
  projectId: string
  sessionId: string
  message: BotanicAgentMessage
  idempotencyKey: string
}) {
  const projectId = encodeURIComponent(input.projectId)
  const sessionId = encodeURIComponent(input.sessionId)
  const messageId = encodeURIComponent(input.message.id)
  const response = await productRequest<{ message: BotanicAgentMessage }>(
    `/api/projects/${projectId}/agent-sessions/${sessionId}/messages/${messageId}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': input.idempotencyKey },
      body: JSON.stringify(persistentBotanicAgentMessageBody(input.message)),
    },
  )
  return response.message
}

/** 独立 Session 写入用于跨设备同步标题、模型、Skill、执行模式和上下文；阅读位置使用成员级回执。 */
export async function submitPersistentBotanicAgentSession(
  projectIdValue: string,
  session: BotanicAgentSession,
  idempotencyKey = `agent-session-${session.id}-${session.updatedAt}`,
) {
  const projectId = encodeURIComponent(projectIdValue)
  const sessionId = encodeURIComponent(session.id)
  const response = await productRequest<{ session: BotanicAgentSession }>(`/api/projects/${projectId}/agent-sessions/${sessionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({
      expectedRevision: session.revision ?? 0,
      createdAt: session.createdAt,
      changes: {
        title: session.title,
        executionMode: session.executionMode,
        confirmationWaivers: session.confirmationWaivers ?? [],
        plannerModel: session.plannerModel ?? null,
        mountedSkillIds: session.mountedSkillIds ?? [],
        contextNodeIds: session.contextNodeIds,
      },
    }),
  })
  return response.session
}

/** 独立更新阅读锚点，避免旧设备用整份 Session 覆盖另一设备的新设置。 */
export async function submitPersistentBotanicAgentReadingAnchor(
  projectIdValue: string,
  sessionIdValue: string,
  messageId: string,
) {
  const projectId = encodeURIComponent(projectIdValue)
  const sessionId = encodeURIComponent(sessionIdValue)
  const response = await productRequest<{ receipt: { sessionId: string; messageId: string; updatedAt: number } }>(
    `/api/projects/${projectId}/agent-sessions/${sessionId}/reading-anchor`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `agent-reading-anchor-${sessionIdValue}-${messageId}` },
      body: JSON.stringify({ messageId }),
    },
  )
  return response.receipt
}

export async function createPersistentBotanicAgentRun(input: {
  projectId: string
  plan: BotanicAgentPlan
  branches: AgentRunCreationBranch[]
  idempotencyKey?: string
  /** 确认这次 Run 的回合。缺省表示这条计划不是由服务端回合提出的（本地回退路径）。 */
  turnId?: string
}) {
  const response = await productRequest<{
    run: BotanicAgentRunSnapshot
    canvasPatch?: NonNullable<BotanicAgentActionResult['canvasPatch']>
  }>('/api/agent-runs', {
    method: 'POST',
    // 服务端要落 Run + 写工作流 + 建 N 个 Job 并入队，多分支时 15s 默认超时不够；
    // 客户端过早放弃会走幂等重放，白多一轮往返。
    timeoutMs: 30_000,
    timeoutMessage: '生成提交响应超时，请稍后重试；任务可能仍在云端排队。',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': input.idempotencyKey ?? idempotencyKey('agent-run') },
    body: JSON.stringify({
      projectId: input.projectId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      plan: {
        plannerModel: input.plan.plannerModel,
        intent: input.plan.intent,
        instruction: input.plan.instruction,
        summary: input.plan.summary,
        ...(input.plan.title ? { title: input.plan.title } : {}),
        selectedResultNodeId: input.plan.selectedResultNodeId,
        contextSnapshot: input.plan.contextSnapshot,
        prompt: input.plan.prompt,
        settings: input.plan.settings,
        constraints: input.plan.constraints,
        output: input.plan.output,
        ...(input.plan.variation ? { variation: input.plan.variation } : {}),
        ...(input.plan.region ? { region: input.plan.region } : {}),
        ...(input.plan.composition ? { composition: input.plan.composition } : {}),
        ...(input.plan.memoryBindings?.length ? { memoryBindings: input.plan.memoryBindings } : {}),
        ...(input.plan.skillBindings?.length ? { skillBindings: input.plan.skillBindings } : {}),
        assetGroupId: input.plan.assetGroupId,
        toolCalls: input.plan.toolCalls,
      },
      branches: input.branches,
    }),
  })
  return { run: response.run, canvasPatch: response.canvasPatch }
}

function stableAgentRunKey(runId: string) {
  return runId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 96)
}

const agentActionRequestTimeoutMs = 15_000
/** 确认动作的执行 POST：服务端 MCP 调用最长 45s，客户端必须比它活得久，否则把成功误标成结果未知。 */
const agentActionExecuteTimeoutMs = 60_000

export async function preparePersistentBotanicAgentWorkflow(projectId: string, runId: string) {
  const stableRunId = stableAgentRunKey(runId)
  const toolCallId = `call-workflow-create-${stableRunId}`
  const idempotencyKey = `agent-workflow-${stableRunId}`
  const response = await productRequest<{ output: BotanicAgentActionResult; toolCall: AgentToolCallTrace }>('/api/agent-actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({
      projectId,
      name: 'workflow_create',
      toolCallId,
      confirmed: true,
      arguments: { planId: runId },
    }),
    timeoutMs: agentActionRequestTimeoutMs,
    timeoutMessage: '画布工作流准备超时，请稍后重试；本次生成尚未提交。',
  })
  return response.output
}

export async function executePersistentBotanicAgentRun(
  projectId: string,
  runId: string,
  options: { onWorkflowReady?: (workflow: BotanicAgentActionResult) => Promise<void> } = {},
) {
  const workflow = await preparePersistentBotanicAgentWorkflow(projectId, runId)
  await options.onWorkflowReady?.(workflow)
  const stableRunId = stableAgentRunKey(runId)
  const toolCallId = `call-generation-submit-${stableRunId}`
  const idempotencyKey = `agent-run-execute-${stableRunId}`
  const approvalResponse = await productRequest<{ approval: { token: string; approvedAt: number; expiresAt: number } }>('/api/agent-action-approvals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ projectId, name: 'generation_submit', toolCallId, arguments: { planId: runId } }),
    timeoutMs: agentActionRequestTimeoutMs,
    timeoutMessage: '生成提交响应超时，请稍后重试；任务可能仍在云端排队。',
  })
  const response = await productRequest<{
    output: BotanicAgentActionResult & { run: BotanicAgentRunSnapshot; jobIds: string[] }
    toolCall: AgentToolCallTrace
  }>('/api/agent-actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({
      projectId,
      name: 'generation_submit',
      toolCallId,
      confirmed: true,
      approval: approvalResponse.approval,
      arguments: { planId: runId },
    }),
    timeoutMs: agentActionRequestTimeoutMs,
    timeoutMessage: '生成提交响应超时，请稍后重试；任务可能仍在云端排队。',
  })
  return response.output
}

export async function listPersistentBotanicAgentRuns(projectId: string) {
  const response = await productRequest<{ runs: BotanicAgentRunSnapshot[] }>(`/api/projects/${encodeURIComponent(projectId)}/agent-runs`)
  return response.runs
}

export type BotanicAgentExecutionTrace = {
  traceId: string
  projectId: string
  runId: string
  status: string
  links: { sessionId?: string; messageId?: string; plannerModel?: string; toolCallIds: string[]; skillIds: string[]; jobIds: string[]; artifactIds: string[] }
  metrics: { durationMs: number; retryCount: number; outputCount: number; expectedOutputCount: number; writebackComplete: boolean; recoveryState: 'pending' | 'settled' | 'not_required' }
  failure?: { stage: string; code: string; recoverable: boolean }
}

export async function readPersistentBotanicAgentExecutionTrace(runId: string) {
  const response = await productRequest<{ trace: BotanicAgentExecutionTrace }>(
    `/api/agent-runs/${encodeURIComponent(runId)}/trace`,
  )
  return response.trace
}

/** 读取独立 Agent 实体权威状态，用于其他设备消息、记忆与任务的增量失效恢复。 */
export async function readPersistentBotanicAgentState(
  projectId: string,
  options: { includeMessages?: boolean } = {},
) {
  const suffix = options.includeMessages === false ? '?includeMessages=0' : ''
  return productRequest<{
    sessions: BotanicAgentSession[]
    memory: BotanicAgentMemoryItem[]
    runs: BotanicAgentRunSnapshot[]
  }>(`/api/projects/${encodeURIComponent(projectId)}/agent-state${suffix}`)
}

export async function listPersistentBotanicAgentSessions(projectId: string, options: { limit?: number } = {}) {
  const query = new URLSearchParams()
  if (options.limit !== undefined) query.set('limit', String(options.limit))
  const suffix = query.size ? `?${query.toString()}` : ''
  return productRequest<{ sessions: BotanicAgentSession[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/agent-sessions${suffix}`,
  )
}

export async function listPersistentBotanicAgentSessionMessages(
  projectId: string,
  sessionId: string,
  options: { limit?: number; before?: string; signal?: AbortSignal } = {},
) {
  const query = new URLSearchParams()
  if (options.limit !== undefined) query.set('limit', String(options.limit))
  if (options.before !== undefined) query.set('before', String(options.before))
  const suffix = query.size ? `?${query.toString()}` : ''
  return productRequest<{ messages: BotanicAgentMessage[]; nextBefore?: string }>(
    `/api/projects/${encodeURIComponent(projectId)}/agent-sessions/${encodeURIComponent(sessionId)}/messages${suffix}`,
    { signal: options.signal },
  )
}

export async function listProjectAgentArtifacts(
  projectId: string,
  options: { limit?: number; before?: string; signal?: AbortSignal } = {},
) {
  const query = new URLSearchParams()
  if (options.limit !== undefined) query.set('limit', String(options.limit))
  if (options.before !== undefined) query.set('before', String(options.before))
  const suffix = query.size ? `?${query.toString()}` : ''
  return productRequest<{ artifacts: BotanicIndexedArtifact[]; nextBefore?: string }>(
    `/api/projects/${encodeURIComponent(projectId)}/agent-artifacts${suffix}`,
    { signal: options.signal },
  )
}

export async function retryPersistentBotanicAgentBranch(runId: string, branchId: string, retryKey?: string) {
  const response = await productRequest<{ run: BotanicAgentRunSnapshot }>(
    `/api/agent-runs/${encodeURIComponent(runId)}/branches/${encodeURIComponent(branchId)}/retry`,
    { method: 'POST', headers: { 'Idempotency-Key': retryKey ?? idempotencyKey(`agent-retry-${branchId}`) } },
  )
  return response.run
}

export async function cancelPersistentBotanicAgentRun(runId: string) {
  const response = await productRequest<{ run: BotanicAgentRunSnapshot }>(
    `/api/agent-runs/${encodeURIComponent(runId)}/cancel`,
    { method: 'POST' },
  )
  return response.run
}

export async function requestBotanicAgentRunReview(projectId: string, runId: string, signal?: AbortSignal, locale: ProductLocale = readProductLocale()) {
  const copy = agentApiCopy(locale)
  const response = await productRequest<{ review: BotanicAgentRunReview | null }>('/api/agent-run-reviews', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept-Language': locale },
    body: JSON.stringify({ projectId, runId, locale }),
    signal,
    timeoutMs: 45_000,
    timeoutMessage: copy.reviewTimeout,
  })
  return response.review
}

export async function submitBotanicAgentReviewDecision(input: {
  projectId: string
  reviewId: string
  decision: 'accepted' | 'rejected'
  note?: string
}) {
  const response = await productRequest<{ review: BotanicAgentRunReview }>(
    `/api/agent-reviews/${encodeURIComponent(input.reviewId)}/decision`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: input.projectId, decision: input.decision, ...(input.note ? { note: input.note } : {}) }),
    },
  )
  return response.review
}

export async function listProjectAgentSkills(projectId: string) {
  const response = await productRequest<{ skills: BotanicAgentSkill[] }>(`/api/projects/${encodeURIComponent(projectId)}/agent-skills`)
  return response.skills
}

export async function listBotanicAgentSystemSkills() {
  const response = await productRequest<{ skills: BotanicAgentSkillCatalogItem[] }>('/api/agent-skill-catalog')
  return response.skills
}

export async function createProjectAgentSkill(input: {
  projectId: string
  name: string
  instructions: string
  submissionKey?: string
  toolCallId?: string
}) {
  const submissionKey = input.submissionKey ?? idempotencyKey('agent-skill')
  const toolCallId = input.toolCallId ?? `call-skill-create-${crypto.randomUUID()}`
  const response = await productRequest<{ output: { skill: BotanicAgentSkill }; toolCall: AgentToolCallTrace }>('/api/agent-actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': submissionKey },
    body: JSON.stringify({
      projectId: input.projectId,
      name: 'skill_create',
      toolCallId,
      confirmed: true,
      arguments: { name: input.name, instructions: input.instructions },
    }),
  })
  return response
}

export type ProjectAgentActionContext = {
  sessionId: string
  messageId: string
}

export type ProjectAgentActionManualRetryToken = {
  token: string
  expiresAt: number
}

export type ProjectAgentActionResolution = {
  status: BotanicAgentActionReconciliationStatus
  replayed?: boolean
  manualRetryAuthorization?: ProjectAgentActionManualRetryToken
  manualRetryReservation?: { retryIdempotencyKey: string; expiresAt: number }
}

export type ProjectAgentActionStatusResult = {
  status: BotanicAgentActionReconciliationStatus
  /** 只来自已持久化的 succeeded Receipt；状态查询不会重新执行工具。 */
  execution?: { output: BotanicAgentActionResult; toolCall: AgentToolCallTrace }
}

export class ProjectAgentActionClientError extends ProductApiError {
  stage: 'approval'

  constructor(caught: unknown) {
    const source = caught instanceof ProductApiError ? caught : undefined
    super(source?.message ?? 'Agent 行动审批失败。', source?.status ?? 0, source?.code)
    this.name = 'ProjectAgentActionClientError'
    this.stage = 'approval'
  }
}

export function projectAgentActionIdempotencyKey(action: Pick<BotanicAgentActionProposal, 'id' | 'toolName'>) {
  const actionKey = `${action.id}-${action.toolName}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 112)
  return `agent-action-${actionKey}`
}

function projectAgentActionIdentity(input: {
  projectId: string
  action: BotanicAgentActionProposal
} & ProjectAgentActionContext) {
  return {
    projectId: input.projectId,
    sessionId: input.sessionId,
    messageId: input.messageId,
    actionId: input.action.id,
    name: input.action.toolName,
    toolCallId: input.action.id,
    arguments: input.action.arguments,
  }
}

export async function readProjectAgentActionStatus(input: {
  projectId: string
  action: BotanicAgentActionProposal
  /** manual retry 之后观察新的回执；仍只传幂等键，不接受客户端 receiptId/hash。 */
  receiptIdempotencyKey?: string
} & ProjectAgentActionContext) {
  return productRequest<ProjectAgentActionStatusResult>('/api/agent-actions/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': input.receiptIdempotencyKey ?? projectAgentActionIdempotencyKey(input.action) },
    body: JSON.stringify(projectAgentActionIdentity(input)),
    timeoutMs: agentActionRequestTimeoutMs,
    timeoutMessage: `${input.action.label}状态确认超时，请稍后重试。`,
  })
}

export async function resolveProjectAgentAction(input: {
  projectId: string
  action: BotanicAgentActionProposal
  decision: BotanicAgentActionReconciliationDecision
  receiptIdempotencyKey?: string
  preparedRetryIdempotencyKey?: string
} & ProjectAgentActionContext) {
  return productRequest<ProjectAgentActionResolution>('/api/agent-actions/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': input.receiptIdempotencyKey ?? projectAgentActionIdempotencyKey(input.action) },
    body: JSON.stringify({
      ...projectAgentActionIdentity(input),
      decision: input.decision,
      ...(input.preparedRetryIdempotencyKey
        ? { preparedRetryIdempotencyKey: input.preparedRetryIdempotencyKey }
        : {}),
    }),
    timeoutMs: agentActionRequestTimeoutMs,
    timeoutMessage: `${input.action.label}人工确认超时，请稍后重试。`,
  })
}

export async function executeProjectAgentAction(input: {
  projectId: string
  action: BotanicAgentActionProposal
  manualRetryAuthorization?: BotanicAgentManualRetryAuthorization
  /**
   * raw token 已在服务端消费但 retry Receipt 尚未 claim 时，用同一公开提交键恢复。
   * 服务端仍会校验 consumedByReceiptId；这不是授权凭据。
   */
  resumeManualRetry?: { retryIdempotencyKey: string }
} & ProjectAgentActionContext) {
  const manualRetry = input.manualRetryAuthorization
  const resumeManualRetry = input.resumeManualRetry
  if (manualRetry && resumeManualRetry) {
    throw new ProductApiError('手动重试恢复参数冲突。', 409, 'AGENT_ACTION_MANUAL_RETRY_INVALID')
  }
  if (manualRetry && (
    input.action.status !== 'failed'
    || !manualRetry.token.trim()
    || !manualRetry.retryIdempotencyKey.trim()
    || manualRetry.expiresAt <= Date.now()
  )) {
    throw new ProductApiError('手动重试授权无效或已过期，请重新发起行动。', 409, 'AGENT_ACTION_MANUAL_RETRY_INVALID')
  }
  if (resumeManualRetry && (
    input.action.status !== 'failed'
    || !resumeManualRetry.retryIdempotencyKey.trim()
    || input.action.receiptIdempotencyKey !== resumeManualRetry.retryIdempotencyKey
    || input.action.manualRetryResumeAvailable !== true
  )) {
    throw new ProductApiError('手动重试恢复标识无效，请重新确认状态。', 409, 'AGENT_ACTION_MANUAL_RETRY_INVALID')
  }
  if (!manualRetry && !resumeManualRetry && input.action.status === 'failed') {
    throw new ProductApiError('失败行动不能直接换新标识重试，请重新发起行动。', 409, 'AGENT_ACTION_MANUAL_RETRY_REQUIRED')
  }
  if (input.action.status === 'running' || input.action.status === 'uncertain') {
    throw new ProductApiError('请先确认行动状态，系统不会重复执行结果未知的行动。', 409, 'AGENT_ACTION_RECONCILIATION_REQUIRED')
  }
  const submissionKey = manualRetry?.retryIdempotencyKey
    ?? resumeManualRetry?.retryIdempotencyKey
    ?? projectAgentActionIdempotencyKey(input.action)
  const identity = projectAgentActionIdentity(input)
  let approvalResponse: { approval: { token: string; approvedAt: number; expiresAt: number } } | undefined
  if (agentActionsRequiringApproval.has(input.action.toolName)) {
    try {
      approvalResponse = await productRequest('/api/agent-action-approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': submissionKey },
        body: JSON.stringify(identity),
        timeoutMs: agentActionRequestTimeoutMs,
        timeoutMessage: `${input.action.label}响应超时，请稍后重试。`,
      })
    } catch (caught) {
      // 审批失败发生在 Action POST 之前，不能把卡片误标成 running / outcome unknown。
      throw new ProjectAgentActionClientError(caught)
    }
  }
  try {
    return await productRequest<{ output: BotanicAgentActionResult; toolCall: AgentToolCallTrace }>('/api/agent-actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': submissionKey },
      body: JSON.stringify({
        ...identity,
        confirmed: true,
        ...(approvalResponse ? { approval: approvalResponse.approval } : {}),
        ...(manualRetry ? { manualRetryAuthorization: { token: manualRetry.token } } : {}),
      }),
      timeoutMs: agentActionExecuteTimeoutMs,
      timeoutMessage: `${input.action.label}响应超时，请稍后重试。`,
    })
  } catch (caught) {
    if (caught instanceof ProductApiError && caught.status === 0 && (!caught.code || caught.code === 'REQUEST_TIMEOUT')) {
      throw new ProductApiError(caught.message, 0, 'AGENT_ACTION_OUTCOME_UNKNOWN')
    }
    throw caught
  }
}

/**
 * 读取一次 Run 的评审任务。
 *
 * 服务端已经把覆盖策略与被跳过的候选数放进读模型；界面必须照原样展示，
 * 不要只显示评过的那几条 —— 那会让「评了 2 张」看起来像「全评过了」。
 */
export async function fetchAgentReviewTasks(runId: string) {
  const response = await productRequest<{ tasks: AgentReviewTaskSnapshot[] }>(
    `/api/agent-runs/${encodeURIComponent(runId)}/review-tasks`,
  )
  return response.tasks ?? []
}

/**
 * 提交人工决定。批量共享一个幂等键，服务端逐候选落库。
 *
 * 三种决定都不覆盖原结果：接受只是标记可交付，拒绝保留原因，请求重试会产生新的 Run。
 */
export async function submitAgentReviewDecisions(
  taskId: string,
  decisions: Array<{ artifactId: string; decision: AgentReviewDecision; note?: string }>,
  options: { idempotencyKey?: string } = {},
) {
  const response = await productRequest<{
    task: AgentReviewTaskSnapshot
    decisions: Array<{ artifactId: string; decision: AgentReviewDecision }>
    retryRuns?: Array<{ artifactId: string; runId: string }>
  }>(`/api/agent-review-tasks/${encodeURIComponent(taskId)}/decisions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': options.idempotencyKey ?? idempotencyKey('agent-review-decision'),
    },
    body: JSON.stringify({ decisions }),
  })
  return response
}

/**
 * 请求停止评审。服务端先写 durable cancelling fence；收到响应不等于 Worker 已退出，
 * 因此界面只展示服务端返回的权威状态，不在本地伪造 cancelled。
 */
export async function cancelAgentReviewTask(
  taskId: string,
  options: { idempotencyKey?: string; reason?: string } = {},
) {
  return productRequest<{ task: AgentReviewTaskSnapshot }>(
    `/api/agent-review-tasks/${encodeURIComponent(taskId)}/cancel`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': options.idempotencyKey ?? idempotencyKey('agent-review-cancel'),
      },
      body: JSON.stringify(options.reason ? { reason: options.reason } : {}),
    },
  )
}

/**
 * 人工收口 outcome_unknown。`continue_unverifiable` 不重放 Provider；`retry_once`
 * 明确承担一次重复调用风险，且服务端会拒绝第二次授权。
 */
export async function reconcileAgentReviewOutcome(
  taskId: string,
  action: AgentReviewReconciliationAction,
  options: { idempotencyKey?: string } = {},
) {
  return productRequest<{ task: AgentReviewTaskSnapshot }>(
    `/api/agent-review-tasks/${encodeURIComponent(taskId)}/reconciliation`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': options.idempotencyKey ?? idempotencyKey('agent-review-reconciliation'),
      },
      body: JSON.stringify({ action }),
    },
  )
}
