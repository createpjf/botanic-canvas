import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyWorkflowItemResult,
  applyWorkflowNodeResult,
  advanceProductionWorkflowRun,
  createProductionWorkflowVersion,
  createProductionWorkflowRun,
  productionWorkflowLineage,
  recordWorkflowApprovalDecision,
  resolveProductionWorkflowRecipe,
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

test('工作流版本保存完整生产设置，升级不会改变旧版本', () => {
  const first = createProductionWorkflowVersion({
    id: 'workflow-a', projectId: 'project-a', name: '夏日场景', definition,
  }, { actorId: 'user-a', now: 100 })
  const second = createProductionWorkflowVersion({
    id: 'workflow-a', projectId: 'project-a', name: '夏日场景',
    definition: { ...definition, prompt: '替换为海边晨光。' },
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
    id: 'workflow-a', projectId: 'project-a', name: '批量首图', definition,
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
    id: 'workflow-a', projectId: 'project-a', name: '批量首图', definition,
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

test('工作流结果血缘关联版本、运行、任务、Artifact、画布节点与来源版本', () => {
  assert.deepEqual(productionWorkflowLineage({
    workflowId: 'workflow-a', workflowVersion: 3, runId: 'run-a', itemId: 'sku-a',
    jobId: 'job-a', artifactId: 'artifact-a', canvasNodeId: 'result-a', sourceVersionId: 'history-a',
  }), {
    workflowId: 'workflow-a', workflowVersion: 3, workflowRunId: 'run-a', workflowItemId: 'sku-a',
    generationJobId: 'job-a', artifactId: 'artifact-a', canvasNodeId: 'result-a', sourceVersionId: 'history-a',
  })
})

test('图节点在文案批准前阻断生成，QA 失败则交付不可运行', () => {
  const graphDefinition = {
    ...definition,
    graph: {
      nodes: [
        { id: 'copy', kind: 'content', dependencies: [] },
        { id: 'copy-approval', kind: 'approval', dependencies: ['copy'] },
        { id: 'poster', kind: 'generation', dependencies: ['copy-approval'] },
        { id: 'poster-qa', kind: 'validation', dependencies: ['poster'] },
        { id: 'delivery', kind: 'delivery', dependencies: ['poster-qa'] },
      ],
    },
  }
  const workflow = createProductionWorkflowVersion({
    id: 'workflow-g', projectId: 'project-a', name: 'Campaign Kit', definition: graphDefinition,
  }, { actorId: 'user-a', now: 100 })
  let run = createProductionWorkflowRun({
    id: 'run-g', workflow, itemInputs: [{ id: 'poster' }],
  }, { actorId: 'user-a', now: 200 })
  run = advanceProductionWorkflowRun(run, { now: 210, quality: { checks: [], blockingPassed: true } })
  const approval = run.items[0].nodeRuns.find((node) => node.kind === 'approval')
  const poster = run.items[0].nodeRuns.find((node) => node.nodeId === 'poster')
  assert.equal(approval.status, 'awaiting_approval')
  assert.equal(poster.status, 'blocked')

  run = recordWorkflowApprovalDecision(run, { nodeId: 'copy-approval', decision: 'approved' }, { actorId: 'user-a', now: 220 })
  assert.equal(run.items[0].nodeRuns.find((node) => node.nodeId === 'poster').status, 'queued')

  run = applyWorkflowNodeResult(run, 'poster', { status: 'succeeded', jobId: 'job-1', artifactIds: ['art-1'] }, {
    now: 230,
    quality: { checks: [{ id: 'x', label: '主张溯源', passed: false, severity: 'blocking', reason: '缺少主张' }], blockingPassed: false },
  })
  assert.equal(run.items[0].nodeRuns.find((node) => node.kind === 'validation').status, 'failed')
  assert.equal(run.items[0].nodeRuns.find((node) => node.kind === 'delivery').status, 'blocked')
})

test('文案驳回写入审批记录并取消未完成节点', () => {
  const graphDefinition = {
    ...definition,
    graph: {
      nodes: [
        { id: 'copy', kind: 'content', dependencies: [] },
        { id: 'copy-approval', kind: 'approval', dependencies: ['copy'] },
        { id: 'poster', kind: 'generation', dependencies: ['copy-approval'] },
      ],
    },
  }
  const workflow = createProductionWorkflowVersion({
    id: 'workflow-r', projectId: 'project-a', name: 'Campaign Kit', definition: graphDefinition,
  }, { actorId: 'user-a', now: 100 })
  let run = advanceProductionWorkflowRun(createProductionWorkflowRun({
    id: 'run-r', workflow, itemInputs: [{ id: 'poster' }],
  }, { actorId: 'user-a', now: 200 }), { now: 210 })
  run = recordWorkflowApprovalDecision(run, { nodeId: 'copy-approval', decision: 'rejected', comment: '禁用表达' }, { actorId: 'user-a', now: 220 })
  assert.equal(run.approvals[0].decision, 'rejected')
  assert.equal(run.items[0].nodeRuns.find((node) => node.kind === 'approval').status, 'failed')
  assert.equal(run.items[0].nodeRuns.find((node) => node.nodeId === 'poster').status, 'blocked')
  const cancelled = transitionProductionWorkflowRun(transitionProductionWorkflowRun(run, 'start', { now: 230 }), 'cancel', { now: 240 })
  assert.equal(cancelled.status, 'cancelled')
  assert.ok(cancelled.items[0].nodeRuns.every((node) => ['succeeded', 'failed', 'cancelled'].includes(node.status)))
})
