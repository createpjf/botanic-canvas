// @ts-check

import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { agentTurnRequestHash, agentTurnRequestHashVersion, storedAgentTurnRequestBinding } from '../agent/turn/agentTurnRequestIdentity.mjs'
import { agentTurnOutputPreviewCommitDecision, agentTurnOutputPreviewEventPayload } from '../agent/turn/agentTurnOutputPreview.mjs'
import {
  BotanicAgentSkillError,
  agentSkillExecutionContentHash,
  agentSkillVersion,
  validateAgentSkillVersionSnapshot,
} from '../agent/action/botanicAgentSkill.mjs'

/**
 * ProductStore 是项目、Agent、生成任务和审计持久化的服务端 seam。
 * 核心方法必须由每个 Adapter 提供；只在特定部署存在的能力按完整方法组声明，
 * 调用方先检查能力，不能依赖可选链猜测 Adapter 形状。
 */
/**
 * 非终态 Turn。孤儿回收只看这几个状态：终态 Turn 已经结束，不该被重新拾起。
 * 与 `turnReclaim.mjs` 的同名集合保持一致 —— 那边判「怎么处理」，这里定「捞哪些」。
 */
export const nonTerminalAgentTurnStatuses = Object.freeze(['queued', 'running', 'waiting_user', 'cancelling'])

/** 只有这些状态代表执行实例可能失联；waiting_user 由用户输入恢复，不参与孤儿回收。 */
export const reclaimableAgentTurnStatuses = Object.freeze(['queued', 'running', 'cancelling'])

export const canvasGraphConflictCode = 'CANVAS_GRAPH_CONFLICT'
export const canvasMutationConflictCode = 'CANVAS_MUTATION_CONFLICT'
export const canvasSyncEpochStaleCode = 'CANVAS_SYNC_EPOCH_STALE'

export function canvasSyncEpochStaleError(syncProtocolEpoch) {
  const error = /** @type {Error & { code: string; statusCode: number; syncProtocolEpoch?: number }} */ (
    new Error('画布同步协议版本已前进，请重新握手。')
  )
  error.code = canvasSyncEpochStaleCode
  error.statusCode = 409
  if (Number.isInteger(syncProtocolEpoch) && syncProtocolEpoch > 0) error.syncProtocolEpoch = syncProtocolEpoch
  return error
}

/**
 * @param {{ update?: unknown; idempotencyUpdate?: unknown; graph?: unknown; mutationId?: unknown; expectedGraphRevision?: unknown; syncProtocolEpoch?: unknown } | null | undefined} input
 */
export function normalizeCanvasGraphMutation(input) {
  const { update, idempotencyUpdate, graph, mutationId, expectedGraphRevision, syncProtocolEpoch } = input ?? {}
  if (typeof update !== 'string' || !update
    || (idempotencyUpdate !== undefined && (typeof idempotencyUpdate !== 'string' || !idempotencyUpdate))
    || !graph || typeof graph !== 'object'
    || !('nodes' in graph) || !Array.isArray(graph.nodes)
    || !('edges' in graph) || !Array.isArray(graph.edges)) {
    throw new TypeError('画布协作更新格式无效。')
  }
  const payloadHash = createHash('sha256').update(idempotencyUpdate ?? update).digest('base64url')
  const resolvedMutationId = mutationId ?? `legacy:${payloadHash}`
  if (typeof resolvedMutationId !== 'string'
    || !/^[A-Za-z0-9._:-]{1,200}$/.test(resolvedMutationId)) {
    throw new TypeError('画布协作 mutationId 无效。')
  }
  if (expectedGraphRevision !== undefined
    && (!Number.isInteger(expectedGraphRevision) || Number(expectedGraphRevision) < 1)) {
    throw new TypeError('画布协作 expectedGraphRevision 无效。')
  }
  if (syncProtocolEpoch !== undefined
    && (!Number.isInteger(syncProtocolEpoch) || Number(syncProtocolEpoch) < 1)) {
    throw new TypeError('画布协作 syncProtocolEpoch 无效。')
  }
  return {
    update,
    graph,
    mutationId: resolvedMutationId,
    payloadHash,
    expectedGraphRevision: expectedGraphRevision === undefined ? undefined : Number(expectedGraphRevision),
    syncProtocolEpoch: syncProtocolEpoch === undefined ? undefined : Number(syncProtocolEpoch),
  }
}

function completeAgentSkillVersionSnapshot(snapshot) {
  return typeof snapshot?.name === 'string'
    && typeof snapshot?.instructions === 'string'
    && Array.isArray(snapshot?.capabilities)
    && typeof snapshot?.contentHash === 'string'
}

function agentSkillPersistenceError(code, message) {
  throw new BotanicAgentSkillError(409, code, message)
}

function immutableAgentSkillVersionMatches(stored, incoming) {
  if (isDeepStrictEqual(stored, incoming)) return true
  // draft 首次发布不伪造内容相同的新版本；只允许给原本未发布的
  // 完整执行快照一次性补齐批准身份，其他字段仍必须逐字一致。
  if (stored?.publishedBy !== undefined || stored?.publishedAt !== undefined
    || incoming?.publishedBy === undefined || incoming?.publishedAt === undefined) return false
  const withoutPublication = structuredClone(incoming)
  delete withoutPublication.publishedBy
  delete withoutPublication.publishedAt
  return isDeepStrictEqual(stored, withoutPublication)
}

function legacyAgentSkillVersionPrefix(existing, storedVersion) {
  const updatedAt = Number(existing?.updatedAt ?? existing?.createdAt)
  if (!Number.isSafeInteger(storedVersion) || storedVersion < 1
    || typeof existing?.instructions !== 'string'
    || typeof existing?.contentHash !== 'string'
    || !Number.isFinite(updatedAt) || updatedAt < 0) return undefined
  return {
    version: storedVersion,
    instructions: existing.instructions,
    contentHash: existing.contentHash,
    updatedAt,
  }
}

/**
 * 读取历史版本时保留上线前的不完整快照，新完整快照则必须通过 V2 hash 验证。
 */
export function persistedAgentSkillVersion(skill, version) {
  const snapshot = agentSkillVersion(skill, version)
  if (!snapshot) return undefined
  return validateAgentSkillVersionSnapshot(snapshot, {
    allowLegacy: !completeAgentSkillVersionSnapshot(snapshot),
  })
}

/**
 * 三个 Adapter 共用的 Skill 写入决策。
 *
 * 版本与 hash 已由 `botanicAgentSkill` 领域层生成；Store 只验证当前快照、
 * 确认旧 history 是 incoming history 的不可变前缀，然后原样持久化。
 */
export function agentSkillPersistenceDecision(existing, incoming, options) {
  const { ownerId } = options ?? {}
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return agentSkillPersistenceError('INVALID_AGENT_SKILL_VERSION', 'Skill 持久化快照无效。')
  }
  const version = Number(incoming.version)
  const versions = Array.isArray(incoming.versions) ? incoming.versions : []
  if (!Number.isSafeInteger(version) || version < 1 || !versions.length) {
    return agentSkillPersistenceError('INVALID_AGENT_SKILL_VERSION', 'Skill 持久化快照缺少版本历史。')
  }
  let previousVersion = 0
  for (const snapshot of versions) {
    const snapshotVersion = Number(snapshot?.version)
    if (!Number.isSafeInteger(snapshotVersion) || snapshotVersion <= previousVersion) {
      return agentSkillPersistenceError('AGENT_SKILL_HISTORY_CONFLICT', 'Skill 历史版本必须严格递增且不重复。')
    }
    if (completeAgentSkillVersionSnapshot(snapshot)) validateAgentSkillVersionSnapshot(snapshot)
    previousVersion = snapshotVersion
  }
  if (previousVersion !== version) {
    return agentSkillPersistenceError('AGENT_SKILL_HISTORY_CONFLICT', 'Skill 当前版本与历史尾部不一致。')
  }
  const current = persistedAgentSkillVersion(incoming, version)
  if (!current || !completeAgentSkillVersionSnapshot(current)) {
    return agentSkillPersistenceError('INVALID_AGENT_SKILL_VERSION', 'Skill 当前版本必须是完整快照。')
  }
  if (incoming.contentHash !== current.contentHash
    || agentSkillExecutionContentHash(incoming) !== current.contentHash) {
    return agentSkillPersistenceError('AGENT_SKILL_VERSION_HASH_MISMATCH', 'Skill 当前内容与版本快照不一致。')
  }

  const existingVersions = Array.isArray(existing?.versions) ? existing.versions : []
  let sameVersionHistoryBackfill = false
  if (existing) {
    const storedVersion = Number(existing.version)
    if (!Number.isSafeInteger(storedVersion) || version < storedVersion) {
      return agentSkillPersistenceError('AGENT_SKILL_VERSION_STALE', 'Skill 写入版本已过期。')
    }
    if (!existingVersions.length) {
      // 上线前的行只有顶层当前版本。首次 V2 写入只允许两种收敛：
      // 1) 顶层本来已是 V2 hash，同版补一份完整快照；
      // 2) 精确冻结旧顶层为 incomplete legacy 前缀，再追加唯一的新版本。
      const legacyPrefix = legacyAgentSkillVersionPrefix(existing, storedVersion)
      if (version === storedVersion) {
        let existingHash
        try { existingHash = agentSkillExecutionContentHash(existing) } catch { existingHash = undefined }
        if (versions.length !== 1
          || incoming.contentHash !== existing.contentHash
          || existingHash !== existing.contentHash) {
          return agentSkillPersistenceError('AGENT_SKILL_VERSION_CONFLICT', 'Skill 同一版本不得改写执行内容。')
        }
        sameVersionHistoryBackfill = true
      } else if (version === storedVersion + 1) {
        if (versions.length !== 2 || !legacyPrefix || !isDeepStrictEqual(versions[0], legacyPrefix)) {
          return agentSkillPersistenceError('AGENT_SKILL_HISTORY_CONFLICT', 'Skill legacy 版本必须先按原始身份冻结。')
        }
      } else {
        return agentSkillPersistenceError('AGENT_SKILL_HISTORY_CONFLICT', 'Skill 新版本必须在完整历史后追加。')
      }
    } else {
      if (versions.length < existingVersions.length
        || existingVersions.some((snapshot, index) => !immutableAgentSkillVersionMatches(snapshot, versions[index]))) {
        return agentSkillPersistenceError('AGENT_SKILL_HISTORY_CONFLICT', 'Skill 历史版本不得覆盖或截断。')
      }
      if (version === storedVersion) {
        if (incoming.contentHash !== existing.contentHash || versions.length !== existingVersions.length) {
          return agentSkillPersistenceError('AGENT_SKILL_VERSION_CONFLICT', 'Skill 同一版本不得改写执行内容。')
        }
      } else if (version !== storedVersion + 1 || versions.length !== existingVersions.length + 1) {
        return agentSkillPersistenceError('AGENT_SKILL_HISTORY_CONFLICT', 'Skill 新版本必须在完整历史后追加。')
      }
    }
  } else if (version !== 1 || versions.length !== 1) {
    return agentSkillPersistenceError('AGENT_SKILL_HISTORY_CONFLICT', 'Skill 首次写入必须从版本 1 开始。')
  }

  const payload = {
    ...structuredClone(incoming),
    ownerId: existing?.ownerId ?? ownerId ?? incoming.ownerId,
    createdAt: existing?.createdAt ?? incoming.createdAt,
  }
  if (existing && isDeepStrictEqual(existing, payload)) return { kind: 'replay', payload }
  if (existing && version === Number(existing.version)) {
    const storedWithoutHistory = structuredClone(existing)
    const incomingWithoutHistory = structuredClone(payload)
    delete storedWithoutHistory.versions
    delete incomingWithoutHistory.versions
    const historyOnlyBackfill = sameVersionHistoryBackfill
      && isDeepStrictEqual(storedWithoutHistory, incomingWithoutHistory)
    if (!historyOnlyBackfill) {
      const storedUpdatedAt = Number(existing.updatedAt)
      const incomingUpdatedAt = Number(payload.updatedAt)
      if (!Number.isFinite(storedUpdatedAt) || storedUpdatedAt < 0
        || !Number.isFinite(incomingUpdatedAt) || incomingUpdatedAt <= storedUpdatedAt) {
        return agentSkillPersistenceError('AGENT_SKILL_VERSION_STALE', 'Skill 同版本写入已落后于权威状态。')
      }
    }
  }
  return {
    kind: 'write',
    payload,
  }
}

/** Run/Job 全量扫描统一使用 id ASC keyset pagination。 */
export function normalizeAgentEntityIdPage(options = {}) {
  const raw = options ?? {}
  const afterId = typeof raw.afterId === 'string' && raw.afterId.trim() ? raw.afterId.trim() : null
  return { afterId, limit: Math.max(1, Math.min(Number(raw.limit) || 50, 200)) }
}

/**
 * 跨项目周期恢复的稳定 keyset 页。三个 Adapter 必须共用此入口，
 * 否则同一个 `(updatedAt,id)` 游标会因默认页长或非法值处理不同而跳页。
 */
export function normalizeUpdatedAtIdRecoveryPage(options = {}) {
  const raw = options ?? {}
  const updatedAt = Number(raw.after?.updatedAt)
  const id = typeof raw.after?.id === 'string' ? raw.after.id.trim() : ''
  const after = Number.isInteger(updatedAt) && updatedAt >= 0 && id
    ? { updatedAt, id }
    : null
  const requestedLimit = Number(raw.limit) || 25
  return {
    after,
    limit: Math.max(1, Math.min(Math.trunc(requestedLimit), 200)),
  }
}

/** Pending Review 在通用 keyset 之外还有一个权威的截止时间。 */
export function normalizePendingAgentReviewRecoveryPage(options = {}) {
  const raw = options ?? {}
  const page = normalizeUpdatedAtIdRecoveryPage(raw)
  const candidate = Number(raw.olderThan)
  return {
    olderThan: Number.isInteger(candidate) && candidate >= 0 ? candidate : Date.now(),
    ...page,
  }
}

/**
 * Turn 事件分页参数。三个 Adapter 共用同一份规格化，避免各自写一套默认值与上限 ——
 * 那会让「同一个游标在不同 Adapter 上返回不同结果」这种最难查的差异出现。
 *
 * `after` 是 `(turnId, sequence)` 游标：只返回该序号**之后**的事件。缺省为 null
 * 表示从头读。
 */
export function normalizeTurnEventPage(options = {}) {
  const raw = options ?? {}
  const after = Number.isInteger(raw.after) && raw.after >= 0 ? raw.after : null
  return { after, limit: Math.max(1, Math.min(Number(raw.limit) || 200, 500)) }
}

/**
 * 陈旧 Turn 扫描参数。
 *
 * 租约下限 30 秒：比这更短会抢走仍在推进的 Turn —— 一次慢的模型调用就可能超过
 * 几秒不更新 updated_at。默认 2 分钟。
 */
export function normalizeStaleTurnQuery(options = {}) {
  const raw = options ?? {}
  const leaseMs = Math.max(30_000, Number(raw.leaseMs) || 120_000)
  const now = Number.isInteger(raw.now) ? raw.now : Date.now()
  const afterUpdatedAt = Number(raw.after?.updatedAt)
  const afterId = typeof raw.after?.id === 'string' ? raw.after.id.trim() : ''
  const after = Number.isFinite(afterUpdatedAt) && afterUpdatedAt >= 0 && afterId
    ? { updatedAt: afterUpdatedAt, id: afterId }
    : null
  return {
    olderThan: Number.isInteger(raw.olderThan) ? raw.olderThan : now - leaseMs,
    after,
    // 清扫是周期性的，一次只取一小批：单次捞太多会让一个慢批次拖住后续所有清扫。
    limit: Math.max(1, Math.min(Number(raw.limit) || 25, 200)),
  }
}

const terminalAgentTurnStatuses = new Set(['completed', 'failed', 'cancelled'])

/**
 * Agent Turn 的原子执行权判定。Adapter 必须在自己的事务/锁内调用，且把数据库时钟
 * 作为 `observedAt` 传入；调用进程的时钟只能作为 Local Adapter 的实现细节。
 *
 * `generation + leaseToken` 是双重 fencing token：旧实例即使在租约过期后才返回，
 * 也不能覆盖已被新实例接管的 checkpoint 或终态。
 */
export function agentTurnExecutionClaimDecision(existing, incoming) {
  const source = incoming?.turn
  const sourceRequestHash = typeof source?.requestHash === 'string' && source.requestHash.trim()
    ? source.requestHash
    : undefined
  const sourceRequestHashVersion = agentTurnRequestHashVersion(source)
  if (!source || !sourceRequestHash || !sourceRequestHashVersion
    || typeof incoming?.leaseToken !== 'string' || !incoming.leaseToken.trim()) {
    return { kind: 'conflict', turn: existing ? structuredClone(existing) : undefined, changed: false }
  }
  const observedAt = Number(incoming.observedAt) || Date.now()
  const leaseDurationMs = Math.max(30_000, Math.min(Number(incoming.leaseDurationMs) || 120_000, 900_000))
  const claim = (turn, generation) => {
    const claimed = {
      ...structuredClone(turn),
      status: 'running',
      updatedAt: observedAt,
      execution: {
        generation,
        leaseToken: incoming.leaseToken,
        leaseDurationMs,
        leaseExpiresAt: observedAt + leaseDurationMs,
        claimedAt: observedAt,
        lastHeartbeatAt: observedAt,
      },
    }
    delete claimed.error
    return { kind: 'claimed', turn: claimed, changed: true }
  }

  if (!existing) return claim(source, 1)
  let stored = structuredClone(existing)
  if (stored.id !== source.id
    || stored.ownerId !== source.ownerId
    || stored.projectId !== source.projectId
    || stored.idempotencyKey !== source.idempotencyKey) {
    return { kind: 'conflict', turn: stored, changed: false }
  }

  let requestBindingChanged = false
  if (typeof stored.requestHash === 'string' && stored.requestHash.trim()) {
    const storedRequestHashVersion = agentTurnRequestHashVersion(stored)
    if (!storedRequestHashVersion || stored.requestHash !== sourceRequestHash) {
      return { kind: 'conflict', turn: stored, changed: false }
    }
    if (!Object.hasOwn(stored, 'requestHashVersion')) {
      stored.requestHashVersion = storedRequestHashVersion
      requestBindingChanged = true
    }
  } else {
    // 旧 Turn 不得用本次 source.requestHash 盲目回填：先按旧记录的版本规则
    // 从已存 immutable request 派生，再用同一规则比较本次请求。缺快照或
    // 未知版本都 fail closed，避免新 input 借用历史幂等身份首次执行。
    const storedBinding = storedAgentTurnRequestBinding(stored)
    const sourceBinding = storedAgentTurnRequestBinding(source)
    if (!storedBinding || !sourceBinding
      || sourceBinding.requestHash !== sourceRequestHash
      || agentTurnRequestHash(source.request, storedBinding.requestHashVersion) !== storedBinding.requestHash) {
      return { kind: 'conflict', turn: stored, changed: false }
    }
    stored = {
      ...stored,
      requestHash: sourceRequestHash,
      requestHashVersion: sourceRequestHashVersion,
    }
    requestBindingChanged = true
  }

  if (terminalAgentTurnStatuses.has(stored.status)) {
    return { kind: 'replay', turn: stored, changed: requestBindingChanged }
  }
  if (stored.status === 'waiting_user') {
    return { kind: 'waiting_user', turn: stored, changed: requestBindingChanged }
  }
  if (stored.status === 'cancelling') {
    return { kind: 'cancelling', turn: stored, changed: requestBindingChanged }
  }
  if (stored.status === 'queued') {
    return claim(stored, Math.max(0, Number(stored.execution?.generation) || 0) + 1)
  }
  if (stored.status !== 'running') return { kind: 'conflict', turn: stored, changed: false }

  const generation = Math.max(1, Number(stored.execution?.generation) || 1)
  if (stored.execution?.leaseToken === incoming.leaseToken) {
    return { kind: 'claimed', turn: stored, changed: requestBindingChanged }
  }
  if (Number(stored.execution?.leaseExpiresAt) > observedAt) {
    return { kind: 'in_progress', turn: stored, changed: requestBindingChanged }
  }
  if (incoming.allowTakeover !== true) return { kind: 'stale', turn: stored, changed: requestBindingChanged }
  return claim(stored, generation + 1)
}

/**
 * 当前 Turn 执行者的 fenced commit。它既用于 heartbeat/checkpoint，也用于终态；
 * identity 与 execution 字段始终来自已存记录，调用者只能提交状态投影。
 */
export function committedAgentTurnExecution(existing, command) {
  if (!existing) return { kind: 'missing', turn: undefined, changed: false }
  const stored = structuredClone(existing)
  if (stored.id !== command?.id || stored.projectId !== command?.projectId) {
    return { kind: 'conflict', turn: stored, changed: false }
  }
  const sameLease = stored.execution?.leaseToken === command?.leaseToken
    && Number(stored.execution?.generation) === Number(command?.executionGeneration)
  if (!sameLease) return { kind: 'stale', turn: stored, changed: false }

  const requestedStatus = command?.status
  // cancelled 只能由 finalizedAgentTurnCancellation 在深取消传播完成后提交。
  // 执行者即使还持有原 lease，也不能越过 Run / Job 收口直接终态化。
  if (requestedStatus === 'cancelled') {
    return stored.status === 'cancelling'
      ? { kind: 'cancelling', turn: stored, changed: false }
      : { kind: 'conflict', turn: stored, changed: false }
  }
  if (terminalAgentTurnStatuses.has(stored.status)) {
    return stored.status === requestedStatus
      ? { kind: 'replay', turn: stored, changed: false }
      : { kind: 'stale', turn: stored, changed: false }
  }
  if (stored.status === 'waiting_user') {
    return requestedStatus === 'waiting_user'
      ? { kind: 'replay', turn: stored, changed: false }
      : { kind: 'stale', turn: stored, changed: false }
  }
  if (stored.status === 'cancelling') {
    if (stored.cancellation?.signalRequired !== true) {
      return { kind: 'cancelling', turn: stored, changed: false }
    }
    if (!command?.signalId) {
      return { kind: 'cancelling', turn: stored, changed: false }
    }
    if (command.signalId !== stored.cancellation.signalId) {
      return { kind: 'stale', turn: stored, changed: false }
    }
    const observedAt = Number(command.observedAt) || Date.now()
    if (command.releaseBasis === 'worker_exit') {
      if (stored.cancellation.workerReleased === true) {
        return { kind: 'replay', turn: stored, changed: false }
      }
      const turn = {
        ...stored,
        updatedAt: observedAt,
        execution: { ...stored.execution, settledAt: observedAt },
        cancellation: {
          ...stored.cancellation,
          workerReleased: true,
          signalAcknowledgedAt: observedAt,
          releaseBasis: 'worker_exit',
        },
      }
      return { kind: 'cancellation_acknowledged', turn, changed: true }
    }
    if (command.releaseBasis !== undefined || command.status !== 'running'
      || stored.cancellation.workerReleased === true) {
      return { kind: 'stale', turn: stored, changed: false }
    }
    const turn = {
      ...stored,
      updatedAt: observedAt,
      execution: {
        ...stored.execution,
        leaseExpiresAt: observedAt
          + Math.max(30_000, Number(stored.execution?.leaseDurationMs) || 120_000),
        lastHeartbeatAt: observedAt,
      },
      cancellation: { ...stored.cancellation, lastHeartbeatAt: observedAt },
    }
    return { kind: 'cancellation_heartbeat', turn, changed: true }
  }
  if (!['running', 'waiting_user', 'completed', 'failed'].includes(requestedStatus)) {
    return { kind: 'conflict', turn: stored, changed: false }
  }

  const observedAt = Number(command.observedAt) || Date.now()
  const previewRequested = Object.hasOwn(command, 'outputPreview')
  const previewDecision = previewRequested
    ? agentTurnOutputPreviewCommitDecision(stored.outputPreview, command.outputPreview, observedAt)
    : undefined
  if (previewDecision?.kind === 'conflict') return { kind: 'conflict', turn: stored, changed: false }
  if (previewDecision?.kind === 'stale') return { kind: 'stale', turn: stored, changed: false }
  if (previewRequested && (!previewDecision?.preview
    || command.event?.type !== 'turn.output_preview.updated'
    || !isDeepStrictEqual(command.event?.payload, agentTurnOutputPreviewEventPayload(previewDecision.preview)))) {
    return { kind: 'conflict', turn: stored, changed: false }
  }
  if (previewDecision?.kind === 'replay') return { kind: 'replay', turn: stored, changed: false }
  const turn = { ...stored, status: requestedStatus, updatedAt: observedAt }
  if (requestedStatus === 'running') {
    turn.execution = {
      ...stored.execution,
      leaseExpiresAt: observedAt + Math.max(30_000, Number(stored.execution?.leaseDurationMs) || 120_000),
      lastHeartbeatAt: observedAt,
    }
    if (Object.hasOwn(command, 'checkpoint')) turn.checkpoint = structuredClone(command.checkpoint)
    if (previewDecision?.kind === 'committed') turn.outputPreview = previewDecision.preview
    delete turn.result
    delete turn.error
  } else {
    turn.execution = { ...stored.execution, settledAt: observedAt }
    delete turn.outputPreview
    if (requestedStatus === 'completed' || requestedStatus === 'waiting_user') {
      turn.result = structuredClone(command.result)
      delete turn.error
    } else {
      turn.error = structuredClone(command.error)
      delete turn.result
    }
  }
  return { kind: 'committed', turn, changed: true }
}

/**
 * 取消传播完成后的原子收口。它不依赖原执行者的 leaseToken，但只接受已经进入
 * `cancelling` 的 Turn；原 execution 会保留并写 settledAt，让旧执行者的后续 commit
 * 永远只能看到 terminal fence。
 */
export function finalizedAgentTurnCancellation(existing, command) {
  if (!existing) return { kind: 'missing', turn: undefined, changed: false }
  const stored = structuredClone(existing)
  if (stored.id !== command?.id || stored.projectId !== command?.projectId) {
    return { kind: 'conflict', turn: stored, changed: false }
  }
  if (stored.status === 'cancelled') return { kind: 'replay', turn: stored, changed: false }
  if (terminalAgentTurnStatuses.has(stored.status)) return { kind: 'stale', turn: stored, changed: false }
  if (stored.status !== 'cancelling') return { kind: 'conflict', turn: stored, changed: false }
  const observedAt = Number(command.observedAt) || Date.now()
  let cancellation = structuredClone(stored.cancellation) ?? {}
  if (cancellation.signalRequired === true && cancellation.workerReleased !== true) {
    if (!Number(stored.execution?.leaseExpiresAt)
      || Number(stored.execution.leaseExpiresAt) > observedAt) {
      return { kind: 'pending', turn: stored, changed: false }
    }
    cancellation = {
      ...cancellation,
      workerReleased: true,
      signalAcknowledgedAt: observedAt,
      releaseBasis: 'lease_expired',
    }
  }
  const turn = {
    ...stored,
    status: 'cancelled',
    updatedAt: observedAt,
    execution: { ...stored.execution, settledAt: observedAt },
    error: stored.error?.code === 'AGENT_TURN_CANCELLED'
      ? stored.error
      : { code: 'AGENT_TURN_CANCELLED', message: 'Agent 回合已取消。' },
    cancellation: {
      ...cancellation,
      status: 'completed',
      completedAt: observedAt,
    },
  }
  delete turn.result
  delete turn.outputPreview
  return { kind: 'finalized', turn, changed: true }
}

/** 显式取消请求不需要知道当前 leaseToken，但必须在同一 Store 锁内压过 completed。 */
export function requestedAgentTurnCancellation(existing, request) {
  if (!existing) return { kind: 'missing', turn: undefined, changed: false }
  const stored = structuredClone(existing)
  if (stored.id !== request?.id || stored.projectId !== request?.projectId) {
    return { kind: 'conflict', turn: stored, changed: false }
  }
  if (['failed', 'cancelled', 'cancelling'].includes(stored.status)) {
    return { kind: 'replay', turn: stored, changed: false }
  }
  // completed 只代表模型执行已完成；显式取消还要继续撤销它委派出的 Run / Job，
  // 因此允许 completed 再进入 cancelling。claim/commit 的执行终态语义不变。
  if (!['queued', 'running', 'waiting_user', 'completed'].includes(stored.status)) {
    return { kind: 'conflict', turn: stored, changed: false }
  }
  const observedAt = Number(request.observedAt) || Date.now()
  const reason = typeof request.reason === 'string' && request.reason.trim()
    ? request.reason.trim().slice(0, 500)
    : '用户取消了 Agent 回合。'
  const error = { code: 'AGENT_TURN_CANCELLED', message: reason }
  const executionGeneration = Number(stored.execution?.generation)
  const activeExecutor = stored.status === 'running'
    && Number.isInteger(executionGeneration)
    && executionGeneration > 0
    && nonEmptyString(stored.execution?.leaseToken)
    && Number(stored.execution?.leaseExpiresAt) > 0
  const signalId = activeExecutor
    ? `agent-turn-cancel:${stored.id}:${executionGeneration}:${observedAt}`
    : undefined
  const turn = {
    ...stored,
    status: 'cancelling',
    updatedAt: observedAt,
    error,
    cancellation: {
      status: 'requested',
      requestedAt: observedAt,
      reason: 'user',
      ...(activeExecutor ? {
        signalRequired: true,
        signalId,
        executionGeneration,
        workerReleased: false,
      } : {}),
    },
  }
  delete turn.result
  return { kind: 'requested', turn, changed: true }
}

/**
 * Agent Action Receipt 的原子 claim 判定。Local/PostgreSQL Adapter 在各自的锁内共用
 * 这份状态机；Supabase RPC 必须保持同语义。旧回执没有 status，按已成功完成兼容。
 */
export function agentActionReceiptClaimDecision(existing, incoming) {
  if (!existing) {
    const receipt = {
      id: incoming.id,
      ownerId: incoming.ownerId,
      projectId: incoming.projectId,
      toolCallId: incoming.toolCallId,
      actionName: incoming.actionName,
      intentHash: incoming.intentHash,
      ...(nonEmptyString(incoming.actionBindingHash) ? { actionBindingHash: incoming.actionBindingHash.trim() } : {}),
      replayPolicy: incoming.replayPolicy,
      status: 'running',
      leaseToken: incoming.leaseToken,
      leaseDurationMs: incoming.leaseDurationMs,
      leaseExpiresAt: incoming.leaseExpiresAt,
      createdAt: incoming.createdAt,
      updatedAt: incoming.updatedAt,
    }
    return { kind: 'claimed', receipt, changed: true }
  }
  if (existing.intentHash && existing.intentHash !== incoming.intentHash) {
    return { kind: 'conflict', receipt: structuredClone(existing), changed: false }
  }
  const existingBinding = nonEmptyString(existing.actionBindingHash) ? existing.actionBindingHash.trim() : undefined
  const incomingBinding = nonEmptyString(incoming.actionBindingHash) ? incoming.actionBindingHash.trim() : undefined
  // contextual Receipt 必须从首次 claim 起绑定完整 Session/Message/Action；只有双方均
  // 无 binding 的 standalone 旧调用才允许继续走 legacy 兼容路径。
  if (existingBinding !== incomingBinding) {
    return { kind: 'conflict', receipt: structuredClone(existing), changed: false }
  }
  const status = existing.status ?? 'succeeded'
  if (status === 'succeeded') return { kind: 'replay', receipt: structuredClone(existing), changed: false }
  if (status === 'failed' && existing.replayPolicy === 'safe' && incoming.replayPolicy === 'safe') {
    const receipt = {
      ...structuredClone(existing),
      status: 'running',
      leaseToken: incoming.leaseToken,
      leaseDurationMs: incoming.leaseDurationMs,
      leaseExpiresAt: incoming.leaseExpiresAt,
      updatedAt: incoming.updatedAt,
    }
    delete receipt.error
    delete receipt.result
    return { kind: 'claimed', receipt, changed: true }
  }
  if (status === 'failed' || status === 'uncertain') {
    return { kind: status, receipt: structuredClone(existing), changed: false }
  }
  if (status !== 'running') return { kind: 'conflict', receipt: structuredClone(existing), changed: false }
  if (existing.leaseToken && existing.leaseToken === incoming.leaseToken) {
    return { kind: 'claimed', receipt: structuredClone(existing), changed: false }
  }
  const observedAt = Number(incoming.updatedAt) || Date.now()
  if (Number(existing.leaseExpiresAt) > observedAt) {
    return { kind: 'in_progress', receipt: structuredClone(existing), changed: false }
  }
  const receipt = {
    ...structuredClone(existing),
    status: 'uncertain',
    updatedAt: observedAt,
    error: {
      code: 'AGENT_ACTION_OUTCOME_UNKNOWN',
      message: '行动执行租约已过期，副作用结果无法安全确认。',
      statusCode: 409,
    },
  }
  return { kind: 'uncertain', receipt, changed: true }
}

/** Action Receipt 的身份字段一旦 claim 即不可改写；settle 只接受终态投影。 */
export function settledAgentActionReceipt(existing, settlement) {
  const receipt = {
    ...structuredClone(existing),
    status: settlement.status,
    updatedAt: settlement.updatedAt,
  }
  if (settlement.status === 'succeeded') {
    receipt.result = structuredClone(settlement.result)
    delete receipt.error
  } else {
    receipt.error = structuredClone(settlement.error)
    delete receipt.result
  }
  return receipt
}

function nonEmptyString(value) {
  return typeof value === 'string' && Boolean(value.trim())
}

function actionReceiptScopeMatches(existing, command) {
  const actorId = command?.ownerId ?? command?.actorId
  return existing?.id === command?.id
    && existing?.ownerId === actorId
    && existing?.projectId === command?.projectId
    && existing?.toolCallId === command?.toolCallId
    && existing?.actionName === command?.actionName
    && existing?.intentHash === command?.intentHash
}

function validResolutionCommand(command) {
  return ['confirmed_applied', 'confirmed_not_applied'].includes(command?.decision)
    && [command?.id, command?.projectId, command?.toolCallId, command?.actionName,
      command?.intentHash, command?.actionBindingHash, command?.actorId ?? command?.ownerId]
      .every(nonEmptyString)
    && Number.isFinite(Number(command?.resolvedAt))
    && Number(command.resolvedAt) > 0
}

function manualRetryAuthorizationMatches(command) {
  const authorization = command?.manualRetryAuthorization
  const actorId = command?.ownerId ?? command?.actorId
  const commonIdentityMatches = [authorization?.id, authorization?.receiptId,
    authorization?.intentHash, authorization?.actionBindingHash, authorization?.userId,
    authorization?.projectId, authorization?.actionId].every(nonEmptyString)
    && authorization.receiptId === command.id
    && authorization.intentHash === command.intentHash
    && authorization.actionBindingHash === command.actionBindingHash
    && authorization.userId === actorId
    && authorization.projectId === command.projectId
    && authorization.consumedAt === undefined
    && authorization.consumedByReceiptId === undefined
  if (!commonIdentityMatches) return false

  if (authorization.version === 1) {
    return nonEmptyString(authorization.tokenHash)
      && Number.isFinite(Number(authorization.issuedAt))
      && Number.isFinite(Number(authorization.expiresAt))
      && Number(authorization.issuedAt) > 0
      && Number(authorization.issuedAt) === Number(command.resolvedAt)
      && Number(authorization.expiresAt) > Number(authorization.issuedAt)
  }
  if (authorization.version === 2) {
    return nonEmptyString(authorization.boundRetryReceiptId)
      && authorization.boundRetryReceiptId !== command.id
      && authorization.tokenHash === undefined
      && authorization.tokenHint === undefined
      && authorization.issuedAt === undefined
      && Number.isFinite(Number(authorization.reservedAt))
      && Number.isFinite(Number(authorization.expiresAt))
      && Number(authorization.reservedAt) > 0
      && Number(authorization.reservedAt) === Number(command.resolvedAt)
      && Number(authorization.expiresAt) > Number(authorization.reservedAt)
  }
  return false
}

/**
 * Adapter 用权威数据库/Store 时钟重写授权起点，但不会把缺字段或倒置期限的恶意
 * 输入“修好”为有效授权。v1 以 issuedAt 为起点，v2 以 reservedAt 为起点。
 */
export function authoritativeAgentActionManualRetryAuthorization(requested, observedAt) {
  if (!requested) return undefined
  const authorization = structuredClone(requested)
  const anchorField = authorization.version === 1
    ? 'issuedAt'
    : authorization.version === 2
      ? 'reservedAt'
      : undefined
  if (!anchorField) return authorization
  const requestedAnchor = Number(authorization[anchorField])
  const requestedExpiry = Number(authorization.expiresAt)
  if (!Number.isFinite(requestedAnchor) || requestedAnchor <= 0
    || !Number.isFinite(requestedExpiry) || requestedExpiry <= requestedAnchor) {
    return authorization
  }
  const ttlMs = Math.max(1, Math.min(requestedExpiry - requestedAnchor, 3_600_000))
  authorization[anchorField] = Number(observedAt)
  authorization.expiresAt = Number(observedAt) + ttlMs
  return authorization
}

/**
 * uncertain Action Receipt 的人工决议。Adapter 必须在锁内用权威时钟覆盖
 * actorId/resolvedAt 后调用；客户端不能选择 Receipt 身份或写入原始 Token。
 */
export function agentActionReceiptResolutionDecision(existing, command) {
  if (!validResolutionCommand(command)) {
    return { kind: 'invalid', receipt: existing ? structuredClone(existing) : undefined, changed: false }
  }
  if (!existing) return { kind: 'not_found', receipt: undefined, changed: false }
  const stored = structuredClone(existing)
  if (!actionReceiptScopeMatches(stored, command)) {
    return { kind: 'conflict', receipt: stored, changed: false }
  }

  const existingResolution = stored.resolution
  if (existingResolution) {
    const sameResolution = existingResolution.version === 1
      && existingResolution.decision === command.decision
      && existingResolution.actorId === (command.ownerId ?? command.actorId)
      && existingResolution.actionBindingHash === command.actionBindingHash
      && Boolean(existingResolution.manualRetryExhausted) === Boolean(command.manualRetryExhausted)
    return sameResolution
      ? { kind: 'replay', receipt: stored, changed: false }
      : { kind: 'conflict', receipt: stored, changed: false }
  }
  if (stored.status !== 'uncertain') {
    return { kind: 'not_uncertain', receipt: stored, changed: false }
  }
  if (stored.actionBindingHash && stored.actionBindingHash !== command.actionBindingHash) {
    return { kind: 'conflict', receipt: stored, changed: false }
  }
  if (command.decision === 'confirmed_not_applied') {
    const exhausted = command.manualRetryExhausted === true
    if ((exhausted && command.manualRetryAuthorization !== undefined)
      || (!exhausted && !manualRetryAuthorizationMatches(command))) {
      return { kind: 'invalid', receipt: stored, changed: false }
    }
  }
  if (command.decision === 'confirmed_applied'
    && (command.manualRetryAuthorization !== undefined || command.manualRetryExhausted === true)) {
    return { kind: 'invalid', receipt: stored, changed: false }
  }

  const actorId = command.ownerId ?? command.actorId
  const receipt = {
    ...stored,
    status: command.decision === 'confirmed_applied' ? 'succeeded' : 'failed',
    updatedAt: Number(command.resolvedAt),
    actionBindingHash: command.actionBindingHash,
    resolution: {
      version: 1,
      decision: command.decision,
      actorId,
      actionBindingHash: command.actionBindingHash,
      resolvedAt: Number(command.resolvedAt),
      ...(command.manualRetryExhausted === true ? { manualRetryExhausted: true } : {}),
    },
  }
  // 人工决议只确认外部事实，绝不能伪造 Provider output / Artifact。
  delete receipt.result
  delete receipt.output
  delete receipt.artifacts
  delete receipt.leaseToken
  delete receipt.leaseDurationMs
  delete receipt.leaseExpiresAt
  if (command.decision === 'confirmed_applied') {
    delete receipt.error
    delete receipt.manualRetryAuthorization
  } else {
    const exhausted = command.manualRetryExhausted === true
    receipt.error = exhausted
      ? {
          code: 'AGENT_ACTION_MANUAL_RETRY_EXHAUSTED',
          message: '已人工确认该行动未生效；一次性手动重试机会已用完。',
          statusCode: 409,
        }
      : {
          code: 'AGENT_ACTION_CONFIRMED_NOT_APPLIED',
          message: '已人工确认该行动未生效，可使用一次性授权重新提交。',
          statusCode: 409,
        }
    if (exhausted) delete receipt.manualRetryAuthorization
    else receipt.manualRetryAuthorization = structuredClone(command.manualRetryAuthorization)
  }
  return { kind: 'resolved', receipt, changed: true }
}

/** 一次性手动重试授权消费；相同 retryReceiptId 的传输重试可安全重放。 */
export function agentActionManualRetryConsumptionDecision(existing, command) {
  const actorId = command?.ownerId ?? command?.actorId
  if (![command?.id, command?.projectId, command?.actionId, command?.toolCallId,
    command?.actionName, command?.intentHash, command?.actionBindingHash,
    command?.retryReceiptId, actorId].every(nonEmptyString)
    || !Number.isFinite(Number(command?.consumedAt)) || Number(command.consumedAt) <= 0) {
    return { kind: 'invalid', receipt: existing ? structuredClone(existing) : undefined, changed: false }
  }
  if (!existing) return { kind: 'not_found', receipt: undefined, changed: false }
  const stored = structuredClone(existing)
  if (!actionReceiptScopeMatches(stored, { ...command, ownerId: actorId })
    || stored.actionBindingHash !== command.actionBindingHash
    || stored.resolution?.actionBindingHash !== command.actionBindingHash) {
    return { kind: 'conflict', receipt: stored, changed: false }
  }
  if (stored.status !== 'failed' || stored.resolution?.decision !== 'confirmed_not_applied') {
    return { kind: 'unavailable', receipt: stored, changed: false }
  }
  const authorization = stored.manualRetryAuthorization
  if (!authorization
    || !nonEmptyString(authorization.id)
    || authorization.receiptId !== stored.id
    || authorization.intentHash !== command.intentHash
    || authorization.actionBindingHash !== command.actionBindingHash
    || authorization.userId !== actorId
    || authorization.projectId !== command.projectId
    || authorization.actionId !== command.actionId) {
    return { kind: 'invalid', receipt: stored, changed: false }
  }

  const authorizationVersion = Number(authorization.version)
  const authorizationAnchor = authorizationVersion === 1
    ? authorization.issuedAt
    : authorizationVersion === 2
      ? authorization.reservedAt
      : undefined
  if (!Number.isFinite(Number(authorizationAnchor)) || Number(authorizationAnchor) <= 0
    || !Number.isFinite(Number(authorization.expiresAt))
    || Number(authorization.expiresAt) <= Number(authorizationAnchor)) {
    return { kind: 'invalid', receipt: stored, changed: false }
  }
  if (authorizationVersion === 1) {
    if (!nonEmptyString(authorization.tokenHash)
      || !nonEmptyString(command.tokenHash)
      || authorization.tokenHash !== command.tokenHash) {
      return { kind: 'invalid', receipt: stored, changed: false }
    }
  } else if (authorizationVersion === 2) {
    if (!nonEmptyString(authorization.boundRetryReceiptId)) {
      return { kind: 'invalid', receipt: stored, changed: false }
    }
  } else {
    return { kind: 'invalid', receipt: stored, changed: false }
  }

  // 已消费授权先处理幂等重放：响应丢失后即使此时已过期，相同新 Receipt 仍可继续 claim。
  if (authorization.consumedAt !== undefined) {
    if (!Number.isFinite(Number(authorization.consumedAt))
      || Number(authorization.consumedAt) <= 0
      || !nonEmptyString(authorization.consumedByReceiptId)) {
      return { kind: 'invalid', receipt: stored, changed: false }
    }
    if (authorization.consumedByReceiptId === command.retryReceiptId) {
      return {
        kind: 'replay', receipt: stored, changed: false,
        authorization: {
          id: authorization.id,
          consumedAt: Number(authorization.consumedAt),
          consumedByReceiptId: authorization.consumedByReceiptId,
        },
      }
    }
    return { kind: 'already_consumed', receipt: stored, changed: false }
  }
  if (authorizationVersion === 2
    && authorization.boundRetryReceiptId !== command.retryReceiptId) {
    return { kind: 'conflict', receipt: stored, changed: false }
  }
  if (Number(command.consumedAt) >= Number(authorization.expiresAt)) {
    return { kind: 'expired', receipt: stored, changed: false }
  }

  const consumedAt = Number(command.consumedAt)
  const receipt = {
    ...stored,
    updatedAt: consumedAt,
    manualRetryAuthorization: {
      ...authorization,
      consumedAt,
      consumedByReceiptId: command.retryReceiptId,
    },
  }
  return {
    kind: 'consumed', receipt, changed: true,
    authorization: { id: authorization.id, consumedAt, consumedByReceiptId: command.retryReceiptId },
  }
}

/**
 * Thread Summary 的 compare-and-set 决策。Session 主实体不是写入载荷：胜出者只替换
 * `threadSummary`，因此并发标题、模式、Skill 与上下文设置不会被 compactor 的旧快照覆盖。
 */
export function agentThreadSummaryCompareAndSetDecision(existing, command) {
  const sessionId = typeof command?.sessionId === 'string' ? command.sessionId.trim() : ''
  const expectedUpdatedAt = command?.expectedUpdatedAt
  const summary = command?.summary
  const summaryUpdatedAt = Number(summary?.updatedAt)
  const validExpected = expectedUpdatedAt === null
    || (Number.isSafeInteger(expectedUpdatedAt) && expectedUpdatedAt >= 0)
  const validSummary = summary && typeof summary === 'object' && !Array.isArray(summary)
    && typeof summary.updatedAt === 'number'
    && Number.isSafeInteger(summaryUpdatedAt) && summaryUpdatedAt >= 0
    && (expectedUpdatedAt === null || summaryUpdatedAt > expectedUpdatedAt)
  if (!sessionId || !validExpected || !validSummary) {
    return { kind: 'invalid', changed: false, ...(existing ? { session: structuredClone(existing) } : {}) }
  }
  if (!existing || existing.id !== sessionId) return { kind: 'not_found', changed: false }
  const currentUpdatedAt = existing.threadSummary === undefined || existing.threadSummary === null
    ? null
    : Number(existing.threadSummary.updatedAt)
  if (currentUpdatedAt !== null && (
    typeof existing.threadSummary.updatedAt !== 'number'
    || !Number.isSafeInteger(currentUpdatedAt)
    || currentUpdatedAt < 0
  )) {
    return { kind: 'invalid', changed: false, session: structuredClone(existing) }
  }
  if (currentUpdatedAt !== expectedUpdatedAt) {
    return { kind: 'conflict', changed: false, session: structuredClone(existing) }
  }
  return {
    kind: 'updated',
    changed: true,
    session: { ...structuredClone(existing), threadSummary: structuredClone(summary) },
  }
}

export const productStoreCoreMethods = Object.freeze([
  'authenticate',
  'createUser',
  'listProjects',
  'readProject',
  'projectAccess',
  'canEditProject',
  'readCanvasSyncProtocolEpoch',
  'writeProject',
  'deleteProject',
  'addProjectMember',
  'loadCanvasCollaboration',
  'appendCanvasGraphUpdate',
  'compactCanvasGraphUpdates',
  'readGlobalAssetLibrary',
  'writeGlobalAssetLibrary',
  'deleteGlobalAsset',
  'readAgentState',
  'listAgentSessions',
  'readAgentSession',
  'listAgentSessionMessages',
  'putAgentSessionReadReceipt',
  'listCollaborationActivities',
  'putCollaborationActivity',
  'putCollaborationActivityReceipt',
  'putAgentSession',
  'compareAndSetAgentSessionSettings',
  'compareAndSetAgentThreadSummary',
  // Model Context Surface 的 head 与 append-only ledger。State CAS 同时承载
  // provider usage anchor；原始 Message 仍是权威记录，compaction 只影响模型投影。
  'readAgentContextState',
  'listAgentContextCompactions',
  'compareAndSetAgentContextState',
  'putAgentMessage',
  'putAgentMemoryItem',
  'deleteAgentMemoryItem',
  'listAgentArtifacts',
  'putAgentSkill',
  'listAgentSkills',
  'readAgentSkillVersion',
  'putAgentActionReceipt',
  'readAgentActionReceipt',
  'claimAgentActionReceipt',
  'settleAgentActionReceipt',
  'resolveAgentActionReceipt',
  'consumeAgentActionManualRetryAuthorization',
  'putGenerationJob',
  'claimGenerationJobExecution',
  'commitGenerationJobExecution',
  'cancelGenerationJobExecution',
  'acknowledgeGenerationJobCancellation',
  'compareAndSetGenerationJob',
  'refreshGenerationArtifacts',
  'putAgentRun',
  'readAgentRun',
  'readAgentRunForWorker',
  'claimAgentBranchRetry',
  'listAgentRunsForProject',
  // 按确认来源 Turn 反查 Run。权威边是 `run.turnId`；Turn 侧的 linkedRunIds 是读时
  // 派生，因此这条查询不能退化成「列项目全部 Run 再本地过滤」—— 那会在项目 Run 数
  // 超过列表上限时静默漏掉更早的关联。
  'listAgentRunsForTurn',
  'listAgentRunsForTurnPage',
  'listQueuedAgentRunsForRecovery',
  'claimAgentTurnExecution',
  'commitAgentTurnExecution',
  'requestAgentTurnCancellation',
  'finalizeAgentTurnCancellation',
  'putAgentTurn',
  'readAgentTurn',
  'readAgentTurnForWorker',
  'listAgentTurnsForProject',
  // 跨项目扫描超过租约未推进的非终态 Turn。与 readAgentTurnForWorker 一样是
  // Worker 侧方法：清扫是系统行为，没有发起它的用户，因此不做成员校验。
  'listStaleAgentTurns',
  'appendAgentTurnEvent',
  'listAgentTurnEvents',
  // Durable Subagent 是独立描述符 + FIFO Activation。每次 Activation 仍复用 AgentTurn
  // 的执行权，Store 只负责在同一事务里绑定独立 Session/Message 与 gapless sequence。
  'enqueueAgentSubagentActivation',
  'claimAgentSubagentActivation',
  'settleAgentSubagentActivation',
  'readAgentSubagent',
  'readAgentSubagentForWorker',
  // Turn 取消落下 durable fence 后通过这条权威反向边分页收口全部子 Agent。
  'listAgentSubagentsForRootTurnPage',
  'listAgentSubagentActivations',
  'listAgentSubagentActivationsForWorker',
  'listRunnableAgentSubagents',
  'requestAgentSubagentCancellation',
  'finalizeAgentSubagentCancellation',
  // 评审任务（ADR 0006）。ReviewResult 与 HumanDecision 存在任务 payload 内：
  // 「每个候选都有结论才算完成」是原子判定，拆成三张表会让完成判定跨表且可能读到半态。
  // 跨项目扫描仍有未收口工作流运行的项目（Epic 7）。与 listStaleAgentTurns 同为
  // Worker 侧方法：推进是系统行为，没有发起它的用户。
  'listProjectsWithActiveWorkflowRuns',
  // 跨项目扫描含失败分支的 Run（Epic 5 自动重试）。同为 Worker 侧方法：
  // 重试清扫是系统行为，没有发起它的用户。
  'listRunsWithFailedBranches',
  'putAgentReviewTask',
  'claimAgentReviewExecution',
  'commitAgentReviewExecution',
  'commitAgentReviewHumanDecisions',
  'requestAgentReviewCancellation',
  'finalizeAgentReviewCancellation',
  'resolveAgentReviewOutcomeUnknown',
  'readAgentReviewTask',
  'readAgentReviewTaskForWorker',
  'listAgentReviewTasksForRun',
  'listPendingAgentReviewTasks',
  'putAgentReview',
  'readAgentReview',
  'listAgentReviewsForRun',
  'putAgentReviewDecision',
  'readGenerationJob',
  'listGenerationJobsForProject',
  'listGenerationJobsForAgentRunPage',
  'readGenerationJobForWorker',
  'listRecoverableGenerationJobs',
  'recoverGenerationJobs',
  'recoverStaleGenerationJobs',
  'listAuditEvents',
  'listWorkspaceAuditEvents',
  'recordSecurityAuditEvent',
])

export const productStoreCapabilities = Object.freeze({
  authAssurance: Object.freeze(['authAssurance']),
  workspaceMembers: Object.freeze(['listUsers', 'updateUser']),
  inviteResend: Object.freeze(['resendUserInvite']),
  mediaObjects: Object.freeze(['createMediaObject', 'readMediaObject']),
  userProvisioning: Object.freeze(['ensureAuthenticatedUser', 'readUser']),
  lifecycle: Object.freeze(['close']),
  /**
   * 原子文档更新：`updateProjectDocument(userId, projectId, mutate)`。
   * 契约：mutate 收到最新合并文档（含 graph），返回下一份文档或 undefined（无需写入）；
   * Adapter 在自身锁/事务内应用，返回 writeProject 同形结果或 undefined（项目缺失/无变更）。
   * Worker 任务状态回写用它替代「读-改-CAS 写」竞速；不支持的 Store 回退旧循环。
   */
  projectDocumentAtomicUpdate: Object.freeze(['updateProjectDocument']),
})

function missingMethods(store, methods) {
  return methods.filter((method) => typeof store?.[method] !== 'function')
}

export function productStoreSupports(store, capability) {
  const methods = productStoreCapabilities[capability]
  if (!methods) throw new Error(`未知 ProductStore 能力：${capability}`)
  return missingMethods(store, methods).length === 0
}

export function assertProductStoreContract(store, { adapter = 'ProductStore' } = {}) {
  const missing = missingMethods(store, productStoreCoreMethods)
  if (missing.length) {
    throw new Error(`${adapter} 缺少 ProductStore 核心方法：${missing.join(', ')}`)
  }
  return store
}
