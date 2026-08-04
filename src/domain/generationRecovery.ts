import type { CanvasNode, GenerateNodeData, ResultNodeData } from './canvas.ts'

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
