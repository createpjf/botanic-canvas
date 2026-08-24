import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareAgentRunExecution, reconcileAgentGenerationJobToProject } from './botanicAgentExecution.mjs'

const settings = { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' }
const models = [{ id: 'gpt-image-2', provider: 'openai', mediaKind: 'image', aspectRatios: ['3:4'], resolutions: ['2K'] }]

function projectDocument() {
  return {
    schemaVersion: 25, id: 'project-1', name: '测试项目',
    nodes: [{
      id: 'result-parent', type: 'result', position: { x: 100, y: 100 }, draggable: true,
      data: {
        kind: 'result', status: 'ready', image: '/api/media/media_parent', label: '首图 01',
        generationRecipe: {
          references: [{ nodeId: 'asset-product-node', assetId: 'asset-product', name: '球衣', image: '/api/media/media_product', role: '商品', primary: true, priority: 1 }],
          prompt: '原始首图', batchCount: 1, settings,
        },
      },
    }],
    edges: [],
    assets: [
      { id: 'asset-scene-a', name: '海边', role: '场景', image: '/api/media/media_scene_a', source: 'upload', tags: [] },
      { id: 'asset-scene-b', name: '森林', role: '场景', image: '/api/media/media_scene_b', source: 'upload', tags: [] },
    ],
    assetGroups: [{ id: 'group-scenes', name: '场景组', role: '场景', assetIds: ['asset-scene-a', 'asset-scene-b'] }],
    generationJobs: [], agentRuns: [], updatedAt: 1,
  }
}

function persistentRun() {
  return {
    id: 'agent-run-1', ownerId: 'user-1', projectId: 'project-1', status: 'queued',
    plan: {
      intent: 'replace_scene', instruction: '批量替换场景', summary: '生成两个场景分支',
      selectedResultNodeId: 'result-parent', prompt: '人物与服装不变，只替换场景。', settings,
      constraints: [{ dimension: 'scene', mode: 'vary', sourceAssetGroupId: 'group-scenes' }],
      output: { mode: 'batch_by_asset', count: 2, candidatesPerItem: 1 }, assetGroupId: 'group-scenes',
    },
    branches: [
      { id: 'branch-a', label: '海边', assetId: 'asset-scene-a', status: 'queued', attempt: 0, jobIds: [], outputCount: 0, updatedAt: 1 },
      { id: 'branch-b', label: '森林', assetId: 'asset-scene-b', status: 'queued', attempt: 0, jobIds: [], outputCount: 0, updatedAt: 1 },
    ],
    createdAt: 1, updatedAt: 1,
  }
}

function initialGenerationRun(contextSnapshot = [
  { nodeId: 'asset-product-node', label: '球衣', kind: '素材', mediaKind: 'image', role: '商品' },
]) {
  return {
    id: 'agent-run-initial', ownerId: 'user-1', projectId: 'project-1', status: 'queued',
    plan: {
      intent: 'initial_generation', instruction: '生成商品首图', summary: '生成两张商品首图',
      contextSnapshot, prompt: '以球衣为主体，生成棚拍商品首图。', settings,
      constraints: [{ dimension: 'style', mode: 'vary' }],
      output: { mode: 'single', count: 2, candidatesPerItem: 1 },
    },
    branches: [
      { id: 'branch-initial', label: '商品首图', status: 'queued', attempt: 0, jobIds: [], outputCount: 0, updatedAt: 1 },
    ],
    createdAt: 1, updatedAt: 1,
  }
}

function initialGenerationDocument() {
  const document = projectDocument()
  document.nodes.push(
    {
      id: 'asset-product-node', type: 'asset', position: { x: 40, y: 80 }, draggable: true,
      data: { kind: 'asset', assetId: 'asset-product', name: '球衣', image: '/api/media/media_product', role: '商品', source: 'upload', mediaKind: 'image', primary: true },
    },
    {
      id: 'asset-video-node', type: 'asset', position: { x: 40, y: 520 }, draggable: true,
      data: { kind: 'asset', assetId: 'asset-video', name: '视频', image: '/api/media/media_video', role: '场景', source: 'upload', mediaKind: 'video' },
    },
    { id: 'text-node', type: 'text', position: { x: 40, y: 920 }, draggable: true, data: { kind: 'text', text: '文字描述' } },
    { id: 'empty-result-node', type: 'result', position: { x: 40, y: 1320 }, draggable: true, data: { kind: 'result', label: '空结果', mediaKind: 'image' } },
  )
  return document
}

function prepare(document = projectDocument()) {
  return prepareAgentRunExecution({
    run: persistentRun(), document, now: 100,
    jobIdForBranch: (branch) => `job-${branch.id}`,
    models, maximumBatchCount: 8, maximumReferenceBytes: 8 * 1024 * 1024,
  })
}

test('服务端从持久化 Agent Run 创建独立工作流占位与可执行 Generation Jobs', () => {
  const result = prepare()
  assert.equal(result.jobs.length, 2)
  assert.deepEqual(result.jobs.map((job) => job.agentRun), [
    { runId: 'agent-run-1', branchId: 'branch-a' },
    { runId: 'agent-run-1', branchId: 'branch-b' },
  ])
  assert.equal(result.jobs[0].rawInput.parent.mediaId, 'media_parent')
  assert.equal(result.jobs[0].rawInput.recipe.references.at(-1).mediaId, 'media_scene_a')
  assert.equal(result.jobs[1].rawInput.recipe.references.at(-1).mediaId, 'media_scene_b')
  assert.equal(result.document.nodes.filter((node) => node.type === 'generate').length, 2)
  assert.equal(result.document.nodes.filter((node) => node.type === 'text' && node.data.content === persistentRun().plan.prompt).length, 2)
  assert.equal(result.document.nodes.filter((node) => node.type === 'result' && !node.data.image).length, 2)
  for (const [index, workflow] of result.workflows.entries()) {
    assert.equal(workflow.promptNode.type, 'text')
    assert.equal(workflow.promptNode.data.content, persistentRun().plan.prompt)
    assert.equal(workflow.generateNode.data.prompt, '')
    assert.deepEqual(workflow.generateNode.data.agentRun, { runId: 'agent-run-1', branchId: persistentRun().branches[index].id })
    assert.deepEqual(workflow.resultNode.data.agentRun, workflow.generateNode.data.agentRun)
    assert.equal(result.document.edges.some((edge) => edge.data?.role === 'prompt'
      && edge.source === workflow.promptNodeId
      && edge.target === workflow.generateNodeId), true)
    assert.equal(result.document.edges.some((edge) => edge.data?.role === 'output'
      && edge.source === workflow.generateNodeId
      && edge.target === workflow.resultNodeId), true)
  }
  assert.equal(result.document.generationJobs.length, 2)
  assert.equal(result.document.generationJobs[0].promptNodeId, result.workflows[0].promptNodeId)
  assert.equal(result.document.generationJobs[0].parentNodeId, 'result-parent')
  assert.equal(JSON.stringify(result).includes('data:image'), false)
})

test('同一个 Agent Run 再次执行时复用既有工作流和 Job', () => {
  const first = prepare()
  const second = prepare(first.document)
  assert.equal(second.document.nodes.length, first.document.nodes.length)
  assert.equal(second.document.edges.length, first.document.edges.length)
  assert.deepEqual(second.jobs.map((job) => job.id), ['job-branch-a', 'job-branch-b'])
})

test('单分支计划按总候选数提交，而不是误用每素材候选数', () => {
  const run = persistentRun()
  run.plan.output = { mode: 'single', count: 3, candidatesPerItem: 1 }
  run.branches = [run.branches[0]]
  const result = prepareAgentRunExecution({
    run, document: projectDocument(), now: 100,
    jobIdForBranch: (branch) => `job-${branch.id}`,
    models, maximumBatchCount: 8, maximumReferenceBytes: 8 * 1024 * 1024,
  })
  assert.equal(result.jobs[0].batchCount, 3)
})

test('画布文本节点去掉旁白，生成节点不复制 Prompt', () => {
  const run = persistentRun()
  run.plan.prompt = '说明一下来源：当前项目上下文里我没有读取到原图。'
  run.plan.instruction = '保持人物服装，换成海边自然光'
  run.branches = [run.branches[0]]
  const result = prepareAgentRunExecution({
    run, document: projectDocument(), now: 100,
    jobIdForBranch: (branch) => `job-${branch.id}`,
    models, maximumBatchCount: 8, maximumReferenceBytes: 8 * 1024 * 1024,
  })
  assert.equal(result.workflows[0].generateNode.data.prompt, '')
  assert.equal(result.workflows[0].promptNode.data.content, '保持人物服装，换成海边自然光')
  assert.match(result.jobs[0].rawInput.prompt, /执行契约/u)
  assert.match(result.jobs[0].rawInput.prompt, /保持人物服装，换成海边自然光/u)
  assert.match(result.jobs[0].rawInput.recipe.prompt, /保持人物服装，换成海边自然光/u)
  assert.match(result.jobs[0].rawInput.recipe.prompt, /执行契约/u)
  assert.equal(result.jobs[0].rawInput.recipe.promptForDisplay, undefined)
  assert.equal(result.jobs[0].generationRecipe.promptForDisplay, '保持人物服装，换成海边自然光')
  assert.match(result.jobs[0].generationRecipe.prompt, /执行契约/u)
})

test('首次生成从权威画布解析图片上下文并复用普通 Generation Job 链路', () => {
  const result = prepareAgentRunExecution({
    run: initialGenerationRun(), document: initialGenerationDocument(), now: 100,
    jobIdForBranch: (branch) => `job-${branch.id}`,
    models, maximumBatchCount: 8, maximumReferenceBytes: 8 * 1024 * 1024,
  })

  assert.equal(result.jobs.length, 1)
  assert.equal(result.jobs[0].kind, 'generation')
  assert.equal(result.jobs[0].batchCount, 2)
  assert.equal(result.jobs[0].rawInput.parent, undefined)
  assert.deepEqual(result.jobs[0].rawInput.recipe.references, [{
    name: '球衣', role: '商品', primary: true, priority: 1, mediaId: 'media_product',
  }])
  const workflow = result.workflows[0]
  assert.equal(workflow.resultNode.data.rootRecipe.references[0].nodeId, 'asset-product-node')
  assert.equal(result.document.edges.some((edge) => edge.source === 'asset-product-node' && edge.target === workflow.generateNodeId), true)
  assert.equal(result.document.edges.some((edge) => edge.data?.role === 'parent'), false)
})

test('首次图片生成没有参考图时仍创建纯文字 Generation Job', () => {
  const result = prepareAgentRunExecution({
    run: initialGenerationRun([]), document: initialGenerationDocument(), now: 100,
    jobIdForBranch: (branch) => `job-${branch.id}`,
    models, maximumBatchCount: 8, maximumReferenceBytes: 8 * 1024 * 1024,
  })

  assert.equal(result.jobs.length, 1)
  assert.deepEqual(result.jobs[0].rawInput.recipe.references, [])
  assert.equal(result.jobs[0].rawInput.parent, undefined)
  assert.equal(result.document.edges.some((edge) => edge.data?.role === 'reference'), false)
})

test('首次生成忽略同一上下文中的文字和视频，只解析声明为图片的节点', () => {
  const result = prepareAgentRunExecution({
    run: initialGenerationRun([
      { nodeId: 'asset-product-node', label: '球衣', kind: '素材', mediaKind: 'image', role: '商品' },
      { nodeId: 'asset-video-node', label: '视频', kind: '素材', mediaKind: 'video' },
      { nodeId: 'text-node', label: '文字', kind: '文字' },
    ]),
    document: initialGenerationDocument(), now: 100,
    jobIdForBranch: (branch) => `job-${branch.id}`,
    models, maximumBatchCount: 8, maximumReferenceBytes: 8 * 1024 * 1024,
  })

  assert.deepEqual(result.jobs[0].rawInput.recipe.references.map((reference) => reference.mediaId), ['media_product'])
})

test('首次生成在创建工作流和 Job 前拒绝声明错误的上下文节点', () => {
  const document = initialGenerationDocument()
  const invalidSnapshots = [
    [{ nodeId: 'asset-video-node', label: '视频', kind: '素材', mediaKind: 'image' }],
    [{ nodeId: 'text-node', label: '文字', kind: '节点', mediaKind: 'image' }],
    [{ nodeId: 'empty-result-node', label: '空结果', kind: '结果', mediaKind: 'image' }],
  ]

  for (const contextSnapshot of invalidSnapshots) {
    assert.throws(() => prepareAgentRunExecution({
      run: initialGenerationRun(contextSnapshot), document, now: 100,
      jobIdForBranch: (branch) => `job-${branch.id}`,
      models, maximumBatchCount: 8, maximumReferenceBytes: 8 * 1024 * 1024,
    }), /Agent 首次生成只支持已存入画布的图片素材或图片结果/)
  }
})

test('视频计划以第一张图片为首帧提交一条视频任务', () => {
  const videoModels = [
    ...models,
    { id: 'MiniMax-H3', provider: 'minimax', mediaKind: 'video', aspectRatios: ['16:9', '3:4', '9:16'], resolutions: ['2K'], durations: [5, 10, 15], defaultDuration: 5 },
  ]
  const run = initialGenerationRun([
    { nodeId: 'asset-product-node', label: '球衣', kind: '素材', mediaKind: 'image', role: '商品' },
    { nodeId: 'result-parent', label: '首图 01', kind: '结果', mediaKind: 'image' },
  ])
  run.plan.settings = { model: 'MiniMax-H3', aspectRatio: '3:4', resolution: '2K', duration: 10 }
  run.plan.output = { mode: 'single', count: 1, candidatesPerItem: 1 }
  run.plan.prompt = '以首图为起点，镜头缓慢推近，光线渐暖。'

  const result = prepareAgentRunExecution({
    run, document: initialGenerationDocument(), now: 100,
    jobIdForBranch: (branch) => `job-${branch.id}`,
    models: videoModels, maximumBatchCount: 8, maximumReferenceBytes: 8 * 1024 * 1024,
  })

  const job = result.jobs[0]
  assert.equal(job.provider, 'minimax-video')
  assert.equal(job.settings.duration, 10)
  assert.equal(job.batchCount, 1)
  // 只保留第一张图片作首帧，且显式声明角色；多余参考会改变 Provider 的输入模式。
  assert.equal(job.rawInput.recipe.references.length, 1)
  assert.equal(job.rawInput.recipe.references[0].inputRole, 'first_frame')
  assert.equal(job.rawInput.recipe.references[0].mediaId, 'media_product')
  // 持久化配方与提交输入一致，画布重试不会退回 first_last 模式。
  assert.equal(job.generationRecipe.videoInputMode, 'first_frame')
  assert.equal(job.generationRecipe.references.length, 1)
})

test('Worker 完成任务后把图片写回占位结果节点', () => {
  const prepared = prepare()
  const completed = {
    ...prepared.jobs[0], status: 'succeeded', updatedAt: 200,
    outputs: [{ id: 'output-a', image: '/api/media/media_output_a' }],
  }
  const reconciled = reconcileAgentGenerationJobToProject(prepared.document, completed, 210)
  assert.equal(reconciled.changed, true)
  const output = reconciled.document.nodes.find((node) => node.type === 'result' && node.data.jobId === completed.id)
  assert.equal(output.data.image, '/api/media/media_output_a')
  assert.equal(output.data.taskStatus, 'succeeded')
})

test('部分结果已落盘时继续补齐缺失候选，不重复覆盖已有图片', () => {
  const run = persistentRun()
  run.plan.output = { mode: 'single', count: 2, candidatesPerItem: 1 }
  run.branches = [run.branches[0]]
  const prepared = prepareAgentRunExecution({
    run, document: projectDocument(), now: 100,
    jobIdForBranch: (branch) => `job-${branch.id}`,
    models, maximumBatchCount: 8, maximumReferenceBytes: 8 * 1024 * 1024,
  })
  const workflow = prepared.workflows[0]
  const existing = prepared.document.nodes.find((node) => node.id === workflow.resultNodeId)
  existing.data = {
    ...existing.data,
    status: 'ready', taskStatus: 'succeeded', image: '/api/media/media-existing', candidateId: 'output-a',
  }
  const completed = {
    ...prepared.jobs[0], status: 'succeeded', updatedAt: 200,
    outputs: [
      { id: 'output-a', image: '/api/media/media-existing' },
      { id: 'output-b', image: '/api/media/media-missing' },
    ],
  }

  const reconciled = reconcileAgentGenerationJobToProject(prepared.document, completed, 210)
  const outputs = reconciled.document.nodes.filter((node) => node.type === 'result' && node.data.jobId === completed.id && node.data.image)

  assert.equal(reconciled.complete, true)
  assert.equal(outputs.length, 2)
  assert.deepEqual(outputs.map((node) => node.data.candidateId).sort(), ['output-a', 'output-b'])
  assert.equal(reconciled.document.nodes.some((node) => node.type === 'result' && node.data.jobId === completed.id && !node.data.image), false)
})

test('画布缺少 Agent 占位时按 Job 血缘补建生成与结果节点，并保留 Artifact 所需的 agentRun', () => {
  const document = {
    ...projectDocument(),
    nodes: [{
      id: 'result-parent', type: 'result', position: { x: 100, y: 100 }, draggable: true,
      data: { kind: 'result', status: 'ready', image: '/api/media/media_parent', label: '首图' },
    }],
    edges: [],
    generationJobs: [],
  }
  const job = {
    id: 'job-recovered-agent', ownerId: 'user-1', projectId: document.id,
    status: 'succeeded', kind: 'generation', refinementMode: 'faithful',
    createdAt: 100, updatedAt: 200, batchCount: 1,
    settings, provider: 'openai-images',
    generateNodeId: 'agent-generate-recovered', resultNodeId: 'agent-result-recovered',
    generationRecipe: {
      references: [{ nodeId: 'result-parent', name: '首图', image: '/api/media/media_parent', role: '首图', primary: true }],
      prompt: '生成新版本', batchCount: 1, settings,
    },
    outputs: [{ id: 'output-recovered', image: '/api/media/media_recovered' }],
    agentRun: { runId: 'agent-run-1', branchId: 'branch-a' },
  }

  const reconciled = reconcileAgentGenerationJobToProject(document, job, 210)

  assert.equal(reconciled.changed, true)
  assert.equal(reconciled.complete, true)
  assert.equal(reconciled.document.nodes.find((node) => node.id === job.generateNodeId)?.type, 'generate')
  const prompt = reconciled.document.nodes.find((node) => node.type === 'text' && node.data.content === job.generationRecipe.prompt)
  assert.equal(prompt?.id, 'agent-prompt-agent-run-1-branch-a')
  const result = reconciled.document.nodes.find((node) => node.id === job.resultNodeId)
  assert.equal(result?.data.image, '/api/media/media_recovered')
  assert.equal(reconciled.document.edges.some((edge) => edge.source === job.generateNodeId && edge.target === job.resultNodeId), true)
  assert.equal(reconciled.document.edges.some((edge) => edge.data?.role === 'prompt'
    && edge.source === prompt?.id
    && edge.target === job.generateNodeId), true)
  assert.equal(reconciled.document.edges.some((edge) => edge.data?.role === 'reference'
    && edge.source === 'result-parent'
    && edge.target === job.generateNodeId), true)
  assert.deepEqual(reconciled.document.generationJobs[0].agentRun, job.agentRun)
})

test('取消分支会同步关闭画布占位节点，不遗留永久生成态', () => {
  const prepared = prepare()
  const cancelled = { ...prepared.jobs[0], status: 'cancelled', updatedAt: 200 }
  const reconciled = reconcileAgentGenerationJobToProject(prepared.document, cancelled, 200)
  const resultNode = reconciled.document.nodes.find((node) => node.id === prepared.workflows[0].resultNodeId)
  const generateNode = reconciled.document.nodes.find((node) => node.id === prepared.workflows[0].generateNodeId)

  assert.equal(reconciled.changed, true)
  assert.equal(resultNode.data.status, 'ready')
  assert.equal(resultNode.data.taskStatus, 'cancelled')
  assert.equal(generateNode.data.status, 'cancelled')
})

test('参考连线按源节点类型选择输出端口，素材节点不会连到不存在的端口', () => {
  // 素材节点的输出端口是 asset-output，结果节点是 output。
  // 端口写错时 React Flow 不渲染这条边，参考图看起来就“没连上”。
  const initial = prepareAgentRunExecution({
    run: initialGenerationRun(), document: initialGenerationDocument(), now: 100,
    jobIdForBranch: (branch) => `job-${branch.id}`,
    models, maximumBatchCount: 8, maximumReferenceBytes: 8 * 1024 * 1024,
  })
  const referenceEdge = initial.document.edges.find((edge) => edge.data?.role === 'reference')
  assert.equal(referenceEdge.source, 'asset-product-node')
  assert.equal(referenceEdge.sourceHandle, 'asset-output')

  // 精修时父结果是 result 节点，仍然用 output。
  const refinement = prepare()
  const parentEdge = refinement.document.edges.find((edge) => edge.data?.role === 'parent')
  assert.equal(parentEdge.sourceHandle, 'output')

  // 每条参考边的端口都必须和它源节点的真实类型一致。
  const nodesById = new Map(initial.document.nodes.map((node) => [node.id, node]))
  for (const edge of initial.document.edges.filter((item) => item.data?.role === 'reference')) {
    const expected = nodesById.get(edge.source)?.type === 'asset' ? 'asset-output' : 'output'
    assert.equal(edge.sourceHandle, expected, `参考边 ${edge.id} 的输出端口与源节点类型不一致`)
  }
})

test('继续生成只带本轮指定的参考，不再沿用最初那次配方', () => {
  const document = projectDocument()
  document.nodes.push({
    id: 'asset-mood-node', type: 'asset', position: { x: 0, y: 600 }, draggable: true,
    data: { kind: 'asset', assetId: 'asset-mood', name: '氛围参考', image: '/api/media/media_mood', role: '调性', mediaKind: 'image' },
  })

  // 本轮用户只锁定了「氛围参考」；父结果的 rootRecipe 里那张商品图不应再被带上。
  const run = persistentRun()
  run.plan.output = { mode: 'single', count: 1, candidatesPerItem: 1 }
  delete run.plan.assetGroupId
  run.branches = [{ id: 'branch-single', label: '继续修改', status: 'queued', attempt: 0, jobIds: [], outputCount: 0, updatedAt: 1 }]
  run.plan.contextSnapshot = [
    { nodeId: 'asset-mood-node', label: '氛围参考', kind: '素材', mediaKind: 'image' },
    // 父结果本身通过 parent 传入，不重复进参考集。
    { nodeId: 'result-parent', label: '首图 01', kind: '结果', mediaKind: 'image' },
  ]

  const result = prepareAgentRunExecution({
    run, document, now: 100,
    jobIdForBranch: (branch) => `job-${branch.id}`,
    models, maximumBatchCount: 8, maximumReferenceBytes: 8 * 1024 * 1024,
  })

  const references = result.jobs[0].rawInput.recipe.references
  assert.deepEqual(references.map((reference) => reference.mediaId), ['media_mood'])
  // 上一轮结果仍然作为 parent 单独传入。
  assert.equal(result.jobs[0].rawInput.parent.mediaId, 'media_parent')

  // 本轮没有指定任何参考时，参考集为空，只靠上一轮结果继续改。
  const bare = persistentRun()
  bare.plan.output = { mode: 'single', count: 1, candidatesPerItem: 1 }
  delete bare.plan.assetGroupId
  bare.branches = [{ id: 'branch-bare', label: '继续修改', status: 'queued', attempt: 0, jobIds: [], outputCount: 0, updatedAt: 1 }]
  const bareResult = prepareAgentRunExecution({
    run: bare, document, now: 100,
    jobIdForBranch: (branch) => `job-${branch.id}`,
    models, maximumBatchCount: 8, maximumReferenceBytes: 8 * 1024 * 1024,
  })
  assert.deepEqual(bareResult.jobs[0].rawInput.recipe.references, [])
  assert.equal(bareResult.jobs[0].rawInput.parent.mediaId, 'media_parent')
})

test('「从原配方重做」仍然复用最初那次配方的参考', () => {
  const run = persistentRun()
  run.plan.intent = 'redo_from_root'
  run.plan.output = { mode: 'single', count: 1, candidatesPerItem: 1 }
  delete run.plan.assetGroupId
  run.branches = [{ id: 'branch-redo', label: '原配方重做', status: 'queued', attempt: 0, jobIds: [], outputCount: 0, updatedAt: 1 }]
  run.plan.contextSnapshot = []

  const result = prepareAgentRunExecution({
    run, document: projectDocument(), now: 100,
    jobIdForBranch: (branch) => `job-${branch.id}`,
    models, maximumBatchCount: 8, maximumReferenceBytes: 8 * 1024 * 1024,
  })

  assert.deepEqual(result.jobs[0].rawInput.recipe.references.map((item) => item.mediaId), ['media_product'])
  // 原配方重做是一次全新生成，没有 parent。
  assert.equal(result.jobs[0].rawInput.parent, undefined)
})

test('无素材变体分支把本支增量叠到共用画面 Prompt 上', () => {
  const run = persistentRun()
  run.plan.intent = 'batch_variation'
  run.plan.instruction = '白皙、自然两种肤色，多图'
  run.plan.prompt = '保持人物与白裙，棚拍柔光。'
  run.plan.output = { mode: 'batch_by_variation', count: 2, candidatesPerItem: 1 }
  delete run.plan.assetGroupId
  run.branches = [
    {
      id: 'branch-fair', label: '白皙', status: 'queued', attempt: 0, jobIds: [], outputCount: 0, updatedAt: 1,
      variation: { label: '白皙', promptDelta: '人物肤色为白皙，保持五官与身份不变。', values: [{ key: 'skin_tone', axisLabel: '肤色', valueLabel: '白皙' }] },
    },
    {
      id: 'branch-tan', label: '小麦', status: 'queued', attempt: 0, jobIds: [], outputCount: 0, updatedAt: 1,
      variation: { label: '小麦', promptDelta: '人物肤色为小麦，保持五官与身份不变。', values: [{ key: 'skin_tone', axisLabel: '肤色', valueLabel: '小麦' }] },
    },
  ]

  const result = prepareAgentRunExecution({
    run, document: projectDocument(), now: 100,
    jobIdForBranch: (branch) => `job-${branch.id}`,
    models, maximumBatchCount: 8, maximumReferenceBytes: 8 * 1024 * 1024,
  })

  assert.equal(result.jobs.length, 2)
  assert.match(result.jobs[0].rawInput.prompt, /执行契约/u)
  assert.match(result.jobs[0].rawInput.prompt, /人物肤色为白皙，保持五官与身份不变。/u)
  assert.match(result.jobs[1].rawInput.prompt, /人物肤色为小麦，保持五官与身份不变。/u)
  assert.equal(result.jobs[0].generationRecipe.promptForDisplay, '保持人物与白裙，棚拍柔光。\n\n人物肤色为白皙，保持五官与身份不变。')
  assert.equal(result.jobs[0].rawInput.parent.mediaId, 'media_parent')
})

test('首次生成把标识类参考排到人像之后，避免 logo 当底图', () => {
  const document = initialGenerationDocument()
  document.nodes.push({
    id: 'asset-logo-node', type: 'asset', position: { x: 40, y: 200 }, draggable: true,
    data: {
      kind: 'asset', assetId: 'asset-logo', name: 'logo-full 2',
      image: '/api/media/media_logo', role: '商品', source: 'upload', mediaKind: 'image',
    },
  })
  document.nodes.push({
    id: 'asset-portrait-node', type: 'asset', position: { x: 40, y: 360 }, draggable: true,
    data: {
      kind: 'asset', assetId: 'asset-portrait', name: '棚拍人像',
      image: '/api/media/media_portrait', role: '模特', source: 'upload', mediaKind: 'image',
    },
  })
  const run = initialGenerationRun([
    { nodeId: 'asset-logo-node', label: 'logo-full 2', kind: '素材', mediaKind: 'image', role: '商品' },
    { nodeId: 'asset-portrait-node', label: '棚拍人像', kind: '素材', mediaKind: 'image', role: '模特' },
  ])
  const result = prepareAgentRunExecution({
    run, document, now: 100,
    jobIdForBranch: (branch) => `job-${branch.id}`,
    models, maximumBatchCount: 8, maximumReferenceBytes: 8 * 1024 * 1024,
  })
  assert.deepEqual(
    result.jobs[0].rawInput.recipe.references.map((item) => item.mediaId),
    ['media_portrait', 'media_logo'],
  )
})

test('局部重绘计划只以父结果为基准图，选区随任务下发为 maskRegion', () => {
  const run = {
    ...persistentRun(),
    plan: {
      intent: 'region_edit', instruction: '只把右上角换成盛开花丛', summary: '局部重绘画面右上的区域。',
      selectedResultNodeId: 'result-parent', prompt: '盛开的白色山茶花丛，保持光线方向。', settings,
      constraints: [{ dimension: 'person', mode: 'preserve' }],
      output: { mode: 'single', count: 1, candidatesPerItem: 1 },
      region: { rect: { x: 0.6, y: 0, width: 0.4, height: 0.4 }, description: '画面右上的区域' },
    },
    branches: [{ id: 'branch-region', label: '局部重绘', status: 'queued', attempt: 0, jobIds: [], outputCount: 0, updatedAt: 1 }],
  }
  const result = prepareAgentRunExecution({
    run, document: projectDocument(), now: 100,
    jobIdForBranch: (branch) => `job-${branch.id}`,
    models, maximumBatchCount: 8, maximumReferenceBytes: 8 * 1024 * 1024,
  })
  assert.equal(result.jobs.length, 1)
  const job = result.jobs[0]
  assert.equal(job.kind, 'refinement')
  assert.deepEqual(job.rawInput.recipe.maskRegion, { x: 0.6, y: 0, width: 0.4, height: 0.4 })
  // 原配方只有球衣，不是标识，因此不补参考；基准图仍是 parent。
  assert.deepEqual(job.rawInput.recipe.references, [])
  assert.equal(job.rawInput.parent.mediaId, 'media_parent')
})

test('局部重绘在本轮 @ 标识或原配方含 logo 时把标识带进参考', () => {
  const document = projectDocument()
  document.nodes.push({
    id: 'asset-logo-node', type: 'asset', position: { x: 40, y: 200 }, draggable: true,
    data: {
      kind: 'asset', assetId: 'asset-logo', name: 'logo-full 2',
      image: '/api/media/media_logo', role: '商品', source: 'upload', mediaKind: 'image',
    },
  })
  const withMention = {
    ...persistentRun(),
    plan: {
      intent: 'region_edit', instruction: '勋章还原 logo', summary: '局部重绘勋章。',
      selectedResultNodeId: 'result-parent', prompt: '勋章图案严格还原文字标识。', settings,
      constraints: [{ dimension: 'person', mode: 'preserve' }],
      output: { mode: 'single', count: 1, candidatesPerItem: 1 },
      region: { rect: { x: 0.7, y: 0.3, width: 0.1, height: 0.1 } },
      contextSnapshot: [
        { nodeId: 'asset-logo-node', label: 'logo-full 2', kind: '素材', mediaKind: 'image' },
      ],
    },
    branches: [{ id: 'branch-region-logo', label: '局部重绘', status: 'queued', attempt: 0, jobIds: [], outputCount: 0, updatedAt: 1 }],
  }
  const mentioned = prepareAgentRunExecution({
    run: withMention, document, now: 100,
    jobIdForBranch: (branch) => `job-${branch.id}`,
    models, maximumBatchCount: 8, maximumReferenceBytes: 8 * 1024 * 1024,
  })
  assert.deepEqual(mentioned.jobs[0].rawInput.recipe.references.map((item) => item.mediaId), ['media_logo'])

  document.nodes[0].data.generationRecipe.references.push({
    nodeId: 'asset-logo-node', assetId: 'asset-logo', name: 'logo-full 2',
    image: '/api/media/media_logo', role: '商品', primary: false, priority: 2,
  })
  const inherited = {
    ...persistentRun(),
    plan: {
      intent: 'region_edit', instruction: '只改勋章', summary: '局部重绘勋章。',
      selectedResultNodeId: 'result-parent', prompt: '勋章图案严格还原文字标识。', settings,
      constraints: [{ dimension: 'person', mode: 'preserve' }],
      output: { mode: 'single', count: 1, candidatesPerItem: 1 },
      region: { rect: { x: 0.7, y: 0.3, width: 0.1, height: 0.1 } },
    },
    branches: [{ id: 'branch-region-inherit', label: '局部重绘', status: 'queued', attempt: 0, jobIds: [], outputCount: 0, updatedAt: 1 }],
  }
  const inheritedResult = prepareAgentRunExecution({
    run: inherited, document, now: 100,
    jobIdForBranch: (branch) => `job-${branch.id}`,
    models, maximumBatchCount: 8, maximumReferenceBytes: 8 * 1024 * 1024,
  })
  assert.deepEqual(inheritedResult.jobs[0].rawInput.recipe.references.map((item) => item.mediaId), ['media_logo'])
})

test('成套方案分支异构执行：图片条目按数量、视频条目切视频模型并走首帧', () => {
  const mixedModels = [
    ...models,
    { id: 'MiniMax-H3', provider: 'minimax', mediaKind: 'video', aspectRatios: ['3:4', '16:9'], resolutions: ['2K'], durations: [5, 10, 15], defaultDuration: 5 },
  ]
  const run = {
    ...persistentRun(),
    plan: {
      intent: 'initial_generation', instruction: '执行方案', summary: '成套生成 3 项。',
      contextSnapshot: [
        { nodeId: 'asset-product-node', label: '球衣', kind: '素材', mediaKind: 'image', role: '商品' },
      ],
      prompt: '主画面', settings,
      constraints: [],
      output: { mode: 'single', count: 3, candidatesPerItem: 1 },
      composition: {
        theme: '春季系列',
        items: [
          { index: 1, title: '主视觉', mediaKind: 'image', prompt: '主画面：盛开山茶花与球衣', count: 1 },
          { index: 2, title: '细节', mediaKind: 'image', prompt: '细节：面料与花瓣特写', count: 2 },
          { index: 3, title: '氛围视频', mediaKind: 'video', prompt: '镜头缓推花丛', count: 1, duration: 10 },
        ],
      },
    },
    branches: [
      { id: 'branch-1', label: '主视觉', item: { index: 1, title: '主视觉', mediaKind: 'image', prompt: '主画面：盛开山茶花与球衣', count: 1 }, status: 'queued', attempt: 0, jobIds: [], outputCount: 0, updatedAt: 1 },
      { id: 'branch-2', label: '细节', item: { index: 2, title: '细节', mediaKind: 'image', prompt: '细节：面料与花瓣特写', count: 2 }, status: 'queued', attempt: 0, jobIds: [], outputCount: 0, updatedAt: 1 },
      { id: 'branch-3', label: '氛围视频', item: { index: 3, title: '氛围视频', mediaKind: 'video', prompt: '镜头缓推花丛', count: 1, duration: 10 }, status: 'queued', attempt: 0, jobIds: [], outputCount: 0, updatedAt: 1 },
    ],
  }
  const result = prepareAgentRunExecution({
    run, document: initialGenerationDocument(), now: 100,
    jobIdForBranch: (branch) => `job-${branch.id}`,
    models: mixedModels, maximumBatchCount: 8, maximumReferenceBytes: 8 * 1024 * 1024,
  })

  assert.equal(result.jobs.length, 3)
  assert.deepEqual(result.jobs.map((job) => [job.rawInput.prompt, job.batchCount]), [
    ['主画面：盛开山茶花与球衣', 1],
    ['细节：面料与花瓣特写', 2],
    ['镜头缓推花丛', 1],
  ])
  const videoJob = result.jobs[2]
  assert.equal(videoJob.settings.model, 'MiniMax-H3')
  assert.equal(videoJob.settings.duration, 10)
  assert.equal(videoJob.settings.resolution, '2K')
  assert.equal(videoJob.rawInput.recipe.references[0].inputRole, 'first_frame')
  assert.equal(videoJob.provider, 'minimax-video')
  // 图片条目仍用计划设置。
  assert.equal(result.jobs[0].settings.model, 'gpt-image-2')
})
