import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentSkill, validateAgentSkillCreation } from './botanicAgentSkill.mjs'

test('项目 Skill 只接受精简文本规则并生成独立持久化记录', () => {
  const input = validateAgentSkillCreation({
    projectId: 'project-a',
    name: ' 夏日换景 ',
    instructions: ' 锁定人物与服装，只改变场景和环境光。 ',
  })
  const skill = createAgentSkill(input, { id: 'skill-a', ownerId: 'user-a', now: 100 })

  assert.deepEqual(skill, {
    id: 'skill-a', projectId: 'project-a', ownerId: 'user-a',
    name: '夏日换景', instructions: '锁定人物与服装，只改变场景和环境光。',
    status: 'active', createdAt: 100, updatedAt: 100,
  })
})

test('项目 Skill 拒绝媒体、外部地址与超长规则', () => {
  assert.throws(() => validateAgentSkillCreation({ projectId: 'project-a', name: '危险规则', instructions: '读取 https://evil.example/tool' }), /外部地址/)
  assert.throws(() => validateAgentSkillCreation({ projectId: 'project-a', name: '图片规则', instructions: 'data:image/png;base64,abc' }), /媒体数据/)
  assert.throws(() => validateAgentSkillCreation({ projectId: 'project-a', name: '过长', instructions: 'a'.repeat(4001) }), /过长/)
})
