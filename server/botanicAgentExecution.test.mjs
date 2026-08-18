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
  assert.equal(result.document.nodes.filter((node) => node.type === 'result' && !node.data.image).length, 2)
  assert.equal(result.document.generationJobs.length, 2)
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

test('首次生成在创建工作流和 Job 前拒绝视频、文字和空结果上下文', () => {
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
    nodes: [],
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
  const result = reconciled.document.nodes.find((node) => node.id === job.resultNodeId)
  assert.equal(result?.data.image, '/api/media/media_recovered')
  assert.equal(reconciled.document.edges.some((edge) => edge.source === job.generateNodeId && edge.target === job.resultNodeId), true)
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
