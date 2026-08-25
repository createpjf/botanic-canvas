// @ts-check
import { executionTraceId, isExecutionStage, redactSensitive } from './executionTrace.mjs'

const finiteNumber = (value) => Number.isFinite(value) ? value : undefined

export function agentRunOperationalPayload(input, occurredAt = new Date().toISOString()) {
  return {
    event: `agent.run.${input.type}`,
    occurredAt,
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    // 与 agentExecutionTrace 共用同一个标识实现，不再各自内联一份公式。
    // Turn 在场时以 Turn 为根，因此同一 Turn 委托的多个 Run 能归到一条链路。
    ...(executionTraceId(input) ? { traceId: executionTraceId(input) } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.branchId ? { branchId: input.branchId } : {}),
    ...(input.jobId ? { jobId: input.jobId } : {}),
    ...(finiteNumber(input.durationMs) !== undefined ? { durationMs: input.durationMs } : {}),
    ...(finiteNumber(input.queueDurationMs) !== undefined ? { queueDurationMs: input.queueDurationMs } : {}),
    ...(finiteNumber(input.activeJobCount) !== undefined ? { activeJobCount: input.activeJobCount } : {}),
    ...(finiteNumber(input.outputCount) !== undefined ? { outputCount: input.outputCount } : {}),
    ...(input.code ? { code: input.code } : {}),
    ...(isExecutionStage(input.stage) ? { stage: input.stage } : {}),
    // 错误摘要一律脱敏后再进日志。Provider 回包与拼接字符串经常带 URL 或密钥，
    // 兜底在这里做，不指望每个抛错点都记得不要拼。
    ...(redactSensitive(input.message ?? '') ? { message: redactSensitive(input.message) } : {}),
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
