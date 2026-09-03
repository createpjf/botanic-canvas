// @ts-check

import { botanicAgentSkillToolRisk } from '../tools/botanicAgentTools.mjs'
import { publicAgentSkill } from './botanicAgentSkill.mjs'
import { deprecatePublishedAgentSkill, publishReviewedAgentSkill, restoreAgentSkillVersionAsDraft } from './agentSkillLifecycle.mjs'
import { AgentToolRuntimeError } from '../tools/agentToolRuntime.mjs'
import { knownPreEffectFailure } from '../tools/agentToolOutput.mjs'

/** @param {any} input */
export async function executeAgentSkillManagementAction(input) {
  const { productStore, userId, projectId, operation, argumentsValue } = input
  const skills = await productStore.listAgentSkills(userId, projectId, { includeAll: true }) ?? []
  const skill = skills.find((candidate) => candidate.id === argumentsValue.skillId)
  if (!skill) throw knownPreEffectFailure(new AgentToolRuntimeError('AGENT_SKILL_NOT_FOUND', '未找到 Skill。', 404))
  const options = { actorId: userId, expected: { version: argumentsValue.expectedVersion, contentHash: argumentsValue.expectedContentHash }, riskOf: (name) => botanicAgentSkillToolRisk(name), skillCatalog: skills }
  let updated
  try {
    // 生命周期与乐观锁校验全在 putAgentSkill 之前，失败即确定无副作用；
    // 标 outcomeKnown 才能记成普通失败回执而不是结果未知，否则同一幂等键无法重试。
    updated = operation === 'skill_publish' ? publishReviewedAgentSkill(skill, options)
      : operation === 'skill_deprecate' ? deprecatePublishedAgentSkill(skill, options)
        : restoreAgentSkillVersionAsDraft(skill, argumentsValue.version, options)
  } catch (caught) {
    throw knownPreEffectFailure(caught)
  }
  const stored = await productStore.putAgentSkill(userId, updated)
  return { skill: publicAgentSkill(stored), message: operation === 'skill_publish' ? 'Skill 已发布。' : operation === 'skill_deprecate' ? 'Skill 已弃用。' : '已从历史版本创建新草稿。' }
}
