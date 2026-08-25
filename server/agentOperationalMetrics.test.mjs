import assert from 'node:assert/strict'
import test from 'node:test'
import {
  OPERATIONAL_METRIC_FAMILIES,
  aggregateOperationalMetrics,
  diffOperationalMetrics,
} from './agentOperationalMetrics.mjs'

const runEvent = (type, extra = {}) => ({ event: `agent.run.${type}`, ...extra })

function events() {
  return [
    runEvent('created', { runId: 'run-1' }),
    runEvent('worker_started', { runId: 'run-1', queueDurationMs: 200 }),
    runEvent('worker_completed', { runId: 'run-1', durationMs: 5_000, projectWritebackPending: false }),
    runEvent('worker_started', { runId: 'run-2', queueDurationMs: 400 }),
    runEvent('worker_failed', { runId: 'run-2', code: 'PROVIDER_TIMEOUT' }),
    runEvent('submission_reused', { runId: 'run-1' }),
    { event: 'generation.cancel.aborted', jobId: 'job-1', latencyMs: 12 },
    { event: 'agent.turn.reclaim.resumed', turnId: 'turn-1' },
    { event: 'agent.turn.reclaim.abandoned', turnId: 'turn-2' },
    { event: 'agent.review.settled', status: 'completed', reviewed: 3, skipped: 2 },
    { event: 'agent.review.skipped', runId: 'run-3' },
    { event: 'workflow.advanced', projectId: 'project-1' },
    { event: 'workflow.advance.failed', projectId: 'project-2' },
  ]
}

test('指标族是声明式的', () => {
  assert.deepEqual([...OPERATIONAL_METRIC_FAMILIES], [
    'turn', 'tool', 'run', 'provider', 'cancel', 'writeback', 'review', 'workflow',
  ])
})

test('从既有结构化事件聚合，不需要新增埋点', () => {
  const metrics = aggregateOperationalMetrics(events(), { minimumPercentileSamples: 1 })
  assert.equal(metrics.run.settledCount, 2)
  assert.equal(metrics.run.successRate, 0.5)
  assert.equal(metrics.run.p50DurationMs, 5_000)
  assert.equal(metrics.provider.failureRate, 0.5)
  assert.equal(metrics.cancel.p50LatencyMs, 12)
  assert.equal(metrics.turn.resumeRate, 0.5)
  assert.equal(metrics.workflow.advanceSuccessRate, 0.5)
})

test('「没有样本」与「成功率 0%」必须分开', () => {
  // 用 0 顶替会让一个还没跑过任何任务的部署看起来像全线崩溃。
  const empty = aggregateOperationalMetrics([])
  assert.equal(empty.run.successRate, null)
  assert.equal(empty.cancel.p50LatencyMs, null)
  assert.equal(empty.review.candidateCoverageRate, null)

  const allFailed = aggregateOperationalMetrics([
    runEvent('worker_started', {}), runEvent('worker_failed', {}),
  ])
  assert.equal(allFailed.run.successRate, 0)
})

test('样本不足时不报分位数：3 个样本的 P95 不是 P95', () => {
  const few = aggregateOperationalMetrics([
    runEvent('worker_completed', { durationMs: 1 }),
    runEvent('worker_completed', { durationMs: 2 }),
  ])
  assert.equal(few.run.p95DurationMs, null)
  assert.equal(few.run.p50DurationMs, null)
  assert.equal(aggregateOperationalMetrics([
    runEvent('worker_completed', { durationMs: 1 }),
  ], { minimumPercentileSamples: 1 }).run.p50DurationMs, 1)
})

test('评审覆盖率按候选算，不按任务算', () => {
  // 一个任务评了 2/5 张也是「完成」，按任务算会把覆盖率算成 100%。
  const metrics = aggregateOperationalMetrics(events())
  assert.equal(metrics.review.completionRate, 1)
  assert.equal(metrics.review.candidateCoverageRate, 0.6)
})

test('回填完整率只在观察到写回标记的事件上计算', () => {
  const metrics = aggregateOperationalMetrics([
    runEvent('worker_completed', { projectWritebackPending: false }),
    runEvent('worker_completed', { projectWritebackPending: true }),
    runEvent('worker_completed', {}),
  ])
  assert.equal(metrics.writeback.observedCount, 2)
  assert.equal(metrics.writeback.completeRate, 0.5)
})

test('前后对比只比两边都有样本的指标', () => {
  const before = aggregateOperationalMetrics(events(), { minimumPercentileSamples: 1 })
  const after = aggregateOperationalMetrics([
    ...events(),
    runEvent('worker_started', { runId: 'run-3' }),
    runEvent('worker_completed', { runId: 'run-3', durationMs: 4_000 }),
  ], { minimumPercentileSamples: 1 })

  const changes = diffOperationalMetrics(before, after)
  const success = changes.find((change) => change.family === 'run' && change.metric === 'successRate')
  assert.equal(success.from, 0.5)
  assert.ok(success.to > 0.5)
  assert.equal(success.status, 'changed')

  // 一边没样本时报 insufficient_samples，而不是算出一个看起来像回归的差值。
  const sparse = diffOperationalMetrics(aggregateOperationalMetrics([]), after)
  const sparseSuccess = sparse.find((change) => change.family === 'run' && change.metric === 'successRate')
  assert.equal(sparseSuccess.status, 'insufficient_samples')
  assert.equal(sparseSuccess.from, null)
})

test('没有变化的指标不进对比结果', () => {
  const metrics = aggregateOperationalMetrics(events(), { minimumPercentileSamples: 1 })
  assert.deepEqual(diffOperationalMetrics(metrics, metrics), [])
})
