import { createHash, randomUUID } from 'node:crypto'

export const botanicAgentSkillCapabilities = Object.freeze(['read', 'write', 'costly', 'external'])
const skillCapabilitySet = new Set(botanicAgentSkillCapabilities)

/**
 * Skill 生命周期。治理状态必须由流程产生，不得在创建时硬编码为已批准（ADR 0006）。
 *
 * `published` 只能来自一次可追溯的批准动作，并记下批准人与时间 —— 状态本身要能被
 * 核对，而不只是被声明。`status` 字段保留为派生的兼容视图（active/archived），
 * 既有读取路径按它过滤。
 */
export const botanicAgentSkillLifecycle = Object.freeze(['draft', 'review', 'published', 'deprecated'])
const lifecycleSet = new Set(botanicAgentSkillLifecycle)

/** 兼容视图：老读取路径只认 active/archived。 */
function statusForLifecycle(lifecycle) {
  return lifecycle === 'published' ? 'active' : 'archived'
}

/** 已发布且未弃用的 Skill 才能被挂载或执行。 */
export function isUsableAgentSkill(skill) {
  if (!skill) return false
  if (typeof skill.lifecycle === 'string') return skill.lifecycle === 'published'
  // 生命周期字段上线前创建的 Skill 只有 status。
  return skill.status === 'active'
}

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

/**
 * 创建项目 Skill。
 *
 * `approvedBy` 是批准这次创建的人。有它才进入 `published` 并记下批准人与时间；
 * 没有它就停在 `draft` —— 「已批准」不能凭创建这个动作本身成立。当前唯一的创建入口
 * 是用户确认过的 Agent 行动，因此路由把确认者作为批准人传进来。
 */
export function createAgentSkill(input, {
  id = `agent_skill_${randomUUID()}`,
  ownerId,
  approvedBy,
  now = Date.now(),
} = {}) {
  if (!ownerId) throw new TypeError('项目 Skill 缺少所有者。')
  const contentHash = createHash('sha256').update(input.instructions).digest('base64url')
  const lifecycle = approvedBy ? 'published' : 'draft'
  return {
    id,
    projectId: input.projectId,
    ownerId,
    name: input.name,
    instructions: input.instructions,
    lifecycle,
    status: statusForLifecycle(lifecycle),
    createdAt: now,
    updatedAt: now,
    version: 1,
    contentHash,
    capabilities: normalizeBotanicAgentSkillCapabilities(input.capabilities),
    ...(approvedBy ? { governance: 'project-approved', publishedBy: approvedBy, publishedAt: now } : {}),
    versions: [{
      version: 1, contentHash, instructions: input.instructions, updatedAt: now,
      ...(approvedBy ? { publishedBy: approvedBy, publishedAt: now } : {}),
    }],
  }
}

/**
 * 修改已发布 Skill：**追加新版本**，不原位改写。
 *
 * 已发布版本原位可改的话，持有 `version: N` 的历史 Run 会突然按新内容执行，
 * 「历史 Run 仍引用旧版本」就是一句无法验证的声明（ADR 0006）。
 */
export function updateAgentSkill(existing, input, { actorId, approvedBy, now = Date.now() } = {}) {
  if (!existing?.id) throw new TypeError('Skill 更新缺少原始记录。')
  if (!actorId) throw new TypeError('Skill 更新缺少操作者。')
  const instructions = text(input?.instructions ?? existing.instructions, 'Skill 规则', 4000)
  const contentHash = createHash('sha256').update(instructions).digest('base64url')
  const versions = Array.isArray(existing.versions) ? [...existing.versions] : []
  const version = Number(existing.version ?? versions.length ?? 1) + 1
  const lifecycle = approvedBy ? 'published' : 'draft'
  return {
    ...existing,
    name: input?.name ? text(input.name, 'Skill 名称', 80) : existing.name,
    instructions,
    capabilities: input?.capabilities === undefined
      ? normalizeBotanicAgentSkillCapabilities(existing.capabilities)
      : normalizeBotanicAgentSkillCapabilities(input.capabilities),
    lifecycle,
    status: statusForLifecycle(lifecycle),
    version,
    contentHash,
    updatedAt: now,
    ...(approvedBy
      ? { governance: 'project-approved', publishedBy: approvedBy, publishedAt: now }
      : { governance: undefined, publishedBy: undefined, publishedAt: undefined }),
    versions: [...versions, {
      version, contentHash, instructions, updatedAt: now,
      ...(approvedBy ? { publishedBy: approvedBy, publishedAt: now } : {}),
    }],
  }
}

/** 弃用：不删除历史版本，只让它不再可挂载。 */
export function deprecateAgentSkill(existing, { actorId, now = Date.now() } = {}) {
  if (!existing?.id) throw new TypeError('Skill 弃用缺少原始记录。')
  if (!actorId) throw new TypeError('Skill 弃用缺少操作者。')
  return {
    ...existing,
    lifecycle: 'deprecated',
    status: statusForLifecycle('deprecated'),
    deprecatedBy: actorId,
    deprecatedAt: now,
    updatedAt: now,
  }
}

/**
 * 取回某个历史版本的指令内容。
 *
 * 没有这条路径，一个持有 `version: N` 的历史 Run 就无法说明自己当时按什么执行 ——
 * 「Run 固定 Skill 版本」也就无从验证。
 */
export function agentSkillVersion(skill, version) {
  const target = Number(version)
  if (!Number.isInteger(target) || target < 1) return undefined
  return (Array.isArray(skill?.versions) ? skill.versions : []).find((entry) => Number(entry?.version) === target)
}

export function publicAgentSkill(skill) {
  if (!skill) return undefined
  const lifecycle = lifecycleSet.has(skill.lifecycle)
    ? skill.lifecycle
    : (skill.status === 'active' ? 'published' : 'deprecated')
  return {
    id: skill.id,
    projectId: skill.projectId,
    name: skill.name,
    instructions: skill.instructions,
    lifecycle,
    status: skill.status,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
    version: skill.version ?? 1,
    contentHash: skill.contentHash,
    capabilities: skill.capabilities ?? ['read'],
    // 治理状态只在真的批准过时才出现；缺省即「尚未批准」，不再默认成已批准。
    ...(skill.governance ? { governance: skill.governance } : {}),
    ...(skill.publishedBy ? { publishedBy: skill.publishedBy, publishedAt: skill.publishedAt } : {}),
    ...(skill.deprecatedBy ? { deprecatedBy: skill.deprecatedBy, deprecatedAt: skill.deprecatedAt } : {}),
    // 历史版本清单随读模型暴露：内容按需用 agentSkillVersion 取回，列表只给身份。
    versions: (Array.isArray(skill.versions) ? skill.versions : []).map((entry) => ({
      version: entry.version,
      contentHash: entry.contentHash,
      updatedAt: entry.updatedAt,
      ...(entry.publishedBy ? { publishedBy: entry.publishedBy, publishedAt: entry.publishedAt } : {}),
    })),
  }
}
