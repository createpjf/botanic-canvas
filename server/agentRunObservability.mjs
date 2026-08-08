const finiteNumber = (value) => Number.isFinite(value) ? value : undefined
const traceId = (runId) => runId ? `agent-trace:${runId}` : undefined

export function agentRunOperationalPayload(input, occurredAt = new Date().toISOString()) {
  return {
    event: `agent.run.${input.type}`,
    occurredAt,
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(traceId(input.runId) ? { traceId: traceId(input.runId) } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.branchId ? { branchId: input.branchId } : {}),
    ...(input.jobId ? { jobId: input.jobId } : {}),
    ...(finiteNumber(input.durationMs) !== undefined ? { durationMs: input.durationMs } : {}),
    ...(finiteNumber(input.queueDurationMs) !== undefined ? { queueDurationMs: input.queueDurationMs } : {}),
    ...(finiteNumber(input.activeJobCount) !== undefined ? { activeJobCount: input.activeJobCount } : {}),
    ...(finiteNumber(input.outputCount) !== undefined ? { outputCount: input.outputCount } : {}),
    ...(input.code ? { code: input.code } : {}),
    ...(typeof input.projectWritebackPending === 'boolean'
      ? { projectWritebackPending: input.projectWritebackPending }
      : {}),
  }
}

export function writeAgentRunOperationalEvent(input, logger = console) {
  try {
    logger.log(JSON.stringify(agentRunOperationalPayload(input)))
  } catch {
    // 可观测性不得改变 Agent 或生成任务状态。
  }
}
