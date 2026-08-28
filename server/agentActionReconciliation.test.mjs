import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AgentActionReconciliationError,
  agentActionManualRetryConsumptionDecision,
  agentActionReceiptResolutionDecision,
  agentActionReconciliationIdentity,
  createAgentActionReconciliation,
} from './agentActionReconciliation.mjs'

function originalAction(overrides = {}) {
  return {
    userId: 'user-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    messageId: 'message-1',
    actionId: 'action-1',
    toolCallId: 'action-1',
    name: 'mcp_call',
    arguments: { server: 'notion', tool: 'create_page', input: { title: 'Botanic' } },
    idempotencyKey: 'agent-action-action-1-mcp_call',
    ...overrides,
  }
}

function uncertainReceipt(action = originalAction()) {
  const identity = agentActionReconciliationIdentity(action)
  return {
    id: identity.receiptId,
    ownerId: action.userId,
    projectId: action.projectId,
    toolCallId: identity.toolCallId,
    actionName: identity.actionName,
    intentHash: identity.intentHash,
    actionBindingHash: identity.actionBindingHash,
    replayPolicy: 'never',
    status: 'uncertain',
    error: {
      code: 'AGENT_ACTION_OUTCOME_UNKNOWN',
      message: '行动可能已经生效。',
      statusCode: 409,
    },
    createdAt: 900,
    updatedAt: 1_000,
  }
}

function fakeStore(initialReceipt) {
  const receipts = new Map(initialReceipt ? [[initialReceipt.id, structuredClone(initialReceipt)]] : [])
  const calls = { reads: [], resolutions: [], consumptions: [] }
  return {
    receipts,
    calls,
    async readAgentActionReceipt(userId, receiptId) {
      calls.reads.push({ userId, receiptId })
      const receipt = receipts.get(receiptId)
      return receipt?.ownerId === userId ? structuredClone(receipt) : undefined
    },
    async resolveAgentActionReceipt(userId, resolution) {
      calls.resolutions.push(structuredClone({ userId, resolution }))
      const current = receipts.get(resolution.id)
      const decision = agentActionReceiptResolutionDecision(current, { ...resolution, ownerId: userId })
      if (decision.changed) receipts.set(resolution.id, structuredClone(decision.receipt))
      return structuredClone(decision)
    },
    async consumeAgentActionManualRetryAuthorization(userId, consumption) {
      calls.consumptions.push(structuredClone({ userId, consumption }))
      const current = receipts.get(consumption.id)
      const decision = agentActionManualRetryConsumptionDecision(current, { ...consumption, ownerId: userId })
      if (decision.changed) receipts.set(consumption.id, structuredClone(decision.receipt))
      return structuredClone(decision)
    },
  }
}

test('调和身份由服务端原 action 重算：忽略客户端 receiptId，参数键序不影响摘要', () => {
  const first = agentActionReconciliationIdentity(originalAction({ receiptId: 'attacker-controlled' }))
  const second = agentActionReconciliationIdentity(originalAction({
    receiptId: 'another-attacker-value',
    arguments: { input: { title: 'Botanic' }, tool: 'create_page', server: 'notion' },
  }))

  assert.equal(first.receiptId, second.receiptId)
  assert.notEqual(first.receiptId, 'attacker-controlled')
  assert.equal(first.intentHash, second.intentHash)
  assert.equal(first.actionBindingHash, second.actionBindingHash)

  for (const [field, value] of [
    ['userId', 'user-2'],
    ['projectId', 'project-2'],
    ['sessionId', 'session-2'],
    ['messageId', 'message-2'],
    ['actionId', 'action-2'],
    ['toolCallId', 'call-2'],
    ['name', 'skill_create'],
    ['idempotencyKey', 'agent-action-another-action'],
  ]) {
    assert.notEqual(
      agentActionReconciliationIdentity(originalAction({ [field]: value })).actionBindingHash,
      first.actionBindingHash,
      `${field} 必须绑定到完整 action 摘要`,
    )
  }
})

test('状态读取只返回安全投影，不泄露回执身份、结果、参数或授权摘要', async () => {
  const action = originalAction()
  const receipt = {
    ...uncertainReceipt(action),
    result: { output: { secret: '不应出现' }, artifacts: [{ url: 'https://private.example' }] },
    leaseToken: 'lease-secret',
  }
  const store = fakeStore(receipt)
  const service = createAgentActionReconciliation({ productStore: store, now: () => 1_100 })

  const status = await service.readStatus({ ...action, receiptId: 'wrong-client-id' })

  assert.deepEqual(status.action, {
    sessionId: action.sessionId,
    messageId: action.messageId,
    actionId: action.actionId,
    toolCallId: action.toolCallId,
    name: action.name,
  })
  assert.equal(status.status, 'uncertain')
  assert.equal(status.canResolve, true)
  assert.equal(JSON.stringify(status).includes('secret'), false)
  assert.equal(JSON.stringify(status).includes('receiptId'), false)
  assert.equal(JSON.stringify(status).includes('intentHash'), false)
  assert.deepEqual(store.calls.reads, [{ userId: action.userId, receiptId: receipt.id }])
})

test('confirmed_applied 原子结算为无伪造结果的 succeeded，重复同决议幂等', async () => {
  const action = originalAction()
  const store = fakeStore(uncertainReceipt(action))
  const service = createAgentActionReconciliation({ productStore: store, now: () => 2_000 })

  const first = await service.resolve({ action, decision: 'confirmed_applied' })
  const stored = store.receipts.values().next().value

  assert.equal(first.status.status, 'succeeded')
  assert.equal(first.manualRetryAuthorization, undefined)
  assert.equal(stored.status, 'succeeded')
  assert.equal(stored.result, undefined)
  assert.equal(stored.output, undefined)
  assert.equal(stored.artifacts, undefined)
  assert.deepEqual(stored.resolution, {
    version: 1,
    decision: 'confirmed_applied',
    actorId: action.userId,
    actionBindingHash: agentActionReconciliationIdentity(action).actionBindingHash,
    resolvedAt: 2_000,
  })
  assert.deepEqual(store.calls.resolutions[0].resolution.audit, {
    action: 'agent-action.reconciled',
    detail: { result: 'confirmed_applied', status: 'succeeded', toolCallId: action.toolCallId, toolName: action.name },
  })

  const replay = await service.resolve({ action, decision: 'confirmed_applied' })
  assert.equal(replay.status.status, 'succeeded')
  assert.equal(replay.replayed, true)
  assert.equal(replay.manualRetryAuthorization, undefined)

  await assert.rejects(
    service.resolve({ action, decision: 'confirmed_not_applied' }),
    (caught) => caught instanceof AgentActionReconciliationError
      && caught.code === 'AGENT_ACTION_RECONCILIATION_CONFLICT'
      && caught.statusCode === 409,
  )
})

test('confirmed_not_applied 生成仅返回一次的手动重试 token，Store 只收到哈希摘要', async () => {
  const action = originalAction()
  const store = fakeStore(uncertainReceipt(action))
  const rawToken = 'agent_action_retry_this-token-is-only-returned-once'
  let tokensCreated = 0
  const service = createAgentActionReconciliation({
    productStore: store,
    now: () => 3_000,
    manualRetryTtlMs: 500,
    createToken: () => {
      tokensCreated += 1
      return rawToken
    },
    createAuthorizationId: () => 'manual-retry-1',
  })

  const first = await service.resolve({ action, decision: 'confirmed_not_applied' })
  const stored = store.receipts.values().next().value
  const persistedRequest = store.calls.resolutions[0].resolution

  assert.equal(first.status.status, 'failed')
  assert.deepEqual(first.manualRetryAuthorization, {
    token: rawToken,
    expiresAt: 3_500,
  })
  assert.equal(stored.error.code, 'AGENT_ACTION_CONFIRMED_NOT_APPLIED')
  assert.equal(stored.manualRetryAuthorization.id, 'manual-retry-1')
  assert.notEqual(stored.manualRetryAuthorization.tokenHash, rawToken)
  assert.equal(JSON.stringify(persistedRequest).includes(rawToken), false)
  assert.equal(stored.result, undefined)

  const replay = await service.resolve({ action, decision: 'confirmed_not_applied' })
  assert.equal(replay.replayed, true)
  assert.equal(replay.manualRetryAuthorization, undefined, '幂等重放不能再次返回或重签 token')
  assert.equal(tokensCreated, 1)
})

test('v2 手动重试先持久预留新回执：决议重放不返回 token，同 key 可无 token 消费与恢复', async () => {
  const action = originalAction()
  const retryIdempotencyKey = 'agent-action-retry-action-1-v2-reserved'
  let currentTime = 3_000
  let tokensCreated = 0
  const store = fakeStore(uncertainReceipt(action))
  const service = createAgentActionReconciliation({
    productStore: store,
    now: () => currentTime,
    manualRetryTtlMs: 500,
    createToken: () => {
      tokensCreated += 1
      return 'should-not-create-v2-token'
    },
    createAuthorizationId: () => 'manual-retry-v2-1',
  })

  const first = await service.resolve({
    action,
    decision: 'confirmed_not_applied',
    preparedRetryIdempotencyKey: retryIdempotencyKey,
  })
  const replay = await service.resolve({
    action,
    decision: 'confirmed_not_applied',
    preparedRetryIdempotencyKey: retryIdempotencyKey,
  })
  const originalIdentity = agentActionReconciliationIdentity(action)
  const retryIdentity = agentActionReconciliationIdentity({ ...action, idempotencyKey: retryIdempotencyKey })
  const stored = store.receipts.get(originalIdentity.receiptId)

  assert.equal(first.manualRetryAuthorization, undefined)
  assert.deepEqual(first.manualRetryReservation, {
    retryIdempotencyKey,
    expiresAt: 3_500,
  })
  assert.equal(replay.replayed, true)
  assert.deepEqual(replay.manualRetryReservation, first.manualRetryReservation)
  assert.equal(tokensCreated, 0)
  assert.deepEqual(stored.manualRetryAuthorization, {
    version: 2,
    id: 'manual-retry-v2-1',
    receiptId: originalIdentity.receiptId,
    intentHash: originalIdentity.intentHash,
    actionBindingHash: originalIdentity.actionBindingHash,
    userId: action.userId,
    projectId: action.projectId,
    actionId: action.actionId,
    boundRetryReceiptId: retryIdentity.receiptId,
    reservedAt: 3_000,
    expiresAt: 3_500,
  })

  await assert.rejects(
    service.consumeManualRetryAuthorization({
      action,
      retryIdempotencyKey: 'agent-action-retry-action-1-v2-forged',
    }),
    (caught) => caught?.code === 'AGENT_ACTION_RECONCILIATION_SCOPE_MISMATCH',
  )

  currentTime = 3_200
  const consumed = await service.consumeManualRetryAuthorization({ action, retryIdempotencyKey })
  assert.equal(consumed.retryReceiptId, retryIdentity.receiptId)
  assert.equal(consumed.replayed, undefined)

  currentTime = 4_000
  const recovered = await service.consumeManualRetryAuthorization({ action, retryIdempotencyKey })
  assert.equal(recovered.retryReceiptId, retryIdentity.receiptId)
  assert.equal(recovered.replayed, true, '已消费的同回执恢复不受授权过期影响')

  await assert.rejects(
    service.consumeManualRetryAuthorization({
      action,
      retryIdempotencyKey: 'agent-action-retry-action-1-v2-other-after-consume',
    }),
    (caught) => caught?.code === 'AGENT_ACTION_MANUAL_RETRY_ALREADY_CONSUMED',
  )
})

test('并发不同 v2 预留键只有 Store 胜者可返回，败者不能回显未绑定的 retry key', async () => {
  const action = originalAction()
  const requestedKey = 'agent-action-retry-action-1-v2-loser'
  const winningKey = 'agent-action-retry-action-1-v2-winner'
  const identity = agentActionReconciliationIdentity(action)
  const winningIdentity = agentActionReconciliationIdentity({ ...action, idempotencyKey: winningKey })
  const store = fakeStore(uncertainReceipt(action))
  store.resolveAgentActionReceipt = async (_userId, command) => ({
    kind: 'replay',
    changed: false,
    receipt: {
      ...uncertainReceipt(action),
      status: 'failed',
      resolution: {
        version: 1,
        decision: 'confirmed_not_applied',
        actorId: action.userId,
        actionBindingHash: identity.actionBindingHash,
        resolvedAt: 3_000,
      },
      manualRetryAuthorization: {
        ...command.manualRetryAuthorization,
        boundRetryReceiptId: winningIdentity.receiptId,
      },
    },
  })
  const service = createAgentActionReconciliation({ productStore: store, now: () => 3_000 })

  await assert.rejects(
    service.resolve({
      action,
      decision: 'confirmed_not_applied',
      preparedRetryIdempotencyKey: requestedKey,
    }),
    (caught) => caught?.code === 'AGENT_ACTION_RECONCILIATION_CONFLICT',
  )
})

test('只有 uncertain 可决议，且完整原 action 与回执身份不符时拒绝', async () => {
  const action = originalAction()
  const alreadyFailed = { ...uncertainReceipt(action), status: 'failed' }
  const store = fakeStore(alreadyFailed)
  const service = createAgentActionReconciliation({ productStore: store })

  await assert.rejects(
    service.resolve({ action, decision: 'confirmed_applied' }),
    (caught) => caught?.code === 'AGENT_ACTION_RECONCILIATION_NOT_UNCERTAIN',
  )

  const mismatchedStore = fakeStore({ ...uncertainReceipt(action), intentHash: 'different-intent' })
  const mismatched = createAgentActionReconciliation({ productStore: mismatchedStore })
  await assert.rejects(
    mismatched.readStatus(action),
    (caught) => caught?.code === 'AGENT_ACTION_RECONCILIATION_SCOPE_MISMATCH',
  )
})

test('手动重试授权绑定 receipt/intent/user/project/action/retry receipt，传输重放幂等但换 receipt 拒绝', async () => {
  const action = originalAction()
  let currentTime = 4_000
  const store = fakeStore(uncertainReceipt(action))
  const token = 'agent_action_retry_valid-token-with-enough-entropy'
  const service = createAgentActionReconciliation({
    productStore: store,
    now: () => currentTime,
    manualRetryTtlMs: 1_000,
    createToken: () => token,
    createAuthorizationId: () => 'manual-retry-2',
  })
  await service.resolve({ action, decision: 'confirmed_not_applied' })

  await assert.rejects(
    service.consumeManualRetryAuthorization({
      action,
      token: `${token}-wrong`,
      retryIdempotencyKey: 'agent-action-retry-action-1-wrong-token',
    }),
    (caught) => caught?.code === 'AGENT_ACTION_MANUAL_RETRY_INVALID',
  )

  const retryIdempotencyKey = 'agent-action-retry-action-1-attempt-1'
  const consumed = await service.consumeManualRetryAuthorization({ action, token, retryIdempotencyKey })
  assert.equal(consumed.kind, 'authorized')
  assert.equal(consumed.receiptId, agentActionReconciliationIdentity(action).receiptId)
  assert.equal(consumed.intentHash, agentActionReconciliationIdentity(action).intentHash)
  assert.equal(consumed.actionBindingHash, agentActionReconciliationIdentity(action).actionBindingHash)
  assert.equal(consumed.authorizationId, 'manual-retry-2')
  assert.match(consumed.retryReceiptId, /^agent_action_/u)
  assert.notEqual(consumed.retryReceiptId, consumed.receiptId)
  assert.equal(store.receipts.values().next().value.manualRetryAuthorization.consumedByReceiptId, consumed.retryReceiptId)

  const transportReplay = await service.consumeManualRetryAuthorization({ action, token, retryIdempotencyKey })
  assert.equal(transportReplay.kind, 'authorized')
  assert.equal(transportReplay.replayed, true)
  assert.equal(transportReplay.retryReceiptId, consumed.retryReceiptId)

  await assert.rejects(
    service.consumeManualRetryAuthorization({
      action,
      token,
      retryIdempotencyKey: 'agent-action-retry-action-1-attempt-2',
    }),
    (caught) => caught?.code === 'AGENT_ACTION_MANUAL_RETRY_ALREADY_CONSUMED',
  )

  const otherStore = fakeStore(uncertainReceipt(action))
  const expiring = createAgentActionReconciliation({
    productStore: otherStore,
    now: () => currentTime,
    manualRetryTtlMs: 100,
    createToken: () => token,
  })
  await expiring.resolve({ action, decision: 'confirmed_not_applied' })
  currentTime = 4_101
  await assert.rejects(
    expiring.consumeManualRetryAuthorization({
      action,
      token,
      retryIdempotencyKey: 'agent-action-retry-action-1-expired',
    }),
    (caught) => caught?.code === 'AGENT_ACTION_MANUAL_RETRY_EXPIRED',
  )
})

test('手动重试必须使用新的幂等键，避免 consume 后再 claim 原回执的崩溃窗口', async () => {
  const action = originalAction()
  const store = fakeStore(uncertainReceipt(action))
  const token = 'agent_action_retry_new-receipt-bound-token'
  const service = createAgentActionReconciliation({
    productStore: store,
    now: () => 5_000,
    createToken: () => token,
  })
  await service.resolve({ action, decision: 'confirmed_not_applied' })

  await assert.rejects(
    service.consumeManualRetryAuthorization({
      action,
      token,
      retryIdempotencyKey: action.idempotencyKey,
    }),
    (caught) => caught?.code === 'AGENT_ACTION_MANUAL_RETRY_IDEMPOTENCY_REUSED',
  )
  assert.equal(store.calls.consumptions.length, 0, '复用原回执必须在进入原子消费前拒绝')
})

test('手动重试自身再次 uncertain 只能收口为 exhausted，不签发第二个 token', async () => {
  const original = originalAction()
  const retry = originalAction({ idempotencyKey: 'agent-action-retry-action-1-exhausted' })
  const store = fakeStore(uncertainReceipt(original))
  const token = 'agent_action_retry_exhaustion-token-with-entropy'
  const service = createAgentActionReconciliation({
    productStore: store,
    now: () => 6_000,
    createToken: () => token,
  })
  await service.resolve({ action: original, decision: 'confirmed_not_applied' })
  await service.consumeManualRetryAuthorization({
    action: original,
    token,
    retryIdempotencyKey: retry.idempotencyKey,
  })
  const retryReceipt = uncertainReceipt(retry)
  store.receipts.set(retryReceipt.id, retryReceipt)

  const exhausted = await service.resolve({
    action: retry,
    manualRetryOf: original,
    decision: 'confirmed_not_applied',
  })
  const stored = store.receipts.get(retryReceipt.id)

  assert.equal(exhausted.manualRetryAuthorization, undefined)
  assert.equal(exhausted.status.status, 'failed')
  assert.equal(stored.error.code, 'AGENT_ACTION_MANUAL_RETRY_EXHAUSTED')
  assert.equal(stored.resolution.manualRetryExhausted, true)
})

test('返回给客户端的授权过期时间以 Adapter 权威时钟为准', async () => {
  const action = originalAction()
  const store = fakeStore(uncertainReceipt(action))
  const baseResolve = store.resolveAgentActionReceipt.bind(store)
  store.resolveAgentActionReceipt = (userId, command) => baseResolve(userId, {
    ...command,
    resolvedAt: 7_000,
    manualRetryAuthorization: command.manualRetryAuthorization
      ? { ...command.manualRetryAuthorization, issuedAt: 7_000, expiresAt: 7_777 }
      : undefined,
  })
  const service = createAgentActionReconciliation({
    productStore: store,
    now: () => 6_000,
    manualRetryTtlMs: 500,
    createToken: () => 'agent_action_retry_adapter-clock-token',
  })

  const result = await service.resolve({ action, decision: 'confirmed_not_applied' })

  assert.equal(result.manualRetryAuthorization.expiresAt, 7_777)
  assert.equal(result.status.manualRetry.expiresAt, 7_777)
})

test('v2 预留响应也只返回 Adapter 权威过期时间', async () => {
  const action = originalAction()
  const store = fakeStore(uncertainReceipt(action))
  const baseResolve = store.resolveAgentActionReceipt.bind(store)
  store.resolveAgentActionReceipt = (userId, command) => baseResolve(userId, {
    ...command,
    resolvedAt: 8_000,
    manualRetryAuthorization: command.manualRetryAuthorization
      ? { ...command.manualRetryAuthorization, reservedAt: 8_000, expiresAt: 8_888 }
      : undefined,
  })
  const service = createAgentActionReconciliation({
    productStore: store,
    now: () => 6_000,
    manualRetryTtlMs: 500,
  })

  const result = await service.resolve({
    action,
    decision: 'confirmed_not_applied',
    preparedRetryIdempotencyKey: 'agent-action-retry-action-1-adapter-clock-v2',
  })

  assert.equal(result.manualRetryAuthorization, undefined)
  assert.equal(result.manualRetryReservation.expiresAt, 8_888)
  assert.equal(result.status.manualRetry.expiresAt, 8_888)
})
