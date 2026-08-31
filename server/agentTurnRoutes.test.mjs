import assert from 'node:assert/strict'
import test from 'node:test'
import { agentTurnStreamSettlementEvent, createAgentTurnHttpAdapter } from './agentTurnRoutes.mjs'

test('非终态 Turn 只发送 handoff，业务终态才发送 done', () => {
  for (const status of ['queued', 'running', 'waiting_user', 'cancelling']) {
    const event = agentTurnStreamSettlementEvent({
      turnId: 'turn-1',
      projectId: 'project-1',
      execution: { turn: { id: 'turn-1', projectId: 'project-1', status } },
    })
    assert.equal(event.type, 'handoff', status)
    assert.equal(event.turnId, 'turn-1')
  }

  assert.equal(agentTurnStreamSettlementEvent({
    turnId: 'turn-1', projectId: 'project-1',
    execution: {
      turn: { id: 'turn-1', projectId: 'project-1', status: 'completed' },
      result: { kind: 'chat', answer: '完成' },
    },
  }).type, 'done')
})

test('非发起者不能取消 Turn，即使 Store 可读到该记录', async () => {
  let cancelInvoked = 0
  const responses = []
  const handler = createAgentTurnHttpAdapter({
    config: { security: {} },
    productStore: {
      // 模拟未来 Turn 开放项目级可见：读取不再按 owner 作用域过滤。
      readAgentTurn: async (_userId, turnId) => ({
        id: turnId, ownerId: 'owner-user', projectId: 'project-1', status: 'running',
      }),
      listAgentRunsForTurn: async () => [],
    },
    json: (_response, status, body) => { responses.push({ status, body }); return true },
    error: (_response, status, code, message) => { responses.push({ status, body: { error: { code, message } } }); return true },
    readJson: async () => ({}),
    requireUser: async () => ({ id: 'other-project-member' }),
    enforceRateLimit: async () => true,
    createSse: () => undefined,
    turnSubmission: () => ({}),
    cancellationService: () => ({
      cancelAgentTurn: async () => { cancelInvoked += 1; return {} },
    }),
  })

  const handled = await handler({
    request: { method: 'POST', headers: {} },
    response: {},
    url: new URL('http://localhost/api/agent-turns/turn-1/cancel'),
    routeMatches: { agentTurnCancel: ['/api/agent-turns/turn-1/cancel', 'turn-1'] },
  })

  assert.equal(handled, true)
  assert.equal(cancelInvoked, 0)
  assert.equal(responses.at(-1)?.status, 403)
  assert.equal(responses.at(-1)?.body.error.code, 'AGENT_TURN_CANCEL_FORBIDDEN')
})
