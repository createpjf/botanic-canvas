// @ts-check

import { canonicalHash } from '../../canonicalHash.mjs'

const MAX_SAFE = Number.MAX_SAFE_INTEGER
const HASH_TEXT_LIMIT = 200
const ID_TEXT_LIMIT = 200
const CONTENT_LIMIT = 64_000
const REVISION_LIMIT = 500
const triggers = new Set(['pre_step', 'overflow', 'manual'])

function text(value, name, maximum = ID_TEXT_LIMIT) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new TypeError(`${name}无效。`)
  }
  return value.trim()
}

function integer(value, name, { minimum = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`${name}无效。`)
  return value
}

function boundedObject(value, name, maximumBytes = 32_000) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name}无效。`)
  let serialized
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw new TypeError(`${name}无效。`)
  }
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > maximumBytes) throw new TypeError(`${name}过大。`)
  const cloned = JSON.parse(serialized)
  const inspect = [cloned]
  while (inspect.length) {
    const current = inspect.pop()
    if (!current || typeof current !== 'object') continue
    for (const [key, child] of Object.entries(current)) {
      if (['rawReasoning', 'reasoning_content', 'reasoningContent'].includes(key)) {
        throw new TypeError(`${name}不得包含原始推理。`)
      }
      if (child && typeof child === 'object') inspect.push(child)
    }
  }
  return cloned
}

export function validateAgentUsageAnchor(value) {
  const anchor = boundedObject(value, 'Agent usage anchor', 8_000)
  if (anchor.version !== 1) throw new TypeError('Agent usage anchor 版本无效。')
  const inputTokens = integer(anchor.inputTokens, 'Agent usage input tokens')
  const outputTokens = anchor.outputTokens === undefined
    ? undefined
    : integer(anchor.outputTokens, 'Agent usage output tokens')
  const totalTokens = anchor.totalTokens === undefined
    ? undefined
    : integer(anchor.totalTokens, 'Agent usage total tokens')
  if (totalTokens !== undefined && totalTokens < inputTokens) {
    throw new TypeError('Agent usage total tokens 小于 input tokens。')
  }
  if (totalTokens !== undefined && outputTokens !== undefined
    && totalTokens < inputTokens + outputTokens) {
    throw new TypeError('Agent usage total tokens 小于 input 与 output tokens 之和。')
  }
  const result = {
    version: 1,
    provider: text(anchor.provider, 'Agent usage provider', 120),
    model: text(anchor.model, 'Agent usage model', 160),
    surfaceHash: text(anchor.surfaceHash, 'Agent usage surface hash', HASH_TEXT_LIMIT),
    staticHash: text(anchor.staticHash, 'Agent usage static hash', HASH_TEXT_LIMIT),
    inputTokens,
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    heuristicInputTokens: integer(anchor.heuristicInputTokens, 'Agent usage heuristic tokens'),
    observedAt: integer(anchor.observedAt, 'Agent usage observedAt'),
    ...(anchor.turnId === undefined ? {} : {
      turnId: text(anchor.turnId, 'Agent usage Turn', ID_TEXT_LIMIT),
    }),
    ...(anchor.step === undefined ? {} : {
      step: integer(anchor.step, 'Agent usage step'),
    }),
  }
  return result
}

function validateMessageRevisions(value) {
  if (!Array.isArray(value) || !value.length || value.length > REVISION_LIMIT) {
    throw new TypeError('Agent compaction 消息版本无效。')
  }
  const seen = new Set()
  return value.map((entry) => {
    const messageId = text(entry?.messageId, 'Agent compaction 消息标识', ID_TEXT_LIMIT)
    if (seen.has(messageId)) throw new TypeError('Agent compaction 消息标识重复。')
    seen.add(messageId)
    return {
      messageId,
      revision: text(entry?.revision, 'Agent compaction 消息版本', HASH_TEXT_LIMIT),
    }
  })
}

export function validateAgentContextCompaction(value) {
  const compaction = boundedObject(value, 'Agent context compaction', 160_000)
  if (compaction.version !== 2 || !triggers.has(compaction.trigger)) {
    throw new TypeError('Agent context compaction 版本或触发类型无效。')
  }
  const checkpoint = boundedObject(compaction.checkpoint, 'Agent compaction checkpoint', 80_000)
  if (checkpoint.role !== 'user' || typeof checkpoint.content !== 'string'
    || !checkpoint.content.trim() || checkpoint.content.length > CONTENT_LIMIT) {
    throw new TypeError('Agent compaction checkpoint 无效。')
  }
  const checkpointContentHash = text(checkpoint.contentHash, 'Agent compaction content hash', HASH_TEXT_LIMIT)
  if (canonicalHash(checkpoint.content) !== checkpointContentHash) {
    throw new TypeError('Agent compaction checkpoint 内容哈希不匹配。')
  }
  const policy = boundedObject(compaction.policy, 'Agent compaction policy', 8_000)
  return {
    id: text(compaction.id, 'Agent compaction 标识', ID_TEXT_LIMIT),
    version: 2,
    trigger: compaction.trigger,
    sourceSurfaceHash: text(compaction.sourceSurfaceHash, 'Agent compaction source surface hash', HASH_TEXT_LIMIT),
    resultSurfaceHash: text(compaction.resultSurfaceHash, 'Agent compaction result surface hash', HASH_TEXT_LIMIT),
    replacedMessageRevisions: validateMessageRevisions(compaction.replacedMessageRevisions),
    checkpoint: {
      role: 'user',
      content: checkpoint.content,
      contentHash: checkpointContentHash,
      ...(checkpoint.threadSummaryHash === undefined ? {} : {
        threadSummaryHash: text(checkpoint.threadSummaryHash, 'Agent compaction thread summary hash', HASH_TEXT_LIMIT),
      }),
    },
    policy: {
      id: text(policy.id, 'Agent compaction policy 标识', ID_TEXT_LIMIT),
      hash: text(policy.hash, 'Agent compaction policy hash', HASH_TEXT_LIMIT),
      model: text(policy.model, 'Agent compaction policy model', 160),
    },
    meterBefore: boundedObject(compaction.meterBefore, 'Agent compaction meterBefore', 32_000),
    meterAfter: boundedObject(compaction.meterAfter, 'Agent compaction meterAfter', 32_000),
  }
}

export function materializeAgentContextCommand(value) {
  const command = boundedObject(value, 'Agent context CAS command', 180_000)
  const projectId = text(command.projectId, 'Agent context 项目标识', ID_TEXT_LIMIT)
  const sessionId = text(command.sessionId, 'Agent context 会话标识', ID_TEXT_LIMIT)
  const expectedRevision = integer(command.expectedRevision, 'Agent context expected revision')
  const idempotencyKey = text(command.idempotencyKey, 'Agent context 幂等键', ID_TEXT_LIMIT)
  const usageAnchor = command.usageAnchor === undefined ? undefined : validateAgentUsageAnchor(command.usageAnchor)
  const compaction = command.compaction === undefined ? undefined : validateAgentContextCompaction(command.compaction)
  if (!usageAnchor && !compaction) throw new TypeError('Agent context CAS 没有可提交的变更。')
  const request = {
    version: 2,
    projectId,
    sessionId,
    expectedRevision,
    ...(usageAnchor ? { usageAnchor } : {}),
    ...(compaction ? { compaction } : {}),
  }
  return {
    ...request,
    idempotencyKey,
    // expectedRevision 只是本次 CAS 的观测水位，不是语义意图。首次成功后
    // head 已推进，同键传输重试携带新水位仍必须 replay 原结果。
    requestHash: canonicalHash({
      version: 2,
      projectId,
      sessionId,
      ...(usageAnchor ? { usageAnchor } : {}),
      ...(compaction ? { compaction } : {}),
    }),
  }
}

export function agentContextLedgerEntryId(sessionId, idempotencyKey) {
  return `agent_context_${canonicalHash({ sessionId, idempotencyKey }).slice(0, 32)}`
}

export function normalizeAgentContextCompactionPage(value = {}) {
  const afterSequence = value?.afterSequence === undefined
    ? 0
    : integer(value.afterSequence, 'Agent compaction afterSequence')
  const rawLimit = Number(value?.limit)
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(Math.floor(rawLimit), 200))
    : 50
  return { afterSequence, limit }
}

/**
 * Context state 的单一 CAS 决策。Adapter 先验证 Session/权限并读取幂等 ledger，
 * 再把同一个数据库时钟传入这里。ledger 记录每个成功迁移，因此旧键在 head 继续
 * 推进后仍能精确 replay；usage-only 迁移不会被列表伪装成 compaction。
 */
export function agentContextStateCompareAndSetDecision(input) {
  let command
  try {
    command = materializeAgentContextCommand(input?.command)
  } catch {
    return { kind: 'invalid', changed: false }
  }
  const replay = input?.replayEntry
  if (replay) {
    if (replay.requestHash !== command.requestHash) return { kind: 'conflict', changed: false, state: structuredClone(input?.state) }
    return {
      kind: 'replay',
      changed: false,
      state: structuredClone(replay.state),
      ...(replay.compaction ? { compaction: structuredClone(replay.compaction) } : {}),
    }
  }
  const revision = Number(input?.state?.revision ?? 0)
  if (!Number.isSafeInteger(revision) || revision < 0 || revision !== command.expectedRevision) {
    return { kind: 'conflict', changed: false, state: structuredClone(input?.state) }
  }
  const observedAt = integer(input?.observedAt, 'Agent context database clock')
  const nextRevision = revision + 1
  if (nextRevision > MAX_SAFE) return { kind: 'invalid', changed: false }
  const ownerId = text(input?.ownerId, 'Agent context owner', ID_TEXT_LIMIT)
  const previous = input?.state
  const previousHasHeadId = previous?.headCompactionId !== undefined
  const previousHasHeadSequence = previous?.headCompactionSequence !== undefined
  if (previousHasHeadId !== previousHasHeadSequence || (previousHasHeadId && (
    typeof previous.headCompactionId !== 'string'
    || !previous.headCompactionId.trim()
    || !Number.isSafeInteger(previous.headCompactionSequence)
    || previous.headCompactionSequence < 1
    || previous.headCompactionSequence > revision
  ))) return { kind: 'invalid', changed: false }
  const state = {
    version: 2,
    sessionId: command.sessionId,
    projectId: command.projectId,
    revision: nextRevision,
    ...(command.compaction
      ? { headCompactionId: command.compaction.id, headCompactionSequence: nextRevision }
      : previous?.headCompactionId && Number.isSafeInteger(previous?.headCompactionSequence)
        ? {
            headCompactionId: previous.headCompactionId,
            headCompactionSequence: previous.headCompactionSequence,
          }
        : {}),
    ...(command.usageAnchor
      ? { usageAnchor: command.usageAnchor }
      : previous?.usageAnchor ? { usageAnchor: structuredClone(previous.usageAnchor) } : {}),
    updatedAt: observedAt,
  }
  const ledgerEntry = {
    id: agentContextLedgerEntryId(command.sessionId, command.idempotencyKey),
    ownerId,
    projectId: command.projectId,
    sessionId: command.sessionId,
    sequence: nextRevision,
    idempotencyKey: command.idempotencyKey,
    requestHash: command.requestHash,
    state: structuredClone(state),
    ...(command.usageAnchor ? { usageAnchor: command.usageAnchor } : {}),
    ...(command.compaction ? { compaction: command.compaction } : {}),
    createdAt: observedAt,
  }
  return {
    kind: 'updated',
    changed: true,
    state,
    ledgerEntry,
    ...(command.compaction ? { compaction: command.compaction } : {}),
  }
}

export function publicAgentContextCompaction(entry) {
  if (!entry?.compaction) return undefined
  return {
    ...structuredClone(entry.compaction),
    sequence: Number(entry.sequence),
    createdAt: Number(entry.createdAt),
  }
}
