import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentRouteHandler } from '../../http/agentRoutes.mjs'
import { createConfiguredMcpRuntime, parseMcpToolConfigurations } from '../../mcpClient.mjs'
import { agentActionReconciliationIdentity } from './agentActionReconciliation.mjs'
import {
  agentActionManualRetryConsumptionDecision,
  agentActionReceiptClaimDecision,
  agentActionReceiptResolutionDecision,
  settledAgentActionReceipt,
} from '../../store/productStoreContract.mjs'

const user = { id: 'user-action-route' }
const projectId = 'project-action-route'
const sessionId = 'session-action-route'
const messageId = 'message-action-route'
const originalKey = 'agent-action-action-route-skill_apply'
const retryKey = 'agent-action-manual-retry-action-route-attempt-1'

function proposal(overrides = {}) {
  return {
    id: 'action-route',
    kind: 'skill',
    toolName: 'skill_apply',
    label: '应用受控编辑 Skill',
    summary: '应用受控编辑 Skill',
    risk: 'write',
    arguments: { skillId: 'controlled_edit' },
    status: 'running',
    ...overrides,
  }
}

function requestBody(action, overrides = {}) {
  return {
    projectId,
    sessionId,
    messageId,
    actionId: action.id,
    name: action.toolName,
    toolCallId: action.id,
    arguments: action.arguments,
    ...overrides,
  }
}

function withoutActionContext(body) {
  const { sessionId: _sessionId, messageId: _messageId, actionId: _actionId, ...standalone } = body
  return standalone
}

function actionIdentity(action, idempotencyKey = originalKey) {
  return agentActionReconciliationIdentity({
    userId: user.id,
    projectId,
    sessionId,
    messageId,
    actionId: action.id,
    toolCallId: action.id,
    name: action.toolName,
    arguments: action.arguments,
    idempotencyKey,
  })
}

function receiptFor(action, idempotencyKey, status, overrides = {}) {
  const identity = actionIdentity(action, idempotencyKey)
  return {
    id: identity.receiptId,
    ownerId: user.id,
    projectId,
    toolCallId: action.id,
    actionName: action.toolName,
    intentHash: identity.intentHash,
    actionBindingHash: identity.actionBindingHash,
    replayPolicy: 'never',
    status,
    createdAt: 100,
    updatedAt: 100,
    ...structuredClone(overrides),
  }
}

function createStore(action, initialReceipts = [], options = {}) {
  const receipts = new Map(initialReceipts.map((receipt) => [receipt.id, structuredClone(receipt)]))
  const calls = { claims: 0, settles: 0, resolves: 0, consumes: 0 }
  const state = {
    sessions: [{
      id: sessionId,
      messages: [{ id: messageId, plan: { actions: [action] } }],
    }],
  }
  return {
    receipts,
    calls,
    state,
    async projectAccess() { return { exists: true, role: options.role ?? 'owner' } },
    async listAgentSkills() { return [] },
    async readAgentState() { return structuredClone(state) },
    async readAgentActionReceipt(ownerId, receiptId) {
      const receipt = receipts.get(receiptId)
      return receipt?.ownerId === ownerId ? structuredClone(receipt) : undefined
    },
    async claimAgentActionReceipt(ownerId, claim) {
      calls.claims += 1
      const current = receipts.get(claim.id)
      const decision = agentActionReceiptClaimDecision(current, { ...claim, ownerId })
      if (decision.changed) receipts.set(claim.id, structuredClone(decision.receipt))
      return structuredClone(decision)
    },
    async settleAgentActionReceipt(ownerId, settlement) {
      calls.settles += 1
      const current = receipts.get(settlement.id)
      if (!current || current.ownerId !== ownerId || current.leaseToken !== settlement.leaseToken) {
        throw new Error('stale action lease')
      }
      const receipt = settledAgentActionReceipt(current, settlement)
      receipts.set(receipt.id, structuredClone(receipt))
      return structuredClone(receipt)
    },
    async resolveAgentActionReceipt(ownerId, command) {
      calls.resolves += 1
      const current = receipts.get(command.id)
      const decision = agentActionReceiptResolutionDecision(current, { ...command, ownerId, actorId: ownerId })
      if (decision.changed) receipts.set(command.id, structuredClone(decision.receipt))
      return structuredClone(decision)
    },
    async consumeAgentActionManualRetryAuthorization(ownerId, command) {
      calls.consumes += 1
      const current = receipts.get(command.id)
      const decision = agentActionManualRetryConsumptionDecision(current, { ...command, ownerId, actorId: ownerId })
      if (decision.changed) receipts.set(command.id, structuredClone(decision.receipt))
      return structuredClone(decision)
    },
  }
}

function createHarness(action, store, config = {}, options = {}) {
  let body
  const responses = []
  const handler = createAgentRouteHandler({
    config,
    productStore: store,
    configuredMcpTools: options.configuredMcpTools,
    json: (_response, status, payload) => { responses.push({ status, body: payload }); return true },
    error: (_response, status, code, message) => { responses.push({ status, body: { error: { code, message } } }); return true },
    readJson: async () => structuredClone(body),
    text: (value) => String(value),
    requireUser: async () => user,
  })
  return {
    responses,
    async call(path, idempotencyKey, nextBody = requestBody(action)) {
      body = nextBody
      return handler(
        { method: 'POST', headers: { 'idempotency-key': idempotencyKey } },
        {},
        new URL(`http://botanic.test${path}`),
        {},
        'request-action-reconciliation',
      )
    },
  }
}

test('Action status 精确绑定 session/message/action，权限或任一身份错配都拒绝', async () => {
  const action = proposal()
  const viewer = createHarness(action, createStore(action, [], { role: 'viewer' }))
  await assert.rejects(
    viewer.call('/api/agent-actions/status', originalKey),
    (caught) => caught?.code === 'PROJECT_ACCESS_FORBIDDEN',
  )

  const harness = createHarness(action, createStore(action))
  await assert.rejects(
    harness.call('/api/agent-actions/status', originalKey, requestBody(action, { messageId: 'message-forged' })),
    (caught) => caught?.code === 'ACTION_PROPOSAL_NOT_FOUND',
  )
  await assert.rejects(
    harness.call('/api/agent-actions/status', originalKey, requestBody(action, { arguments: { skillId: 'forged' } })),
    (caught) => caught?.code === 'ACTION_PROPOSAL_MISMATCH',
  )
})

test('Action approval 携带 context 时也必须精确绑定权威 proposal', async () => {
  const action = proposal({
    kind: 'mcp',
    toolName: 'mcp_call',
    risk: 'external',
    arguments: { server: 'assets', tool: 'search', arguments: { query: 'botanic' } },
  })
  const store = createStore(action)
  const harness = createHarness(action, store, { agentActionApprovalSecret: 'route-test-secret' })
  const idempotencyKey = `agent-action-${action.id}-${action.toolName}`

  await assert.rejects(
    harness.call('/api/agent-action-approvals', idempotencyKey, requestBody(action, { sessionId: 'session-forged' })),
    (caught) => caught?.code === 'ACTION_PROPOSAL_NOT_FOUND',
  )
  await harness.call('/api/agent-action-approvals', idempotencyKey)

  assert.equal(harness.responses[0].status, 200)
  assert.match(harness.responses[0].body.approval.token, /\./u)
})

test('MCP Proposal 绑定旧 capability 后配置漂移，审批也不能把它执行到新能力', async () => {
  const oldRuntime = createConfiguredMcpRuntime(parseMcpToolConfigurations([{
    server: 'assets', tool: 'search', version: '1', url: 'https://old-mcp.example/rpc',
  }]))
  let externalCalls = 0
  const currentRuntime = createConfiguredMcpRuntime(parseMcpToolConfigurations([{
    server: 'assets', tool: 'search', version: '2', url: 'https://new-mcp.example/rpc',
  }]), {
    fetchImpl: async () => { externalCalls += 1; throw new Error('不应外呼') },
  })
  const oldDescriptor = oldRuntime.catalog()[0]
  const action = proposal({
    kind: 'mcp', toolName: 'mcp_call', risk: 'external', status: 'running',
    arguments: {
      server: 'assets', tool: 'search', arguments: { query: 'botanic' },
      version: oldDescriptor.version, capabilityHash: oldDescriptor.capabilityHash,
    },
  })
  const idempotencyKey = `agent-action-${action.id}-${action.toolName}`
  const store = createStore(action)
  const harness = createHarness(action, store, { agentActionApprovalSecret: 'mcp-stale-secret' }, {
    configuredMcpTools: currentRuntime,
  })

  await harness.call('/api/agent-action-approvals', idempotencyKey)
  const approval = harness.responses.at(-1).body.approval
  await assert.rejects(
    harness.call('/api/agent-actions', idempotencyKey, requestBody(action, { confirmed: true, approval })),
    (error) => error.code === 'MCP_CAPABILITY_STALE' && error.statusCode === 409,
  )
  assert.equal(externalCalls, 0)
  assert.equal([...store.receipts.values()].at(-1).status, 'failed')
})

test('Action status 只回读 succeeded Receipt.result，忽略客户端伪造身份且不重放工具', async () => {
  const action = proposal({ status: 'succeeded' })
  const execution = {
    output: { message: '已从持久回执恢复。' },
    toolCall: { id: action.id, name: action.toolName, status: 'completed' },
  }
  const store = createStore(action, [receiptFor(action, originalKey, 'succeeded', { result: execution })])
  const harness = createHarness(action, store)

  await harness.call('/api/agent-actions/status', originalKey, requestBody(action, {
    receiptId: 'attacker-receipt', intentHash: 'attacker-intent', actionBindingHash: 'attacker-binding',
  }))

  assert.equal(harness.responses[0].status, 200)
  assert.equal(harness.responses[0].body.status.status, 'succeeded')
  assert.deepEqual(harness.responses[0].body.execution, execution)
  assert.equal(store.calls.claims, 0)
  assert.equal(store.calls.settles, 0)
})

test('contextual status/resolve 严格要求持久 Receipt 具备完整 action binding', async () => {
  const action = proposal({ status: 'uncertain' })
  const legacyReceipt = receiptFor(action, originalKey, 'uncertain')
  delete legacyReceipt.actionBindingHash
  const store = createStore(action, [legacyReceipt])
  const harness = createHarness(action, store)

  await assert.rejects(
    harness.call('/api/agent-actions/status', originalKey),
    (caught) => caught?.code === 'AGENT_ACTION_RECONCILIATION_SCOPE_MISMATCH',
  )
  await assert.rejects(
    harness.call('/api/agent-actions/resolve', originalKey, requestBody(action, { decision: 'confirmed_applied' })),
    (caught) => caught?.code === 'AGENT_ACTION_RECONCILIATION_SCOPE_MISMATCH',
  )
  assert.equal(store.calls.resolves, 0)
})

test('uncertain 原回执决议仅返回一次 token，Store 不持久原文', async () => {
  const action = proposal({ status: 'uncertain' })
  const store = createStore(action, [receiptFor(action, originalKey, 'uncertain')])
  const harness = createHarness(action, store)
  const resolveBody = requestBody(action, { decision: 'confirmed_not_applied' })

  await harness.call('/api/agent-actions/resolve', originalKey, resolveBody)
  await harness.call('/api/agent-actions/resolve', originalKey, resolveBody)

  const token = harness.responses[0].body.manualRetryAuthorization?.token
  const stored = store.receipts.get(actionIdentity(action).receiptId)
  assert.equal(typeof token, 'string')
  assert.equal(token.length > 32, true)
  assert.equal(harness.responses[1].body.replayed, true)
  assert.equal(harness.responses[1].body.manualRetryAuthorization, undefined)
  assert.equal(JSON.stringify(stored).includes(token), false)
  assert.equal(stored.status, 'failed')
})

test('一次性手动重试先原子 consume 再执行：同回执传输重放幂等，换回执拒绝', async () => {
  const action = proposal({ status: 'uncertain' })
  const store = createStore(action, [receiptFor(action, originalKey, 'uncertain')])
  const harness = createHarness(action, store)
  await harness.call('/api/agent-actions/resolve', originalKey, requestBody(action, { decision: 'confirmed_not_applied' }))
  const token = harness.responses[0].body.manualRetryAuthorization.token
  action.status = 'running'
  action.receiptIdempotencyKey = retryKey
  const retryBody = requestBody(action, { confirmed: true, manualRetryAuthorization: { token } })

  await harness.call('/api/agent-actions', retryKey, retryBody)
  await harness.call('/api/agent-actions', retryKey, retryBody)

  const original = store.receipts.get(actionIdentity(action, originalKey).receiptId)
  const retry = store.receipts.get(actionIdentity(action, retryKey).receiptId)
  assert.equal(store.calls.consumes, 2, '同回执第二次 consume 是原子 replay')
  assert.equal(store.calls.claims, 2, '执行回执第二次只命中 succeeded replay')
  assert.equal(store.calls.settles, 1, '工具只执行并结算一次')
  assert.equal(original.manualRetryAuthorization.consumedByReceiptId, retry.id)
  assert.equal(retry.status, 'succeeded')
  assert.deepEqual(harness.responses.at(-1).body, harness.responses.at(-2).body)

  await assert.rejects(
    harness.call('/api/agent-actions', 'agent-action-manual-retry-action-route-attempt-2', retryBody),
    (caught) => caught?.code === 'AGENT_ACTION_MANUAL_RETRY_ALREADY_CONSUMED',
  )
})

test('v2 预留不下发 token：fresh approval 后消费，consume→claim 失败可用同 key 无 token 恢复', async () => {
  let externalCalls = 0
  const mcpRuntime = createConfiguredMcpRuntime(parseMcpToolConfigurations([{
    server: 'assets', tool: 'search', version: '2', url: 'https://mcp.example/rpc',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { query: { type: 'string', maxLength: 80 } }, required: ['query'],
    },
  }]), {
    idFactory: () => 'request-route-mcp',
    fetchImpl: async () => {
      externalCalls += 1
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: 'request-route-mcp', result: { content: [{ type: 'text', text: 'found' }] },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  })
  const descriptor = mcpRuntime.catalog()[0]
  const action = proposal({
    status: 'uncertain',
    kind: 'mcp',
    toolName: 'mcp_call',
    risk: 'external',
    arguments: {
      server: 'assets', tool: 'search', arguments: { query: 'botanic' },
      version: descriptor.version, capabilityHash: descriptor.capabilityHash,
    },
  })
  const mcpOriginalKey = `agent-action-${action.id}-${action.toolName}`
  const store = createStore(action, [receiptFor(action, mcpOriginalKey, 'uncertain')])
  const retryIdentity = actionIdentity(action, retryKey)
  const baseClaim = store.claimAgentActionReceipt.bind(store)
  let failClaimOnce = true
  store.claimAgentActionReceipt = async (ownerId, claim) => {
    if (claim.id === retryIdentity.receiptId && failClaimOnce) {
      failClaimOnce = false
      throw Object.assign(new Error('simulated crash before claim'), { code: 'AGENT_ACTION_ATOMIC_CLAIM_REQUIRED' })
    }
    return baseClaim(ownerId, claim)
  }
  const secret = 'v2-route-approval-secret'
  const harness = createHarness(action, store, { agentActionApprovalSecret: secret }, {
    configuredMcpTools: mcpRuntime,
  })
  const resolveBody = requestBody(action, {
    decision: 'confirmed_not_applied',
    preparedRetryIdempotencyKey: retryKey,
  })

  await harness.call('/api/agent-actions/resolve', mcpOriginalKey, resolveBody)
  await harness.call('/api/agent-actions/resolve', mcpOriginalKey, resolveBody)

  assert.deepEqual(harness.responses[0].body.manualRetryReservation, {
    retryIdempotencyKey: retryKey,
    expiresAt: harness.responses[0].body.status.manualRetry.expiresAt,
  })
  assert.equal(harness.responses[0].body.manualRetryAuthorization, undefined)
  assert.equal(harness.responses[1].body.replayed, true)
  assert.equal(harness.responses[1].body.manualRetryAuthorization, undefined)
  const original = store.receipts.get(actionIdentity(action, mcpOriginalKey).receiptId)
  assert.equal(original.manualRetryAuthorization.version, 2)
  assert.equal(original.manualRetryAuthorization.boundRetryReceiptId, retryIdentity.receiptId)
  assert.equal(original.manualRetryAuthorization.tokenHash, undefined)

  action.status = 'running'
  action.receiptIdempotencyKey = retryKey
  const retryBody = requestBody(action, { confirmed: true })
  await assert.rejects(
    harness.call('/api/agent-actions', retryKey, retryBody),
    (caught) => caught?.code === 'ACTION_APPROVAL_REQUIRED',
  )
  assert.equal(store.calls.consumes, 0, 'fresh approval 必须先于一次性授权消费')

  await harness.call('/api/agent-action-approvals', retryKey, retryBody)
  const approval = harness.responses.at(-1).body.approval
  await assert.rejects(
    harness.call('/api/agent-actions', retryKey, { ...retryBody, approval }),
    (caught) => caught?.code === 'AGENT_ACTION_CLAIM_FAILED' && caught?.statusCode === 503,
  )
  assert.equal(store.calls.consumes, 1, '首次失败发生在 durable consume 之后')
  assert.equal(externalCalls, 0, '未取得 claim 前不得执行外部工具')

  await harness.call('/api/agent-actions', retryKey, { ...retryBody, approval })
  await harness.call('/api/agent-actions', retryKey, { ...retryBody, approval })

  assert.equal(store.calls.consumes, 3, '同一 bound receipt 的恢复与传输重放都走原子 replay')
  assert.equal(externalCalls, 1)
  assert.equal(store.receipts.get(retryIdentity.receiptId).status, 'succeeded')

  const otherKey = 'agent-action-manual-retry-action-route-v2-other'
  await harness.call('/api/agent-action-approvals', otherKey, retryBody)
  const otherApproval = harness.responses.at(-1).body.approval
  await assert.rejects(
    harness.call('/api/agent-actions', otherKey, { ...retryBody, approval: otherApproval }),
    (caught) => caught?.code === 'AGENT_ACTION_MANUAL_RETRY_ALREADY_CONSUMED',
  )
  assert.equal(externalCalls, 1)
})

test('consume 后 claim 前退出：status 只返恢复信号，同 retry key 可无 raw token 恢复且仍只执行一次', async () => {
  const action = proposal({ status: 'running', receiptIdempotencyKey: retryKey })
  const originalIdentity = actionIdentity(action, originalKey)
  const retryIdentity = actionIdentity(action, retryKey)
  const original = receiptFor(action, originalKey, 'failed', {
    actionBindingHash: originalIdentity.actionBindingHash,
    resolution: {
      version: 1,
      decision: 'confirmed_not_applied',
      actorId: user.id,
      actionBindingHash: originalIdentity.actionBindingHash,
      resolvedAt: 100,
    },
    manualRetryAuthorization: {
      version: 1,
      id: 'manual-auth-crash-window',
      receiptId: originalIdentity.receiptId,
      intentHash: originalIdentity.intentHash,
      actionBindingHash: originalIdentity.actionBindingHash,
      userId: user.id,
      projectId,
      actionId: action.id,
      tokenHash: 'x'.repeat(43),
      issuedAt: 100,
      expiresAt: 10_000,
      consumedAt: 200,
      consumedByReceiptId: retryIdentity.receiptId,
    },
  })
  const store = createStore(action, [original])
  const harness = createHarness(action, store)

  await assert.rejects(
    harness.call('/api/agent-actions/status', retryKey),
    (caught) => caught?.code === 'AGENT_ACTION_MANUAL_RETRY_RECEIPT_PENDING' && caught?.statusCode === 409,
  )
  assert.equal(store.calls.claims, 0, '状态查询不得代替执行')

  const recoveryBody = requestBody(action, { confirmed: true })
  await harness.call('/api/agent-actions', retryKey, recoveryBody)
  await harness.call('/api/agent-actions', retryKey, recoveryBody)

  assert.equal(store.receipts.get(retryIdentity.receiptId).status, 'succeeded')
  assert.equal(store.calls.consumes, 0, '授权已消费，恢复不再伪造第二次 consume')
  assert.equal(store.calls.settles, 1)
})

test('手动重试回执只能由 consumedByReceiptId 观察/决议，再次未生效时标记 exhausted 且不签第二个 token', async () => {
  const action = proposal({ status: 'uncertain', receiptIdempotencyKey: retryKey })
  const originalIdentity = actionIdentity(action, originalKey)
  const retryIdentity = actionIdentity(action, retryKey)
  const authorization = {
    version: 1,
    id: 'manual-auth-route',
    receiptId: originalIdentity.receiptId,
    intentHash: originalIdentity.intentHash,
    actionBindingHash: originalIdentity.actionBindingHash,
    userId: user.id,
    projectId,
    actionId: action.id,
    tokenHash: 'x'.repeat(43),
    issuedAt: 100,
    expiresAt: 10_000,
    consumedAt: 200,
    consumedByReceiptId: retryIdentity.receiptId,
  }
  const original = receiptFor(action, originalKey, 'failed', {
    actionBindingHash: originalIdentity.actionBindingHash,
    resolution: {
      version: 1,
      decision: 'confirmed_not_applied',
      actorId: user.id,
      actionBindingHash: originalIdentity.actionBindingHash,
      resolvedAt: 100,
    },
    manualRetryAuthorization: authorization,
  })
  const retry = receiptFor(action, retryKey, 'uncertain')
  const store = createStore(action, [original, retry])
  const harness = createHarness(action, store)

  await harness.call('/api/agent-actions/status', retryKey)
  await harness.call('/api/agent-actions/resolve', retryKey, requestBody(action, { decision: 'confirmed_not_applied' }))

  const storedRetry = store.receipts.get(retryIdentity.receiptId)
  assert.equal(harness.responses[0].body.status.status, 'uncertain')
  assert.equal(harness.responses[1].body.manualRetryAuthorization, undefined)
  assert.equal(storedRetry.status, 'failed')
  assert.equal(storedRetry.error.code, 'AGENT_ACTION_MANUAL_RETRY_EXHAUSTED')
  assert.equal(storedRetry.resolution.manualRetryExhausted, true)

  const arbitraryKey = 'agent-action-manual-retry-action-route-forged'
  const arbitrary = receiptFor(action, arbitraryKey, 'uncertain')
  store.receipts.set(arbitrary.id, arbitrary)
  await assert.rejects(
    harness.call('/api/agent-actions/status', arbitraryKey),
    (caught) => caught?.code === 'AGENT_ACTION_MANUAL_RETRY_UNAVAILABLE',
  )
})

test('contextual Action 新回执没有 raw token 直接拒绝，原回执也不接受手动 token', async () => {
  const action = proposal()
  const store = createStore(action)
  const harness = createHarness(action, store)
  await assert.rejects(
    harness.call('/api/agent-actions', retryKey, requestBody(action, { confirmed: true })),
    (caught) => caught?.code === 'AGENT_ACTION_MANUAL_RETRY_REQUIRED',
  )
  await assert.rejects(
    harness.call('/api/agent-actions', originalKey, requestBody(action, {
      confirmed: true, manualRetryAuthorization: { token: 'forged-token' },
    })),
    (caught) => caught?.code === 'AGENT_ACTION_MANUAL_RETRY_IDEMPOTENCY_REUSED',
  )
  assert.equal(store.calls.claims, 0)
})

test('省略 context 也会反查权威 Proposal：新 key 不能绕过 token/consumedBy，伪造 toolCallId 拒绝', async () => {
  const action = proposal({ status: 'running' })
  const store = createStore(action)
  const harness = createHarness(action, store)
  const noContext = withoutActionContext(requestBody(action, { confirmed: true }))

  await assert.rejects(
    harness.call('/api/agent-actions', retryKey, noContext),
    (caught) => caught?.code === 'AGENT_ACTION_MANUAL_RETRY_REQUIRED',
  )
  await assert.rejects(
    harness.call('/api/agent-actions', originalKey, {
      ...noContext,
      toolCallId: 'action-forged',
    }),
    (caught) => caught?.code === 'ACTION_PROPOSAL_NOT_FOUND',
  )
  assert.equal(store.calls.claims, 0)
})

test('省略 context 的另一新 key 不能绕过已消费授权指向', async () => {
  const action = proposal({ status: 'running', receiptIdempotencyKey: retryKey })
  const originalIdentity = actionIdentity(action, originalKey)
  const authorizedRetry = actionIdentity(action, retryKey)
  const original = receiptFor(action, originalKey, 'failed', {
    actionBindingHash: originalIdentity.actionBindingHash,
    resolution: {
      version: 1,
      decision: 'confirmed_not_applied',
      actorId: user.id,
      actionBindingHash: originalIdentity.actionBindingHash,
      resolvedAt: 100,
    },
    manualRetryAuthorization: {
      version: 1,
      id: 'manual-auth-no-context',
      receiptId: originalIdentity.receiptId,
      intentHash: originalIdentity.intentHash,
      actionBindingHash: originalIdentity.actionBindingHash,
      userId: user.id,
      projectId,
      actionId: action.id,
      tokenHash: 'x'.repeat(43),
      issuedAt: 100,
      expiresAt: 10_000,
      consumedAt: 200,
      consumedByReceiptId: authorizedRetry.receiptId,
    },
  })
  const store = createStore(action, [original])
  const harness = createHarness(action, store)
  const forgedRetryKey = 'agent-action-manual-retry-action-route-attempt-2'

  await assert.rejects(
    harness.call('/api/agent-actions', forgedRetryKey, withoutActionContext(requestBody(action, { confirmed: true }))),
    (caught) => caught?.code === 'AGENT_ACTION_MANUAL_RETRY_REQUIRED',
  )
  assert.equal(store.calls.claims, 0)
})

test('省略 context 的合法 Proposal 仍使用权威 attempt，明确 standalone skill_create 保持兼容', async () => {
  const action = proposal({ status: 'running' })
  const store = createStore(action)
  let createdSkill
  store.putAgentSkill = async (_userId, skill) => {
    createdSkill = structuredClone(skill)
    return structuredClone(skill)
  }
  const harness = createHarness(action, store)

  await harness.call(
    '/api/agent-actions',
    originalKey,
    withoutActionContext(requestBody(action, { confirmed: true })),
  )
  assert.equal(harness.responses[0].status, 200)
  assert.equal(store.calls.settles, 1)

  await harness.call('/api/agent-actions', 'agent-skill-direct-legacy', {
    projectId,
    name: 'skill_create',
    toolCallId: 'call-skill-create-direct',
    confirmed: true,
    arguments: {
      name: '夏日品牌规则',
      instructions: '保持自然光与品牌绿。',
      capabilities: ['write'],
      manifest: { kind: 'guidance', toolAllowlist: ['workflow_create'], dependencies: [] },
    },
  })
  assert.equal(harness.responses[1].status, 200)
  assert.equal(harness.responses[1].body.output.skill.name, '夏日品牌规则')
  assert.deepEqual(createdSkill.capabilities, ['write'])
  assert.deepEqual(createdSkill.manifest, {
    version: 1, kind: 'guidance', toolAllowlist: ['workflow_create'], dependencies: [],
  })
})

test('跨 Session/Message 的同 action id 不得共用 Receipt，省略 context 时也不猜测', async () => {
  const action = proposal({ status: 'succeeded' })
  const execution = { output: { message: 'session-a-result' }, toolCall: { id: action.id, name: action.toolName } }
  const receipt = receiptFor(action, originalKey, 'succeeded', { result: execution })
  const store = createStore(action, [receipt])
  store.state.sessions.push({
    id: 'session-action-route-b',
    messages: [{ id: 'message-action-route-b', plan: { actions: [structuredClone(action)] } }],
  })
  const harness = createHarness(action, store)

  await assert.rejects(
    harness.call('/api/agent-actions/status', originalKey, requestBody(action, {
      sessionId: 'session-action-route-b',
      messageId: 'message-action-route-b',
    })),
    (caught) => caught?.code === 'AGENT_ACTION_RECONCILIATION_SCOPE_MISMATCH',
  )
  await assert.rejects(
    harness.call('/api/agent-actions', originalKey, withoutActionContext(requestBody(action, { confirmed: true }))),
    (caught) => caught?.code === 'ACTION_PROPOSAL_NOT_FOUND',
  )
  assert.equal(store.calls.claims, 0)
})

test('跨 Session/Message 的同 action id 即使 receipt/intent 相同也不能执行第二次', async () => {
  const action = proposal({ status: 'running' })
  const store = createStore(action)
  store.state.sessions.push({
    id: 'session-action-route-b',
    messages: [{ id: 'message-action-route-b', plan: { actions: [structuredClone(action)] } }],
  })
  const harness = createHarness(action, store)

  await harness.call('/api/agent-actions', originalKey, requestBody(action, { confirmed: true }))
  await assert.rejects(
    harness.call('/api/agent-actions', originalKey, requestBody(action, {
      sessionId: 'session-action-route-b',
      messageId: 'message-action-route-b',
      confirmed: true,
    })),
    (caught) => caught?.code === 'AGENT_ACTION_INTENT_CONFLICT',
  )

  assert.equal(store.calls.settles, 1)
})
