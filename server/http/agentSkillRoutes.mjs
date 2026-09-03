// @ts-check

import { botanicAgentSkillToolRisk } from '../agent/tools/botanicAgentTools.mjs'
import { publicAgentSkill } from '../agent/action/botanicAgentSkill.mjs'
import { createAgentSkillDraft, preflightAgentSkill, submitAgentSkillReview, updateAgentSkillDraft } from '../agent/action/agentSkillLifecycle.mjs'
import { requireProjectPermission } from '../auth/projectAuthorization.mjs'

function skillIdFrom(match) { return match?.[2] ? decodeURIComponent(match[2]) : undefined }
function expected(body) { return { version: body?.expectedVersion, contentHash: body?.expectedContentHash } }

export function createAgentSkillRouteHandler(input) {
  const { productStore, json, error, readJson, requireUser, methodNotAllowed, registry } = input
  const riskOf = (name) => botanicAgentSkillToolRisk(name, registry)
  const catalog = async (userId, projectId) => await productStore.listAgentSkills(userId, projectId, { includeAll: true }) ?? []
  const find = async (userId, projectId, skillId) => (await catalog(userId, projectId)).find((item) => item.id === skillId)
  const fail = (response, caught) => error(response, caught?.statusCode ?? 400, caught?.code ?? 'INVALID_AGENT_SKILL', caught?.message ?? 'Skill 请求无效。')
  return async function handleAgentSkillRoute({ request, response, url, routeMatches }) {
    const collection = routeMatches.projectAgentSkills
    const item = routeMatches.projectAgentSkill
    const preflight = routeMatches.projectAgentSkillPreflight
    const review = routeMatches.projectAgentSkillReview
    if (!collection && !item && !preflight && !review) return false
    const match = collection ?? item ?? preflight ?? review
    const projectId = decodeURIComponent(match[1])
    const user = await requireUser(request)
    try {
      if (collection && request.method === 'GET') {
        await requireProjectPermission(productStore, user.id, projectId, 'read')
        const skills = await productStore.listAgentSkills(user.id, projectId, { includeAll: url.searchParams.get('include') === 'all' }) ?? []
        return json(response, 200, { skills: skills.map(publicAgentSkill) })
      }
      if (collection && request.method === 'POST') {
        await requireProjectPermission(productStore, user.id, projectId, 'modify-workflow')
        const body = await readJson(request, 64 * 1024, 'Skill 草稿请求过大。')
        const skill = createAgentSkillDraft({ ...body, projectId }, { ownerId: user.id, riskOf })
        return json(response, 201, { skill: publicAgentSkill(await productStore.putAgentSkill(user.id, skill)) })
      }
      const skillId = skillIdFrom(match)
      await requireProjectPermission(productStore, user.id, projectId, request.method === 'GET' ? 'read' : 'modify-workflow')
      const skill = await find(user.id, projectId, skillId)
      if (!skill) return error(response, 404, 'AGENT_SKILL_NOT_FOUND', '未找到 Skill。')
      if (item && request.method === 'GET') return json(response, 200, { skill: publicAgentSkill(skill) })
      if (item && request.method === 'PATCH') {
        const body = await readJson(request, 64 * 1024, 'Skill 草稿请求过大。')
        const updated = updateAgentSkillDraft(skill, body, { actorId: user.id, expected: expected(body), riskOf })
        return json(response, 200, { skill: publicAgentSkill(await productStore.putAgentSkill(user.id, updated)) })
      }
      if (preflight && request.method === 'POST') return json(response, 200, { preflight: preflightAgentSkill(skill, { riskOf, skillCatalog: await catalog(user.id, projectId) }) })
      if (review && request.method === 'POST') {
        const body = await readJson(request, 8 * 1024, 'Skill 审核请求过大。')
        const updated = submitAgentSkillReview(skill, { actorId: user.id, expected: expected(body), riskOf, skillCatalog: await catalog(user.id, projectId) })
        return json(response, 200, { skill: publicAgentSkill(await productStore.putAgentSkill(user.id, updated)) })
      }
      return methodNotAllowed(response, 'Skill 资源方法不受支持。', item ? 'GET, PATCH' : collection ? 'GET, POST' : 'POST')
    } catch (caught) { return fail(response, caught) }
  }
}
