// @ts-check
import { executionTraceId, isExecutionStage, redactSensitive } from './executionTrace.mjs'
import { AGENT_SEMANTIC_EVENT_NAMES, createAgentSemanticEvent } from './agentSemanticEvent.mjs'

const finiteNumber = (value) => Number.isFinite(value) ? value : undefined
const w3cTraceId = (value) => typeof value === 'string' && /^[0-9a-f]{32}$/iu.test(value) ? value : undefined
const w3cSpanId = (value) => typeof value === 'string' && /^[0-9a-f]{16}$/iu.test(value) ? value : undefined

const semanticRunType = Object.freeze({
  created: { phase: 'submission', outcome: 'created' },
  submission_reused: { phase: 'submission', outcome: 'reused' },
  auto_submitted: { phase: 'submission', outcome: 'submitted' },
  auto_submit_deferred: { phase: 'submission', outcome: 'deferred' },
  retry_queued: { phase: 'retry', outcome: 'queued' },
  retry_reused: { phase: 'retry', outcome: 'reused' },
  retry_failed: { phase: 'retry', outcome: 'failed' },
  worker_started: { phase: 'execution', outcome: 'started' },
  worker_completed: { phase: 'execution', outcome: 'succeeded' },
  worker_failed: { phase: 'execution', outcome: 'failed' },
  worker_lease_lost: { phase: 'execution', outcome: 'lease_lost' },
  worker_delegation_fenced: { phase: 'execution', outcome: 'fenced' },
  worker_discarded_late_result: { phase: 'execution', outcome: 'discarded' },
  worker_discarded_fenced_result: { phase: 'execution', outcome: 'discarded' },
  cancelled: { phase: 'cancellation', outcome: 'cancelled' },
})

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

/**
 * 将旧 `agent.run.*` 输入适配到固定 semantic schema。未知旧事件不猜测语义，
 * 返回 undefined；旧日志本身仍照常写出。
 */
export function adaptAgentRunOperationalEvent(input, occurredAt = new Date().toISOString()) {
  const mapped = semanticRunType[input?.type]
  if (!mapped) return undefined
  return createAgentSemanticEvent(AGENT_SEMANTIC_EVENT_NAMES.RUN_LIFECYCLE, {
    ...mapped,
    requestId: input.requestId,
    projectId: input.projectId,
    turnId: input.turnId,
    runId: input.runId,
    branchId: input.branchId,
    jobId: input.jobId,
    status: input.status,
    durationMs: finiteNumber(input.durationMs),
    queueDurationMs: finiteNumber(input.queueDurationMs),
    activeJobCount: finiteNumber(input.activeJobCount),
    outputCount: finiteNumber(input.outputCount),
    projectWritebackPending: input.projectWritebackPending,
    ...(input.code ? {
      error: {
        code: input.code,
        ...(typeof input.retryable === 'boolean' ? { retryable: input.retryable } : {}),
        // 原始 message 即使传入也不属于 semantic error schema。
        message: input.message,
      },
    } : {}),
    // `traceId` 在 legacy payload 中仍由 executionTraceId 生成逻辑关联 ID；
    // 若调用方旁路注入的是合法 W3C ID，则 semantic adapter 可直接复用。
    traceId: input.w3cTraceId ?? w3cTraceId(input.traceId),
    spanId: input.w3cSpanId ?? w3cSpanId(input.spanId),
    traceFlags: input.traceFlags,
  }, occurredAt)
}

/**
 * Legacy logger 保持单行 `agent.run.*` 兼容。调用方可用第三参数显式开启旁路双写；
 * 任一 logger 或 semantic adapter 故障都不会阻断另一条日志或业务链路。
 */
export function writeAgentRunOperationalEvent(input, logger = console, options) {
  const occurredAt = new Date().toISOString()
  try {
    logger.log(JSON.stringify(agentRunOperationalPayload(input, occurredAt)))
  } catch {
    // 可观测性不得改变 Agent 或生成任务状态。
  }
  if (options?.semanticLogger) {
    try {
      const semantic = adaptAgentRunOperationalEvent(input, occurredAt)
      if (semantic) options.semanticLogger.log(JSON.stringify(semantic))
    } catch {
      // semantic 双写是旁路；旧日志已经完成或失败，均不改变业务。
    }
  }
}
