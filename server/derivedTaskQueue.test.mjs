import assert from 'node:assert/strict'
import test from 'node:test'
import { trace } from '@opentelemetry/api'
import {
  currentAgentTraceContext,
  extractAgentTraceContext,
  withAgentTraceContext,
} from './agentTraceContext.mjs'
import {
  DERIVED_TASK_KINDS,
  createDerivedTaskQueue,
  createDerivedTaskWorker,
  derivedSweepKey,
} from './derivedTaskQueue.mjs'

const TRACE_PARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'

test('未配置 Redis 时不构造队列，与生成队列行为一致', () => {
  assert.equal(createDerivedTaskQueue(undefined), undefined)
  assert.equal(createDerivedTaskQueue(''), undefined)
})

test('种类必须声明，未声明的种类抛错而不是入队一个没人消费的任务', () => {
  assert.throws(() => derivedSweepKey('workflow.advanced'), /未声明的派生任务种类/u)
  assert.throws(() => derivedSweepKey('turn.reclaimed'), /未声明的派生任务种类/u)
  assert.equal(derivedSweepKey('turn.reclaim'), 'sweep__turn.reclaim')
  assert.equal(derivedSweepKey('review.run'), 'sweep__review.run')
})

test('复合标识不含冒号，BullMQ 拒绝含冒号的自定义 jobId', () => {
  // 这条约束只有对着真实 Redis 才会暴露（Custom Id cannot contain :），
  // 因此在这里钉住，避免以后有人改回冒号分隔。
  assert.doesNotMatch(derivedSweepKey('turn.reclaim'), /:/u)
})

test('当前只声明有真实消费者的种类', () => {
  // 没有消费者的种类只是猜测；新种类要和它的消费者一起加。
  assert.deepEqual([...DERIVED_TASK_KINDS], ['turn.reclaim', 'review.run', 'workflow.advance', 'branch.retry', 'run.submit'])
  assert.equal(new Set(DERIVED_TASK_KINDS).size, DERIVED_TASK_KINDS.length)
})

test('Derived enqueue/schedule 与 Worker 跨边界传播 trace，处理器不接收 carrier', async () => {
  const added = []
  class FakeQueue {
    async getJob() { return undefined }
    async add(name, data, options) { added.push({ name, data, options }) }
  }
  const queue = createDerivedTaskQueue('redis://test', { QueueImpl: FakeQueue })
  await withAgentTraceContext(extractAgentTraceContext({ traceparent: TRACE_PARENT }), async () => {
    await queue.enqueue('review.run', 'review-1', { reviewTaskId: 'review-1' })
    await queue.scheduleSweep('turn.reclaim', 20_000)
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
  createDerivedTaskWorker({
    redisUrl: 'redis://test',
    WorkerImpl: FakeWorker,
    handlers: {
      'review.run': async (payload) => {
        processed = {
          payload,
          spanContext: trace.getSpanContext(currentAgentTraceContext()),
        }
      },
    },
  })
  await workerHandler({ data: added[0].data })
  assert.deepEqual(processed.payload, { kind: 'review.run', reviewTaskId: 'review-1' })
  assert.equal(processed.spanContext?.traceId, '4bf92f3577b34da6a3ce929d0e0e4736')
})

test('Derived Worker 可执行无 carrier 的历史 payload', async () => {
  let workerHandler
  class FakeWorker {
    constructor(_name, handler) { workerHandler = handler }
  }
  let processed
  const legacy = { kind: 'run.submit', runId: 'run-1' }
  createDerivedTaskWorker({
    redisUrl: 'redis://test',
    WorkerImpl: FakeWorker,
    handlers: { 'run.submit': async (payload) => { processed = payload } },
  })
  await workerHandler({ data: legacy })
  assert.equal(processed, legacy)
})
