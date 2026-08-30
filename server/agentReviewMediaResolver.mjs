// @ts-check
import { resolveBotanicAgentImageDataUrl } from './botanicAgentVision.mjs'

/** Review 取图必须复用 Generation 的 owner/project 授权边界。 */
export function createAgentReviewMediaResolver(mediaService) {
  return async function resolveReviewMedia(image, input) {
    const { ownerId, projectId, signal } = input ?? {}
    if (!mediaService?.enabled || !ownerId || !projectId) return undefined
    return resolveBotanicAgentImageDataUrl(image, (mediaId, options) => (
      mediaService.readGenerationInput(ownerId, mediaId, projectId, options)
    ), signal)
  }
}
