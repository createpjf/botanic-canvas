import assert from 'node:assert/strict'
import test from 'node:test'
import { queryCanvasWithSemanticSearch } from './canvasAgentSemanticSearch.mjs'

const document = { nodes: [
  { id: 'a', type: 'text', position: { x: 0, y: 0 }, data: { label: '春日海报', content: '绿色植物' } },
  { id: 'b', type: 'text', position: { x: 1, y: 1 }, data: { label: '冬日海报', content: '白色雪景' } },
  { id: 'g', type: 'generate', position: { x: 2, y: 2 }, data: { label: '生成器', prompt: 'private secret prompt' } },
], edges: [] }
const config = { enabled: true, apiBaseUrl: 'https://embedding.example/v1', apiKey: 'test-key', model: 'test-model' }

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
})

test('语义 Provider 失败时确定性降级关键词检索', async () => {
  const result = await queryCanvasWithSemanticSearch(document, { mode: 'semantic', query: '冬日' }, config, async () => { throw new Error('offline') })
  assert.deepEqual(result.nodes.map((node) => node.id), ['b'])
  assert.deepEqual(result.search, { requestedMode: 'semantic', effectiveMode: 'keyword', degraded: true, reason: 'SEMANTIC_PROVIDER_FAILED' })
})
