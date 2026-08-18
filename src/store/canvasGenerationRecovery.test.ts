import assert from 'node:assert/strict'
import test from 'node:test'
import type { CanvasDocument, CanvasNode, GenerationJob, ResultNodeData } from '../domain/canvas.ts'
import { hasRecoveredGenerationDelta, mergeRecoveredGenerationJobs } from './canvasGenerationRecovery.ts'

function job(id: string, outputs: GenerationJob['outputs'] = [], updatedAt = 20): GenerationJob {
  return {
    id,
    status: 'succeeded',
    kind: 'generation',
    createdAt: 10,
    updatedAt,
    batchCount: Math.max(1, outputs.length),
    outputCount: outputs.length,
    provider: 'openai-images',
    model: 'gpt-image-2',
    outputs,
  }
}

function document(nodes: CanvasNode[], edges: CanvasDocument['edges'] = [], generationJobs: GenerationJob[] = []): CanvasDocument {
  return {
    id: 'project-recovery',
    name: '恢复测试',
    schemaVersion: 25,
    nodes,
    edges,
    viewport: { x: 0, y: 0, zoom: 1 },
    assets: [],
    assetGroups: [],
    templates: [],
    history: [],
    deliveries: [],
    generationJobs,
    batchVariationRuns: [],
    agentSessions: [],
    agentMemory: [],
    agentRuns: [],
    updatedAt: 1,
  }
}

function generateNode(position = { x: 100, y: 120 }, prompt = '本地保留的描述'): CanvasNode {
  return {
    id: 'generate-a',
    type: 'generate',
    position,
    draggable: true,
    data: {
      kind: 'generate',
      label: '图像生成',
      prompt,
      batchCount: 2,
      settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
    },
  }
}

function resultNode(
  id: string,
  position: { x: number; y: number },
  data: Partial<ResultNodeData> = {},
): CanvasNode {
  return {
    id,
    type: 'result',
    position,
    draggable: true,
    data: {
      kind: 'result',
      outputOf: 'generate-a',
      status: 'generating',
      taskStatus: 'running',
      label: '本地候选名',
      ...data,
    },
  }
}

test('任务已成功但本地结果节点为空时原位补图，并保留本地布局与编辑', () => {
  const currentJob = { ...job('job-a', [], 30), status: 'running' as const }
  const currentResult = { ...resultNode('result-a', { x: 520, y: 240 }), selected: true }
  const current = document([generateNode(), currentResult], [], [currentJob])
  const recoveredJob = job('job-a', [{ id: 'output-a', image: '/api/media/a', mediaKind: 'image' }], 20)
  const recovered = document([
    generateNode({ x: 0, y: 0 }, '远端旧描述'),
    resultNode('result-a', { x: 999, y: 999 }, {
      image: '/api/media/a',
      candidateId: 'output-a',
      jobId: 'job-a',
      status: 'ready',
      taskStatus: 'succeeded',
      label: '生成候选 1',
    }),
  ], [], [recoveredJob])

  const merged = mergeRecoveredGenerationJobs(current, recovered)
  const result = merged.nodes.find((node) => node.id === 'result-a')!

  assert.deepEqual(result.position, { x: 520, y: 240 })
  assert.equal(result.selected, true)
  assert.equal((result.data as ResultNodeData).image, '/api/media/a')
  assert.equal((result.data as ResultNodeData).candidateId, 'output-a')
  assert.equal((result.data as ResultNodeData).label, '本地候选名')
  assert.equal((merged.nodes.find((node) => node.id === 'generate-a')!.data as { prompt: string }).prompt, '本地保留的描述')
  assert.equal(merged.generationJobs[0].outputs?.length, 1)
})

test('一次任务的 N 个输出全部恢复为独立节点，并补齐必要连线', () => {
  const current = document([
    generateNode(),
    resultNode('result-a', { x: 520, y: 240 }, { taskGroupId: 'result-a', jobId: 'job-a' }),
  ], [], [job('job-a', [], 10)])
  const outputs = [
    { id: 'output-a', image: '/api/media/a', mediaKind: 'image' as const },
    { id: 'output-b', image: '/api/media/b', mediaKind: 'image' as const },
  ]
  const recovered = document([
    generateNode({ x: 0, y: 0 }, '远端旧描述'),
    resultNode('result-a', { x: 900, y: 100 }, {
      image: outputs[0].image,
      candidateId: outputs[0].id,
      jobId: 'job-a',
      taskGroupId: 'result-a',
      status: 'ready',
      taskStatus: 'succeeded',
    }),
    resultNode('result-job-a-output-b', { x: 900, y: 470 }, {
      image: outputs[1].image,
      candidateId: outputs[1].id,
      jobId: 'job-a',
      taskGroupId: 'result-a',
      status: 'ready',
      taskStatus: 'succeeded',
      variant: 1,
    }),
  ], [
    { id: 'edge-a', source: 'generate-a', target: 'result-a' },
    { id: 'edge-b', source: 'generate-a', target: 'result-job-a-output-b' },
  ], [job('job-a', outputs, 20)])

  const merged = mergeRecoveredGenerationJobs(current, recovered)
  const results = merged.nodes.filter((node) => node.type === 'result')

  assert.equal(results.length, 2)
  assert.deepEqual(results.map((node) => (node.data as ResultNodeData).image).sort(), ['/api/media/a', '/api/media/b'])
  assert.equal(merged.edges.filter((edge) => edge.source === 'generate-a').length, 2)
  assert.deepEqual(merged.nodes.find((node) => node.id === 'result-a')!.position, { x: 520, y: 240 })
})

test('浏览器断线后接受远端完成结果，同时保留离线期间的本地节点、位置与连线', () => {
  const localNote: CanvasNode = {
    id: 'text-local',
    type: 'text',
    position: { x: 40, y: 60 },
    draggable: true,
    data: { kind: 'text', label: '离线备注', content: '保留这条本地编辑' },
  }
  const current = document([
    generateNode({ x: 300, y: 320 }),
    resultNode('result-a', { x: 680, y: 350 }, { jobId: 'job-a', taskGroupId: 'result-a' }),
    localNote,
  ], [{ id: 'local-reference', source: 'text-local', target: 'generate-a' }], [job('job-a', [], 10)])
  const recovered = document([
    generateNode({ x: 0, y: 0 }, '远端旧描述'),
    resultNode('result-a', { x: 400, y: 40 }, {
      image: '/api/media/reconnected',
      candidateId: 'output-a',
      jobId: 'job-a',
      taskGroupId: 'result-a',
      status: 'ready',
      taskStatus: 'succeeded',
    }),
  ], [{ id: 'remote-output', source: 'generate-a', target: 'result-a' }], [
    job('job-a', [{ id: 'output-a', image: '/api/media/reconnected', mediaKind: 'image' }], 20),
  ])

  const merged = mergeRecoveredGenerationJobs(current, recovered)

  assert.equal(merged.nodes.some((node) => node.id === 'text-local'), true)
  assert.deepEqual(merged.nodes.find((node) => node.id === 'generate-a')!.position, { x: 300, y: 320 })
  assert.deepEqual(merged.nodes.find((node) => node.id === 'result-a')!.position, { x: 680, y: 350 })
  assert.equal((merged.nodes.find((node) => node.id === 'result-a')!.data as ResultNodeData).image, '/api/media/reconnected')
  assert.deepEqual(new Set(merged.edges.map((edge) => edge.id)), new Set(['local-reference', 'remote-output']))
})

test('结果数量不变时仍识别候选血缘与 Agent Run 的远端修复', () => {
  const current = document([
    generateNode(),
    resultNode('result-a', { x: 520, y: 240 }, {
      image: '/api/media/same', candidateId: 'legacy-output', jobId: 'job-a', status: 'ready', taskStatus: 'succeeded',
    }),
  ], [], [{ ...job('job-a', [{ id: 'legacy-output', image: '/api/media/same' }]), agentRun: undefined }])
  const recovered = document([
    generateNode(),
    resultNode('result-a', { x: 520, y: 240 }, {
      image: '/api/media/same', candidateId: 'output-a', jobId: 'job-a', status: 'ready', taskStatus: 'succeeded',
    }),
  ], [], [{ ...job('job-a', [{ id: 'output-a', image: '/api/media/same' }]), agentRun: { runId: 'run-a', branchId: 'branch-a' } }])

  assert.equal(hasRecoveredGenerationDelta(current, recovered), true)
  const merged = mergeRecoveredGenerationJobs(current, recovered)
  assert.equal((merged.nodes.find((node) => node.id === 'result-a')!.data as ResultNodeData).candidateId, 'output-a')
  assert.deepEqual(merged.generationJobs[0].agentRun, { runId: 'run-a', branchId: 'branch-a' })
})

test('Agent 结果恢复会补回完整 prompt、生成节点及参考和输出连线', () => {
  const reference: CanvasNode = {
    id: 'asset-reference',
    type: 'asset',
    position: { x: 20, y: 180 },
    draggable: true,
    data: {
      kind: 'asset', assetId: 'asset-reference', name: '参考图', image: '/api/media/reference',
      role: '商品', source: 'upload', mediaKind: 'image',
    },
  }
  const current = document([reference])
  const recoveredJob = {
    ...job('job-agent', [{ id: 'output-agent', image: '/api/media/output', mediaKind: 'image' }]),
    agentRun: { runId: 'run-agent', branchId: 'branch-agent' },
    generateNodeId: 'agent-generate-run-agent-branch-agent',
    resultNodeId: 'agent-result-run-agent-branch-agent',
  }
  const prompt: CanvasNode = {
    id: 'agent-prompt-run-agent-branch-agent', type: 'text', position: { x: 480, y: 8 }, draggable: true,
    data: { kind: 'text', label: '生成描述', content: '保持人物不变，只替换背景。' },
  }
  const generate: CanvasNode = {
    id: 'agent-generate-run-agent-branch-agent', type: 'generate', position: { x: 480, y: 180 }, draggable: true,
    data: {
      kind: 'generate', label: 'Agent 生成', prompt: '保持人物不变，只替换背景。', batchCount: 1,
      settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' }, status: 'succeeded',
      jobId: 'job-agent', agentRun: recoveredJob.agentRun,
    },
  }
  const result = resultNode('agent-result-run-agent-branch-agent', { x: 940, y: 180 }, {
    outputOf: generate.id,
    image: '/api/media/output', candidateId: 'output-agent', jobId: 'job-agent',
    status: 'ready', taskStatus: 'succeeded', agentRun: recoveredJob.agentRun,
  })
  const recovered = document([reference, prompt, generate, result], [
    { id: 'edge-reference', source: reference.id, sourceHandle: 'asset-output', target: generate.id, targetHandle: 'input', data: { role: 'reference' } },
    { id: 'edge-prompt', source: prompt.id, sourceHandle: 'output', target: generate.id, targetHandle: 'input', data: { role: 'prompt' } },
    { id: 'edge-output', source: generate.id, sourceHandle: 'output', target: result.id, targetHandle: 'input', data: { role: 'output' } },
  ], [recoveredJob])

  const merged = mergeRecoveredGenerationJobs(current, recovered)

  assert.deepEqual(
    new Set(merged.nodes.map((node) => node.id)),
    new Set([reference.id, prompt.id, generate.id, result.id]),
  )
  assert.deepEqual(
    new Set(merged.edges.map((edge) => edge.data?.role)),
    new Set(['reference', 'prompt', 'output']),
  )
})
