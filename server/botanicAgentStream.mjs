/**
 * OpenAI 兼容 `chat/completions` 的流式读取。
 *
 * 传输层的唯一职责是：把增量块累积回**非流式的响应形状**，让工具循环完全不需要
 * 区分两种传输；同时把可展示的增量通过 onEvent 转发出去。工具循环、计划归一化和
 * 安全校验因此保持不变，流式只是换了一条管道。
 */

const DONE = '[DONE]'

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
  const toolCalls = new Map()
  const namedToolCalls = new Set()
  const emit = (event) => {
    if (typeof onEvent !== 'function') return
    try { onEvent(event) } catch { /* 展示层异常不得中断模型读取。 */ }
  }

  return {
    push(chunk) {
      const choice = chunk?.choices?.[0]
      if (!choice) return
      const delta = choice.delta ?? {}
      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content
        emit({ type: 'answer', delta: delta.content })
      }
      const reasoningDelta = typeof delta.reasoning_content === 'string'
        ? delta.reasoning_content
        : typeof delta.reasoning === 'string' ? delta.reasoning : ''
      if (reasoningDelta) {
        reasoning += reasoningDelta
        emit({ type: 'reasoning', delta: reasoningDelta })
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
 * 遇到 [DONE] 结束。解析不出 JSON 的事件被跳过而不是让整轮失败。
 */
export async function* readServerSentEvents(body) {
  const stream = toAsyncIterable(body)
  if (!stream) return
  const decoder = new TextDecoder()
  let buffer = ''
  let dataLines = []

  const flush = function* flushEvent() {
    if (!dataLines.length) return
    const payload = dataLines.join('\n')
    dataLines = []
    if (payload === DONE) return
    try {
      yield JSON.parse(payload)
    } catch {
      // 心跳、注释或截断片段不应中断整轮读取。
    }
  }

  for await (const chunk of stream) {
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
          return
        }
        dataLines.push(value)
      }
      // 其余字段（event / id / retry / 注释行）当前不需要。
      newlineIndex = buffer.indexOf('\n')
    }
  }
  const tail = buffer.replace(/\r$/, '')
  if (tail.startsWith('data:')) {
    const value = tail.slice(5).trimStart()
    if (value !== DONE) dataLines.push(value)
  }
  yield* flush()
}

/** 读完一次流式模型调用，返回与非流式完全一致的响应形状。 */
export async function readStreamedChatCompletion(body, { onEvent } = {}) {
  const accumulator = createChatCompletionAccumulator({ onEvent })
  for await (const chunk of readServerSentEvents(body)) accumulator.push(chunk)
  return accumulator.result()
}
