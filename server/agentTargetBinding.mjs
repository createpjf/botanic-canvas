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

async function referenceMediaIdentity(reference, resolveMedia) {
  if (reference?.buffer?.length) {
    return {
      ...(reference.mediaId ? { mediaId: reference.mediaId } : {}),
      mediaSha256: createHash('sha256').update(reference.buffer).digest('hex'),
    }
  }
  return targetMediaIdentity(reference?.image ?? reference?.dataUrl, resolveMedia)
}

export async function createAgentReferenceBindings(references, { resolveMedia } = {}) {
  if (!Array.isArray(references)) throw targetError('AGENT_PLAN_REFERENCE_BINDING_INVALID', 'Agent 参考图绑定无效。', 400)
  return Promise.all(references.map(async (reference) => {
    const media = await referenceMediaIdentity(reference, resolveMedia)
    const artifactVersionId = reference?.artifactVersionId
      ?? reference?.versionId
      ?? (reference?.jobId && reference?.candidateId ? `generation:${reference.jobId}:${reference.candidateId}` : undefined)
    return {
      ...(reference?.nodeId ? { nodeId: reference.nodeId } : {}),
      ...(reference?.assetId ? { assetId: reference.assetId } : {}),
      ...(artifactVersionId ? { artifactVersionId } : {}),
      role: reference?.role ?? '参考',
      ...media,
    }
  }))
}

export async function assertAgentReferenceBindings(expected, references, { resolveMedia } = {}) {
  const current = await createAgentReferenceBindings(references, { resolveMedia })
  if (!Array.isArray(expected) || canonicalHash(current) !== canonicalHash(expected)) {
    throw targetError('AGENT_PLAN_REFERENCE_DRIFT', '确认时使用的参考素材内容已发生变化，请重新确认这次生成。')
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
    boundAt: typeof now === 'function' ? now() : now,
  }
}

export function validateAgentTargetBinding(raw, { expectedNodeId } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || raw.version !== 1
    || typeof raw.nodeId !== 'string' || !raw.nodeId.trim()
    || (expectedNodeId && raw.nodeId !== expectedNodeId)
    || typeof raw.nodeRevision !== 'string' || !raw.nodeRevision.trim()
    || typeof raw.mediaSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(raw.mediaSha256)
    || !Number.isFinite(Number(raw.boundAt)) || Number(raw.boundAt) < 0) {
    throw targetError('AGENT_TARGET_BINDING_INVALID', 'Agent 目标版本绑定无效。', 400)
  }
  const optionalIdentity = (value, name) => {
    if (value === null || value === undefined) return null
    if (typeof value !== 'string' || !value.trim() || value.length > 240) {
      throw targetError('AGENT_TARGET_BINDING_INVALID', `Agent 目标${name}无效。`, 400)
    }
    return value.trim()
  }
  return {
    version: 1,
    nodeId: raw.nodeId.trim(),
    nodeRevision: raw.nodeRevision.trim(),
    artifactId: optionalIdentity(raw.artifactId, ' Artifact'),
    generationJobId: optionalIdentity(raw.generationJobId, '任务'),
    candidateId: optionalIdentity(raw.candidateId, '候选'),
    versionId: optionalIdentity(raw.versionId, '版本'),
    ...(raw.mediaId === undefined ? {} : { mediaId: optionalIdentity(raw.mediaId, '媒体') }),
    mediaSha256: raw.mediaSha256,
    ...(Number.isInteger(raw.projectRevision) ? { projectRevision: raw.projectRevision } : {}),
    boundAt: Number(raw.boundAt),
  }
}

export async function assertAgentTargetBinding(document, input, { resolveMedia } = {}) {
  if (!input?.hasTarget) return
  const binding = input.targetBinding
  if (!binding || binding.version !== 1 || binding.nodeId !== input.selectedResultNodeId) {
    throw targetError('AGENT_TARGET_BINDING_MISSING', '原 Agent 回合没有可验证的目标版本，请重新选择图片。')
  }
  validateAgentTargetBinding(binding, { expectedNodeId: input.selectedResultNodeId })
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
