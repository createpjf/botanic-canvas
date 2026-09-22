import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { queryCanvasWithSemanticSearch } from './canvasAgentSemanticSearch.mjs'

const document = { nodes: [
  { id: 'a', type: 'text', position: { x: 0, y: 0 }, data: { label: '春日海报', content: '绿色植物' } },
  { id: 'b', type: 'text', position: { x: 1, y: 1 }, data: { label: '冬日海报', content: '白色雪景' } },
  { id: 'g', type: 'generate', position: { x: 2, y: 2 }, data: { label: '生成器', prompt: 'private secret prompt' } },
], edges: [] }
const config = { enabled: true, apiBaseUrl: 'https://embedding.example/v1', apiKey: 'test-key', model: 'test-model' }

test('语义检索只有一次总预算，父取消或 Turn deadline 不降级成关键词成功', async () => {
  const large = { nodes: Array.from({ length: 150 }, (_, i) => ({ id: `budget-${i}`, type: 'text', data: { label: '植物' } })), edges: [] }
  let requests = 0
  const slowProvider = async (_url, init) => {
    requests++
    await delay(30, undefined, { signal: init.signal })
    return { ok: true, json: async () => ({ data: JSON.parse(init.body).input.map(() => ({ embedding: [1, 0] })) }) }
  }
  const startedAt = performance.now()
  const timed = await queryCanvasWithSemanticSearch(large, { mode: 'semantic', query: '植物' }, { ...config, model: 'budget', timeoutMs: 45 }, slowProvider)
  assert.equal(timed.search.reason, 'SEMANTIC_SEARCH_TIMEOUT')
  assert.ok(requests <= 2, '下一批不能重新获得一份完整超时预算')
  assert.ok(performance.now() - startedAt < 300, '留出调度余量，避免毫秒级脆弱断言')

  const controller = new AbortController()
  requests = 0
  await assert.rejects(queryCanvasWithSemanticSearch(large, { mode: 'semantic', query: '植物' }, { ...config, model: 'cancel' }, async (_url, init) => {
    requests++
    controller.abort()
    await delay(5, undefined, { signal: init.signal })
    throw new Error('不可到达')
  }, { signal: controller.signal }), { code: 'REQUEST_CANCELLED' })
  assert.equal(requests, 1)

  requests = 0
  await assert.rejects(queryCanvasWithSemanticSearch(large, { mode: 'semantic', query: '植物' }, { ...config, model: 'deadline' }, slowProvider, {
    deadlineAt: Date.now() - 1,
  }), { code: 'AGENT_TURN_DEADLINE_EXCEEDED' })
  assert.equal(requests, 0)
  await assert.rejects(queryCanvasWithSemanticSearch(large, { mode: 'semantic', query: '植物' }, { ...config, model: 'deadline-active' }, slowProvider, {
    deadlineAt: Date.now() + 15,
  }), { code: 'AGENT_TURN_DEADLINE_EXCEEDED' })
  assert.equal(requests, 1)
})

test('混合检索只发送安全文本并融合关键词与语义稳定排序', async () => {
  let request
  const result = await queryCanvasWithSemanticSearch(document, { mode: 'hybrid', query: '春日海报', limit: 2 }, config, async (url, init) => {
    request = { url, body: JSON.parse(init.body) }
    return { ok: true, json: async () => ({ data: [{ embedding: [1, 0] }, { embedding: [1, 0] }, { embedding: [0, 1] }, { embedding: [0.5, 0.5] }] }) }
  })
  assert.equal(request.url, 'https://embedding.example/v1/embeddings')
  assert.equal(JSON.stringify(request.body).includes('private secret prompt'), false)
  assert.deepEqual(result.nodes.map((node) => node.id), ['a', 'g'])
  assert.deepEqual(result.search, { requestedMode: 'hybrid', effectiveMode: 'hybrid', degraded: false })

  const large = { nodes: Array.from({ length: 52 }, (_, index) => ({ id: `n-${String(index).padStart(2, '0')}`, type: 'text', position: { x: index, y: 0 }, data: { label: `节点 ${index}`, content: '候选' } })), edges: [] }
  const batchSizes = []
  const beyondFirstPage = await queryCanvasWithSemanticSearch(large, { mode: 'semantic', query: '目标', limit: 1 }, config, async (_url, init) => {
    const input = JSON.parse(init.body).input
    batchSizes.push(input.length)
    return { ok: true, json: async () => ({ data: input.map((text) => ({ embedding: text === '目标' || text.includes('节点 51') ? [1, 0] : [0, 1] })) }) }
  })
  assert.deepEqual(batchSizes, [50, 3])
  assert.equal(beyondFirstPage.nodes[0].id, 'n-51')
  assert.equal(beyondFirstPage.page.searchTruncated, false)
  const cached = await queryCanvasWithSemanticSearch(large, { mode: 'semantic', query: '目标', limit: 1 }, config, async () => { throw new Error('unchanged candidates must not be re-embedded') })
  assert.equal(cached.nodes[0].id, 'n-51')
})

test('语义 Provider 失败时降级关键词检索并延续当前游标', async () => {
  const fallbackDocument = { nodes: [
    { id: 'a', type: 'text', position: { x: 0, y: 0 }, data: { label: '冬日 A', content: '雪景' } },
    { id: 'b', type: 'text', position: { x: 1, y: 0 }, data: { label: '冬日 B', content: '雪景' } },
  ], edges: [] }
  const result = await queryCanvasWithSemanticSearch(fallbackDocument, { mode: 'semantic', query: '冬日', limit: 1, afterId: 'a' }, { ...config, model: 'offline-model' }, async () => { throw new Error('offline') })
  assert.deepEqual(result.nodes.map((node) => node.id), ['b'])
  assert.deepEqual(result.search, { requestedMode: 'semantic', effectiveMode: 'keyword', degraded: true, reason: 'SEMANTIC_PROVIDER_FAILED' })
})

test('语义游标对 keyword 排序无效时重置游标重来，不谎报已完整', async () => {
  const fallbackDocument = { nodes: [
    { id: 'a', type: 'text', position: { x: 0, y: 0 }, data: { label: '冬日 A', content: '雪景' } },
    { id: 'b', type: 'text', position: { x: 1, y: 0 }, data: { label: '冬日 B', content: '雪景' } },
  ], edges: [] }
  // afterId 'zz' 是语义排序里的游标，keyword 结果集中不存在。
  const result = await queryCanvasWithSemanticSearch(fallbackDocument, { mode: 'semantic', query: '冬日', limit: 1, afterId: 'zz' }, { ...config, model: 'offline-model' }, async () => { throw new Error('offline') })
  assert.equal(result.nodes.length, 1, '重置后返回 keyword 第一页，而不是空终页')
  assert.equal(result.search.cursorReset, true)
  assert.equal(result.search.degraded, true)
})
