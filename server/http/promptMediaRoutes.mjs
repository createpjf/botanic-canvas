import { refinePrompt, validatePromptRefinementInput } from '../providers/promptRefinementProvider.mjs'
import { requireProjectPermission } from '../auth/projectAuthorization.mjs'

export function createPromptMediaRouteHandler({
  config,
  productStore,
  mediaService,
  json,
  error,
  readJson,
  text,
  requireUser,
  enforceRateLimit,
  streamMedia,
  HttpError,
}) {
  return async function handlePromptMediaRoute(request, response, url, routeMatches) {
    const { projectMedia: projectMediaMatch, media: mediaMatch } = routeMatches
    if (url.pathname === '/api/prompt-refinements') {
      if (request.method !== 'POST') return json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '提示词润色资源只接受提交请求。' } }, { Allow: 'POST' })
      const user = await requireUser(request)
      if (!await enforceRateLimit(response, {
        scope: 'prompt-refinement', subject: user.id,
        limit: config.security.promptRefinementsPerFiveMinutes, windowMs: 5 * 60_000,
      })) return true
      if (!config.flockApiBaseUrl || !config.flockApiKey || !config.flockTextModel) return error(response, 503, 'PROMPT_PROVIDER_NOT_CONFIGURED', '提示词润色尚未配置 Flock API。')
      const input = validatePromptRefinementInput(await readJson(request, config.maximumPromptRefinementRequestBytes, '提示词润色请求过大，请精简后重试。'))
      await requireProjectPermission(productStore, user.id, input.projectId, 'edit')
      const refinementController = new AbortController()
      const cancelRefinement = () => refinementController.abort()
      const cancelOnClosedResponse = () => { if (!response.writableEnded) cancelRefinement() }
      request.once('aborted', cancelRefinement)
      response.once('close', cancelOnClosedResponse)
      if (request.aborted || response.destroyed) cancelRefinement()
      try {
        const result = await refinePrompt(input, config, { signal: refinementController.signal })
        if (refinementController.signal.aborted || response.destroyed) return true
        return json(response, 200, result)
      } catch (caught) {
        if (refinementController.signal.aborted || response.destroyed) return true
        throw caught
      } finally {
        request.off('aborted', cancelRefinement)
        response.off('close', cancelOnClosedResponse)
      }
    }
    if (projectMediaMatch) {
      if (request.method !== 'POST') return json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '项目媒体资源只接受上传请求。' } }, { Allow: 'POST' })
      const user = await requireUser(request)
      if (!await enforceRateLimit(response, { scope: 'media-upload', subject: user.id, limit: config.security.mediaUploadsPerMinute, windowMs: 60_000 })) return true
      const projectId = decodeURIComponent(projectMediaMatch[1])
      await requireProjectPermission(productStore, user.id, projectId, 'edit')
      const body = await readJson(request, config.maximumRequestBytes, '参考图片过大，请压缩到 8MB 以内。')
      try {
        const image = await mediaService.persistDataUrl({ ownerId: user.id, projectId, dataUrl: text(body?.dataUrl, '参考图片', config.maximumRequestBytes) })
        return json(response, 201, { image })
      } catch (caught) {
        if (caught?.code === 'MEDIA_VALIDATION_FAILED') throw new HttpError(400, 'AGENT_REFERENCE_INVALID', caught.message)
        throw caught
      }
    }
    if (mediaMatch) {
      if (request.method !== 'GET') return json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '媒体资源只支持读取。' } }, { Allow: 'GET' })
      const user = await requireUser(request, { allowMediaCookie: true })
      const mediaId = decodeURIComponent(mediaMatch[1])
      const signedUrl = await mediaService.signedUrl(user.id, mediaId)
      if (signedUrl) {
        response.writeHead(302, { Location: signedUrl, 'Cache-Control': 'private, no-store', Vary: 'Cookie, Authorization' })
        response.end()
        return true
      }
      const media = await mediaService.read(user.id, mediaId)
      if (!media) return error(response, 404, 'MEDIA_NOT_FOUND', '未找到媒体文件或你没有访问权限。')
      await streamMedia(response, media)
      return true
    }
    return false
  }
}
