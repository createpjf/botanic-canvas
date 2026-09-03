import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentSkillDraft, deprecatePublishedAgentSkill, preflightAgentSkill, publishReviewedAgentSkill, restoreAgentSkillVersionAsDraft, submitAgentSkillReview, updateAgentSkillDraft } from './agentSkillLifecycle.mjs'

test('Skill 从草稿经检查发布并以历史版本恢复为新草稿', () => {
  const riskOf = (name) => name === 'canvas_read' ? 'read' : undefined
  const draft = createAgentSkillDraft({ projectId: 'p-1', name: '换景', instructions: '保持商品。', capabilities: ['read'], manifest: { toolAllowlist: ['canvas_read'] } }, { id: 's-1', ownerId: 'u-1', riskOf, now: 100 })
  assert.deepEqual(preflightAgentSkill(draft, { riskOf, skillCatalog: [] }), { ok: true, risk: 'read', issues: [] })
  const review = submitAgentSkillReview(draft, { actorId: 'u-1', expected: { version: 1, contentHash: draft.contentHash }, riskOf, skillCatalog: [], now: 200 })
  const published = publishReviewedAgentSkill(review, { actorId: 'u-1', expected: { version: 1, contentHash: review.contentHash }, riskOf, skillCatalog: [], now: 300 })
  assert.equal(published.lifecycle, 'published')
  const changed = updateAgentSkillDraft(published, { name: '换景', instructions: '保持商品与构图。', capabilities: ['read'], manifest: published.manifest }, { actorId: 'u-1', expected: { version: 1, contentHash: published.contentHash }, riskOf, now: 400 })
  assert.equal(changed.version, 2); assert.equal(changed.lifecycle, 'draft')
  const restored = restoreAgentSkillVersionAsDraft(changed, 1, { actorId: 'u-1', expected: { version: 2, contentHash: changed.contentHash }, riskOf, now: 500 })
  assert.equal(restored.version, 3); assert.equal(restored.instructions, '保持商品。'); assert.equal(restored.lifecycle, 'draft')
  const reviewAgain = submitAgentSkillReview(restored, { actorId: 'u-1', expected: { version: 3, contentHash: restored.contentHash }, riskOf, skillCatalog: [], now: 600 })
  const republished = publishReviewedAgentSkill(reviewAgain, { actorId: 'u-1', expected: { version: 3, contentHash: reviewAgain.contentHash }, riskOf, skillCatalog: [], now: 700 })
  assert.equal(deprecatePublishedAgentSkill(republished, { actorId: 'u-1', expected: { version: 3, contentHash: republished.contentHash }, now: 800 }).lifecycle, 'deprecated')
  assert.equal(changed.versions[0].instructions, '保持商品。')
})

test('Skill 管理拒绝过期编辑和未通过检查的审核', () => {
  const draft = createAgentSkillDraft({ projectId: 'p-1', name: '危险', instructions: '规则', capabilities: ['costly'], manifest: { toolAllowlist: ['generation_submit'], dependencies: [{ skillId: 'gone' }] } }, { id: 's-2', ownerId: 'u-1', riskOf: () => 'costly', now: 100 })
  assert.throws(() => updateAgentSkillDraft(draft, { name: '危险', instructions: '新规则', capabilities: ['read'] }, { actorId: 'u-1', expected: { version: 9, contentHash: draft.contentHash } }), (error) => error.code === 'AGENT_SKILL_EDIT_CONFLICT')
  assert.throws(() => submitAgentSkillReview(draft, { actorId: 'u-1', expected: { version: 1, contentHash: draft.contentHash }, riskOf: () => 'costly', skillCatalog: [], now: 200 }), (error) => error.code === 'AGENT_SKILL_PREFLIGHT_FAILED')
})
