import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { AgentToolRuntimeError } from '../agent/tools/agentToolRuntime.mjs'
import { createTavilyWebResearch } from './webSearchProvider.mjs'

function pageResponse({ status = 200, headers = {}, body = Buffer.alloc(0), inspect } = {}) {
  return (url, options, onResponse) => {
    const request = new EventEmitter()
    request.end = () => {
      inspect?.(url, options)
      const response = new PassThrough()
      response.statusCode = status
      response.headers = headers
      onResponse(response)
      response.end(body)
    }
    return request
  }
}

test('Tavily 搜索只把公开结果回给模型，请求带 Bearer 且不含 MCP 地址', async () => {
  const requests = []
  const client = createTavilyWebResearch({
    apiKey: 'test-search-key',
    fetchImpl: async (url, init) => {
      requests.push({ url, init })
      return new Response(JSON.stringify({
        results: [
          { title: '和光', url: 'https://www.andlight.cn/', content: '灯具品牌' },
          { title: '内网', url: 'http://127.0.0.1/secret', content: '不该出现' },
        ],
      }), { status: 200 })
    },
  })

  const result = await client.search('和光品牌')
  assert.equal(requests[0].url, 'https://api.tavily.com/search')
  assert.equal(requests[0].init.headers.Authorization, 'Bearer test-search-key')
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    query: '和光品牌', max_results: 5, include_answer: false, search_depth: 'basic',
  })
  assert.equal(result.hitCount, 1)
  assert.equal(result.hits[0].hostname, 'www.andlight.cn')
})

test('Tavily 抽取公开页正文，并拒绝内网 URL', async () => {
  const client = createTavilyWebResearch({
    apiKey: 'test-search-key',
    lookup: async () => ['1.1.1.1'],
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://api.tavily.com/extract')
      assert.deepEqual(JSON.parse(init.body), { urls: ['https://www.andlight.cn/'] })
      return new Response(JSON.stringify({
        results: [{ url: 'https://www.andlight.cn/', raw_content: '和光是灯具品牌。', title: '和光' }],
      }), { status: 200 })
    },
  })
  const page = await client.extract('https://www.andlight.cn/')
  assert.equal(page.hostname, 'www.andlight.cn')
  assert.equal(page.text, '和光是灯具品牌。')
  await assert.rejects(client.extract('https://192.168.0.8/'), (error) => (
    error instanceof AgentToolRuntimeError && error.code === 'WEB_URL_NOT_ALLOWED'
  ))
  await assert.rejects(client.extract('https://[::1]/'), (error) => (
    error instanceof AgentToolRuntimeError && error.code === 'WEB_URL_NOT_ALLOWED'
  ))
})

test('无 Key 直连固定首次校验的公网 IP，且不会再次 DNS 解析', async () => {
  let lookups = 0
  let pinnedAddress
  const client = createTavilyWebResearch({
    apiKey: '',
    lookup: async () => {
      lookups += 1
      return ['93.184.216.34']
    },
    pageRequestImpl: pageResponse({
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: Buffer.from('<html><title>公开页</title><p>安全正文</p></html>'),
      inspect: (_url, options) => {
        options.lookup('untrusted.example', {}, (error, address) => {
          assert.ifError(error)
          pinnedAddress = address
        })
      },
    }),
  })

  const page = await client.extract('https://untrusted.example/article')
  assert.equal(lookups, 1)
  assert.equal(pinnedAddress, '93.184.216.34')
  assert.equal(page.title, '公开页')
  assert.equal(page.text, '公开页 安全正文')
})

test('无 Key 直连在读取中按字节上限拒绝超大网页', async () => {
  for (const scenario of ['declared', 'streamed']) {
    const client = createTavilyWebResearch({
      apiKey: '',
      lookup: async () => ['93.184.216.34'],
      pageRequestImpl: pageResponse({
        headers: {
          'content-type': 'text/html',
          ...(scenario === 'declared' ? { 'content-length': '1000001' } : {}),
        },
        body: scenario === 'declared' ? Buffer.from('ignored') : Buffer.alloc(1_000_001, 97),
      }),
    })
    await assert.rejects(client.extract('https://untrusted.example/large'), (error) => (
      error instanceof AgentToolRuntimeError && error.code === 'WEB_FETCH_TOO_LARGE'
    ))
  }
})
