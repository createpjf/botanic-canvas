import assert from 'node:assert/strict'
import test from 'node:test'
import type { Edge } from '@xyflow/react'
import type { CanvasNode } from './canvas.ts'
import {
  displayEdgeEnds,
  displayGenerateOwnerId,
  generateHasVisualInput,
  hiddenAgentExecutionNodeIds,
  hiddenGenerateIds,
  listGeneratesFromInput,
  markStandaloneGeneratesOnManualConnect,
  pickWorkingGenerateId,
} from './canvasWorkingGenerate.ts'

const nodes = [
  { id: 'asset-1', type: 'asset', position: { x: 0, y: 0 }, data: { name: 'A', image: 'a.png', role: '商品' } },
  { id: 'generate-1', type: 'generate', position: { x: 0, y: 0 }, data: { label: '图像生成', prompt: '', batchCount: 1, settings: { model: 'm', aspectRatio: '1:1', resolution: '1K' }, primaryInputId: 'asset-1' } },
  { id: 'generate-2', type: 'generate', position: { x: 0, y: 0 }, data: { label: '图像生成', prompt: '', batchCount: 1, settings: { model: 'm', aspectRatio: '1:1', resolution: '1K' }, primaryInputId: 'asset-1' } },
  { id: 'result-1', type: 'result', position: { x: 0, y: 0 }, data: { label: '出图', image: 'r.png', status: 'ready', selected: false } },
  { id: 'generate-orphan', type: 'generate', position: { x: 0, y: 0 }, data: { label: '图像生成', prompt: '', batchCount: 1, settings: { model: 'm', aspectRatio: '1:1', resolution: '1K' }, primaryInputId: '' } },
] as CanvasNode[]

const edges = [
  { id: 'e1', source: 'asset-1', target: 'generate-1' },
  { id: 'e2', source: 'asset-1', target: 'generate-2' },
  { id: 'e3', source: 'generate-1', target: 'result-1' },
] as Edge[]

test('listGeneratesFromInput 按 id 新到旧', () => {
  assert.deepEqual(listGeneratesFromInput('asset-1', nodes, edges), ['generate-2', 'generate-1'])
})

test('pickWorkingGenerateId 优先尚无成功输出的 generate', () => {
  assert.equal(pickWorkingGenerateId('asset-1', nodes, edges), 'generate-2')
})

test('generateHasVisualInput / hiddenGenerateIds 只藏有参考的 generate', () => {
  assert.equal(generateHasVisualInput('generate-1', nodes, edges), true)
  assert.equal(generateHasVisualInput('generate-orphan', nodes, edges), false)
  const hidden = hiddenGenerateIds(nodes, edges)
  assert.equal(hidden.has('generate-1'), true)
  assert.equal(hidden.has('generate-2'), true)
  assert.equal(hidden.has('generate-orphan'), false)
})

test('Agent 的 prompt / generate 只保留在持久化血缘，不占普通画布节点', () => {
  const agentNodes = [
    { id: 'agent-prompt-1', type: 'text', position: { x: 0, y: 0 }, data: { kind: 'text', label: '生成描述', content: '一张海报' } },
    { id: 'agent-generate-1', type: 'generate', position: { x: 0, y: 0 }, data: { kind: 'generate', label: 'Agent 生成', prompt: '', batchCount: 1, settings: { model: 'm', aspectRatio: '1:1', resolution: '1K' }, agentRun: { runId: 'run-1', branchId: 'branch-1' } } },
    { id: 'agent-result-1', type: 'result', position: { x: 0, y: 0 }, data: { kind: 'result', image: 'result.png', status: 'ready', outputOf: 'agent-generate-1' } },
  ] as CanvasNode[]
  const agentEdges = [
    { id: 'agent-prompt-edge', source: 'agent-prompt-1', target: 'agent-generate-1' },
    { id: 'agent-output-edge', source: 'agent-generate-1', target: 'agent-result-1' },
  ] as Edge[]
  assert.equal(hiddenGenerateIds(agentNodes, agentEdges).has('agent-generate-1'), true)
  assert.deepEqual([...hiddenAgentExecutionNodeIds(agentNodes, agentEdges)].sort(), ['agent-generate-1', 'agent-prompt-1'])
})

test('两张图的参考边画在媒体之间，不指向隐藏 generate', () => {
  const extra = [
    ...nodes,
    { id: 'asset-2', type: 'asset', position: { x: 200, y: 0 }, data: { name: 'B', image: 'b.png', role: '场景' } },
  ] as CanvasNode[]
  const linked = [...edges, { id: 'e4', source: 'asset-2', target: 'generate-2' }] as Edge[]
  assert.equal(displayGenerateOwnerId('generate-2', extra, linked), 'asset-1')
  const hidden = hiddenGenerateIds(extra, linked)
  const shown = displayEdgeEnds(linked[3], extra, linked, hidden)
  assert.deepEqual(shown, { source: 'asset-2', target: 'asset-1', hidden: false })
  const self = displayEdgeEnds(linked[1], extra, linked, hidden)
  assert.equal(self.hidden, true)
  assert.equal(displayEdgeEnds(edges[2], extra, linked, hidden).hidden, true)
})

test('Agent 工作流的参考边画到输出结果上，而不是折成自环被隐藏', () => {
  const agentNodes = [
    { id: 'asset-old', type: 'asset', position: { x: 0, y: 0 }, data: { name: '老素材', image: 'old.png', role: '商品' } },
    { id: 'result-old', type: 'result', position: { x: 0, y: 200 }, data: { label: '老结果', image: 'old-r.png', status: 'ready' } },
    { id: 'agent-generate-1', type: 'generate', position: { x: 460, y: 0 }, data: { kind: 'generate', label: 'Agent 生成', prompt: '', batchCount: 1, settings: { model: 'm', aspectRatio: '1:1', resolution: '1K' }, agentRun: { runId: 'run-1', branchId: 'branch-1' } } },
    { id: 'agent-result-1', type: 'result', position: { x: 920, y: 0 }, data: { kind: 'result', outputOf: 'agent-generate-1', status: 'generating' } },
  ] as CanvasNode[]
  const agentEdges = [
    { id: 'agent-reference-edge-a', source: 'asset-old', target: 'agent-generate-1' },
    { id: 'agent-reference-edge-b', source: 'result-old', target: 'agent-generate-1' },
    { id: 'agent-output-edge', source: 'agent-generate-1', target: 'agent-result-1' },
  ] as Edge[]
  const hidden = hiddenGenerateIds(agentNodes, agentEdges)
  assert.equal(hidden.has('agent-generate-1'), true)
  assert.deepEqual(
    displayEdgeEnds(agentEdges[0], agentNodes, agentEdges, hidden),
    { source: 'asset-old', target: 'agent-result-1', hidden: false },
  )
  assert.deepEqual(
    displayEdgeEnds(agentEdges[1], agentNodes, agentEdges, hidden),
    { source: 'result-old', target: 'agent-result-1', hidden: false },
  )
})

test('用户钉在画布上的 generate 连上旧图后仍可见，参考边仍指向该节点', () => {
  const standaloneNodes = nodes.map((node) => (
    node.id === 'generate-orphan'
      ? { ...node, data: { ...node.data, standalone: true } }
      : node
  )) as CanvasNode[]
  const connected = [...edges, { id: 'e-orphan', source: 'asset-1', target: 'generate-orphan' }] as Edge[]
  const hidden = hiddenGenerateIds(standaloneNodes, connected)
  assert.equal(hidden.has('generate-orphan'), false)
  assert.equal(hidden.has('generate-1'), true)
  assert.deepEqual(
    displayEdgeEnds(connected[3], standaloneNodes, connected, hidden),
    { source: 'asset-1', target: 'generate-orphan', hidden: false },
  )
})

test('standalone generate 只是上下文，不抢走媒体自己的 composer', () => {
  const extra = nodes.map((node) => (
    node.id === 'generate-orphan'
      ? { ...node, data: { ...node.data, standalone: true } }
      : node
  )) as CanvasNode[]
  const linked = [...edges, { id: 'e-orphan', source: 'asset-1', target: 'generate-orphan' }] as Edge[]
  assert.equal(pickWorkingGenerateId('asset-1', extra, linked), 'generate-2')
})

test('媒体只连着 standalone generate 时没有自己的 working generate', () => {
  const only = [
    nodes[0],
    { ...nodes[4], data: { ...nodes[4].data, standalone: true } },
  ] as CanvasNode[]
  const linked = [{ id: 'e-orphan', source: 'asset-1', target: 'generate-orphan' }] as Edge[]
  assert.equal(pickWorkingGenerateId('asset-1', only, linked), null)
})

test('当媒体只是别人 generate 的上下文时，不抢走自己的 composer', () => {
  const extra = [
    ...nodes,
    { id: 'asset-2', type: 'asset', position: { x: 200, y: 0 }, data: { name: 'B', image: 'b.png', role: '场景' } },
    { id: 'generate-b', type: 'generate', position: { x: 0, y: 0 }, data: { label: '图像生成', prompt: '', batchCount: 1, settings: { model: 'm', aspectRatio: '1:1', resolution: '1K' }, primaryInputId: 'asset-2' } },
  ] as CanvasNode[]
  const linked = [
    ...edges,
    { id: 'e-b', source: 'asset-2', target: 'generate-b' },
    { id: 'e-ctx', source: 'asset-1', target: 'generate-b' },
  ] as Edge[]
  assert.equal(pickWorkingGenerateId('asset-1', extra, linked), 'generate-2')
})

test('媒体只作为别人 generate 的上下文时没有自己的 working generate', () => {
  const only = [
    nodes[0],
    { id: 'asset-2', type: 'asset', position: { x: 200, y: 0 }, data: { name: 'B', image: 'b.png', role: '场景' } },
    { id: 'generate-b', type: 'generate', position: { x: 0, y: 0 }, data: { label: '图像生成', prompt: '', batchCount: 1, settings: { model: 'm', aspectRatio: '1:1', resolution: '1K' }, primaryInputId: 'asset-2' } },
  ] as CanvasNode[]
  const linked = [
    { id: 'e-b', source: 'asset-2', target: 'generate-b' },
    { id: 'e-ctx', source: 'asset-1', target: 'generate-b' },
  ] as Edge[]
  assert.equal(pickWorkingGenerateId('asset-1', only, linked), null)
})

test('把已有 orphan generate 第一次连上视觉参考时标成 standalone', () => {
  const connected = [...edges, { id: 'e-orphan', source: 'asset-1', target: 'generate-orphan' }] as Edge[]
  const marked = markStandaloneGeneratesOnManualConnect(nodes, edges, connected)
  const orphan = marked.find((node) => node.id === 'generate-orphan')
  assert.equal((orphan?.data as { standalone?: boolean }).standalone, true)
  const existing = marked.find((node) => node.id === 'generate-1')
  assert.equal((existing?.data as { standalone?: boolean }).standalone, undefined)
})
