import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentSubagentRecovery } from './agentSubagentRecovery.mjs'

test('Subagent 恢复只把数据库给出的 FIFO head 投入专用队列', async () => {
  const queries = []
  const enqueued = []
  const productStore = {
    async listRunnableAgentSubagents(options) {
      queries.push(options)
      return [
        { subagent: { id: 'subagent-1' }, activation: { id: 'activation-1', sequence: 1 } },
        { subagent: { id: 'subagent-2' }, activation: { id: 'activation-3', sequence: 3 } },
      ]
    },
  }
  const recover = createAgentSubagentRecovery({
    productStore,
    now: () => 2_000,
    enqueue: async (identity) => { enqueued.push(identity); return identity.subagentId !== 'subagent-2' },
  })

  assert.deepEqual(await recover(), {
    scanned: 2, enqueued: 1, deduplicated: 1, invalid: 0, failed: 0,
  })
  assert.deepEqual(queries, [{ now: 2_000, limit: 100 }])
  assert.deepEqual(enqueued, [
    { subagentId: 'subagent-1', activationId: 'activation-1' },
    { subagentId: 'subagent-2', activationId: 'activation-3' },
  ])
})

test('Subagent 恢复隔离坏记录、队列失败与观测异常', async () => {
  const observed = []
  const recover = createAgentSubagentRecovery({
    productStore: {
      async listRunnableAgentSubagents() {
        return [
          { subagent: { id: 'subagent-bad' }, activation: {} },
          { subagent: { id: 'subagent-fail' }, activation: { id: 'activation-fail' } },
          { subagent: { id: 'subagent-good' }, activation: { id: 'activation-good' } },
        ]
      },
    },
    enqueue: async ({ subagentId }) => {
      if (subagentId === 'subagent-fail') throw Object.assign(new Error('redis down'), { code: 'REDIS_DOWN' })
      return true
    },
    observe: (event) => {
      observed.push(event)
      if (event.event === 'agent.subagent.recovery.invalid') throw new Error('observer down')
    },
  })

  assert.deepEqual(await recover(), {
    scanned: 3, enqueued: 1, deduplicated: 0, invalid: 1, failed: 1,
  })
  assert.ok(observed.some((event) => event.code === 'REDIS_DOWN'))
  assert.ok(observed.some((event) => event.subagentId === 'subagent-good'))
})

test('Subagent 恢复构造时要求权威查询与投递 seam', () => {
  assert.throws(() => createAgentSubagentRecovery({ productStore: {} }), /ProductStore/u)
  assert.throws(() => createAgentSubagentRecovery({
    productStore: { listRunnableAgentSubagents() {} },
  }), /队列投递/u)
})
