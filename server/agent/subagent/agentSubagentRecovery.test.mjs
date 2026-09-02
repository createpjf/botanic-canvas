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
  assert.deepEqual(queries, [{ now: 2_000, after: null, limit: 100 }])
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

test('Subagent 恢复观测只接受白名单错误码，不泄漏队列异常正文', async () => {
  const observed = []
  const recover = createAgentSubagentRecovery({
    productStore: {
      async listRunnableAgentSubagents() {
        return [{ subagent: { id: 'subagent-secret' }, activation: { id: 'activation-secret' } }]
      },
    },
    enqueue: async () => {
      throw Object.assign(new Error('Bearer private-token Prompt: confidential'), {
        code: 'https://private.example/internal',
      })
    },
    observe: (event) => observed.push(event),
  })

  assert.deepEqual(await recover(), {
    scanned: 1, enqueued: 0, deduplicated: 0, invalid: 0, failed: 1,
  })
  assert.deepEqual(observed, [{
    event: 'agent.subagent.recovery.failed',
    subagentId: 'subagent-secret',
    activationId: 'activation-secret',
    code: 'AGENT_SUBAGENT_QUEUE_FAILED',
  }])
})

test('Subagent 恢复翻过整页失败项，继续投递下一页', async () => {
  const entries = Array.from({ length: 101 }, (_, index) => ({
    subagent: { id: `subagent-${String(index + 1).padStart(3, '0')}`, updatedAt: index + 1 },
    activation: { id: `activation-${index + 1}` },
  }))
  const queries = []
  const enqueued = []
  const recover = createAgentSubagentRecovery({
    productStore: {
      async listRunnableAgentSubagents(options) {
        queries.push(options)
        const start = options.after
          ? entries.findIndex((entry) => entry.subagent.id === options.after.id) + 1
          : 0
        return entries.slice(start, start + options.limit)
      },
    },
    enqueue: async ({ subagentId }) => {
      if (subagentId !== 'subagent-101') throw Object.assign(new Error('queue unavailable'), { code: 'QUEUE_DOWN' })
      enqueued.push(subagentId)
      return true
    },
  })

  assert.deepEqual(await recover(), {
    scanned: 101, enqueued: 1, deduplicated: 0, invalid: 0, failed: 100,
  })
  assert.equal(queries.length, 2)
  assert.deepEqual(queries[1].after, { updatedAt: 100, id: 'subagent-100' })
  assert.deepEqual(enqueued, ['subagent-101'])
})

test('Subagent 恢复在分页游标无进展时停止，不会死循环', async () => {
  const observed = []
  const entries = [
    { subagent: { id: 'subagent-1', updatedAt: 1 }, activation: { id: 'activation-1' } },
    { subagent: { id: 'subagent-2', updatedAt: 2 }, activation: { id: 'activation-2' } },
  ]
  let queryCount = 0
  const recover = createAgentSubagentRecovery({
    productStore: {
      async listRunnableAgentSubagents() {
        queryCount += 1
        return entries
      },
    },
    limit: 2,
    maxPages: 20,
    enqueue: async () => false,
    observe: (event) => observed.push(event),
  })

  assert.deepEqual(await recover(), {
    scanned: 4, enqueued: 0, deduplicated: 4, invalid: 0, failed: 0,
  })
  assert.equal(queryCount, 2)
  assert.ok(observed.some((event) => event.event === 'agent.subagent.recovery.cursor_stalled'))
})

test('Subagent 恢复跨 Sweep 保留游标，越过单轮页数上限后再回绕', async () => {
  const entries = Array.from({ length: 5 }, (_, index) => ({
    subagent: { id: `subagent-${index + 1}`, updatedAt: index + 1 },
    activation: { id: `activation-${index + 1}` },
  }))
  const queries = []
  const enqueued = []
  const recover = createAgentSubagentRecovery({
    productStore: {
      async listRunnableAgentSubagents(options) {
        queries.push(options)
        const start = options.after
          ? entries.findIndex((entry) => entry.subagent.id === options.after.id) + 1
          : 0
        return entries.slice(start, start + options.limit)
      },
    },
    limit: 2,
    maxPages: 1,
    enqueue: async (identity) => { enqueued.push(identity.subagentId); return false },
  })

  await recover()
  await recover()
  await recover()
  await recover()

  assert.deepEqual(queries.map((query) => query.after), [
    null,
    { updatedAt: 2, id: 'subagent-2' },
    { updatedAt: 4, id: 'subagent-4' },
    null,
  ])
  assert.deepEqual(enqueued, [
    'subagent-1', 'subagent-2',
    'subagent-3', 'subagent-4',
    'subagent-5',
    'subagent-1', 'subagent-2',
  ])
})

test('Subagent 恢复构造时要求权威查询与投递 seam', () => {
  assert.throws(() => createAgentSubagentRecovery({ productStore: {} }), /ProductStore/u)
  assert.throws(() => createAgentSubagentRecovery({
    productStore: { listRunnableAgentSubagents() {} },
  }), /队列投递/u)
})
