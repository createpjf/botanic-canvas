// @ts-check

import {
  BotanicAgentSkillError,
  agentSkillManifestRisk,
  agentSkillVersion,
  assertAgentSkillManifestConsistent,
  createAgentSkill,
  deprecateAgentSkill,
  freezeAgentSkillDependencies,
  resolveAgentSkillDependencyClosure,
  skillRiskOrder,
  updateAgentSkill,
  validateAgentSkillCreation,
} from './botanicAgentSkill.mjs'

function assertCurrent(existing, expected = {}) {
  if (!existing?.id) throw new BotanicAgentSkillError(404, 'AGENT_SKILL_NOT_FOUND', '未找到 Skill。')
  if (Number(expected.version) !== Number(existing.version) || expected.contentHash !== existing.contentHash) {
    throw new BotanicAgentSkillError(409, 'AGENT_SKILL_EDIT_CONFLICT', 'Skill 已发生变化，请刷新后重试。')
  }
}
function assertLifecycle(existing, allowed, action) {
  if (!allowed.includes(existing.lifecycle)) throw new BotanicAgentSkillError(409, 'AGENT_SKILL_LIFECYCLE_INVALID', '当前 Skill 状态不能' + action + '。')
}
function issue(code, references = []) { return { code, references } }

/** @param {any} body @param {any} options */
export function createAgentSkillDraft(body, options = {}) {
  return createAgentSkill(validateAgentSkillCreation(body), /** @type {any} */ ({ id: options.id, ownerId: options.ownerId, riskOf: options.riskOf, now: options.now }))
}
/** @param {any} existing @param {any} body @param {any} options */
export function updateAgentSkillDraft(existing, body, options = {}) {
  assertCurrent(existing, options.expected)
  assertLifecycle(existing, ['draft', 'review', 'published'], '编辑')
  const input = validateAgentSkillCreation({ ...body, projectId: existing.projectId })
  return updateAgentSkill(existing, input, /** @type {any} */ ({ actorId: options.actorId, riskOf: options.riskOf, now: options.now }))
}
/** @param {any} skill @param {any} options */
export function preflightAgentSkill(skill, options = {}) {
  const issues = []
  let risk = 'read'
  try {
    assertAgentSkillManifestConsistent(skill, options.riskOf)
    risk = agentSkillManifestRisk(skill.manifest, options.riskOf)
  } catch (error) { issues.push(issue(/** @type {any} */ (error)?.code ?? 'AGENT_SKILL_PREFLIGHT_INVALID')) }
  const closure = resolveAgentSkillDependencyClosure([skill], options.skillCatalog ?? [])
  for (const value of closure.missing) issues.push(issue('AGENT_SKILL_DEPENDENCY_MISSING', [value]))
  for (const value of closure.unusable) issues.push(issue('AGENT_SKILL_DEPENDENCY_UNUSABLE', [value]))
  for (const value of closure.cyclic) issues.push(issue('AGENT_SKILL_DEPENDENCY_CYCLIC', [value]))
  for (const value of closure.conflicts) issues.push(issue('AGENT_SKILL_DEPENDENCY_CONFLICT', [String(value)]))
  if (closure.limitExceeded) issues.push(issue('AGENT_SKILL_DEPENDENCY_LIMIT'))
  return { ok: issues.length === 0, risk: skillRiskOrder.includes(risk) ? risk : 'external', issues }
}
/** @param {any} existing @param {any} options */
export function submitAgentSkillReview(existing, options = {}) {
  assertCurrent(existing, options.expected)
  assertLifecycle(existing, ['draft', 'review'], '提交审核')
  const preflight = preflightAgentSkill(existing, options)
  if (!preflight.ok) throw new BotanicAgentSkillError(409, 'AGENT_SKILL_PREFLIGHT_FAILED', 'Skill 检查未通过。')
  if (existing.lifecycle === 'review') return existing
  const now = options.now ?? Date.now()
  return { ...existing, lifecycle: 'review', status: 'archived', reviewSubmittedBy: options.actorId, reviewSubmittedAt: now, updatedAt: now }
}
/** @param {any} existing @param {any} options */
export function publishReviewedAgentSkill(existing, options = {}) {
  assertCurrent(existing, options.expected)
  assertLifecycle(existing, ['review'], '发布')
  const preflight = preflightAgentSkill(existing, options)
  if (!preflight.ok) throw new BotanicAgentSkillError(409, 'AGENT_SKILL_PREFLIGHT_FAILED', 'Skill 检查未通过。')
  const manifest = freezeAgentSkillDependencies(existing.manifest, options.skillCatalog ?? [])
  return updateAgentSkill(existing, { ...(manifest ? { manifest } : {}) }, /** @type {any} */ ({ actorId: options.actorId, approvedBy: options.actorId, riskOf: options.riskOf, skillCatalog: options.skillCatalog ?? [], now: options.now }))
}
/** @param {any} existing @param {any} options */
export function deprecatePublishedAgentSkill(existing, options = {}) {
  assertCurrent(existing, options.expected)
  assertLifecycle(existing, ['published'], '弃用')
  return deprecateAgentSkill(existing, /** @type {any} */ ({ actorId: options.actorId, now: options.now }))
}
/** @param {any} existing @param {number} version @param {any} options */
export function restoreAgentSkillVersionAsDraft(existing, version, options = {}) {
  assertCurrent(existing, options.expected)
  const snapshot = agentSkillVersion(existing, version)
  if (!snapshot?.name || !snapshot?.instructions || !snapshot?.capabilities) throw new BotanicAgentSkillError(404, 'AGENT_SKILL_VERSION_NOT_FOUND', '未找到可恢复的 Skill 版本。')
  const restored = updateAgentSkill(existing, { name: snapshot.name, instructions: snapshot.instructions, capabilities: snapshot.capabilities, manifest: snapshot.manifest }, /** @type {any} */ ({ actorId: options.actorId, riskOf: options.riskOf, now: options.now }))
  if (restored.lifecycle === 'draft') return restored
  // 恢复的内容与当前执行语义相同时 updateAgentSkill 判定为重放，原样返回已发布/已弃用记录。
  // 恢复动作必须落在草稿上，因此这里只做生命周期转移：版本、内容摘要与历史版本都不动，
  // 乐观锁字段随之保持可用。
  const now = options.now ?? Date.now()
  return {
    ...restored,
    lifecycle: 'draft',
    status: 'archived',
    governance: undefined,
    reviewSubmittedBy: undefined,
    reviewSubmittedAt: undefined,
    publishedBy: undefined,
    publishedAt: undefined,
    deprecatedBy: undefined,
    deprecatedAt: undefined,
    updatedAt: now,
  }
}
