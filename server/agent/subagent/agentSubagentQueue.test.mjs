import assert from 'node:assert/strict'
import test from 'node:test'
import { trace } from '@opentelemetry/api'
import {
  currentAgentTraceContext,
  extractAgentTraceContext,
  withAgentTraceContext,
} from '../../agentTraceContext.mjs'
import {
  agentSubagentQueueJobId,
  createAgentSubagentQueue,
  createAgentSubagentWorker,
} from './agentSubagentQueue.mjs'

const TRACE_PARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'

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

test('Subagent enqueue/reclaim 与 Worker 跨边界传播 trace，不污染激活身份', async () => {
  const added = []
  class FakeQueue {
    async getJob() { return undefined }
    async add(name, data, options) { added.push({ name, data, options }) }
  }
  const queue = createAgentSubagentQueue('redis://test', { QueueImpl: FakeQueue })
  const identity = { subagentId: 'subagent-1', activationId: 'activation-1' }
  await withAgentTraceContext(extractAgentTraceContext({ traceparent: TRACE_PARENT }), async () => {
    await queue.enqueue(identity)
    await queue.reclaim({ subagentId: 'subagent-2', activationId: 'activation-2' })
  })
  assert.equal(added.length, 2)
  assert.equal(added[0].data.traceparent, TRACE_PARENT)
  assert.equal(added[1].data.traceparent, TRACE_PARENT)
  assert.equal('baggage' in added[0].data, false)

  let workerHandler
  class FakeWorker {
    constructor(_name, handler) { workerHandler = handler }
  }
  let processed
  createAgentSubagentWorker({
    redisUrl: 'redis://test',
    WorkerImpl: FakeWorker,
    processActivation: async (payload) => {
      processed = {
        payload,
        spanContext: trace.getSpanContext(currentAgentTraceContext()),
      }
    },
  })
  await workerHandler({ data: added[0].data })
  assert.deepEqual(processed.payload, identity)
  assert.equal(processed.spanContext?.traceId, '4bf92f3577b34da6a3ce929d0e0e4736')
})

test('Subagent Worker 可执行无 carrier 的历史激活任务', async () => {
  let workerHandler
  class FakeWorker {
    constructor(_name, handler) { workerHandler = handler }
  }
  let processed
  createAgentSubagentWorker({
    redisUrl: 'redis://test',
    WorkerImpl: FakeWorker,
    processActivation: async (payload) => { processed = payload },
  })
  const legacy = { subagentId: 'subagent-1', activationId: 'activation-2', ignored: true }
  await workerHandler({ data: legacy })
  assert.deepEqual(processed, { subagentId: 'subagent-1', activationId: 'activation-2' })
})
