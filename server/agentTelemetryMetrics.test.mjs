import assert from 'node:assert/strict'
import test from 'node:test'
import { initializeAgentTelemetryMetrics, recordAgentSemanticMetric, resetAgentTelemetryMetrics } from './agentTelemetryMetrics.mjs'
import { agentRuntimeDiagnosticsSnapshot, registerAgentDiagnosticGauge, unregisterAgentDiagnosticGauge } from './agentRuntimeDiagnostics.mjs'

function fakeMeterProvider(records) {
  return {
    getMeter() {
      return {
        createCounter: () => ({ add: (value, attributes) => records.push({ instrument: 'counter', value, attributes }) }),
        createHistogram: (name) => ({ record: (value, attributes) => records.push({ instrument: name, value, attributes }) }),
      }
    },
  }
}

test('语义事件旁路成低基数指标:标识字段被丢弃,duration/generation 进直方图', () => {
  const records = []
  initializeAgentTelemetryMetrics({ meterProvider: fakeMeterProvider(records) })
  try {
    recordAgentSemanticMetric({
      event: 'botanic.agent.harness.lifecycle',
      kind: 'cancel',
      outcome: 'cancel_observed',
      durationMs: 1500,
      generation: 2,
      projectId: 'project-secret',
      turnId: 'turn-secret',
    })
    recordAgentSemanticMetric({
      event: 'botanic.agent.harness.lifecycle', kind: 'provider', outcome: 'stream_completed',
      durationMs: 2_000, chunkCount: 8, maxChunkGapMs: 80,
    })
    const counter = records.find((entry) => entry.instrument === 'counter')
    assert.equal(counter.attributes.kind, 'cancel')
    assert.equal(counter.attributes.outcome, 'cancel_observed')
    // 标识一律不进 metrics 标签。
    assert.equal(JSON.stringify(records).includes('secret'), false)
    assert.ok(records.some((entry) => entry.instrument === 'botanic.agent.event.duration' && entry.value === 1500))
    assert.ok(records.some((entry) => entry.instrument === 'botanic.agent.turn.generation' && entry.value === 2))
    assert.ok(records.some((entry) => entry.instrument === 'botanic.agent.provider.chunk_count' && entry.value === 8))
    assert.ok(records.some((entry) => entry.instrument === 'botanic.agent.provider.max_chunk_gap' && entry.value === 80))
  } finally {
    resetAgentTelemetryMetrics()
  }
})

test('recorder 未初始化或 gauge 源抛错都 fail-open,快照只含计数与字节', () => {
  resetAgentTelemetryMetrics()
  // 未初始化:静默丢弃,不抛错。
  recordAgentSemanticMetric({ event: 'botanic.agent.harness.lifecycle', kind: 'tool', outcome: 'succeeded' })
  // gauge 源抛错 → null,不影响其他源。
  registerAgentDiagnosticGauge('agent.test.broken', () => { throw new Error('boom') })
  registerAgentDiagnosticGauge('agent.test.ok', () => 7)
  registerAgentDiagnosticGauge('agent.test.shared', () => 2)
  registerAgentDiagnosticGauge('agent.test.shared', () => 3)
  try {
    const snapshot = agentRuntimeDiagnosticsSnapshot({ now: () => 42 })
    assert.equal(snapshot.gauges['agent.test.broken'], null)
    assert.equal(snapshot.gauges['agent.test.ok'], 7)
    assert.equal(snapshot.gauges['agent.test.shared'], 5)
    assert.equal(snapshot.generatedAt, 42)
    assert.ok(snapshot.process.rssBytes > 0)
    assert.equal(JSON.stringify(snapshot).includes('prompt'), false)
  } finally {
    unregisterAgentDiagnosticGauge('agent.test.broken')
    unregisterAgentDiagnosticGauge('agent.test.ok')
    unregisterAgentDiagnosticGauge('agent.test.shared')
  }
})
