import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyGenerationJobToAgentRun,
  cancelPersistentAgentRun,
  createPersistentAgentRun,
  failUnsubmittedPersistentAgentRun,
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

test('首次图片生成允许纯文字，视频仍要求图片首帧', () => {
  const input = validateAgentRunCreation({
    ...creation,
    plan: {
      ...creation.plan,
      intent: 'initial_generation',
      selectedResultNodeId: undefined,
      constraints: [],
      contextSnapshot: [
        { nodeId: 'asset-product-node', label: '商品图', kind: '素材', mediaKind: 'image', role: '商品' },
      ],
    },
  })

  assert.equal(input.plan.intent, 'initial_generation')
  assert.equal(input.plan.selectedResultNodeId, undefined)
  assert.deepEqual(input.plan.constraints, [])
  assert.deepEqual(input.plan.contextSnapshot, [
    { nodeId: 'asset-product-node', label: '商品图', kind: '素材', mediaKind: 'image', role: '商品' },
  ])

  const direct = validateAgentRunCreation({
    ...creation,
    plan: {
      ...creation.plan,
      intent: 'initial_generation',
      selectedResultNodeId: undefined,
      constraints: [],
      contextSnapshot: [],
    },
  })
  assert.deepEqual(direct.plan.contextSnapshot, undefined)

  assert.throws(() => validateAgentRunCreation({
    ...creation,
    plan: {
      ...creation.plan,
      intent: 'initial_generation',
      selectedResultNodeId: undefined,
      settings: { ...creation.plan.settings, duration: 5 },
      contextSnapshot: [],
    },
  }), /视频首次生成需要至少一个图片素材或图片结果作为首帧/)
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

test('仅在尚未建立生成 Job 时收口确定性提交失败', () => {
  const queued = createPersistentAgentRun(validateAgentRunCreation(creation), { id: 'run-1', ownerId: 'user-1', now: 100 })
  const failed = failUnsubmittedPersistentAgentRun(queued, '父结果节点已不存在。', { now: 200 })

  assert.equal(failed.status, 'failed')
  assert.equal(failed.branches[0].status, 'failed')
  assert.equal(failed.branches[0].error, '父结果节点已不存在。')
  assert.equal(failed.updatedAt, 200)

  const withJob = applyGenerationJobToAgentRun(queued, {
    id: 'job-a', status: 'queued', agentRun: { runId: 'run-1', branchId: 'branch-a' }, updatedAt: 150,
  })
  assert.equal(failUnsubmittedPersistentAgentRun(withJob, '不应覆盖', { now: 300 }), withJob)
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

test('Agent 新图名按字计长，8 个含 emoji 的字可以通过校验', () => {
  const emojiTitle = '🌸'.repeat(8)
  assert.equal(Array.from(emojiTitle).length, 8)
  assert.ok(emojiTitle.length > 8)
  const input = validateAgentRunCreation({
    ...creation,
    plan: { ...creation.plan, title: emojiTitle },
  })
  assert.equal(input.plan.title, emojiTitle)
  assert.throws(() => validateAgentRunCreation({
    ...creation,
    plan: { ...creation.plan, title: `${emojiTitle}景` },
  }), /新图名过长/)
  assert.throws(() => validateAgentRunCreation({
    ...creation,
    plan: { ...creation.plan, title: '替换场景黄昏柔光场' },
  }), /新图名过长/)
})

test('首次生成按变体批量不要求父结果节点', () => {
  const input = validateAgentRunCreation({
    projectId: 'project-1',
    plan: {
      intent: 'initial_generation',
      instruction: '白皙、自然两种肤色，多图',
      summary: '按「肤色」生成 2 张。',
      prompt: '基于 Mia 氛围肖像，保持人物身份。',
      settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' },
      constraints: [
        { dimension: 'person', mode: 'preserve' },
        { dimension: 'style', mode: 'vary' },
      ],
      output: { mode: 'batch_by_variation', count: 2, candidatesPerItem: 1 },
      variation: {
        combine: false,
        axes: [{
          key: 'skin_tone',
          label: '肤色',
          values: [
            { label: '白皙', promptDelta: '人物肤色为白皙，保持五官与身份不变。' },
            { label: '自然', promptDelta: '人物肤色为自然，保持五官与身份不变。' },
          ],
        }],
      },
      contextSnapshot: [{ nodeId: 'asset-mia', label: 'Mia 氛围肖像', kind: '素材', mediaKind: 'image' }],
    },
    branches: [
      { id: 'branch-fair', label: '白皙' },
      { id: 'branch-natural', label: '自然' },
    ],
  })
  assert.equal(input.plan.intent, 'initial_generation')
  assert.equal(input.plan.selectedResultNodeId, undefined)
  assert.equal(input.plan.output.mode, 'batch_by_variation')
  assert.equal(input.plan.variation.axes[0].values.length, 2)

  assert.throws(() => validateAgentRunCreation({
    projectId: 'project-1',
    plan: {
      ...input.plan,
      intent: 'batch_variation',
    },
    branches: [
      { id: 'branch-fair', label: '白皙' },
      { id: 'branch-natural', label: '自然' },
    ],
  }), /父结果节点不能为空/)
})

test('按变体轴批量允许无素材分支，并持久化分支增量', () => {
  const input = validateAgentRunCreation({
    ...creation,
    plan: {
      ...creation.plan,
      intent: 'batch_variation',
      instruction: '白皙、自然、小麦、深棕四种肤色，多图',
      summary: '按「肤色」生成 4 张。',
      title: '肤色变体',
      assetGroupId: undefined,
      output: { mode: 'batch_by_variation', count: 2, candidatesPerItem: 1 },
      variation: {
        combine: false,
        axes: [{
          key: 'skin_tone',
          label: '肤色',
          values: [
            { label: '白皙', promptDelta: '人物肤色为白皙，保持五官与身份不变。' },
            { label: '小麦', promptDelta: '人物肤色为小麦，保持五官与身份不变。' },
          ],
        }],
      },
    },
    branches: [
      {
        id: 'branch-fair',
        label: '白皙',
        variation: {
          label: '白皙',
          promptDelta: '人物肤色为白皙，保持五官与身份不变。',
          values: [{ key: 'skin_tone', axisLabel: '肤色', valueLabel: '白皙' }],
        },
      },
      {
        id: 'branch-tan',
        label: '小麦',
        variation: {
          label: '小麦',
          promptDelta: '人物肤色为小麦，保持五官与身份不变。',
          values: [{ key: 'skin_tone', axisLabel: '肤色', valueLabel: '小麦' }],
        },
      },
    ],
  })

  assert.equal(input.plan.output.mode, 'batch_by_variation')
  assert.equal(input.plan.variation.axes[0].values.length, 2)
  assert.equal(input.branches[0].assetId, undefined)
  assert.match(input.branches[1].variation.promptDelta, /小麦/)
})

test('Agent Run 创建保留对齐后的自定义像素', () => {
  const input = validateAgentRunCreation({
    ...creation,
    plan: {
      ...creation.plan,
      settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '2K', outputWidth: 1920, outputHeight: 1080 },
    },
  })
  assert.equal(input.plan.settings.outputWidth, 1920)
  assert.equal(input.plan.settings.outputHeight, 1088)
  assert.equal(input.plan.settings.aspectRatio, '16:9')
})

test('局部重绘计划持久化归一化选区；缺选区或选区过小被拒', () => {
  const regionPlan = {
    ...creation,
    plan: {
      ...creation.plan,
      intent: 'region_edit',
      output: { mode: 'single', count: 1, candidatesPerItem: 1 },
      assetGroupId: undefined,
      region: { rect: { x: 0.6, y: -0.1, width: 0.5, height: 0.4 }, description: '画面右上的区域' },
    },
    branches: [{ id: 'branch-a', label: '局部重绘' }],
  }
  const input = validateAgentRunCreation(regionPlan)
  assert.deepEqual(input.plan.region, {
    rect: { x: 0.6, y: 0, width: 0.4, height: 0.4 },
    description: '画面右上的区域',
  })

  assert.throws(() => validateAgentRunCreation({
    ...regionPlan,
    plan: { ...regionPlan.plan, region: undefined },
  }), /局部重绘计划必须携带有效选区/)

  assert.throws(() => validateAgentRunCreation({
    ...regionPlan,
    plan: { ...regionPlan.plan, region: { rect: { x: 0.5, y: 0.5, width: 0.001, height: 0.5 } } },
  }), /选区无效或过小/)
})

test('成套方案随计划持久化，分支条目归一化（视频单条、数量夹取）', () => {
  const compositionCreation = {
    ...creation,
    plan: {
      ...creation.plan,
      intent: 'initial_generation',
      selectedResultNodeId: undefined,
      constraints: [],
      contextSnapshot: [
        { nodeId: 'asset-product', label: '商品图', kind: '素材', mediaKind: 'image', role: '商品' },
      ],
      output: { mode: 'single', count: 3, candidatesPerItem: 1 },
      assetGroupId: undefined,
      composition: {
        theme: '春季山茶花系列',
        items: [
          { title: '主视觉', mediaKind: 'image', prompt: '主画面', count: 99 },
          { title: '细节', mediaKind: 'image', prompt: '细节画面', count: 2 },
          { title: '氛围视频', mediaKind: 'video', prompt: '镜头缓推', count: 3, duration: 10 },
        ],
      },
    },
    branches: [
      { id: 'branch-1', label: '主视觉', item: { index: 1, title: '主视觉', mediaKind: 'image', prompt: '主画面', count: 99 } },
      { id: 'branch-2', label: '细节', item: { index: 2, title: '细节', mediaKind: 'image', prompt: '细节画面', count: 2 } },
      { id: 'branch-3', label: '氛围视频', item: { index: 3, title: '氛围视频', mediaKind: 'video', prompt: '镜头缓推', count: 3, duration: 10 } },
    ],
  }
  const input = validateAgentRunCreation(compositionCreation)
  assert.equal(input.plan.composition.items.length, 3)
  assert.equal(input.plan.composition.items[0].count, 4)
  assert.deepEqual(input.branches.map((branch) => [branch.item.mediaKind, branch.item.count]), [
    ['image', 4],
    ['image', 2],
    ['video', 1],
  ])
  assert.equal(input.branches[2].item.duration, 10)

  assert.throws(() => validateAgentRunCreation({
    ...compositionCreation,
    plan: { ...compositionCreation.plan, composition: { theme: '只有一项', items: [{ title: 'a', mediaKind: 'image', prompt: 'x' }] } },
  }), /至少要有 2 个条目/)
})

test('确认来源 Turn 随 Run 持久化，缺省表示没有回合确认过它', () => {
  const linked = createPersistentAgentRun(
    validateAgentRunCreation({ ...creation, turnId: 'turn_abc' }),
    { id: 'run-linked', ownerId: 'user-1', now: 100 },
  )
  assert.equal(linked.turnId, 'turn_abc')
  // 本地回退路径没有服务端回合：字段缺失是「没有回合」，不是丢了来源。
  const local = createPersistentAgentRun(validateAgentRunCreation(creation), { id: 'run-local', ownerId: 'user-1', now: 100 })
  assert.equal('turnId' in local, false)
  assert.throws(() => validateAgentRunCreation({ ...creation, turnId: '   ' }), /确认来源 Turn/u)
})
