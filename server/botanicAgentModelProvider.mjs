// @ts-check
/**
 * Agent Model Provider(升级计划 1A):Agent 侧 LLM 采样的唯一传输 seam。
 *
 * 它拥有并隐藏所有传输差异——base URL、鉴权/trace headers、per-call timeout 与根
 * signal 组合、SSE 归一化、HTTP/transport 错误分类、usage 归一化、context-overflow
 * 识别、provider.call_timeout 语义事件。调用方(Turn/Chat/Planner/Subagent/Vision/
 * Review/Summarizer/Refinement)只构造 sample request,不再知道 HTTP endpoint。
 *
 * 明确不拥有的:Prompt/角色、temperature 数值、业务模型选择、fail-open/fail-closed、
 * Context V2 压缩重试(仍由 ToolLoop/Context owner 做最多一次)、以及任何 retry——
 * transport retry 保持 H3C Gate 关闭,本模块一次请求只发一次。
 *
 * 错误统一为带 code/statusCode 的 BotanicAgentModelProviderError:
 * REQUEST_CANCELLED 499 / PROVIDER_TIMEOUT 504 / PROVIDER_AUTH_FAILED 502 /
 * PROVIDER_RATE_LIMITED 429 / PROVIDER_UNAVAILABLE 502 / PROVIDER_REJECTED 422 /
 * INVALID_PROVIDER_RESPONSE 502;context overflow 保留 AGENT_CONTEXT_OVERFLOW 原错误。
 * raw Provider body 不进入错误对象,只用于 overflow 判定后丢弃。
 */
import { outboundAgentTraceHeaders } from './agentTraceContext.mjs'
import { throwIfAgentProviderContextOverflow } from './agentProviderContextOverflow.mjs'
import { BotanicAgentStreamError, readStreamedChatCompletion } from './botanicAgentStream.mjs'
import { AGENT_SEMANTIC_EVENT_NAMES, writeAgentSemanticEvent } from './agentSemanticEvent.mjs'

/** 与既有 Planner 目录一致的缺省 Agent 模型。 */
export const DEFAULT_AGENT_MODELS = Object.freeze(['deepseek-v4-flash-vision-exp', 'kimi-k3', 'gemini-3.7-flash', 'glm-5'])

export class BotanicAgentModelProviderError extends Error {
  constructor(statusCode, code, message) {
    super(message)
    this.name = 'BotanicAgentModelProviderError'
    this.statusCode = statusCode
    this.code = code
  }
}

function invalidRequest(message) {
  throw new BotanicAgentModelProviderError(400, 'INVALID_REQUEST', message)
}

/** HTTP 状态 → 统一错误。既有 Planner 语义原样保留。 */
export function agentModelProviderResponseError(status) {
  if (status === 401 || status === 403) return new BotanicAgentModelProviderError(502, 'PROVIDER_AUTH_FAILED', 'Agent 模型服务鉴权失败。')
  if (status === 429) return new BotanicAgentModelProviderError(429, 'PROVIDER_RATE_LIMITED', 'Agent 模型服务当前繁忙，请稍后重试。')
  if (Number(status) >= 500) return new BotanicAgentModelProviderError(502, 'PROVIDER_UNAVAILABLE', 'Agent 模型服务暂时不可用，请稍后重试。')
  return new BotanicAgentModelProviderError(422, 'PROVIDER_REJECTED', 'Agent 模型服务无法处理本次请求。')
}

/** kimi-k3 需要 temperature=1;其余保持 0.1。调用方可显式覆盖。 */
export function agentModelProviderTemperature(model) {
  return model === 'kimi-k3' ? 1 : 0.1
}

function boundedTimeoutMs(value, fallback = 55_000) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(60_000, Math.max(1_000, parsed))
}

/** 每次请求的超时预算由调用方拥有(视觉/摘要/润色各不相同),只设护栏上下限。 */
function boundedRequestTimeoutMs(value, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(60_000, parsed)
}

/**
 * 解析一次 Agent 模型配置。requestedModel 必须在目录内;缺 key/model 具名 503。
 * 与旧 botanicAgentProviderConfig 同语义,错误类型换成 Provider 模块自己的。
 */
export function agentModelProviderConfig(runtimeConfig, requestedModel) {
  const baseUrl = typeof runtimeConfig?.flockApiBaseUrl === 'string' && runtimeConfig.flockApiBaseUrl.trim()
    ? runtimeConfig.flockApiBaseUrl.trim().replace(/\/+$/, '')
    : 'https://api.flock.io/v1'
  const apiKey = typeof runtimeConfig?.flockApiKey === 'string' ? runtimeConfig.flockApiKey.trim() : ''
  const defaultModel = typeof runtimeConfig?.flockTextModel === 'string' ? runtimeConfig.flockTextModel.trim() : ''
  const allowedModels = Array.isArray(runtimeConfig?.flockAgentModels)
    ? [...new Set(runtimeConfig.flockAgentModels.filter((model) => typeof model === 'string').map((model) => model.trim()).filter(Boolean))]
    : [...new Set([defaultModel, ...DEFAULT_AGENT_MODELS].filter(Boolean))]
  if (requestedModel && !allowedModels.includes(requestedModel)) invalidRequest('Agent 模型不在可用目录中。')
  const model = requestedModel || defaultModel || allowedModels[0] || ''
  if (!apiKey || !model) {
    throw new BotanicAgentModelProviderError(503, 'PROVIDER_NOT_CONFIGURED', 'Agent 模型服务尚未配置。')
  }
  return {
    baseUrl,
    apiKey,
    model,
    allowedModels,
    genAiDevelopmentSemconv: runtimeConfig?.telemetry?.genAiDevelopmentSemconv === true,
    timeoutMs: boundedTimeoutMs(runtimeConfig?.agentPlannerTimeoutMs),
  }
}

/**
 * 构造 Agent Model Provider。
 *
 * dependencies.fetchImpl 是唯一测试 seam;不注入时用全局 fetch。
 * provider 无状态、可并发,配置在构造时冻结。
 */
export function createBotanicAgentModelProvider(runtimeConfig, { fetchImpl = fetch, now = Date.now } = {}) {
  const baseUrl = typeof runtimeConfig?.flockApiBaseUrl === 'string' && runtimeConfig.flockApiBaseUrl.trim()
    ? runtimeConfig.flockApiBaseUrl.trim().replace(/\/+$/, '')
    : 'https://api.flock.io/v1'
  const apiKey = typeof runtimeConfig?.flockApiKey === 'string' ? runtimeConfig.flockApiKey.trim() : ''
  const defaultTimeoutMs = boundedTimeoutMs(runtimeConfig?.agentPlannerTimeoutMs)

  /**
   * 单次采样。stream=true 时把 SSE 归一化回非流式 completion 形状,
   * 可展示增量经 onEvent 旁路转发;两种传输返回同一形状 { choices, usage }。
   *
   * @param {{
   *   model: string,
   *   messages: unknown[],
   *   tools?: unknown[],
   *   toolChoice?: unknown,
   *   maxOutputTokens?: number,
   *   temperature?: number,
   *   stream?: boolean,
   *   timeoutMs?: number,
   *   signal?: AbortSignal,
   *   onEvent?: (event: { type: string }) => void,
   *   responseFormat?: unknown,
   * }} request
   */
  async function sample(request) {
    const model = typeof request?.model === 'string' ? request.model.trim() : ''
    if (!model) invalidRequest('Agent 采样缺少模型。')
    if (!Array.isArray(request?.messages) || !request.messages.length) invalidRequest('Agent 采样缺少消息。')
    if (!apiKey) throw new BotanicAgentModelProviderError(503, 'PROVIDER_NOT_CONFIGURED', 'Agent 模型服务尚未配置。')
    const stream = request.stream === true
    const timeoutMs = boundedRequestTimeoutMs(request.timeoutMs, defaultTimeoutMs)
    // per-call timeout 每次采样重建;根 signal 只组合,不被覆盖。
    const timeoutController = new AbortController()
    const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs)
    const callTimeout = timeoutController.signal
    const signal = request.signal ? AbortSignal.any([request.signal, callTimeout]) : callTimeout
    const startedAt = now()
    try {
      let response
      try {
        response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            ...outboundAgentTraceHeaders(),
            Authorization: `Bearer ${apiKey}`,
            'x-litellm-api-key': apiKey,
            Accept: stream ? 'text/event-stream' : 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages: request.messages,
            ...(request.tools !== undefined ? { tools: request.tools } : {}),
            ...(request.toolChoice !== undefined ? { tool_choice: request.toolChoice } : {}),
            ...(Number.isFinite(Number(request.maxOutputTokens)) ? { max_tokens: Number(request.maxOutputTokens) } : {}),
            temperature: Number.isFinite(Number(request.temperature)) ? Number(request.temperature) : agentModelProviderTemperature(model),
            ...(request.responseFormat !== undefined ? { response_format: request.responseFormat } : {}),
            stream,
          }),
          signal,
        })
      } catch (caught) {
        throw classifyTransportFailure(caught, { rootSignal: request.signal, callTimeout, startedAt })
      }
      try {
        if (!response.ok) {
          // overflow 判定需要 body;判定后丢弃,不进入错误对象。
          const failureBody = await response.text()
          throwIfAgentProviderContextOverflow(response.status, failureBody)
          throw agentModelProviderResponseError(response.status)
        }
        if (!stream) {
          const parsed = /** @type {{ choices?: unknown } | null} */ (await response.json().catch((caught) => {
            if (request.signal?.aborted || callTimeout.aborted) throw caught
            return null
          }))
          if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.choices)) {
            throw new BotanicAgentModelProviderError(502, 'INVALID_PROVIDER_RESPONSE', 'Agent 模型返回了无法解析的响应。')
          }
          return parsed
        }
        return await readStreamedChatCompletion(response.body, {
          onEvent: typeof request.onEvent === 'function' ? request.onEvent : undefined,
        })
      } catch (caught) {
        if (caught instanceof BotanicAgentModelProviderError) throw caught
        if (caught instanceof BotanicAgentStreamError) {
          throw new BotanicAgentModelProviderError(caught.statusCode, caught.code, caught.message)
        }
        if (caught && typeof caught === 'object' && 'code' in caught && caught.code === 'AGENT_CONTEXT_OVERFLOW') throw caught
        throw classifyTransportFailure(caught, { rootSignal: request.signal, callTimeout, startedAt })
      }
    } finally {
      clearTimeout(timeoutId)
    }
  }

  /** 传输失败归类:根取消 > per-call timeout > 网络不可用。timeout 才 emit call_timeout。 */
  function classifyTransportFailure(caught, { rootSignal, callTimeout, startedAt }) {
    if (rootSignal?.aborted) {
      return new BotanicAgentModelProviderError(499, 'REQUEST_CANCELLED', 'Agent 请求已取消。')
    }
    if (callTimeout.aborted) {
      writeAgentSemanticEvent(AGENT_SEMANTIC_EVENT_NAMES.HARNESS_LIFECYCLE, {
        kind: 'provider',
        outcome: 'call_timeout',
        durationMs: Math.max(0, now() - startedAt),
      })
      return new BotanicAgentModelProviderError(504, 'PROVIDER_TIMEOUT', 'Agent 模型响应超时，请重试。')
    }
    void caught
    return new BotanicAgentModelProviderError(502, 'PROVIDER_UNAVAILABLE', 'Agent 模型服务暂时不可用，请稍后重试。')
  }

  return Object.freeze({ sample })
}
