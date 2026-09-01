// @ts-check

import { ROLLOUT_FLAGS } from './featureFlags.mjs'

/**
 * Agent V2 的安全语义日志协议。
 *
 * 这里刻意不用 `attributes: Record<string, unknown>`：任意属性袋会让 Prompt、
 * Provider 回包或媒体地址在某个调用点“顺手”进入日志。新增字段必须先在本模块
 * 进入固定 schema，再由测试证明边界。
 */
export const AGENT_SEMANTIC_EVENT_SCHEMA = 'botanic.agent.semantic'
export const AGENT_SEMANTIC_EVENT_SCHEMA_VERSION = 1

export const AGENT_SEMANTIC_EVENT_NAMES = Object.freeze({
  RUN_LIFECYCLE: 'botanic.agent.run.lifecycle',
  ROLLOUT_EVALUATED: 'botanic.agent.rollout.evaluated',
  CONTEXT_SHADOW_EVALUATED: 'botanic.agent.context.shadow.evaluated',
  CONTEXT_COMPACTION_RESULT: 'botanic.agent.context.compaction.result',
  CONTEXT_OVERFLOW_RESULT: 'botanic.agent.context.overflow.result',
  CONTEXT_USAGE_ANCHOR_RESULT: 'botanic.agent.context.usage_anchor.result',
  HARNESS_LIFECYCLE: 'botanic.agent.harness.lifecycle',
})

// Telemetry 自身也必须能灰度；在 featureFlags 的同一 Flag 正式声明前保持显式枚举，
// 不能退化成“任意大写字符串都可进日志”。
export const AGENT_SEMANTIC_ROLLOUT_FEATURES = Object.freeze([
  ...ROLLOUT_FLAGS,
  'AGENT_TELEMETRY_V2',
])

const rolloutFeatures = new Set(AGENT_SEMANTIC_ROLLOUT_FEATURES)
/** @type {Set<string>} */
const eventNames = new Set(Object.values(AGENT_SEMANTIC_EVENT_NAMES))
const contextTriggers = new Set(['pre_step', 'overflow', 'manual'])
const runPhases = new Set(['submission', 'retry', 'execution', 'cancellation'])
const runOutcomes = new Set([
  'created', 'reused', 'submitted', 'deferred', 'queued', 'started', 'succeeded',
  'failed', 'cancelled', 'lease_lost', 'fenced', 'discarded',
])
const runStatuses = new Set(['queued', 'running', 'cancelling', 'cancelled', 'succeeded', 'failed', 'missing'])
const rolloutDecisions = new Set(['enabled', 'disabled'])
const rolloutCohorts = new Set(['control', 'treatment', 'shadow', 'killed'])
const rolloutModes = new Set(['off', 'all', 'scoped'])
const shadowOutcomes = new Set(['would_compact', 'no_change', 'failed'])
const compactionOutcomes = new Set(['compacted', 'reused', 'no_change', 'cas_conflict', 'failed'])
const overflowOutcomes = new Set(['recovered', 'failed', 'not_retried'])
const usageAnchorOutcomes = new Set(['persisted', 'reused', 'cas_conflict', 'not_found', 'failed'])
/** Harness 控制面事件（H7）。label 只有低基数枚举与安全 code,不含用户文本/URL/Skill ID/参数。 */
const harnessKinds = new Set(['tool', 'skill', 'cancel', 'recovery', 'provider', 'loop'])
const harnessOutcomes = new Set([
  'started', 'succeeded', 'failed', 'aborted', 'unknown',
  'repair', 'loop_stop', 'final_synthesis',
  'requested', 'loaded', 'rejected', 'snapshot_mismatch',
  'cancel_observed', 'started_after_cancel', 'completed_after_cancel',
  'reused', 'reexecuted', 'duplicate_dispatch',
  'retry', 'call_timeout', 'deadline_exceeded', 'resume_limit',
])

const ID_LIMIT = 200
const ERROR_CODE_LIMIT = 120
const MAX_COUNT = 10_000_000
const MAX_TOKEN_COUNT = 2_000_000_000
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1_000
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u
const SAFE_ERROR_CODE = /^[A-Z0-9][A-Z0-9._:-]*$/u
const W3C_TRACE_ID = /^[0-9a-f]{32}$/u
const W3C_SPAN_ID = /^[0-9a-f]{16}$/u

function invalid(name) {
  throw new TypeError(`${name}无效。`)
}

function inputObject(value) {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Agent semantic event input')
  return value
}

function enumValue(value, allowed, name) {
  if (typeof value !== 'string' || !allowed.has(value)) invalid(name)
  return value
}

function optionalEnum(value, allowed, name) {
  return value === undefined ? undefined : enumValue(value, allowed, name)
}

function identifier(value, name) {
  if (typeof value !== 'string' || !value || value.length > ID_LIMIT || !SAFE_ID.test(value)) invalid(name)
  return value
}

function optionalIdentifier(value, name) {
  return value === undefined ? undefined : identifier(value, name)
}

function boundedInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) invalid(name)
  return value
}

function optionalInteger(value, name, maximum) {
  return value === undefined ? undefined : boundedInteger(value, name, maximum)
}

function optionalBoolean(value, name) {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') invalid(name)
  return value
}

function occurredAt(value) {
  const candidate = value ?? new Date().toISOString()
  if (typeof candidate !== 'string') invalid('Agent semantic event occurredAt')
  const parsed = Date.parse(candidate)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== candidate) {
    invalid('Agent semantic event occurredAt')
  }
  return candidate
}

function safeError(value) {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Agent semantic event error')
  const code = value.code
  if (typeof code !== 'string' || !code || code.length > ERROR_CODE_LIMIT || !SAFE_ERROR_CODE.test(code)) {
    invalid('Agent semantic event error code')
  }
  const retryable = optionalBoolean(value.retryable, 'Agent semantic event error retryable')
  // message、stack、cause、Provider body 等即使出现在输入里也不会被投影。
  return { code, ...(retryable === undefined ? {} : { retryable }) }
}

function addTraceCorrelation(target, source) {
  const traceId = source.traceId
  const spanId = source.spanId
  if ((traceId === undefined) !== (spanId === undefined)) invalid('Agent semantic event trace correlation')
  if (traceId !== undefined) {
    const normalizedTraceId = typeof traceId === 'string' ? traceId.toLowerCase() : ''
    const normalizedSpanId = typeof spanId === 'string' ? spanId.toLowerCase() : ''
    if (!W3C_TRACE_ID.test(normalizedTraceId) || /^0+$/u.test(normalizedTraceId)
      || !W3C_SPAN_ID.test(normalizedSpanId) || /^0+$/u.test(normalizedSpanId)) {
      invalid('Agent semantic event trace correlation')
    }
    target.traceId = normalizedTraceId
    target.spanId = normalizedSpanId
  }
  const traceFlags = optionalInteger(source.traceFlags, 'Agent semantic event traceFlags', 255)
  if (traceFlags !== undefined) {
    if (traceId === undefined) invalid('Agent semantic event traceFlags')
    target.traceFlags = traceFlags
  }
}

function addOptionalIdentifiers(target, source, names) {
  for (const name of names) {
    const value = optionalIdentifier(source[name], `Agent semantic event ${name}`)
    if (value !== undefined) target[name] = value
  }
}

function addOptionalInteger(target, source, name, maximum) {
  const value = optionalInteger(source[name], `Agent semantic event ${name}`, maximum)
  if (value !== undefined) target[name] = value
}

function addOptionalBoolean(target, source, name) {
  const value = optionalBoolean(source[name], `Agent semantic event ${name}`)
  if (value !== undefined) target[name] = value
}

function addError(target, source) {
  const error = safeError(source.error)
  if (error) target.error = error
}

function addContextIdentity(target, source) {
  addOptionalIdentifiers(target, source, ['projectId', 'sessionId', 'turnId'])
}

function addTokenDelta(target, source) {
  addOptionalInteger(target, source, 'inputTokensBefore', MAX_TOKEN_COUNT)
  addOptionalInteger(target, source, 'inputTokensAfter', MAX_TOKEN_COUNT)
  if (target.inputTokensBefore !== undefined && target.inputTokensAfter !== undefined
    && target.inputTokensAfter > target.inputTokensBefore) {
    invalid('Agent semantic event token delta')
  }
}

function runLifecycleEvent(target, source) {
  target.phase = enumValue(source.phase, runPhases, 'Agent semantic run phase')
  target.outcome = enumValue(source.outcome, runOutcomes, 'Agent semantic run outcome')
  const status = optionalEnum(source.status, runStatuses, 'Agent semantic run status')
  if (status !== undefined) target.status = status
  addOptionalIdentifiers(target, source, ['requestId', 'projectId', 'turnId', 'runId', 'branchId', 'jobId'])
  addOptionalInteger(target, source, 'durationMs', MAX_DURATION_MS)
  addOptionalInteger(target, source, 'queueDurationMs', MAX_DURATION_MS)
  addOptionalInteger(target, source, 'activeJobCount', MAX_COUNT)
  addOptionalInteger(target, source, 'outputCount', MAX_COUNT)
  addOptionalBoolean(target, source, 'projectWritebackPending')
  addError(target, source)
}

function rolloutEvaluatedEvent(target, source) {
  target.feature = enumValue(source.feature, rolloutFeatures, 'Agent semantic rollout feature')
  target.decision = enumValue(source.decision, rolloutDecisions, 'Agent semantic rollout decision')
  target.cohort = enumValue(source.cohort, rolloutCohorts, 'Agent semantic rollout cohort')
  const mode = optionalEnum(source.mode, rolloutModes, 'Agent semantic rollout mode')
  if (mode !== undefined) target.mode = mode
  // Rollout 白名单里的用户/项目选择器不得进入事件。关联只依赖 W3C Trace。
}

function contextShadowEvent(target, source) {
  target.outcome = enumValue(source.outcome, shadowOutcomes, 'Agent semantic context shadow outcome')
  target.trigger = enumValue(source.trigger, contextTriggers, 'Agent semantic context trigger')
  addContextIdentity(target, source)
  // Shadow 是 legacy control 与 V2 candidate 的横向对比，不是一次压缩前后。
  // candidate 变大是必须保留的风险信号，不能套用 after <= before 的约束。
  addOptionalInteger(target, source, 'controlInputTokens', MAX_TOKEN_COUNT)
  addOptionalInteger(target, source, 'candidateInputTokens', MAX_TOKEN_COUNT)
  addOptionalInteger(target, source, 'durationMs', MAX_DURATION_MS)
  addError(target, source)
}

function contextCompactionEvent(target, source) {
  target.outcome = enumValue(source.outcome, compactionOutcomes, 'Agent semantic compaction outcome')
  target.trigger = enumValue(source.trigger, contextTriggers, 'Agent semantic context trigger')
  addContextIdentity(target, source)
  addOptionalIdentifiers(target, source, ['compactionId'])
  addTokenDelta(target, source)
  addOptionalInteger(target, source, 'replacedMessageCount', MAX_COUNT)
  addOptionalInteger(target, source, 'durationMs', MAX_DURATION_MS)
  addError(target, source)
}

function contextOverflowEvent(target, source) {
  target.outcome = enumValue(source.outcome, overflowOutcomes, 'Agent semantic overflow outcome')
  addContextIdentity(target, source)
  addOptionalInteger(target, source, 'retryCount', 2)
  addOptionalInteger(target, source, 'durationMs', MAX_DURATION_MS)
  addError(target, source)
}

function harnessLifecycleEvent(target, source) {
  target.kind = enumValue(source.kind, harnessKinds, 'Agent semantic harness kind')
  target.outcome = enumValue(source.outcome, harnessOutcomes, 'Agent semantic harness outcome')
  addContextIdentity(target, source)
  // reason 复用 error code 词法:稳定大写枚举,禁止用户文本。
  if (source.reason !== undefined) {
    if (typeof source.reason !== 'string' || !SAFE_ERROR_CODE.test(source.reason) || source.reason.length > ERROR_CODE_LIMIT) {
      invalid('Agent semantic harness reason')
    }
    target.reason = source.reason
  }
  addOptionalInteger(target, source, 'step', 64)
  addOptionalInteger(target, source, 'durationMs', MAX_DURATION_MS)
  addOptionalInteger(target, source, 'generation', 16)
  addError(target, source)
}

function contextUsageAnchorEvent(target, source) {
  target.outcome = enumValue(source.outcome, usageAnchorOutcomes, 'Agent semantic usage anchor outcome')
  addContextIdentity(target, source)
  addOptionalInteger(target, source, 'inputTokens', MAX_TOKEN_COUNT)
  addOptionalInteger(target, source, 'outputTokens', MAX_TOKEN_COUNT)
  addOptionalInteger(target, source, 'totalTokens', MAX_TOKEN_COUNT)
  addOptionalInteger(target, source, 'heuristicInputTokens', MAX_TOKEN_COUNT)
  if (target.totalTokens !== undefined && target.inputTokens !== undefined
    && target.totalTokens < target.inputTokens + (target.outputTokens ?? 0)) {
    invalid('Agent semantic usage anchor totalTokens')
  }
  addOptionalInteger(target, source, 'durationMs', MAX_DURATION_MS)
  addError(target, source)
}

/**
 * 将调用方输入投影为固定、安全的语义事件。未知字段一律丢弃；未知事件名、枚举或
 * 越界数值则拒绝，防止“看似有数据”实际污染指标口径。
 *
 * @param {string} name
 * @param {Record<string, any>} [input]
 * @param {string} [timestamp]
 */
export function createAgentSemanticEvent(name, input, timestamp) {
  if (!eventNames.has(name)) invalid('Agent semantic event name')
  const source = inputObject(input)
  const target = {
    schema: AGENT_SEMANTIC_EVENT_SCHEMA,
    schemaVersion: AGENT_SEMANTIC_EVENT_SCHEMA_VERSION,
    event: name,
    occurredAt: occurredAt(timestamp),
  }
  addTraceCorrelation(target, source)
  switch (name) {
    case AGENT_SEMANTIC_EVENT_NAMES.RUN_LIFECYCLE:
      runLifecycleEvent(target, source)
      break
    case AGENT_SEMANTIC_EVENT_NAMES.ROLLOUT_EVALUATED:
      rolloutEvaluatedEvent(target, source)
      break
    case AGENT_SEMANTIC_EVENT_NAMES.CONTEXT_SHADOW_EVALUATED:
      contextShadowEvent(target, source)
      break
    case AGENT_SEMANTIC_EVENT_NAMES.CONTEXT_COMPACTION_RESULT:
      contextCompactionEvent(target, source)
      break
    case AGENT_SEMANTIC_EVENT_NAMES.CONTEXT_OVERFLOW_RESULT:
      contextOverflowEvent(target, source)
      break
    case AGENT_SEMANTIC_EVENT_NAMES.CONTEXT_USAGE_ANCHOR_RESULT:
      contextUsageAnchorEvent(target, source)
      break
    case AGENT_SEMANTIC_EVENT_NAMES.HARNESS_LIFECYCLE:
      harnessLifecycleEvent(target, source)
      break
    default:
      invalid('Agent semantic event name')
  }
  return Object.freeze(target)
}

/**
 * 语义日志是旁路：schema 输入错误、JSON 序列化失败或 logger 故障都不得改变业务。
 * 成功时返回事件便于测试/组合，失败时返回 undefined。
 *
 * @param {string} name
 * @param {Record<string, any>} [input]
 * @param {{ log: (line:string) => unknown }} [logger]
 * @param {string} [timestamp]
 */
export function writeAgentSemanticEvent(name, input, logger = console, timestamp) {
  try {
    const event = createAgentSemanticEvent(name, input, timestamp)
    logger.log(JSON.stringify(event))
    return event
  } catch {
    return undefined
  }
}
