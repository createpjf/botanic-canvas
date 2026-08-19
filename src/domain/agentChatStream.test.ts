import assert from 'node:assert/strict'
import test from 'node:test'
import { createBotanicAgentChatStreamReader } from './agentChatStream.ts'

function sse(payload: unknown) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

test('实时事件读取容忍跨网络块切断的行、CRLF 与注释行', () => {
  const reader = createBotanicAgentChatStreamReader()

  assert.deepEqual(reader.push(': keep-alive\n\n'), [])
  // 一个事件被拆成三段送达。
  assert.deepEqual(reader.push('data: {"type":"answer","step":0,"del'), [])
  assert.deepEqual(reader.push('ta":"你"}'), [])
  assert.deepEqual(reader.push('\n\n'), [{ type: 'answer', step: 0, delta: '你' }])
  assert.deepEqual(reader.push('data: {"type":"answer","step":0,"delta":"好"}\r\n\r\n'), [
    { type: 'answer', step: 0, delta: '好' },
  ])
})

test('一次推送里的多个事件按顺序返回，未知与损坏事件被跳过', () => {
  const reader = createBotanicAgentChatStreamReader()
  const events = reader.push([
    sse({ type: 'reasoning', step: 0, delta: '先看看上下文' }),
    sse({ type: 'heartbeat' }),
    'data: {"type":"answer"\n\n',
    sse({ type: 'tool', step: 0, toolCall: { id: 'call-1', name: 'ontology_read', label: '读取项目本体', risk: 'read', status: 'running', requiresConfirmation: false, summary: '先确认画布内容' } }),
  ].join(''))

  assert.deepEqual(events.map((event) => event.type), ['reasoning', 'tool'])
  assert.equal(events[1].type === 'tool' ? events[1].toolCall.summary : '', '先确认画布内容')
})

test('流结束时补出最后一个没有空行收尾的事件', () => {
  const reader = createBotanicAgentChatStreamReader()
  assert.deepEqual(reader.push('data: {"type":"done","response":{"answer":"完成","mode":"conversation"}}'), [])
  const flushed = reader.flush()
  assert.equal(flushed.length, 1)
  assert.equal(flushed[0].type === 'done' ? flushed[0].response.answer : '', '完成')
  // flush 之后状态清空，不会重复吐出同一个事件。
  assert.deepEqual(reader.flush(), [])
})

test('多行 data 按 SSE 规范拼接后再解析', () => {
  const reader = createBotanicAgentChatStreamReader()
  assert.deepEqual(reader.push('data: {"type":"answer","step":0,\ndata: "delta":"分两行"}\n\n'), [
    { type: 'answer', step: 0, delta: '分两行' },
  ])
})

test('tool presentation 是向后兼容的加字段，未知键不会影响事件解析', () => {
  const reader = createBotanicAgentChatStreamReader()
  const [event] = reader.push(sse({
    type: 'tool',
    step: 1,
    toolCall: { id: 'search-1', name: 'web_search', label: '网页搜索', risk: 'external', status: 'succeeded', requiresConfirmation: false },
    presentation: { kind: 'search', title: '已搜索 25 个网站', count: 25 },
    futureField: { ignoredByOldClients: true },
  }))

  assert.equal(event.type, 'tool')
  if (event.type !== 'tool') return
  assert.deepEqual(event.presentation, { kind: 'search', title: '已搜索 25 个网站', count: 25 })
  assert.equal(event.toolCall.id, 'search-1')
})
