import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyGenerationJobToAgentRun,
  cancelPersistentAgentRun,
  createPersistentAgentRun,
  prepareAgentBranchRetry,
  validateAgentRunCreation,
} from './botanicAgentRun.mjs'

const creation = {
  projectId: 'project-1',
  plan: {
    intent: 'replace_scene',
    instruction: '保持人物和服装，替换场景。',
    summary: '按场景组生成 2 张。',
    selectedResultNodeId: 'result-1',
    contextSnapshot: [
      { nodeId: 'asset-product', label: '商品图', kind: '素材', mediaKind: 'image', role: '商品' },
      { nodeId: 'result-1', label: '当前结果', kind: '结果', mediaKind: 'image' },
    ],
    prompt: '保持人物和服装，替换为海边场景。',
    settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' },
    constraints: [
      { dimension: 'person', mode: 'preserve' },
      { dimension: 'scene', mode: 'vary', sourceAssetGroupId: 'group-scenes' },
    ],
    output: { mode: 'batch_by_asset', count: 2, candidatesPerItem: 1 },
    assetGroupId: 'group-scenes',
    toolCalls: [{
      id: 'call-plan-1',
      name: 'generation_create_plan',
      label: '生成执行计划',
      risk: 'read',
      status: 'succeeded',
      requiresConfirmation: false,
    }],
  },
  branches: [
    { id: 'branch-a', label: '海边', assetId: 'asset-scene-a' },
    { id: 'branch-b', label: '森林', assetId: 'asset-scene-b' },
  ],
}

test('Agent Run 创建请求只持久化计划元数据与独立分支', () => {
  const input = validateAgentRunCreation(creation)
  const run = createPersistentAgentRun(input, { id: 'run-1', ownerId: 'user-1', now: 100 })

  assert.equal(run.status, 'queued')
  assert.equal(run.projectId, 'project-1')
  assert.deepEqual(run.branches.map(({ id, status, attempt }) => ({ id, status, attempt })), [
    { id: 'branch-a', status: 'queued', attempt: 0 },
    { id: 'branch-b', status: 'queued', attempt: 0 },
  ])
  assert.equal(JSON.stringify(run).includes('data:image'), false)
  assert.deepEqual(run.plan.toolCalls, creation.plan.toolCalls)
  assert.equal(run.plan.prompt, creation.plan.prompt)
  assert.deepEqual(run.plan.settings, creation.plan.settings)
  assert.deepEqual(run.plan.constraints, creation.plan.constraints)
  assert.deepEqual(run.plan.contextSnapshot, creation.plan.contextSnapshot)
  assert.equal(run.branches[0].assetId, 'asset-scene-a')
})

test('生成 Job 状态驱动 Agent Run 分支与整体进度', () => {
  let run = createPersistentAgentRun(validateAgentRunCreation(creation), { id: 'run-1', ownerId: 'user-1', now: 100 })
  run = applyGenerationJobToAgentRun(run, {
    id: 'job-a', status: 'running', agentRun: { runId: 'run-1', branchId: 'branch-a' }, updatedAt: 200,
  })
  assert.equal(run.status, 'running')
  assert.equal(run.branches[0].activeJobId, 'job-a')

  run = applyGenerationJobToAgentRun(run, {
    id: 'job-a', status: 'succeeded', agentRun: { runId: 'run-1', branchId: 'branch-a' }, outputs: [{ id: 'output-a' }], updatedAt: 300,
  })
  run = applyGenerationJobToAgentRun(run, {
    id: 'job-b', status: 'failed', agentRun: { runId: 'run-1', branchId: 'branch-b' }, error: '供应商失败', updatedAt: 310,
  })

  assert.equal(run.status, 'partial')
  assert.equal(run.completedBranchCount, 1)
  assert.equal(run.failedBranchCount, 1)
  assert.equal(run.branches[0].outputCount, 1)
  assert.equal(run.branches[1].error, '供应商失败')
})

test('只重试失败分支并保留历史 Job 追溯', () => {
  let run = createPersistentAgentRun(validateAgentRunCreation(creation), { id: 'run-1', ownerId: 'user-1', now: 100 })
  run = applyGenerationJobToAgentRun(run, {
    id: 'job-b-1', status: 'failed', agentRun: { runId: 'run-1', branchId: 'branch-b' }, error: '第一次失败', updatedAt: 200,
  })
  run = prepareAgentBranchRetry(run, 'branch-b', { jobId: 'job-b-2', now: 300 })

  assert.equal(run.status, 'queued')
  assert.equal(run.branches[0].attempt, 0)
  assert.equal(run.branches[1].attempt, 1)
  assert.deepEqual(run.branches[1].jobIds, ['job-b-1', 'job-b-2'])
  assert.equal(run.branches[1].activeJobId, 'job-b-2')
  assert.equal(run.branches[1].error, undefined)
  assert.throws(() => prepareAgentBranchRetry(run, 'branch-a', { jobId: 'job-a-2', now: 400 }), /只有失败或取消的分支/)
})

test('取消 Agent Run 只终止活动分支并保留已完成结果', () => {
  let run = createPersistentAgentRun(validateAgentRunCreation(creation), { id: 'run-1', ownerId: 'user-1', now: 100 })
  run = applyGenerationJobToAgentRun(run, {
    id: 'job-a', status: 'succeeded', agentRun: { runId: 'run-1', branchId: 'branch-a' }, outputs: [{ id: 'output-a' }], updatedAt: 200,
  })
  run = applyGenerationJobToAgentRun(run, {
    id: 'job-b', status: 'running', agentRun: { runId: 'run-1', branchId: 'branch-b' }, updatedAt: 210,
  })

  const cancelled = cancelPersistentAgentRun(run, { now: 300 })
  assert.equal(cancelled.status, 'partial')
  assert.equal(cancelled.branches[0].status, 'succeeded')
  assert.equal(cancelled.branches[1].status, 'cancelled')
  assert.equal(cancelled.updatedAt, 300)

  assert.deepEqual(cancelPersistentAgentRun(cancelled, { now: 400 }), cancelled)
})

test('Agent Run 拒绝图片数据与重复分支标识', () => {
  assert.throws(() => validateAgentRunCreation({
    ...creation,
    plan: { ...creation.plan, image: 'data:image/png;base64,abc' },
  }), /不能包含图片/)
  assert.throws(() => validateAgentRunCreation({
    ...creation,
    branches: [{ id: 'same', label: 'A' }, { id: 'same', label: 'B' }],
  }), /分支标识重复/)
  assert.throws(() => validateAgentRunCreation({
    ...creation,
    plan: {
      ...creation.plan,
      toolCalls: [{ ...creation.plan.toolCalls[0], status: 'invented' }],
    },
  }), /工具调用状态无效/)
  assert.throws(() => validateAgentRunCreation({
    ...creation,
    plan: {
      ...creation.plan,
      contextSnapshot: [{ nodeId: 'asset-1', label: '商品', kind: '未知' }],
    },
  }), /上下文类型无效/)
})
