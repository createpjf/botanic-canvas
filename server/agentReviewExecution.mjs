// @ts-check

import { isDeepStrictEqual } from 'node:util'

export const AGENT_REVIEW_OUTCOME_UNKNOWN = 'AGENT_REVIEW_OUTCOME_UNKNOWN'

const terminalStatuses = new Set(['completed', 'failed', 'cancelled'])

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function observedAt(input) {
  return Number(input?.observedAt) || Date.now()
}

function executionGeneration(task) {
  return Math.max(
    0,
    Number(task?.executionVersion) || 0,
    Number(task?.execution?.generation) || 0,
  )
}

function identityMatches(task, id, projectId) {
  return task?.id === id && task?.projectId === projectId
}

function hasResult(task, artifactId) {
  return (task?.results ?? []).some((result) => (
    result?.taskId === task?.id && result?.artifactId === artifactId
  ))
}

function sameValue(left, right) {
  return isDeepStrictEqual(left, right)
}

function boundedText(value, maxLength) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return normalized && normalized.length <= maxLength ? normalized : undefined
}

function cancellationIdentityMatches(cancel, command) {
  return cancel?.idempotencyKey === command?.idempotencyKey
    && cancel?.signalId === command?.signalId
    && cancel?.requestedBy === command?.requestedBy
    && (cancel?.reason ?? '') === (command?.reason ?? '')
}

function humanDecisionIdentity(value) {
  if (!value) return undefined
  const identity = clone(value)
  delete identity.decidedAt
  delete identity.decisionRevision
  return identity
}

function validHumanDecision(task, actorId, decision) {
  const candidateStatus = {
    accepted: 'accepted',
    rejected: 'rejected',
    retry_requested: 'pending_review',
  }[decision?.decision]
  return Boolean(
    decision
    && typeof decision.id === 'string' && decision.id.trim()
    && decision.taskId === task.id
    && decision.projectId === task.projectId
    && typeof decision.artifactId === 'string' && decision.artifactId.trim()
    && (task.coverage?.artifactIds ?? []).includes(decision.artifactId)
    && decision.decidedBy === actorId
    && candidateStatus && decision.candidateStatus === candidateStatus
    && typeof decision.idempotencyKey === 'string' && decision.idempotencyKey.trim()
    && typeof decision.decidedAt === 'number'
    && Number.isFinite(decision.decidedAt) && decision.decidedAt > 0
    && (decision.note === undefined || (typeof decision.note === 'string' && decision.note.length <= 500))
    && (task.results ?? []).some((result) => (
      result?.taskId === task.id && result?.artifactId === decision.artifactId
    )),
  )
}

/**
 * completed ReviewTask 上的人工决定原子合并。调用方只提交 decision command；
 * candidateStatus/updatedAt 始终从权威自动 result 与首次 durable decision 派生。
 */
export function agentReviewHumanDecisionCommitDecision(existing, command) {
  if (!existing) return { kind: 'missing', task: undefined, changed: false }
  const stored = clone(existing)
  if (!identityMatches(stored, command?.id, command?.projectId)) {
    return { kind: 'conflict', task: stored, changed: false }
  }
  if (stored.status !== 'completed') {
    return { kind: 'not_ready', task: stored, changed: false }
  }
  const actorId = typeof command?.actorId === 'string' ? command.actorId.trim() : ''
  const requested = Array.isArray(command?.decisions) ? command.decisions.map(clone) : []
  if (!actorId || !requested.length || requested.length > 60
    || requested.some((decision) => !validHumanDecision(stored, actorId, decision))) {
    return { kind: 'conflict', task: stored, changed: false }
  }
  if (new Set(requested.map((decision) => decision.id)).size !== requested.length
    || new Set(requested.map((decision) => decision.artifactId)).size !== requested.length) {
    return { kind: 'conflict', task: stored, changed: false }
  }

  const existingById = new Map()
  for (const decision of stored.decisions ?? []) {
    if (!decision?.id) continue
    const prior = existingById.get(decision.id)
    if (prior && !sameValue(humanDecisionIdentity(prior), humanDecisionIdentity(decision))) {
      return { kind: 'conflict', task: stored, changed: false }
    }
    if (!prior) existingById.set(decision.id, decision)
  }

  const accepted = []
  let changed = false
  let decisionVersion = Math.max(
    Number(stored.decisionVersion) || 0,
    (stored.decisions ?? []).length,
    ...(stored.decisions ?? []).map((decision) => Number(decision?.decisionRevision) || 0),
  )
  let lastDecidedAt = Math.max(
    0,
    ...(stored.decisions ?? []).map((decision) => Number(decision?.decidedAt) || 0),
  )
  const at = observedAt(command)
  for (const decision of requested) {
    const prior = existingById.get(decision.id)
    if (prior) {
      if (!sameValue(humanDecisionIdentity(prior), humanDecisionIdentity(decision))) {
        return { kind: 'conflict', task: stored, changed: false }
      }
      accepted.push(prior)
      continue
    }
    changed = true
    decisionVersion += 1
    lastDecidedAt = Math.max(lastDecidedAt + 1, at)
    const authoritative = {
      ...decision,
      decisionRevision: decisionVersion,
      decidedAt: lastDecidedAt,
    }
    existingById.set(authoritative.id, authoritative)
    accepted.push(authoritative)
  }
  if (!changed) return { kind: 'replay', task: stored, changed: false }

  const decisions = [...(stored.decisions ?? []), ...accepted.filter((decision) => (
    !(stored.decisions ?? []).some((prior) => prior?.id === decision.id)
  ))]
  const byArtifactId = new Map(accepted.map((decision) => [decision.artifactId, decision]))
  const results = (stored.results ?? []).map((result) => {
    const decision = byArtifactId.get(result?.artifactId)
    return decision ? {
      ...result,
      candidateStatus: decision.candidateStatus,
      humanDecisionId: decision.id,
      updatedAt: decision.decidedAt,
    } : result
  })
  return {
    kind: 'committed',
    changed: true,
    task: {
      ...stored,
      decisions,
      results,
      decisionVersion,
      updatedAt: Math.max(Number(stored.updatedAt) || 0, at),
    },
  }
}

/**
 * 普通 ProductStore put 只负责建立尚未执行的 ReviewTask。它不持有 Worker
 * capability，因此无权铸造 lease，也不能在执行开始后改写 status/checkpoint/result。
 */
export function agentReviewTaskPutDecision(existing, incoming, input = {}) {
  const at = observedAt(input)
  const candidate = clone(incoming)
  if (!candidate || typeof candidate.id !== 'string' || typeof candidate.projectId !== 'string'
    || typeof candidate.ownerId !== 'string' || typeof candidate.runId !== 'string') {
    return { kind: 'conflict', task: existing ? clone(existing) : undefined, changed: false }
  }

  delete candidate.execution
  delete candidate.executionVersion
  delete candidate.error
  candidate.status = 'queued'
  candidate.attempt = 0
  candidate.results = []
  if (!existing) {
    return { kind: 'inserted', task: { ...candidate, updatedAt: at }, changed: true }
  }

  const stored = clone(existing)
  if (!identityMatches(stored, candidate.id, candidate.projectId)
    || stored.ownerId !== candidate.ownerId || stored.runId !== candidate.runId) {
    return { kind: 'conflict', task: stored, changed: false }
  }
  if (stored.execution || executionGeneration(stored) > 0
    || terminalStatuses.has(stored.status) || (stored.results ?? []).length > 0) {
    return { kind: 'fenced', task: stored, changed: false }
  }

  // ReviewTask 的 ID 已绑定 Run + quality policy。已存在的未执行任务也按 once-bound
  // 处理，避免旧 writer 用同一个 ID 换 coverage/rubric；重复创建只返回权威快照。
  return { kind: 'replay', task: stored, changed: false }
}

/**
 * 视觉调用前的最小安全 checkpoint。这里只保存候选引用与时间，不允许 Prompt、URL、
 * 媒体或 Provider 原始回包进入恢复记录。
 *
 * @param {{ artifactId: string, preparedAt?: number }} input
 */
export function agentReviewPreparedCheckpoint(input) {
  const { artifactId, preparedAt = Date.now() } = input ?? {}
  const allowedKeys = new Set(['version', 'phase', 'artifactId', 'preparedAt'])
  const normalizedArtifactId = typeof artifactId === 'string' ? artifactId.trim() : ''
  const normalizedPreparedAt = Number(preparedAt)
  if (Object.keys(input ?? {}).some((key) => !allowedKeys.has(key))
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(normalizedArtifactId)
    || !Number.isFinite(normalizedPreparedAt) || normalizedPreparedAt <= 0) {
    throw new TypeError('Agent Review prepared checkpoint 无效。')
  }
  return {
    version: 1,
    phase: 'prepared',
    artifactId: normalizedArtifactId,
    preparedAt: normalizedPreparedAt,
  }
}

function normalizedCheckpoint(value) {
  if (!value || value.version !== 1 || value.phase !== 'prepared') return undefined
  try {
    return agentReviewPreparedCheckpoint(value)
  } catch {
    return undefined
  }
}

/** 对已存在 queued/running ReviewTask 的原子执行权判定。 */
export function agentReviewExecutionClaimDecision(existing, command) {
  if (!existing) return { kind: 'missing', task: undefined, changed: false }
  const stored = clone(existing)
  if (!identityMatches(stored, command?.id, command?.projectId)) {
    return { kind: 'conflict', task: stored, changed: false }
  }
  const leaseToken = typeof command?.leaseToken === 'string' ? command.leaseToken.trim() : ''
  if (!leaseToken) return { kind: 'conflict', task: stored, changed: false }
  if (stored.status === 'completed') return { kind: 'replay', task: stored, changed: false }
  if (stored.status === 'cancelled') return { kind: 'cancelled', task: stored, changed: false }
  if (stored.status === 'cancelling') return { kind: 'cancelling', task: stored, changed: false }
  if (stored.status === 'failed') {
    return {
      kind: stored.error?.code === AGENT_REVIEW_OUTCOME_UNKNOWN ? 'outcome_unknown' : 'terminal',
      task: stored,
      changed: false,
    }
  }
  if (!['queued', 'running'].includes(stored.status)) {
    return { kind: 'conflict', task: stored, changed: false }
  }

  const at = observedAt(command)
  const leaseDurationMs = Math.max(30_000, Math.min(Number(command?.leaseDurationMs) || 120_000, 900_000))
  if (stored.status === 'running') {
    if (stored.execution?.leaseToken === leaseToken) {
      return { kind: 'claimed', task: stored, changed: false }
    }
    if (Number(stored.execution?.leaseExpiresAt) > at) {
      return { kind: 'in_progress', task: stored, changed: false }
    }

    const rawCheckpoint = stored.execution?.checkpoint
    const checkpoint = normalizedCheckpoint(rawCheckpoint)
    if (rawCheckpoint && (!checkpoint || !hasResult(stored, checkpoint.artifactId))) {
      const task = {
        ...stored,
        status: 'failed',
        error: {
          code: AGENT_REVIEW_OUTCOME_UNKNOWN,
          message: '视觉评审可能已调用但结果未确认。为避免重复调用，系统不会自动重试。',
        },
        updatedAt: Math.max(Number(stored.updatedAt) || 0, at),
        execution: {
          ...stored.execution,
          settledAt: Number(stored.execution?.settledAt) || at,
        },
      }
      return { kind: 'outcome_unknown', task, changed: true }
    }
    if (command?.allowTakeover !== true) {
      return { kind: 'stale', task: stored, changed: false }
    }
    // 若旧 checkpoint 已经有同候选的 durable result，它只是一次遗留投影；接管前清掉。
    if (checkpoint) delete stored.execution.checkpoint
  }

  const generation = executionGeneration(stored) + 1
  const task = {
    ...stored,
    status: 'running',
    attempt: Number(stored.attempt ?? 0) + 1,
    updatedAt: Math.max(Number(stored.updatedAt) || 0, at),
    executionVersion: generation,
    execution: {
      generation,
      leaseToken,
      leaseDurationMs,
      leaseExpiresAt: at + leaseDurationMs,
      claimedAt: at,
      lastHeartbeatAt: at,
    },
  }
  delete task.error
  return { kind: 'claimed', task, changed: true }
}

/** 当前 generation + leaseToken 持有者的 heartbeat/prepared/result/terminal fenced commit。 */
export function committedAgentReviewExecution(existing, command) {
  if (!existing) return { kind: 'missing', task: undefined, changed: false }
  const stored = clone(existing)
  if (!identityMatches(stored, command?.id, command?.projectId)) {
    return { kind: 'conflict', task: stored, changed: false }
  }
  const generation = Number(command?.executionGeneration)
  const sameLease = stored.execution?.leaseToken === command?.leaseToken
    && Number(stored.execution?.generation) === generation
    && executionGeneration(stored) === generation
  if (!sameLease) return { kind: 'stale', task: stored, changed: false }

  const status = command?.status
  if (!['running', 'completed', 'failed'].includes(status)) {
    return { kind: 'conflict', task: stored, changed: false }
  }
  if (terminalStatuses.has(stored.status)) {
    return {
      kind: stored.status === status ? 'replay' : 'stale',
      task: stored,
      changed: false,
    }
  }
  if (stored.status !== 'running') return { kind: 'stale', task: stored, changed: false }

  const currentCheckpoint = normalizedCheckpoint(stored.execution?.checkpoint)
  if (stored.execution?.checkpoint && !currentCheckpoint) {
    return { kind: 'conflict', task: stored, changed: false }
  }
  let nextCheckpoint = currentCheckpoint
  if (command?.checkpoint !== undefined && command.checkpoint !== null) {
    const requested = normalizedCheckpoint(command.checkpoint)
    if (!requested || hasResult(stored, requested.artifactId)
      || !(stored.coverage?.artifactIds ?? []).includes(requested.artifactId)
      || (currentCheckpoint && currentCheckpoint.artifactId !== requested.artifactId)) {
      return { kind: 'conflict', task: stored, changed: false }
    }
    nextCheckpoint = requested
  }

  const results = [...(stored.results ?? [])]
  if (command?.result !== undefined) {
    const result = clone(command.result)
    const existingResult = results.find((item) => item?.artifactId === result?.artifactId)
    if (!result || result.taskId !== stored.id || result.projectId !== stored.projectId
      || typeof result.artifactId !== 'string' || !result.artifactId.trim()
      || (!currentCheckpoint && !(existingResult && sameValue(existingResult, result)))
      || (currentCheckpoint && currentCheckpoint.artifactId !== result.artifactId)
      || (currentCheckpoint && command.checkpoint !== null)) {
      return { kind: 'conflict', task: stored, changed: false }
    }
    if (existingResult && !sameValue(existingResult, result)) {
      return { kind: 'conflict', task: stored, changed: false }
    }
    if (!existingResult) results.push(result)
  }
  if (command?.checkpoint === null) {
    // prepared 只能与该候选的 durable result 在同一个 CAS 中清除。
    if (currentCheckpoint && !hasResult({ ...stored, results }, currentCheckpoint.artifactId)) {
      return { kind: 'conflict', task: stored, changed: false }
    }
    nextCheckpoint = undefined
  }

  if (status !== 'running') {
    if (nextCheckpoint) return { kind: 'conflict', task: stored, changed: false }
    if (status === 'completed') {
      const done = new Set(results.filter((item) => item?.taskId === stored.id).map((item) => item.artifactId))
      if ((stored.coverage?.artifactIds ?? []).some((artifactId) => !done.has(artifactId))) {
        return { kind: 'conflict', task: stored, changed: false }
      }
    }
    if (status === 'failed' && typeof command?.error?.code !== 'string') {
      return { kind: 'conflict', task: stored, changed: false }
    }
  }

  const at = observedAt(command)
  const execution = status === 'running'
    ? {
        ...stored.execution,
        generation,
        leaseToken: command.leaseToken,
        leaseExpiresAt: at + Math.max(30_000, Number(stored.execution?.leaseDurationMs) || 120_000),
        lastHeartbeatAt: at,
        ...(nextCheckpoint ? { checkpoint: nextCheckpoint } : {}),
      }
    : {
        ...stored.execution,
        generation,
        leaseToken: command.leaseToken,
        settledAt: Number(stored.execution?.settledAt) || at,
      }
  if (!nextCheckpoint) delete execution.checkpoint

  const task = {
    ...stored,
    status,
    results,
    updatedAt: Math.max(Number(stored.updatedAt) || 0, at),
    executionVersion: generation,
    execution,
    ...(status === 'failed' ? {
      error: {
        code: command.error.code,
        message: String(command.error.message ?? '').slice(0, 500),
      },
    } : {}),
  }
  if (status !== 'failed') delete task.error
  return { kind: 'committed', task, changed: true }
}

/**
 * 显式取消先写 durable fence；HTTP 断开不调用本函数，也不能被解释为取消成功。
 * 尚未执行的 queued 任务没有 Worker，可由同一原子判定直接收为 cancelled；running
 * 任务只进入 cancelling，必须等待实际 Worker 退出或数据库租约过期证明。
 */
export function agentReviewCancellationRequestDecision(existing, command) {
  if (!existing) return { kind: 'missing', task: undefined, changed: false }
  const stored = clone(existing)
  if (!identityMatches(stored, command?.id, command?.projectId)) {
    return { kind: 'conflict', task: stored, changed: false }
  }

  const idempotencyKey = boundedText(command?.idempotencyKey, 200)
  const signalId = boundedText(command?.signalId, 240)
  const requestedBy = boundedText(command?.requestedBy, 160)
  const reason = command?.reason === undefined ? undefined : boundedText(command.reason, 500)
  if (!idempotencyKey || !signalId || !requestedBy
    || (command?.reason !== undefined && !reason)) {
    return { kind: 'conflict', task: stored, changed: false }
  }
  const normalizedCommand = { idempotencyKey, signalId, requestedBy, ...(reason ? { reason } : {}) }

  if (stored.status === 'cancelling' || stored.status === 'cancelled') {
    if (!cancellationIdentityMatches(stored.cancel, normalizedCommand)) {
      return { kind: 'conflict', task: stored, changed: false }
    }
    return {
      kind: stored.status === 'cancelled' ? 'replay' : 'cancelling',
      task: stored,
      changed: false,
    }
  }
  if (terminalStatuses.has(stored.status)) {
    return { kind: 'terminal', task: stored, changed: false }
  }
  if (!['queued', 'running'].includes(stored.status)) {
    return { kind: 'conflict', task: stored, changed: false }
  }

  const at = observedAt(command)
  const generation = executionGeneration(stored)
  const signalRequired = stored.status === 'running'
  if (signalRequired && (!generation || !stored.execution?.leaseToken)) {
    return { kind: 'conflict', task: stored, changed: false }
  }
  const cancel = {
    version: 1,
    idempotencyKey,
    signalId,
    requestedAt: at,
    requestedBy,
    ...(reason ? { reason } : {}),
    executionGeneration: generation,
    signalRequired,
    workerReleased: !signalRequired,
    ...(!signalRequired ? {
      signalAcknowledgedAt: at,
      releaseBasis: 'not_started',
    } : {}),
  }
  const status = signalRequired ? 'cancelling' : 'cancelled'
  const task = {
    ...stored,
    status,
    cancel,
    updatedAt: Math.max(Number(stored.updatedAt) || 0, at),
    ...(stored.execution ? {
      execution: signalRequired
        ? { ...stored.execution }
        : {
            ...stored.execution,
            settledAt: Number(stored.execution.settledAt) || at,
          },
    } : {}),
  }
  delete task.error
  return { kind: status, task, changed: true }
}

/**
 * 只有 generation-fenced 的实际退出证明才能把 running Review 从 cancelling 收口。
 * `worker_exit` 绑定旧 lease capability；Worker 崩溃时只能由数据库时间确认旧租约
 * 已过期后使用 `lease_expired`，发布 cancel signal 或 HTTP 断开都不是退出证明。
 */
export function agentReviewCancellationFinalizeDecision(existing, command) {
  if (!existing) return { kind: 'missing', task: undefined, changed: false }
  const stored = clone(existing)
  if (!identityMatches(stored, command?.id, command?.projectId)) {
    return { kind: 'conflict', task: stored, changed: false }
  }
  const signalId = boundedText(command?.signalId, 240)
  const generation = Number(command?.executionGeneration)
  if (!signalId || !Number.isInteger(generation) || generation < 1) {
    return { kind: 'conflict', task: stored, changed: false }
  }
  if (stored.status === 'cancelled') {
    const sameCancellation = stored.cancel?.signalId === signalId
      && Number(stored.cancel?.executionGeneration) === generation
    return {
      kind: sameCancellation ? 'replay' : 'stale',
      task: stored,
      changed: false,
    }
  }
  if (stored.status !== 'cancelling') {
    return {
      kind: terminalStatuses.has(stored.status) ? 'terminal' : 'stale',
      task: stored,
      changed: false,
    }
  }
  if (stored.cancel?.signalRequired !== true
    || stored.cancel.signalId !== signalId
    || Number(stored.cancel.executionGeneration) !== generation
    || executionGeneration(stored) !== generation) {
    return { kind: 'stale', task: stored, changed: false }
  }

  const proofKind = command?.proof?.kind
  if (!['worker_exit', 'lease_expired'].includes(proofKind)) {
    return { kind: 'conflict', task: stored, changed: false }
  }
  const at = observedAt({ observedAt: command?.proof?.observedAt ?? command?.observedAt })
  if (at < Number(stored.cancel.requestedAt)) {
    return { kind: 'conflict', task: stored, changed: false }
  }
  if (proofKind === 'worker_exit') {
    const leaseToken = boundedText(command?.proof?.leaseToken, 240)
    if (!leaseToken || leaseToken !== stored.execution?.leaseToken) {
      return { kind: 'stale', task: stored, changed: false }
    }
  }
  if (proofKind === 'lease_expired') {
    const leaseExpiresAt = Number(stored.execution?.leaseExpiresAt)
    if (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= 0) {
      return { kind: 'conflict', task: stored, changed: false }
    }
    if (leaseExpiresAt > at) {
      return { kind: 'pending', task: stored, changed: false }
    }
  }

  const task = {
    ...stored,
    status: 'cancelled',
    updatedAt: Math.max(Number(stored.updatedAt) || 0, at),
    cancel: {
      ...stored.cancel,
      workerReleased: true,
      signalAcknowledgedAt: at,
      releaseBasis: proofKind,
    },
    execution: {
      ...stored.execution,
      settledAt: Number(stored.execution?.settledAt) || at,
    },
  }
  delete task.error
  return { kind: 'cancelled', task, changed: true }
}
