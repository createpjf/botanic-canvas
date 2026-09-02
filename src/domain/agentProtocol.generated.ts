// 本文件由 scripts/generateAgentProtocol.mjs 生成,不要手改。
// source of truth: server/agentProtocol.mjs;npm run build 前会做 --check。

export const AGENT_PROTOCOL_VERSION = 1

export type AgentTurnPublicStatus = 'queued' | 'running' | 'waiting_user' | 'cancelling' | 'completed' | 'failed' | 'cancelled'
export const AGENT_TURN_PUBLIC_STATUS_VALUES = Object.freeze(['queued', 'running', 'waiting_user', 'cancelling', 'completed', 'failed', 'cancelled']) as readonly AgentTurnPublicStatus[]
const AgentTurnPublicStatusSet: ReadonlySet<string> = new Set(AGENT_TURN_PUBLIC_STATUS_VALUES)
export function isAgentTurnPublicStatus(value: unknown): value is AgentTurnPublicStatus {
  return typeof value === 'string' && AgentTurnPublicStatusSet.has(value)
}

export type AgentStreamEventType = 'attempt' | 'accepted' | 'handoff' | 'reasoning' | 'answer' | 'answer_snapshot' | 'tool' | 'done' | 'error'
export const AGENT_STREAM_EVENT_TYPE_VALUES = Object.freeze(['attempt', 'accepted', 'handoff', 'reasoning', 'answer', 'answer_snapshot', 'tool', 'done', 'error']) as readonly AgentStreamEventType[]
const AgentStreamEventTypeSet: ReadonlySet<string> = new Set(AGENT_STREAM_EVENT_TYPE_VALUES)
export function isAgentStreamEventType(value: unknown): value is AgentStreamEventType {
  return typeof value === 'string' && AgentStreamEventTypeSet.has(value)
}

export type AgentToolCallPublicStatus = 'pending' | 'running' | 'awaiting_confirmation' | 'succeeded' | 'failed' | 'aborted'
export const AGENT_TOOL_CALL_PUBLIC_STATUS_VALUES = Object.freeze(['pending', 'running', 'awaiting_confirmation', 'succeeded', 'failed', 'aborted']) as readonly AgentToolCallPublicStatus[]
const AgentToolCallPublicStatusSet: ReadonlySet<string> = new Set(AGENT_TOOL_CALL_PUBLIC_STATUS_VALUES)
export function isAgentToolCallPublicStatus(value: unknown): value is AgentToolCallPublicStatus {
  return typeof value === 'string' && AgentToolCallPublicStatusSet.has(value)
}

export type AgentToolCallPublicRisk = 'read' | 'write' | 'costly' | 'external'
export const AGENT_TOOL_CALL_PUBLIC_RISK_VALUES = Object.freeze(['read', 'write', 'costly', 'external']) as readonly AgentToolCallPublicRisk[]
const AgentToolCallPublicRiskSet: ReadonlySet<string> = new Set(AGENT_TOOL_CALL_PUBLIC_RISK_VALUES)
export function isAgentToolCallPublicRisk(value: unknown): value is AgentToolCallPublicRisk {
  return typeof value === 'string' && AgentToolCallPublicRiskSet.has(value)
}

export type AgentPublicErrorCode = 'INVALID_REQUEST' | 'INVALID_IDEMPOTENCY_KEY' | 'AGENT_TURN_INTENT_CONFLICT' | 'AGENT_THREAD_CONTEXT_REQUIRED' | 'AGENT_TURN_PREPARATION_FAILED' | 'AGENT_TURN_CANCELLED' | 'AGENT_TURN_FAILED' | 'AGENT_TURN_RESULT_MISSING' | 'AGENT_TURN_NOT_REPLAYABLE' | 'AGENT_TURN_DEADLINE_EXCEEDED' | 'AGENT_TURN_RESUME_LIMIT_REACHED' | 'AGENT_TURN_DURABILITY_UNAVAILABLE' | 'AGENT_PROTOCOL_VERSION_UNSUPPORTED' | 'REQUEST_CANCELLED' | 'TOOL_LOOP_LIMIT_REACHED' | 'TOOL_NO_PROGRESS' | 'TOOL_CALL_LIMIT_REACHED' | 'AGENT_TOOL_OUTCOME_UNKNOWN' | 'AGENT_TOOL_DUPLICATE_DISPATCH' | 'AGENT_SKILL_BINDING_UNKNOWN' | 'AGENT_SKILL_BINDING_DEPENDENCY' | 'AGENT_SKILL_BINDING_LIMIT' | 'AGENT_SKILL_DEPENDENCY_CONFLICT' | 'AGENT_SKILL_DEPENDENCY_LIMIT' | 'AGENT_SKILL_CONTEXT_TOO_LARGE' | 'AGENT_SKILL_SNAPSHOT_MISMATCH' | 'PROVIDER_NOT_CONFIGURED' | 'PROVIDER_TIMEOUT' | 'PROVIDER_AUTH_FAILED' | 'PROVIDER_RATE_LIMITED' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_REJECTED' | 'INVALID_PROVIDER_RESPONSE' | 'AGENT_CONTEXT_OVERFLOW'
export const AGENT_PUBLIC_ERROR_CODE_VALUES = Object.freeze(['INVALID_REQUEST', 'INVALID_IDEMPOTENCY_KEY', 'AGENT_TURN_INTENT_CONFLICT', 'AGENT_THREAD_CONTEXT_REQUIRED', 'AGENT_TURN_PREPARATION_FAILED', 'AGENT_TURN_CANCELLED', 'AGENT_TURN_FAILED', 'AGENT_TURN_RESULT_MISSING', 'AGENT_TURN_NOT_REPLAYABLE', 'AGENT_TURN_DEADLINE_EXCEEDED', 'AGENT_TURN_RESUME_LIMIT_REACHED', 'AGENT_TURN_DURABILITY_UNAVAILABLE', 'AGENT_PROTOCOL_VERSION_UNSUPPORTED', 'REQUEST_CANCELLED', 'TOOL_LOOP_LIMIT_REACHED', 'TOOL_NO_PROGRESS', 'TOOL_CALL_LIMIT_REACHED', 'AGENT_TOOL_OUTCOME_UNKNOWN', 'AGENT_TOOL_DUPLICATE_DISPATCH', 'AGENT_SKILL_BINDING_UNKNOWN', 'AGENT_SKILL_BINDING_DEPENDENCY', 'AGENT_SKILL_BINDING_LIMIT', 'AGENT_SKILL_DEPENDENCY_CONFLICT', 'AGENT_SKILL_DEPENDENCY_LIMIT', 'AGENT_SKILL_CONTEXT_TOO_LARGE', 'AGENT_SKILL_SNAPSHOT_MISMATCH', 'PROVIDER_NOT_CONFIGURED', 'PROVIDER_TIMEOUT', 'PROVIDER_AUTH_FAILED', 'PROVIDER_RATE_LIMITED', 'PROVIDER_UNAVAILABLE', 'PROVIDER_REJECTED', 'INVALID_PROVIDER_RESPONSE', 'AGENT_CONTEXT_OVERFLOW']) as readonly AgentPublicErrorCode[]
const AgentPublicErrorCodeSet: ReadonlySet<string> = new Set(AGENT_PUBLIC_ERROR_CODE_VALUES)
export function isAgentPublicErrorCode(value: unknown): value is AgentPublicErrorCode {
  return typeof value === 'string' && AgentPublicErrorCodeSet.has(value)
}

export type AgentTurnTerminalStatus = 'completed' | 'failed' | 'cancelled'
export const AGENT_TURN_TERMINAL_STATUS_VALUES = Object.freeze(['completed', 'failed', 'cancelled']) as readonly AgentTurnTerminalStatus[]
const AgentTurnTerminalStatusSet: ReadonlySet<string> = new Set(AGENT_TURN_TERMINAL_STATUS_VALUES)
export function isAgentTurnTerminalStatus(value: unknown): value is AgentTurnTerminalStatus {
  return typeof value === 'string' && AgentTurnTerminalStatusSet.has(value)
}
