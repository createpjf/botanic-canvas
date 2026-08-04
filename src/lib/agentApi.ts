import { buildBotanicAgentPlanRequest, completeBotanicAgentPlan, type BotanicAgentPlanRequestInput, type BotanicAgentPlanResponse } from '../domain/agentPlanContract'
import { buildBotanicAgentChatRequest, type BotanicAgentChatRequestInput, type BotanicAgentChatResponse } from '../domain/agentChatContract'
import { productRequest } from './productSession'
import type { AgentToolCallTrace, BotanicAgentActionProposal, BotanicAgentActionResult, BotanicAgentClarificationResponse, BotanicAgentMessage, BotanicAgentPlan, BotanicAgentRunSnapshot, BotanicAgentSession, BotanicAgentSkill, BotanicIndexedArtifact } from '../domain/agent'

export type AgentRunCreationBranch = { id: string; label: string; assetId?: string }

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

export async function requestBotanicAgentPlan(input: BotanicAgentPlanRequestInput, signal?: AbortSignal) {
  const response = await productRequest<BotanicAgentPlanResponse>('/api/agent-plans', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildBotanicAgentPlanRequest(input)),
    signal,
    timeoutMs: 60_000,
    timeoutMessage: 'Agent 规划响应较慢，请稍后重试；当前画布内容未被修改。',
  })
  if ('clarification' in response) {
    return { kind: 'clarification', clarification: response.clarification } satisfies BotanicAgentClarificationResponse
  }
  return completeBotanicAgentPlan(response.plan, input)
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
  await productRequest<{ session: BotanicAgentSession }>(`/api/projects/${projectId}/agent-sessions/${sessionId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `${input.idempotencyKey}-session` },
    body: JSON.stringify({
      id: input.session.id,
      title: input.session.title,
      executionMode: input.session.executionMode,
      contextNodeIds: input.session.contextNodeIds,
      createdAt: input.session.createdAt,
      updatedAt: input.session.updatedAt,
    }),
  })
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
        selectedResultNodeId: input.plan.selectedResultNodeId,
        contextSnapshot: input.plan.contextSnapshot,
        prompt: input.plan.prompt,
        settings: input.plan.settings,
        constraints: input.plan.constraints,
        output: input.plan.output,
        assetGroupId: input.plan.assetGroupId,
        toolCalls: input.plan.toolCalls,
      },
      branches: input.branches,
    }),
  })
  return response.run
}

export async function executePersistentBotanicAgentRun(projectId: string, runId: string) {
  const response = await productRequest<{
    output: BotanicAgentActionResult & { run: BotanicAgentRunSnapshot; jobIds: string[] }
    toolCall: AgentToolCallTrace
  }>('/api/agent-actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `agent-run-execute-${runId}` },
    body: JSON.stringify({
      projectId,
      name: 'generation_submit',
      toolCallId: `call-generation-submit-${runId}`,
      confirmed: true,
      arguments: { planId: runId },
    }),
  })
  return response.output
}

export async function listPersistentBotanicAgentRuns(projectId: string) {
  const response = await productRequest<{ runs: BotanicAgentRunSnapshot[] }>(`/api/projects/${encodeURIComponent(projectId)}/agent-runs`)
  return response.runs
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

export async function listProjectAgentSkills(projectId: string) {
  const response = await productRequest<{ skills: BotanicAgentSkill[] }>(`/api/projects/${encodeURIComponent(projectId)}/agent-skills`)
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
  const response = await productRequest<{ output: BotanicAgentActionResult; toolCall: AgentToolCallTrace }>('/api/agent-actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `agent-action-${actionKey}` },
    body: JSON.stringify({
      projectId: input.projectId,
      name: input.action.toolName,
      toolCallId: input.action.id,
      confirmed: true,
      arguments: input.action.arguments,
    }),
  })
  return response
}
