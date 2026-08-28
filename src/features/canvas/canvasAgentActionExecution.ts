/** 本地化画布行动错误时保留 API 错误的原型与机器可读字段。 */
export function preserveCanvasAgentActionError(error: unknown, message: string): Error {
  if (error instanceof Error) {
    error.message = message
    return error
  }
  return new Error(message)
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
