import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { canonicalHash } from '../canonicalHash.mjs'
import { createAgentSkill, deprecateAgentSkill, updateAgentSkill } from '../agent/action/botanicAgentSkill.mjs'
import { createProductStore } from './productStore.mjs'
import {
  agentActionManualRetryConsumptionDecision,
  agentActionReceiptClaimDecision,
  agentActionReceiptResolutionDecision,
  agentSkillPersistenceDecision,
  agentThreadSummaryCompareAndSetDecision,
  agentTurnExecutionClaimDecision,
  committedAgentTurnExecution,
  finalizedAgentTurnCancellation,
  requestedAgentTurnCancellation,
  settledAgentActionReceipt,
  assertProductStoreContract,
  productStoreCoreMethods,
  productStoreSupports,
  nonTerminalAgentTurnStatuses,
  reclaimableAgentTurnStatuses,
  normalizeAgentEntityIdPage,
  normalizeUpdatedAtIdRecoveryPage,
  normalizeStaleTurnQuery,
  normalizeTurnEventPage,
  persistedAgentSkillVersion,
} from './productStoreContract.mjs'

function coreStore() {
  return Object.fromEntries(productStoreCoreMethods.map((method) => [method, () => undefined]))
}

test('ProductStore 契约明确报告缺失的核心能力', () => {
  const store = coreStore()
  delete store.readProject

  assert.throws(
    () => assertProductStoreContract(store, { adapter: 'BrokenStore' }),
    /BrokenStore 缺少 ProductStore 核心方法：readProject/,
  )
})

test('ProductStore 可选能力必须完整实现后才会暴露', () => {
  const store = coreStore()
  store.createMediaObject = () => undefined
  assert.equal(productStoreSupports(store, 'mediaObjects'), false)

  store.readMediaObject = () => undefined
  assert.equal(productStoreSupports(store, 'mediaObjects'), true)
})

test('Skill 持久化决策仅接受领域版本，幂等重放不追加且历史前缀不可改写', () => {
  const first = createAgentSkill({
    projectId: 'project-skill-contract', name: '换景', instructions: '保持商品不变。', capabilities: ['read'],
  }, { id: 'skill-contract', ownerId: 'user-1', approvedBy: 'user-1', now: 100 })
  assert.equal(agentSkillPersistenceDecision(undefined, first, { ownerId: 'user-1' }).kind, 'write')
  assert.equal(agentSkillPersistenceDecision(first, first, { ownerId: 'user-1' }).kind, 'replay')

  const second = updateAgentSkill(first, { instructions: '保持商品不变，只替换场景。' }, {
    actorId: 'user-1', approvedBy: 'user-1', now: 200,
  })
  assert.equal(agentSkillPersistenceDecision(first, second, { ownerId: 'user-1' }).kind, 'write')

  const deprecated = deprecateAgentSkill(second, { actorId: 'user-1', now: 300 })
  assert.equal(agentSkillPersistenceDecision(second, deprecated, { ownerId: 'user-1' }).kind, 'write')
  assert.equal(persistedAgentSkillVersion(deprecated, 1)?.instructions, first.instructions)

  const draft = createAgentSkill({
    projectId: 'project-skill-contract', name: '待审换景', instructions: '只替换背景。', capabilities: ['read'],
  }, { id: 'skill-draft-contract', ownerId: 'user-1', now: 100 })
  const published = updateAgentSkill(draft, {}, {
    actorId: 'user-1', approvedBy: 'reviewer-1', now: 200,
  })
  assert.equal(published.version, 1)
  assert.equal(agentSkillPersistenceDecision(draft, published, { ownerId: 'user-1' }).kind, 'write')

  const truncated = { ...second, versions: [second.versions[1]] }
  assert.throws(
    () => agentSkillPersistenceDecision(first, truncated, { ownerId: 'user-1' }),
    (error) => error.code === 'AGENT_SKILL_HISTORY_CONFLICT',
  )
  const overwritten = structuredClone(second)
  overwritten.versions[0].publishedAt = 999
  assert.throws(
    () => agentSkillPersistenceDecision(first, overwritten, { ownerId: 'user-1' }),
    (error) => error.code === 'AGENT_SKILL_HISTORY_CONFLICT',
  )
  assert.throws(
    () => agentSkillPersistenceDecision(first, { ...first, instructions: '篡改执行内容' }, { ownerId: 'user-1' }),
    (error) => error.code === 'AGENT_SKILL_VERSION_HASH_MISMATCH',
  )
  const unsafeVersion = structuredClone(first)
  unsafeVersion.version = Number.MAX_SAFE_INTEGER + 1
  unsafeVersion.versions[0].version = Number.MAX_SAFE_INTEGER + 1
  assert.throws(
    () => agentSkillPersistenceDecision(undefined, unsafeVersion, { ownerId: 'user-1' }),
    (error) => error.code === 'INVALID_AGENT_SKILL_VERSION',
  )
})

test('Skill 持久化决策兼容存量无 history 行，且只接受精确 legacy 前缀', () => {
  const legacy = {
    id: 'skill-legacy-contract',
    projectId: 'project-skill-contract',
    ownerId: 'user-1',
    name: '旧换景',
    instructions: '保留旧规则。',
    capabilities: ['read'],
    lifecycle: 'published',
    status: 'active',
    version: 3,
    contentHash: 'legacy-instructions-hash',
    createdAt: 50,
    updatedAt: 60,
  }
  const migrated = updateAgentSkill(legacy, { instructions: '保留旧规则，只替换背景。' }, {
    actorId: 'user-1', approvedBy: 'user-1', now: 100,
  })
  assert.deepEqual(migrated.versions.map((snapshot) => snapshot.version), [3, 4])
  assert.equal(agentSkillPersistenceDecision(legacy, migrated, { ownerId: 'user-1' }).kind, 'write')

  const tampered = structuredClone(migrated)
  tampered.versions[0].instructions = '篡改旧规则。'
  assert.throws(
    () => agentSkillPersistenceDecision(legacy, tampered, { ownerId: 'user-1' }),
    (error) => error.code === 'AGENT_SKILL_HISTORY_CONFLICT',
  )

  const complete = createAgentSkill({
    projectId: 'project-skill-contract', name: '已是 V2', instructions: '保持内容。', capabilities: ['read'],
  }, { id: 'skill-v2-backfill', ownerId: 'user-1', approvedBy: 'user-1', now: 200 })
  const withoutHistory = structuredClone(complete)
  delete withoutHistory.versions
  assert.equal(agentSkillPersistenceDecision(withoutHistory, complete, { ownerId: 'user-1' }).kind, 'write')

  const tamperedBackfill = structuredClone(complete)
  tamperedBackfill.lifecycle = 'deprecated'
  tamperedBackfill.status = 'archived'
  assert.throws(
    () => agentSkillPersistenceDecision(withoutHistory, tamperedBackfill, { ownerId: 'user-1' }),
    (error) => error.code === 'AGENT_SKILL_VERSION_STALE',
  )
})

test('Skill 同版本治理写入使用 updatedAt CAS，旧状态不能覆盖新状态', () => {
  const published = createAgentSkill({
    projectId: 'project-skill-contract', name: '治理 Skill', instructions: '保持内容。', capabilities: ['read'],
  }, { id: 'skill-governance-cas', ownerId: 'user-1', approvedBy: 'user-1', now: 100 })
  const deprecated = deprecateAgentSkill(published, { actorId: 'user-1', now: 300 })
  assert.equal(agentSkillPersistenceDecision(published, deprecated, { ownerId: 'user-1' }).kind, 'write')
  assert.throws(
    () => agentSkillPersistenceDecision(deprecated, published, { ownerId: 'user-1' }),
    (error) => error.code === 'AGENT_SKILL_VERSION_STALE',
  )

  const equalTimestampConflict = { ...published, lifecycle: 'deprecated', status: 'archived' }
  assert.throws(
    () => agentSkillPersistenceDecision(published, equalTimestampConflict, { ownerId: 'user-1' }),
    (error) => error.code === 'AGENT_SKILL_VERSION_STALE',
  )
})

test('本地 ProductStore 满足核心契约和成员管理能力', () => {
  const directory = mkdtempSync(join(tmpdir(), 'botanic-product-contract-'))
  try {
    const store = createProductStore({
      dataPath: join(directory, 'product.json'),
      bootstrapAccessToken: 'contract-test',
    })
    assert.equal(assertProductStoreContract(store, { adapter: 'LocalProductStore' }), store)
    assert.equal(productStoreSupports(store, 'workspaceMembers'), true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Thread Summary CAS 只允许匹配当前摘要版本的单个 compactor 胜出', () => {
  const session = {
    id: 'session-summary-cas', title: '保留标题', executionMode: 'auto', contextNodeIds: ['node-1'],
    createdAt: 1, updatedAt: 50,
  }
  const firstSummary = {
    version: 1, goals: ['首个摘要'], decisions: [], constraints: [], openQuestions: [], entityIds: [],
    coveredMessageIds: ['m-1'], coveredThrough: 10, updatedAt: 100,
  }
  const first = agentThreadSummaryCompareAndSetDecision(session, {
    sessionId: session.id, expectedUpdatedAt: null, summary: firstSummary,
  })
  assert.equal(first.kind, 'updated')
  assert.equal(first.session.updatedAt, 50, '摘要不能改变 Session 主排序时间')
  assert.equal(first.session.title, '保留标题')

  const stale = agentThreadSummaryCompareAndSetDecision(first.session, {
    sessionId: session.id,
    expectedUpdatedAt: null,
    summary: { ...firstSummary, goals: ['迟到摘要'], updatedAt: 90 },
  })
  assert.equal(stale.kind, 'conflict')
  assert.equal(stale.changed, false)
  assert.deepEqual(stale.session.threadSummary, firstSummary)

  for (const malformed of [
    { sessionId: '', expectedUpdatedAt: null, summary: firstSummary },
    { sessionId: session.id, expectedUpdatedAt: undefined, summary: firstSummary },
    { sessionId: session.id, expectedUpdatedAt: null, summary: { ...firstSummary, updatedAt: '100' } },
    { sessionId: session.id, expectedUpdatedAt: 100, summary: { ...firstSummary, updatedAt: 100 } },
  ]) {
    assert.equal(agentThreadSummaryCompareAndSetDecision(session, malformed).kind, 'invalid')
  }
})

test('Turn 事件分页参数三个 Adapter 共用同一份规格化', () => {
  // 缺省从头读，上限 200。
  assert.deepEqual(normalizeTurnEventPage(), { after: null, limit: 200 })
  assert.deepEqual(normalizeTurnEventPage({}), { after: null, limit: 200 })
  assert.deepEqual(normalizeTurnEventPage({ after: 7, limit: 50 }), { after: 7, limit: 50 })
  // after: 0 是合法游标（表示只要序号 > 0），不能被当成缺省。
  assert.deepEqual(normalizeTurnEventPage({ after: 0 }).after, 0)
  // 非整数与负数一律视为无游标，不能悄悄变成 NaN 比较。
  for (const after of [-1, 1.5, '3', null, undefined, Number.NaN]) {
    assert.equal(normalizeTurnEventPage({ after }).after, null, `after=${String(after)} 应视为无游标`)
  }
  assert.equal(normalizeTurnEventPage({ limit: 9999 }).limit, 500, 'limit 有硬上限')
  assert.equal(normalizeTurnEventPage({ limit: 0 }).limit, 200)
  assert.equal(normalizeTurnEventPage({ limit: -5 }).limit, 1)
})

test('陈旧 Turn 扫描的租约有下限，避免抢走仍在推进的 Turn', () => {
  // 30 秒下限：一次慢的模型调用就可能几秒不更新 updated_at。
  assert.equal(normalizeStaleTurnQuery({ now: 1_000_000, leaseMs: 1 }).olderThan, 1_000_000 - 30_000)
  assert.equal(normalizeStaleTurnQuery({ now: 1_000_000 }).olderThan, 1_000_000 - 120_000, '默认租约 2 分钟')
  assert.equal(normalizeStaleTurnQuery({ now: 1_000_000, leaseMs: 300_000 }).olderThan, 700_000)
  // 显式 olderThan 优先于租约推导。
  assert.equal(normalizeStaleTurnQuery({ now: 1_000_000, olderThan: 42 }).olderThan, 42)
  assert.equal(normalizeStaleTurnQuery({}).limit, 25, '一次只取一小批')
  assert.equal(normalizeStaleTurnQuery({ limit: 9999 }).limit, 200)
  assert.deepEqual(normalizeStaleTurnQuery({
    after: { updatedAt: 42, id: 'turn-42' },
  }).after, { updatedAt: 42, id: 'turn-42' })
  for (const after of [undefined, null, {}, { updatedAt: -1, id: 'turn' }, { updatedAt: 1, id: '' }]) {
    assert.equal(normalizeStaleTurnQuery({ after }).after, null)
  }
})

test('非终态集合只含尚可推进的状态，终态不得混入', () => {
  assert.deepEqual([...nonTerminalAgentTurnStatuses], ['queued', 'running', 'waiting_user', 'cancelling'])
  assert.deepEqual([...reclaimableAgentTurnStatuses], ['queued', 'running', 'cancelling'])
  assert.equal(reclaimableAgentTurnStatuses.includes('waiting_user'), false, '等待用户不是孤儿执行，不得占回收批次')
  for (const terminal of ['completed', 'failed', 'cancelled']) {
    assert.equal(nonTerminalAgentTurnStatuses.includes(terminal), false, `${terminal} 是终态，不该被回收`)
  }
})

test('Run/Job 恢复分页共用稳定 id 游标与硬上限', () => {
  assert.deepEqual(normalizeAgentEntityIdPage(), { afterId: null, limit: 50 })
  assert.deepEqual(normalizeAgentEntityIdPage({ afterId: 'run-050', limit: 10 }), {
    afterId: 'run-050', limit: 10,
  })
  assert.deepEqual(normalizeAgentEntityIdPage({ afterId: '  ', limit: 999 }), {
    afterId: null, limit: 200,
  })
})

test('周期恢复扫描共用 (updatedAt,id) 游标与页上限', () => {
  assert.deepEqual(normalizeUpdatedAtIdRecoveryPage(), { after: null, limit: 25 })
  assert.deepEqual(normalizeUpdatedAtIdRecoveryPage({
    after: { updatedAt: 42, id: ' item-42 ' },
    limit: 10,
  }), {
    after: { updatedAt: 42, id: 'item-42' },
    limit: 10,
  })
  assert.equal(normalizeUpdatedAtIdRecoveryPage({ limit: 999 }).limit, 200)
  assert.equal(normalizeUpdatedAtIdRecoveryPage({ limit: -2 }).limit, 1)
  assert.equal(normalizeUpdatedAtIdRecoveryPage({ limit: 2.9 }).limit, 2)
  for (const after of [
    undefined,
    null,
    {},
    { updatedAt: -1, id: 'item' },
    { updatedAt: 1, id: '' },
    { updatedAt: 1.5, id: 'item' },
    { updatedAt: Number.NaN, id: 'item' },
  ]) {
    assert.equal(normalizeUpdatedAtIdRecoveryPage({ after }).after, null)
  }
})

test('三个 Adapter 共用行动 claim 状态机：完成重放、安全失败可重试、过期转 uncertain', () => {
  const incoming = {
    id: 'receipt-1', intentHash: 'intent-1', actionName: 'skill_create', status: 'running',
    leaseToken: 'lease-new', createdAt: 200, updatedAt: 200,
  }
  assert.equal(agentActionReceiptClaimDecision(undefined, incoming).kind, 'claimed')
  assert.equal(agentActionReceiptClaimDecision({ id: 'receipt-1', result: { ok: true } }, incoming).kind, 'replay', '旧回执按 succeeded 兼容')
  assert.equal(agentActionReceiptClaimDecision({
    id: 'receipt-1', intentHash: 'intent-1', status: 'running', leaseExpiresAt: 201,
  }, incoming).kind, 'in_progress')
  assert.equal(agentActionReceiptClaimDecision({
    id: 'receipt-1', intentHash: 'intent-1', status: 'running', leaseToken: 'lease-new', leaseExpiresAt: 201,
  }, incoming).kind, 'claimed', '同一租约的传输重试仍是 claim 胜者')
  const retried = agentActionReceiptClaimDecision({
    id: 'receipt-1', intentHash: 'intent-1', actionName: 'mcp_call', status: 'failed', replayPolicy: 'safe',
    createdAt: 100, error: { code: 'FAILED' },
  }, { ...incoming, replayPolicy: 'safe' })
  assert.equal(retried.kind, 'claimed')
  assert.equal(retried.receipt.status, 'running')
  assert.equal(retried.receipt.error, undefined)
  assert.equal(retried.receipt.intentHash, 'intent-1')
  assert.equal(retried.receipt.actionName, 'mcp_call')
  assert.equal(retried.receipt.createdAt, 100)
  const expired = agentActionReceiptClaimDecision({
    id: 'receipt-1', intentHash: 'intent-1', status: 'running', leaseExpiresAt: 199,
  }, incoming)
  assert.equal(expired.kind, 'uncertain')
  assert.equal(expired.receipt.error.code, 'AGENT_ACTION_OUTCOME_UNKNOWN')
  assert.equal(agentActionReceiptClaimDecision({
    id: 'receipt-1', intentHash: 'intent-other', status: 'succeeded',
  }, incoming).kind, 'conflict')
})

test('行动 settle 只更新终态字段，不允许改写回执身份', () => {
  const existing = {
    id: 'receipt-1', ownerId: 'user-1', projectId: 'project-1', toolCallId: 'call-1',
    actionName: 'mcp_call', intentHash: 'intent-1', replayPolicy: 'never', leaseToken: 'lease-1',
    status: 'running', createdAt: 100, updatedAt: 100,
  }
  const settled = settledAgentActionReceipt(existing, {
    id: 'other', ownerId: 'other', projectId: 'other', toolCallId: 'other', actionName: 'skill_create',
    intentHash: 'other', replayPolicy: 'safe', createdAt: 999, leaseToken: 'lease-1',
    status: 'succeeded', result: { output: { ok: true } }, updatedAt: 200,
  })

  assert.deepEqual({
    id: settled.id,
    ownerId: settled.ownerId,
    projectId: settled.projectId,
    toolCallId: settled.toolCallId,
    actionName: settled.actionName,
    intentHash: settled.intentHash,
    replayPolicy: settled.replayPolicy,
    createdAt: settled.createdAt,
  }, {
    id: 'receipt-1', ownerId: 'user-1', projectId: 'project-1', toolCallId: 'call-1',
    actionName: 'mcp_call', intentHash: 'intent-1', replayPolicy: 'never', createdAt: 100,
  })
  assert.equal(settled.status, 'succeeded')
  assert.equal(settled.updatedAt, 200)
  assert.equal(settled.result.output.ok, true)
})

test('uncertain 行动只接受一次人工决议，并把重试授权绑定到完整行动', () => {
  const existing = {
    id: 'receipt-1', ownerId: 'user-1', projectId: 'project-1', toolCallId: 'call-1',
    actionName: 'mcp_call', intentHash: 'intent-1', replayPolicy: 'never', status: 'uncertain',
    result: { output: { shouldDisappear: true } }, createdAt: 100, updatedAt: 150,
  }
  const base = {
    id: existing.id, ownerId: existing.ownerId, projectId: existing.projectId,
    toolCallId: existing.toolCallId, actionName: existing.actionName, intentHash: existing.intentHash,
    actionBindingHash: 'binding-1', actorId: existing.ownerId, resolvedAt: 200,
    audit: { action: 'agent-action.reconciled', detail: { result: 'confirmed_not_applied' } },
  }
  const authorization = {
    version: 1, id: 'manual-retry-1', receiptId: existing.id, intentHash: existing.intentHash,
    actionBindingHash: 'binding-1', userId: existing.ownerId, projectId: existing.projectId,
    actionId: 'action-1', tokenHash: 'token-hash-1', tokenHint: 'abcd', issuedAt: 200, expiresAt: 1_200,
  }
  const resolved = agentActionReceiptResolutionDecision(existing, {
    ...base, decision: 'confirmed_not_applied', manualRetryAuthorization: authorization,
  })

  assert.equal(resolved.kind, 'resolved')
  assert.equal(resolved.receipt.status, 'failed')
  assert.equal(resolved.receipt.result, undefined)
  assert.equal(resolved.receipt.error.code, 'AGENT_ACTION_CONFIRMED_NOT_APPLIED')
  assert.equal(resolved.receipt.manualRetryAuthorization.tokenHash, 'token-hash-1')
  assert.equal(agentActionReceiptResolutionDecision(resolved.receipt, {
    ...base, decision: 'confirmed_not_applied', manualRetryAuthorization: authorization,
  }).kind, 'replay')
  assert.equal(agentActionReceiptResolutionDecision(resolved.receipt, {
    ...base, decision: 'confirmed_applied',
  }).kind, 'conflict', '既有决议不可被相反结论覆盖')
  assert.equal(agentActionReceiptResolutionDecision({ ...existing, status: 'failed' }, {
    ...base, decision: 'confirmed_applied',
  }).kind, 'not_uncertain')
  assert.equal(agentActionReceiptResolutionDecision(existing, {
    ...base, intentHash: 'other-intent', decision: 'confirmed_applied',
  }).kind, 'conflict')

  const applied = agentActionReceiptResolutionDecision(existing, {
    ...base, decision: 'confirmed_applied',
  })
  assert.equal(applied.receipt.status, 'succeeded')
  assert.equal(applied.receipt.result, undefined, '人工确认已生效不能伪造 Provider 结果')
  assert.equal(applied.receipt.output, undefined)
  assert.equal(applied.receipt.artifacts, undefined)
  assert.equal(applied.receipt.manualRetryAuthorization, undefined)

  const exhausted = agentActionReceiptResolutionDecision({ ...existing, id: 'receipt-retry-1' }, {
    ...base,
    id: 'receipt-retry-1',
    decision: 'confirmed_not_applied',
    manualRetryExhausted: true,
  })
  assert.equal(exhausted.kind, 'resolved')
  assert.equal(exhausted.receipt.status, 'failed')
  assert.equal(exhausted.receipt.error.code, 'AGENT_ACTION_MANUAL_RETRY_EXHAUSTED')
  assert.equal(exhausted.receipt.manualRetryAuthorization, undefined, '一次性重试后的新回执不能再签授权')
  assert.equal(exhausted.receipt.resolution.manualRetryExhausted, true)
  assert.equal(agentActionReceiptResolutionDecision(exhausted.receipt, {
    ...base,
    id: 'receipt-retry-1',
    decision: 'confirmed_not_applied',
    manualRetryAuthorization: { ...authorization, receiptId: 'receipt-retry-1' },
  }).kind, 'conflict', 'exhausted 决议不能重放成第二份授权')
})

test('手动重试授权用 token hash 原子消费，并按 retryReceiptId 幂等', () => {
  const receipt = agentActionReceiptResolutionDecision({
    id: 'receipt-1', ownerId: 'user-1', projectId: 'project-1', toolCallId: 'call-1',
    actionName: 'mcp_call', intentHash: 'intent-1', status: 'uncertain', createdAt: 100, updatedAt: 150,
  }, {
    id: 'receipt-1', ownerId: 'user-1', actorId: 'user-1', projectId: 'project-1',
    toolCallId: 'call-1', actionName: 'mcp_call', intentHash: 'intent-1',
    actionBindingHash: 'binding-1', decision: 'confirmed_not_applied', resolvedAt: 200,
    manualRetryAuthorization: {
      version: 1, id: 'auth-1', receiptId: 'receipt-1', intentHash: 'intent-1',
      actionBindingHash: 'binding-1', userId: 'user-1', projectId: 'project-1', actionId: 'action-1',
      tokenHash: 'token-hash-1', tokenHint: 'abcd', issuedAt: 200, expiresAt: 1_200,
    },
  }).receipt
  const command = {
    id: 'receipt-1', ownerId: 'user-1', projectId: 'project-1', actionId: 'action-1',
    toolCallId: 'call-1', actionName: 'mcp_call', intentHash: 'intent-1', actionBindingHash: 'binding-1',
    tokenHash: 'token-hash-1', retryReceiptId: 'receipt-retry-1', consumedAt: 300,
  }
  const consumed = agentActionManualRetryConsumptionDecision(receipt, command)
  assert.equal(consumed.kind, 'consumed')
  assert.deepEqual(consumed.authorization, {
    id: 'auth-1', consumedAt: 300, consumedByReceiptId: 'receipt-retry-1',
  })
  assert.equal(consumed.receipt.manualRetryAuthorization.consumedByReceiptId, 'receipt-retry-1')
  assert.equal(agentActionManualRetryConsumptionDecision(consumed.receipt, {
    ...command, consumedAt: 400,
  }).kind, 'replay', '相同新提交键在响应丢失后可以继续')
  assert.equal(agentActionManualRetryConsumptionDecision(consumed.receipt, {
    ...command, retryReceiptId: 'receipt-retry-2', consumedAt: 400,
  }).kind, 'already_consumed')
  assert.equal(agentActionManualRetryConsumptionDecision(receipt, {
    ...command, tokenHash: 'wrong-token-hash',
  }).kind, 'invalid')
  assert.equal(agentActionManualRetryConsumptionDecision(receipt, {
    ...command, consumedAt: 1_200,
  }).kind, 'expired')
})

test('v2 手动重试预绑定 durable Receipt，不依赖原始 token 且消费前受期限约束', () => {
  const uncertain = {
    id: 'receipt-v2', ownerId: 'user-1', projectId: 'project-1', toolCallId: 'call-1',
    actionName: 'mcp_call', intentHash: 'intent-1', actionBindingHash: 'binding-1',
    status: 'uncertain', createdAt: 100, updatedAt: 150,
  }
  const resolution = {
    id: uncertain.id, ownerId: uncertain.ownerId, actorId: uncertain.ownerId,
    projectId: uncertain.projectId, toolCallId: uncertain.toolCallId,
    actionName: uncertain.actionName, intentHash: uncertain.intentHash,
    actionBindingHash: uncertain.actionBindingHash,
    decision: 'confirmed_not_applied', resolvedAt: 200,
    manualRetryAuthorization: {
      version: 2, id: 'auth-v2', receiptId: uncertain.id, intentHash: uncertain.intentHash,
      actionBindingHash: uncertain.actionBindingHash, userId: uncertain.ownerId,
      projectId: uncertain.projectId, actionId: 'action-1',
      boundRetryReceiptId: 'receipt-v2-retry', reservedAt: 200, expiresAt: 1_200,
    },
  }
  const resolved = agentActionReceiptResolutionDecision(uncertain, resolution)
  assert.equal(resolved.kind, 'resolved')
  assert.equal(resolved.receipt.manualRetryAuthorization.version, 2)
  assert.equal(resolved.receipt.manualRetryAuthorization.boundRetryReceiptId, 'receipt-v2-retry')
  assert.equal(resolved.receipt.manualRetryAuthorization.tokenHash, undefined)
  assert.equal(resolved.receipt.manualRetryAuthorization.consumedAt, undefined)

  const consume = {
    id: uncertain.id, ownerId: uncertain.ownerId, projectId: uncertain.projectId,
    actionId: 'action-1', toolCallId: uncertain.toolCallId, actionName: uncertain.actionName,
    intentHash: uncertain.intentHash, actionBindingHash: uncertain.actionBindingHash,
    retryReceiptId: 'receipt-v2-retry', consumedAt: 300,
  }
  const consumed = agentActionManualRetryConsumptionDecision(resolved.receipt, consume)
  assert.equal(consumed.kind, 'consumed')
  assert.deepEqual(consumed.authorization, {
    id: 'auth-v2', consumedAt: 300, consumedByReceiptId: 'receipt-v2-retry',
  })
  assert.equal(agentActionManualRetryConsumptionDecision(consumed.receipt, {
    ...consume, consumedAt: 2_000,
  }).kind, 'replay', '已提交的相同预绑定 Receipt 在过期后仍可恢复响应')
  assert.equal(agentActionManualRetryConsumptionDecision(consumed.receipt, {
    ...consume, retryReceiptId: 'receipt-v2-other', consumedAt: 400,
  }).kind, 'already_consumed')
  assert.equal(agentActionManualRetryConsumptionDecision(resolved.receipt, {
    ...consume, retryReceiptId: 'receipt-v2-other', consumedAt: 300,
  }).kind, 'conflict', '未消费的 v2 授权只能交给 resolve 时预绑定的 Receipt')
  assert.equal(agentActionManualRetryConsumptionDecision(resolved.receipt, {
    ...consume, consumedAt: 1_200,
  }).kind, 'expired')

  for (const malformedAuthorization of [
    { ...resolution.manualRetryAuthorization, boundRetryReceiptId: '' },
    { ...resolution.manualRetryAuthorization, boundRetryReceiptId: uncertain.id },
    { ...resolution.manualRetryAuthorization, reservedAt: undefined },
    { ...resolution.manualRetryAuthorization, expiresAt: undefined },
    { ...resolution.manualRetryAuthorization, expiresAt: 200 },
  ]) {
    assert.equal(agentActionReceiptResolutionDecision(uncertain, {
      ...resolution, manualRetryAuthorization: malformedAuthorization,
    }).kind, 'invalid')
  }
})

test('v1 手动重试授权缺少 issuedAt/expiresAt 时必须 invalid', () => {
  const existing = {
    id: 'receipt-v1-malformed', ownerId: 'user-1', projectId: 'project-1',
    toolCallId: 'call-1', actionName: 'mcp_call', intentHash: 'intent-1',
    actionBindingHash: 'binding-1', status: 'uncertain', createdAt: 100, updatedAt: 150,
  }
  const command = {
    id: existing.id, ownerId: existing.ownerId, actorId: existing.ownerId,
    projectId: existing.projectId, toolCallId: existing.toolCallId,
    actionName: existing.actionName, intentHash: existing.intentHash,
    actionBindingHash: existing.actionBindingHash,
    decision: 'confirmed_not_applied', resolvedAt: 200,
    manualRetryAuthorization: {
      version: 1, id: 'auth-v1-malformed', receiptId: existing.id,
      intentHash: existing.intentHash, actionBindingHash: existing.actionBindingHash,
      userId: existing.ownerId, projectId: existing.projectId, actionId: 'action-1',
      tokenHash: 'hash', issuedAt: 200, expiresAt: 1_200,
    },
  }
  for (const missing of ['issuedAt', 'expiresAt']) {
    const authorization = { ...command.manualRetryAuthorization }
    delete authorization[missing]
    assert.equal(agentActionReceiptResolutionDecision(existing, {
      ...command, manualRetryAuthorization: authorization,
    }).kind, 'invalid')
  }
})

test('Turn 执行 claim 由持久化租约决定唯一执行者，并用 generation 围栏旧实例', () => {
  const turn = {
    id: 'turn-1', version: 2, ownerId: 'user-1', projectId: 'project-1',
    idempotencyKey: 'intent-1', requestHash: 'request-1', status: 'queued',
    createdAt: 100, updatedAt: 100,
  }
  const first = agentTurnExecutionClaimDecision(undefined, {
    turn, leaseToken: 'lease-1', leaseDurationMs: 120_000, observedAt: 200,
  })
  assert.equal(first.kind, 'claimed')
  assert.equal(first.turn.status, 'running')
  assert.equal(first.turn.execution.generation, 1)
  assert.equal(first.turn.execution.leaseExpiresAt, 120_200)

  assert.equal(agentTurnExecutionClaimDecision(first.turn, {
    turn, leaseToken: 'lease-2', leaseDurationMs: 120_000, observedAt: 300,
  }).kind, 'in_progress')
  assert.equal(agentTurnExecutionClaimDecision(first.turn, {
    turn, leaseToken: 'lease-1', leaseDurationMs: 120_000, observedAt: 300,
  }).kind, 'claimed', '同一租约的传输重试仍持有执行权')

  const stale = agentTurnExecutionClaimDecision(first.turn, {
    turn, leaseToken: 'lease-2', leaseDurationMs: 120_000, observedAt: 120_201,
  })
  assert.equal(stale.kind, 'stale', '普通请求不能自行接管过期执行')
  const reclaimed = agentTurnExecutionClaimDecision(first.turn, {
    turn, leaseToken: 'lease-2', leaseDurationMs: 120_000, observedAt: 120_201, allowTakeover: true,
  })
  assert.equal(reclaimed.kind, 'claimed')
  assert.equal(reclaimed.turn.execution.generation, 2)
  assert.equal(reclaimed.turn.execution.leaseToken, 'lease-2')

  assert.equal(agentTurnExecutionClaimDecision({ ...first.turn, status: 'completed' }, {
    turn, leaseToken: 'lease-3', leaseDurationMs: 120_000, observedAt: 130_000,
  }).kind, 'replay')
  assert.equal(agentTurnExecutionClaimDecision(first.turn, {
    turn: { ...turn, requestHash: 'other-request' }, leaseToken: 'lease-3', leaseDurationMs: 120_000, observedAt: 300,
  }).kind, 'conflict')
})

test('legacy Turn 缺 requestHash 时只能从已存不可变请求派生并在 claim 内回填', () => {
  const storedRequest = {
    projectId: 'project-1',
    sessionId: 'session-1',
    inputMessage: { id: 'message-1', content: '生成海边主视觉' },
    messages: [{ role: 'user', content: '旧窗口' }],
    plannerModel: 'planner-a',
  }
  const incomingRequest = {
    ...storedRequest,
    messages: [{ role: 'user', content: '滑动后的新窗口' }],
  }
  const { messages: _derivedMessages, ...v2Intent } = incomingRequest
  const incomingHash = canonicalHash(v2Intent)
  const existing = {
    id: 'turn-legacy-hash', version: 2, ownerId: 'user-1', projectId: 'project-1',
    idempotencyKey: 'intent-legacy', request: storedRequest, status: 'queued',
    createdAt: 100, updatedAt: 100,
  }
  const source = {
    ...existing,
    request: incomingRequest,
    requestHash: incomingHash,
    requestHashVersion: 2,
  }

  const claimed = agentTurnExecutionClaimDecision(existing, {
    turn: source, leaseToken: 'lease-1', observedAt: 200,
  })
  assert.equal(claimed.kind, 'claimed')
  assert.equal(claimed.turn.requestHash, incomingHash)
  assert.equal(claimed.turn.requestHashVersion, 2)
  assert.deepEqual(claimed.turn.request, storedRequest, '回填不得把首次快照换成新请求')
})

test('legacy Turn 的存储请求无法派生或与新输入不同时 fail closed', () => {
  const base = {
    id: 'turn-legacy-conflict', version: 2, ownerId: 'user-1', projectId: 'project-1',
    idempotencyKey: 'intent-legacy', status: 'queued', createdAt: 100, updatedAt: 100,
  }
  const storedRequest = {
    sessionId: 'session-1',
    inputMessage: { id: 'message-1', content: '原始输入' },
  }
  const changedRequest = {
    sessionId: 'session-1',
    inputMessage: { id: 'message-1', content: '新输入' },
  }
  const source = {
    ...base,
    request: changedRequest,
    requestHash: canonicalHash(changedRequest),
    requestHashVersion: 2,
  }

  assert.equal(agentTurnExecutionClaimDecision({ ...base, request: storedRequest }, {
    turn: source, leaseToken: 'lease-1', observedAt: 200,
  }).kind, 'conflict')
  assert.equal(agentTurnExecutionClaimDecision(base, {
    turn: source, leaseToken: 'lease-1', observedAt: 200,
  }).kind, 'conflict')
  assert.equal(agentTurnExecutionClaimDecision({ ...base, version: 99, request: storedRequest }, {
    turn: source, leaseToken: 'lease-1', observedAt: 200,
  }).kind, 'conflict')
})

test('contextual Action claim 不可接管其他 binding 或 legacy unbound Receipt', () => {
  const contextual = {
    id: 'receipt-binding', ownerId: 'user-1', projectId: 'project-1', toolCallId: 'call-1',
    actionName: 'mcp_call', intentHash: 'intent-1', actionBindingHash: 'binding-message-a',
    replayPolicy: 'never', leaseToken: 'lease-a', leaseDurationMs: 60_000,
    leaseExpiresAt: 60_100, createdAt: 100, updatedAt: 100,
  }
  const claimed = agentActionReceiptClaimDecision(undefined, contextual)
  assert.equal(claimed.kind, 'claimed')
  assert.equal(claimed.receipt.actionBindingHash, 'binding-message-a')

  const succeeded = { ...claimed.receipt, status: 'succeeded', result: { output: { ok: true } } }
  assert.equal(agentActionReceiptClaimDecision(succeeded, {
    ...contextual, leaseToken: 'lease-replay', updatedAt: 200,
  }).kind, 'replay', '同 binding 才能读取既有成功回执')
  assert.equal(agentActionReceiptClaimDecision(succeeded, {
    ...contextual, actionBindingHash: 'binding-message-b', leaseToken: 'lease-forged', updatedAt: 200,
  }).kind, 'conflict', '不同消息不能复用相同 action/tool/intent 的回执')
  assert.equal(agentActionReceiptClaimDecision(succeeded, {
    ...contextual, actionBindingHash: undefined, leaseToken: 'lease-legacy', updatedAt: 200,
  }).kind, 'conflict', 'legacy standalone claim 不能读取 contextual 回执')

  const legacy = { ...succeeded }
  delete legacy.actionBindingHash
  assert.equal(agentActionReceiptClaimDecision(legacy, contextual).kind, 'conflict', 'contextual claim 不能接管 legacy unbound 回执')
  assert.equal(agentActionReceiptClaimDecision(legacy, {
    ...contextual, actionBindingHash: undefined,
  }).kind, 'replay', '仅双方均无 binding 时保留 standalone 兼容')
})

test('Turn commit 只接受当前 generation 与 leaseToken，cancelled 终态只能由 finalizer 提交', () => {
  const running = agentTurnExecutionClaimDecision(undefined, {
    turn: {
      id: 'turn-1', version: 2, ownerId: 'user-1', projectId: 'project-1',
      idempotencyKey: 'intent-1', requestHash: 'request-1', requestHashVersion: 2,
      status: 'queued', createdAt: 100, updatedAt: 100,
    },
    leaseToken: 'lease-1', leaseDurationMs: 120_000, observedAt: 200,
  }).turn

  const heartbeat = committedAgentTurnExecution(running, {
    id: running.id, projectId: running.projectId, leaseToken: 'lease-1', executionGeneration: 1,
    status: 'running', checkpoint: { version: 1, nextStep: 1 }, observedAt: 300,
  })
  assert.equal(heartbeat.kind, 'committed')
  assert.deepEqual(heartbeat.turn.checkpoint, { version: 1, nextStep: 1 })
  assert.equal(heartbeat.turn.execution.leaseExpiresAt, 120_300)

  const stale = committedAgentTurnExecution(heartbeat.turn, {
    id: running.id, projectId: running.projectId, leaseToken: 'lease-old', executionGeneration: 1,
    status: 'completed', result: { kind: 'chat' }, observedAt: 400,
  })
  assert.equal(stale.kind, 'stale')
  assert.equal(stale.turn.status, 'running')

  const cancelling = { ...heartbeat.turn, status: 'cancelling', error: { code: 'AGENT_TURN_CANCELLED' } }
  const blocked = committedAgentTurnExecution(cancelling, {
    id: running.id, projectId: running.projectId, leaseToken: 'lease-1', executionGeneration: 1,
    status: 'completed', result: { kind: 'chat' }, observedAt: 500,
  })
  assert.equal(blocked.kind, 'cancelling')
  assert.equal(blocked.turn.status, 'cancelling')

  const cancelled = committedAgentTurnExecution(cancelling, {
    id: running.id, projectId: running.projectId, leaseToken: 'lease-1', executionGeneration: 1,
    status: 'cancelled', error: { code: 'AGENT_TURN_CANCELLED' }, observedAt: 501,
  })
  assert.equal(cancelled.kind, 'cancelling')
  assert.equal(cancelled.turn.status, 'cancelling')

  const forgedCancellation = committedAgentTurnExecution(heartbeat.turn, {
    id: running.id, projectId: running.projectId, leaseToken: 'lease-1', executionGeneration: 1,
    status: 'cancelled', error: { code: 'AGENT_TURN_CANCELLED' }, observedAt: 502,
  })
  assert.equal(forgedCancellation.kind, 'conflict')
  assert.equal(forgedCancellation.turn.status, 'running')

  const waiting = committedAgentTurnExecution(heartbeat.turn, {
    id: running.id, projectId: running.projectId, leaseToken: 'lease-1', executionGeneration: 1,
    status: 'waiting_user', result: { kind: 'clarification', question: '请选择一个方向' }, observedAt: 450,
  })
  assert.equal(waiting.kind, 'committed')
  assert.equal(waiting.turn.status, 'waiting_user')
  assert.equal(waiting.turn.result.kind, 'clarification')
  assert.equal(waiting.turn.error, undefined)
  assert.equal(waiting.turn.execution.settledAt, 450)
  assert.equal(agentTurnExecutionClaimDecision(waiting.turn, {
    turn: waiting.turn, leaseToken: 'lease-2', observedAt: 500,
  }).kind, 'waiting_user')
})

test('Turn 原子取消把可撤销状态推进到 cancelling，completed 仍可深取消委派任务', () => {
  const running = {
    id: 'turn-1', ownerId: 'user-1', projectId: 'project-1', status: 'running',
    updatedAt: 100,
    execution: {
      generation: 1, leaseToken: 'lease-1', leaseDurationMs: 30_000,
      leaseExpiresAt: 30_100, claimedAt: 100, lastHeartbeatAt: 100,
    },
  }
  const requested = requestedAgentTurnCancellation(running, {
    id: 'turn-1', projectId: 'project-1', reason: '用户停止', observedAt: 200,
  })
  assert.equal(requested.kind, 'requested')
  assert.equal(requested.turn.status, 'cancelling')
  assert.equal(requested.turn.execution.leaseToken, 'lease-1')
  assert.equal(requested.turn.error.code, 'AGENT_TURN_CANCELLED')
  assert.equal(requested.turn.cancellation.signalRequired, true)
  assert.equal(requested.turn.cancellation.workerReleased, false)
  assert.equal(requested.turn.cancellation.executionGeneration, 1)
  assert.equal(requested.turn.cancellation.signalId, 'agent-turn-cancel:turn-1:1:200')
  assert.equal(requestedAgentTurnCancellation(requested.turn, {
    id: 'turn-1', projectId: 'project-1', observedAt: 300,
  }).kind, 'replay')
  const completed = { ...running, status: 'completed', result: { kind: 'chat' } }
  const completedCancellation = requestedAgentTurnCancellation(completed, {
    id: 'turn-1', projectId: 'project-1', observedAt: 300,
  })
  assert.equal(completedCancellation.kind, 'requested')
  assert.equal(completedCancellation.turn.status, 'cancelling')
  assert.equal(completedCancellation.turn.result, undefined)
  assert.equal(completedCancellation.turn.cancellation.signalRequired, undefined)
  assert.equal(requestedAgentTurnCancellation({ ...running, status: 'failed' }, {
    id: 'turn-1', projectId: 'project-1', observedAt: 300,
  }).kind, 'replay')
})

test('Turn cancelling heartbeat 只允许原 signal/generation/lease 续租，worker_exit 才留下退出证明', () => {
  const requested = requestedAgentTurnCancellation({
    id: 'turn-heartbeat-cancel', ownerId: 'user-1', projectId: 'project-1', status: 'running',
    updatedAt: 100,
    execution: {
      generation: 3, leaseToken: 'lease-3', leaseDurationMs: 30_000,
      leaseExpiresAt: 30_100, claimedAt: 100, lastHeartbeatAt: 100,
    },
  }, {
    id: 'turn-heartbeat-cancel', projectId: 'project-1', observedAt: 200,
  }).turn

  const heartbeat = committedAgentTurnExecution(requested, {
    id: requested.id,
    projectId: requested.projectId,
    leaseToken: 'lease-3',
    executionGeneration: 3,
    status: 'running',
    signalId: requested.cancellation.signalId,
    observedAt: 500,
  })
  assert.equal(heartbeat.kind, 'cancellation_heartbeat')
  assert.equal(heartbeat.turn.status, 'cancelling')
  assert.equal(heartbeat.turn.execution.leaseExpiresAt, 30_500)
  assert.equal(heartbeat.turn.cancellation.lastHeartbeatAt, 500)

  for (const command of [
    { leaseToken: 'wrong', executionGeneration: 3, signalId: requested.cancellation.signalId },
    { leaseToken: 'lease-3', executionGeneration: 2, signalId: requested.cancellation.signalId },
    { leaseToken: 'lease-3', executionGeneration: 3, signalId: 'wrong' },
  ]) {
    const stale = committedAgentTurnExecution(heartbeat.turn, {
      id: requested.id,
      projectId: requested.projectId,
      status: 'running',
      observedAt: 600,
      ...command,
    })
    assert.equal(stale.kind, 'stale')
    assert.equal(stale.turn.execution.leaseExpiresAt, 30_500)
  }

  const exited = committedAgentTurnExecution(heartbeat.turn, {
    id: requested.id,
    projectId: requested.projectId,
    leaseToken: 'lease-3',
    executionGeneration: 3,
    status: 'running',
    signalId: requested.cancellation.signalId,
    releaseBasis: 'worker_exit',
    observedAt: 700,
  })
  assert.equal(exited.kind, 'cancellation_acknowledged')
  assert.equal(exited.turn.cancellation.workerReleased, true)
  assert.equal(exited.turn.cancellation.signalAcknowledgedAt, 700)
  assert.equal(exited.turn.cancellation.releaseBasis, 'worker_exit')
  assert.equal(exited.turn.execution.settledAt, 700)
})

test('Turn 取消收口只允许 cancelling→cancelled，并保留 execution 围栏', () => {
  const cancelling = {
    id: 'turn-1', ownerId: 'user-1', projectId: 'project-1', status: 'cancelling', updatedAt: 200,
    execution: { generation: 2, leaseToken: 'lease-2' },
    error: { code: 'AGENT_TURN_CANCELLED', message: '用户取消' },
    cancellation: { status: 'requested', requestedAt: 200, reason: 'user' },
  }
  const finalized = finalizedAgentTurnCancellation(cancelling, {
    id: 'turn-1', projectId: 'project-1', observedAt: 300,
  })
  assert.equal(finalized.kind, 'finalized')
  assert.equal(finalized.turn.status, 'cancelled')
  assert.equal(finalized.turn.execution.leaseToken, 'lease-2')
  assert.equal(finalized.turn.execution.settledAt, 300)
  assert.equal(finalized.turn.cancellation.status, 'completed')
  assert.equal(finalizedAgentTurnCancellation(finalized.turn, {
    id: 'turn-1', projectId: 'project-1', observedAt: 400,
  }).kind, 'replay')
  assert.equal(finalizedAgentTurnCancellation({ ...cancelling, status: 'completed' }, {
    id: 'turn-1', projectId: 'project-1', observedAt: 400,
  }).kind, 'stale')
})

test('有活动 Turn 执行者时 finalizer 等待 worker_exit；heartbeat 停止并按 DB clock 过期后才可替代收口', () => {
  const requested = requestedAgentTurnCancellation({
    id: 'turn-release-proof', ownerId: 'user-1', projectId: 'project-1', status: 'running',
    updatedAt: 100,
    execution: {
      generation: 2, leaseToken: 'lease-2', leaseDurationMs: 30_000,
      leaseExpiresAt: 30_100, claimedAt: 100, lastHeartbeatAt: 100,
    },
  }, {
    id: 'turn-release-proof', projectId: 'project-1', observedAt: 200,
  }).turn
  const heartbeat = committedAgentTurnExecution(requested, {
    id: requested.id, projectId: requested.projectId,
    leaseToken: 'lease-2', executionGeneration: 2, status: 'running',
    signalId: requested.cancellation.signalId, observedAt: 500,
  }).turn

  const pending = finalizedAgentTurnCancellation(heartbeat, {
    id: requested.id, projectId: requested.projectId, observedAt: 30_499,
  })
  assert.equal(pending.kind, 'pending')
  assert.equal(pending.turn.status, 'cancelling')

  const expired = finalizedAgentTurnCancellation(heartbeat, {
    id: requested.id, projectId: requested.projectId, observedAt: 30_500,
  })
  assert.equal(expired.kind, 'finalized')
  assert.equal(expired.turn.status, 'cancelled')
  assert.equal(expired.turn.cancellation.workerReleased, true)
  assert.equal(expired.turn.cancellation.releaseBasis, 'lease_expired')

  const exited = committedAgentTurnExecution(heartbeat, {
    id: requested.id, projectId: requested.projectId,
    leaseToken: 'lease-2', executionGeneration: 2, status: 'running',
    signalId: requested.cancellation.signalId, releaseBasis: 'worker_exit', observedAt: 800,
  }).turn
  const finalized = finalizedAgentTurnCancellation(exited, {
    id: requested.id, projectId: requested.projectId, observedAt: 801,
  })
  assert.equal(finalized.kind, 'finalized')
  assert.equal(finalized.turn.cancellation.releaseBasis, 'worker_exit')

  for (const status of ['queued', 'waiting_user', 'completed']) {
    const noExecutor = requestedAgentTurnCancellation({
      id: `turn-${status}`, ownerId: 'user-1', projectId: 'project-1', status,
      updatedAt: 100,
      ...(status === 'queued' ? {} : { execution: { generation: 1, leaseToken: 'settled', settledAt: 90 } }),
    }, {
      id: `turn-${status}`, projectId: 'project-1', observedAt: 200,
    }).turn
    assert.equal(noExecutor.cancellation.signalRequired, undefined, status)
    const outcome = finalizedAgentTurnCancellation(noExecutor, {
      id: noExecutor.id, projectId: noExecutor.projectId, observedAt: 201,
    })
    assert.equal(outcome.kind, 'finalized', status)
    assert.equal(outcome.turn.cancellation.releaseBasis, undefined, status)
  }
})
