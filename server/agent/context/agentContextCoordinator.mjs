// @ts-check

import { canonicalHash } from '../../canonicalHash.mjs'
import {
  agentContextMessageCursorHash,
  resolveAgentContextCompaction,
} from './agentContextCompaction.mjs'
import { resolveAgentModelContextPolicy } from '../../agentModelContextPolicy.mjs'

const MAX_LEDGER_PAGES = 20

export class AgentContextCoordinatorError extends Error {
  constructor(code, message, statusCode = 409) {
    super(message)
    this.name = 'AgentContextCoordinatorError'
    this.code = code
    this.statusCode = statusCode
  }
}

/** @returns {never} */
function failure(code, message, statusCode = 409) {
  throw new AgentContextCoordinatorError(code, message, statusCode)
}

function assertStore(productStore) {
  for (const method of [
    'readAgentContextState',
    'listAgentContextCompactions',
    'compareAndSetAgentContextState',
  ]) {
    if (typeof productStore?.[method] !== 'function') {
      throw new TypeError(`Agent Context Coordinator 缺少 ProductStore.${method}。`)
    }
  }
}

async function readHeadCompaction(productStore, userId, projectId, sessionId, state) {
  const headId = state?.headCompactionId
  if (!headId) return undefined
  const headSequence = Number(state?.headCompactionSequence)
  if (!Number.isSafeInteger(headSequence) || headSequence < 1) {
    failure('AGENT_CONTEXT_HEAD_INVALID', 'Agent Context Head 缺少有效序号。', 409)
  }
  let afterSequence = Math.max(0, headSequence - 1)
  const seen = new Set()
  for (let pageIndex = 0; pageIndex < MAX_LEDGER_PAGES; pageIndex += 1) {
    if (seen.has(afterSequence)) break
    seen.add(afterSequence)
    const page = await productStore.listAgentContextCompactions(
      userId,
      projectId,
      sessionId,
      { afterSequence, limit: 200 },
    )
    if (!page) failure('AGENT_SESSION_NOT_FOUND', '未找到 Agent Context 所属会话。', 404)
    const found = (page.compactions ?? []).find((entry) => (
      entry?.id === headId && Number(entry.sequence) === headSequence
    ))
    if (found) return found
    const next = Number(page.nextAfterSequence)
    if (!Number.isSafeInteger(next) || next <= afterSequence) break
    afterSequence = next
  }
  // State 指向不存在的 ledger 不是“当作没压缩”即可接受的小问题：这会让不同实例
  // 对同一 Turn 构造不同请求快照。
  failure('AGENT_CONTEXT_HEAD_MISSING', 'Agent Context Head 与压缩目录不一致。', 409)
}

function safePolicy(policy) {
  return structuredClone(policy)
}

function snapshotFromProjection(projection, state, head) {
  const entries = projection.kind === 'candidate'
    ? projection.retainedEntries
    : projection.checkpoint
      ? projection.entries.slice(1)
      : projection.entries
  const checkpoint = projection.checkpoint
  return {
    version: 2,
    modelPolicy: safePolicy(projection.policy),
    ...(head ? {
      compactionHead: {
        id: head.id,
        sequence: Number(head.sequence ?? state?.revision ?? 0),
        resultSurfaceHash: head.resultSurfaceHash,
      },
    } : {}),
    ...(checkpoint ? { checkpoint: structuredClone(checkpoint) } : {}),
    messages: structuredClone(entries),
    messageCursorHash: agentContextMessageCursorHash(entries),
    contextMeter: projection.meter ? structuredClone(projection.meter) : undefined,
    contextStateRevision: Number(state?.revision ?? 0),
    ...(state?.usageAnchor ? { usageAnchor: structuredClone(state.usageAnchor) } : {}),
  }
}

function committedHead(compaction, state) {
  return {
    ...structuredClone(compaction),
    sequence: Number(state.revision),
    createdAt: Number(state.updatedAt),
  }
}

/**
 * Context V2 的唯一持久化协调器。纯选择逻辑与 Store CAS 分离：冲突时重读一次，
 * 任何无法证明一致的结果都 fail closed，不能偷偷回退为每实例不同的 legacy surface。
 */
export function createAgentContextCoordinator(dependencies) {
  const { productStore } = dependencies ?? {}
  assertStore(productStore)
  const policies = dependencies?.policies
  const observe = typeof dependencies?.observe === 'function' ? dependencies.observe : undefined

  const emitCompaction = (input, outcome, projection, startedAt) => {
    if (!observe) return
    const compaction = projection?.compaction
    const before = compaction?.meterBefore?.inputTokens ?? projection?.meter?.inputTokens
    const after = compaction?.meterAfter?.inputTokens ?? projection?.meter?.inputTokens
    try {
      observe({
        name: 'agent.context.compaction',
        outcome,
        trigger: input?.trigger ?? 'pre_step',
        identity: {
          projectId: input?.projectId,
          sessionId: input?.sessionId,
          turnId: input?.turnId,
          compactionId: compaction?.id,
        },
        ...(Number.isSafeInteger(before) ? { inputTokensBefore: before } : {}),
        ...(Number.isSafeInteger(after) ? { inputTokensAfter: after } : {}),
        ...(Array.isArray(compaction?.replacedMessageRevisions)
          ? { replacedMessageCount: compaction.replacedMessageRevisions.length }
          : {}),
        durationMs: Math.max(0, Date.now() - startedAt),
      })
    } catch { /* 可观测性不得改变 CAS */ }
  }

  async function resolve(input) {
    const startedAt = Date.now()
    const {
      userId, projectId, sessionId, model, messages, currentMessageId,
      locale = 'zh-CN', threadSummary, force = false, trigger = 'pre_step',
    } = input ?? {}
    const policy = resolveAgentModelContextPolicy(model, policies)
    let state = await productStore.readAgentContextState(userId, projectId, sessionId)
    if (!state) failure('AGENT_SESSION_NOT_FOUND', '未找到 Agent Context 所属会话。', 404)

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const head = await readHeadCompaction(productStore, userId, projectId, sessionId, state)
      const projection = resolveAgentContextCompaction({
        sessionId,
        messages,
        currentMessageId,
        locale,
        policy,
        usageAnchor: state.usageAnchor,
        existingCompaction: head,
        threadSummary,
        force,
        trigger,
      })
      if (projection.kind !== 'candidate') {
        emitCompaction(input, projection.kind === 'reused' ? 'reused' : 'no_change', projection, startedAt)
        return {
          kind: projection.kind,
          state: structuredClone(state),
          ...(head ? { compaction: structuredClone(head) } : {}),
          snapshot: snapshotFromProjection(projection, state, head),
        }
      }
      const idempotencyKey = typeof input?.idempotencyKey === 'string' && input.idempotencyKey.trim()
        ? input.idempotencyKey.trim()
        : projection.idempotencyKey
      const outcome = await productStore.compareAndSetAgentContextState(userId, {
        projectId,
        sessionId,
        expectedRevision: Number(state.revision ?? 0),
        idempotencyKey,
        compaction: projection.compaction,
      })
      if (['updated', 'replay'].includes(outcome?.kind) && outcome.state) {
        const nextHead = committedHead(outcome.compaction ?? projection.compaction, outcome.state)
        const committedProjection = resolveAgentContextCompaction({
          sessionId,
          messages,
          currentMessageId,
          locale,
          policy,
          usageAnchor: outcome.state.usageAnchor,
          existingCompaction: nextHead,
          threadSummary,
          force: false,
          trigger,
        })
        if (!['reused', 'no_change'].includes(committedProjection.kind)) {
          failure('AGENT_CONTEXT_COMMIT_UNREADABLE', '已提交的 Agent Context Checkpoint 无法重放。', 409)
        }
        const resolvedKind = outcome.kind === 'replay' ? 'replay' : 'compacted'
        emitCompaction(input, outcome.kind === 'replay' ? 'reused' : 'compacted', {
          ...committedProjection,
          compaction: nextHead,
        }, startedAt)
        return {
          kind: resolvedKind,
          state: structuredClone(outcome.state),
          compaction: nextHead,
          snapshot: snapshotFromProjection(committedProjection, outcome.state, nextHead),
        }
      }
      if (outcome?.kind === 'not_found') {
        failure('AGENT_SESSION_NOT_FOUND', 'Agent Context 会话已不存在。', 404)
      }
      if (outcome?.kind === 'invalid') {
        failure('AGENT_CONTEXT_CAS_INVALID', 'Agent Context CAS 请求无效。', 409)
      }
      if (outcome?.kind !== 'conflict') {
        failure('AGENT_CONTEXT_CAS_REJECTED', 'Agent Context CAS 返回了不受支持的结果。', 409)
      }
      state = outcome.state ?? await productStore.readAgentContextState(userId, projectId, sessionId)
      if (!state) failure('AGENT_SESSION_NOT_FOUND', 'Agent Context 会话已不存在。', 404)
    }
    emitCompaction(input, 'cas_conflict', undefined, startedAt)
    failure('AGENT_CONTEXT_CAS_CONFLICT', 'Agent Context 同时被其它执行者推进，请重试。', 409)
  }

  async function persistUsageAnchor(input) {
    const { userId, projectId, sessionId, usageAnchor } = input ?? {}
    const state = await productStore.readAgentContextState(userId, projectId, sessionId)
    if (!state) return { kind: 'not_found', changed: false }
    const idempotencyKey = `agent-context-usage-${canonicalHash({
      sessionId,
      surfaceHash: usageAnchor?.surfaceHash,
      turnId: usageAnchor?.turnId,
      step: usageAnchor?.step,
    })}`
    return productStore.compareAndSetAgentContextState(userId, {
      projectId,
      sessionId,
      expectedRevision: Number(state.revision ?? 0),
      idempotencyKey,
      usageAnchor,
    })
  }

  return Object.freeze({ resolve, persistUsageAnchor })
}
