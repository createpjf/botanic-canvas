import assert from 'node:assert/strict'
import test from 'node:test'
import { propagation, trace } from '@opentelemetry/api'
import {
  attachAgentTraceContext,
  currentAgentTraceContext,
  extractAgentTraceContext,
  injectAgentTraceContext,
  outboundAgentTraceHeaders,
  withAgentTraceContext,
  withExtractedAgentTraceContext,
} from './agentTraceContext.mjs'

const TRACE_PARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
const TRACE_STATE = 'vendor=opaque'

test('W3C Trace Context 合法 carrier 可跨异步边界提取并再次注入', async () => {
  const extracted = extractAgentTraceContext({
    traceparent: TRACE_PARENT,
    tracestate: TRACE_STATE,
  })
  const spanContext = trace.getSpanContext(extracted)
  assert.equal(spanContext?.traceId, '4bf92f3577b34da6a3ce929d0e0e4736')
  assert.equal(spanContext?.spanId, '00f067aa0ba902b7')
  assert.equal(spanContext?.traceFlags, 1)
  assert.equal(spanContext?.isRemote, true)
  assert.equal(spanContext?.traceState?.serialize(), TRACE_STATE)

  await withAgentTraceContext(extracted, async () => {
    await Promise.resolve()
    assert.equal(trace.getSpanContext(currentAgentTraceContext())?.traceId, '4bf92f3577b34da6a3ce929d0e0e4736')
    assert.deepEqual(injectAgentTraceContext(), {
      traceparent: TRACE_PARENT,
      tracestate: TRACE_STATE,
    })
  })
})

test('非法或缺失 carrier 降级为根上下文，不阻断业务回调', async () => {
  for (const carrier of [
    undefined,
    {},
    { traceparent: 'invalid' },
    { traceparent: '00-00000000000000000000000000000000-00f067aa0ba902b7-01' },
    { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01' },
  ]) {
    const extracted = extractAgentTraceContext(carrier)
    assert.equal(trace.getSpanContext(extracted), undefined)
    assert.deepEqual(injectAgentTraceContext(extracted), {})
  }

  let invoked = false
  await withExtractedAgentTraceContext(undefined, async (payload) => {
    invoked = true
    assert.equal(payload, undefined)
    assert.equal(trace.getSpanContext(currentAgentTraceContext()), undefined)
  })
  assert.equal(invoked, true)

  const hostileCarrier = new Proxy({}, {
    getOwnPropertyDescriptor() { throw new Error('untrusted carrier') },
  })
  assert.equal(withExtractedAgentTraceContext(hostileCarrier, () => 'business-continued'), 'business-continued')
})

test('仅传播 traceparent/tracestate，显式排除 baggage', () => {
  const extracted = extractAgentTraceContext({
    traceparent: TRACE_PARENT,
    tracestate: TRACE_STATE,
    baggage: 'user.id=secret,prompt=private',
  })
  const withBaggage = propagation.setBaggage(
    extracted,
    propagation.createBaggage({ secret: { value: 'do-not-propagate' } }),
  )

  withAgentTraceContext(withBaggage, () => {
    assert.deepEqual(injectAgentTraceContext(), {
      traceparent: TRACE_PARENT,
      tracestate: TRACE_STATE,
    })
    assert.deepEqual(attachAgentTraceContext({ jobId: 'job-1' }), {
      jobId: 'job-1',
      traceparent: TRACE_PARENT,
      tracestate: TRACE_STATE,
    })
    assert.deepEqual(outboundAgentTraceHeaders(), { traceparent: TRACE_PARENT })
  })
})

test('Worker 提取后剥离内部 carrier，旧 payload 形状保持兼容', () => {
  const legacy = { kind: 'review.run', reviewTaskId: 'review-1' }
  assert.equal(withExtractedAgentTraceContext(legacy, (payload) => payload), legacy)

  const propagated = { ...legacy, traceparent: TRACE_PARENT, tracestate: TRACE_STATE }
  const result = withExtractedAgentTraceContext(propagated, (payload) => ({
    payload,
    spanContext: trace.getSpanContext(currentAgentTraceContext()),
  }))
  assert.deepEqual(result.payload, legacy)
  assert.equal(result.spanContext?.traceId, '4bf92f3577b34da6a3ce929d0e0e4736')
})
