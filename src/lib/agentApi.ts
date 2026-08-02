import { buildBotanicAgentPlanRequest, completeBotanicAgentPlan, type BotanicAgentPlanDraft, type BotanicAgentPlanRequestInput } from '../domain/agentPlanContract'
import { productRequest } from './productSession'
import type { AgentToolCallTrace, BotanicAgentActionProposal, BotanicAgentActionResult, BotanicAgentPlan, BotanicAgentRunSnapshot, BotanicAgentSkill } from '../domain/agent'

export type AgentRunCreationBranch = { id: string; label: string; assetId?: string }

function idempotencyKey(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`
}

export async function requestBotanicAgentPlan(input: BotanicAgentPlanRequestInput, signal?: AbortSignal) {
  const response = await productRequest<{ plan: BotanicAgentPlanDraft }>('/api/agent-plans', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildBotanicAgentPlanRequest(input)),
    signal,
  })
  return completeBotanicAgentPlan(response.plan, input)
}

export async function createPersistentBotanicAgentRun(input: {
  projectId: string
  plan: BotanicAgentPlan
  branches: AgentRunCreationBranch[]
}) {
  const response = await productRequest<{ run: BotanicAgentRunSnapshot }>('/api/agent-runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey('agent-run') },
    body: JSON.stringify({
      projectId: input.projectId,
      plan: {
        plannerModel: input.plan.plannerModel,
        intent: input.plan.intent,
        instruction: input.plan.instruction,
        summary: input.plan.summary,
        selectedResultNodeId: input.plan.selectedResultNodeId,
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

export async function retryPersistentBotanicAgentBranch(runId: string, branchId: string) {
  const response = await productRequest<{ run: BotanicAgentRunSnapshot }>(
    `/api/agent-runs/${encodeURIComponent(runId)}/branches/${encodeURIComponent(branchId)}/retry`,
    { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey(`agent-retry-${branchId}`) } },
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
