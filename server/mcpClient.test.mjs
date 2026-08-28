import assert from 'node:assert/strict'
import test from 'node:test'
import { withExtractedAgentTraceContext } from './agentTraceContext.mjs'
import {
  createConfiguredMcpRuntime,
  createConfiguredMcpTools,
  parseMcpToolConfigurations,
} from './mcpClient.mjs'

function rpcResponse(id, result, status = 200) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function configured(overrides = {}) {
  return parseMcpToolConfigurations([{
    server: 'asset-catalog',
    tool: 'search',
    version: '2026.08',
    url: 'https://mcp.example/rpc',
    authToken: 'secret-token',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 80 },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['matches'],
      properties: { matches: { type: 'integer', minimum: 0 } },
    },
    ...overrides,
  }])
}

test('MCP Runtime V2 发布无密钥 catalog，并按输入输出契约投影 tools/call', async () => {
  const requests = []
  const runtime = createConfiguredMcpRuntime(configured(), {
    fetchImpl: async (url, init) => {
      requests.push({ url, init })
      return rpcResponse('request-1', { matches: 2, privateProviderField: 'drop-me' })
    },
    idFactory: () => 'request-1',
  })

  const catalog = runtime.catalog()
  assert.equal(Object.isFrozen(catalog), true)
  assert.equal(Object.isFrozen(catalog[0].inputSchema), true)
  assert.deepEqual(Object.keys(catalog[0]), [
    'key', 'server', 'tool', 'version', 'capabilityHash', 'inputSchema', 'outputSchema', 'replayPolicy',
  ])
  assert.doesNotMatch(JSON.stringify(catalog), /mcp\.example|secret-token/u)
  assert.equal(catalog[0].replayPolicy, 'never')

  assert.deepEqual(await runtime.invoke('asset-catalog.search', {
    query: '海边',
    limit: 2,
    privatePrompt: 'drop-before-request',
  }, {
    expectedVersion: catalog[0].version,
    expectedCapabilityHash: catalog[0].capabilityHash,
  }), { matches: 2 })
  assert.equal(requests[0].url, 'https://mcp.example/rpc')
  assert.equal(requests[0].init.redirect, 'error')
  assert.equal(requests[0].init.headers.Authorization, 'Bearer secret-token')
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    jsonrpc: '2.0', id: 'request-1', method: 'tools/call',
    params: { name: 'search', arguments: { limit: 2, query: '海边' } },
  })
})

test('MCP capabilityHash 对 Schema 键序稳定，显式旧 hash 与版本漂移 fail closed', async () => {
  const first = configured()
  const second = parseMcpToolConfigurations([{
    server: 'asset-catalog', tool: 'search', version: '2026.08', url: 'https://other.example/rpc',
    inputSchema: {
      required: ['query'],
      properties: {
        limit: { maximum: 20, minimum: 1, type: 'integer' },
        query: { maxLength: 80, minLength: 1, type: 'string' },
      },
      additionalProperties: false,
      type: 'object',
    },
    outputSchema: {
      required: ['matches'], properties: { matches: { minimum: 0, type: 'integer' } },
      type: 'object', additionalProperties: false,
    },
  }])
  assert.equal(first[0].capabilityHash, second[0].capabilityHash)
  assert.throws(() => configured({ capabilityHash: 'x'.repeat(43) }), /capabilityHash 不匹配/u)

  let calls = 0
  const runtime = createConfiguredMcpRuntime(first, { fetchImpl: async () => { calls += 1; return rpcResponse('id', { matches: 1 }) } })
  await assert.rejects(
    runtime.invoke('asset-catalog.search', { query: '海边' }, { expectedVersion: '2025.01' }),
    (error) => error.code === 'MCP_CAPABILITY_STALE' && error.outcomeKnown === true,
  )
  assert.equal(calls, 0)
})

test('MCP 输入在请求前校验，未知工具与预先取消均是已知未执行', async () => {
  let calls = 0
  const runtime = createConfiguredMcpRuntime(configured(), {
    fetchImpl: async () => { calls += 1; return rpcResponse('id', { matches: 1 }) },
  })
  await assert.rejects(runtime.invoke('asset-catalog.search', { query: '' }), (error) => (
    error.code === 'MCP_INPUT_INVALID'
      && error.outcomeKnown === true
      && error.replayPolicy === 'never'
  ))
  await assert.rejects(runtime.invoke('unknown.tool', {}), (error) => (
    error.code === 'MCP_TOOL_NOT_ALLOWED' && error.outcomeKnown === true
  ))
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    runtime.invoke('asset-catalog.search', { query: '海边' }, { signal: controller.signal }),
    (error) => error.code === 'REQUEST_CANCELLED' && error.outcomeKnown === true,
  )
  assert.equal(calls, 0)
})

test('MCP 严格校验 JSON-RPC 2.0/id，并在输出契约失败时保持 outcome_unknown', async () => {
  for (const response of [
    { jsonrpc: '1.0', id: 'request-1', result: { matches: 1 } },
    { jsonrpc: '2.0', id: 'other-request', result: { matches: 1 } },
    { jsonrpc: '2.0', id: 'request-1', result: { matches: 1 }, error: { code: -1, message: 'bad' } },
  ]) {
    const runtime = createConfiguredMcpRuntime(configured(), {
      idFactory: () => 'request-1',
      fetchImpl: async () => new Response(JSON.stringify(response), { status: 200 }),
    })
    await assert.rejects(runtime.invoke('asset-catalog.search', { query: '海边' }), (error) => (
      error.code === 'MCP_INVALID_RESPONSE'
        && error.outcome === 'outcome_unknown'
        && error.outcomeKnown === false
    ))
  }

  const outputInvalid = createConfiguredMcpRuntime(configured(), {
    idFactory: () => 'request-1',
    fetchImpl: async () => rpcResponse('request-1', { matches: 'two' }),
  })
  await assert.rejects(outputInvalid.invoke('asset-catalog.search', { query: '海边' }), (error) => (
    error.code === 'MCP_OUTPUT_INVALID' && error.outcomeKnown === false
  ))
})

test('MCP JSON-RPC error、网络与超限响应均保持 never/outcome_unknown', async () => {
  const explicitFailure = createConfiguredMcpRuntime(configured(), {
    idFactory: () => 'request-1',
    fetchImpl: async () => new Response(JSON.stringify({
      jsonrpc: '2.0', id: 'request-1', error: { code: -32_000, message: 'provider secret detail' },
    }), { status: 502 }),
  })
  await assert.rejects(explicitFailure.invoke('asset-catalog.search', { query: '海边' }), (error) => (
    error.code === 'MCP_TOOL_FAILED'
      && error.outcomeKnown === false
      && error.outcome === 'outcome_unknown'
      && error.message === 'MCP 工具执行失败。'
  ))

  const unavailable = createConfiguredMcpRuntime(configured(), {
    fetchImpl: async () => { throw new Error('socket with secret') },
  })
  await assert.rejects(unavailable.invoke('asset-catalog.search', { query: '海边' }), (error) => (
    error.code === 'MCP_UNAVAILABLE'
      && error.outcomeKnown === false
      && error.replayPolicy === 'never'
      && error.outcome === 'outcome_unknown'
  ))

  const tooLarge = createConfiguredMcpRuntime(configured({ maximumResponseBytes: 1024 }), {
    idFactory: () => 'request-1',
    fetchImpl: async () => rpcResponse('request-1', { matches: 1, padding: 'x'.repeat(2000) }),
  })
  await assert.rejects(tooLarge.invoke('asset-catalog.search', { query: '海边' }), (error) => (
    error.code === 'MCP_RESPONSE_TOO_LARGE' && error.outcomeKnown === false
  ))
})

test('createConfiguredMcpTools 保留旧 open-object 配置与调用形状', async () => {
  const configurations = parseMcpToolConfigurations(JSON.stringify([{
    server: 'catalog', tool: 'search', url: 'https://mcp.example/rpc',
  }]))
  const tools = createConfiguredMcpTools(configurations, {
    idFactory: () => 'legacy-request',
    fetchImpl: async () => rpcResponse('legacy-request', { matches: 2, nested: { ok: true } }),
  })
  assert.deepEqual(Object.keys(tools), ['catalog.search'])
  assert.deepEqual(await tools['catalog.search']({ query: '海边' }), { matches: 2, nested: { ok: true } })
})

test('MCP 配置拒绝重复工具、不安全地址与损坏响应', async () => {
  assert.throws(() => parseMcpToolConfigurations(JSON.stringify([
    { server: 'catalog', tool: 'search', url: 'https://mcp.example/rpc' },
    { server: 'catalog', tool: 'search', url: 'https://other.example/rpc' },
  ])), /重复/u)
  assert.throws(() => parseMcpToolConfigurations(JSON.stringify([
    { server: 'catalog', tool: 'search', url: 'http://public.example/rpc' },
  ])), /HTTPS/u)
  assert.throws(() => configured({ inputSchema: { type: 'object', oneOf: [] } }), /受支持/u)

  const tools = createConfiguredMcpTools(parseMcpToolConfigurations(JSON.stringify([
    { server: 'catalog', tool: 'search', url: 'https://mcp.example/rpc' },
  ])), { fetchImpl: async () => new Response('{bad', { status: 200 }) })
  await assert.rejects(tools['catalog.search']({}), /响应无效/u)
})

test('MCP 外呼禁止跟随 Provider 重定向，失败保持 outcome_unknown', async () => {
  let observedRedirect
  const runtime = createConfiguredMcpRuntime(configured(), {
    fetchImpl: async (_url, init) => {
      observedRedirect = init.redirect
      throw new TypeError('redirect mode is set to error')
    },
  })

  await assert.rejects(runtime.invoke('asset-catalog.search', { query: '海边' }), (error) => (
    error.code === 'MCP_UNAVAILABLE'
      && error.outcomeKnown === false
      && error.outcome === 'outcome_unknown'
  ))
  assert.equal(observedRedirect, 'error')
})

test('MCP 工具把行动外层取消信号传给真实 HTTP 请求', async () => {
  const controller = new AbortController()
  let requestSignal
  let rejectFetch
  const tools = createConfiguredMcpTools(parseMcpToolConfigurations(JSON.stringify([{
    server: 'catalog', tool: 'write', url: 'https://mcp.example/rpc', timeoutMs: 30_000,
  }])), {
    fetchImpl: async (_url, init) => {
      requestSignal = init.signal
      return new Promise((_, reject) => { rejectFetch = reject })
    },
  })

  const execution = tools['catalog.write'](
    { title: '夏季 Campaign' },
    { signal: controller.signal, actionIntentHash: 'stable-action-hash' },
  )
  await Promise.resolve()
  controller.abort(new Error('用户取消行动'))
  const outerCancellationReachedHttp = requestSignal?.aborted === true
  rejectFetch?.(new Error('测试收口'))
  await assert.rejects(execution, (error) => (
    error.code === 'REQUEST_CANCELLED' && error.outcomeKnown === false
  ))

  assert.equal(outerCancellationReachedHttp, true)
})

test('MCP 外呼只发送 traceparent 与受控 intent hash，不把参数写入 Header', async () => {
  let requestHeaders
  const tools = createConfiguredMcpTools(parseMcpToolConfigurations(JSON.stringify([{
    server: 'catalog', tool: 'write', url: 'https://mcp.example/rpc',
  }])), {
    idFactory: () => 'request-1',
    fetchImpl: async (_url, init) => {
      requestHeaders = init.headers
      return rpcResponse('request-1', { ok: true })
    },
  })

  await withExtractedAgentTraceContext({
    traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    tracestate: 'vendor=private',
    baggage: 'private=prompt',
  }, () => tools['catalog.write'](
    { privatePrompt: '不可进入 Header 的创作参数' },
    { actionIntentHash: 'W7l4k_29pSMPzjZXZrbdP3UDDwFdGW3IcLkw8v6H6aA' },
  ))

  assert.equal(requestHeaders['X-Botanic-Action-Intent'], 'W7l4k_29pSMPzjZXZrbdP3UDDwFdGW3IcLkw8v6H6aA')
  assert.equal(requestHeaders.traceparent, '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')
  assert.equal(requestHeaders.tracestate, undefined)
  assert.equal(requestHeaders.baggage, undefined)
  assert.doesNotMatch(JSON.stringify(requestHeaders), /不可进入 Header/u)
})
