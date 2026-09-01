// @ts-check
/**
 * Agent Protocol v1(升级计划 CS2):跨传输 seam 的公共协议单一来源。
 *
 * 这里只声明**最危险的跨端枚举**——public Turn status/error、SSE 事件类型、
 * ToolCall public status/risk、错误码目录。服务端 builder 与浏览器 parser 都从
 * 同一 catalog 派生;前端类型由 scripts/generateAgentProtocol.mjs 生成,
 * `--check` 在 build 前验证生成物无漂移。
 *
 * 约束:
 * - 只描述 public projection;checkpoint 私有字段、reasoning、Provider body 不进协议。
 * - additive 演进:v1 内只能加枚举值/可选字段,破坏性变更必须升 protocolVersion。
 * - REST/SSE 传输形状不变;本层不是新的 RPC。
 */

export const AGENT_PROTOCOL_VERSION = 1

/** durable Turn 的公开状态机(与 productStoreContract 状态集一致)。 */
export const AGENT_TURN_PUBLIC_STATUSES = Object.freeze([
  'queued', 'running', 'waiting_user', 'cancelling', 'completed', 'failed', 'cancelled',
])

/** 实时通道事件类型(chat/turn/plan 共用)。 */
export const AGENT_STREAM_EVENT_TYPES = Object.freeze([
  'attempt', 'accepted', 'handoff', 'reasoning', 'answer', 'tool', 'done', 'error',
])

/** 工具调用公开状态(含 H4 的 aborted)。 */
export const AGENT_TOOL_CALL_PUBLIC_STATUSES = Object.freeze([
  'pending', 'running', 'awaiting_confirmation', 'succeeded', 'failed', 'aborted',
])

export const AGENT_TOOL_CALL_PUBLIC_RISKS = Object.freeze(['read', 'write', 'costly', 'external'])

/**
 * 稳定错误码目录:客户端可依赖的具名错误。服务端新增错误码必须先登记,
 * 前端 i18n/恢复策略按同一目录判断,不再各自维护第二份清单。
 */
export const AGENT_PUBLIC_ERROR_CODES = Object.freeze([
  // 请求与幂等
  'INVALID_REQUEST', 'INVALID_IDEMPOTENCY_KEY', 'AGENT_TURN_INTENT_CONFLICT',
  'AGENT_THREAD_CONTEXT_REQUIRED', 'AGENT_TURN_PREPARATION_FAILED',
  // 生命周期与恢复
  'AGENT_TURN_CANCELLED', 'AGENT_TURN_FAILED', 'AGENT_TURN_RESULT_MISSING',
  'AGENT_TURN_NOT_REPLAYABLE', 'AGENT_TURN_DEADLINE_EXCEEDED', 'AGENT_TURN_RESUME_LIMIT_REACHED',
  'AGENT_TURN_DURABILITY_UNAVAILABLE', 'AGENT_PROTOCOL_VERSION_UNSUPPORTED', 'REQUEST_CANCELLED',
  // 工具与循环
  'TOOL_LOOP_LIMIT_REACHED', 'TOOL_NO_PROGRESS', 'TOOL_CALL_LIMIT_REACHED',
  'AGENT_TOOL_OUTCOME_UNKNOWN', 'AGENT_TOOL_DUPLICATE_DISPATCH',
  // Skill 绑定
  'AGENT_SKILL_BINDING_UNKNOWN', 'AGENT_SKILL_BINDING_DEPENDENCY', 'AGENT_SKILL_BINDING_LIMIT',
  'AGENT_SKILL_DEPENDENCY_CONFLICT', 'AGENT_SKILL_DEPENDENCY_LIMIT',
  'AGENT_SKILL_CONTEXT_TOO_LARGE', 'AGENT_SKILL_SNAPSHOT_MISMATCH',
  // Provider(1A 统一后的具名传输错误)
  'PROVIDER_NOT_CONFIGURED', 'PROVIDER_TIMEOUT', 'PROVIDER_AUTH_FAILED',
  'PROVIDER_RATE_LIMITED', 'PROVIDER_UNAVAILABLE', 'PROVIDER_REJECTED',
  'INVALID_PROVIDER_RESPONSE', 'AGENT_CONTEXT_OVERFLOW',
])

/** 终态集合;observer 结算与 UI 归档共用。 */
export const AGENT_TURN_TERMINAL_STATUSES = Object.freeze(['completed', 'failed', 'cancelled'])

const turnStatusSet = new Set(AGENT_TURN_PUBLIC_STATUSES)
const streamEventTypeSet = new Set(AGENT_STREAM_EVENT_TYPES)
const toolStatusSet = new Set(AGENT_TOOL_CALL_PUBLIC_STATUSES)
const toolRiskSet = new Set(AGENT_TOOL_CALL_PUBLIC_RISKS)
const errorCodeSet = new Set(AGENT_PUBLIC_ERROR_CODES)

export function isAgentTurnPublicStatus(value) {
  return typeof value === 'string' && turnStatusSet.has(value)
}

export function isAgentStreamEventType(value) {
  return typeof value === 'string' && streamEventTypeSet.has(value)
}

export function isAgentToolCallPublicStatus(value) {
  return typeof value === 'string' && toolStatusSet.has(value)
}

export function isAgentToolCallPublicRisk(value) {
  return typeof value === 'string' && toolRiskSet.has(value)
}

export function isAgentPublicErrorCode(value) {
  return typeof value === 'string' && errorCodeSet.has(value)
}

/**
 * 生成器消费的完整 catalog。JSON Schema 与前端类型都从它派生,
 * 保证三种产物(运行时 guard、schema 文档、TS 类型)不会分头演进。
 */
export function agentProtocolCatalog() {
  return Object.freeze({
    protocolVersion: AGENT_PROTOCOL_VERSION,
    enums: Object.freeze({
      AgentTurnPublicStatus: AGENT_TURN_PUBLIC_STATUSES,
      AgentStreamEventType: AGENT_STREAM_EVENT_TYPES,
      AgentToolCallPublicStatus: AGENT_TOOL_CALL_PUBLIC_STATUSES,
      AgentToolCallPublicRisk: AGENT_TOOL_CALL_PUBLIC_RISKS,
      AgentPublicErrorCode: AGENT_PUBLIC_ERROR_CODES,
      AgentTurnTerminalStatus: AGENT_TURN_TERMINAL_STATUSES,
    }),
  })
}
