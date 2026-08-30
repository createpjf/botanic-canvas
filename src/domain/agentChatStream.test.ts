import assert from 'node:assert/strict'
import test from 'node:test'
import { botanicAgentChatTransportErrorMessage, createBotanicAgentChatStreamReader } from './agentChatStream.ts'

function sse(payload: unknown) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

test('传输层把浏览器掐流的英文错误收成可重试的中文，服务端中文原样保留', () => {
  assert.equal(botanicAgentChatTransportErrorMessage(new Error('network error')), 'Agent 对话连接中断，请重试。')
  assert.equal(botanicAgentChatTransportErrorMessage(new Error('Failed to fetch')), 'Agent 对话连接中断，请重试。')
  assert.equal(botanicAgentChatTransportErrorMessage(new DOMException('The user aborted a request.', 'AbortError')), 'Agent 对话连接中断，请重试。')
  assert.equal(botanicAgentChatTransportErrorMessage(new Error('load failed'), { idleTimedOut: true }), 'Agent 对话连接中断，请重试。')
  assert.equal(botanicAgentChatTransportErrorMessage(new Error('Agent 对话超时，请重试。')), 'Agent 对话超时，请重试。')
  assert.equal(botanicAgentChatTransportErrorMessage('not-an-error'), 'Agent 暂时无法回答，请稍后重试。')
  assert.equal(botanicAgentChatTransportErrorMessage(new Error('Failed to fetch'), { locale: 'en' }), 'Agent connection was interrupted. Try again.')
  assert.equal(botanicAgentChatTransportErrorMessage(new Error('服务端返回中文错误'), { locale: 'en' }), 'Agent is temporarily unavailable. Try again shortly.')
})

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

test('Turn accepted 事件暴露稳定身份与续读地址，但不伪装成 done', () => {
  const reader = createBotanicAgentChatStreamReader()
  assert.deepEqual(reader.push(sse({
    type: 'accepted',
    turnId: 'turn-1',
    runtimeTurn: { id: 'turn-1', projectId: 'project-1' },
    observer: { url: '/api/agent-turns/turn-1?after=0' },
  })), [{
    type: 'accepted',
    turnId: 'turn-1',
    runtimeTurn: { id: 'turn-1', projectId: 'project-1' },
    observer: { url: '/api/agent-turns/turn-1?after=0' },
  }])
})

test('Turn handoff 是非终态观察事件，不会被解析成 done', () => {
  const reader = createBotanicAgentChatStreamReader()
  const [event] = reader.push(sse({
    type: 'handoff', turnId: 'turn-1',
    runtimeTurn: { id: 'turn-1', projectId: 'project-1', status: 'running' },
    observer: { url: '/api/agent-turns/turn-1?after=4' },
  }))
  assert.equal(event?.type, 'handoff')
})

test('SSE id 行推进续读游标，事件体同时携带 sequence', () => {
  const reader = createBotanicAgentChatStreamReader()
  assert.equal(reader.lastEventId, '', '尚未收到可解析事件时游标为空')

  const events = reader.push([
    'id: 7',
    'data: {"type":"answer","step":0,"delta":"你","sequence":7}',
    '',
    'id: 8',
    'data: {"type":"answer","step":0,"delta":"好","sequence":8}',
    '',
    '',
  ].join('\n'))

  assert.equal(events.length, 2)
  assert.equal(events[0].sequence, 7)
  assert.equal(events[1].sequence, 8)
  assert.equal(reader.lastEventId, '8')
})

test('解析失败的事件不推进游标，否则重连会永久跳过它', () => {
  const reader = createBotanicAgentChatStreamReader()
  reader.push('id: 3\ndata: {"type":"answer","step":0,"delta":"a","sequence":3}\n\n')
  assert.equal(reader.lastEventId, '3')

  // 损坏的 JSON 与未知事件类型都不该把游标推过去。
  reader.push('id: 4\ndata: {损坏\n\n')
  assert.equal(reader.lastEventId, '3', '损坏事件不得推进游标')
  reader.push('id: 5\ndata: {"type":"unknown"}\n\n')
  assert.equal(reader.lastEventId, '3', '未知类型不得推进游标')

  reader.push('id: 6\ndata: {"type":"answer","step":0,"delta":"b","sequence":6}\n\n')
  assert.equal(reader.lastEventId, '6')
})

test('没有 id 行的事件不改变游标，心跳与注释也不改变', () => {
  const reader = createBotanicAgentChatStreamReader()
  reader.push('id: 2\ndata: {"type":"answer","step":0,"delta":"a","sequence":2}\n\n')
  reader.push(': keep-alive\n\n')
  assert.equal(reader.lastEventId, '2')
  reader.push('data: {"type":"answer","step":0,"delta":"b"}\n\n')
  assert.equal(reader.lastEventId, '2', '缺少 id 行时保留上一个可用游标')
})

test('id 行跨网络块切断仍能正确归属到它的事件', () => {
  const reader = createBotanicAgentChatStreamReader()
  reader.push('id: 1')
  reader.push('2\ndata: {"type":"answer","step":0,"del')
  const events = reader.push('ta":"x","sequence":12}\n\n')
  assert.equal(events.length, 1)
  assert.equal(reader.lastEventId, '12')
})
