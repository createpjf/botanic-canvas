import type { BotanicAgentSkill } from '../domain/agent'
import { productRequest } from './productSession'

export async function listProjectAgentSkills(projectId: string, options: { includeAll?: boolean } = {}) {
  const query = options.includeAll ? '?include=all' : ''
  const response = await productRequest<{ skills: BotanicAgentSkill[] }>(`/api/projects/${encodeURIComponent(projectId)}/agent-skills${query}`)
  return response.skills
}
export async function createProjectAgentSkillDraft(projectId: string, input: Pick<BotanicAgentSkill, 'name' | 'instructions'> & Partial<Pick<BotanicAgentSkill, 'capabilities' | 'manifest'>>) {
  const response = await productRequest<{ skill: BotanicAgentSkill }>(`/api/projects/${encodeURIComponent(projectId)}/agent-skills`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
  return response.skill
}
export async function updateProjectAgentSkillDraft(projectId: string, skill: BotanicAgentSkill, input: Pick<BotanicAgentSkill, 'name' | 'instructions'> & Partial<Pick<BotanicAgentSkill, 'capabilities' | 'manifest'>>) {
  const response = await productRequest<{ skill: BotanicAgentSkill }>(`/api/projects/${encodeURIComponent(projectId)}/agent-skills/${encodeURIComponent(skill.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, expectedVersion: skill.version, expectedContentHash: skill.contentHash }) })
  return response.skill
}
export type AgentSkillLifecycleAction = 'skill_publish' | 'skill_deprecate' | 'skill_restore'
export async function executeProjectAgentSkillLifecycleAction(projectId: string, skill: BotanicAgentSkill, name: AgentSkillLifecycleAction, version?: number) {
  const argumentsValue = { skillId: skill.id, expectedVersion: skill.version, expectedContentHash: skill.contentHash, ...(version ? { version } : {}) }
  const toolCallId = `call-${name}-${skill.id}-${skill.version}`, submissionKey = `agent-${name}-${skill.id}-${skill.version}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 120)
  const identity = { projectId, name, toolCallId, arguments: argumentsValue }
  const approval = await productRequest<{ approval: { token: string; approvedAt: number; expiresAt: number } }>('/api/agent-action-approvals', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': submissionKey }, body: JSON.stringify(identity) })
  const response = await productRequest<{ output: { skill: BotanicAgentSkill } }>('/api/agent-actions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': submissionKey }, body: JSON.stringify({ ...identity, confirmed: true, approval: approval.approval }) })
  return response.output.skill
}

export type AgentSkillPreflight = { ok: boolean; risk: 'read' | 'write' | 'costly' | 'external'; issues: Array<{ code: string; references: string[] }> }
export async function preflightProjectAgentSkill(projectId: string, skillId: string) {
  const response = await productRequest<{ preflight: AgentSkillPreflight }>(`/api/projects/${encodeURIComponent(projectId)}/agent-skills/${encodeURIComponent(skillId)}/preflight`, { method: 'POST' })
  return response.preflight
}
export async function submitProjectAgentSkillReview(projectId: string, skill: BotanicAgentSkill) {
  const response = await productRequest<{ skill: BotanicAgentSkill }>(`/api/projects/${encodeURIComponent(projectId)}/agent-skills/${encodeURIComponent(skill.id)}/review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: skill.version, expectedContentHash: skill.contentHash }) })
  return response.skill
}
