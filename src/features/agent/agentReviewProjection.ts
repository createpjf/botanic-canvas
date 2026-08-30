import type { AgentReviewTaskSnapshot } from '../../domain/agentReviewPresentation'

type ProjectionResult =
  | { kind: 'duplicate' }
  | { kind: 'pending'; task?: AgentReviewTaskSnapshot }
  | { kind: 'ready'; task: AgentReviewTaskSnapshot }
  | { kind: 'retry' | 'failed'; error: unknown }

function retryable(error: unknown) {
  const status = Number((error as { status?: unknown } | undefined)?.status ?? 0)
  return !status || status === 408 || status === 425 || status === 429 || status >= 500
}

/** Set 只记住成功投影；临时失败必须释放键，否则同一 Run 永久丢消息。 */
export async function loadAgentReviewProjection(input: {
  requestKey: string
  requested: Set<string>
  read: () => Promise<AgentReviewTaskSnapshot[]>
}): Promise<ProjectionResult> {
  if (input.requested.has(input.requestKey)) return { kind: 'duplicate' }
  input.requested.add(input.requestKey)
  try {
    const tasks = await input.read()
    const task = [...tasks].sort((left, right) => Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0))[0]
    if (!task || !['completed', 'failed', 'cancelled'].includes(task.status)) {
      input.requested.delete(input.requestKey)
      return { kind: 'pending', ...(task ? { task } : {}) }
    }
    return { kind: 'ready', task }
  } catch (error) {
    input.requested.delete(input.requestKey)
    return { kind: retryable(error) ? 'retry' : 'failed', error }
  }
}
