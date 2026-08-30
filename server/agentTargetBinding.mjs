import { createHash } from 'node:crypto'
import { canonicalHash } from './canonicalHash.mjs'

const MEDIA_PATH_PATTERN = /^\/api\/media\/([^/?#]+)$/u

function targetError(code, message, statusCode = 409) {
  return Object.assign(new Error(message), { code, statusCode })
}

function targetNode(document, nodeId) {
  const node = (document?.nodes ?? []).find((candidate) => candidate?.id === nodeId)
  if (node?.type !== 'result' || typeof node.data?.image !== 'string' || !node.data.image) {
    throw targetError('AGENT_TURN_TARGET_NOT_FOUND', '原 Agent 回合选择的结果已不存在，不能安全续跑。')
  }
  return node
}

function mediaIdFromImage(image) {
  const encoded = MEDIA_PATH_PATTERN.exec(image)?.[1]
  if (!encoded) return undefined
  try { return decodeURIComponent(encoded) } catch { return undefined }
}

async function targetMediaIdentity(image, resolveMedia) {
  const mediaId = mediaIdFromImage(image)
  let bytes
  if (mediaId) {
    const resolved = typeof resolveMedia === 'function' ? await resolveMedia(mediaId) : undefined
    bytes = resolved?.buffer
  } else if (/^data:image\/[^;,]+;base64,/u.test(image)) {
    bytes = Buffer.from(image.slice(image.indexOf(',') + 1), 'base64')
  }
  if (!bytes?.length) {
    throw targetError('AGENT_TARGET_MEDIA_UNAVAILABLE', '原目标图片无法读取，不能安全继续。')
  }
  return {
    ...(mediaId ? { mediaId } : {}),
    mediaSha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

function stableNodeIdentity(node, media) {
  const data = node.data ?? {}
  const jobId = typeof data.jobId === 'string' && data.jobId.trim() ? data.jobId.trim() : null
  const candidateId = typeof data.candidateId === 'string' && data.candidateId.trim() ? data.candidateId.trim() : null
  const versionId = typeof data.versionId === 'string' && data.versionId.trim() ? data.versionId.trim() : null
  return {
    nodeId: node.id,
    nodeRevision: canonicalHash({ jobId, candidateId, versionId, mediaId: media.mediaId ?? null, mediaSha256: media.mediaSha256 }),
    artifactId: jobId && candidateId ? `generation:${jobId}:${candidateId}` : null,
    generationJobId: jobId,
    candidateId,
    versionId,
    ...media,
  }
}

export async function createAgentTargetBinding(document, input, options) {
  const { resolveMedia, projectRevision, now = Date.now() } = options ?? {}
  if (!input?.hasTarget) return undefined
  const node = targetNode(document, input.selectedResultNodeId)
  const media = await targetMediaIdentity(node.data.image, resolveMedia)
  return {
    version: 1,
    ...stableNodeIdentity(node, media),
    ...(Number.isInteger(projectRevision) ? { projectRevision } : {}),
    boundAt: now,
  }
}

export async function assertAgentTargetBinding(document, input, { resolveMedia, projectRevision } = {}) {
  if (!input?.hasTarget) return
  const binding = input.targetBinding
  if (!binding || binding.version !== 1 || binding.nodeId !== input.selectedResultNodeId) {
    throw targetError('AGENT_TARGET_BINDING_MISSING', '原 Agent 回合没有可验证的目标版本，请重新选择图片。')
  }
  if (Number.isInteger(binding.projectRevision)
    && Number.isInteger(projectRevision)
    && binding.projectRevision !== projectRevision) {
    throw targetError('AGENT_TARGET_STALE', '原目标所在项目版本已经变化，请重新选择后再执行。')
  }
  const node = targetNode(document, binding.nodeId)
  const current = stableNodeIdentity(node, await targetMediaIdentity(node.data.image, resolveMedia))
  const fields = ['nodeId', 'nodeRevision', 'artifactId', 'generationJobId', 'candidateId', 'versionId', 'mediaId', 'mediaSha256']
  if (fields.some((field) => (current[field] ?? null) !== (binding[field] ?? null))) {
    throw targetError('AGENT_TARGET_STALE', '原目标图片已经变化，请重新选择后再执行。')
  }
}

export async function assertGenerationTargetBinding(binding, parent, { resolveMedia } = {}) {
  if (!binding) return
  if (!parent || parent.nodeId !== binding.nodeId) {
    throw targetError('AGENT_TARGET_STALE', '生成任务的父图与已确认目标不一致，请重新确认。')
  }
  let bytes = parent.buffer
  if (!bytes?.length && parent.mediaId && typeof resolveMedia === 'function') {
    bytes = (await resolveMedia(parent.mediaId))?.buffer
  }
  const mediaSha256 = bytes?.length ? createHash('sha256').update(bytes).digest('hex') : undefined
  if ((parent.mediaId ?? null) !== (binding.mediaId ?? null) || mediaSha256 !== binding.mediaSha256) {
    throw targetError('AGENT_TARGET_STALE', '生成任务的父图内容与已确认目标不一致，请重新确认。')
  }
}
