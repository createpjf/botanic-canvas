// @ts-check
import { AsyncLocalStorage } from 'node:async_hooks'
import { ROOT_CONTEXT, context as otelContext } from '@opentelemetry/api'
import { W3CTraceContextPropagator } from '@opentelemetry/core'

const TRACE_PARENT_HEADER = 'traceparent'
const TRACE_STATE_HEADER = 'tracestate'
const TRACE_FIELDS = Object.freeze([TRACE_PARENT_HEADER, TRACE_STATE_HEADER])
const traceContextStorage = new AsyncLocalStorage()
const traceContextPropagator = new W3CTraceContextPropagator()

const carrierGetter = {
  get(carrier, key) {
    if (!carrier || typeof carrier !== 'object') return undefined
    const value = carrier[String(key).toLowerCase()]
    if (Array.isArray(value)) return value[0]
    return typeof value === 'string' ? value : undefined
  },
  keys() {
    // 只允许 W3C Trace Context；即使输入带 baggage 也不会读取或传播。
    return [...TRACE_FIELDS]
  },
}

const carrierSetter = {
  set(carrier, key, value) {
    if (!carrier || typeof carrier !== 'object') return
    const normalizedKey = String(key).toLowerCase()
    if (!TRACE_FIELDS.includes(normalizedKey)) return
    carrier[normalizedKey] = String(value)
  },
}

/**
 * 返回当前 Agent 链路上下文。模块自己的 AsyncLocalStorage 是队列边界的稳定来源；
 * 已初始化 OpenTelemetry SDK 时，API 的 active context 仍可作为入口上下文。
 */
export function currentAgentTraceContext() {
  try {
    return traceContextStorage.getStore() ?? otelContext.active() ?? ROOT_CONTEXT
  } catch {
    return ROOT_CONTEXT
  }
}

/**
 * 从不可信 carrier 只提取 traceparent/tracestate。非法或缺失 carrier 返回根上下文，
 * 不能让观测元数据阻断业务恢复。
 *
 * @param {unknown} carrier
 */
export function extractAgentTraceContext(carrier) {
  try {
    return traceContextPropagator.extract(ROOT_CONTEXT, carrier, carrierGetter)
  } catch {
    return ROOT_CONTEXT
  }
}

/**
 * 注入 W3C Trace Context。这里刻意不用全局 composite propagator，因此 baggage、
 * Prompt、成员信息和其他应用字段都不会跨队列传播。
 *
 * @param {import('@opentelemetry/api').Context} [traceContext]
 * @returns {{ traceparent?: string, tracestate?: string }}
 */
export function injectAgentTraceContext(traceContext = currentAgentTraceContext()) {
  /** @type {{ traceparent?: string, tracestate?: string }} */
  const carrier = {}
  try {
    traceContextPropagator.inject(traceContext ?? ROOT_CONTEXT, carrier, carrierSetter)
  } catch {
    // 可观测性失败不得改变队列或业务执行结果。
  }
  return carrier
}

/**
 * 外部 Provider/MCP 边界只发送 traceparent。tracestate 可能包含供应商私有状态，
 * baggage 更被明确禁用；两者都不得跨到未共同治理的服务。
 */
export function outboundAgentTraceHeaders() {
  const carrier = injectAgentTraceContext()
  return carrier.traceparent ? { traceparent: carrier.traceparent } : {}
}

/**
 * 在同步与异步边界内安装上下文。若 OpenTelemetry 的全局 ContextManager 尚未初始化，
 * 自有 AsyncLocalStorage 仍保证本模块的 current/inject 正常工作。
 *
 * @template T
 * @param {import('@opentelemetry/api').Context | undefined} traceContext
 * @param {() => T} callback
 * @returns {T}
 */
export function withAgentTraceContext(traceContext, callback) {
  if (typeof callback !== 'function') throw new TypeError('Agent Trace Context 缺少回调。')
  const selected = traceContext ?? ROOT_CONTEXT
  let callbackInvoked = false
  const invoke = () => {
    callbackInvoked = true
    return callback()
  }
  try {
    return traceContextStorage.run(selected, () => {
      try {
        return otelContext.with(selected, invoke)
      } catch (error) {
        if (callbackInvoked) throw error
        return invoke()
      }
    })
  } catch (error) {
    if (callbackInvoked) throw error
    return invoke()
  }
}

/**
 * 把当前 W3C carrier 附着到 BullMQ 数据；无有效上下文时保持原 payload 形状和引用。
 *
 * @template {Record<string, any>} T
 * @param {T} payload
 * @returns {T & { traceparent?: string, tracestate?: string }}
 */
export function attachAgentTraceContext(payload) {
  try {
    const carrier = injectAgentTraceContext()
    if (!carrier.traceparent) return payload
    return {
      ...payload,
      traceparent: carrier.traceparent,
      ...(carrier.tracestate ? { tracestate: carrier.tracestate } : {}),
    }
  } catch {
    return payload
  }
}

/**
 * Worker 侧提取 carrier，并把内部传播字段从业务 payload 剥离。旧任务没有 carrier 时
 * 原样交给处理器；非法 carrier 也只降级为根上下文。
 *
 * @template T
 * @param {T} payload
 * @param {(businessPayload: T) => any} callback
 */
export function withExtractedAgentTraceContext(payload, callback) {
  /** @type {Record<string, any> | undefined} */
  let source
  let businessPayload = payload
  try {
    source = payload && typeof payload === 'object'
      ? /** @type {Record<string, any>} */ (payload)
      : undefined
    const hasTraceFields = Boolean(source && (
      Object.prototype.hasOwnProperty.call(source, TRACE_PARENT_HEADER)
      || Object.prototype.hasOwnProperty.call(source, TRACE_STATE_HEADER)
    ))
    if (hasTraceFields && source) {
      const { traceparent: _traceparent, tracestate: _tracestate, ...rest } = source
      businessPayload = /** @type {T} */ (rest)
    }
  } catch {
    source = undefined
  }
  return withAgentTraceContext(extractAgentTraceContext(source), () => callback(businessPayload))
}
