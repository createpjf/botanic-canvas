// @ts-check

import {
  AGENT_REVIEW_OUTCOME_UNKNOWN,
  agentReviewPreparedCheckpoint,
} from './agentReviewExecution.mjs'
import { createAgentReviewResult } from './agentReviewTask.mjs'

export const AGENT_REVIEW_RECONCILIATION_ACTIONS = Object.freeze([
  'continue_unverifiable',
  'retry_once',
])

export const AGENT_REVIEW_RETRY_RISK_CODE = 'AGENT_REVIEW_RETRY_MAY_DUPLICATE_PROVIDER_CALL'

const actionSet = new Set(AGENT_REVIEW_RECONCILIATION_ACTIONS)

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function observedAt(input) {
  return Number(input?.observedAt) || Date.now()
}

function boundedText(value, maxLength) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return normalized && normalized.length <= maxLength ? normalized : undefined
}

function identityMatches(task, command) {
  return task?.id === command?.id && task?.projectId === command?.projectId
}

function safeCheckpoint(task) {
  if (!task?.execution?.checkpoint) return undefined
  try {
    return agentReviewPreparedCheckpoint(task.execution.checkpoint)
  } catch {
    return undefined
  }
}

function priorResultSummary(task) {
  return (task?.results ?? []).slice(0, 120).flatMap((result) => {
    const id = boundedText(result?.id, 200)
    const artifactId = boundedText(result?.artifactId, 240)
    if (!id || !artifactId || result?.taskId !== task.id || result?.projectId !== task.projectId) return []
    return [{
      id,
      artifactId,
      ...(boundedText(result?.verdict, 40) ? { verdict: result.verdict.trim() } : {}),
    }]
  })
}

function validResolutionRecord(record) {
  return Boolean(
    record
    && boundedText(record.idempotencyKey, 200)
    && actionSet.has(record.action)
    && boundedText(record.actorId, 160)
    && Number.isFinite(Number(record.resolvedAt))
    && Number(record.resolvedAt) > 0
    && record.prior?.errorCode === AGENT_REVIEW_OUTCOME_UNKNOWN
    && Number.isInteger(Number(record.prior?.executionGeneration))
    && Number(record.prior.executionGeneration) > 0
    && Array.isArray(record.prior?.results),
  )
}

function normalizedReconciliation(value) {
  if (value === undefined) return { version: 1, retryCount: 0, resolutions: [] }
  if (!value || value.version !== 1 || !Array.isArray(value.resolutions)
    || value.resolutions.length > 4 || value.resolutions.some((record) => !validResolutionRecord(record))) {
    return undefined
  }
  const keys = value.resolutions.map((record) => record.idempotencyKey)
  const retryCount = value.resolutions.filter((record) => record.action === 'retry_once').length
  if (new Set(keys).size !== keys.length || !Number.isInteger(Number(value.retryCount))
    || Number(value.retryCount) !== retryCount || retryCount > 1) {
    return undefined
  }
  return clone(value)
}

function priorSnapshot(task) {
  const checkpoint = safeCheckpoint(task)
  return {
    status: task.status,
    errorCode: task.error.code,
    executionGeneration: Math.max(
      Number(task.executionVersion) || 0,
      Number(task.execution?.generation) || 0,
    ),
    checkpointState: task.execution?.checkpoint
      ? checkpoint ? 'prepared' : 'invalid'
      : 'missing',
    ...(checkpoint ? { checkpointArtifactId: checkpoint.artifactId } : {}),
    results: priorResultSummary(task),
  }
}

function settledExecution(task, at) {
  if (!task.execution) return undefined
  const execution = {
    ...task.execution,
    settledAt: Number(task.execution.settledAt) || at,
  }
  delete execution.checkpoint
  return execution
}

function sameResolution(record, command) {
  return record.action === command.action && record.actorId === command.actorId
}

/**
 * 对 `failed + AGENT_REVIEW_OUTCOME_UNKNOWN` 的唯一人工调和状态机。
 *
 * - continue_unverifiable：只写一份明确标注 `human_resolution` 的 unverifiable
 *   ReviewResult；本函数纯计算，不调用 Provider。若还有未评候选则重新排队。
 * - retry_once：保留已落库结果，记录重复调用/重复计费风险后只允许再排队一次。
 * - 同一幂等键只能绑定同一 action/actor；损坏历史、非法来源或第二次 retry 均
 *   fail closed。
 */
export function agentReviewOutcomeReconciliationDecision(existing, command) {
  if (!existing) return { kind: 'missing', task: undefined, changed: false }
  const stored = clone(existing)
  if (!identityMatches(stored, command)) {
    return { kind: 'conflict', task: stored, changed: false }
  }

  const idempotencyKey = boundedText(command?.idempotencyKey, 200)
  const action = actionSet.has(command?.action) ? command.action : undefined
  const actorId = boundedText(command?.actorId, 160)
  if (!idempotencyKey || !action || !actorId) {
    return { kind: 'conflict', task: stored, changed: false }
  }
  const history = normalizedReconciliation(stored.reconciliation)
  if (!history) return { kind: 'conflict', task: stored, changed: false }

  const priorResolution = history.resolutions.find((record) => record.idempotencyKey === idempotencyKey)
  if (priorResolution) {
    return {
      kind: sameResolution(priorResolution, { action, actorId }) ? 'replay' : 'conflict',
      task: stored,
      changed: false,
    }
  }
  if (stored.status !== 'failed' || stored.error?.code !== AGENT_REVIEW_OUTCOME_UNKNOWN) {
    return { kind: 'not_reconcilable', task: stored, changed: false }
  }

  const prior = priorSnapshot(stored)
  if (!prior.executionGeneration) {
    return { kind: 'conflict', task: stored, changed: false }
  }
  if (action === 'retry_once' && history.retryCount >= 1) {
    return { kind: 'retry_limit', task: stored, changed: false }
  }

  const at = observedAt(command)
  const resolution = {
    idempotencyKey,
    action,
    actorId,
    resolvedAt: at,
    prior,
    ...(action === 'retry_once' ? {
      risk: {
        code: AGENT_REVIEW_RETRY_RISK_CODE,
        acknowledged: true,
        message: '此前 Provider 是否执行成功未知；再次调用可能产生重复评审或重复计费。',
      },
    } : {}),
  }
  const reconciliation = {
    version: 1,
    retryCount: history.retryCount + (action === 'retry_once' ? 1 : 0),
    resolutions: [...history.resolutions, resolution],
  }

  if (action === 'retry_once') {
    const execution = settledExecution(stored, at)
    const task = {
      ...stored,
      status: 'queued',
      reconciliation,
      updatedAt: Math.max(Number(stored.updatedAt) || 0, at),
      ...(execution ? { execution } : {}),
    }
    delete task.error
    return { kind: 'resolved', task, changed: true }
  }

  const checkpoint = safeCheckpoint(stored)
  const artifactIds = stored.coverage?.artifactIds
  if (!checkpoint || !Array.isArray(artifactIds)
    || !artifactIds.includes(checkpoint.artifactId)
    || (stored.results ?? []).some((result) => result?.artifactId === checkpoint.artifactId)) {
    return { kind: 'conflict', task: stored, changed: false }
  }
  const humanResolution = {
    kind: 'human_resolution',
    action: 'continue_unverifiable',
    reasonCode: AGENT_REVIEW_OUTCOME_UNKNOWN,
    resolvedBy: actorId,
    resolvedAt: at,
  }
  const result = {
    ...createAgentReviewResult({
      taskId: stored.id,
      projectId: stored.projectId,
      artifactId: checkpoint.artifactId,
      qualityPolicyFingerprint: stored.qualityPolicyFingerprint,
      criteria: [{
        id: 'provider_outcome',
        layer: 'human',
        verdict: 'unverifiable',
        evidence: 'Provider 调用结果未知；人工选择不重复调用，并保留为无法验证。',
      }],
      verdict: 'unverifiable',
      now: at,
    }),
    source: 'human_resolution',
    resolution: humanResolution,
  }
  const results = [...(stored.results ?? []), result]
  const completedArtifactIds = new Set(results.filter((item) => (
    item?.taskId === stored.id && item?.projectId === stored.projectId
  )).map((item) => item.artifactId))
  const status = artifactIds.every((artifactId) => completedArtifactIds.has(artifactId))
    ? 'completed'
    : 'queued'
  const execution = settledExecution(stored, at)
  const task = {
    ...stored,
    status,
    results,
    reconciliation,
    updatedAt: Math.max(Number(stored.updatedAt) || 0, at),
    ...(execution ? { execution } : {}),
  }
  delete task.error
  return { kind: 'resolved', task, changed: true }
}
