import type { CanvasDocument, GenerateNodeData } from '../../domain/canvas'

/** 本地化画布行动错误时保留 API 错误的原型与机器可读字段。 */
export function preserveCanvasAgentActionError(error: unknown, message: string): Error {
  if (error instanceof Error) {
    error.message = message
    return error
  }
  return new Error(message)
}

/** 本次回退路径创建的一次生成尝试：分支节点，以及为它一并恢复的素材节点。 */
export type UnstartedGenerateBranch = { nodeId: string; companionNodeIds?: string[] }

/**
 * 客户端回退执行失败时清理本次创建、且从未进入提交流程的分支节点：
 * status/jobId/submissionKey 只在 createTaskFlow 提交时写入，任一存在即已提交，
 * 留给恢复器。否则孤儿「新图 · 图像 01」空节点会永远留在画布上。
 *
 * `redo_from_root` 还会为缺失的参考补建素材节点：分支节点被清理时它们一起清理，
 * 否则同样留下孤儿；画布上原有的素材不在 companion 列表里，不受影响。
 */
export function removeUnstartedGenerateBranches(
  branches: UnstartedGenerateBranch[],
  document: Pick<CanvasDocument, 'nodes'>,
  removeNodeFromCanvas: (nodeId: string) => void,
) {
  for (const branch of branches) {
    const node = document.nodes.find((item) => item.id === branch.nodeId && item.type === 'generate')
    const data = node?.data as GenerateNodeData | undefined
    if (!data || data.status || data.jobId || data.submissionKey) continue
    removeNodeFromCanvas(branch.nodeId)
    for (const companionNodeId of branch.companionNodeIds ?? []) {
      if (document.nodes.some((item) => item.id === companionNodeId)) removeNodeFromCanvas(companionNodeId)
    }
  }
}

/** 分支创建前后的节点集差集即这次一并补建的素材节点。 */
export function trackCreatedGenerateBranch(
  nodeId: string,
  beforeNodeIds: Set<string>,
  nodes: readonly { id: string }[],
): UnstartedGenerateBranch {
  return { nodeId, companionNodeIds: nodes.map((node) => node.id).filter((id) => id !== nodeId && !beforeNodeIds.has(id)) }
}

/**
 * Run HTTP 响应就是 durable accepted boundary。之后的本地兼容投影或无关 Canvas
 * 草稿 flush 失败只能等待读模型对账，不能反向把已运行的 Run 标成「提交失败」。
 */
export async function projectAcceptedAgentRunBestEffort(input: {
  apply: () => void
  flush?: () => Promise<unknown>
}) {
  let applied = true
  let flushed = true
  try {
    input.apply()
  } catch {
    applied = false
  }
  if (input.flush) {
    try {
      await input.flush()
    } catch {
      flushed = false
    }
  }
  return { applied, flushed }
}
