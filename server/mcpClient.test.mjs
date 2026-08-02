import assert from 'node:assert/strict'
import test from 'node:test'
import { createConfiguredMcpTools, parseMcpToolConfigurations } from './mcpClient.mjs'

test('MCP 配置生成精确工具白名单并以 tools/call 协议执行', async () => {
  const configurations = parseMcpToolConfigurations(JSON.stringify([{
    server: 'asset-catalog', tool: 'search', url: 'https://mcp.example/rpc', authToken: 'secret-token',
  }]))
  const requests = []
  const tools = createConfiguredMcpTools(configurations, {
    fetchImpl: async (url, init) => {
      requests.push({ url, init })
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'server', result: { matches: 2 } }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    },
    idFactory: () => 'request-1',
  })

  assert.deepEqual(Object.keys(tools), ['asset-catalog.search'])
  assert.deepEqual(await tools['asset-catalog.search']({ query: '海边' }), { matches: 2 })
  assert.equal(requests[0].url, 'https://mcp.example/rpc')
  assert.equal(requests[0].init.headers.Authorization, 'Bearer secret-token')
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    jsonrpc: '2.0', id: 'request-1', method: 'tools/call',
    params: { name: 'search', arguments: { query: '海边' } },
  })
})

test('MCP 配置拒绝重复工具、不安全地址与损坏响应', async () => {
  assert.throws(() => parseMcpToolConfigurations(JSON.stringify([
    { server: 'catalog', tool: 'search', url: 'https://mcp.example/rpc' },
    { server: 'catalog', tool: 'search', url: 'https://other.example/rpc' },
  ])), /重复/)
  assert.throws(() => parseMcpToolConfigurations(JSON.stringify([
    { server: 'catalog', tool: 'search', url: 'http://public.example/rpc' },
  ])), /HTTPS/)

  const tools = createConfiguredMcpTools(parseMcpToolConfigurations(JSON.stringify([
    { server: 'catalog', tool: 'search', url: 'https://mcp.example/rpc' },
  ])), { fetchImpl: async () => new Response('{bad', { status: 200 }) })
  await assert.rejects(tools['catalog.search']({}), /响应无效/)
})
