import type { CanvasNode, GenerateNodeData, GenerationJob, ResultNodeData } from './canvas.ts'

export type UnknownSubmissionAnchor = {
  generateNode: CanvasNode
  resultNode: CanvasNode
  resultNodeIds: string[]
  submissionKey: string
}

/** 从持久化画布中找出可用原幂等键接管的最新未知提交。 */
export function findUnknownSubmissionAnchor(nodes: CanvasNode[]): UnknownSubmissionAnchor | undefined {
  const resultNode = [...nodes]
    .filter((node) => node.type === 'result')
    .filter((node) => {
      const result = node.data as ResultNodeData
      return result.taskStatus === 'submission_unknown'
        && !result.jobId
        && (!result.taskGroupId || result.taskGroupId === node.id)
    })
    .sort((left, right) => Number((right.data as ResultNodeData).submittedAt ?? 0) - Number((left.data as ResultNodeData).submittedAt ?? 0))[0]
  if (!resultNode || resultNode.type !== 'result') return undefined

  const result = resultNode.data as ResultNodeData
  const generateNode = nodes.find((node) => node.id === result.outputOf && node.type === 'generate')
  if (!generateNode || generateNode.type !== 'generate') return undefined
  const generate = generateNode.data as GenerateNodeData
  const submissionKey = result.submissionKey ?? generate.submissionKey
  if (!submissionKey) return undefined

  const resultNodeId = result.taskGroupId ?? resultNode.id
  const resultNodeIds = nodes
    .filter((node) => node.type === 'result' && ((node.data as ResultNodeData).taskGroupId ?? node.id) === resultNodeId)
    .map((node) => node.id)
  return { generateNode, resultNode, resultNodeIds, submissionKey }
}

/**
 * 给「没有任务号的未完成占位节点」兜底匹配可补投影的历史任务。
 *
 * 两条硬约束，违反任何一条都会篡改画布历史：
 * - 已在画布上落图的任务是已完成历史，不得再错配给新的占位节点。否则占位节点会被打上
 *   旧任务号，后续对账按「任务号 + 候选号」会命中持有旧图的历史节点，并用占位节点的
 *   参数快照（比例、分辨率、模型、血缘）覆写它。
 * - 已带任务号的占位节点身份明确，只能按自己的任务号恢复，不参与时间就近匹配。
 */
export function matchUnresolvedGenerationTaskJobs({
  nodes,
  jobs,
  reservedJobIds,
}: {
  nodes: CanvasNode[]
  jobs: GenerationJob[]
  reservedJobIds?: Iterable<string>
}): Map<string, GenerationJob> {
  const usedJobIds = new Set(reservedJobIds ?? [])
  for (const node of nodes) {
    if (node.type !== 'result') continue
    const result = node.data as ResultNodeData
    if (result.image && result.jobId) usedJobIds.add(result.jobId)
  }
  const candidates = jobs.filter((job) => job.status === 'succeeded' && Boolean(job.outputs?.length))
  const matches = new Map<string, GenerationJob>()
  for (const node of nodes) {
    if (node.type !== 'result') continue
    const result = node.data as ResultNodeData
    if (result.image || result.jobId) continue
    if (result.taskGroupId && result.taskGroupId !== node.id) continue
    const kind = result.generationKind ?? 'generation'
    const matching = candidates
      .filter((job) => !usedJobIds.has(job.id) && job.kind === kind)
      .sort((left, right) => Math.abs(left.createdAt - (result.submittedAt ?? left.createdAt)) - Math.abs(right.createdAt - (result.submittedAt ?? right.createdAt)))[0]
    if (!matching) continue
    usedJobIds.add(matching.id)
    matches.set(node.id, matching)
  }
  return matches
}
