/**
 * OpenAI 兼容 `chat/completions` 的流式读取。
 *
 * 传输层的唯一职责是：把增量块累积回**非流式的响应形状**，让工具循环完全不需要
 * 区分两种传输；同时把可展示的增量通过 onEvent 转发出去。工具循环、计划归一化和
 * 安全校验因此保持不变，流式只是换了一条管道。
 */

const DONE = '[DONE]'

export class BotanicAgentStreamError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'BotanicAgentStreamError'
    this.code = code
    this.statusCode = 502
  }
}

function usageToken(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function firstUsageToken(usage, names) {
  for (const name of names) {
    const value = usageToken(usage?.[name])
    if (value !== undefined) return value
  }
  return undefined
}

/**
 * 把 Chat Completions / Responses 风格的 usage 收敛成内部统一计量单位。
 * 不保留 Provider 原始对象，避免后续计量模块绑定某一家字段命名。
 */
export function normalizeProviderUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return undefined
  const inputTokens = firstUsageToken(usage, ['prompt_tokens', 'input_tokens'])
  const outputTokens = firstUsageToken(usage, ['completion_tokens', 'output_tokens'])
  const reportedTotal = usageToken(usage.total_tokens)
  const totalTokens = reportedTotal ?? (
    inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined
  )
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  }
}

function normalizeToolCallDelta(state, delta) {
  const index = Number.isInteger(delta?.index) ? delta.index : 0
  const current = state.get(index) ?? { index, id: '', type: 'function', function: { name: '', arguments: '' } }
  if (typeof delta?.id === 'string' && delta.id) current.id = delta.id
  if (typeof delta?.type === 'string' && delta.type) current.type = delta.type
  if (typeof delta?.function?.name === 'string' && delta.function.name) current.function.name = delta.function.name
  if (typeof delta?.function?.arguments === 'string') current.function.arguments += delta.function.arguments
  state.set(index, current)
  return current
}

/**
 * 累积增量块。同一个累积器只服务一次模型调用。
 * onEvent 只转发可展示的增量；调用方决定其中哪些真正下发给浏览器。
 */
export function createChatCompletionAccumulator({ onEvent } = {}) {
  let content = ''
  let reasoning = ''
  let finishReason
  let usage
  let answerChunkIndex = 0
  let reasoningChunkIndex = 0
  const toolCalls = new Map()
  const namedToolCalls = new Set()
  const emit = (event) => {
    if (typeof onEvent !== 'function') return
    try { onEvent(event) } catch { /* 展示层异常不得中断模型读取。 */ }
  }

  return {
    push(chunk) {
      // include_usage 的最后一块通常没有 choices；必须在 choice 之前保留。
      if (chunk && Object.prototype.hasOwnProperty.call(chunk, 'usage')) usage = chunk.usage
      const choice = chunk?.choices?.[0]
      if (!choice) return
      const delta = choice.delta ?? {}
      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content
        emit({ type: 'answer', delta: delta.content, chunkIndex: answerChunkIndex++ })
      }
      const reasoningDelta = typeof delta.reasoning_content === 'string'
        ? delta.reasoning_content
        : typeof delta.reasoning === 'string' ? delta.reasoning : ''
      if (reasoningDelta) {
        reasoning += reasoningDelta
        emit({ type: 'reasoning', delta: reasoningDelta, chunkIndex: reasoningChunkIndex++ })
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const toolCallDelta of delta.tool_calls) {
          const call = normalizeToolCallDelta(toolCalls, toolCallDelta)
          // 工具名一旦出现就先播报一次，用户不必等参数流完才知道在调什么。
          if (call.function.name && !namedToolCalls.has(call.index)) {
            namedToolCalls.add(call.index)
            emit({ type: 'tool_call', index: call.index, id: call.id, name: call.function.name })
          }
        }
      }
      if (typeof choice.finish_reason === 'string' && choice.finish_reason) finishReason = choice.finish_reason
    },
    /** 还原成非流式响应形状，供既有工具循环直接消费。 */
    result() {
      const calls = [...toolCalls.values()]
        .sort((left, right) => left.index - right.index)
        .filter((call) => call.function.name)
        .map((call, order) => ({
          id: call.id || `tool-call-stream-${order + 1}`,
          type: call.type || 'function',
          function: { name: call.function.name, arguments: call.function.arguments || '{}' },
        }))
      return {
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content,
            ...(reasoning ? { reasoning_content: reasoning } : {}),
            ...(calls.length ? { tool_calls: calls } : {}),
          },
          ...(finishReason ? { finish_reason: finishReason } : {}),
        }],
        ...(usage === undefined ? {} : { usage }),
      }
    },
  }
}

function toAsyncIterable(body) {
  if (!body) return undefined
  if (typeof body[Symbol.asyncIterator] === 'function') return body
  if (typeof body.getReader !== 'function') return undefined
  return (async function* read() {
    const reader = body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        if (value) yield value
      }
    } finally {
      reader.releaseLock?.()
    }
  })()
}

/**
 * 逐事件读取 SSE 响应体。按 SSE 规范处理跨网络块切断的行、注释行与多行 data，
 * 只有 [DONE] 才是正常终止。坏 JSON、未闭合 tail 或 EOF 前缺 [DONE] 都是截断失败。
 */
export async function* readServerSentEvents(body, { onActivity } = {}) {
  const stream = toAsyncIterable(body)
  if (!stream) return
  const decoder = new TextDecoder()
  let buffer = ''
  let dataLines = []
  let doneSeen = false

  const flush = function* flushEvent() {
    if (!dataLines.length) return
    const payload = dataLines.join('\n')
    dataLines = []
    if (payload === DONE) { doneSeen = true; return }
    try {
      yield JSON.parse(payload)
    } catch {
      throw new BotanicAgentStreamError('PROVIDER_STREAM_MALFORMED', 'Agent 模型返回了损坏的流式事件。')
    }
  }

  for await (const chunk of stream) {
    try { onActivity?.() } catch { /* transport activity observer 不能中断模型读取。 */ }
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    let newlineIndex = buffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, '')
      buffer = buffer.slice(newlineIndex + 1)
      if (!line) {
        yield* flush()
      } else if (line.startsWith('data:')) {
        const value = line.slice(5).trimStart()
        if (value === DONE) {
          yield* flush()
          doneSeen = true
          return
        }
        dataLines.push(value)
      }
      // 其余字段（event / id / retry / 注释行）当前不需要。
      newlineIndex = buffer.indexOf('\n')
    }
  }
  // EOF 时任何未闭合 tail/data 都不能补成合法事件;缺 [DONE] 同样是截断。
  if (buffer || dataLines.length || !doneSeen) {
    throw new BotanicAgentStreamError('PROVIDER_STREAM_CLOSED', 'Agent 模型流式响应提前结束。')
  }
}

/** 读完一次流式模型调用，返回与非流式完全一致的响应形状。 */
export async function readStreamedChatCompletion(body, { onEvent, onActivity } = {}) {
  const accumulator = createChatCompletionAccumulator({ onEvent })
  for await (const chunk of readServerSentEvents(body, { onActivity })) accumulator.push(chunk)
  return accumulator.result()
}
