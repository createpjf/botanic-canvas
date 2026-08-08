import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { AgentToolRuntimeError } from './agentToolRuntime.mjs'

const permissions = Object.freeze({
  generation_submit: 'create-generation',
  workflow_create: 'modify-workflow',
  skill_apply: 'modify-workflow',
  skill_create: 'modify-workflow',
  mcp_call: 'execute-external-tool',
})

const safeAuditDetailKeys = new Set([
  'result', 'runId', 'branchId', 'jobId', 'toolCallId', 'toolName', 'risk',
  'status', 'errorCode', 'failureStage', 'retryCount', 'durationMs', 'model', 'batchCount',
])

export const actionApprovalTtlMs = 15 * 60_000

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
  }
  return value
}

export function actionArgumentsHash(argumentsValue) {
  return createHash('sha256').update(JSON.stringify(canonicalize(argumentsValue ?? {}))).digest('base64url')
}

function sign(payload, secret) {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function decode(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
}

/**
 * 审批必须由服务端针对已持久化的行动提案签发，客户端时间戳本身不是授权凭据。
 * Token 绑定用户、项目、工具调用、参数摘要和幂等键，避免把确认重放到另一项行动。
 */
export function createActionApprovalToken({ secret, userId, projectId, actionName, toolCallId, argumentsValue, idempotencyKey, now = Date.now(), ttlMs = actionApprovalTtlMs }) {
  if (!secret || !userId || !projectId || !actionName || !toolCallId || !idempotencyKey) throw new TypeError('Agent 审批签发参数不完整。')
  const payload = {
    v: 1,
    userId,
    projectId,
    actionName,
    toolCallId,
    idempotencyKey,
    argumentsHash: actionArgumentsHash(argumentsValue),
    issuedAt: now,
    expiresAt: now + ttlMs,
  }
  const encoded = encode(payload)
  return { token: `${encoded}.${sign(encoded, secret)}`, approvedAt: payload.issuedAt, expiresAt: payload.expiresAt }
}

export function agentToolPermission(name) {
  return permissions[name] ?? 'edit'
}

export function assertFreshActionApproval(body, {
  secret,
  userId,
  projectId,
  actionName,
  toolCallId,
  argumentsValue,
  idempotencyKey,
  now = Date.now(),
}) {
  const approval = body?.approval
  if (body?.confirmed !== true || !approval || typeof approval !== 'object' || typeof approval.token !== 'string') {
    throw new AgentToolRuntimeError('ACTION_APPROVAL_REQUIRED', '该行动需要明确审批。', 409)
  }
  if (!secret || !userId || !actionName || !idempotencyKey) {
    throw new AgentToolRuntimeError('ACTION_APPROVAL_UNAVAILABLE', '当前行动审批服务尚未配置，请稍后重试。', 503)
  }
  const [encoded, signature] = approval.token.split('.')
  let payload
  try { payload = decode(encoded) } catch { payload = undefined }
  const expected = encoded ? sign(encoded, secret) : ''
  const validSignature = Boolean(signature && expected && signature.length === expected.length
    && timingSafeEqual(Buffer.from(signature), Buffer.from(expected)))
  if (!payload || !validSignature) {
    throw new AgentToolRuntimeError('ACTION_APPROVAL_INVALID', '审批凭据无效，请重新确认。', 409)
  }
  if (payload.v !== 1 || payload.userId !== userId || payload.projectId !== projectId
    || payload.actionName !== actionName || payload.toolCallId !== toolCallId
    || payload.idempotencyKey !== idempotencyKey || payload.argumentsHash !== actionArgumentsHash(argumentsValue)) {
    throw new AgentToolRuntimeError('ACTION_APPROVAL_SCOPE_MISMATCH', '审批与当前项目、行动或参数不匹配。', 409)
  }
  if (!Number.isFinite(payload.issuedAt) || !Number.isFinite(payload.expiresAt)
    || payload.issuedAt > now + 30_000 || payload.expiresAt < now
    || payload.expiresAt - payload.issuedAt > actionApprovalTtlMs) {
    throw new AgentToolRuntimeError('ACTION_APPROVAL_EXPIRED', '审批已失效，请重新确认。', 409)
  }
  return { projectId, actionName, toolCallId, approvedAt: payload.issuedAt, expiresAt: payload.expiresAt }
}

export function sanitizeAuditEvent(event) {
  const detail = {}
  for (const [key, value] of Object.entries(event?.detail ?? {})) {
    if (safeAuditDetailKeys.has(key) && ['string', 'number', 'boolean'].includes(typeof value)) detail[key] = value
  }
  return {
    id: event?.id,
    actorId: event?.actorId,
    action: event?.action,
    projectId: event?.projectId,
    targetId: event?.targetId,
    createdAt: event?.createdAt,
    detail,
  }
}

export function filterAuditEvents(events, { action, actorId, result } = {}) {
  return (events ?? [])
    .filter((event) => !action || event.action === action)
    .filter((event) => !actorId || event.actorId === actorId)
    .filter((event) => !result || event.detail?.result === result)
    .map(sanitizeAuditEvent)
}
