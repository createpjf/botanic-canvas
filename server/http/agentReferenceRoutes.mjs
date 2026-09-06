// @ts-check

import { requireProjectPermission } from '../auth/projectAuthorization.mjs'
import { botanicAgentProviderConfig } from '../agent/semantic/botanicAgentPlanner.mjs'
import { nativeAgentVisionModel } from '../agent/semantic/botanicAgentVisionCapability.mjs'
import { describeBotanicAgentContextImages, resolveBotanicAgentVisionParts } from '../agent/semantic/botanicAgentVision.mjs'
import { createAgentReferenceUsage } from '../agent/semantic/botanicAgentReferenceUsage.mjs'

/** 只准备引用，不进入 ToolLoop，不创建或恢复 Turn/Run/Job。 */
export function createAgentReferenceRouteHandler(input) {
  const { config, productStore, json, error, readJson, requireUser, enforceRateLimit, mediaService } = input
  return async function handleReferencePreparation(request, response, match) {
    if (!match) return false
    if (request.method !== 'POST') return json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '引用准备仅接受 POST。' } }, { Allow: 'POST' })
    const projectId = decodeURIComponent(match[1])
    const user = await requireUser(request)
    await requireProjectPermission(productStore, user.id, projectId, 'edit')
    if (!await enforceRateLimit(response, { scope: 'agent-reference-prepare', subject: user.id, limit: config.security.agentPlansPerFiveMinutes, windowMs: 5 * 60_000 })) return true
    const body = await readJson(request, 8 * 1024, '引用准备请求过大。')
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((key) => !['nodeIds', 'plannerModel'].includes(key))
      || typeof body.plannerModel !== 'string' || !body.plannerModel.trim() || body.plannerModel.length > 160
      || !Array.isArray(body.nodeIds) || !body.nodeIds.length || body.nodeIds.length > 4
      || body.nodeIds.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/u.test(id))
      || new Set(body.nodeIds).size !== body.nodeIds.length) {
      return error(response, 400, 'INVALID_REFERENCE_PREPARATION', '请选择有效引用。')
    }
    const model = botanicAgentProviderConfig(config, body.plannerModel).model
    const project = await productStore.readProject(user.id, projectId)
    if (!project?.document || project.document.id !== projectId) return error(response, 404, 'PROJECT_NOT_FOUND', '未找到项目。')
    const controller = new AbortController()
    const abort = () => controller.abort()
    request.once?.('aborted', abort)
    response.once?.('close', abort)
    if (request.aborted || response.destroyed) controller.abort()
    const references = createAgentReferenceUsage(project.document, body.nodeIds)
    const options = {
      document: project.document, contextNodeIds: body.nodeIds, signal: controller.signal,
      resolveMedia: mediaService?.enabled
        ? (mediaId, options) => mediaService.readGenerationInput(user.id, mediaId, projectId, options)
        : undefined,
      onFailure: references.failed,
    }
    try {
      try {
        if (nativeAgentVisionModel(model)) references.prepared(await resolveBotanicAgentVisionParts(options), 'image')
        else references.prepared(await describeBotanicAgentContextImages({ ...options, runtimeConfig: config }), 'description')
      } catch (caught) {
        if (!(caught instanceof Error) || !('code' in caught) || caught.code !== 'AGENT_VISION_BYTES_EXCEEDED') throw caught
        // 超限仍返回逐项失败；不以一次失败重跑整轮。
      }
      controller.signal.throwIfAborted()
      let items = []
      await references.publish((event) => { items = event.items })
      return json(response, 200, { items })
    } finally {
      request.removeListener?.('aborted', abort)
      response.removeListener?.('close', abort)
    }
  }
}
