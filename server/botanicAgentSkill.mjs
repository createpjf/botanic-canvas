import { randomUUID } from 'node:crypto'

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
  return { projectId, name, instructions }
}

export function createAgentSkill(input, {
  id = `agent_skill_${randomUUID()}`,
  ownerId,
  now = Date.now(),
} = {}) {
  if (!ownerId) throw new TypeError('项目 Skill 缺少所有者。')
  return {
    id,
    projectId: input.projectId,
    ownerId,
    name: input.name,
    instructions: input.instructions,
    status: 'active',
    createdAt: now,
    updatedAt: now,
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
  } : undefined
}
