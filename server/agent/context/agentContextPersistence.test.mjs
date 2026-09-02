import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalHash } from '../../canonicalHash.mjs'
import {
  agentContextStateCompareAndSetDecision,
  materializeAgentContextCommand,
  normalizeAgentContextCompactionPage,
  publicAgentContextCompaction,
  validateAgentContextCompaction,
  validateAgentUsageAnchor,
} from './agentContextPersistence.mjs'

function usageAnchor(overrides = {}) {
  return {
    version: 1,
    provider: 'openai',
    model: 'gpt-5',
    surfaceHash: 'surface-1',
    staticHash: 'static-1',
    inputTokens: 120,
    outputTokens: 20,
    heuristicInputTokens: 110,
    observedAt: 1_000,
    turnId: 'turn-1',
    step: 2,
    ...overrides,
  }
}

function compaction(overrides = {}) {
  return {
    id: 'compact-1',
    version: 2,
    trigger: 'pre_step',
    sourceSurfaceHash: 'surface-before',
    resultSurfaceHash: 'surface-after',
    replacedMessageRevisions: [
      { messageId: 'message-1', revision: 'revision-1' },
      { messageId: 'message-2', revision: 'revision-2' },
    ],
    checkpoint: {
      role: 'user',
      content: '这是压缩检查点。',
      contentHash: canonicalHash('这是压缩检查点。'),
      threadSummaryHash: 'summary-1',
    },
    policy: { id: 'policy-1', hash: 'policy-hash-1', model: 'gpt-5' },
    meterBefore: { totalTokens: 7_500 },
    meterAfter: { totalTokens: 1_400 },
    ...overrides,
  }
}

function command(overrides = {}) {
  return {
    projectId: 'project-1',
    sessionId: 'session-1',
    expectedRevision: 0,
    idempotencyKey: 'context-key-1',
    usageAnchor: usageAnchor(),
    ...overrides,
  }
}

test('Usage anchor 与 Compaction V2 只接受受限 DTO', () => {
  assert.deepEqual(validateAgentUsageAnchor(usageAnchor()), usageAnchor())
  const { outputTokens: _omittedOutputTokens, ...inputOnly } = usageAnchor()
  assert.deepEqual(validateAgentUsageAnchor(inputOnly), inputOnly)
  const inputAndTotal = { ...inputOnly, totalTokens: 140 }
  assert.deepEqual(validateAgentUsageAnchor(inputAndTotal), inputAndTotal)
  const completeUsage = usageAnchor({ totalTokens: 145 })
  assert.deepEqual(validateAgentUsageAnchor(completeUsage), completeUsage)
  assert.deepEqual(validateAgentContextCompaction(compaction()), compaction())
  assert.throws(() => validateAgentUsageAnchor(usageAnchor({ version: 2 })), /版本无效/u)
  assert.throws(() => validateAgentUsageAnchor(usageAnchor({ outputTokens: -1 })), /output tokens无效/u)
  assert.throws(() => validateAgentUsageAnchor(usageAnchor({ totalTokens: 119 })), /小于 input tokens/u)
  assert.throws(() => validateAgentUsageAnchor(usageAnchor({ totalTokens: 130 })), /input 与 output tokens 之和/u)
  assert.throws(() => validateAgentContextCompaction(compaction({ trigger: 'automatic' })), /触发类型无效/u)
  assert.throws(() => validateAgentContextCompaction(compaction({
    checkpoint: { role: 'user', content: '被篡改', contentHash: 'old-hash' },
  })), /内容哈希不匹配/u)
  assert.throws(() => validateAgentContextCompaction(compaction({
    meterBefore: { rawReasoning: '不应持久化' },
  })), /原始推理/u)
})

test('CAS request hash 只绑定规范化后的不可变意图', () => {
  const first = materializeAgentContextCommand({ ...command(), ignored: 'field' })
  const second = materializeAgentContextCommand(command({ expectedRevision: 9 }))
  assert.equal(first.requestHash, second.requestHash)
  assert.equal(first.ignored, undefined)
  assert.throws(() => materializeAgentContextCommand({
    ...command(), usageAnchor: undefined,
  }), /没有可提交/u)
})

test('Context state CAS 原子推进 revision 并保留 owner', () => {
  const first = agentContextStateCompareAndSetDecision({
    command: command(), ownerId: 'owner-1', observedAt: 2_000,
  })
  assert.equal(first.kind, 'updated')
  assert.equal(first.state.revision, 1)
  assert.equal(first.state.updatedAt, 2_000)
  assert.deepEqual(first.state.usageAnchor, usageAnchor())
  assert.equal(first.ledgerEntry.ownerId, 'owner-1')
  assert.equal(first.ledgerEntry.compaction, undefined, 'usage-only transition 不冒充 compaction')

  const second = agentContextStateCompareAndSetDecision({
    state: first.state,
    command: command({
      expectedRevision: 1,
      idempotencyKey: 'context-key-2',
      usageAnchor: undefined,
      compaction: compaction(),
    }),
    ownerId: first.ledgerEntry.ownerId,
    observedAt: 3_000,
  })
  assert.equal(second.kind, 'updated')
  assert.equal(second.state.revision, 2)
  assert.equal(second.state.headCompactionId, 'compact-1')
  assert.equal(second.state.headCompactionSequence, 2)
  assert.deepEqual(second.state.usageAnchor, usageAnchor(), '未携带 anchor 时保留原值')
  assert.equal(second.ledgerEntry.ownerId, 'owner-1')
  assert.deepEqual(publicAgentContextCompaction(second.ledgerEntry), {
    ...compaction(), sequence: 2, createdAt: 3_000,
  })

  const third = agentContextStateCompareAndSetDecision({
    state: second.state,
    command: command({
      expectedRevision: 2,
      idempotencyKey: 'context-key-3',
      usageAnchor: usageAnchor({ surfaceHash: 'surface-3' }),
    }),
    ownerId: 'owner-1',
    observedAt: 4_000,
  })
  assert.equal(third.state.revision, 3)
  assert.equal(third.state.headCompactionId, 'compact-1')
  assert.equal(third.state.headCompactionSequence, 2, 'usage-only 推进保留 head sequence')
})

test('历史幂等键在 head 推进后仍 replay，变更请求则 conflict', () => {
  const original = agentContextStateCompareAndSetDecision({
    command: command(), ownerId: 'owner-1', observedAt: 2_000,
  })
  const advancedState = { ...original.state, revision: 9, updatedAt: 9_000 }
  const replay = agentContextStateCompareAndSetDecision({
    state: advancedState,
    replayEntry: original.ledgerEntry,
    command: command({ expectedRevision: 9 }),
    ownerId: 'owner-1',
    observedAt: 10_000,
  })
  assert.equal(replay.kind, 'replay')
  assert.deepEqual(replay.state, original.state)

  const conflict = agentContextStateCompareAndSetDecision({
    state: advancedState,
    replayEntry: original.ledgerEntry,
    command: command({ usageAnchor: usageAnchor({ inputTokens: 121 }) }),
    ownerId: 'owner-1',
    observedAt: 10_000,
  })
  assert.equal(conflict.kind, 'conflict')

  const stale = agentContextStateCompareAndSetDecision({
    state: advancedState,
    command: command({ idempotencyKey: 'new-key' }),
    ownerId: 'owner-1',
    observedAt: 10_000,
  })
  assert.equal(stale.kind, 'conflict')
})

test('Compaction ledger 页面是单调 afterSequence', () => {
  assert.deepEqual(normalizeAgentContextCompactionPage(), { afterSequence: 0, limit: 50 })
  assert.deepEqual(normalizeAgentContextCompactionPage({ afterSequence: 4, limit: 500 }), {
    afterSequence: 4, limit: 200,
  })
  assert.throws(() => normalizeAgentContextCompactionPage({ afterSequence: -1 }), /afterSequence/u)
})
