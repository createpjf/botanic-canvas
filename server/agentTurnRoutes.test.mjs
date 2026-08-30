import assert from 'node:assert/strict'
import test from 'node:test'
import { agentTurnStreamSettlementEvent } from './agentTurnRoutes.mjs'

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
