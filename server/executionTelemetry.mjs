// @ts-check

import {
  SpanKind,
  SpanStatusCode,
  context,
  trace,
} from '@opentelemetry/api'
import { currentAgentTraceContext } from './agentTraceContext.mjs'

const tracerName = 'botanic.agent.runtime'
const kinds = Object.freeze({
  internal: SpanKind.INTERNAL,
  server: SpanKind.SERVER,
  client: SpanKind.CLIENT,
  producer: SpanKind.PRODUCER,
  consumer: SpanKind.CONSUMER,
})

const attributeKeys = new Set([
  'http.request.method', 'url.scheme', 'url.path', 'http.route', 'http.response.status_code',
  'error.type',
  'gen_ai.operation.name', 'gen_ai.provider.name', 'gen_ai.request.model',
  'gen_ai.tool.name',
  'gen_ai.response.model', 'gen_ai.request.stream', 'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens', 'gen_ai.usage.reasoning.output_tokens',
  'gen_ai.conversation.compacted',
  'botanic.component', 'botanic.phase', 'botanic.status', 'botanic.trigger',
  'botanic.request.id', 'botanic.project.id', 'botanic.session.id', 'botanic.message.id',
  'botanic.turn.id', 'botanic.run.id', 'botanic.branch.id', 'botanic.job.id',
  'botanic.artifact.id', 'botanic.review_task.id', 'botanic.subagent.id',
  'botanic.activation.id', 'botanic.tool_call.id', 'botanic.context.policy_hash',
  'botanic.execution.generation', 'botanic.attempt', 'botanic.retry_count',
  'botanic.context.before_input_tokens', 'botanic.context.after_input_tokens',
  'botanic.context.replaced_messages',
])

const unsafe = /(?:https?:\/\/|data:[^;]+;base64,|\bBearer\s+|\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]{8,}\.)/iu
const safeString = (value) => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed && trimmed.length <= 240 && !unsafe.test(trimmed) ? trimmed : undefined
}

export function safeBotanicSpanAttributes(input = {}) {
  /** @type {import('@opentelemetry/api').Attributes} */
  const output = {}
  for (const [key, value] of Object.entries(input ?? {})) {
    if (!attributeKeys.has(key)) continue
    if (typeof value === 'string') {
      const safe = safeString(value)
      if (safe !== undefined) output[key] = safe
      continue
    }
    if (typeof value === 'boolean') output[key] = value
    else if (Number.isFinite(value)) output[key] = Number(value)
  }
  return output
}

export function activeBotanicTraceFields() {
  const activeContext = context.active()
  const spanContext = trace.getSpanContext(activeContext)
    ?? trace.getSpanContext(currentAgentTraceContext())
  if (!spanContext || !trace.isSpanContextValid(spanContext)) return {}
  return { traceId: spanContext.traceId, spanId: spanContext.spanId, traceFlags: spanContext.traceFlags }
}

export function setBotanicHttpSpanStatus(span, statusCode) {
  if (!span || !Number.isInteger(statusCode)) return
  span.setStatus({ code: statusCode >= 500 ? SpanStatusCode.ERROR : SpanStatusCode.OK })
}

/**
 * OTel 唯一执行入口。未注册 SDK 时 API 自然 no-op；Exporter/Span 异常也不会改变
 * 业务返回。错误只记录类型码，不 recordException，避免 stack/message 带入 Prompt。
 */
export async function withBotanicSpan(name, options, operation) {
  if (typeof operation !== 'function') throw new TypeError('Botanic Span 缺少业务操作。')
  const safeName = safeString(name) ?? 'botanic.operation'
  let operationStarted = false
  try {
    const tracer = trace.getTracer(tracerName)
    return await tracer.startActiveSpan(safeName, {
      kind: kinds[options?.kind] ?? SpanKind.INTERNAL,
      attributes: safeBotanicSpanAttributes(options?.attributes),
      ...(Array.isArray(options?.links) ? { links: options.links } : {}),
    }, async (span) => {
      operationStarted = true
      try {
        const result = await operation(span)
        if (options?.automaticSuccessStatus !== false) {
          try { span.setStatus({ code: SpanStatusCode.OK }) } catch { /* exporter/sdk isolation */ }
        }
        return result
      } catch (caught) {
        const errorCode = caught && typeof caught === 'object' && 'code' in caught ? caught.code : undefined
        const errorName = caught && typeof caught === 'object' && 'name' in caught ? caught.name : undefined
        const errorType = safeString(errorCode) ?? safeString(errorName) ?? 'unknown_error'
        try {
          span.setAttribute('error.type', errorType)
          span.setStatus({ code: SpanStatusCode.ERROR })
        } catch { /* exporter/sdk isolation */ }
        throw caught
      } finally {
        try { span.end() } catch { /* exporter/sdk isolation */ }
      }
    })
  } catch (caught) {
    // startActiveSpan 自身失败属于观测故障；业务操作还未执行时必须继续执行一次。
    // 业务操作已经开始后的异常必须原样抛出，避免任何自动二次执行。
    if (operationStarted) throw caught
    return operation(undefined)
  }
}
