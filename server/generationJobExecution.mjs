// @ts-check

import { idempotencyRequestBindingWriteDecision } from './idempotencyRequestBinding.mjs'

const terminalStatuses = new Set(['succeeded', 'failed', 'cancelled'])
const allStatuses = new Set(['queued', 'running', ...terminalStatuses])

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function observedAt(input) {
  return Number(input?.observedAt) || Date.now()
}

function executionGeneration(job) {
  return Math.max(
    0,
    Number(job?.executionVersion) || 0,
    Number(job?.execution?.generation) || 0,
  )
}

function identityMatches(existing, id, projectId) {
  return existing?.id === id && existing?.projectId === projectId
}

const generationRequestFields = [
  'id', 'ownerId', 'projectId', 'createdAt', 'kind', 'refinementMode', 'batchCount',
  'settings', 'provider', 'rawInput', 'idempotencyKey', 'agentRun', 'idempotencyBinding',
]

/**
 * 绑定建立后，普通 put / Worker commit / 通用 CAS 只能推进执行态；请求快照仍以首次
 * 持久化实体为准。旧 writer 即使省略 binding，或复用看见的 binding，也不能改 payload。
 */
function stickyGenerationRequest(existing, incoming) {
  const candidate = clone(incoming)
  if (!existing?.idempotencyBinding) return candidate
  for (const field of generationRequestFields) {
    if (Object.hasOwn(existing, field)) candidate[field] = clone(existing[field])
    else delete candidate[field]
  }
  return candidate
}

/** Worker 对已存在 queued/running Job 的原子执行权判定。 */
export function generationJobExecutionClaimDecision(existing, incoming) {
  if (!existing) return { kind: 'missing', job: undefined, changed: false }
  const stored = clone(existing)
  const leaseToken = typeof incoming?.leaseToken === 'string' ? incoming.leaseToken.trim() : ''
  if (!leaseToken) return { kind: 'conflict', job: stored, changed: false }
  if (terminalStatuses.has(stored.status)) return { kind: 'terminal', job: stored, changed: false }
  if (!['queued', 'running'].includes(stored.status)) return { kind: 'conflict', job: stored, changed: false }

  const at = observedAt(incoming)
  const leaseDurationMs = Math.max(30_000, Math.min(Number(incoming.leaseDurationMs) || 120_000, 900_000))
  if (stored.status === 'running') {
    if (stored.execution?.leaseToken === leaseToken) return { kind: 'claimed', job: stored, changed: false }
    if (Number(stored.execution?.leaseExpiresAt) > at) return { kind: 'in_progress', job: stored, changed: false }
    if (incoming.allowTakeover !== true) return { kind: 'stale', job: stored, changed: false }
  }

  const generation = executionGeneration(stored) + 1
  const job = {
    ...stored,
    status: 'running',
    updatedAt: at,
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
  delete job.error
  delete job.errorCode
  return { kind: 'claimed', job, changed: true }
}

/** 当前 generation + leaseToken 持有者的 heartbeat/progress/terminal fenced commit。 */
export function committedGenerationJobExecution(existing, command) {
  if (!existing) return { kind: 'missing', job: undefined, changed: false }
  const stored = clone(existing)
  if (!identityMatches(stored, command?.id, command?.projectId)) {
    return { kind: 'conflict', job: stored, changed: false }
  }
  const generation = Number(command?.executionGeneration)
  const sameLease = stored.execution?.leaseToken === command?.leaseToken
    && Number(stored.execution?.generation) === generation
    && executionGeneration(stored) === generation
  if (!sameLease) return { kind: 'stale', job: stored, changed: false }

  // 用户可见状态已经是 cancelled 时，Provider 仍可能忽略 AbortSignal。只有原
  // signal/generation/lease 持有者能证明自己仍未退出并续租，避免 DB clock 提前
  // 把仍在执行的 Provider 当成 lease_expired。
  if (stored.status === 'cancelled') {
    if (stored.cancel?.signalRequired === true
      && stored.cancel?.workerReleased !== true
      && command?.status === 'running'
      && !command?.signalId) {
      return { kind: 'cancellation_required', job: stored, changed: false }
    }
    if (stored.cancel?.signalRequired !== true
      || stored.cancel?.workerReleased === true
      || command?.status !== 'cancelled'
      || !command?.signalId
      || command.signalId !== stored.cancel.signalId) {
      return { kind: 'stale', job: stored, changed: false }
    }
    const at = observedAt(command)
    const job = {
      ...stored,
      updatedAt: at,
      executionVersion: generation,
      execution: {
        ...stored.execution,
        generation,
        leaseToken: command.leaseToken,
        leaseExpiresAt: at + Math.max(30_000, Number(stored.execution?.leaseDurationMs) || 120_000),
        lastHeartbeatAt: at,
      },
      cancel: { ...stored.cancel, lastHeartbeatAt: at },
    }
    return { kind: 'cancellation_heartbeat', job, changed: true }
  }

  const status = command?.status
  if (!['running', 'succeeded', 'failed'].includes(status)) {
    return { kind: 'conflict', job: stored, changed: false }
  }
  if (stored.status === 'cancelled') return { kind: 'stale', job: stored, changed: false }
  if (terminalStatuses.has(stored.status) && stored.status !== status) {
    return { kind: 'stale', job: stored, changed: false }
  }
  if (!['running', status].includes(stored.status)) return { kind: 'stale', job: stored, changed: false }
  if (command.job && (!identityMatches(command.job, stored.id, stored.projectId)
    || command.job.ownerId !== stored.ownerId
    || command.job.status !== status)) {
    return { kind: 'conflict', job: stored, changed: false }
  }

  const at = observedAt(command)
  const requested = command.job ? clone(command.job) : stored
  const bindingDecision = idempotencyRequestBindingWriteDecision(stored, requested)
  if (bindingDecision.kind === 'conflict') return { kind: 'conflict', job: stored, changed: false }
  const candidate = stickyGenerationRequest(stored, requested)
  const job = {
    ...candidate,
    id: stored.id,
    ownerId: stored.ownerId,
    projectId: stored.projectId,
    createdAt: stored.createdAt,
    idempotencyKey: stored.idempotencyKey,
    ...(bindingDecision.binding ? { idempotencyBinding: clone(bindingDecision.binding) } : {}),
    status,
    updatedAt: at,
    executionVersion: generation,
    execution: status === 'running'
      ? {
          ...stored.execution,
          generation,
          leaseToken: command.leaseToken,
          leaseExpiresAt: at + Math.max(30_000, Number(stored.execution?.leaseDurationMs) || 120_000),
          lastHeartbeatAt: at,
        }
      : {
          ...stored.execution,
          generation,
          leaseToken: command.leaseToken,
          settledAt: Number(stored.execution?.settledAt) || at,
        },
  }
  return { kind: 'committed', job, changed: true }
}

/**
 * 非 Worker 状态转换的通用 CAS：提交响应失败、HTTP 超时、显式 terminal retry。
 * `expectedExecutionGeneration: null` 是有意义的 —— 它要求 Job 尚未被 claim。
 */
export function comparedAndSetGenerationJob(existing, command) {
  if (!existing) return { kind: 'missing', job: undefined, changed: false }
  const stored = clone(existing)
  if (!identityMatches(stored, command?.id, command?.projectId)) {
    return { kind: 'conflict', job: stored, changed: false }
  }
  const currentGeneration = stored.execution ? Number(stored.execution.generation) : null
  if (stored.status !== command?.expectedStatus
    || currentGeneration !== command?.expectedExecutionGeneration) {
    return { kind: 'stale', job: stored, changed: false }
  }
  const next = command?.job
  if (!next || !identityMatches(next, stored.id, stored.projectId)
    || next.ownerId !== stored.ownerId || !allStatuses.has(next.status)) {
    return { kind: 'conflict', job: stored, changed: false }
  }
  const allowed = (stored.status === next.status)
    || (stored.status === 'queued' && next.status === 'failed')
    || (stored.status === 'running' && next.status === 'failed')
    || (['failed', 'cancelled'].includes(stored.status) && next.status === 'queued' && command.clearExecution === true)
  if (!allowed) return { kind: 'conflict', job: stored, changed: false }

  const at = observedAt(command)
  const version = executionGeneration(stored)
  const bindingDecision = idempotencyRequestBindingWriteDecision(stored, next)
  if (bindingDecision.kind === 'conflict') return { kind: 'conflict', job: stored, changed: false }
  const job = {
    ...stickyGenerationRequest(stored, next),
    id: stored.id,
    ownerId: stored.ownerId,
    projectId: stored.projectId,
    createdAt: stored.createdAt,
    idempotencyKey: stored.idempotencyKey,
    ...(bindingDecision.binding ? { idempotencyBinding: clone(bindingDecision.binding) } : {}),
    updatedAt: at,
    ...(version ? { executionVersion: version } : {}),
  }
  if (!version) delete job.executionVersion
  if (command.clearExecution === true) {
    delete job.execution
  } else if (stored.execution) {
    job.execution = terminalStatuses.has(job.status)
      ? { ...stored.execution, settledAt: Number(stored.execution.settledAt) || at }
      : clone(stored.execution)
  } else {
    // CAS 可保留 Store 已有 capability 或显式清理它，但 command.job 从不拥有
    // 铸造新 lease 的权限。
    delete job.execution
  }
  return { kind: 'updated', job, changed: true }
}

/** 显式取消在同一行锁内选择 queued/running 后果，并压过旧 Worker 的所有后续 commit。 */
export function requestedGenerationJobCancellation(existing, command) {
  if (!existing) return { kind: 'missing', job: undefined, changed: false }
  const stored = clone(existing)
  if (!identityMatches(stored, command?.id, command?.projectId)) {
    return { kind: 'conflict', job: stored, changed: false }
  }
  if (terminalStatuses.has(stored.status)) return { kind: 'replay', job: stored, changed: false }
  if (!['queued', 'running'].includes(stored.status)) return { kind: 'conflict', job: stored, changed: false }
  const outcome = command?.outcomes?.[stored.status]
  if (!outcome || !['none', 'possible'].includes(outcome.billing)
    || typeof outcome.capability !== 'string' || typeof outcome.code !== 'string') {
    return { kind: 'conflict', job: stored, changed: false }
  }
  const at = observedAt(command)
  const requestedAt = Number(command.requestedAt) || at
  const signalRequired = stored.status === 'running'
  const workerReleaseExpected = Boolean(outcome.workerReleased)
  const signalId = signalRequired
    ? `generation-cancel:${stored.id}:${executionGeneration(stored)}:${requestedAt}`
    : undefined
  const job = {
    ...stored,
    status: 'cancelled',
    updatedAt: at,
    cancel: {
      requestedAt,
      reason: command.reason,
      ...(command.requestedBy ? { requestedBy: command.requestedBy } : {}),
      billing: outcome.billing,
      capability: outcome.capability,
      ...(workerReleaseExpected ? { workerReleaseExpected: true } : {}),
      // `generationCancelOutcome` 只描述能力；实际 Worker 是否释放必须由持有本地
      // AbortController 的实例 durable ack，Redis publish 成功不等于已送达。
      workerReleased: signalRequired ? false : workerReleaseExpected,
      code: outcome.code,
      ...(signalRequired ? { signalRequired: true, signalId } : {}),
    },
    ...(stored.execution ? {
      executionVersion: executionGeneration(stored),
      execution: signalRequired
        ? { ...stored.execution }
        : { ...stored.execution, settledAt: at },
    } : {}),
  }
  delete job.error
  delete job.errorCode
  return { kind: 'cancelled', priorStatus: stored.status, job, changed: true }
}

/** Provider/heartbeat 已退出且本地句柄已释放后，原子确认该 generation 不再执行。 */
export function acknowledgedGenerationJobCancellation(existing, command) {
  if (!existing) return { kind: 'missing', job: undefined, changed: false }
  const stored = clone(existing)
  if (!identityMatches(stored, command?.id, command?.projectId)) {
    return { kind: 'conflict', job: stored, changed: false }
  }
  if (stored.status !== 'cancelled' || stored.cancel?.signalRequired !== true) {
    return { kind: 'replay', job: stored, changed: false }
  }
  if (!command?.signalId || command.signalId !== stored.cancel.signalId) {
    return { kind: 'stale', job: stored, changed: false }
  }
  const generation = executionGeneration(stored)
  if (!Number.isInteger(Number(command.executionGeneration))
    || Number(command.executionGeneration) !== generation) {
    return { kind: 'stale', job: stored, changed: false }
  }
  const releaseBasis = command.releaseBasis
  if (!['worker_exit', 'lease_expired'].includes(releaseBasis)) {
    return { kind: 'conflict', job: stored, changed: false }
  }
  if (releaseBasis === 'worker_exit'
    && (!command?.leaseToken || command.leaseToken !== stored.execution?.leaseToken)) {
    return { kind: 'stale', job: stored, changed: false }
  }
  if (Number(stored.cancel.signalAcknowledgedAt) > 0) {
    return { kind: 'replay', job: stored, changed: false }
  }
  const at = observedAt(command)
  if (releaseBasis === 'lease_expired'
    && (!Number(stored.execution?.leaseExpiresAt)
      || Number(stored.execution.leaseExpiresAt) > at)) {
    return { kind: 'pending', job: stored, changed: false }
  }
  const job = {
    ...stored,
    updatedAt: at,
    ...(stored.execution ? {
      execution: {
        ...stored.execution,
        settledAt: Number(stored.execution.settledAt) || at,
      },
    } : {}),
    cancel: {
      ...stored.cancel,
      workerReleased: true,
      signalAcknowledgedAt: at,
      releaseBasis,
    },
  }
  return { kind: 'acknowledged', job, changed: true }
}

/** 普通 put 只能创建/维护 legacy Job，不能越过已建立的 execution fence。 */
export function generationJobPutDecision(existing, incoming, input = {}) {
  const at = observedAt(input)
  // 普通 put 的调用方从来不拥有 Worker fence；insert 与 legacy update 必须
  // 共用同一净化入口，避免先写 legacy Job 再用 update 铸造 generation 水位。
  const candidate = { ...clone(incoming) }
  delete candidate.execution
  delete candidate.executionVersion
  if (!existing) {
    return { kind: 'inserted', job: { ...candidate, updatedAt: at }, changed: true }
  }
  const stored = clone(existing)
  if (!identityMatches(stored, candidate.id, candidate.projectId) || stored.ownerId !== candidate.ownerId) {
    return { kind: 'conflict', job: stored, changed: false }
  }
  const bindingDecision = idempotencyRequestBindingWriteDecision(stored, candidate)
  if (bindingDecision.kind === 'conflict') return { kind: 'conflict', job: stored, changed: false }
  if (bindingDecision.binding) candidate.idempotencyBinding = clone(bindingDecision.binding)
  if (stored.execution || executionGeneration(stored) > 0) {
    return { kind: 'fenced', job: stored, changed: false }
  }
  if (terminalStatuses.has(stored.status) && stored.status !== candidate.status) {
    return { kind: 'fenced', job: stored, changed: false }
  }
  return {
    kind: 'updated',
    job: { ...stickyGenerationRequest(stored, candidate), updatedAt: at },
    changed: true,
  }
}
