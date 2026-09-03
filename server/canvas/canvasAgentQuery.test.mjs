import assert from 'node:assert/strict'
import test from 'node:test'
import { CanvasAgentQueryError, queryCanvasForAgent } from './canvasAgentQuery.mjs'

const document = {
  nodes: [
    { id: 'asset-product', type: 'asset', position: { x: 0, y: 0 }, data: { kind: 'asset', assetId: 'asset-1', name: '商品图', role: '商品', image: 'private://must-not-leak' } },
    { id: 'generate-a', type: 'generate', position: { x: 300, y: 0 }, data: { kind: 'generate', label: '主图 A', status: 'idle', prompt: 'secret prompt', settings: { model: 'm', aspectRatio: '4:5', resolution: '2K' }, batchCount: 4 } },
    { id: 'generate-b', type: 'generate', position: { x: 300, y: 200 }, data: { kind: 'generate', label: '主图 B', status: 'idle', settings: { model: 'm', aspectRatio: '4:5', resolution: '2K' }, batchCount: 2, constraints: [{ dimension: 'person', mode: 'preserve', secret: 'must-not-leak' }, { dimension: 'unknown', mode: 'change' }] } },
    { id: 'generate-c', type: 'generate', position: { x: 300, y: 400 }, data: { kind: 'generate', label: '主图 C', status: 'running', settings: { model: 'm' } } },
    { id: 'generate-d', type: 'generate', position: { x: 300, y: 600 }, data: { kind: 'generate', label: '主图 D', settings: { model: 'm' } } },
    { id: 'result-a', type: 'result', position: { x: 600, y: 0 }, data: { kind: 'result', status: 'ready', jobId: 'job-1', candidateId: 'out-1', image: 'private://result' } },
  ],
  edges: [
    { id: 'edge-product', source: 'asset-product', target: 'generate-a', data: { role: '商品' } },
    { id: 'edge-output', source: 'generate-a', target: 'result-a', data: { system: true, role: 'output' } },
  ],
}

test('分页查询缺少指定参考的空闲 Generate 节点且不泄露媒体与 prompt', () => {
  const first = queryCanvasForAgent(document, {
    types: ['generate'], statuses: ['idle'], missingIncomingReferenceRole: '商品', limit: 1,
  })
  assert.deepEqual(first.nodes.map((node) => node.id), ['generate-b'])
  assert.deepEqual(first.nodes[0].constraints, [{ dimension: 'person', mode: 'preserve' }])
  assert.deepEqual(first.page, { returned: 1, hasMore: true, afterId: 'generate-b', edgesTruncated: false })
  const second = queryCanvasForAgent(document, {
    types: ['generate'], statuses: ['idle'], missingIncomingReferenceRole: '商品', limit: 1, afterId: first.page.afterId,
  })
  assert.deepEqual(second.nodes.map((node) => node.id), ['generate-d'])
  assert.equal(second.page.hasMore, false)
  assert.equal(JSON.stringify(first).includes('private://'), false)
  assert.equal(JSON.stringify(first).includes('secret prompt'), false)

  const generated = queryCanvasForAgent(document, { artifactId: 'generation:job-1:out-1' })
  assert.deepEqual(generated.nodes.map((node) => node.id), ['result-a'])
  assert.deepEqual(generated.nodes[0].authority, { jobId: 'job-1', candidateId: 'out-1' })
})

test('非法过滤与不属于当前结果集的游标明确失败', () => {
  assert.throws(
    () => queryCanvasForAgent(document, { types: ['unknown'] }),
    (error) => error instanceof CanvasAgentQueryError && error.code === 'CANVAS_QUERY_INVALID',
  )
  assert.throws(
    () => queryCanvasForAgent(document, { types: ['generate'], afterId: 'result-a' }),
    (error) => error instanceof CanvasAgentQueryError && error.code === 'CANVAS_QUERY_CURSOR_INVALID',
  )
})
