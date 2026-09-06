import type { AssetNodeData, CanvasDocument, GenerationRecipe, ResultNodeData } from './canvas.ts'

export function isControlledAgentMediaSource(source: string) {
  return /^\/api\/media\/media_[A-Za-z0-9_-]+$/.test(source)
}

function recipeSources(recipe: GenerationRecipe | undefined) {
  return recipe?.references.map((reference) => reference.image).filter(Boolean) ?? []
}

/** 只读恢复确切 Job 输出，不回填节点；媒体访问权限仍由服务端校验。 */
export function resolveAgentResultImage(document: CanvasDocument, nodeId: string) {
  const node = document.nodes.find((candidate) => candidate.id === nodeId && candidate.type === 'result')
  const data = node?.data as ResultNodeData | undefined
  if (!data) return undefined
  if (data.image) return data.image
  if ((data.mediaKind ?? 'image') !== 'image') return undefined
  const jobs = document.generationJobs.filter((job) => data.jobId ? job.id === data.jobId : job.resultNodeId === nodeId)
  const job = jobs.length === 1 ? jobs[0] : undefined
  if (!job || job.status !== 'succeeded' || job.projectionDismissedAt != null) return undefined
  const outputs = job.outputs ?? []
  const output = data.candidateId ? outputs.find((item) => item.id === data.candidateId) : outputs.length === 1 ? outputs[0] : undefined
  if (!output || job.dismissedOutputIds?.includes(output.id) || (output.mediaKind ?? 'image') !== 'image') return undefined
  return output.image || undefined
}

export function collectAgentMediaSources(document: CanvasDocument, resultNodeId: string, assetGroupId?: string) {
  const resultNode = document.nodes.find((node) => node.id === resultNodeId && node.type === 'result')
  const result = resultNode?.type === 'result' ? resultNode.data as ResultNodeData : undefined
  const group = assetGroupId ? document.assetGroups.find((item) => item.id === assetGroupId) : undefined
  const groupAssetIds = new Set(group?.assetIds ?? [])
  return [...new Set([
    resolveAgentResultImage(document, resultNodeId),
    ...recipeSources(result?.generationRecipe),
    ...recipeSources(result?.rootRecipe),
    ...document.assets.filter((asset) => groupAssetIds.has(asset.id)).map((asset) => asset.image),
  ].filter((source): source is string => Boolean(source)))]
}

/** 对话/回合看图只收集当前引用的图片节点，不把视频或未引用节点带去视觉模型。 */
export function collectAgentVisionMediaSources(document: CanvasDocument, contextNodeIds: string[]) {
  const wanted = new Set(contextNodeIds)
  return [...new Set(document.nodes.flatMap((node) => {
    if (!wanted.has(node.id) || (node.type !== 'asset' && node.type !== 'result')) return []
    const data = node.data as AssetNodeData | ResultNodeData
    const image = node.type === 'result' ? resolveAgentResultImage(document, node.id) : data.image
    if ((data.mediaKind ?? 'image') !== 'image' || !image) return []
    return [image]
  }))]
}

export async function prepareAgentMediaSources(
  sources: string[],
  persist: (source: string) => Promise<string>,
) {
  const replacements: Record<string, string> = {}
  for (const source of [...new Set(sources)]) {
    if (isControlledAgentMediaSource(source)) continue
    replacements[source] = await persist(source)
  }
  return replacements
}

export function replaceMediaSources<T>(value: T, replacements: Readonly<Record<string, string>>): T {
  if (typeof value === 'string') return (replacements[value] ?? value) as T
  if (Array.isArray(value)) {
    let changed = false
    const next = value.map((child) => {
      const replaced = replaceMediaSources(child, replacements)
      if (replaced !== child) changed = true
      return replaced
    })
    return (changed ? next : value) as T
  }
  if (!value || typeof value !== 'object') return value
  let changed = false
  const source = value as Record<string, unknown>
  const next: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(source)) {
    const replaced = replaceMediaSources(child, replacements)
    next[key] = replaced
    if (replaced !== child) changed = true
  }
  return (changed ? next : value) as T
}
