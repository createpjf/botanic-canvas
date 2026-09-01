import assert from 'node:assert/strict'
import test from 'node:test'
import {
  agentModelProviderConfig,
  agentModelProviderResponseError,
  agentModelProviderTemperature,
  createBotanicAgentModelProvider,
} from './botanicAgentModelProvider.mjs'

const runtimeConfig = {
  flockApiBaseUrl: 'https://provider.test/v1/',
  flockApiKey: 'test-key',
  flockTextModel: 'deepseek-v4-pro',
  flockAgentModels: ['deepseek-v4-pro', 'kimi-k3'],
  agentPlannerTimeoutMs: 5_000,
}

test('sample 归一化 stream 与 non-stream 到同一 completion 形状,header 与请求体稳定', async () => {
  const requests = []
  const provider = createBotanicAgentModelProvider(runtimeConfig, {
    fetchImpl: async (url, init) => {
      requests.push({ url, init })
      const body = JSON.parse(init.body)
      if (!body.stream) {
        return new Response(JSON.stringify({
          choices: [{ index: 0, message: { role: 'assistant', content: '非流式回答' } }],
          usage: { prompt_tokens: 10, completion_tokens: 4 },
        }), { status: 200 })
      }
      return new Response([
        'data: ' + JSON.stringify({ choices: [{ delta: { content: '流式' } }] }) + '\n\n',
        'data: ' + JSON.stringify({ choices: [{ delta: { content: '回答' }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 2 } }) + '\n\n',
        'data: [DONE]\n\n',
      ].join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    },
  })

  const plain = await provider.sample({ model: 'deepseek-v4-pro', messages: [{ role: 'user', content: '你好' }], maxOutputTokens: 300 })
  assert.equal(plain.choices[0].message.content, '非流式回答')

  const deltas = []
  const streamed = await provider.sample({
    model: 'kimi-k3',
    messages: [{ role: 'user', content: '你好' }],
    stream: true,
    onEvent: (event) => { if (event.type === 'answer') deltas.push(event.delta) },
  })
  assert.equal(streamed.choices[0].message.content, '流式回答')
  assert.deepEqual(deltas, ['流式', '回答'])

  // 传输细节由 Provider 拥有:URL 收敛、双头鉴权、temperature 目录规则。
  assert.equal(requests[0].url, 'https://provider.test/v1/chat/completions')
  assert.equal(requests[0].init.headers.Authorization, 'Bearer test-key')
  assert.equal(requests[0].init.headers['x-litellm-api-key'], 'test-key')
  assert.equal(JSON.parse(requests[0].init.body).temperature, 0.1)
  assert.equal(JSON.parse(requests[1].init.body).temperature, 1)
  assert.equal(JSON.parse(requests[1].init.body).stream, true)
})

test('错误归类稳定:根取消优先于 timeout,HTTP 状态映射保留,overflow 保留原码且 raw body 不外泄', async () => {
  // 根取消优先。
  const controller = new AbortController()
  const cancelled = createBotanicAgentModelProvider(runtimeConfig, {
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }),
  })
  const pending = cancelled.sample({ model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'x' }], signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, (caught) => caught.code === 'REQUEST_CANCELLED' && caught.statusCode === 499)

  // per-call timeout(不带根 signal)。
  const timedOut = createBotanicAgentModelProvider(runtimeConfig, {
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }),
  })
  await assert.rejects(
    timedOut.sample({ model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'x' }], timeoutMs: 1_000 }),
    (caught) => caught.code === 'PROVIDER_TIMEOUT' && caught.statusCode === 504,
  )

  // headers 已返回后，读取响应体超时仍属于 Provider timeout，不能降级成 payload 无效。
  const bodyTimedOut = createBotanicAgentModelProvider(runtimeConfig, {
    fetchImpl: async (_url, init) => ({
      ok: true,
      json: () => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }),
    }),
  })
  await assert.rejects(
    bodyTimedOut.sample({ model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'x' }], timeoutMs: 5 }),
    (caught) => caught.code === 'PROVIDER_TIMEOUT' && caught.statusCode === 504,
  )

  // HTTP 状态映射与 raw body 边界。
  const statuses = [[401, 'PROVIDER_AUTH_FAILED'], [429, 'PROVIDER_RATE_LIMITED'], [503, 'PROVIDER_UNAVAILABLE'], [400, 'PROVIDER_REJECTED']]
  for (const [status, code] of statuses) {
    const provider = createBotanicAgentModelProvider(runtimeConfig, {
      fetchImpl: async () => new Response('secret upstream body', { status }),
    })
    await assert.rejects(
      provider.sample({ model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'x' }] }),
      (caught) => caught.code === code && !String(caught.message).includes('secret'),
    )
  }

  // context overflow 保留原错误码。
  const overflow = createBotanicAgentModelProvider(runtimeConfig, {
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'maximum context length exceeded' } }), { status: 400 }),
  })
  await assert.rejects(
    overflow.sample({ model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'x' }] }),
    (caught) => caught.code === 'AGENT_CONTEXT_OVERFLOW',
  )

  const truncated = createBotanicAgentModelProvider(runtimeConfig, {
    fetchImpl: async () => new Response('data: {"choices":[{"delta":{"content":"half"}}]}\n\n', { status: 200 }),
  })
  await assert.rejects(
    truncated.sample({ model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'x' }], stream: true }),
    (caught) => caught.code === 'PROVIDER_STREAM_CLOSED' && caught.statusCode === 502,
  )
})

test('config 目录校验与静态映射保持既有语义', () => {
  const config = agentModelProviderConfig(runtimeConfig, 'kimi-k3')
  assert.equal(config.model, 'kimi-k3')
  assert.equal(config.baseUrl, 'https://provider.test/v1')
  assert.throws(() => agentModelProviderConfig(runtimeConfig, 'unknown-model'), (caught) => caught.code === 'INVALID_REQUEST')
  assert.throws(() => agentModelProviderConfig({ ...runtimeConfig, flockApiKey: '' }), (caught) => caught.code === 'PROVIDER_NOT_CONFIGURED')
  assert.equal(agentModelProviderTemperature('kimi-k3'), 1)
  assert.equal(agentModelProviderResponseError(429).statusCode, 429)
})

test('流式timeout按idle续命:总时长超过预算但持续有chunk仍完成', async () => {
  const encoder = new TextEncoder()
  const provider = createBotanicAgentModelProvider(runtimeConfig, {
    fetchImpl: async () => new Response(new ReadableStream({
      async start(controller) {
        const push = async (text) => { controller.enqueue(encoder.encode(text)); await new Promise((resolve) => setTimeout(resolve, 25)) }
        await push('data: ' + JSON.stringify({ choices: [{ delta: { content: '活' } }] }) + '\n\n')
        await push(': keep-alive\n\n')
        await push('data: ' + JSON.stringify({ choices: [{ delta: { content: '跃' } }] }) + '\n\n')
        await push('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n')
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    }), { status: 200 }),
  })
  const startedAt = Date.now()
  const result = await provider.sample({
    model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'x' }], stream: true, timeoutMs: 80,
  })
  assert.equal(result.choices[0].message.content, '活跃')
  assert.ok(Date.now() - startedAt >= 80, '总时长必须超过idle预算才能证明续命生效')
})
