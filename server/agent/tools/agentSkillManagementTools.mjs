// @ts-check

import { AgentToolRuntimeError } from './agentToolRuntime.mjs'

function text(value, name, maximum = 160) {
  const result = typeof value === 'string' ? value.trim() : ''
  if (!result || result.length > maximum) throw new AgentToolRuntimeError('INVALID_AGENT_SKILL_ACTION', name + '无效。', 400)
  return result
}
function expected(value) {
  const version = Number(value?.expectedVersion), contentHash = text(value?.expectedContentHash, 'Skill 内容摘要', 128)
  if (!Number.isSafeInteger(version) || version < 1) throw new AgentToolRuntimeError('INVALID_AGENT_SKILL_ACTION', 'Skill 版本无效。', 400)
  return { version, contentHash }
}
function base(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AgentToolRuntimeError('INVALID_AGENT_SKILL_ACTION', 'Skill 行动参数无效。', 400)
  return { skillId: text(raw.skillId, 'Skill'), ...expected(raw) }
}

export function createAgentSkillManagementTools(execute) {
  if (typeof execute !== 'function') return []
  const tool = (name, label, description, validate) => ({
    name, label, description, risk: 'write', requiresConfirmation: true, terminal: true,
    parameters: { type: 'object', additionalProperties: false, properties: { skillId: { type: 'string' }, expectedVersion: { type: 'integer' }, expectedContentHash: { type: 'string' }, version: { type: 'integer' } }, required: validate === restore ? ['skillId', 'expectedVersion', 'expectedContentHash', 'version'] : ['skillId', 'expectedVersion', 'expectedContentHash'] },
    validate, execute: (argumentsValue, context) => execute(name, argumentsValue, context),
  })
  return [
    tool('skill_publish', '发布项目 Skill', '发布已通过检查的 Skill 审核版本，并冻结依赖。', base),
    tool('skill_deprecate', '弃用项目 Skill', '停止新挂载和执行，保留历史版本与运行记录。', base),
    tool('skill_restore', '恢复 Skill 历史版本', '把指定历史版本恢复为新的草稿版本，不覆盖历史。', restore),
  ]
}
function restore(raw) {
  const value = base(raw), version = Number(raw.version)
  if (!Number.isSafeInteger(version) || version < 1) throw new AgentToolRuntimeError('INVALID_AGENT_SKILL_ACTION', '恢复版本无效。', 400)
  return { ...value, version }
}
