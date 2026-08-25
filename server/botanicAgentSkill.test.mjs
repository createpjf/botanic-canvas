import assert from 'node:assert/strict'
import test from 'node:test'
import {
  agentSkillVersion,
  botanicAgentSkillLifecycle,
  createAgentSkill,
  deprecateAgentSkill,
  isUsableAgentSkill,
  publicAgentSkill,
  updateAgentSkill,
  validateAgentSkillCreation,
} from './botanicAgentSkill.mjs'

const creation = () => validateAgentSkillCreation({
  projectId: 'project-a',
  name: ' 夏日换景 ',
  instructions: ' 锁定人物与服装，只改变场景和环境光。 ',
})
const contentHash = 'd7-pXlsFnTupsJzEX2zITaj7L0yRqm67FQZomHWNeMw'

test('项目 Skill 只接受精简文本规则并生成独立持久化记录', () => {
  const skill = createAgentSkill(creation(), { id: 'skill-a', ownerId: 'user-a', approvedBy: 'user-a', now: 100 })

  assert.deepEqual(skill, {
    id: 'skill-a', projectId: 'project-a', ownerId: 'user-a',
    name: '夏日换景', instructions: '锁定人物与服装，只改变场景和环境光。',
    lifecycle: 'published', status: 'active', createdAt: 100, updatedAt: 100,
    version: 1, contentHash, capabilities: ['read'],
    governance: 'project-approved', publishedBy: 'user-a', publishedAt: 100,
    versions: [{ version: 1, contentHash, instructions: '锁定人物与服装，只改变场景和环境光。', updatedAt: 100, publishedBy: 'user-a', publishedAt: 100 }],
  })
})

test('没有批准人就停在 draft：「已批准」不能凭创建这个动作本身成立', () => {
  const draft = createAgentSkill(creation(), { id: 'skill-draft', ownerId: 'user-a', now: 100 })
  assert.equal(draft.lifecycle, 'draft')
  assert.equal(draft.governance, undefined)
  assert.equal(draft.publishedBy, undefined)
  // 未发布的 Skill 不可挂载执行。
  assert.equal(isUsableAgentSkill(draft), false)
  assert.equal(isUsableAgentSkill(createAgentSkill(creation(), { ownerId: 'user-a', approvedBy: 'user-a' })), true)
  // 生命周期字段上线前创建的 Skill 只有 status。
  assert.equal(isUsableAgentSkill({ status: 'active' }), true)
  assert.equal(isUsableAgentSkill({ status: 'archived' }), false)
  assert.deepEqual([...botanicAgentSkillLifecycle], ['draft', 'review', 'published', 'deprecated'])
})

test('修改已发布 Skill 追加新版本，历史版本仍可取回原内容', () => {
  // 原位改写会让持有 version: 1 的历史 Run 突然按新内容执行。
  const published = createAgentSkill(creation(), { id: 'skill-a', ownerId: 'user-a', approvedBy: 'user-a', now: 100 })
  const updated = updateAgentSkill(published, { instructions: '锁定人物，允许更换背景与光线。' }, {
    actorId: 'user-a', approvedBy: 'user-a', now: 200,
  })

  assert.equal(updated.version, 2)
  assert.notEqual(updated.contentHash, published.contentHash)
  assert.equal(agentSkillVersion(updated, 1).instructions, '锁定人物与服装，只改变场景和环境光。')
  assert.equal(agentSkillVersion(updated, 1).contentHash, contentHash)
  assert.equal(agentSkillVersion(updated, 2).instructions, '锁定人物，允许更换背景与光线。')
  assert.equal(agentSkillVersion(updated, 3), undefined)
})

test('未经批准的修改回落 draft，不保留上一版的已批准标记', () => {
  const published = createAgentSkill(creation(), { id: 'skill-a', ownerId: 'user-a', approvedBy: 'user-a', now: 100 })
  const revised = updateAgentSkill(published, { instructions: '偷偷改成别的规则。' }, { actorId: 'user-b', now: 200 })
  assert.equal(revised.lifecycle, 'draft')
  assert.equal(revised.governance, undefined)
  assert.equal(revised.publishedBy, undefined)
  assert.equal(isUsableAgentSkill(revised), false)
})

test('弃用不删除历史版本，只让 Skill 不再可挂载', () => {
  const published = createAgentSkill(creation(), { id: 'skill-a', ownerId: 'user-a', approvedBy: 'user-a', now: 100 })
  const deprecated = deprecateAgentSkill(published, { actorId: 'user-a', now: 300 })
  assert.equal(deprecated.lifecycle, 'deprecated')
  assert.equal(isUsableAgentSkill(deprecated), false)
  assert.equal(agentSkillVersion(deprecated, 1).instructions, '锁定人物与服装，只改变场景和环境光。')
})

test('读模型暴露历史版本清单，但不默认声称已批准', () => {
  const draft = createAgentSkill(creation(), { id: 'skill-draft', ownerId: 'user-a', now: 100 })
  const publicDraft = publicAgentSkill(draft)
  assert.equal(publicDraft.lifecycle, 'draft')
  assert.equal(publicDraft.governance, undefined)
  assert.deepEqual(publicDraft.versions, [{ version: 1, contentHash, updatedAt: 100 }])
  // 版本清单只给身份；内容按需用 agentSkillVersion 取回。
  assert.equal('instructions' in publicDraft.versions[0], false)
})

test('项目 Skill 拒绝媒体、外部地址与超长规则', () => {
  assert.throws(() => validateAgentSkillCreation({ projectId: 'project-a', name: '危险规则', instructions: '读取 https://evil.example/tool' }), /外部地址/)
  assert.throws(() => validateAgentSkillCreation({ projectId: 'project-a', name: '图片规则', instructions: 'data:image/png;base64,abc' }), /媒体数据/)
  assert.throws(() => validateAgentSkillCreation({ projectId: 'project-a', name: '过长', instructions: 'a'.repeat(4001) }), /过长/)
  assert.throws(() => validateAgentSkillCreation({ projectId: 'project-a', name: '未知能力', instructions: '只读', capabilities: ['browser_delete'] }), /不受支持/)
  assert.deepEqual(validateAgentSkillCreation({ projectId: 'project-a', name: '需要确认', instructions: '写入工作流', capabilities: ['read', 'write', 'read'] }).capabilities, ['read', 'write'])
})
