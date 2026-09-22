import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentToolChoiceShadow } from './agentToolChoiceShadow.mjs'
import { createRolloutFlags } from '../../featureFlags.mjs'
import { agentActionReceiptClaimDecision, settledAgentActionReceipt } from '../../store/productStoreContract.mjs'

function setup() {
  const receipts = new Map(), requests = [], events = [], quotas = []
  const state = { status: 'completed', role: 'owner', allowed: true, malformed: false, failSettlement: false }
  const deps = {
    config: { flockApiKey: 'test-only', flockApiBaseUrl: 'https://api.flock.io/v1',
      rolloutFlags: createRolloutFlags({ AGENT_TOOL_CHOICE_SHADOW: 'true' }), agentToolChoiceShadowSamplePercent: 100 },
    productStore: {
      projectAccess: async () => ({ role: state.role }),
      readAgentTurn: async () => ({ status: state.status }),
      claimAgentActionReceipt: async (userId, claim) => {
        const decision = agentActionReceiptClaimDecision(receipts.get(claim.id), { ...claim, ownerId: userId })
        if (decision.changed) receipts.set(claim.id, decision.receipt)
        return structuredClone(decision)
      },
      settleAgentActionReceipt: async (_userId, settlement) => {
        if (state.failSettlement) throw new Error('synthetic_store_failure')
        const prior = receipts.get(settlement.id)
        assert.equal(prior.leaseToken, settlement.leaseToken)
        const next = settledAgentActionReceipt(prior, settlement)
        receipts.set(settlement.id, next)
        return next
      },
    },
    securityControls: { consume: async (quota) => { quotas.push(quota); return { allowed: state.allowed } } },
    provider: { sample: async (request) => {
      requests.push(request)
      if (state.malformed) return { choices: [] }
      const label = '是，请求需要这项能力'
      return { choices: [{ message: { content: JSON.stringify({ intent: label }) } }],
        this_that: { choice: label, confidence: 0.8, probabilities: { [label]: 0.8, '否，请求不需要这项能力': 0.2 } },
        usage: { prompt_tokens: 100 } }
    } },
    observe: (event) => events.push(event),
  }
  const input = { identity: { userId: 'u1', projectId: 'p1', turnId: 't1' },
    request: { inputMessage: { content: '比较当前画布两张卡片' }, document: 'private-document', messages: ['private-history'] },
    toolNames: ['canvas_query', 'ask_clarification'], toolCalls: [{ name: 'canvas_query', arguments: 'private-arguments' }] }
  return { deps, input, state, receipts, requests, events, quotas }
}

test('旁路基于实际授权目录，回执跨实例去重；记录不含正文/参数且不修改主路径', async () => {
  const s = setup(), before = structuredClone(s.input)
  await createAgentToolChoiceShadow(s.deps)(s.input)
  await createAgentToolChoiceShadow(s.deps)(s.input)
  assert.equal(s.requests.length, 2)
  assert.equal(s.quotas.length, 1)
  assert.equal(s.quotas[0].cost, 2)
  assert.equal(s.quotas[0].requireShared, true)
  const receipt = [...s.receipts.values()][0]
  assert.equal(receipt.replayPolicy, 'never')
  assert.equal(receipt.result.outcome, 'completed')
  assert.equal(receipt.result.disagreementCount, 1)
  assert.deepEqual(s.input, before)
  assert.ok(!JSON.stringify(s.requests).includes('private-'))
  assert.ok(!JSON.stringify([receipt, s.events]).includes(s.input.request.inputMessage.content))
  assert.ok(!JSON.stringify([receipt, s.events]).includes('private-'))
})

test('关闭、无权限、配额失效、取消、畸形响应和落账故障都不影响主链路或重复计费', async () => {
  const off = setup()
  off.deps.config.rolloutFlags = createRolloutFlags()
  await createAgentToolChoiceShadow(off.deps)(off.input)
  assert.equal(off.requests.length, 0)
  for (const change of [s => { s.state.role = 'viewer' }, s => { s.state.allowed = false },
    s => { s.state.status = 'cancelled' }, s => { s.input.toolNames.push('unknown_private_tool') },
    s => { s.input.signal = AbortSignal.abort() }]) {
    const s = setup(); change(s)
    await createAgentToolChoiceShadow(s.deps)(s.input)
    assert.equal(s.requests.length, 0)
  }
  const malformed = setup(); malformed.state.malformed = true
  await createAgentToolChoiceShadow(malformed.deps)(malformed.input)
  await createAgentToolChoiceShadow(malformed.deps)(malformed.input)
  assert.equal(malformed.requests.length, 1)
  assert.equal([...malformed.receipts.values()][0].result.dispatchedWithoutValidResult, 1)
  const lost = setup(); lost.state.failSettlement = true
  await createAgentToolChoiceShadow(lost.deps)(lost.input)
  await createAgentToolChoiceShadow(lost.deps)(lost.input)
  assert.equal(lost.requests.length, 2)
  assert.equal([...lost.receipts.values()][0].status, 'running')
})
