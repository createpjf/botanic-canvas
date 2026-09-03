import type { CanvasDocument, GenerateNodeData } from '../../domain/canvas'

/** 本地化画布行动错误时保留 API 错误的原型与机器可读字段。 */
export function preserveCanvasAgentActionError(error: unknown, message: string): Error {
  if (error instanceof Error) {
    error.message = message
    return error
  }
  return new Error(message)
}

/**
 * 客户端回退执行失败时清理本次创建、且从未进入提交流程的分支节点：
 * status/jobId/submissionKey 只在 createTaskFlow 提交时写入，任一存在即已提交，
 * 留给恢复器。否则孤儿「新图 · 图像 01」空节点会永远留在画布上。
 */
export function removeUnstartedGenerateBranches(
  nodeIds: string[],
  document: Pick<CanvasDocument, 'nodes'>,
  removeNodeFromCanvas: (nodeId: string) => void,
) {
  for (const nodeId of nodeIds) {
    const node = document.nodes.find((item) => item.id === nodeId && item.type === 'generate')
    const data = node?.data as GenerateNodeData | undefined
    if (data && !data.status && !data.jobId && !data.submissionKey) removeNodeFromCanvas(nodeId)
  }
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
