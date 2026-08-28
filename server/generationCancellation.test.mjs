import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GENERATION_CANCEL_REASONS,
  abortMatchingGenerationJobCancellation,
  cancelGenerationJob,
  recordedGenerationCancelOutcome,
} from './generationCancellation.mjs'
import { requestedGenerationJobCancellation } from './generationJobExecution.mjs'

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
        cancelGenerationJobExecution: async (ownerId, command) => {
          const decision = requestedGenerationJobCancellation(stored, {
            ...command,
            observedAt: command.requestedAt,
          })
          if (!decision.changed) return structuredClone(decision)
          stored = structuredClone(decision.job)
          written.push({ ownerId, job: structuredClone(stored) })
          return structuredClone(decision)
        },
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

test('Worker subscriber 只 abort 与 durable signalId 匹配的当前 generation，不直接写 ack', async () => {
  const current = {
    ...queuedJob,
    status: 'cancelled',
    execution: { generation: 2, leaseToken: 'lease-current' },
    cancel: {
      signalRequired: true,
      signalId: 'generation-cancel:job-1:2:3000',
      workerReleased: false,
    },
  }
  const aborted = []
  const deps = {
    productStore: { async readGenerationJobForWorker() { return structuredClone(current) } },
    cancelRegistry: { abort(id) { aborted.push(id); return true } },
  }

  assert.equal(await abortMatchingGenerationJobCancellation({
    ...deps,
    event: {
      scope: 'job', id: current.id, projectId: current.projectId,
      signalId: 'generation-cancel:job-1:1:2000',
    },
  }), false)
  assert.deepEqual(aborted, [])

  assert.equal(await abortMatchingGenerationJobCancellation({
    ...deps,
    event: {
      scope: 'job', id: current.id, projectId: current.projectId,
      signalId: current.cancel.signalId,
    },
  }), true)
  assert.deepEqual(aborted, ['job-1'])
})

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
  assert.equal(result.outcome.workerReleased, false)
  assert.equal(result.job.cancel.workerReleaseExpected, true)
  assert.equal(written[0].job.cancel.reason, 'workflow-cancel')
  assert.equal(written[0].job.cancel.code, 'CANCELLED_RESULT_DISCARDED')
  // 请求时刻随广播传出，Worker 据此报出取消延迟。
  assert.deepEqual(broadcast, [{
    scope: 'job', id: 'job-1', projectId: 'project-1', requestedAt: 2_000,
    signalId: 'generation-cancel:job-1:0:2000',
  }])
})

test('运行中 Job 首次 publish 失败后，重复取消会按 durable signalId 强制重发', async () => {
  const runningJob = { ...queuedJob, status: 'running' }
  const state = harness(runningJob)
  let publishAttempts = 0
  const publishCancel = async (event) => {
    publishAttempts += 1
    if (publishAttempts === 1) throw new Error('Redis publish failed')
    state.broadcast.push(event)
  }

  await assert.rejects(
    cancelGenerationJob({
      ...state.deps, publishCancel, job: runningJob, reason: 'agent-run', requestedAt: 2_500,
    }),
    /Redis publish failed/u,
  )
  assert.equal(state.stored().status, 'cancelled')
  assert.equal(state.stored().cancel.signalAcknowledgedAt, undefined)

  const replay = await cancelGenerationJob({
    ...state.deps, publishCancel, job: state.stored(), reason: 'agent-run', requestedAt: 9_999,
  })

  assert.equal(replay.cancelled, false)
  assert.equal(publishAttempts, 2)
  assert.deepEqual(state.broadcast, [{
    scope: 'job', id: 'job-1', projectId: 'project-1', requestedAt: 2_500,
    signalId: 'generation-cancel:job-1:0:2500',
  }])
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
    productStore: {
      cancelGenerationJobExecution: async (_ownerId, command) => {
        order.push('persist')
        return {
          kind: 'cancelled', changed: true,
          job: {
            ...running, status: 'cancelled',
            cancel: { requestedAt: command.requestedAt, reason: command.reason, ...command.outcomes.running },
          },
        }
      },
    },
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

test('取消不信任调用方旧快照：Store 锁内看到 running 时记录 running 后果', async () => {
  const staleQueuedSnapshot = { ...queuedJob, status: 'queued' }
  const authoritativeRunning = {
    ...queuedJob,
    status: 'running',
    execution: { generation: 1, leaseToken: 'lease-worker' },
  }
  let command
  const result = await cancelGenerationJob({
    productStore: {
      async cancelGenerationJobExecution(_ownerId, incoming) {
        command = incoming
        return {
          kind: 'cancelled', changed: true, priorStatus: 'running',
          job: {
            ...authoritativeRunning,
            status: 'cancelled',
            cancel: {
              requestedAt: incoming.requestedAt,
              reason: incoming.reason,
              billing: incoming.outcomes.running.billing,
              capability: incoming.outcomes.running.capability,
              workerReleased: incoming.outcomes.running.workerReleased,
              code: incoming.outcomes.running.code,
            },
          },
        }
      },
    },
    modelOptions: [{ id: 'gpt-image-2', provider: 'openai' }],
    ownerId: 'user-1',
    job: staleQueuedSnapshot,
    reason: 'user',
    requestedAt: 3_000,
  })

  assert.equal(command.outcomes.queued.code, 'CANCELLED_BEFORE_DISPATCH')
  assert.equal(command.outcomes.running.code, 'CANCELLED_RESULT_DISCARDED')
  assert.equal(result.job.cancel.code, 'CANCELLED_RESULT_DISCARDED')
  assert.equal(result.outcome.billing, 'possible')
})
