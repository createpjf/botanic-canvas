import assert from 'node:assert/strict'
import test from 'node:test'

import { createAgentTurnRecord } from './botanicAgentTurnRuntime.mjs'
import { awaitDurableTurn, createAgentTurnSubmission } from './agentTurnSubmission.mjs'

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

test('durable waiter 有界:稍后可见成功;永不可见 503 且 poller 停止、execution 不受影响', async () => {
  // 主路径:第三次读取才可见,退避轮询仍在上限内成功。
  const candidate = createAgentTurnRecord({
    id: 'turn-wait', ownerId: 'user-1', projectId: 'project-1', idempotencyKey: 'wait-key',
    request: { operation: 'chat' },
  })
  let readsUntilVisible = 0
  const laterVisible = {
    readAgentTurn: async () => {
      readsUntilVisible += 1
      return readsUntilVisible >= 3 ? candidate : undefined
    },
  }
  const neverSettles = new Promise(() => {})
  const turn = await awaitDurableTurn(laterVisible, 'user-1', candidate, neverSettles)
  assert.equal(turn.id, 'turn-wait')

  // 失败路径:Store 永远无记录。waitLimit 内有界读取后返回 503,poller 停止,
  // execution Promise 仍存活且未收到 abort。
  let reads = 0
  const neverVisible = { readAgentTurn: async () => { reads += 1; return undefined } }
  let executionAborted = false
  const execution = new Promise(() => {})
  execution.catch(() => { executionAborted = true })
  await assert.rejects(
    awaitDurableTurn(neverVisible, 'user-1', candidate, execution, { waitLimitMs: 120 }),
    (caught) => caught?.code === 'AGENT_TURN_DURABILITY_UNAVAILABLE' && caught?.statusCode === 503,
  )
  const readsAtTimeout = reads
  // 120ms 内按 5/25/100ms 退避,读取次数必须有界(远小于旧 5ms 固定间隔的 ~24 次)。
  assert.ok(readsAtTimeout <= 5, '退避后读取次数应有界,实际 ' + readsAtTimeout)
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(reads, readsAtTimeout, '503 返回后 poller 必须停止')
  assert.equal(executionAborted, false, 'execution 不得被 observer 超时中止')
})
