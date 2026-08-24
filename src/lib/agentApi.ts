import { buildBotanicAgentPlanRequest, completeBotanicAgentPlan, type BotanicAgentPlanRequestInput, type BotanicAgentPlanResponse } from '../domain/agentPlanContract'
import { buildBotanicAgentChatRequest, type BotanicAgentChatRequestInput, type BotanicAgentChatResponse } from '../domain/agentChatContract'
import { botanicAgentChatTransportErrorMessage, createBotanicAgentChatStreamReader, type BotanicAgentChatStreamEvent, type BotanicAgentStreamEvent } from '../domain/agentChatStream'
import type { BotanicAgentRunReview } from '../domain/agentReviewContract'
import { buildBotanicAgentTurnRequest, type BotanicAgentTurnRequestInput, type BotanicAgentTurnResult } from '../domain/agentTurnContract'
import { ProductApiError, productAuthorizationHeader, productRequest } from './productSession'
import type { AgentToolCallTrace, BotanicAgentReasoningEntry, BotanicAgentActionProposal, BotanicAgentActionResult, BotanicAgentClarificationResponse, BotanicAgentMemoryItem, BotanicAgentMessage, BotanicAgentPlan, BotanicAgentRunSnapshot, BotanicAgentSession, BotanicAgentSkill, BotanicAgentSkillCatalogItem, BotanicIndexedArtifact } from '../domain/agent'
import type { BotanicAgentBranchVariation } from '../domain/agentVariations'
import type { BotanicAgentCompositionItem } from '../domain/agentCreativeComposition'
import { readProductLocale, type ProductLocale } from '../i18n/core'

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
    mediaRead: 'Unable to read the reference image. Add it again.', mediaType: 'Agent reference images support PNG, JPEG, or WebP only.', planTimeout: 'Agent planning is taking longer than expected. Try again shortly; the canvas was not changed.', turnTimeout: 'Agent is taking longer than expected to understand the request. Try again shortly; the canvas was not changed.', chatTimeout: 'Agent is taking longer than expected to organize the context. Try again shortly; the canvas was not changed.', streamUnavailable: 'Agent live connection is unavailable.', chatIncomplete: 'Agent did not complete the response. Try again.', streamEnded: 'Agent live connection ended unexpectedly.', reviewTimeout: 'The result review is taking longer than expected. This round was skipped; your generated results are unaffected.',
  } : {
    mediaRead: '参考图片读取失败，请重新添加该图片。', mediaType: 'Agent 参考图仅支持 PNG、JPEG 或 WebP。', planTimeout: 'Agent 规划响应较慢，请稍后重试；当前画布内容未被修改。', turnTimeout: 'Agent 正在理解你的意图，响应较慢，请稍后重试；当前画布内容未被修改。', chatTimeout: 'Agent 正在整理上下文，响应较慢，请稍后重试；当前画布内容未被修改。', streamUnavailable: 'Agent 实时通道不可用。', chatIncomplete: 'Agent 对话未完成，请重试。', streamEnded: 'Agent 实时通道意外结束。', reviewTimeout: '结果评审响应较慢，已跳过本轮点评；生成结果不受影响。',
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
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(blob.type)) {
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
) {
  const copy = agentApiCopy(input.locale)
  const response = await productRequest<BotanicAgentPlanResponse>('/api/agent-plans', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept-Language': input.locale },
    body: JSON.stringify(buildBotanicAgentPlanRequest(input)),
    signal,
    timeoutMs: 60_000,
    timeoutMessage: copy.planTimeout,
  })
  if (response.reasoning?.length) onReasoning?.(response.reasoning)
  if ('clarification' in response) {
    return { kind: 'clarification', clarification: response.clarification } satisfies BotanicAgentClarificationResponse
  }
  return completeBotanicAgentPlan(response.plan, input)
}

export async function requestBotanicAgentTurn(input: BotanicAgentTurnRequestInput, signal?: AbortSignal, requestKey = idempotencyKey('agent-turn')) {
  const copy = agentApiCopy(input.locale)
  const response = await productRequest<{ turn: BotanicAgentTurnResult; runtimeTurn?: unknown }>('/api/agent-turns', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept-Language': input.locale, 'Idempotency-Key': requestKey },
    body: JSON.stringify(buildBotanicAgentTurnRequest(input)),
    signal,
    timeoutMs: 60_000,
    timeoutMessage: copy.turnTimeout,
  })
  return response.turn
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
  } = {},
): Promise<BotanicAgentPlan | BotanicAgentClarificationResponse> {
  const copy = agentApiCopy(input.locale)
  let settled: BotanicAgentPlan | BotanicAgentClarificationResponse | undefined
  try {
    await streamBotanicAgentEndpoint({
      path: '/api/agent-plans/stream',
      body: JSON.stringify(buildBotanicAgentPlanRequest(input)),
      locale: input.locale,
      signal: options.signal,
      onEvent: (event) => {
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
    if (caught instanceof ProductApiError && (caught.code === 'STREAM_DISCONNECTED' || caught.code === 'REQUEST_TIMEOUT')) {
      throw caught
    }
    return requestBotanicAgentPlan(input, options.signal, options.onReasoning)
  }
  if (!settled) throw new ProductApiError(copy.streamEnded, 0)
  return settled
}

/**
 * 回合实时通道：只读/生成意图工具步进时间线，done 携带与 /api/agent-intent 一致的 turn。
 */
export async function streamBotanicAgentTurn(
  input: BotanicAgentTurnRequestInput,
  options: { signal?: AbortSignal; onEvent?: (event: BotanicAgentStreamEvent) => void } = {},
): Promise<BotanicAgentTurnResult> {
  const copy = agentApiCopy(input.locale)
  const requestKey = idempotencyKey('agent-turn')
  let settled: BotanicAgentTurnResult | undefined
  try {
    await streamBotanicAgentEndpoint({
      path: '/api/agent-turns/stream',
      body: JSON.stringify(buildBotanicAgentTurnRequest(input)),
      locale: input.locale,
      headers: { 'Idempotency-Key': requestKey },
      signal: options.signal,
      onEvent: (event) => {
        if (event.type === 'done' && (event.result ?? event.turn)) settled = event.result ?? event.turn
        options.onEvent?.(event)
      },
    })
  } catch (caught) {
    if (options.signal?.aborted) throw caught
    if (settled) return settled
    if (caught instanceof ProductApiError && (caught.code === 'STREAM_DISCONNECTED' || caught.code === 'REQUEST_TIMEOUT')) {
      throw caught
    }
    return requestBotanicAgentTurn(input, options.signal, requestKey)
  }
  if (!settled) throw new ProductApiError(copy.streamEnded, 0)
  return settled
}

/** 实时对话通道。它只改变“回答什么时候到”，不改变回答本身。 */

export async function requestBotanicAgentChat(input: BotanicAgentChatRequestInput, signal?: AbortSignal) {
  const copy = agentApiCopy(input.locale)
  const response = await productRequest<{ response: BotanicAgentChatResponse }>('/api/agent-chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept-Language': input.locale },
    body: JSON.stringify(buildBotanicAgentChatRequest(input)),
    signal,
    timeoutMs: 60_000,
    timeoutMessage: copy.chatTimeout,
  })
  return response.response
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
  options: { signal?: AbortSignal; onEvent?: (event: BotanicAgentChatStreamEvent) => void } = {},
): Promise<BotanicAgentChatResponse> {
  const copy = agentApiCopy(input.locale)
  let settled: BotanicAgentChatResponse | undefined
  try {
    await streamBotanicAgentEndpoint({
      path: '/api/agent-chat/stream',
      body: JSON.stringify(buildBotanicAgentChatRequest(input)),
      locale: input.locale,
      signal: options.signal,
      onEvent: (event) => {
        if (event.type === 'done' && event.response) settled = event.response
        options.onEvent?.(event)
      },
    })
  } catch (caught) {
    if (options.signal?.aborted) throw caught
    if (settled) return settled
    if (caught instanceof ProductApiError && (caught.code === 'STREAM_DISCONNECTED' || caught.code === 'REQUEST_TIMEOUT')) {
      throw caught
    }
    return requestBotanicAgentChat(input, options.signal)
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
  session: BotanicAgentSession
  message: BotanicAgentMessage
  idempotencyKey: string
}) {
  const projectId = encodeURIComponent(input.projectId)
  const sessionId = encodeURIComponent(input.session.id)
  const messageId = encodeURIComponent(input.message.id)
  await submitPersistentBotanicAgentSession(input.projectId, input.session, `${input.idempotencyKey}-session`)
  const response = await productRequest<{ message: BotanicAgentMessage }>(
    `/api/projects/${projectId}/agent-sessions/${sessionId}/messages/${messageId}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': input.idempotencyKey },
      body: JSON.stringify({
        id: input.message.id,
        role: input.message.role,
        kind: input.message.kind,
        content: input.message.content,
        ...(input.message.prompt === undefined ? {} : { prompt: input.message.prompt }),
        createdAt: input.message.createdAt,
        ...(input.message.plan === undefined ? {} : { plan: input.message.plan }),
        ...(input.message.question === undefined ? {} : { question: input.message.question }),
        ...(input.message.composition === undefined ? {} : { composition: input.message.composition }),
        ...(input.message.runId === undefined ? {} : { runId: input.message.runId }),
        ...(input.message.status === undefined ? {} : { status: input.message.status }),
        ...(input.message.feedback === undefined ? {} : { feedback: input.message.feedback }),
      }),
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
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({
      id: session.id,
      title: session.title,
      executionMode: session.executionMode,
      ...(session.plannerModel ? { plannerModel: session.plannerModel } : {}),
      ...(session.mountedSkillIds?.length ? { mountedSkillIds: session.mountedSkillIds } : {}),
      contextNodeIds: session.contextNodeIds,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
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
}) {
  const response = await productRequest<{ run: BotanicAgentRunSnapshot }>('/api/agent-runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': input.idempotencyKey ?? idempotencyKey('agent-run') },
    body: JSON.stringify({
      projectId: input.projectId,
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
  return response.run
}

function stableAgentRunKey(runId: string) {
  return runId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 96)
}

const agentActionRequestTimeoutMs = 15_000

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
export async function readPersistentBotanicAgentState(projectId: string) {
  return productRequest<{
    sessions: BotanicAgentSession[]
    memory: BotanicAgentMemoryItem[]
    runs: BotanicAgentRunSnapshot[]
  }>(`/api/projects/${encodeURIComponent(projectId)}/agent-state`)
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
  decision: 'accepted' | 'rejected' | 'retry_requested'
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

export async function createProjectAgentSkill(input: { projectId: string; name: string; instructions: string }) {
  const toolCallId = `call-skill-create-${crypto.randomUUID()}`
  const response = await productRequest<{ output: { skill: BotanicAgentSkill }; toolCall: AgentToolCallTrace }>('/api/agent-actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey('agent-skill') },
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

export async function executeProjectAgentAction(input: { projectId: string; action: BotanicAgentActionProposal }) {
  const actionKey = `${input.action.id}-${input.action.toolName}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 112)
  const idempotencyKey = `agent-action-${actionKey}`
  const approvalResponse = ['generation_submit', 'mcp_call'].includes(input.action.toolName)
    ? await productRequest<{ approval: { token: string; approvedAt: number; expiresAt: number } }>('/api/agent-action-approvals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ projectId: input.projectId, name: input.action.toolName, toolCallId: input.action.id, arguments: input.action.arguments }),
      timeoutMs: agentActionRequestTimeoutMs,
      timeoutMessage: `${input.action.label}响应超时，请稍后重试。`,
    })
    : undefined
  const response = await productRequest<{ output: BotanicAgentActionResult; toolCall: AgentToolCallTrace }>('/api/agent-actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({
      projectId: input.projectId,
      name: input.action.toolName,
      toolCallId: input.action.id,
      confirmed: true,
      ...(approvalResponse ? { approval: approvalResponse.approval } : {}),
      arguments: input.action.arguments,
    }),
    timeoutMs: agentActionRequestTimeoutMs,
    timeoutMessage: `${input.action.label}响应超时，请稍后重试。`,
  })
  return response
}
