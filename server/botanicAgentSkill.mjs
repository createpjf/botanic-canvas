import { createHash, randomUUID } from 'node:crypto'

export const botanicAgentSkillCapabilities = Object.freeze(['read', 'write', 'costly', 'external'])
const skillCapabilitySet = new Set(botanicAgentSkillCapabilities)

export class BotanicAgentSkillError extends Error {
  constructor(statusCode, code, message) {
    super(message)
    this.statusCode = statusCode
    this.code = code
  }
}

function text(value, name, maximumLength) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BotanicAgentSkillError(400, 'INVALID_AGENT_SKILL', `${name}不能为空。`)
  }
  if (value.length > maximumLength) {
    throw new BotanicAgentSkillError(400, 'INVALID_AGENT_SKILL', `${name}过长。`)
  }
  return value.trim()
}

export function normalizeBotanicAgentSkillCapabilities(value) {
  if (value === undefined) return ['read']
  if (!Array.isArray(value) || value.length > 12 || !value.length) {
    throw new BotanicAgentSkillError(400, 'INVALID_AGENT_SKILL', 'Skill 能力声明无效。')
  }
  const capabilities = [...new Set(value.map((capability) => {
    if (typeof capability !== 'string' || !skillCapabilitySet.has(capability)) {
      throw new BotanicAgentSkillError(400, 'INVALID_AGENT_SKILL', `Skill 能力「${String(capability)}」不受支持。`)
    }
    return capability
  }))]
  if (!capabilities.length) throw new BotanicAgentSkillError(400, 'INVALID_AGENT_SKILL', 'Skill 能力声明无效。')
  return capabilities
}

export function validateAgentSkillCreation(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BotanicAgentSkillError(400, 'INVALID_AGENT_SKILL', 'Skill 请求无效。')
  }
  const projectId = text(body.projectId, '项目', 160)
  const name = text(body.name, 'Skill 名称', 80)
  const instructions = text(body.instructions, 'Skill 规则', 4000)
  if (/data:(?:image|video|audio)\//i.test(instructions)) {
    throw new BotanicAgentSkillError(400, 'AGENT_SKILL_MEDIA_FORBIDDEN', 'Skill 规则不能包含媒体数据。')
  }
  if (/https?:\/\//i.test(instructions)) {
    throw new BotanicAgentSkillError(400, 'AGENT_SKILL_EXTERNAL_URL_FORBIDDEN', 'Skill 规则不能直接包含外部地址。')
  }
  const capabilities = normalizeBotanicAgentSkillCapabilities(body.capabilities)
  return { projectId, name, instructions, capabilities }
}

export function createAgentSkill(input, {
  id = `agent_skill_${randomUUID()}`,
  ownerId,
  now = Date.now(),
} = {}) {
  if (!ownerId) throw new TypeError('项目 Skill 缺少所有者。')
  const contentHash = createHash('sha256').update(input.instructions).digest('base64url')
  return {
    id,
    projectId: input.projectId,
    ownerId,
    name: input.name,
    instructions: input.instructions,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    version: 1,
    contentHash,
    capabilities: normalizeBotanicAgentSkillCapabilities(input.capabilities),
    governance: 'project-approved',
    versions: [{ version: 1, contentHash, instructions: input.instructions, updatedAt: now }],
  }
}

export function publicAgentSkill(skill) {
  return skill ? {
    id: skill.id,
    projectId: skill.projectId,
    name: skill.name,
    instructions: skill.instructions,
    status: skill.status,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
    version: skill.version ?? 1,
    contentHash: skill.contentHash,
    capabilities: skill.capabilities ?? ['read'],
    governance: skill.governance ?? 'project-approved',
  } : undefined
}
