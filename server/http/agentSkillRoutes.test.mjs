import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentSkillRouteHandler } from './agentSkillRoutes.mjs'
import { matchBotanicHttpRoutes } from './httpRouteTable.mjs'

function responseCapture() {
  const captured = {}
  return { captured, json: (_response, status, body) => Object.assign(captured, { status, body }), error: (_response, status, code, message) => Object.assign(captured, { status, body: { code, message } }) }
}

test('Skill 资源支持管理列表、草稿更新、检查与提交审核', async () => {
  let stored
  const productStore = {
    projectAccess: async () => ({ exists: true, role: 'owner' }),
    listAgentSkills: async (_userId, _projectId, options) => !stored ? [] : options?.includeAll ? [stored] : stored.status === 'active' ? [stored] : [],
    putAgentSkill: async (_userId, skill) => (stored = structuredClone(skill)),
  }
  const capture = responseCapture()
  const handler = createAgentSkillRouteHandler({ productStore, ...capture, readJson: async (request) => request.body ?? {}, requireUser: async () => ({ id: 'user-1' }), methodNotAllowed: capture.error })
  const call = async (method, pathname, body, search = '') => {
    const url = new URL('https://botanic.test' + pathname + search)
    await handler({ request: { method, body }, response: {}, url, routeMatches: matchBotanicHttpRoutes(pathname) })
    return capture.captured.body
  }
  const created = (await call('POST', '/api/projects/project-1/agent-skills', { name: '版式规则', instructions: '保持标题留白。' })).skill
  assert.equal(created.lifecycle, 'draft')
  assert.deepEqual((await call('GET', '/api/projects/project-1/agent-skills', undefined, '?include=all')).skills.map((skill) => skill.id), [created.id])
  const updated = (await call('PATCH', '/api/projects/project-1/agent-skills/' + created.id, { name: '版式规则', instructions: '保持标题与主体留白。', expectedVersion: created.version, expectedContentHash: created.contentHash })).skill
  assert.equal(updated.version, 2)
  assert.deepEqual(await call('POST', '/api/projects/project-1/agent-skills/' + created.id + '/preflight'), { preflight: { ok: true, risk: 'read', issues: [] } })
  const reviewed = (await call('POST', '/api/projects/project-1/agent-skills/' + created.id + '/review', { expectedVersion: updated.version, expectedContentHash: updated.contentHash })).skill
  assert.equal(reviewed.lifecycle, 'review')
  const conflict = await call('PATCH', '/api/projects/project-1/agent-skills/' + created.id, { name: '旧编辑', instructions: '旧内容', expectedVersion: created.version, expectedContentHash: created.contentHash })
  assert.equal(conflict.code, 'AGENT_SKILL_EDIT_CONFLICT')
})
