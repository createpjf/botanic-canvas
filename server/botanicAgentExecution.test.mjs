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
