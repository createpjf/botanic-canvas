import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentToolRuntimeError } from './agentToolRuntime.mjs'
import { createTavilyWebResearch } from './webSearchProvider.mjs'

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
})
