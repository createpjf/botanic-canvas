// @ts-check

import { canonicalHash } from '../canonicalHash.mjs'
import { AgentToolRuntimeError } from '../agent/tools/agentToolRuntime.mjs'

const PAGE_SIZE = 100
const MAX_PAGES = 20

function fail(code, message, statusCode = 422) {
  throw new AgentToolRuntimeError(code, message, statusCode)
}

export function canvasAgentArtifactHash(artifact) {
  return canonicalHash(artifact)
}

function publicGenerationSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const result = {}
  for (const key of ['model', 'aspectRatio', 'resolution', 'thinkingLevel']) if (typeof value[key] === 'string') result[key] = value[key]
  for (const key of ['duration', 'outputWidth', 'outputHeight']) if (Number.isFinite(value[key])) result[key] = Number(value[key])
  if (typeof value.searchGrounding === 'boolean') result.searchGrounding = value.searchGrounding
  return Object.keys(result).length ? result : undefined
}

export function projectCanvasResultFromArtifact(artifact, { id, position, label }) {
  if (!artifact || !['image', 'video'].includes(artifact.kind) || artifact.origin?.type !== 'generation_output') {
    fail('CANVAS_ARTIFACT_NOT_PROJECTABLE', '只有生成完成的图片或视频 Artifact 可以投影到画布。')
  }
  const metadata = artifact.metadata ?? {}
  const settings = publicGenerationSettings(metadata.settings)
  if (typeof artifact.url !== 'string' || !artifact.url.startsWith('/api/media/') || !artifact.origin.jobId || !artifact.origin.outputId
    || metadata.quarantined || metadata.dismissed || metadata.status === 'late_discarded') {
    fail('CANVAS_ARTIFACT_NOT_PROJECTABLE', '该 Artifact 缺少可验证输出或已被隔离，不能投影到画布。')
  }
  return {
    id, type: 'result', position, draggable: true, selected: false,
    data: {
      kind: 'result', label: label ?? artifact.label, image: artifact.url,
      mediaKind: artifact.kind, status: 'ready', taskStatus: 'succeeded',
      jobId: artifact.origin.jobId, candidateId: artifact.origin.outputId,
      ...(settings ? { generationSettings: settings } : {}),
      generationKind: metadata.parentArtifactId ? 'refinement' : 'generation',
    },
  }
}

/** 通过现有 keyset 接口有界查找；不扩 ProductStore，也不把 Artifact 内容交给模型。 */
export async function resolveCanvasAgentArtifacts(productStore, userId, projectId, artifactIds) {
  const remaining = new Set(artifactIds)
  const resolved = new Map()
  let before
  for (let page = 0; remaining.size && page < MAX_PAGES; page += 1) {
    const items = await productStore.listAgentArtifacts(userId, projectId, { limit: PAGE_SIZE, ...(before ? { before } : {}) })
    if (!items) fail('PROJECT_NOT_FOUND', '未找到当前项目。', 404)
    for (const artifact of items) if (remaining.delete(artifact.id)) resolved.set(artifact.id, artifact)
    if (items.length < PAGE_SIZE) break
    const last = items.at(-1)
    before = { createdAt: last.createdAt, id: last.id }
  }
  if (remaining.size) fail('CANVAS_ARTIFACT_NOT_FOUND', '未找到历史 Artifact：' + [...remaining].join('、') + '。', 404)
  return resolved
}
