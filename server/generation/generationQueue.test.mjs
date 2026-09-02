import assert from 'node:assert/strict'
import test from 'node:test'
import { trace } from '@opentelemetry/api'
import {
  currentAgentTraceContext,
  extractAgentTraceContext,
  withAgentTraceContext,
} from '../observability/agentTraceContext.mjs'
import { createGenerationQueue, createGenerationWorker } from './generationQueue.mjs'

const TRACE_PARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'

test('stalled recovery 只移除指定且已解锁的 active Job，不调用全局 clean', async () => {
  const calls = []
  const target = {
    async getState() { return 'active' },
    async remove() { calls.push(['remove', 'job-target']) },
  }
  class FakeQueue {
    async getJob(id) { calls.push(['getJob', id]); return id === 'job-target' ? target : undefined }
    async clean() { calls.push(['clean']); return ['job-other'] }
    async add(name, data, options) { calls.push(['add', name, data, options]) }
  }
  const queue = createGenerationQueue('redis://test', { QueueImpl: FakeQueue })

  assert.equal(await queue.reclaimStaleActive('job-target'), true)
  assert.equal(calls.some(([method]) => method === 'clean'), false, '不得扫描或删除其他 active Job')
  assert.deepEqual(calls, [
    ['getJob', 'job-target'],
    ['remove', 'job-target'],
    ['add', 'generate', { jobId: 'job-target' }, { jobId: 'job-target' }],
  ])
})

test('stalled recovery 遇到仍持有 BullMQ lock 的目标时安全放弃，不重复入队', async () => {
  const calls = []
  class FakeQueue {
    async getJob() {
      return {
        async getState() { return 'active' },
        async remove() { throw new Error('Job job-target could not be removed because it is locked by another worker') },
      }
    }
    async add() { calls.push('add') }
  }
  const queue = createGenerationQueue('redis://test', { QueueImpl: FakeQueue })

  assert.equal(await queue.reclaimStaleActive('job-target'), false)
  assert.deepEqual(calls, [])
})

test('stale-running 的 BullMQ 项已丢失或 failed 时按 jobId 精确重建', async () => {
  for (const state of ['missing', 'failed']) {
    const calls = []
    class FakeQueue {
      async getJob() {
        if (state === 'missing') return undefined
        return {
          async getState() { return 'failed' },
          async remove() { calls.push('remove') },
        }
      }
      async add(name, data, options) { calls.push(['add', name, data, options]) }
    }
    const queue = createGenerationQueue('redis://test', { QueueImpl: FakeQueue })
    assert.equal(await queue.reclaimStaleActive('job-target'), true, state)
    assert.deepEqual(calls.at(-1), ['add', 'generate', { jobId: 'job-target' }, { jobId: 'job-target' }])
  }
})

test('Generation 队列跨 Worker 传播 W3C trace，业务处理器仍只收到 jobId', async () => {
  let queuedData
  class FakeQueue {
    async getJob() { return undefined }
    async add(_name, data) { queuedData = data }
  }
  const queue = createGenerationQueue('redis://test', { QueueImpl: FakeQueue })
  await withAgentTraceContext(extractAgentTraceContext({ traceparent: TRACE_PARENT }), () => queue.enqueue('job-1'))
  assert.deepEqual(queuedData, { jobId: 'job-1', traceparent: TRACE_PARENT })
  assert.equal('baggage' in queuedData, false)

  let workerHandler
  class FakeWorker {
    constructor(_name, handler) { workerHandler = handler }
  }
  let processed
  createGenerationWorker({
    redisUrl: 'redis://test',
    WorkerImpl: FakeWorker,
    processJob: async (jobId) => {
      processed = {
        jobId,
        spanContext: trace.getSpanContext(currentAgentTraceContext()),
      }
    },
  })
  await workerHandler({ data: queuedData })
  assert.equal(processed.jobId, 'job-1')
  assert.equal(processed.spanContext?.traceId, '4bf92f3577b34da6a3ce929d0e0e4736')
})

test('Generation Worker 可执行无 carrier 的历史任务', async () => {
  let workerHandler
  class FakeWorker {
    constructor(_name, handler) { workerHandler = handler }
  }
  let processed
  createGenerationWorker({
    redisUrl: 'redis://test',
    WorkerImpl: FakeWorker,
    processJob: async (jobId) => { processed = jobId },
  })
  await workerHandler({ data: { jobId: 'legacy-job' } })
  assert.equal(processed, 'legacy-job')
})
