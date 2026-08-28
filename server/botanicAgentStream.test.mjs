import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createChatCompletionAccumulator,
  normalizeProviderUsage,
  readServerSentEvents,
  readStreamedChatCompletion,
} from './botanicAgentStream.mjs'

const encoder = new TextEncoder()

function byteStream(pieces) {
  return (async function* stream() {
    for (const piece of pieces) yield encoder.encode(piece)
  })()
}

function sse(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

test('SSE 读取容忍跨网络块切断的行、注释与心跳', async () => {
  const chunks = []
  // 单个 JSON 事件被拆成三段，中间还夹着注释行和空事件。
  const stream = byteStream([
    ': keep-alive\n\n',
    'data: {"choices":[{"delta":{"con',
    'tent":"你"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"好"}}]}\r\n\r\n',
    'data: [DONE]\n\n',
    'data: {"choices":[{"delta":{"content":"不应读到"}}]}\n\n',
  ])
  for await (const chunk of readServerSentEvents(stream)) chunks.push(chunk)

  assert.equal(chunks.length, 2)
  assert.equal(chunks[0].choices[0].delta.content, '你')
  assert.equal(chunks[1].choices[0].delta.content, '好')
})

test('SSE 读取跳过无法解析的事件，并处理结尾没有空行的情况', async () => {
  const chunks = []
  const stream = byteStream([
    'data: {"broken"\n\n',
    'data: {"choices":[{"delta":{"content":"末尾"}}]}',
  ])
  for await (const chunk of readServerSentEvents(stream)) chunks.push(chunk)

  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].choices[0].delta.content, '末尾')
})

test('SSE 读取支持 web ReadableStream 与纯文本块', async () => {
  const readable = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sse({ choices: [{ delta: { content: 'A' } }] })))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  const fromReadable = []
  for await (const chunk of readServerSentEvents(readable)) fromReadable.push(chunk)
  assert.deepEqual(fromReadable.map((chunk) => chunk.choices[0].delta.content), ['A'])

  const fromText = []
  for await (const chunk of readServerSentEvents((async function* stream() {
    yield sse({ choices: [{ delta: { content: 'B' } }] })
  })())) fromText.push(chunk)
  assert.deepEqual(fromText.map((chunk) => chunk.choices[0].delta.content), ['B'])
})

test('增量块累积回非流式响应形状，工具参数按 index 拼接', async () => {
  const events = []
  const result = await readStreamedChatCompletion(byteStream([
    sse({ choices: [{ delta: { role: 'assistant' } }] }),
    sse({ choices: [{ delta: { reasoning_content: '先看看' } }] }),
    sse({ choices: [{ delta: { reasoning_content: '上下文。' } }] }),
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'ontology_read', arguments: '{"why":"先确认' } }] } }] }),
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '画布内容"}' } }] } }] }),
    sse({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', function: { name: 'skill_search', arguments: '{}' } }] } }] }),
    sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    'data: [DONE]\n\n',
  ]), { onEvent: (event) => events.push(event) })

  const message = result.choices[0].message
  assert.equal(message.role, 'assistant')
  assert.equal(message.reasoning_content, '先看看上下文。')
  assert.equal(result.choices[0].finish_reason, 'tool_calls')
  assert.deepEqual(message.tool_calls, [
    { id: 'call_a', type: 'function', function: { name: 'ontology_read', arguments: '{"why":"先确认画布内容"}' } },
    { id: 'call_b', type: 'function', function: { name: 'skill_search', arguments: '{}' } },
  ])
  // 工具名一出现就播报一次，不必等参数流完。
  assert.deepEqual(events.filter((event) => event.type === 'tool_call'), [
    { type: 'tool_call', index: 0, id: 'call_a', name: 'ontology_read' },
    { type: 'tool_call', index: 1, id: 'call_b', name: 'skill_search' },
  ])
  assert.deepEqual(events.filter((event) => event.type === 'reasoning').map((event) => event.delta), ['先看看', '上下文。'])
})

test('纯文本回答累积出与非流式一致的 content，并逐段播报', async () => {
  const events = []
  const result = await readStreamedChatCompletion(byteStream([
    sse({ choices: [{ delta: { content: '当前项目' } }] }),
    sse({ choices: [{ delta: { content: '有 3 个结果。' } }] }),
    sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    'data: [DONE]\n\n',
  ]), { onEvent: (event) => events.push(event) })

  assert.equal(result.choices[0].message.content, '当前项目有 3 个结果。')
  assert.equal(result.choices[0].message.tool_calls, undefined)
  assert.equal(result.choices[0].message.reasoning_content, undefined)
  assert.deepEqual(events.map((event) => event.delta), ['当前项目', '有 3 个结果。'])
})

test('usage-only 流式尾块保留为非流式响应的顶层 usage', async () => {
  const usage = { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }
  const result = await readStreamedChatCompletion(byteStream([
    sse({ choices: [{ delta: { content: '完成' } }] }),
    sse({ choices: [], usage }),
    'data: [DONE]\n\n',
  ]))

  assert.equal(result.choices[0].message.content, '完成')
  assert.deepEqual(result.usage, usage)
})

test('Provider usage 兼容 Chat Completions 与 Responses 两套字段', () => {
  assert.deepEqual(normalizeProviderUsage({
    prompt_tokens: 12,
    completion_tokens: 3,
    total_tokens: 15,
  }), { inputTokens: 12, outputTokens: 3, totalTokens: 15 })
  assert.deepEqual(normalizeProviderUsage({
    input_tokens: 20,
    output_tokens: 4,
  }), { inputTokens: 20, outputTokens: 4, totalTokens: 24 })
  assert.deepEqual(normalizeProviderUsage({ total_tokens: 9 }), { totalTokens: 9 })
  assert.equal(normalizeProviderUsage({ prompt_tokens: -1 }), undefined)
  assert.equal(normalizeProviderUsage(undefined), undefined)
})

test('累积器补齐缺失的工具调用标识，并丢弃没有名字的残块', () => {
  const accumulator = createChatCompletionAccumulator()
  accumulator.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'ontology_read' } }] } }] })
  accumulator.push({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '{}' } }] } }] })
  const calls = accumulator.result().choices[0].message.tool_calls
  assert.equal(calls.length, 1)
  assert.equal(calls[0].id, 'tool-call-stream-1')
  assert.equal(calls[0].function.arguments, '{}')
})

test('展示回调抛错不会中断模型读取', async () => {
  const result = await readStreamedChatCompletion(byteStream([
    sse({ choices: [{ delta: { content: '仍然完整' } }] }),
    'data: [DONE]\n\n',
  ]), { onEvent: () => { throw new Error('渲染失败') } })
  assert.equal(result.choices[0].message.content, '仍然完整')
})

test('空响应体返回可安全消费的空结果', async () => {
  assert.deepEqual((await readStreamedChatCompletion(undefined)).choices[0].message, {
    role: 'assistant', content: '',
  })
})
