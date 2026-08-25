import assert from 'node:assert/strict'
import test from 'node:test'
import { GENERATION_CANCEL_REASONS, cancelGenerationJob, recordedGenerationCancelOutcome } from './generationCancellation.mjs'

function harness(job) {
  const written = []
  const dequeued = []
  const broadcast = []
  let stored = job
  return {
    written, dequeued, broadcast,
    stored: () => stored,
    deps: {
      productStore: {
        putGenerationJob: async (ownerId, next) => { written.push({ ownerId, job: next }); stored = next },
      },
      redisQueue: { cancel: async (jobId) => dequeued.push(jobId) },
      publishCancel: async (event) => broadcast.push(event),
      modelOptions: [{ id: 'gpt-image-2', provider: 'openai' }],
      ownerId: 'user-1',
    },
  }
}

const queuedJob = {
  id: 'job-1', projectId: 'project-1', ownerId: 'user-1', status: 'queued',
  settings: { model: 'gpt-image-2' },
}

test('派发前取消：出队即真省钱，并把判定写成持久回执', async () => {
  const { deps, written, dequeued, broadcast } = harness(queuedJob)
  const result = await cancelGenerationJob({ ...deps, job: queuedJob, reason: 'user', requestedAt: 1_700, requestedBy: 'user-1' })

  assert.equal(result.cancelled, true)
  assert.equal(result.outcome.billing, 'none')
  assert.equal(result.outcome.code, 'CANCELLED_BEFORE_DISPATCH')
  assert.equal(written[0].job.status, 'cancelled')
  assert.deepEqual(written[0].job.cancel, {
    requestedAt: 1_700, reason: 'user', requestedBy: 'user-1',
    billing: 'none', capability: 'local-abort-only', workerReleased: false, code: 'CANCELLED_BEFORE_DISPATCH',
  })
  assert.deepEqual(dequeued, ['job-1'])
  assert.deepEqual(broadcast, [{ scope: 'job', id: 'job-1', projectId: 'project-1', requestedAt: 1_700 }])
})

test('运行中取消：必须广播到 Worker，且照实记为费用可能已产生', async () => {
  // 不广播的话 Worker（独立进程）会把 Provider 调用跑完才发现结果没人要，槽位白占。
  const runningJob = { ...queuedJob, status: 'running' }
  const { deps, written, broadcast } = harness(runningJob)
  const result = await cancelGenerationJob({ ...deps, job: runningJob, reason: 'workflow-cancel', requestedAt: 2_000 })

  assert.equal(result.outcome.billing, 'possible')
  assert.equal(result.outcome.workerReleased, true)
  assert.equal(written[0].job.cancel.reason, 'workflow-cancel')
  assert.equal(written[0].job.cancel.code, 'CANCELLED_RESULT_DISCARDED')
  // 请求时刻随广播传出，Worker 据此报出取消延迟。
  assert.deepEqual(broadcast, [{ scope: 'job', id: 'job-1', projectId: 'project-1', requestedAt: 2_000 }])
})

test('重复取消幂等：不再改写任务，并返回与第一次相同的判定', async () => {
  const first = harness(queuedJob)
  await cancelGenerationJob({ ...first.deps, job: queuedJob, reason: 'user', requestedAt: 1_700 })
  const cancelledJob = first.stored()

  const second = harness(cancelledJob)
  const result = await cancelGenerationJob({ ...second.deps, job: cancelledJob, reason: 'user', requestedAt: 9_999 })

  assert.equal(result.cancelled, false)
  assert.equal(second.written.length, 0)
  assert.deepEqual(second.dequeued, [])
  assert.deepEqual(second.broadcast, [])
  // 关键：第二次不能退化成中性文案，否则用户以为两次点击的后果不同。
  assert.equal(result.outcome.code, 'CANCELLED_BEFORE_DISPATCH')
  assert.equal(result.outcome.billing, 'none')
})

test('已成功的任务：取消是无操作，判定为本就无需取消', async () => {
  const settled = { ...queuedJob, status: 'succeeded' }
  const { deps, written, dequeued, broadcast } = harness(settled)
  const result = await cancelGenerationJob({ ...deps, job: settled, reason: 'user' })

  assert.equal(result.cancelled, false)
  assert.equal(result.outcome.code, 'ALREADY_SETTLED')
  assert.equal(written.length, 0)
  assert.deepEqual(dequeued, [])
  assert.deepEqual(broadcast, [])
})

test('取消来源是声明式的，未声明的来源直接拒绝', async () => {
  const { deps } = harness(queuedJob)
  await assert.rejects(
    () => cancelGenerationJob({ ...deps, job: queuedJob, reason: 'whatever' }),
    /未声明的取消来源/u,
  )
  assert.deepEqual([...GENERATION_CANCEL_REASONS], ['user', 'agent-run', 'workflow-cancel', 'workflow-pause'])
})

test('afterPersist 拿到已带回执的任务，且在出队与广播之前执行', async () => {
  const order = []
  const seen = []
  const running = { ...queuedJob, status: 'running' }
  await cancelGenerationJob({
    productStore: { putGenerationJob: async () => order.push('persist') },
    redisQueue: { cancel: async () => order.push('dequeue') },
    publishCancel: async () => order.push('broadcast'),
    modelOptions: [], ownerId: 'user-1', job: running, reason: 'agent-run',
    afterPersist: (job) => { order.push('afterPersist'); seen.push(job) },
  })
  assert.deepEqual(order, ['persist', 'afterPersist', 'dequeue', 'broadcast'])
  assert.equal(seen[0].status, 'cancelled')
  assert.equal(seen[0].cancel.reason, 'agent-run')
})

test('未取消过的任务没有回执，不得凭空造一个判定', () => {
  assert.equal(recordedGenerationCancelOutcome({ status: 'cancelled' }), undefined)
  assert.equal(recordedGenerationCancelOutcome(undefined), undefined)
})
