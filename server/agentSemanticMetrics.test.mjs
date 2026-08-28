import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AGENT_SEMANTIC_EVENT_NAMES,
  createAgentSemanticEvent,
} from './agentSemanticEvent.mjs'
import {
  AGENT_SEMANTIC_METRIC_FAMILIES,
  aggregateAgentSemanticMetrics,
  diffAgentSemanticMetrics,
} from './agentSemanticMetrics.mjs'

const occurredAt = '2026-08-28T00:00:00.000Z'

function semantic(name, input) {
  return createAgentSemanticEvent(name, input, occurredAt)
}

function events() {
  return [
    semantic(AGENT_SEMANTIC_EVENT_NAMES.ROLLOUT_EVALUATED, {
      feature: 'AGENT_CONTEXT_COMPACTION_V2', decision: 'enabled', cohort: 'treatment', mode: 'scoped',
    }),
    semantic(AGENT_SEMANTIC_EVENT_NAMES.ROLLOUT_EVALUATED, {
      feature: 'AGENT_CONTEXT_COMPACTION_V2', decision: 'disabled', cohort: 'control', mode: 'scoped',
    }),
    semantic(AGENT_SEMANTIC_EVENT_NAMES.CONTEXT_SHADOW_EVALUATED, {
      outcome: 'would_compact', trigger: 'pre_step', durationMs: 10,
      controlInputTokens: 1000, candidateInputTokens: 400,
    }),
    semantic(AGENT_SEMANTIC_EVENT_NAMES.CONTEXT_SHADOW_EVALUATED, {
      outcome: 'no_change', trigger: 'pre_step', durationMs: 20,
      controlInputTokens: 800, candidateInputTokens: 900,
    }),
    semantic(AGENT_SEMANTIC_EVENT_NAMES.CONTEXT_SHADOW_EVALUATED, {
      outcome: 'failed', trigger: 'pre_step', durationMs: 30,
      error: { code: 'AGENT_CONTEXT_SHADOW_FAILED', retryable: true },
    }),
    semantic(AGENT_SEMANTIC_EVENT_NAMES.CONTEXT_COMPACTION_RESULT, {
      outcome: 'compacted', trigger: 'pre_step', inputTokensBefore: 1_000, inputTokensAfter: 400, durationMs: 40,
    }),
    semantic(AGENT_SEMANTIC_EVENT_NAMES.CONTEXT_COMPACTION_RESULT, {
      outcome: 'reused', trigger: 'pre_step', durationMs: 50,
    }),
    semantic(AGENT_SEMANTIC_EVENT_NAMES.CONTEXT_COMPACTION_RESULT, {
      outcome: 'no_change', trigger: 'manual', durationMs: 60,
    }),
    semantic(AGENT_SEMANTIC_EVENT_NAMES.CONTEXT_COMPACTION_RESULT, {
      outcome: 'cas_conflict', trigger: 'pre_step', durationMs: 70,
      error: { code: 'AGENT_CONTEXT_CAS_CONFLICT', retryable: true },
    }),
    semantic(AGENT_SEMANTIC_EVENT_NAMES.CONTEXT_COMPACTION_RESULT, {
      outcome: 'failed', trigger: 'manual', durationMs: 80,
      error: { code: 'AGENT_CONTEXT_COMPACTION_NOT_SMALLER', retryable: false },
    }),
    semantic(AGENT_SEMANTIC_EVENT_NAMES.CONTEXT_OVERFLOW_RESULT, {
      outcome: 'recovered', retryCount: 1, durationMs: 90,
    }),
    semantic(AGENT_SEMANTIC_EVENT_NAMES.CONTEXT_OVERFLOW_RESULT, {
      outcome: 'failed', retryCount: 1, durationMs: 100,
      error: { code: 'AGENT_CONTEXT_OVERFLOW', retryable: false },
    }),
    semantic(AGENT_SEMANTIC_EVENT_NAMES.CONTEXT_OVERFLOW_RESULT, {
      outcome: 'not_retried', retryCount: 0,
    }),
    semantic(AGENT_SEMANTIC_EVENT_NAMES.CONTEXT_USAGE_ANCHOR_RESULT, {
      outcome: 'persisted', inputTokens: 100, totalTokens: 100, durationMs: 2,
    }),
    semantic(AGENT_SEMANTIC_EVENT_NAMES.CONTEXT_USAGE_ANCHOR_RESULT, {
      outcome: 'reused', inputTokens: 100, totalTokens: 100, durationMs: 3,
    }),
    semantic(AGENT_SEMANTIC_EVENT_NAMES.CONTEXT_USAGE_ANCHOR_RESULT, {
      outcome: 'cas_conflict', durationMs: 4,
    }),
    semantic(AGENT_SEMANTIC_EVENT_NAMES.CONTEXT_USAGE_ANCHOR_RESULT, {
      outcome: 'failed', durationMs: 5,
    }),
    semantic(AGENT_SEMANTIC_EVENT_NAMES.CONTEXT_USAGE_ANCHOR_RESULT, {
      outcome: 'not_found', durationMs: 6,
    }),
  ]
}

test('semantic 指标族固定且覆盖 rollout/shadow/compaction/overflow/usage anchor', () => {
  assert.deepEqual([...AGENT_SEMANTIC_METRIC_FAMILIES], [
    'rollout', 'shadow', 'compaction', 'overflow', 'usageAnchor',
  ])
  const metrics = aggregateAgentSemanticMetrics(events(), { minimumPercentileSamples: 1 })
  assert.equal(metrics.sampleCount, 18)
  assert.equal(metrics.rollout.enabledCoverageRate, 0.5)
  assert.equal(metrics.rollout.treatmentCoverageRate, 0.5)
  assert.equal(metrics.rollout.killedCoverageRate, 0)
  assert.equal(metrics.shadow.failureRate, 1 / 3)
  assert.equal(metrics.shadow.wouldCompactRate, 0.5)
  assert.equal(metrics.shadow.tokenComparisonSampleCount, 2)
  assert.equal(metrics.shadow.candidateIncreaseRate, 0.5)
  assert.equal(metrics.compaction.successRate, 0.6)
  assert.equal(metrics.compaction.reuseRate, 0.5)
  assert.equal(metrics.compaction.casConflictRate, 0.2)
  assert.equal(metrics.compaction.failureRate, 0.2)
  assert.equal(metrics.compaction.tokenReductionRate, 0.6)
  assert.equal(metrics.compaction.p50TokenReduction, 600)
  assert.equal(metrics.overflow.sampleCount, 2, 'not_retried 不冒充恢复尝试')
  assert.equal(metrics.overflow.recoveryRate, 0.5)
  assert.equal(metrics.usageAnchor.persistenceRate, 0.4)
  assert.equal(metrics.usageAnchor.reuseRate, 0.5)
  assert.equal(metrics.usageAnchor.casConflictRate, 0.2)
})

test('零样本的比率与分位数为 null，不伪装为 0%', () => {
  const metrics = aggregateAgentSemanticMetrics([])
  assert.equal(metrics.rollout.evaluationCount, 0)
  assert.equal(metrics.rollout.enabledCoverageRate, null)
  assert.equal(metrics.rollout.killedCoverageRate, null)
  assert.equal(metrics.shadow.failureRate, null)
  assert.equal(metrics.shadow.wouldCompactRate, null)
  assert.equal(metrics.shadow.candidateIncreaseRate, null)
  assert.equal(metrics.compaction.successRate, null)
  assert.equal(metrics.compaction.reuseRate, null)
  assert.equal(metrics.compaction.casConflictRate, null)
  assert.equal(metrics.compaction.tokenReductionRate, null)
  assert.equal(metrics.compaction.p95TokenReduction, null)
  assert.equal(metrics.overflow.recoveryRate, null)
  assert.equal(metrics.usageAnchor.persistenceRate, null)
})

test('分位数最小样本数可配置，少样本默认不报告 P95', () => {
  const defaults = aggregateAgentSemanticMetrics(events())
  assert.equal(defaults.shadow.p50DurationMs, null)
  assert.equal(defaults.compaction.p95DurationMs, null)
  assert.equal(defaults.compaction.p50TokenReduction, null)

  const permissive = aggregateAgentSemanticMetrics(events(), { minimumPercentileSamples: 1 })
  assert.equal(permissive.shadow.p50DurationMs, 20)
  assert.equal(permissive.shadow.p95DurationMs, 30)
  assert.equal(permissive.compaction.p95DurationMs, 80)
  assert.throws(
    () => aggregateAgentSemanticMetrics(events(), { minimumPercentileSamples: 0 }),
    /minimum samples/u,
  )
})

test('聚合器忽略 legacy、伪造版本与非数组输入', () => {
  const valid = events()[0]
  const metrics = aggregateAgentSemanticMetrics([
    valid,
    { event: valid.event, decision: 'enabled', cohort: 'treatment' },
    { ...valid, schemaVersion: 99 },
    { event: 'agent.run.worker_completed' },
  ])
  assert.equal(metrics.sampleCount, 1)
  assert.equal(aggregateAgentSemanticMetrics(/** @type {any} */ (null)).sampleCount, 0)
})

test('semantic diff 对 null 样本保持 insufficient_samples', () => {
  const before = aggregateAgentSemanticMetrics([])
  const after = aggregateAgentSemanticMetrics(events(), { minimumPercentileSamples: 1 })
  const changes = diffAgentSemanticMetrics(before, after)
  const rolloutCoverage = changes.find((change) => (
    change.family === 'rollout' && change.metric === 'enabledCoverageRate'
  ))
  assert.deepEqual(rolloutCoverage, {
    family: 'rollout', metric: 'enabledCoverageRate', from: null, to: 0.5,
    status: 'insufficient_samples',
  })
  assert.deepEqual(diffAgentSemanticMetrics(after, after), [])
})
