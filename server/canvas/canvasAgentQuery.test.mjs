import assert from 'node:assert/strict'
import test from 'node:test'
import { CanvasAgentQueryError, queryCanvasForAgent } from './canvasAgentQuery.mjs'
import { buildBotanicAgentOntology } from '../agent/semantic/botanicAgentOntology.mjs'

const document = {
  nodes: [
    { id: 'asset-product', type: 'asset', position: { x: 0, y: 0 }, data: { kind: 'asset', assetId: 'asset-1', name: '商品图', role: '商品', image: 'private://must-not-leak' } },
    { id: 'generate-a', type: 'generate', position: { x: 300, y: 0 }, data: { kind: 'generate', label: '主图 A', status: 'idle', prompt: 'secret prompt', settings: { model: 'm', aspectRatio: '4:5', resolution: '2K' }, batchCount: 4 } },
    { id: 'generate-b', type: 'generate', position: { x: 300, y: 200 }, data: { kind: 'generate', label: '主图 B', status: 'idle', settings: { model: 'm', aspectRatio: '4:5', resolution: '2K' }, batchCount: 2, constraints: [{ dimension: 'person', mode: 'preserve', secret: 'must-not-leak' }, { dimension: 'unknown', mode: 'change' }] } },
    { id: 'generate-c', type: 'generate', position: { x: 300, y: 400 }, data: { kind: 'generate', label: '主图 C', status: 'running', settings: { model: 'm' } } },
    { id: 'generate-d', type: 'generate', position: { x: 300, y: 600 }, data: { kind: 'generate', label: '主图 D', settings: { model: 'm' } } },
    { id: 'result-a', type: 'result', position: { x: 600, y: 0 }, data: { kind: 'result', status: 'ready', jobId: 'job-1', candidateId: 'out-1', image: 'private://result' } },
    { id: 'frame-review', type: 'frame', position: { x: 0, y: 700 }, data: { kind: 'frame', label: '审阅泳道', stage: 'review', width: 900, height: 400 } },
    { id: 'prompt-a', type: 'prompt', position: { x: 300, y: 800 }, data: { kind: 'prompt', label: '视觉目标', prompt: '春日山茶花海报' } },
  ],
  edges: [
    { id: 'edge-product', source: 'asset-product', target: 'generate-a', data: { role: '商品' } },
    { id: 'edge-output', source: 'generate-a', target: 'result-a', data: { system: true, role: 'output' } },
  ],
}

test('Ontology 快照与实时查询共享名称、状态、组织与关系语义，但概览不扩大正文权限', () => {
  const input = structuredClone(document)
  Object.assign(input.nodes[1].data, { name: '旧名称', taskStatus: 'running', frameId: 'frame-review' })
  input.edges[0].sourceHandle = 'reference'
  input.edges[0].targetHandle = 'input'
  delete input.edges[0].data.role // 历史边从来源节点取角色。
  const snapshot = buildBotanicAgentOntology(input)
  const live = queryCanvasForAgent(input)
  const generator = snapshot.nodes.find((node) => node.id === 'generate-a')
  assert.equal(generator.label, '主图 A')
  assert.equal(generator.status, 'running')
  assert.equal(generator.frameId, 'frame-review')
  for (const node of snapshot.nodes) {
    const current = live.nodes.find((entry) => entry.id === node.id)
    for (const key of ['id', 'type', 'label', 'status', 'frameId', 'stage', 'role', 'mediaKind']) {
      assert.deepEqual(node[key], current[key], `${node.id}.${key}`)
    }
  }
  for (const edge of live.edges) {
    const stored = snapshot.edges.find((entry) => entry.id === edge.id)
    for (const key of Object.keys(edge)) assert.deepEqual(stored[key], edge[key])
  }
  assert.equal(snapshot.edges[0].role, '商品')
  assert.equal(snapshot.edges[1].system, true)
  assert.equal(snapshot.nodes.find((node) => node.id === 'generate-d').status, 'idle')
  assert.equal(snapshot.nodes.find((node) => node.id === 'frame-review').status, undefined, '阶段不是审批结论')
  assert.ok(live.nodes.find((node) => node.id === 'prompt-a').content)
  assert.doesNotMatch(JSON.stringify(snapshot), /private:\/\/|secret prompt|春日山茶花海报|"authority"|"position"/)
})

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

test('聚合与关键词模式基于安全投影返回确定性结果', () => {
  const aggregate = queryCanvasForAgent(document, { mode: 'aggregate' })
  assert.equal(aggregate.aggregate.total, 8)
  assert.deepEqual(aggregate.aggregate.byType.find((item) => item.value === 'generate'), { value: 'generate', count: 4 })
  assert.deepEqual(aggregate.aggregate.byStage, [{ value: 'review', count: 1 }])
  assert.deepEqual(aggregate.nodes, [])
  const keyword = queryCanvasForAgent(document, { mode: 'keyword', query: '主图', limit: 2 })
  assert.deepEqual(keyword.nodes.map((node) => node.id), ['generate-a', 'generate-b'])
  assert.deepEqual(keyword.nodes[0].match.fields, ['label'])
  assert.equal(keyword.page.hasMore, true)
  assert.deepEqual(queryCanvasForAgent(document, { mode: 'keyword', query: 'secret prompt' }).nodes, [])
  const prompt = queryCanvasForAgent(document, { mode: 'keyword', query: '山茶花' })
  assert.deepEqual(prompt.nodes.map((node) => node.id), ['prompt-a'])
  assert.equal(prompt.nodes[0].content, '春日山茶花海报')
})

test('非法过滤与不属于当前结果集的游标明确失败', () => {
  assert.throws(
    () => queryCanvasForAgent(document, { types: ['unknown'] }),
    (error) => error instanceof CanvasAgentQueryError && error.code === 'CANVAS_QUERY_INVALID',
  )
  assert.throws(
    () => queryCanvasForAgent(document, { mode: 'keyword' }),
    (error) => error instanceof CanvasAgentQueryError && error.code === 'CANVAS_QUERY_INVALID',
  )
  assert.throws(
    () => queryCanvasForAgent(document, { types: ['generate'], afterId: 'result-a' }),
    (error) => error instanceof CanvasAgentQueryError && error.code === 'CANVAS_QUERY_CURSOR_INVALID',
  )
})
