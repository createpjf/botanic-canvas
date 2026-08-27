import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyPublicHttpUrl,
  clipFetchedText,
  extractTextFromHtml,
  hostnameFromUrl,
  normalizeWebSearchHits,
  presentationWebSources,
  resolveTavilyExtractUrl,
  resolveTavilySearchUrl,
} from './agentWebResearch.mjs'

test('Tavily MCP 地址回退到官方 Search REST，不把 Key 留在 URL 里', () => {
  assert.equal(resolveTavilySearchUrl(undefined), 'https://api.tavily.com/search')
  assert.equal(
    resolveTavilySearchUrl('https://mcp.tavily.com/mcp/?tavilyApiKey=secret'),
    'https://api.tavily.com/search',
  )
  assert.equal(resolveTavilyExtractUrl('https://api.tavily.com/search'), 'https://api.tavily.com/extract')
})

test('只接受公开 HTTPS，拒绝内网、metadata 和带用户信息的地址', () => {
  assert.equal(classifyPublicHttpUrl('https://www.andlight.cn/about').ok, true)
  assert.equal(classifyPublicHttpUrl('https://fcbarcelona.com/').ok, true)
  assert.equal(classifyPublicHttpUrl('https://fdny.org/').ok, true)
  assert.equal(classifyPublicHttpUrl('http://example.com').ok, false)
  assert.equal(classifyPublicHttpUrl('https://127.0.0.1/').ok, false)
  assert.equal(classifyPublicHttpUrl('https://192.168.1.8/admin').ok, false)
  assert.equal(classifyPublicHttpUrl('https://169.254.169.254/latest/meta-data').ok, false)
  assert.equal(classifyPublicHttpUrl('https://user:pass@example.com/').ok, false)
  assert.equal(classifyPublicHttpUrl('https://localhost/').ok, false)
  assert.equal(classifyPublicHttpUrl('https://[::1]/').ok, false)
  assert.equal(classifyPublicHttpUrl('https://[fd00::5]/').ok, false)
  assert.equal(classifyPublicHttpUrl('https://[fe80::1]/').ok, false)
  assert.equal(classifyPublicHttpUrl('https://[::ffff:127.0.0.1]/').ok, false)
  assert.equal(classifyPublicHttpUrl('http://127.0.0.1:8787/mock', { allowLocal: true }).ok, true)
  assert.equal(classifyPublicHttpUrl('http://[::1]:8787/mock', { allowLocal: true }).ok, true)
})

test('搜索结果丢掉私网链接，并截断摘要', () => {
  const hits = normalizeWebSearchHits([
    { title: '和光', url: 'https://www.andlight.cn/', content: '品牌官网'.repeat(80) },
    { title: '巴萨', url: 'https://fcbarcelona.com/', content: '俱乐部官网' },
    { title: '内网', url: 'https://10.0.0.8/secret', content: '不可见' },
    { title: '本机 IPv6', url: 'https://[::1]/secret', content: '不可见' },
    { title: '无地址', content: '跳过' },
  ])
  assert.equal(hits.length, 2)
  assert.equal(hits[0].hostname, 'www.andlight.cn')
  assert.equal(hits[1].hostname, 'fcbarcelona.com')
  assert.equal(hits[0].snippet.length <= 400, true)
  assert.equal(hostnameFromUrl(hits[0].url), 'www.andlight.cn')
})

test('展示摘要只下发公开 hostname，去掉重复站、私网、snippet 和 query', () => {
  const sources = presentationWebSources({
    query: '不要下发检索词',
    hits: [
      { title: '和光', url: 'https://www.andlight.cn/', hostname: 'www.andlight.cn', snippet: '品牌官网不要下发' },
      { title: '重复 www', url: 'https://andlight.cn/about', hostname: 'andlight.cn', snippet: '同一站' },
      { title: '巴萨', url: 'https://fcbarcelona.com/', hostname: 'fcbarcelona.com', snippet: '俱乐部' },
      { title: '内网', url: 'https://10.0.0.8/secret', hostname: '10.0.0.8', snippet: '不可见' },
      { title: '无地址', snippet: '跳过' },
    ],
  })
  assert.deepEqual(sources, [
    { hostname: 'www.andlight.cn', url: 'https://www.andlight.cn/', title: '和光' },
    { hostname: 'fcbarcelona.com', url: 'https://fcbarcelona.com/', title: '巴萨' },
  ])
  assert.equal(JSON.stringify(sources).includes('不要下发'), false)
  assert.equal(JSON.stringify(sources).includes('snippet'), false)
  assert.equal(JSON.stringify(sources).includes('query'), false)
})

test('字符串 sources 数组不当成网站；web_fetch 顶层公开 URL 可抽一条', () => {
  assert.deepEqual(presentationWebSources({
    hitCount: 25,
    sources: Array.from({ length: 25 }, (_, index) => `source-${index}`),
  }), [])
  assert.deepEqual(presentationWebSources({
    url: 'https://www.andlight.cn/about',
    hostname: 'www.andlight.cn',
    title: '关于和光',
    text: '正文不应出现',
  }), [{
    hostname: 'www.andlight.cn',
    url: 'https://www.andlight.cn/about',
    title: '关于和光',
  }])
})

test('HTML 抽取去掉脚本并限制长度', () => {
  const text = extractTextFromHtml('<html><script>alert(1)</script><p>和光灯具</p></html>')
  assert.equal(text, '和光灯具')
  assert.equal(clipFetchedText('  一段  空白  '), '一段 空白')
})
