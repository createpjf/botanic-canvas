import assert from 'node:assert/strict'
import test from 'node:test'
import { initializeBotanicTelemetry, resolveBotanicTelemetryConfig } from './botanicTelemetry.mjs'

test('Telemetry 默认关闭，GenAI development semconv 独立关闭', () => {
  assert.deepEqual(resolveBotanicTelemetryConfig({}), {
    enabled: false,
    genAiDevelopmentSemconv: false,
    serviceName: 'botanic-agent',
    serviceVersion: 'development',
    serviceInstanceId: 'local',
    deploymentEnvironment: 'development',
    sampleRatio: 0.1,
  })
})

test('Telemetry 配置限制采样比例且不接收 exporter headers', () => {
  const config = resolveBotanicTelemetryConfig({
    AGENT_TELEMETRY_ENABLED: 'true',
    AGENT_GENAI_TELEMETRY_ENABLED: 'true',
    OTEL_SERVICE_NAME: 'botanic-worker',
    BOTANIC_TELEMETRY_SAMPLE_RATIO: '9',
    OTEL_EXPORTER_OTLP_HEADERS: 'authorization=secret',
  })
  assert.equal(config.enabled, true)
  assert.equal(config.genAiDevelopmentSemconv, true)
  assert.equal(config.sampleRatio, 1)
  assert.doesNotMatch(JSON.stringify(config), /authorization|secret/u)
})

test('Telemetry 关闭时不构造 exporter/provider', async () => {
  let calls = 0
  const telemetry = initializeBotanicTelemetry({ enabled: false }, {
    Provider: class { constructor() { calls += 1 } },
    Exporter: class { constructor() { calls += 1 } },
  })
  assert.equal(telemetry.enabled, false)
  assert.equal(calls, 0)
  await telemetry.shutdown()
})
