import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyWorkflowItemResult,
  createProductionWorkflowVersion,
  createProductionWorkflowRun,
  generationArtifactId,
  productionWorkflowLineage,
  productionWorkflowVersionProvenance,
  resolveProductionWorkflowRecipe,
  resolveProductionWorkflowSource,
  retryFailedWorkflowItems,
  transitionProductionWorkflowRun,
} from './productionWorkflow.mjs'

test('生产工作流运行时从项目权威文档解析稳定媒体且拒绝临时图片', () => {
  const definition = {
    recipe: { references: [{ nodeId: 'asset-node', assetId: 'asset-a', name: '商品', role: '商品', primary: true }] },
  }
  assert.deepEqual(resolveProductionWorkflowRecipe(definition, {
    assets: [{ id: 'asset-a', image: '/api/media/media_product', mediaKind: 'image' }],
    nodes: [],
  }).references[0], {
    nodeId: 'asset-node', assetId: 'asset-a', name: '商品', role: '商品', primary: true,
    priority: 1, mediaKind: 'image', mediaId: 'media_product',
  })
  assert.throws(() => resolveProductionWorkflowRecipe(definition, {
    assets: [{ id: 'asset-a', image: 'blob:http://localhost/temporary' }],
    nodes: [],
  }), /缺少稳定媒体/)
})

const definition = {
  prompt: '保持商品与人物，只替换场景。',
  model: 'gpt-image-2',
  settings: { aspectRatio: '4:5', resolution: '2K', batchCount: 1 },
  output: { mediaKind: 'image', reviewRequired: true },
  brandRules: ['保持米白与植物绿', '不得改变商品包装'],
  assetGroupIds: ['group-brand', 'group-product'],
  confirmationPolicy: 'before-external-action',
}

const source = { canvasNodeId: 'generate-a', runId: 'run-a', branchId: 'branch-a', resultNodeIds: [], artifactIds: [] }

const sourceDocument = {
  nodes: [
    { id: 'generate-a', type: 'generate', data: { kind: 'generate' } },
    { id: 'asset-a', type: 'asset', data: { kind: 'asset' } },
    { id: 'result-a', type: 'result', data: { kind: 'result', jobId: 'job-a', candidateId: 'candidate-a', agentRun: { runId: 'run-a', branchId: 'branch-a' } } },
    { id: 'result-pending', type: 'result', data: { kind: 'result', agentRun: { runId: 'run-a', branchId: 'branch-a' } } },
  ],
  agentRuns: [{ id: 'run-a', status: 'completed', branches: [{ id: 'branch-a' }] }],
}

test('显式来源按项目权威文档解析，Artifact 标识只由服务端生成', () => {
  const resolved = resolveProductionWorkflowSource({
    canvasNodeId: 'generate-a', runId: 'run-a', branchId: 'branch-a', resultNodeIds: ['result-a'],
  }, sourceDocument)
  assert.deepEqual(resolved, {
    canvasNodeId: 'generate-a', runId: 'run-a', branchId: 'branch-a',
    resultNodeIds: ['result-a'], artifactIds: [generationArtifactId('job-a', 'candidate-a')],
  })
  // 纯文字来源没有引用也没有结果时同样可解析。
  assert.deepEqual(resolveProductionWorkflowSource({ canvasNodeId: 'generate-a', resultNodeIds: [] }, sourceDocument), {
    canvasNodeId: 'generate-a', resultNodeIds: [], artifactIds: [],
  })
})

test('来源缺失或实体不成立时拒绝发布，服务端不退到别的节点', () => {
  const cases = [
    [undefined, 'WORKFLOW_SOURCE_REQUIRED'],
    [{ canvasNodeId: 'ghost', resultNodeIds: [] }, 'WORKFLOW_SOURCE_NODE_NOT_FOUND'],
    [{ canvasNodeId: 'asset-a', resultNodeIds: [] }, 'WORKFLOW_SOURCE_NODE_INVALID'],
    [{ canvasNodeId: 'generate-a', branchId: 'branch-a', resultNodeIds: [] }, 'WORKFLOW_SOURCE_BRANCH_WITHOUT_RUN'],
    [{ canvasNodeId: 'generate-a', runId: 'ghost', resultNodeIds: [] }, 'WORKFLOW_SOURCE_RUN_NOT_FOUND'],
    [{ canvasNodeId: 'generate-a', runId: 'run-a', branchId: 'ghost', resultNodeIds: [] }, 'WORKFLOW_SOURCE_BRANCH_NOT_FOUND'],
    [{ canvasNodeId: 'generate-a', resultNodeIds: ['ghost'] }, 'WORKFLOW_SOURCE_RESULT_NOT_FOUND'],
    [{ canvasNodeId: 'generate-a', resultNodeIds: ['asset-a'] }, 'WORKFLOW_SOURCE_RESULT_NOT_FOUND'],
    [{ canvasNodeId: 'generate-a', resultNodeIds: ['result-pending'] }, 'WORKFLOW_SOURCE_RESULT_UNRESOLVED'],
    [{ canvasNodeId: 'generate-a', resultNodeIds: ['result-a', 'result-a'] }, 'WORKFLOW_SOURCE_RESULTS_INVALID'],
  ]
  for (const [input, code] of cases) {
    assert.throws(() => resolveProductionWorkflowSource(input, sourceDocument), (caught) => {
      assert.equal(caught.code, code, `来源 ${JSON.stringify(input)} 应返回 ${code}，实际 ${caught.code}`)
      return true
    })
  }
})

test('未完成的 Agent Run 不能作为发布来源', () => {
  const running = { ...sourceDocument, agentRuns: [{ id: 'run-a', status: 'running', branches: [] }] }
  assert.throws(
    () => resolveProductionWorkflowSource({ canvasNodeId: 'generate-a', runId: 'run-a', resultNodeIds: [] }, running),
    (caught) => caught.code === 'WORKFLOW_SOURCE_RUN_NOT_TERMINAL',
  )
})

test('缺少来源快照的历史版本按 legacy_unverified 读取，不伪造来源', () => {
  assert.equal(productionWorkflowVersionProvenance({ version: 1, definition }), 'legacy_unverified')
  assert.equal(productionWorkflowVersionProvenance({ version: 1, definition, source }), 'verified')
  assert.equal(productionWorkflowVersionProvenance(undefined), 'legacy_unverified')
  const published = createProductionWorkflowVersion({
    id: 'workflow-a', projectId: 'project-a', name: '来源可查', definition, source,
  }, { actorId: 'user-a', now: 100 })
  assert.equal(productionWorkflowVersionProvenance(published.versions[0]), 'verified')
  assert.deepEqual(published.versions[0].source, source)
})

test('发布必须携带来源，缺失时明确失败而不是写入无来源版本', () => {
  assert.throws(() => createProductionWorkflowVersion({
    id: 'workflow-a', projectId: 'project-a', name: '无来源', definition,
  }, { actorId: 'user-a', now: 100 }), (caught) => caught.code === 'WORKFLOW_SOURCE_REQUIRED')
})

test('工作流版本保存完整生产设置，升级不会改变旧版本', () => {
  const first = createProductionWorkflowVersion({
    id: 'workflow-a', projectId: 'project-a', name: '夏日场景', definition, source,
  }, { actorId: 'user-a', now: 100 })
  const second = createProductionWorkflowVersion({
    id: 'workflow-a', projectId: 'project-a', name: '夏日场景',
    definition: { ...definition, prompt: '替换为海边晨光。' },
    source: { ...source, canvasNodeId: 'generate-b' },
    previous: first,
  }, { actorId: 'user-a', now: 200 })

  assert.equal(first.currentVersion, 1)
  assert.equal(second.currentVersion, 2)
  assert.equal(second.versions[0].definition.prompt, definition.prompt)
  assert.equal(second.versions[1].definition.prompt, '替换为海边晨光。')
  assert.deepEqual(second.versions[1].definition.assetGroupIds, ['group-brand', 'group-product'])
  assert.equal(second.versions[1].definition.confirmationPolicy, 'before-external-action')
})

test('批量运行固定工作流版本，支持部分失败、失败项重试和刷新恢复', () => {
  const workflow = createProductionWorkflowVersion({
    id: 'workflow-a', projectId: 'project-a', name: '批量首图', definition, source,
  }, { actorId: 'user-a', now: 100 })
  const run = createProductionWorkflowRun({
    id: 'workflow-run-a', workflow, itemInputs: [
      { id: 'sku-a', variables: { product: '香水 A' } },
      { id: 'sku-b', variables: { product: '香水 B' } },
    ],
  }, { actorId: 'user-a', now: 200 })

  const running = transitionProductionWorkflowRun(run, 'start', { now: 210 })
  const oneDone = applyWorkflowItemResult(running, 'sku-a', {
    status: 'succeeded', jobId: 'job-a', artifactIds: ['artifact-a'], canvasNodeIds: ['result-a'],
  }, { now: 220 })
  const partial = applyWorkflowItemResult(oneDone, 'sku-b', {
    status: 'failed', jobId: 'job-b', error: { code: 'PROVIDER_TIMEOUT', message: '超时' },
  }, { now: 230 })
  const recovered = JSON.parse(JSON.stringify(partial))
  const retried = retryFailedWorkflowItems(recovered, { now: 240 })

  assert.equal(partial.status, 'partially_failed')
  assert.equal(partial.workflowVersion, 1)
  assert.equal(retried.status, 'running')
  assert.equal(retried.items[0].status, 'succeeded')
  assert.equal(retried.items[1].status, 'queued')
  assert.equal(retried.items[1].attempt, 2)
  assert.equal(retried.items[1].idempotencyKey, partial.items[1].idempotencyKey)
})

test('运行可暂停、恢复与取消，终态和历史版本不会被静默重写', () => {
  const workflow = createProductionWorkflowVersion({
    id: 'workflow-a', projectId: 'project-a', name: '批量首图', definition, source,
  }, { actorId: 'user-a', now: 100 })
  const run = createProductionWorkflowRun({ id: 'run-a', workflow, itemInputs: [{ id: 'sku-a' }] }, { actorId: 'user-a', now: 200 })
  const paused = transitionProductionWorkflowRun(transitionProductionWorkflowRun(run, 'start', { now: 210 }), 'pause', { now: 220 })
  const resumed = transitionProductionWorkflowRun(paused, 'resume', { now: 230 })
  const cancelled = transitionProductionWorkflowRun(resumed, 'cancel', { now: 240 })

  assert.equal(paused.status, 'paused')
  assert.equal(resumed.status, 'running')
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.workflowVersion, 1)
  assert.throws(() => transitionProductionWorkflowRun(cancelled, 'resume', { now: 250 }), /终态/)
})

test('开启质量门时全部生成完成后必须经过人工评审才能发布', () => {
  const workflow = createProductionWorkflowVersion({
    id: 'workflow-review', projectId: 'project-a', name: '需审核', definition, source,
  }, { actorId: 'user-a', now: 100 })
  const run = createProductionWorkflowRun({ id: 'run-review', workflow, itemInputs: [{ id: 'sku-a' }] }, { actorId: 'user-a', now: 200 })
  const awaiting = applyWorkflowItemResult(transitionProductionWorkflowRun(run, 'start', { now: 210 }), 'sku-a', { status: 'succeeded', jobId: 'job-a' }, { now: 220 })
  assert.equal(awaiting.status, 'awaiting_review')
  assert.equal(awaiting.qualityGate.status, 'pending')
  assert.equal(transitionProductionWorkflowRun(awaiting, 'approve-review', { now: 230 }).status, 'succeeded')
  assert.equal(transitionProductionWorkflowRun(awaiting, 'reject-review', { now: 240 }).status, 'failed')
})

test('工作流结果血缘关联版本、运行、任务、Artifact、画布节点与来源版本', () => {
  assert.deepEqual(productionWorkflowLineage({
    workflowId: 'workflow-a', workflowVersion: 3, runId: 'run-a', itemId: 'sku-a',
    jobId: 'job-a', artifactId: 'artifact-a', canvasNodeId: 'result-a', sourceVersionId: 'history-a',
  }), {
    workflowId: 'workflow-a', workflowVersion: 3, workflowRunId: 'run-a', workflowItemId: 'sku-a',
    generationJobId: 'job-a', artifactId: 'artifact-a', canvasNodeId: 'result-a', sourceVersionId: 'history-a',
  })
})
