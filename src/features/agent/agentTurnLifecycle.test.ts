import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentTurnLifecycle } from './agentTurnLifecycle.ts'

test('Stop 在 accepted 前保持观察并粘住原 Message，重复取消只请求一次', async () => {
  const cancelled: string[] = []
  const lifecycle = createAgentTurnLifecycle({ isCurrentScope: () => true, cancelTurn: async (id) => { cancelled.push(id) } })
  const message = { id: 'message-1', role: 'user' as const, kind: 'text' as const, content: '生成', createdAt: 1 }
  const operation = lifecycle.begin({ message, awaitingIdentity: true })
  lifecycle.rememberCancellation(message.id, 123)
  assert.equal((await lifecycle.stop()).kind, 'awaiting_turn_identity')
  assert.equal(operation.signal.aborted, false)
  operation.accept('turn-1')
  assert.equal(operation.cancellationRequested(), true)
  await Promise.all([lifecycle.ensureCancelled('turn-1', operation.signal), lifecycle.ensureCancelled('turn-1', operation.signal)])
  assert.deepEqual(cancelled, ['turn-1'])
  assert.equal(lifecycle.cancellationRequestedAt(message.id), 123)
  operation.release()
  const next = lifecycle.begin({ awaitingIdentity: true })
  next.accept('turn-2')
  assert.equal(next.cancellationRequested(), false, '取消不能污染下一轮')
})

test('切会话/卸载只断开观察，迟到 accepted/event/finally 不能接管新操作', async () => {
  let current = true
  const lifecycle = createAgentTurnLifecycle({ isCurrentScope: () => current, cancelTurn: async () => { throw new Error('观察清理不应取消服务端') } })
  const first = lifecycle.begin({ awaitingIdentity: true })
  const second = lifecycle.begin({ awaitingIdentity: true })
  assert.equal(first.signal.aborted, true)
  first.accept('stale')
  assert.equal(first.release(), false)
  second.accept('current')
  assert.equal(lifecycle.active?.turnId, 'current')
  assert.equal(second.isCurrent(), true)
  current = false
  assert.equal(second.isCurrent(), false)
  lifecycle.detach()
  assert.equal(second.signal.aborted, true)
  assert.equal(lifecycle.active, undefined)
})
