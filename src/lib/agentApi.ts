import { buildBotanicAgentPlanRequest, completeBotanicAgentPlan, type BotanicAgentPlanRequestInput, type BotanicAgentPlanResponse } from '../domain/agentPlanContract'
import { buildBotanicAgentChatRequest, type BotanicAgentChatRequestInput, type BotanicAgentChatResponse } from '../domain/agentChatContract'
import { botanicAgentChatTransportErrorMessage, createBotanicAgentChatStreamReader, type BotanicAgentChatStreamEvent } from '../domain/agentChatStream'
import type { BotanicAgentRunReview } from '../domain/agentReviewContract'
import { buildBotanicAgentTurnRequest, type BotanicAgentTurnRequestInput, type BotanicAgentTurnResult } from '../domain/agentTurnContract'
import { ProductApiError, productAuthorizationHeader, productRequest } from './productSession'
import type { AgentToolCallTrace, BotanicAgentReasoningEntry, BotanicAgentActionProposal, BotanicAgentActionResult, BotanicAgentClarificationResponse, BotanicAgentMemoryItem, BotanicAgentMessage, BotanicAgentPlan, BotanicAgentRunSnapshot, BotanicAgentSession, BotanicAgentSkill, BotanicAgentSkillCatalogItem, BotanicIndexedArtifact } from '../domain/agent'
import type { BotanicAgentBranchVariation } from '../domain/agentVariations'

export type AgentRunCreationBranch = { id: string; label: string; assetId?: string; variation?: BotanicAgentBranchVariation }

function blobAsDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('参考图片读取失败，请重新添加该图片。'))
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error('参考图片读取失败，请重新添加该图片。'))
    reader.readAsDataURL(blob)
  })
}

export async function persistAgentReferenceMedia(projectId: string, source: string) {
  let dataUrl = source
  if (!source.startsWith('data:image/')) {
    const response = await fetch(source, { credentials: 'include' })
    if (!response.ok) throw new Error('参考图片暂时无法读取，请重新添加后再试。')
    const blob = await response.blob()
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(blob.type)) {
      throw new Error('Agent 参考图仅支持 PNG、JPEG 或 WebP。')
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
  const response = await productRequest<BotanicAgentPlanResponse>('/api/agent-plans', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildBotanicAgentPlanRequest(input)),
    signal,
    timeoutMs: 60_000,
    timeoutMessage: 'Agent 规划响应较慢，请稍后重试；当前画布内容未被修改。',
  })
  if (response.reasoning?.length) onReasoning?.(response.reasoning)
  if ('clarification' in response) {
    return { kind: 'clarification', clarification: response.clarification } satisfies BotanicAgentClarificationResponse
  }
  return completeBotanicAgentPlan(response.plan, input)
}

export async function requestBotanicAgentTurn(input: BotanicAgentTurnRequestInput, signal?: AbortSignal) {
  const response = await productRequest<{ turn: BotanicAgentTurnResult }>('/api/agent-intent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildBotanicAgentTurnRequest(input)),
    signal,
    timeoutMs: 60_000,
    timeoutMessage: 'Agent 正在理解你的意图，响应较慢，请稍后重试；当前画布内容未被修改。',
  })
  return response.turn
}

export async function requestBotanicAgentChat(input: BotanicAgentChatRequestInput, signal?: AbortSignal) {
  const response = await productRequest<{ response: BotanicAgentChatResponse }>('/api/agent-chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildBotanicAgentChatRequest(input)),
    signal,
    timeoutMs: 60_000,
    timeoutMessage: 'Agent 正在整理上下文，响应较慢，请稍后重试；当前画布内容未被修改。',
  })
  return response.response
}

/** 实时通道的静默上限：这么久没有任何事件就判定连接已死，回退或报错。 */
const agentChatStreamIdleTimeoutMs = 60_000

/**
 * 实时对话通道。它只改变“回答什么时候到”，不改变回答本身：done 事件携带的响应体
 * 与一次性接口完全一致，所以下游收敛逻辑只有一套。
 *
 * 任何在收到首个事件之前的失败都退回一次性接口——网关缓冲、代理不支持 SSE、
 * 部署尚未更新都属于这一类，用户不该因此拿不到回答。
 */
export async function streamBotanicAgentChat(
  input: BotanicAgentChatRequestInput,
  options: { signal?: AbortSignal; onEvent?: (event: BotanicAgentChatStreamEvent) => void } = {},
): Promise<BotanicAgentChatResponse> {
  const body = JSON.stringify(buildBotanicAgentChatRequest(input))
  let received = false
  // 静默挂起的连接必须自己超时：SSE 不像一次性请求那样有天然的结束点。
  const controller = new AbortController()
  const abortFromCaller = () => controller.abort()
  if (options.signal?.aborted) controller.abort()
  else options.signal?.addEventListener('abort', abortFromCaller, { once: true })
  let inactivityTimer = window.setTimeout(() => controller.abort(), agentChatStreamIdleTimeoutMs)
  const keepAlive = () => {
    window.clearTimeout(inactivityTimer)
    inactivityTimer = window.setTimeout(() => controller.abort(), agentChatStreamIdleTimeoutMs)
  }
  try {
    const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'text/event-stream' })
    for (const [key, value] of Object.entries(await productAuthorizationHeader())) headers.set(key, value)
    const response = await fetch('/api/agent-chat/stream', {
      method: 'POST',
      credentials: 'include',
      headers,
      body,
      signal: controller.signal,
    })
    if (!response.ok || !response.body) throw new ProductApiError('Agent 实时通道不可用。', response.status)
    let settled: BotanicAgentChatResponse | undefined
    for await (const event of readAgentChatStream(response.body, keepAlive)) {
      received = true
      if (event.type === 'done') settled = event.response
      // error 也必须先进入展示层，让对话内正在运行的步骤明确收束为失败。
      options.onEvent?.(event)
      if (event.type === 'error') {
        throw new ProductApiError(
          botanicAgentChatTransportErrorMessage(new Error(event.message ?? ''), { fallback: 'Agent 对话未完成，请重试。' }),
          502,
          event.code,
        )
      }
    }
    if (!settled) throw new ProductApiError('Agent 实时通道意外结束。', 0)
    return settled
  } catch (caught) {
    // 用户主动取消要如实抛出；只有实时通道本身不可用才回退。
    if (options.signal?.aborted) throw caught
    // 已经开始推送后失败是真实错误，不能悄悄用另一条通道重跑一次模型。
    if (received) {
      const idleTimedOut = controller.signal.aborted
      if (caught instanceof ProductApiError) {
        throw new ProductApiError(
          botanicAgentChatTransportErrorMessage(caught, { idleTimedOut, fallback: caught.message }),
          caught.status,
          caught.code,
        )
      }
      throw new ProductApiError(
        botanicAgentChatTransportErrorMessage(caught, { idleTimedOut }),
        0,
        idleTimedOut ? 'REQUEST_TIMEOUT' : 'STREAM_DISCONNECTED',
      )
    }
    return requestBotanicAgentChat(input, options.signal)
  } finally {
    window.clearTimeout(inactivityTimer)
    options.signal?.removeEventListener('abort', abortFromCaller)
  }
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

export async function requestBotanicAgentRunReview(projectId: string, runId: string, signal?: AbortSignal) {
  const response = await productRequest<{ review: BotanicAgentRunReview | null }>('/api/agent-run-reviews', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, runId }),
    signal,
    timeoutMs: 45_000,
    timeoutMessage: '结果评审响应较慢，已跳过本轮点评；生成结果不受影响。',
  })
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
