import assert from 'node:assert/strict'
import test from 'node:test'
import { reconcileGenerationResults, retargetGenerationJobForRetry } from './generationResultReconciliation.mjs'

test('单分支重试把原失败占位节点切换到新 Job，不创建平行任务节点', () => {
  const document = {
    nodes: [
      { id: 'generate-a', type: 'generate', data: { jobId: 'job-old', status: 'failed', error: '失败' } },
      { id: 'result-a', type: 'result', data: { outputOf: 'generate-a', jobId: 'job-old', status: 'failed', taskStatus: 'failed', error: '失败' } },
    ],
    generationJobs: [{ id: 'job-old', status: 'failed' }],
  }
  const next = retargetGenerationJobForRetry(document, 'job-old', 'job-new', 100)
  assert.equal(next.changed, true)
  assert.equal(next.document.nodes[0].data.jobId, 'job-new')
  assert.equal(next.document.nodes[1].data.status, 'generating')
  assert.equal(next.document.generationJobs[0].id, 'job-new')
  const reconciled = reconcileGenerationResults(next.document, [{
    id: 'job-new', status: 'succeeded', kind: 'generation', batchCount: 1, createdAt: 100, updatedAt: 120,
    settings: { model: 'gpt-image-2' }, outputs: [{ id: 'output-new', image: '/api/media/new' }],
  }])
  assert.equal(reconciled.changed, true)
  assert.equal(reconciled.document.nodes[1].data.image, '/api/media/new')
})

test('历史成功任务会把空结果节点回填为独立图片节点', () => {
  const document = {
    id: 'project-a', nodes: [
      { id: 'generate-a', type: 'generate', position: { x: 0, y: 0 }, data: { jobId: 'job-a', generationKind: 'refinement' } },
      { id: 'result-a', type: 'result', position: { x: 400, y: 0 }, data: { outputOf: 'generate-a', taskGroupId: 'result-a', taskStatus: 'succeeded', status: 'ready', generationKind: 'refinement' } },
    ], edges: [], generationJobs: [], updatedAt: 1,
  }
  const { document: reconciled, changed } = reconcileGenerationResults(document, [{
    id: 'job-a', status: 'succeeded', kind: 'refinement', batchCount: 2, createdAt: 1, updatedAt: 2,
    settings: { model: 'gpt-image-2' }, outputs: [
      { id: 'output-1', image: '/api/media/one' }, { id: 'output-2', image: '/api/media/two' },
    ],
  }])

  assert.equal(changed, true)
  assert.equal(reconciled.nodes.filter((node) => node.type === 'result').length, 2)
  assert.deepEqual(reconciled.nodes.filter((node) => node.type === 'result').map((node) => node.data.image), ['/api/media/one', '/api/media/two'])
})

test('占位节点被错配旧任务号时，对账不覆写已落图历史节点，并把僵尸占位如实标记失败', () => {
  // 「篡改历史」回归：上游 r1 已持有 job-1 的输出（3:4·2K），下游占位节点被兜底
  // 恢复错打上 job-1 且标成 succeeded。旧行为会按「任务号 + 候选号」命中 r1，
  // 用占位节点的 4:3·1K 参数快照与血缘覆写它；现在 r1 必须原样保留，而占位节点
  // 声称的任务已在别处完整落图、又找不到真正以它为落点的任务，应如实转为失败。
  const parentSettings = { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' }
  const document = {
    id: 'project-hijack',
    nodes: [
      { id: 'g1', type: 'generate', position: { x: 0, y: 0 }, data: { kind: 'generate', jobId: 'job-1', generationKind: 'refinement', settings: parentSettings } },
      {
        id: 'r1', type: 'result', position: { x: 400, y: 0 },
        data: {
          kind: 'result', label: '定向精修', outputOf: 'g1', image: '/api/media/calbee', jobId: 'job-1', candidateId: 'out-1',
          taskGroupId: 'r1', taskStatus: 'succeeded', status: 'ready', generationKind: 'refinement',
          generationSettings: parentSettings,
        },
      },
      {
        id: 'pending', type: 'result', position: { x: 800, y: 0 },
        data: {
          kind: 'result', label: '定向精修 · 图像 01', outputOf: 'g2', jobId: 'job-1',
          taskGroupId: 'pending', taskStatus: 'succeeded', status: 'ready', generationKind: 'refinement',
          generationSettings: { model: 'minimax-image-01', aspectRatio: '4:3', resolution: '1K' },
        },
      },
    ],
    edges: [], generationJobs: [], updatedAt: 1,
  }
  const parentBefore = JSON.stringify(document.nodes[1])
  const { document: reconciled, changed } = reconcileGenerationResults(document, [{
    id: 'job-1', status: 'succeeded', kind: 'refinement', batchCount: 1, createdAt: 1_000, updatedAt: 1_100,
    settings: parentSettings, outputs: [{ id: 'out-1', image: '/api/media/calbee' }],
  }])

  assert.equal(changed, true)
  const parent = reconciled.nodes.find((node) => node.id === 'r1')
  assert.equal(JSON.stringify(parent), parentBefore)
  assert.equal(parent.data.generationSettings.aspectRatio, '3:4')
  assert.equal(parent.data.outputOf, 'g1')
  const pending = reconciled.nodes.find((node) => node.id === 'pending')
  assert.equal(pending.data.image, undefined)
  assert.equal(pending.data.taskStatus, 'failed')
  assert.equal(pending.data.jobId, undefined)
})

test('存量污染文档：被覆写的历史节点按任务提交参数回填，僵尸占位交还真实任务并在同一次对账落图', () => {
  // 修复前的存量现场：r1 的参数快照/血缘已被下游占位节点的 4:3·1K 覆写，
  // 下游占位节点带着 job-1 的任务号卡在「等待生成结果」，真正的 job-2 结果无处可去。
  const parentSettings = { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' }
  const childSettings = { model: 'minimax-image-01', aspectRatio: '4:3', resolution: '1K' }
  const document = {
    id: 'project-corrupted',
    nodes: [
      { id: 'g1', type: 'generate', position: { x: 0, y: 0 }, data: { kind: 'generate', jobId: 'job-1', generationKind: 'refinement', settings: parentSettings } },
      {
        id: 'r1', type: 'result', position: { x: 400, y: 0 },
        data: {
          kind: 'result', label: '定向精修', outputOf: 'g2', image: '/api/media/calbee', jobId: 'job-1', candidateId: 'out-1',
          taskGroupId: 'pending', taskNodeId: 'r1', taskStatus: 'succeeded', status: 'ready', generationKind: 'refinement',
          generationSettings: { ...childSettings },
          generationRecipe: { prompt: '背景放在超市里', batchCount: 1, settings: { ...childSettings }, references: [] },
        },
      },
      { id: 'g2', type: 'generate', position: { x: 800, y: 0 }, data: { kind: 'generate', generationKind: 'refinement', settings: childSettings } },
      {
        id: 'pending', type: 'result', position: { x: 1200, y: 0 },
        data: {
          kind: 'result', label: '定向精修 · 图像 01', outputOf: 'g2', jobId: 'job-1',
          taskGroupId: 'pending', taskStatus: 'succeeded', status: 'ready', generationKind: 'refinement',
          generationSettings: { ...childSettings },
          generationRecipe: { prompt: '背景放在超市里', batchCount: 1, settings: { ...childSettings }, references: [] },
        },
      },
    ],
    edges: [
      { id: 'e-g1-r1', source: 'g1', target: 'r1', data: { system: true, role: 'output' } },
      { id: 'e-r1-g2', source: 'r1', target: 'g2' },
      { id: 'e-g2-pending', source: 'g2', target: 'pending', data: { system: true, role: 'output' } },
    ],
    generationJobs: [], updatedAt: 1,
  }
  const { document: reconciled, changed } = reconcileGenerationResults(document, [
    {
      id: 'job-1', status: 'succeeded', kind: 'refinement', batchCount: 1, createdAt: 1_000, updatedAt: 1_100,
      settings: parentSettings,
      generationRecipe: { prompt: '定向精修原始提示', batchCount: 1, settings: parentSettings, references: [] },
      generateNodeId: 'g1', resultNodeId: 'r1',
      outputs: [{ id: 'out-1', image: '/api/media/calbee' }],
    },
    {
      id: 'job-2', status: 'succeeded', kind: 'refinement', batchCount: 1, createdAt: 2_000, updatedAt: 2_100,
      settings: childSettings,
      generateNodeId: 'g2', resultNodeId: 'pending',
      outputs: [{ id: 'out-2', image: '/api/media/supermarket' }],
    },
  ])

  assert.equal(changed, true)
  const parent = reconciled.nodes.find((node) => node.id === 'r1')
  // 历史节点按 job-1 的提交参数回填：3:4·2K·GPT，血缘回到 g1，保留原图与原标题
  assert.equal(parent.data.image, '/api/media/calbee')
  assert.equal(parent.data.label, '定向精修')
  assert.deepEqual(parent.data.generationSettings, parentSettings)
  assert.equal(parent.data.generationRecipe.prompt, '定向精修原始提示')
  assert.equal(parent.data.outputOf, 'g1')
  assert.equal(parent.data.taskGroupId, 'r1')
  // 僵尸占位节点交还给 job-2，并在同一次对账里拿到自己的输出，参数保持 4:3·1K
  const pending = reconciled.nodes.find((node) => node.id === 'pending')
  assert.equal(pending.data.jobId, 'job-2')
  assert.equal(pending.data.image, '/api/media/supermarket')
  assert.equal(pending.data.generationSettings.aspectRatio, '4:3')
})

test('误标为无结果失败的历史节点仍可由权威任务结果纠正', () => {
  const document = {
    id: 'project-b', nodes: [
      { id: 'generate-b', type: 'generate', position: { x: 0, y: 0 }, data: { jobId: 'job-b', generationKind: 'generation' } },
      { id: 'result-b', type: 'result', position: { x: 400, y: 0 }, data: { outputOf: 'generate-b', taskGroupId: 'result-b', taskStatus: 'failed', status: 'failed', error: '图像服务没有返回结果，请重试。', generationKind: 'generation' } },
    ], edges: [], generationJobs: [], updatedAt: 1,
  }
  const { document: reconciled, changed } = reconcileGenerationResults(document, [{
    id: 'job-b', status: 'succeeded', kind: 'generation', batchCount: 1, createdAt: 1, updatedAt: 2,
    settings: { model: 'gpt-image-2' }, outputs: [{ id: 'output-b', image: '/api/media/b' }],
  }])

  assert.equal(changed, true)
  assert.equal(reconciled.nodes[1].data.image, '/api/media/b')
  assert.equal(reconciled.nodes[1].data.taskStatus, 'succeeded')
})

test('已有候选标识但图片为空时在原节点回填，不创建重复节点', () => {
  const document = {
    id: 'project-c', nodes: [
      { id: 'generate-c', type: 'generate', position: { x: 0, y: 0 }, data: { jobId: 'job-c', generationKind: 'refinement' } },
      {
        id: 'result-c',
        type: 'result',
        position: { x: 400, y: 0 },
        data: {
          outputOf: 'generate-c',
          taskGroupId: 'result-c',
          taskStatus: 'succeeded',
          status: 'ready',
          generationKind: 'refinement',
          jobId: 'job-c',
          candidateId: 'output-c',
        },
      },
    ], edges: [], generationJobs: [], updatedAt: 1,
  }
  const { document: reconciled, changed } = reconcileGenerationResults(document, [{
    id: 'job-c', status: 'succeeded', kind: 'refinement', batchCount: 1, createdAt: 1, updatedAt: 2,
    settings: { model: 'gpt-image-2' }, outputs: [{ id: 'output-c', image: '/api/media/c' }],
  }])

  assert.equal(changed, true)
  assert.equal(reconciled.nodes.length, 2)
  assert.equal(reconciled.nodes[1].id, 'result-c')
  assert.equal(reconciled.nodes[1].data.image, '/api/media/c')
})

test('浏览器断开后完成的 H3 任务会回填视频节点并保留供应商类型', () => {
  const document = {
    id: 'project-video', nodes: [
      { id: 'generate-video', type: 'generate', position: { x: 0, y: 0 }, data: { jobId: 'job-video', generationKind: 'generation' } },
      {
        id: 'result-video',
        type: 'result',
        position: { x: 400, y: 0 },
        data: {
          outputOf: 'generate-video',
          taskGroupId: 'result-video',
          taskStatus: 'failed',
          status: 'failed',
          error: '生成服务没有返回结果，请重试。',
          generationKind: 'generation',
        },
      },
    ], edges: [], generationJobs: [], updatedAt: 1,
  }
  const { document: reconciled, changed } = reconcileGenerationResults(document, [{
    id: 'job-video',
    status: 'succeeded',
    kind: 'generation',
    provider: 'minimax-video',
    batchCount: 1,
    createdAt: 1,
    updatedAt: 2,
    settings: { model: 'MiniMax-H3' },
    outputs: [{ id: 'video-output', image: '/api/media/video', mediaKind: 'video' }],
  }])

  assert.equal(changed, true)
  assert.equal(reconciled.nodes[1].data.image, '/api/media/video')
  assert.equal(reconciled.nodes[1].data.mediaKind, 'video')
  assert.equal(reconciled.generationJobs[0].provider, 'minimax-video')
})

test('Agent 完成回写缺失工作流时重建 prompt、生成节点及父图参考和输出连线', () => {
  const document = {
    id: 'project-agent-recovery',
    nodes: [
      { id: 'parent-result', type: 'result', position: { x: 0, y: 0 }, data: { kind: 'result', status: 'ready', image: '/parent.jpg' } },
      { id: 'asset-reference', type: 'asset', position: { x: 0, y: 360 }, data: { kind: 'asset', assetId: 'asset-a', image: '/reference.jpg' } },
    ],
    edges: [],
    generationJobs: [],
    updatedAt: 1,
  }
  const { document: reconciled, changed } = reconcileGenerationResults(document, [{
    id: 'job-agent',
    status: 'succeeded',
    kind: 'refinement',
    batchCount: 1,
    createdAt: 1,
    updatedAt: 2,
    settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' },
    outputs: [{ id: 'output-agent', image: '/api/media/agent' }],
    promptNodeId: 'prompt-agent',
    generateNodeId: 'generate-agent',
    resultNodeId: 'result-agent',
    parentNodeId: 'parent-result',
    agentRun: { runId: 'run-a', branchId: 'branch-a' },
    generationRecipe: {
      prompt: '只替换背景。',
      batchCount: 1,
      settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' },
      references: [{ nodeId: 'asset-reference', assetId: 'asset-a', image: '/reference.jpg', name: '参考图', role: '模特' }],
    },
    rawInput: { prompt: '只替换背景。' },
  }], { ensureAgentPlaceholders: true })

  assert.equal(changed, true)
  assert.ok(reconciled.nodes.some((node) => node.id === 'prompt-agent' && node.type === 'text'))
  assert.ok(reconciled.nodes.some((node) => node.id === 'generate-agent' && node.type === 'generate'))
  assert.ok(reconciled.nodes.some((node) => node.id === 'result-agent' && node.data.image === '/api/media/agent'))
  assert.deepEqual(new Set(reconciled.edges.map((edge) => edge.data?.role)), new Set(['prompt', 'parent', 'reference', 'output']))
  const generate = reconciled.nodes.find((node) => node.id === 'generate-agent')
  assert.equal(generate?.data.prompt, '')
})

test('落图时保留已有短标题，不用候选文案覆盖', () => {
  const document = {
    id: 'project-keep-title', nodes: [
      { id: 'generate-a', type: 'generate', position: { x: 0, y: 0 }, data: { jobId: 'job-a', generationKind: 'refinement', label: '换景调光', prompt: '' } },
      { id: 'result-a', type: 'result', position: { x: 400, y: 0 }, data: { outputOf: 'generate-a', taskGroupId: 'result-a', taskStatus: 'succeeded', status: 'ready', generationKind: 'refinement', label: '换景调光' } },
    ], edges: [], generationJobs: [], updatedAt: 1,
  }
  const { document: reconciled } = reconcileGenerationResults(document, [{
    id: 'job-a', status: 'succeeded', kind: 'refinement', batchCount: 1, createdAt: 1, updatedAt: 2,
    settings: { model: 'gpt-image-2' }, outputs: [{ id: 'output-a', image: '/api/media/a' }],
  }])
  assert.equal(reconciled.nodes[1].data.image, '/api/media/a')
  assert.equal(reconciled.nodes[1].data.label, '换景调光')
})

test('三支 Agent Job 依次 reconcile 时不覆盖兄弟结果图', () => {
  const document = {
    id: 'project-three-branches',
    nodes: [
      { id: 'parent', type: 'result', position: { x: 0, y: 0 }, data: { kind: 'result', status: 'ready', image: '/parent.jpg' } },
      { id: 'generate-sea', type: 'generate', position: { x: 400, y: 0 }, data: { jobId: 'job-sea', status: 'running' } },
      { id: 'result-sea', type: 'result', position: { x: 800, y: 0 }, data: { outputOf: 'generate-sea', jobId: 'job-sea', status: 'generating', taskStatus: 'running' } },
      { id: 'generate-desert', type: 'generate', position: { x: 400, y: 200 }, data: { jobId: 'job-desert', status: 'running' } },
      { id: 'result-desert', type: 'result', position: { x: 800, y: 200 }, data: { outputOf: 'generate-desert', jobId: 'job-desert', status: 'generating', taskStatus: 'running' } },
      { id: 'generate-space', type: 'generate', position: { x: 400, y: 400 }, data: { jobId: 'job-space', status: 'running' } },
      { id: 'result-space', type: 'result', position: { x: 800, y: 400 }, data: { outputOf: 'generate-space', jobId: 'job-space', status: 'generating', taskStatus: 'running' } },
    ],
    edges: [],
    generationJobs: [],
    updatedAt: 1,
  }
  const afterSea = reconcileGenerationResults(document, [{
    id: 'job-sea', status: 'succeeded', kind: 'generation', batchCount: 1, createdAt: 1, updatedAt: 2,
    settings: { model: 'gpt-image-2' }, outputs: [{ id: 'output-sea', image: '/api/media/sea' }],
    generateNodeId: 'generate-sea', resultNodeId: 'result-sea',
    agentRun: { runId: 'run-a', branchId: 'sea' },
  }])
  const afterDesert = reconcileGenerationResults(afterSea.document, [{
    id: 'job-desert', status: 'succeeded', kind: 'generation', batchCount: 1, createdAt: 3, updatedAt: 4,
    settings: { model: 'gpt-image-2' }, outputs: [{ id: 'output-desert', image: '/api/media/desert' }],
    generateNodeId: 'generate-desert', resultNodeId: 'result-desert',
    agentRun: { runId: 'run-a', branchId: 'desert' },
  }])
  const afterSpace = reconcileGenerationResults(afterDesert.document, [{
    id: 'job-space', status: 'succeeded', kind: 'generation', batchCount: 1, createdAt: 5, updatedAt: 6,
    settings: { model: 'gpt-image-2' }, outputs: [{ id: 'output-space', image: '/api/media/space' }],
    generateNodeId: 'generate-space', resultNodeId: 'result-space',
    agentRun: { runId: 'run-a', branchId: 'space' },
  }])

  const images = Object.fromEntries(afterSpace.document.nodes
    .filter((node) => node.type === 'result' && node.id !== 'parent')
    .map((node) => [node.id, node.data.image]))
  assert.deepEqual(images, {
    'result-sea': '/api/media/sea',
    'result-desert': '/api/media/desert',
    'result-space': '/api/media/space',
  })
  assert.equal(afterSpace.document.nodes.find((node) => node.id === 'parent')?.data.image, '/parent.jpg')
})
