// @ts-check

import {
  AGENT_SEMANTIC_EVENT_NAMES,
  AGENT_SEMANTIC_EVENT_SCHEMA,
  AGENT_SEMANTIC_EVENT_SCHEMA_VERSION,
} from './agentSemanticEvent.mjs'

export const AGENT_SEMANTIC_METRIC_FAMILIES = Object.freeze([
  'rollout',
  'shadow',
  'compaction',
  'overflow',
  'usageAnchor',
])

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null
}

function normalizeMinimumSamples(value) {
  if (value === undefined) return 20
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new TypeError('Agent semantic percentile minimum samples 无效。')
  }
  return value
}

function percentile(values, fraction, minimumSamples) {
  const sorted = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right)
  if (sorted.length < minimumSamples) return null
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return sorted[index]
}

function isSemanticEvent(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && value.schema === AGENT_SEMANTIC_EVENT_SCHEMA
    && value.schemaVersion === AGENT_SEMANTIC_EVENT_SCHEMA_VERSION,
  )
}

function eventsOf(events, name) {
  return events.filter((event) => event.event === name)
}

function outcomesOf(events, outcomes) {
  return events.filter((event) => outcomes.has(event.outcome))
}

function nonNegativeNumber(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

function durations(events) {
  return events
    .map((event) => nonNegativeNumber(event.durationMs))
    .filter((value) => value !== undefined)
}

function durationMetrics(events, minimumSamples) {
  const values = durations(events)
  return {
    durationSampleCount: values.length,
    p50DurationMs: percentile(values, 0.5, minimumSamples),
    p95DurationMs: percentile(values, 0.95, minimumSamples),
  }
}

function tokenReductionSamples(events) {
  const samples = []
  for (const event of events) {
    const before = nonNegativeNumber(event.inputTokensBefore)
    const after = nonNegativeNumber(event.inputTokensAfter)
    if (before === undefined || after === undefined || after > before) continue
    samples.push({ before, after, reduction: before - after })
  }
  return samples
}

/**
 * 统一 Agent semantic event 的灰度与 Context V2 指标口径。
 *
 * 比率、分位数在零样本时统一返回 null；Count 保持 0。这样看板能区分“没有放量”
 * 和“已经放量但成功率为 0”。
 *
 * @param {Array<Record<string, any>>} [events]
 * @param {{ minimumPercentileSamples?: number }} [options]
 */
export function aggregateAgentSemanticMetrics(events = [], options = {}) {
  const minimumSamples = normalizeMinimumSamples(options?.minimumPercentileSamples)
  const all = Array.isArray(events) ? events.filter(isSemanticEvent) : []

  const rollout = eventsOf(all, AGENT_SEMANTIC_EVENT_NAMES.ROLLOUT_EVALUATED)
  const rolloutEnabled = rollout.filter((event) => event.decision === 'enabled')
  const rolloutTreatment = rollout.filter((event) => event.cohort === 'treatment')
  const rolloutKilled = rollout.filter((event) => event.cohort === 'killed')

  const shadow = eventsOf(all, AGENT_SEMANTIC_EVENT_NAMES.CONTEXT_SHADOW_EVALUATED)
  const shadowDecisions = outcomesOf(shadow, new Set(['would_compact', 'no_change']))
  const shadowFailures = shadow.filter((event) => event.outcome === 'failed')
  const shadowWouldCompact = shadow.filter((event) => event.outcome === 'would_compact')
  const shadowTokenComparisons = shadow.flatMap((event) => {
    const control = nonNegativeNumber(event.controlInputTokens)
    const candidate = nonNegativeNumber(event.candidateInputTokens)
    return control === undefined || candidate === undefined ? [] : [{ control, candidate }]
  })
  const shadowCandidateIncreases = shadowTokenComparisons.filter(({ control, candidate }) => candidate > control)

  const compaction = eventsOf(all, AGENT_SEMANTIC_EVENT_NAMES.CONTEXT_COMPACTION_RESULT)
  const compacted = compaction.filter((event) => event.outcome === 'compacted')
  const reused = compaction.filter((event) => event.outcome === 'reused')
  const noChange = compaction.filter((event) => event.outcome === 'no_change')
  const casConflict = compaction.filter((event) => event.outcome === 'cas_conflict')
  const compactionFailed = compaction.filter((event) => event.outcome === 'failed')
  const compactionResolved = compacted.length + reused.length + noChange.length
  const reductionSamples = tokenReductionSamples(compacted)
  const beforeTokens = reductionSamples.reduce((total, sample) => total + sample.before, 0)
  const afterTokens = reductionSamples.reduce((total, sample) => total + sample.after, 0)
  const reductionValues = reductionSamples.map((sample) => sample.reduction)

  const overflow = eventsOf(all, AGENT_SEMANTIC_EVENT_NAMES.CONTEXT_OVERFLOW_RESULT)
  const overflowRecovered = overflow.filter((event) => event.outcome === 'recovered')
  const overflowFailed = overflow.filter((event) => event.outcome === 'failed')
  const overflowRecoverySamples = overflowRecovered.length + overflowFailed.length

  const usageAnchor = eventsOf(all, AGENT_SEMANTIC_EVENT_NAMES.CONTEXT_USAGE_ANCHOR_RESULT)
  const usagePersisted = usageAnchor.filter((event) => event.outcome === 'persisted')
  const usageReused = usageAnchor.filter((event) => event.outcome === 'reused')
  const usageCasConflict = usageAnchor.filter((event) => event.outcome === 'cas_conflict')
  const usageFailed = usageAnchor.filter((event) => ['failed', 'not_found'].includes(event.outcome))
  const usageSettled = usagePersisted.length + usageReused.length + usageCasConflict.length + usageFailed.length

  return {
    sampleCount: all.length,
    rollout: {
      evaluationCount: rollout.length,
      enabledCount: rolloutEnabled.length,
      enabledCoverageRate: ratio(rolloutEnabled.length, rollout.length),
      treatmentCoverageRate: ratio(rolloutTreatment.length, rollout.length),
      killedCoverageRate: ratio(rolloutKilled.length, rollout.length),
    },
    shadow: {
      sampleCount: shadow.length,
      decisionSampleCount: shadowDecisions.length,
      failureRate: ratio(shadowFailures.length, shadow.length),
      wouldCompactRate: ratio(shadowWouldCompact.length, shadowDecisions.length),
      tokenComparisonSampleCount: shadowTokenComparisons.length,
      candidateIncreaseRate: ratio(shadowCandidateIncreases.length, shadowTokenComparisons.length),
      ...durationMetrics(shadow, minimumSamples),
    },
    compaction: {
      sampleCount: compaction.length,
      compactedCount: compacted.length,
      successRate: ratio(compactionResolved, compaction.length),
      reuseRate: ratio(reused.length, compacted.length + reused.length),
      casConflictRate: ratio(casConflict.length, compaction.length),
      failureRate: ratio(compactionFailed.length, compaction.length),
      tokenReductionSampleCount: reductionSamples.length,
      tokenReductionRate: ratio(beforeTokens - afterTokens, beforeTokens),
      p50TokenReduction: percentile(reductionValues, 0.5, minimumSamples),
      p95TokenReduction: percentile(reductionValues, 0.95, minimumSamples),
      ...durationMetrics(compaction, minimumSamples),
    },
    overflow: {
      sampleCount: overflowRecoverySamples,
      recoveryRate: ratio(overflowRecovered.length, overflowRecoverySamples),
      ...durationMetrics([...overflowRecovered, ...overflowFailed], minimumSamples),
    },
    usageAnchor: {
      sampleCount: usageSettled,
      persistenceRate: ratio(usagePersisted.length + usageReused.length, usageSettled),
      reuseRate: ratio(usageReused.length, usagePersisted.length + usageReused.length),
      casConflictRate: ratio(usageCasConflict.length, usageSettled),
      ...durationMetrics(usageAnchor, minimumSamples),
    },
  }
}

/**
 * 与旧 Operational Metrics 相同的 diff 语义，但只遍历固定 semantic families。
 * 任一侧为 null 时标成 insufficient_samples，绝不把无样本算成 0。
 *
 * @param {any} before
 * @param {any} after
 */
export function diffAgentSemanticMetrics(before, after) {
  const changes = []
  for (const family of AGENT_SEMANTIC_METRIC_FAMILIES) {
    const left = before?.[family] ?? {}
    const right = after?.[family] ?? {}
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      const from = left[key]
      const to = right[key]
      if (typeof from !== 'number' || typeof to !== 'number') {
        if (from !== to) changes.push({ family, metric: key, from: from ?? null, to: to ?? null, status: 'insufficient_samples' })
        continue
      }
      if (from === to) continue
      changes.push({ family, metric: key, from, to, delta: to - from, status: 'changed' })
    }
  }
  return changes
}
