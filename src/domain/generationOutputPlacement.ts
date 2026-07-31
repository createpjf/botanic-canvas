export type GenerationResultNodeIdentity = {
  id: string
  jobId?: string
  candidateId?: string
  hasImage: boolean
}

export type GenerationOutputPlacement = {
  outputId: string
  nodeId?: string
  action: 'keep' | 'replace' | 'create'
}

type PlanGenerationOutputPlacementInput = {
  jobId: string
  outputIds: string[]
  resultNodes: GenerationResultNodeIdentity[]
  reusableTaskNodeIds: string[]
}

/**
 * 决定服务端任务输出应复用、补写还是新建哪个结果节点。
 * 这里只处理身份与占位关系，不依赖 React Flow、网络或持久化实现。
 */
export function planGenerationOutputPlacement({
  jobId,
  outputIds,
  resultNodes,
  reusableTaskNodeIds,
}: PlanGenerationOutputPlacementInput): GenerationOutputPlacement[] {
  let reusableNodeIndex = 0
  return outputIds.map((outputId) => {
    const existing = resultNodes.find((node) => node.jobId === jobId && node.candidateId === outputId)
    if (!existing) {
      const nodeId = reusableTaskNodeIds[reusableNodeIndex]
      if (!nodeId) return { outputId, action: 'create' }
      reusableNodeIndex += 1
      return { outputId, nodeId, action: 'replace' }
    }
    return {
      outputId,
      nodeId: existing.id,
      action: existing.hasImage ? 'keep' : 'replace',
    }
  })
}
