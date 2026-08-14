import assert from 'node:assert/strict'
import test from 'node:test'
import type { CanvasDocument, ProductionWorkflowRun } from './canvas.ts'
import {
  attachCampaignKitGraph,
  isDeliveryNodeRunnable,
  marketingPlanRunId,
  marketingPlanWorkflowDraft,
  marketingPlanWorkflowId,
  marketingWorkflowRunItems,
  marketingWorkflowRunProjection,
  productionWorkflowDraftFromCanvas,
  resolveMarketingExecutionMode,
} from './productionWorkflows.ts'

const document = {
  schemaVersion: 25,
  id: 'project-a', name: '品牌项目', updatedAt: 1,
  viewport: { x: 0, y: 0, zoom: 1 },
  assets: [{ id: 'asset-a', name: '商品', role: '商品', image: '/api/media/media-a', source: 'upload', tags: [] }],
  assetGroups: [{ id: 'group-a', name: '商品组', role: '商品', assetIds: ['asset-a'], createdAt: 1, updatedAt: 1 }],
  templates: [], history: [], deliveries: [], generationJobs: [], batchVariationRuns: [], agentSessions: [],
  agentMemory: [{ id: 'memory-a', kind: 'rule', content: '保持植物学留白', sourceNodeIds: [], createdAt: 1, updatedAt: 1 }],
  agentRuns: [{
    id: 'run-a', status: 'completed', createdAt: 1, updatedAt: 2, completedBranchCount: 1, failedBranchCount: 0,
    branches: [], plan: {} as never,
  }],
  nodes: [
    { id: 'asset-node', type: 'asset', position: { x: 0, y: 0 }, data: { kind: 'asset', assetId: 'asset-a', role: '商品', name: '商品', image: '/api/media/media-a', source: 'upload' } },
    { id: 'generate-node', type: 'generate', position: { x: 300, y: 0 }, data: {
      kind: 'generate', label: '品牌首图', prompt: '生成植物学品牌首图', batchCount: 2,
      settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' },
      agentRun: { runId: 'run-a', branchId: 'branch-a' },
    } },
  ],
  edges: [{ id: 'edge-a', source: 'asset-node', target: 'generate-node' }],
} satisfies CanvasDocument

function graphRun(overrides: Partial<ProductionWorkflowRun> = {}): ProductionWorkflowRun {
  const definition = attachCampaignKitGraph({
    prompt: '夏日冰茶',
    model: 'gpt-image-2',
    settings: {},
    output: {},
    brandRules: ['保持包装'],
    assetGroupIds: [],
    confirmationPolicy: 'before-submit',
  })
  return {
    id: 'marketing-run-plan-a',
    workflowId: 'marketing-plan-plan-a',
    workflowVersion: 1,
    projectId: 'project-a',
    definition,
    status: 'running',
    items: [{
      id: 'poster',
      index: 0,
      input: { executionMode: 'fixture', copyText: '夏日冰茶', fixtureAssetIds: ['asset-a'] },
      status: 'queued',
      attempt: 1,
      idempotencyKey: 'workflow_test',
      updatedAt: 1,
      nodeRuns: definition.graph!.nodes.map((node) => ({
        nodeId: node.id,
        kind: node.kind,
        status: node.id === 'copy' ? 'succeeded' : node.id === 'copy-approval' ? 'awaiting_approval' : 'blocked',
        updatedAt: 1,
      })),
    }],
    approvals: [],
    validationReports: [],
    createdAt: 1,
    createdBy: 'user-a',
    updatedAt: 1,
    ...overrides,
  }
}

test('已验证 Agent 画布操作可提升为不包含媒体字节的版本化生产工作流定义', () => {
  const draft = productionWorkflowDraftFromCanvas(document)
  assert.ok(draft)
  assert.equal(draft.sourceAgentRunId, 'run-a')
  assert.equal(draft.definition.model, 'gpt-image-2')
  assert.deepEqual(draft.definition.assetGroupIds, ['group-a'])
  assert.deepEqual(draft.definition.brandRules, ['保持植物学留白'])
  assert.equal(draft.definition.settings.batchCount, 2)
  assert.doesNotMatch(JSON.stringify(draft.definition), /\/api\/media|base64/)
  assert.equal((draft.definition.recipe?.references as Array<{ assetId: string }>)[0].assetId, 'asset-a')
})

test('尚未完成的 Agent 操作不能静默保存为生产工作流', () => {
  const pending = structuredClone(document)
  pending.agentRuns[0].status = 'running'
  assert.equal(productionWorkflowDraftFromCanvas(pending), null)
})

test('营销 Plan 使用稳定工作流与运行标识，发布草稿不写入 Agent Memory', () => {
  assert.equal(marketingPlanWorkflowId('msg-a'), 'marketing-plan-msg-a')
  assert.equal(marketingPlanRunId('msg-a'), 'marketing-run-msg-a')
  const draft = marketingPlanWorkflowDraft({
    messageId: 'msg-a',
    plan: {
      prompt: '夏日冰茶海报',
      summary: '冰茶 Campaign',
      settings: { model: 'gpt-image-2', aspectRatio: '4:5', resolution: '2K' },
      output: { count: 1 },
    },
    document,
  })
  assert.equal(draft.definition.prompt, '夏日冰茶海报')
  assert.deepEqual(draft.definition.brandRules, ['保持植物学留白'])
  assert.equal(draft.definition.graph?.nodes.find((node) => node.kind === 'approval')?.id, 'copy-approval')
})

test('有稳定媒体时走 Provider，否则绑定项目概念样张走 Fixture', () => {
  assert.equal(resolveMarketingExecutionMode({
    recipe: { references: [{ mediaId: 'media_product' }] },
    fixtureAssets: [{ id: 'asset-a', image: '/api/media/media-a' }],
  }), 'provider')
  assert.equal(resolveMarketingExecutionMode({
    recipe: { references: [{ assetId: 'asset-a' }] },
    fixtureAssets: [{ id: 'asset-a', image: '/concept.webp' }],
  }), 'fixture')
  const items = marketingWorkflowRunItems({
    mode: 'fixture',
    copyText: '夏日冰茶',
    fixtureAssetIds: ['asset-a'],
  })
  assert.equal(items[0].id, 'poster')
  assert.equal(items[0].executionMode, 'fixture')
  assert.deepEqual(items[0].fixtureAssetIds, ['asset-a'])
})

test('投影渲染 NodeRun、审批记录与 QA 报告，而不只是阶段横幅', () => {
  const waiting = marketingWorkflowRunProjection(graphRun())
  assert.ok(waiting)
  assert.equal(waiting.status, 'waiting_copy')
  assert.equal(waiting.phase, 'copy-review')
  assert.equal(waiting.copyApproved, false)
  assert.equal(waiting.deliveryRunnable, false)
  assert.equal(waiting.nodeRuns.length, 8)
  assert.equal(waiting.approvals.length, 0)
  assert.equal(waiting.nodeStatuses['copy-approval'], 'awaiting_approval')

  const approved = graphRun({
    approvals: [{ id: 'approval-1', nodeId: 'copy-approval', decision: 'approved', actorId: 'user-a', createdAt: 2 }],
  })
  approved.items[0].nodeRuns = approved.items[0].nodeRuns!.map((node) => (
    node.nodeId === 'copy-approval' ? { ...node, status: 'succeeded', approvalDecisionId: 'approval-1' }
      : node.nodeId === 'poster' ? { ...node, status: 'queued' }
        : node
  ))
  const approvedView = marketingWorkflowRunProjection(approved)
  assert.equal(approvedView?.copyApproved, true)
  assert.equal(approvedView?.approvals[0].decision, 'approved')
  assert.equal(approvedView?.phase, 'poster')
  assert.equal(approvedView?.deliveryRunnable, false)

  const rejected = graphRun({
    status: 'failed',
    approvals: [{ id: 'approval-2', nodeId: 'copy-approval', decision: 'rejected', comment: '禁用表达', actorId: 'user-a', createdAt: 2 }],
  })
  rejected.items[0].nodeRuns = rejected.items[0].nodeRuns!.map((node) => (
    node.nodeId === 'copy-approval' ? { ...node, status: 'failed', approvalDecisionId: 'approval-2' } : node
  ))
  const rejectedView = marketingWorkflowRunProjection(rejected)
  assert.equal(rejectedView?.copyRejected, true)
  assert.equal(rejectedView?.approvals[0].decision, 'rejected')
  assert.equal(rejectedView?.deliveryRunnable, false)
  assert.equal(rejectedView?.phase, 'failed')
})

test('审批或 QA 未通过时交付节点不可运行', () => {
  const run = graphRun({
    validationReports: [{
      id: 'qa-1', itemId: 'poster', nodeId: 'poster-qa', scope: 'preflight', status: 'failed', createdAt: 3,
      checks: [{ id: 'copy-prohibited-claims', label: '禁用表达', passed: false, severity: 'blocking', reason: '命中禁用表达', locator: 'copy' }],
    }],
  })
  run.items[0].nodeRuns = run.items[0].nodeRuns!.map((node) => {
    if (node.kind === 'approval') return { ...node, status: 'succeeded' }
    if (node.nodeId === 'poster') return { ...node, status: 'succeeded' }
    if (node.kind === 'validation') return { ...node, status: 'failed', validationReportId: 'qa-1' }
    return node
  })
  const view = marketingWorkflowRunProjection(run)
  assert.equal(view?.validationPassed, false)
  assert.equal(view?.validationReports[0].status, 'failed')
  assert.equal(view?.deliveryRunnable, false)
  assert.equal(isDeliveryNodeRunnable(run), false)
})

test('审批与 QA 均通过后交付节点可运行', () => {
  const run = graphRun({
    status: 'running',
    approvals: [{ id: 'approval-1', nodeId: 'copy-approval', decision: 'approved', actorId: 'user-a', createdAt: 2 }],
    validationReports: [{
      id: 'qa-1', itemId: 'poster', nodeId: 'poster-qa', scope: 'preflight', status: 'passed', createdAt: 3,
      checks: [{ id: 'copy-prohibited-claims', label: '禁用表达', passed: true, severity: 'blocking', reason: '未命中禁用表达', locator: 'copy' }],
    }],
  })
  run.items[0].nodeRuns = run.items[0].nodeRuns!.map((node) => {
    if (node.kind === 'delivery') return { ...node, status: 'queued' }
    if (node.nodeId === 'copy-approval') return { ...node, status: 'succeeded', approvalDecisionId: 'approval-1' }
    if (node.nodeId === 'poster-qa') return { ...node, status: 'succeeded', validationReportId: 'qa-1' }
    return { ...node, status: 'succeeded' }
  })
  const view = marketingWorkflowRunProjection(run)
  assert.equal(view?.copyApproved, true)
  assert.equal(view?.validationPassed, true)
  assert.equal(view?.deliveryRunnable, true)
  assert.equal(isDeliveryNodeRunnable(run), true)
  assert.equal(view?.phase, 'delivery')
  assert.equal(view?.validationReports[0].status, 'passed')
})
