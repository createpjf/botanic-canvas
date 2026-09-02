// @ts-check
/**
 * Agent Telemetry Metrics(升级计划 CS3):把已投影的安全语义事件旁路成 OTel 指标。
 *
 * 输入只接受 writeAgentSemanticEvent 已通过 schema 校验的事件——日志与 metrics 共用
 * 同一安全投影,调用方不维护第二套标签。所有标签只允许固定低基数枚举
 * (kind/outcome/reason/decision 等已在 agentSemanticEvent schema 收口的字段);
 * projectId/sessionId/turnId 等标识一律丢弃,不进 metrics。
 *
 * recorder 未初始化或 exporter 故障时全部 no-op/fail-open,绝不改变业务结果。
 */
import { metrics as otelMetrics } from '@opentelemetry/api'

const METER_NAME = 'botanic-agent'

/** 允许进入 metrics 标签的低基数字段;其余字段(含所有 *Id)一律丢弃。 */
const SAFE_ATTRIBUTE_KEYS = Object.freeze(['kind', 'outcome', 'reason', 'decision', 'cohort', 'mode', 'feature', 'phase', 'status'])

function safeAttributes(event) {
  const attributes = {}
  for (const key of SAFE_ATTRIBUTE_KEYS) {
    const value = event?.[key]
    if (typeof value === 'string' && value.length <= 120) attributes[key] = value
  }
  return attributes
}

let activeRecorder

/**
 * 初始化 metrics recorder。instruments 固定声明,不随事件动态创建;
 * meterProvider 由 telemetry bootstrap 注入,未启用时返回 no-op。
 */
export function initializeAgentTelemetryMetrics(input) {
  const { meterProvider } = input ?? {}
  if (!meterProvider) return Object.freeze({ enabled: false, record: () => {} })
  try {
    const meter = meterProvider.getMeter(METER_NAME)
    const eventCounter = meter.createCounter('botanic.agent.event.count', {
      description: 'Agent 语义事件计数(按 event/kind/outcome/reason 低基数标签)。',
    })
    const durationHistogram = meter.createHistogram('botanic.agent.event.duration', {
      description: '语义事件报告的传播/调用耗时(cancel_observed、provider call 等)。',
      unit: 'ms',
    })
    const generationHistogram = meter.createHistogram('botanic.agent.turn.generation', {
      description: 'Turn 恢复代际分布(resume_limit/deadline 事件附带)。',
    })
    const providerChunkHistogram = meter.createHistogram('botanic.agent.provider.chunk_count', {
      description: '单次Provider流的安全语义chunk数量。', unit: '{chunk}',
    })
    const providerChunkGapHistogram = meter.createHistogram('botanic.agent.provider.max_chunk_gap', {
      description: '单次Provider流的最大安全语义chunk间隔。', unit: 'ms',
    })
    const previewWriteHistogram = meter.createHistogram('botanic.agent.preview.write_count', {
      description: '单次Turn的Durable OutputPreview写入次数。', unit: '{write}',
    })
    const previewSizeHistogram = meter.createHistogram('botanic.agent.preview.max_char_count', {
      description: '单次Turn的Durable OutputPreview最大字符数。', unit: '{char}',
    })
    const previewNonEmptyHistogram = meter.createHistogram('botanic.agent.preview.nonempty', {
      description: '取消终态是否存在非空OutputPreview(0/1)。', unit: '{boolean}',
    })
    activeRecorder = Object.freeze({
      enabled: true,
      /** @param {Record<string, any>} event 已通过 agentSemanticEvent schema 的事件 */
      record(event) {
        try {
          const attributes = { event: event.event, ...safeAttributes(event) }
          eventCounter.add(1, attributes)
          if (Number.isFinite(Number(event.durationMs))) {
            durationHistogram.record(Number(event.durationMs), attributes)
          }
          if (Number.isSafeInteger(event.generation)) {
            generationHistogram.record(event.generation, attributes)
          }
          if (Number.isSafeInteger(event.chunkCount)) providerChunkHistogram.record(event.chunkCount, attributes)
          if (Number.isSafeInteger(event.maxChunkGapMs)) providerChunkGapHistogram.record(event.maxChunkGapMs, attributes)
          if (Number.isSafeInteger(event.writeCount)) previewWriteHistogram.record(event.writeCount, attributes)
          if (Number.isSafeInteger(event.maxCharCount)) previewSizeHistogram.record(event.maxCharCount, attributes)
          if (Number.isSafeInteger(event.nonEmptyCount)) previewNonEmptyHistogram.record(event.nonEmptyCount, attributes)
        } catch { /* metrics 旁路 fail-open。 */ }
      },
    })
    return activeRecorder
  } catch {
    return Object.freeze({ enabled: false, record: () => {} })
  }
}

/** 语义事件 writer 的旁路入口:未初始化时静默丢弃。 */
export function recordAgentSemanticMetric(event) {
  try {
    activeRecorder?.record(event)
  } catch { /* fail-open */ }
}

/** 测试与关停 seam。 */
export function resetAgentTelemetryMetrics() {
  activeRecorder = undefined
}

export { otelMetrics }
