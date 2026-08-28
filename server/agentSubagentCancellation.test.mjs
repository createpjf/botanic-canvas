import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentSubagentCancellation } from './agentSubagentCancellation.mjs'

function descriptor(overrides = {}) {
  return {
    id: 'subagent-1', ownerId: 'owner-1', projectId: 'project-1', status: 'cancelling',
    cancelGeneration: 1, settledThroughSequence: 0, lastEnqueuedSequence: 2,
    budget: { maxActivations: 8 },
    cancellation: { signalId: 'signal-1', requestedAt: 100, reason: '停止调研' },
    ...overrides,
  }
}

test('Subagent 取消先落 descriptor fence，再逐个取消 Turn 并原子 finalize', async () => {
  const calls = []
  let raw = descriptor()
  const productStore = {
    async requestAgentSubagentCancellation(_userId, command) {
      calls.push(['request', command])
      return { kind: 'requested', changed: true, subagent: raw }
    },
    async readAgentSubagentForWorker() { return raw },
    async listAgentSubagentActivationsForWorker() {
      return [
        { activation: { id: 'activation-1', sequence: 1 }, turn: { id: 'turn-running', status: 'running' } },
        { activation: { id: 'activation-2', sequence: 2 }, turn: { id: 'turn-completed', status: 'completed' } },
      ]
    },
    async finalizeAgentSubagentCancellation(_userId, command) {
      calls.push(['finalize-subagent', command])
      raw = descriptor({ status: 'cancelled', settledThroughSequence: 2 })
      return { kind: 'finalized', changed: true, subagent: raw }
    },
  }
  const published = []
  const cancellation = createAgentSubagentCancellation({
    productStore,
    turnRuntime: {
      async cancel(command) { calls.push(['cancel-turn', command]); return { status: 'cancelling' } },
      async finalizeCancellation(command) { calls.push(['finalize-turn', command]); return { status: 'cancelled' } },
    },
    publishCancel: async (event) => { published.push(event) },
  })

  const result = await cancellation.request({
    userId: 'editor-1', subagentId: 'subagent-1', projectId: 'project-1',
    idempotencyKey: 'cancel-request-1', reason: '停止调研',
  })

  assert.equal(result.subagent.status, 'cancelled')
  assert.equal(calls[0][0], 'request', 'descriptor fence 必须先于 Turn abort')
  assert.deepEqual(calls.filter(([kind]) => kind === 'cancel-turn').map(([, command]) => command.turnId), ['turn-running'])
  assert.deepEqual(calls.filter(([kind]) => kind === 'finalize-turn').map(([, command]) => command.turnId), ['turn-running'])
  assert.equal(calls.at(-1)[0], 'finalize-subagent')
  assert.deepEqual(published, [{
    scope: 'turn', id: 'turn-running', projectId: 'project-1', requestedAt: 100,
  }])
})

test('Recovery 可直接重入 cancelling descriptor，已 cancelled 则幂等跳过', async () => {
  let raw = descriptor()
  let turnCancels = 0
  const productStore = {
    requestAgentSubagentCancellation() {},
    async readAgentSubagentForWorker() { return raw },
    async listAgentSubagentActivationsForWorker() { return [] },
    async finalizeAgentSubagentCancellation() {
      raw = descriptor({ status: 'cancelled', settledThroughSequence: 2 })
      return { kind: 'finalized', changed: true, subagent: raw }
    },
  }
  const cancellation = createAgentSubagentCancellation({
    productStore,
    turnRuntime: {
      async cancel() { turnCancels += 1 },
      async finalizeCancellation() {},
    },
  })

  assert.equal((await cancellation.converge(raw)).kind, 'finalized')
  assert.equal((await cancellation.converge(raw)).kind, 'replay')
  assert.equal(turnCancels, 0)
})

test('Subagent 取消 fail closed 校验依赖与幂等身份', async () => {
  assert.throws(() => createAgentSubagentCancellation({}), /ProductStore/u)
  const cancellation = createAgentSubagentCancellation({
    productStore: {
      requestAgentSubagentCancellation() {}, finalizeAgentSubagentCancellation() {},
      listAgentSubagentActivationsForWorker() {},
    },
    turnRuntime: { cancel() {}, finalizeCancellation() {} },
  })
  await assert.rejects(cancellation.request({}), /幂等身份/u)
})
