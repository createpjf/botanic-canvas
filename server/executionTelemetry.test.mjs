import assert from 'node:assert/strict'
import test from 'node:test'
import {
  activeBotanicTraceFields,
  safeBotanicSpanAttributes,
  setBotanicHttpSpanStatus,
  withBotanicSpan,
} from './executionTelemetry.mjs'
import { extractAgentTraceContext, withAgentTraceContext } from './agentTraceContext.mjs'

test('Span 属性只保留 allowlist 且拒绝 URL、token 与任意内容字段', () => {
  const safe = safeBotanicSpanAttributes({
    'http.request.method': 'POST',
    'http.route': '/api/agent-turns',
    'botanic.turn.id': 'turn-1',
    'botanic.project.id': 'https://evil.example/?secret=1',
    'gen_ai.usage.input_tokens': 123,
    prompt: 'PROMPT_SECRET',
    body: 'provider body',
    authorization: 'Bearer secret-token-value',
  })
  assert.deepEqual(safe, {
    'http.request.method': 'POST',
    'http.route': '/api/agent-turns',
    'botanic.turn.id': 'turn-1',
    'gen_ai.usage.input_tokens': 123,
  })
  assert.doesNotMatch(JSON.stringify(safe), /PROMPT_SECRET|evil|Bearer/u)
})

test('未安装 SDK 时 Span API no-op 且业务只执行一次', async () => {
  let calls = 0
  const result = await withBotanicSpan('invoke_agent', { kind: 'internal' }, async () => {
    calls += 1
    return 'ok'
  })
  assert.equal(result, 'ok')
  assert.equal(calls, 1)
  assert.deepEqual(activeBotanicTraceFields(), {})
})

test('Telemetry 关闭时语义事件仍从自有上下文取得 W3C 关联身份', () => {
  const traceId = '0123456789abcdef0123456789abcdef'
  const spanId = '0123456789abcdef'
  const extracted = extractAgentTraceContext({ traceparent: `00-${traceId}-${spanId}-01` })
  const fields = withAgentTraceContext(extracted, () => activeBotanicTraceFields())
  assert.deepEqual(fields, { traceId, spanId, traceFlags: 1 })
})

test('HTTP Span 对 5xx 标记 ERROR，其余响应标记 OK', () => {
  const statuses = []
  const span = { setStatus(status) { statuses.push(status.code) } }
  setBotanicHttpSpanStatus(span, 503)
  setBotanicHttpSpanStatus(span, 409)
  assert.deepEqual(statuses, [2, 1])
})

test('业务异常原样抛出且不会重试业务操作', async () => {
  let calls = 0
  const failure = Object.assign(new Error('secret body'), { code: 'PROVIDER_FAILED' })
  await assert.rejects(withBotanicSpan('provider.request', {}, async () => {
    calls += 1
    throw failure
  }), (caught) => caught === failure)
  assert.equal(calls, 1)
})
