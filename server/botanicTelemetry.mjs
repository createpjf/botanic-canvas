// @ts-check

import { W3CTraceContextPropagator } from '@opentelemetry/core'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-node'

const truthy = new Set(['1', 'true', 'yes', 'on'])
const enabled = (value, fallback = false) => value === undefined
  ? fallback
  : truthy.has(String(value).trim().toLowerCase())

export function resolveBotanicTelemetryConfig(env = process.env) {
  const ratio = Number(env.OTEL_TRACES_SAMPLER_ARG ?? env.BOTANIC_TELEMETRY_SAMPLE_RATIO ?? 0.1)
  return Object.freeze({
    enabled: enabled(env.AGENT_TELEMETRY_ENABLED, false),
    genAiDevelopmentSemconv: enabled(env.AGENT_GENAI_TELEMETRY_ENABLED, false),
    serviceName: (env.OTEL_SERVICE_NAME ?? 'botanic-agent').trim() || 'botanic-agent',
    serviceVersion: (env.BOTANIC_SERVICE_VERSION ?? env.RAILWAY_GIT_COMMIT_SHA ?? 'development').trim(),
    serviceInstanceId: (env.RAILWAY_REPLICA_ID ?? env.HOSTNAME ?? 'local').trim(),
    deploymentEnvironment: (env.RAILWAY_ENVIRONMENT_NAME ?? env.NODE_ENV ?? 'development').trim(),
    sampleRatio: Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0.1,
  })
}

let activeProvider

/**
 * Traces-only、vendor-neutral 的 OTel bootstrap。OTLP exporter 使用标准 OTEL_* 环境
 * 变量，密钥/header 不复制进 Runtime Config 或健康接口。Baggage 不注册。
 */
export function initializeBotanicTelemetry(config, dependencies = {}) {
  if (!config?.enabled) return Object.freeze({ enabled: false, shutdown: async () => {} })
  if (activeProvider) return activeProvider
  try {
    const Provider = dependencies.Provider ?? NodeTracerProvider
    const Exporter = dependencies.Exporter ?? OTLPTraceExporter
    const exporter = new Exporter()
    const provider = new Provider({
      resource: resourceFromAttributes({
        'service.namespace': 'botanic',
        'service.name': config.serviceName,
        'service.version': config.serviceVersion,
        'service.instance.id': config.serviceInstanceId,
        'deployment.environment.name': config.deploymentEnvironment,
      }),
      sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(config.sampleRatio) }),
      spanProcessors: [new BatchSpanProcessor(exporter)],
    })
    provider.register({ propagator: new W3CTraceContextPropagator() })
    activeProvider = Object.freeze({
      enabled: true,
      async forceFlush() { await provider.forceFlush() },
      async shutdown() {
        try { await provider.shutdown() } finally { activeProvider = undefined }
      },
    })
    return activeProvider
  } catch (caught) {
    const errorType = caught && typeof caught === 'object'
      ? ('code' in caught && typeof caught.code === 'string'
          ? caught.code
          : 'name' in caught && typeof caught.name === 'string' ? caught.name : 'unknown')
      : 'unknown'
    dependencies.logger?.error?.(`[telemetry] initialization disabled: ${errorType}`)
    return Object.freeze({ enabled: false, shutdown: async () => {} })
  }
}
