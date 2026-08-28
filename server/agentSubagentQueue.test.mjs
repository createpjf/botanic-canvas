import assert from 'node:assert/strict'
import test from 'node:test'
import {
  agentSubagentQueueJobId,
  createAgentSubagentQueue,
  createAgentSubagentWorker,
} from './agentSubagentQueue.mjs'

test('Subagent 队列按激活身份幂等投递且不暴露原始 ID', async () => {
  const calls = []
  class FakeQueue {
    async getJob(id) { calls.push(['getJob', id]); return undefined }
    async add(name, data, options) { calls.push(['add', name, data, options]) }
  }
  const queue = createAgentSubagentQueue('redis://test', { QueueImpl: FakeQueue })
  const input = { subagentId: 'subagent:secret', activationId: 'activation:1' }

  assert.equal(await queue.enqueue(input), true)
  const jobId = agentSubagentQueueJobId(input)
  assert.doesNotMatch(jobId, /:/u)
  assert.doesNotMatch(jobId, /secret|activation/u)
  assert.deepEqual(calls, [
    ['getJob', jobId],
    ['add', 'activate', input, { jobId }],
  ])
})

test('Subagent 队列保留非终态任务，终态任务可按同一身份重投', async () => {
  for (const state of ['waiting', 'active', 'completed', 'failed']) {
    const calls = []
    class FakeQueue {
      async getJob() {
        return {
          async getState() { return state },
          async remove() { calls.push('remove') },
        }
      }
      async add() { calls.push('add') }
    }
    const queue = createAgentSubagentQueue('redis://test', { QueueImpl: FakeQueue })
    const enqueued = await queue.enqueue({ subagentId: 'subagent-1', activationId: 'activation-1' })
    assert.equal(enqueued, ['completed', 'failed'].includes(state), state)
    assert.deepEqual(calls, ['completed', 'failed'].includes(state) ? ['remove', 'add'] : [], state)
  }
})

test('Subagent 精确回收遇到活跃锁时放弃，不制造重复任务', async () => {
  const calls = []
  class FakeQueue {
    async getJob() {
      return {
        async getState() { return 'active' },
        async remove() { throw new Error('locked') },
      }
    }
    async add() { calls.push('add') }
  }
  const queue = createAgentSubagentQueue('redis://test', { QueueImpl: FakeQueue })
  assert.equal(await queue.reclaim({ subagentId: 'subagent-1', activationId: 'activation-1' }), false)
  assert.deepEqual(calls, [])
})

test('Subagent Worker 使用独立队列并只交付受校验的激活身份', async () => {
  let workerOptions
  let processed
  class FakeWorker {
    constructor(name, handler, options) {
      workerOptions = { name, handler, options }
    }
  }
  const worker = createAgentSubagentWorker({
    redisUrl: 'redis://test',
    concurrency: 3,
    WorkerImpl: FakeWorker,
    processActivation: async (input) => { processed = input },
  })

  assert.ok(worker instanceof FakeWorker)
  assert.equal(workerOptions.name, 'botanic-subagent')
  assert.equal(workerOptions.options.concurrency, 3)
  await workerOptions.handler({ data: { subagentId: 'subagent-1', activationId: 'activation-2', ignored: true } })
  assert.deepEqual(processed, { subagentId: 'subagent-1', activationId: 'activation-2' })
})
