import assert from 'node:assert/strict'
import test from 'node:test'

import { createAgentTurnRecord } from './botanicAgentTurnRuntime.mjs'
import { createAgentTurnSubmission } from './agentTurnSubmission.mjs'

function fixture({ conflict = false } = {}) {
  const turns = new Map()
  const links = []
  const runtime = {
    async execute(command) {
      const turn = createAgentTurnRecord({
        id: command.id,
        ownerId: command.userId,
        projectId: command.projectId,
        sessionId: command.sessionId,
        requestId: command.requestId,
        idempotencyKey: command.idempotencyKey,
        request: command.request,
      })
      turns.set(turn.id, conflict ? { ...turn, requestHash: 'conflict' } : turn)
      return { turn }
    },
  }
  const submission = createAgentTurnSubmission({
    productStore: { readAgentTurn: async (_userId, id) => turns.get(id) },
    runtime,
  })
  const handle = submission.submit({
    userId: 'user-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    requestId: 'request-1',
    idempotencyKey: 'turn-key',
    request: { operation: 'chat', inputMessage: { id: 'message-1', content: 'hello' } },
    resolve: async () => ({}),
    resolveOptions: {},
    linkMessage: async (turnId) => links.push(turnId),
  })
  return { handle, links }
}

test('正式与兼容入口共用的提交 seam 只在 Turn durable 后建立 Message link', async () => {
  const { handle, links } = fixture()
  const durable = await handle.accepted
  assert.equal(durable.id, handle.turnId)
  assert.deepEqual(links, [handle.turnId])
  await handle.execution
})

test('同一提交键绑定不同请求时不建立 Message link', async () => {
  const { handle, links } = fixture({ conflict: true })
  await assert.rejects(handle.accepted, { code: 'AGENT_TURN_INTENT_CONFLICT' })
  assert.deepEqual(links, [])
})
