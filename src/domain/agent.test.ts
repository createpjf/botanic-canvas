import assert from 'node:assert/strict'
import test from 'node:test'
import type { AssetGroup, CanvasNode, GenerationJob, GenerationRecipe } from './canvas.ts'
import {
  appendBotanicAgentMessage,
  collectBotanicAgentArtifacts,
  collectBotanicAgentResults,
  createBotanicAgentMemoryItem,
  buildBotanicAgentPlan,
  createBotanicAgentRun,
  createBotanicAgentSession,
  inferBotanicAgentIntent,
  insertBotanicAgentMention,
  mergeBotanicAgentRunSnapshot,
  upsertBotanicAgentRunSnapshot,
  readBotanicAgentMentionQuery,
  recordBotanicAgentCanvasWritebacks,
  replaceBotanicAgentSessionContext,
  resolveBotanicAgentResultSelection,
  resolveBotanicAgentCanvasCommands,
  updateBotanicAgentMessage,
  updateBotanicAgentAction,
  updateBotanicAgentRun,
  createBotanicAgentRuntimeSteps,
  updateBotanicAgentRuntimeStep,
  buildBotanicAgentPromptDiff,
} from './agent.ts'

const rootRecipe: GenerationRecipe = {
  primaryReferenceNodeId: 'asset-product',
  references: [
    { nodeId: 'asset-product', assetId: 'product', name: '德国队球衣', image: '/product', role: '商品', primary: true },
    { nodeId: 'asset-model', assetId: 'model', name: '模特 33', image: '/model', role: '模特' },
  ],
  prompt: '模特穿着德国队球衣，在公园踢球。',
  batchCount: 1,
  settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' },
}

const sceneGroup: AssetGroup = {
  id: 'group-scenes',
  name: '夏季场景',
  role: '场景',
  assetIds: ['scene-1', 'scene-2', 'scene-3'],
  createdAt: 1,
  updatedAt: 1,
}

test('Agent 运行记录按可验证的上下文来源生成步骤', () => {
  const steps = createBotanicAgentRuntimeSteps({
    hasTarget: true, referenceCount: 2, memoryCount: 1, assetGroupCount: 3, plannerLabel: 'DeepSeek V4',
  })
  assert.deepEqual(steps.map((step) => step.id), [
    'read-canvas', 'read-references', 'read-memory', 'search-assets', 'call-planner', 'finalize-plan',
  ])
  assert.equal(steps[1].detail, '2 个已连接参考')
  assert.equal(steps[4].detail, 'DeepSeek V4 · 生成执行计划')
})

test('Agent 运行记录按状态更新时间，不改变其他步骤', () => {
  const steps = createBotanicAgentRuntimeSteps({ hasTarget: false })
  const running = updateBotanicAgentRuntimeStep(steps, 'read-canvas', 'running', 100)
  assert.equal(running[0].status, 'running')
  assert.equal(running[0].startedAt, 100)
  const done = updateBotanicAgentRuntimeStep(running, 'read-canvas', 'succeeded', 120)
  assert.equal(done[0].completedAt, 120)
  assert.equal(done[1].status, 'pending')
})

test('Agent 提示词差异突出新增、删除与保留内容', () => {
  assert.deepEqual(buildBotanicAgentPromptDiff(
    '人物保持不变，替换为海边场景。',
    '人物保持不变，替换为日落海边场景，柔和暖光。',
  ), [
    { kind: 'same', text: '人物保持不变，替换为' },
    { kind: 'added', text: '日落' },
    { kind: 'same', text: '海边场景' },
    { kind: 'added', text: '，柔和暖光' },
    { kind: 'same', text: '。' },
  ])
})

test('相同提示词的差异结果保持为单一同文段', () => {
  assert.deepEqual(buildBotanicAgentPromptDiff('保持商品不变。', '保持商品不变。'), [
    { kind: 'same', text: '保持商品不变。' },
  ])
  assert.deepEqual(buildBotanicAgentPromptDiff('', ''), [])
})

test('Botanic Agent 能从自然语言识别高频生图意图', () => {
  assert.equal(inferBotanicAgentIntent('保持衣服不变，换十个海边场景'), 'replace_scene')
  assert.equal(inferBotanicAgentIntent('人物和背景不变，调整一下动作'), 'change_pose')
  assert.equal(inferBotanicAgentIntent('复用最初商品图重新做首图'), 'redo_from_root')
})

test('换场景计划锁定人物服装商品并按素材组逐项生成', () => {
  const plan = buildBotanicAgentPlan({
    instruction: '保持人物和球衣不变，换成夏季场景组里的场景',
    intent: 'replace_scene',
    selectedResultNodeId: 'result-v03',
    selectedResultLabel: '首图候选 01',
    rootRecipe,
    assetGroup: sceneGroup,
  })

  assert.equal(plan.intent, 'replace_scene')
  assert.deepEqual(plan.constraints, [
    { dimension: 'person', mode: 'preserve' },
    { dimension: 'garment', mode: 'preserve' },
    { dimension: 'product', mode: 'preserve' },
    { dimension: 'pose', mode: 'preserve' },
    { dimension: 'scene', mode: 'vary', sourceAssetGroupId: 'group-scenes' },
    { dimension: 'lighting', mode: 'vary' },
  ])
  assert.deepEqual(plan.output, { mode: 'batch_by_asset', count: 3, candidatesPerItem: 1 })
  assert.equal(plan.references.some((reference) => reference.source === 'root_recipe'), true)
  assert.match(plan.summary, /3 张/)
})

test('无素材组的换动作计划创建单次分支且继承根配方参数', () => {
  const plan = buildBotanicAgentPlan({
    instruction: '人物和球衣不变，让动作更有张力',
    intent: 'change_pose',
    selectedResultNodeId: 'result-v03',
    selectedResultLabel: '首图候选 01',
    rootRecipe,
  })

  assert.equal(plan.output.mode, 'single')
  assert.equal(plan.output.count, 1)
  assert.equal(plan.settings, rootRecipe.settings)
  assert.deepEqual(plan.constraints.find((item) => item.dimension === 'pose'), { dimension: 'pose', mode: 'vary' })
  assert.deepEqual(plan.constraints.find((item) => item.dimension === 'scene'), { dimension: 'scene', mode: 'preserve' })
})

test('Agent 不在缺少结果图上下文时伪造可执行计划', () => {
  assert.throws(() => buildBotanicAgentPlan({
    instruction: '换场景',
    intent: 'replace_scene',
    rootRecipe,
  }), /先选择一张已生成图片/)
})

test('AgentRun 保存待确认计划并通过显式状态转换追踪执行', () => {
  const plan = buildBotanicAgentPlan({
    instruction: '调整动作',
    intent: 'change_pose',
    selectedResultNodeId: 'result-v03',
    rootRecipe,
  })
  const run = createBotanicAgentRun(plan, { id: 'agent-run-1', now: 100 })
  assert.equal(run.status, 'awaiting_confirmation')
  assert.equal(run.createdAt, 100)
  assert.equal(run.plan.selectedResultNodeId, 'result-v03')

  assert.deepEqual(updateBotanicAgentRun(run, 'executing', 200), {
    ...run,
    status: 'executing',
    updatedAt: 200,
    error: undefined,
  })
})

test('服务端 Run 快照只更新进度，不覆盖浏览器中的完整可执行计划', () => {
  const plan = buildBotanicAgentPlan({
    instruction: '调整动作', intent: 'change_pose', selectedResultNodeId: 'result-v03', rootRecipe,
  })
  const local = createBotanicAgentRun(plan, { id: 'agent-run-1', now: 100 })
  const merged = mergeBotanicAgentRunSnapshot(local, {
    id: 'agent-run-1', projectId: 'project-a', status: 'partial', completedBranchCount: 1, failedBranchCount: 1,
    branches: [
      { id: 'branch-a', label: '海边', status: 'succeeded', attempt: 0, jobIds: ['job-a'], activeJobId: 'job-a', outputCount: 1, updatedAt: 200 },
      { id: 'branch-b', label: '公园', status: 'failed', attempt: 0, jobIds: ['job-b'], activeJobId: 'job-b', outputCount: 0, error: '失败', updatedAt: 210 },
    ],
    createdAt: 100, updatedAt: 210,
  })
  assert.equal(merged.plan, plan)
  assert.equal(merged.status, 'partial')
  assert.equal(merged.branches[1].error, '失败')
})

test('刷新后可用服务端权威快照恢复本地缺失的 Agent Run', () => {
  const plan = buildBotanicAgentPlan({
    instruction: '调整动作', intent: 'change_pose', selectedResultNodeId: 'result-v03', rootRecipe,
  })
  const snapshot = {
    id: 'agent-run-restored', projectId: 'project-a', status: 'running' as const,
    plan: (({ references: _references, rootRecipe: _rootRecipe, actions: _actions, ...safePlan }) => safePlan)(plan),
    completedBranchCount: 0, failedBranchCount: 0,
    branches: [{ id: 'branch-a', label: '动作 A', status: 'running' as const, attempt: 0, jobIds: ['job-a'], activeJobId: 'job-a', outputCount: 0, updatedAt: 210 }],
    createdAt: 100, updatedAt: 210,
  }
  const restored = upsertBotanicAgentRunSnapshot([], snapshot, rootRecipe)

  assert.equal(restored.length, 1)
  assert.equal(restored[0].id, snapshot.id)
  assert.equal(restored[0].status, 'running')
  assert.equal(restored[0].plan.rootRecipe, rootRecipe)
  assert.equal(restored[0].plan.selectedResultNodeId, 'result-v03')
})

test('Agent 会话保存执行模式、画布上下文与可恢复的消息时间线', () => {
  const session = createBotanicAgentSession({
    id: 'agent-session-1',
    now: 100,
    executionMode: 'manual',
    contextNodeIds: ['asset-product', 'result-v03', 'asset-product'],
  })

  assert.equal(session.title, '新建对话')
  assert.equal(session.executionMode, 'manual')
  assert.deepEqual(session.contextNodeIds, ['asset-product', 'result-v03'])

  const withUserMessage = appendBotanicAgentMessage(session, {
    id: 'message-1', role: 'user', kind: 'text', content: '保持商品不变，换成海边场景。', createdAt: 110,
  })
  assert.equal(withUserMessage.title, '保持商品不变，换成海边场景')
  assert.equal(withUserMessage.messages.length, 1)
  assert.equal(withUserMessage.updatedAt, 110)

  const withContext = replaceBotanicAgentSessionContext(withUserMessage, ['asset-scene'], 120)
  assert.deepEqual(withContext.contextNodeIds, ['asset-scene'])
  assert.equal(withContext.updatedAt, 120)

  const submitted = updateBotanicAgentMessage(withContext, 'message-1', { status: 'submitted', runId: 'run-1' }, 130)
  assert.equal(submitted.messages[0].status, 'submitted')
  assert.equal(submitted.messages[0].runId, 'run-1')
  assert.equal(submitted.updatedAt, 130)

  const rated = updateBotanicAgentMessage(submitted, 'message-1', { feedback: 'positive' }, 140)
  assert.equal(rated.messages[0].feedback, 'positive')
  assert.equal(rated.updatedAt, 140)
})

test('Agent 追问卡可持久化答案状态，润色后的计划也可回填到同一消息', () => {
  const question = {
    id: 'clarification-1',
    question: '请确认输出设置。',
    originalInstruction: '换成海边场景。',
    fields: [{
      id: 'aspect_ratio' as const, label: '画面比例', required: true, defaultValue: '3:4',
      options: [{ value: '3:4', label: '3:4' }, { value: '16:9', label: '16:9' }],
    }],
  }
  const session = appendBotanicAgentMessage(createBotanicAgentSession({ id: 'session-question', now: 100 }), {
    id: 'question-1', role: 'assistant', kind: 'question', content: question.question,
    question, status: 'pending', createdAt: 110,
  })
  const answered = updateBotanicAgentMessage(session, 'question-1', { status: 'answered' }, 120)
  assert.equal(answered.messages[0].question?.fields[0].options[1].value, '16:9')
  assert.equal(answered.messages[0].status, 'answered')

  const plan = buildBotanicAgentPlan({
    instruction: '换成海边场景。', intent: 'replace_scene', selectedResultNodeId: 'result-v03', rootRecipe,
  })
  const withPlan = appendBotanicAgentMessage(answered, {
    id: 'plan-1', role: 'assistant', kind: 'plan', content: plan.summary, plan, status: 'pending', createdAt: 130,
  })
  const polished = updateBotanicAgentMessage(withPlan, 'plan-1', { plan: { ...plan, prompt: '锁定人物与服装，替换为海边场景。' } }, 140)
  assert.equal(polished.messages.at(-1)?.plan?.prompt, '锁定人物与服装，替换为海边场景。')
})

test('Agent 行动卡状态可在对话计划内恢复，并记录画布回写节点', () => {
  const plan = {
    ...buildBotanicAgentPlan({
      instruction: '应用夏日场景规则', intent: 'replace_scene', selectedResultNodeId: 'result-v03', rootRecipe,
    }),
    actions: [{
      id: 'call-skill-1', kind: 'skill' as const, toolName: 'skill_apply' as const,
      label: '应用 Skill：夏日场景', summary: '锁定人物和服装。', risk: 'write' as const,
      arguments: { skillId: 'skill-summer' }, status: 'awaiting_confirmation' as const,
    }],
  }
  const session = appendBotanicAgentMessage(createBotanicAgentSession({ id: 'session-1', now: 100 }), {
    id: 'plan-message-1', role: 'assistant', kind: 'plan', content: plan.summary, plan, status: 'pending', createdAt: 110,
  })
  const running = updateBotanicAgentAction(session, 'plan-message-1', 'call-skill-1', { status: 'running' }, 120)
  assert.equal(running.messages[0].plan?.actions?.[0].status, 'running')

  const succeeded = updateBotanicAgentAction(running, 'plan-message-1', 'call-skill-1', {
    status: 'succeeded', result: { message: '已应用。', canvasNodeId: 'text-skill-1' },
  }, 130)
  assert.deepEqual(succeeded.messages[0].plan?.actions?.[0].result, {
    message: '已应用。', canvasNodeId: 'text-skill-1',
  })
  assert.equal(succeeded.updatedAt, 130)
})

test('Agent 只执行引用现有 Artifact 的安全画布命令，并兼容旧文字回写', () => {
  assert.deepEqual(resolveBotanicAgentCanvasCommands({
    message: '完成',
    artifacts: [
      { id: 'artifact-text', kind: 'text', label: '检索结果', content: '找到 3 个场景。', provenance: { actionId: 'action-1', toolName: 'mcp_call' } },
      { id: 'artifact-image', kind: 'image', label: '场景图', url: 'https://assets.example.com/scene.webp', provenance: { actionId: 'action-1', toolName: 'mcp_call' } },
    ],
    canvasCommands: [
      { id: 'command-text', type: 'create_text_node', artifactId: 'artifact-text' },
      { id: 'command-image', type: 'create_media_node', artifactId: 'artifact-image' },
      { id: 'command-unknown', type: 'create_media_node', artifactId: 'missing' },
    ],
  }).map((item) => item.command.id), ['command-text', 'command-image'])

  const legacy = resolveBotanicAgentCanvasCommands({
    message: '完成', writeback: { kind: 'text', label: '旧结果', content: '仍可写回。' },
  })
  assert.equal(legacy[0].artifact.kind, 'text')
  assert.equal(legacy[0].artifact.label, '旧结果')
  assert.equal(legacy[0].command.type, 'create_text_node')
})

test('Agent 行动产物回写画布后记录真实节点血缘', () => {
  const result = recordBotanicAgentCanvasWritebacks({
    message: '完成',
    artifacts: [
      { id: 'artifact-text', kind: 'text', label: '策略', content: '保持商品不变。', provenance: { actionId: 'action-1', toolName: 'skill_apply' } },
      { id: 'artifact-image', kind: 'image', label: '场景图', url: '/scene.webp', provenance: { actionId: 'action-1', toolName: 'mcp_call', sourceNodeIds: ['source-original'] } },
    ],
  }, [
    { artifactId: 'artifact-text', nodeId: 'text-agent-1' },
    { artifactId: 'artifact-image', nodeId: 'asset-agent-1' },
    { artifactId: 'artifact-image', nodeId: 'asset-agent-1' },
  ])

  assert.deepEqual(result.canvasNodeIds, ['text-agent-1', 'asset-agent-1'])
  assert.equal(result.canvasNodeId, 'text-agent-1')
  assert.deepEqual(result.artifacts?.[0].provenance.sourceNodeIds, ['text-agent-1'])
  assert.deepEqual(result.artifacts?.[1].provenance.sourceNodeIds, ['source-original', 'asset-agent-1'])
})

test('项目创作记忆保存类型、来源节点并去重', () => {
  assert.deepEqual(createBotanicAgentMemoryItem({
    id: 'memory-brand', now: 100, kind: 'rule',
    content: '瓶身标签、Logo 比例与主色不可改变。',
    sourceNodeIds: ['result-v03', 'result-v03', 'asset-product'],
  }), {
    id: 'memory-brand', kind: 'rule', content: '瓶身标签、Logo 比例与主色不可改变。',
    sourceNodeIds: ['result-v03', 'asset-product'], createdAt: 100, updatedAt: 100,
  })
})

test('Agent Composer 能识别光标前的 @ 查询并插入画布引用', () => {
  assert.deepEqual(readBotanicAgentMentionQuery('保持商品，换到 @夏日', 11), {
    start: 8, end: 11, query: '夏日',
  })
  assert.deepEqual(insertBotanicAgentMention('保持商品，换到 @夏日', {
    start: 8, end: 11, query: '夏日',
  }, '夏日窗台'), {
    value: '保持商品，换到 @夏日窗台 ', caret: 14,
  })
  assert.equal(readBotanicAgentMentionQuery('保持 @夏日 窗台', 10), undefined)
})

test('Agent 结果区按最新行动聚合 Artifact，避免重复展示', () => {
  const artifact = {
    id: 'artifact-scene', kind: 'image' as const, label: '海边场景',
    url: 'https://assets.example.com/scene.webp',
    provenance: { actionId: 'action-1', toolName: 'mcp_call' },
  }
  const first = appendBotanicAgentMessage(createBotanicAgentSession({ id: 'session-1', now: 100 }), {
    id: 'message-1', role: 'assistant', kind: 'plan', content: '找到场景', createdAt: 110,
    plan: {
      ...buildBotanicAgentPlan({ instruction: '换场景', intent: 'replace_scene', selectedResultNodeId: 'result-v03', rootRecipe }),
      actions: [{
        id: 'action-1', kind: 'mcp', toolName: 'mcp_call', label: '搜索场景', summary: '搜索',
        risk: 'external', arguments: {}, status: 'succeeded', result: { message: '完成', artifacts: [artifact] },
      }],
    },
  })
  const second = appendBotanicAgentMessage(createBotanicAgentSession({ id: 'session-2', now: 200 }), {
    id: 'message-2', role: 'assistant', kind: 'plan', content: '再次找到场景', createdAt: 210,
    plan: {
      ...first.messages[0].plan!,
      actions: [{ ...first.messages[0].plan!.actions![0], result: { message: '完成', artifacts: [{ ...artifact, label: '海边场景（新）' }] } }],
    },
  })
  assert.deepEqual(collectBotanicAgentArtifacts([first, second]).map((item) => item.label), ['海边场景（新）'])
})

test('Agent 结果区合并关联 Run 的生成结果并保留批次溯源', () => {
  const nodes = [{
    id: 'result-agent-1', type: 'result', position: { x: 0, y: 0 },
    data: {
      kind: 'result', status: 'ready', image: 'https://assets.example.com/output.webp',
      label: '海边候选 01', jobId: 'job-agent-1', candidateId: 'candidate-1',
      generationSettings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' },
    },
  }] as CanvasNode[]
  const generationJobs = [{
    id: 'job-agent-1', status: 'succeeded', kind: 'generation', createdAt: 100, updatedAt: 220,
    batchCount: 1, outputCount: 1, provider: 'openai', model: 'gpt-image-2',
    outputs: [{ id: 'candidate-1', image: 'https://assets.example.com/output.webp' }],
    agentRun: { runId: 'run-scene', branchId: 'branch-beach' },
  }] as GenerationJob[]

  const results = collectBotanicAgentResults({ sessions: [], nodes, generationJobs })

  assert.equal(results.length, 1)
  assert.deepEqual(results[0], {
    id: 'generation:job-agent-1:candidate-1', kind: 'image', label: '海边候选 01',
    url: 'https://assets.example.com/output.webp', mimeType: undefined,
    metadata: {
      source: 'generation', status: 'ready', createdAt: 220, jobId: 'job-agent-1',
      branchId: 'branch-beach', groupId: 'run-scene', savedToLibrary: false,
      settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' },
    },
    provenance: {
      actionId: 'generation:job-agent-1', toolName: 'image_generation', runId: 'run-scene',
      sourceNodeIds: ['result-agent-1'],
    },
  })
})

test('Agent 结果区不混入普通画布任务，并识别已入库结果', () => {
  const nodes = [
    { id: 'result-agent', type: 'result', position: { x: 0, y: 0 }, data: { kind: 'result', status: 'ready', image: '/agent.webp', label: 'Agent 结果', jobId: 'job-agent' } },
    { id: 'result-manual', type: 'result', position: { x: 0, y: 0 }, data: { kind: 'result', status: 'ready', image: '/manual.webp', label: '手动结果', jobId: 'job-manual' } },
  ] as CanvasNode[]
  const baseJob = { status: 'succeeded', kind: 'generation', createdAt: 100, updatedAt: 200, batchCount: 1, outputCount: 1, provider: 'openai', model: 'gpt-image-2' } as const
  const results = collectBotanicAgentResults({
    sessions: [], nodes,
    generationJobs: [
      { ...baseJob, id: 'job-agent', agentRun: { runId: 'run-1', branchId: 'branch-1' } },
      { ...baseJob, id: 'job-manual' },
    ] as GenerationJob[],
    assets: [{ id: 'asset-generated', role: '首图', name: 'Agent 结果', image: '/agent.webp', source: 'generated' }],
  })

  assert.deepEqual(results.map((item) => item.label), ['Agent 结果'])
  assert.equal(results[0].metadata?.savedToLibrary, true)
})

test('Agent 批量结果选择忽略失效项并去重画布引用', () => {
  const artifacts = [
    { id: 'image-a', kind: 'image' as const, label: '图 A', url: '/a.webp', provenance: { actionId: 'generation-a', toolName: 'image_generation', sourceNodeIds: ['result-a'] } },
    { id: 'image-b', kind: 'image' as const, label: '图 B', url: '/b.webp', provenance: { actionId: 'generation-b', toolName: 'image_generation', sourceNodeIds: ['result-a', 'result-b'] } },
    { id: 'text-c', kind: 'text' as const, label: '文字 C', content: '策略', provenance: { actionId: 'action-c', toolName: 'skill_apply', sourceNodeIds: ['text-c'] } },
  ]

  const selection = resolveBotanicAgentResultSelection(artifacts, ['image-b', 'missing', 'image-a'])

  assert.deepEqual(selection.artifacts.map((item) => item.id), ['image-b', 'image-a'])
  assert.deepEqual(selection.mediaArtifacts.map((item) => item.id), ['image-b', 'image-a'])
  assert.deepEqual(selection.sourceNodeIds, ['result-a', 'result-b'])
})
