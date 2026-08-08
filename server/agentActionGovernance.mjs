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

export function agentToolPermission(name) {
  return permissions[name] ?? 'edit'
}

export function assertFreshActionApproval(body, { projectId, toolCallId, now = Date.now() }) {
  const approval = body?.approval
  if (body?.confirmed !== true || !approval || typeof approval !== 'object') {
    throw new AgentToolRuntimeError('ACTION_APPROVAL_REQUIRED', '该行动需要明确审批。', 409)
  }
  if (approval.projectId !== projectId || approval.toolCallId !== toolCallId) {
    throw new AgentToolRuntimeError('ACTION_APPROVAL_SCOPE_MISMATCH', '审批与当前项目或行动不匹配。', 409)
  }
  if (!Number.isFinite(approval.approvedAt) || !Number.isFinite(approval.expiresAt)
    || approval.approvedAt > now || approval.expiresAt < now || approval.expiresAt - approval.approvedAt > 15 * 60_000) {
    throw new AgentToolRuntimeError('ACTION_APPROVAL_EXPIRED', '审批已失效，请重新确认。', 409)
  }
  return { projectId, toolCallId, approvedAt: approval.approvedAt, expiresAt: approval.expiresAt }
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
