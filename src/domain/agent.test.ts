import assert from 'node:assert/strict'
import test from 'node:test'
import type { AssetGroup, CanvasNode, GenerationJob, GenerationRecipe } from './canvas.ts'
import {
  appendBotanicAgentMessage,
  collectBotanicAgentArtifacts,
  collectBotanicAgentResults,
  createBotanicAgentMemoryItem,
  buildBotanicAgentPlan,
  botanicAgentContextSnapshotNodeIds,
  createBotanicAgentContextSnapshot,
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
  shouldRecoverAgentRunResults,
  shouldResumeQueuedAgentRunExecution,
  updateBotanicAgentRuntimeStep,
  restoreBotanicAgentRuntimeSteps,
  shouldRestoreBotanicAgentRuntimeSteps,
  botanicAgentArtifactPlacement,
  botanicAgentPromptWithContextNotes,
  botanicAgentContextNoteLimit,
  insertBotanicAgentToolCallSteps,
  insertBotanicAgentReasoningSteps,
  resolveBotanicAgentExecutionDecision,
  botanicAgentExecutionModeLabel,
  botanicAgentArtifactPrompt,
  botanicAgentArtifactModel,
  botanicAgentArtifactTimestamp,
  botanicAgentSubmissionKey,
  botanicAgentRunFeedback,
  botanicAgentBranchStatusLabel,
  summarizeBotanicAgentRuntime,
  buildBotanicAgentPromptDiff,
  mergeBotanicAgentArtifactIndex,
  resolveBotanicAgentWorkflowReferenceNodeIds,
  buildBotanicAgentRunTimeline,
  buildBotanicAgentSessionTimeline,
  filterBotanicAgentSessionTimeline,
  filterBotanicAgentRunTimeline,
  updateBotanicAgentSessionReadingAnchor,
  botanicAgentActionReceiptMessageId,
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

test('同一个 Agent 行动始终复用同一条成功回执消息标识', () => {
  const session = createBotanicAgentSession({ id: 'session-action-receipt', now: 1 })
  const messageId = botanicAgentActionReceiptMessageId('call-skill-controlled-edit')
  const receipt = {
    id: messageId,
    role: 'assistant' as const,
    kind: 'notice' as const,
    content: '已应用 Skill「受控局部编辑」。',
    createdAt: 2,
  }

  const once = appendBotanicAgentMessage(session, receipt)
  const twice = appendBotanicAgentMessage(once, { ...receipt, createdAt: 3 })

  assert.equal(twice.messages.length, 1)
  assert.equal(twice.messages[0].id, messageId)
})

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

test('Agent 任务时间线按远端更新时间排序并关联来源对话', () => {
  const runs = [{ id: 'run-old', status: 'completed', plan: { summary: '旧任务' }, branches: [], completedBranchCount: 0, failedBranchCount: 0, createdAt: 100, updatedAt: 200 }, { id: 'run-new', status: 'running', plan: { summary: '新任务' }, branches: [], completedBranchCount: 0, failedBranchCount: 0, createdAt: 300, updatedAt: 500 }] as unknown as import('./agent.ts').BotanicAgentRun[]
  const sessions = [{
    id: 'session-source', title: '海边系列', executionMode: 'manual', contextNodeIds: [], createdAt: 10, updatedAt: 600,
    messages: [{ id: 'message-run', role: 'assistant', kind: 'run', content: '已提交', runId: 'run-new', createdAt: 320 }],
  }] as import('./agent.ts').BotanicAgentSession[]

  const timeline = buildBotanicAgentRunTimeline(runs, sessions)

  assert.deepEqual(timeline.map((item) => item.run.id), ['run-new', 'run-old'])
  assert.deepEqual(timeline[0].source, { sessionId: 'session-source', sessionTitle: '海边系列', messageId: 'message-run' })
  assert.equal(timeline[1].source, undefined)
})

test('Agent 对话历史按消息真实更新时间排序并汇总关联任务', () => {
  const sessions = [{
    id: 'session-old', title: '旧会话', executionMode: 'manual', contextNodeIds: [], createdAt: 1, updatedAt: 10,
    messages: [{ id: 'message-old', role: 'user', kind: 'text', content: '较早的内容', createdAt: 10 }],
  }, {
    id: 'session-current', title: '海边系列', executionMode: 'manual', contextNodeIds: [], createdAt: 2, updatedAt: 20,
    messages: [
      { id: 'message-user', role: 'user', kind: 'text', content: '把背景换成海边', createdAt: 30, updatedAt: 80 },
      { id: 'message-run', role: 'assistant', kind: 'run', content: '任务已提交', runId: 'run-active', createdAt: 40 },
    ],
  }] as import('./agent.ts').BotanicAgentSession[]
  const runs = [
    { id: 'run-active', status: 'running', plan: { summary: '海边换景' }, branches: [], completedBranchCount: 0, failedBranchCount: 0, createdAt: 40, updatedAt: 70 },
    { id: 'run-orphan', status: 'completed', plan: { summary: '无来源任务' }, branches: [], completedBranchCount: 0, failedBranchCount: 0, createdAt: 50, updatedAt: 90 },
  ] as unknown as import('./agent.ts').BotanicAgentRun[]

  const timeline = buildBotanicAgentSessionTimeline(sessions, runs)

  assert.deepEqual(timeline.map((item) => item.session.id), ['session-current', 'session-old'])
  assert.equal(timeline[0].preview, '把背景换成海边')
  assert.equal(timeline[0].updatedAt, 80)
  assert.equal(timeline[0].runCount, 1)
  assert.equal(timeline[0].activeRunCount, 1)
  assert.equal(timeline[1].runCount, 0)
})

test('Agent 对话历史可按标题、消息和任务摘要搜索', () => {
  const sessions = [{
    id: 'session-seaside', title: '海边视觉', executionMode: 'manual', contextNodeIds: [], createdAt: 1, updatedAt: 20,
    messages: [{ id: 'message-user', role: 'user', kind: 'text', content: '把人物放到日落沙滩', createdAt: 20 }],
  }, {
    id: 'session-studio', title: '棚拍系列', executionMode: 'manual', contextNodeIds: [], createdAt: 2, updatedAt: 30,
    messages: [{ id: 'message-run', role: 'assistant', kind: 'run', content: '任务已提交', runId: 'run-studio', createdAt: 30 }],
  }] as import('./agent.ts').BotanicAgentSession[]
  const runs = [{
    id: 'run-studio', status: 'completed', plan: { summary: '暖色商品棚拍' }, branches: [], completedBranchCount: 1, failedBranchCount: 0, createdAt: 30, updatedAt: 40,
  }] as unknown as import('./agent.ts').BotanicAgentRun[]
  const timeline = buildBotanicAgentSessionTimeline(sessions, runs)

  assert.deepEqual(filterBotanicAgentSessionTimeline(timeline, '海边').map((item) => item.session.id), ['session-seaside'])
  assert.deepEqual(filterBotanicAgentSessionTimeline(timeline, '日落沙滩').map((item) => item.session.id), ['session-seaside'])
  assert.deepEqual(filterBotanicAgentSessionTimeline(timeline, '商品棚拍').map((item) => item.session.id), ['session-studio'])
  assert.equal(filterBotanicAgentSessionTimeline(timeline, '  '), timeline)
})

test('Agent 对话历史可筛选未读、新结果与需处理任务', () => {
  const timeline = [{
    session: { id: 'session-unread' }, unreadRunCount: 2, unreadResultCount: 0, attentionRunCount: 0, searchText: '海边',
  }, {
    session: { id: 'session-result' }, unreadRunCount: 1, unreadResultCount: 1, attentionRunCount: 0, searchText: '棚拍',
  }, {
    session: { id: 'session-attention' }, unreadRunCount: 0, unreadResultCount: 0, attentionRunCount: 1, searchText: '失败',
  }, {
    session: { id: 'session-read' }, unreadRunCount: 0, unreadResultCount: 0, attentionRunCount: 0, searchText: '完成',
  }] as unknown as ReturnType<typeof buildBotanicAgentSessionTimeline>

  assert.deepEqual(filterBotanicAgentSessionTimeline(timeline, '', 'unread').map((item) => item.session.id), ['session-unread', 'session-result'])
  assert.deepEqual(filterBotanicAgentSessionTimeline(timeline, '', 'results').map((item) => item.session.id), ['session-result'])
  assert.deepEqual(filterBotanicAgentSessionTimeline(timeline, '', 'attention').map((item) => item.session.id), ['session-attention'])
  assert.deepEqual(filterBotanicAgentSessionTimeline(timeline, '棚', 'unread').map((item) => item.session.id), ['session-result'])
})

test('Agent 对话历史按跨设备阅读时间汇总未读任务与新结果', () => {
  const sessions = [{
    id: 'session-read', title: '已读会话', executionMode: 'manual', contextNodeIds: [], readingAnchorMessageId: 'message-read', readingAnchorUpdatedAt: 100, createdAt: 1, updatedAt: 100,
    messages: [
      { id: 'message-read', role: 'user', kind: 'text', content: '开始', createdAt: 90 },
      { id: 'message-running', role: 'assistant', kind: 'run', content: '任务一', runId: 'run-running', createdAt: 95 },
      { id: 'message-result', role: 'assistant', kind: 'run', content: '任务二', runId: 'run-result', createdAt: 96 },
      { id: 'message-old', role: 'assistant', kind: 'run', content: '旧任务', runId: 'run-old', createdAt: 97 },
    ],
  }, {
    id: 'session-no-anchor', title: '未建立阅读基线', executionMode: 'manual', contextNodeIds: [], createdAt: 2, updatedAt: 80,
    messages: [{ id: 'message-no-anchor', role: 'assistant', kind: 'run', content: '历史任务', runId: 'run-no-anchor', createdAt: 80 }],
  }] as import('./agent.ts').BotanicAgentSession[]
  const runs = [
    { id: 'run-running', status: 'running', plan: { summary: '正在生成' }, branches: [], completedBranchCount: 0, failedBranchCount: 0, createdAt: 95, updatedAt: 130 },
    { id: 'run-result', status: 'completed', plan: { summary: '新结果' }, branches: [], completedBranchCount: 2, failedBranchCount: 0, createdAt: 96, updatedAt: 140 },
    { id: 'run-old', status: 'completed', plan: { summary: '旧结果' }, branches: [], completedBranchCount: 1, failedBranchCount: 0, createdAt: 97, updatedAt: 99 },
    { id: 'run-no-anchor', status: 'completed', plan: { summary: '历史结果' }, branches: [], completedBranchCount: 1, failedBranchCount: 0, createdAt: 80, updatedAt: 120 },
  ] as unknown as import('./agent.ts').BotanicAgentRun[]

  const timeline = buildBotanicAgentSessionTimeline(sessions, runs)
  const read = timeline.find((item) => item.session.id === 'session-read')!
  const noAnchor = timeline.find((item) => item.session.id === 'session-no-anchor')!

  assert.equal(read.unreadRunCount, 2)
  assert.equal(read.unreadResultCount, 1)
  assert.equal(noAnchor.unreadRunCount, 0)
  assert.equal(noAnchor.unreadResultCount, 0)
})

test('Agent 任务时间线按进行中、已完成和需处理筛选', () => {
  const timeline = buildBotanicAgentRunTimeline([
    { id: 'run-waiting', status: 'awaiting_confirmation', updatedAt: 70 },
    { id: 'run-running', status: 'running', updatedAt: 60 },
    { id: 'run-completed', status: 'completed', updatedAt: 50 },
    { id: 'run-partial', status: 'partial', updatedAt: 40 },
    { id: 'run-failed', status: 'failed', updatedAt: 30 },
    { id: 'run-cancelled', status: 'cancelled', updatedAt: 20 },
  ] as import('./agent.ts').BotanicAgentRun[], [])

  assert.deepEqual(filterBotanicAgentRunTimeline(timeline, 'active').map((item) => item.run.id), ['run-waiting', 'run-running'])
  assert.deepEqual(filterBotanicAgentRunTimeline(timeline, 'completed').map((item) => item.run.id), ['run-completed'])
  assert.deepEqual(filterBotanicAgentRunTimeline(timeline, 'attention').map((item) => item.run.id), ['run-partial', 'run-failed', 'run-cancelled'])
  assert.equal(filterBotanicAgentRunTimeline(timeline, 'all'), timeline)
})

test('Agent 阅读锚点只接受当前会话中存在的消息', () => {
  const session = {
    id: 'session-reading', title: '阅读恢复', executionMode: 'manual', contextNodeIds: [], createdAt: 10, updatedAt: 20,
    messages: [
      { id: 'message-a', role: 'user', kind: 'text', content: '第一条', createdAt: 11 },
      { id: 'message-b', role: 'assistant', kind: 'text', content: '第二条', createdAt: 12 },
    ],
  } as import('./agent.ts').BotanicAgentSession

  const updated = updateBotanicAgentSessionReadingAnchor(session, 'message-b', 100)
  assert.equal(updated.readingAnchorMessageId, 'message-b')
  assert.equal(updated.readingAnchorUpdatedAt, 100)
  assert.equal(updated.updatedAt, 100)
  assert.equal(updateBotanicAgentSessionReadingAnchor(updated, 'message-missing', 120), updated)
})

test('Agent 提交时锁定安全上下文快照，并可在恢复时过滤已删除节点', () => {
  const snapshot = createBotanicAgentContextSnapshot([
    { nodeId: 'asset-1', label: '商品图', kind: '素材', mediaKind: 'image', role: '商品' },
    { nodeId: 'result-1', label: '首图候选 01', kind: '结果', mediaKind: 'image' },
    { nodeId: 'asset-1', label: '重复商品图', kind: '素材' },
  ])
  assert.deepEqual(snapshot, [
    { nodeId: 'asset-1', label: '商品图', kind: '素材', mediaKind: 'image', role: '商品' },
    { nodeId: 'result-1', label: '首图候选 01', kind: '结果', mediaKind: 'image' },
  ])
  assert.deepEqual(botanicAgentContextSnapshotNodeIds(snapshot, ['result-1', 'asset-1']), ['asset-1', 'result-1'])
  assert.deepEqual(botanicAgentContextSnapshotNodeIds(snapshot, ['result-1']), ['result-1'])
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

test('Agent Run 只在新的完成态出现时触发结果恢复', () => {
  assert.equal(shouldRecoverAgentRunResults(undefined, { status: 'completed', updatedAt: 20 }), true)
  assert.equal(shouldRecoverAgentRunResults({ status: 'running', updatedAt: 10 }, { status: 'completed', updatedAt: 20 }), true)
  assert.equal(shouldRecoverAgentRunResults({ status: 'completed', updatedAt: 20 }, { status: 'completed', updatedAt: 20 }), false)
  assert.equal(shouldRecoverAgentRunResults({ status: 'completed', updatedAt: 20 }, { status: 'completed', updatedAt: 30 }), true)
  assert.equal(shouldRecoverAgentRunResults({ status: 'running', updatedAt: 10 }, { status: 'failed', updatedAt: 20 }), false)
})

test('Agent Run 只对已确认但未绑定任务的 queued 快照补执行', () => {
  const branch = {
    id: 'branch-a', label: '新场景', status: 'queued' as const, attempt: 0,
    jobIds: [], outputCount: 0, updatedAt: 100,
  }
  assert.equal(shouldResumeQueuedAgentRunExecution({ status: 'queued', branches: [branch] }), true)
  assert.equal(shouldResumeQueuedAgentRunExecution({
    status: 'queued', branches: [{ ...branch, activeJobId: 'job-a', jobIds: ['job-a'] }],
  }), false)
  assert.equal(shouldResumeQueuedAgentRunExecution({ status: 'running', branches: [branch] }), false)
  assert.equal(shouldResumeQueuedAgentRunExecution({ status: 'queued', branches: [] }), false)
})

test('对话与检索也展示可理解的运行阶段，而不是静默等待', () => {
  const steps = createBotanicAgentRuntimeSteps({ hasTarget: false, mode: 'research' })
  assert.deepEqual(steps.map((step) => step.id), ['read-canvas', 'call-planner', 'respond'])
  assert.equal(steps[1].detail, '检索项目资料并核对来源')
  assert.equal(steps[2].label, '整理检索结果')
})

test('刷新后从服务端 Run 恢复运行时间线，而不是伪造模型过程', () => {
  const steps = restoreBotanicAgentRuntimeSteps({
    run: { status: 'running' }, hasTarget: true, referenceCount: 1, plannerLabel: 'DeepSeek V4',
  })
  assert.equal(steps.at(-1)?.id, 'finalize-plan')
  assert.equal(steps.at(-1)?.status, 'running')
  assert.match(steps[0].detail, /已从服务端恢复/)

  const failed = restoreBotanicAgentRuntimeSteps({ run: { status: 'failed' }, hasTarget: true })
  assert.equal(failed.at(-1)?.status, 'failed')
  assert.match(failed.at(-1)?.detail ?? '', /失败原因|重试/)
})

test('Runtime 默认只呈现当前阶段与下一步，展开后仍保留完整进度', () => {
  const steps = createBotanicAgentRuntimeSteps({ hasTarget: true })
  const running = updateBotanicAgentRuntimeStep(steps, 'read-canvas', 'running', 100)
  const summary = summarizeBotanicAgentRuntime({ steps: running, phase: 'reading' })
  assert.equal(summary.label, '读取画布上下文')
  assert.equal(summary.nextAction, '等待读取完成')
  assert.equal(summary.totalCount, 3)
  assert.equal(summary.completedCount, 0)
  assert.equal(summary.progress, 0)

  const waiting = summarizeBotanicAgentRuntime({ steps: running, phase: 'waiting_confirmation' })
  assert.equal(waiting.label, '等待你确认计划')
  assert.match(waiting.detail, /确认后才会提交/)
  assert.equal(waiting.nextAction, '确认生成')

  const waitingReference = summarizeBotanicAgentRuntime({ steps: running, phase: 'waiting_reference' })
  assert.equal(waitingReference.label, '等待参考图片')
  assert.match(waitingReference.detail, /不会创建空节点/)
  assert.equal(waitingReference.nextAction, '添加参考图片')

  const draftReady = summarizeBotanicAgentRuntime({ steps: running, phase: 'draft_ready' })
  assert.equal(draftReady.label, '生成草稿已创建')
  assert.match(draftReady.detail, /尚未提交/)
  assert.equal(draftReady.nextAction, '检查并生成')
})

test('Agent 只为有效图片参考创建生成工作流，忽略文字、生成节点和视频', () => {
  const nodes = [
    { id: 'asset-image', type: 'asset', position: { x: 0, y: 0 }, data: { kind: 'asset', assetId: 'a', name: '商品图', image: '/a.png', role: '商品', source: 'upload', mediaKind: 'image' } },
    { id: 'asset-video', type: 'asset', position: { x: 0, y: 0 }, data: { kind: 'asset', assetId: 'v', name: '视频', image: '/v.mp4', role: '场景', source: 'upload', mediaKind: 'video' } },
    { id: 'result-image', type: 'result', position: { x: 0, y: 0 }, data: { kind: 'result', label: '候选', image: '/result.png', mediaKind: 'image' } },
    { id: 'result-empty', type: 'result', position: { x: 0, y: 0 }, data: { kind: 'result', label: '空候选', mediaKind: 'image' } },
    { id: 'text', type: 'text', position: { x: 0, y: 0 }, data: { kind: 'text', label: '说明', text: '说明' } },
    { id: 'generate', type: 'generate', position: { x: 0, y: 0 }, data: { kind: 'generate', label: '生成节点' } },
  ] as CanvasNode[]

  assert.deepEqual(resolveBotanicAgentWorkflowReferenceNodeIds(
    nodes,
    ['asset-image', 'asset-video', 'result-image', 'result-empty', 'text', 'generate', 'asset-image'],
  ), ['asset-image', 'result-image'])
  assert.deepEqual(resolveBotanicAgentWorkflowReferenceNodeIds(nodes, ['text', 'generate']), [])
})

test('Run 状态统一提供下一步反馈，并兼容超时错误', () => {
  assert.deepEqual(botanicAgentRunFeedback('queued'), {
    label: '排队中', detail: '已入队，等待生成。',
    action: 'view_task', actionLabel: '查看任务', tone: 'progress', terminal: false,
  })
  assert.equal(botanicAgentRunFeedback('running').label, '生成中')
  assert.equal(botanicAgentRunFeedback('running').detail, '正在生成，完成后回填画布。')
  assert.equal(botanicAgentRunFeedback('completed', 2).detail, '已回填画布 · 2 项')
  assert.equal(botanicAgentRunFeedback('completed', 1, undefined, { artifactCount: 1, canvasOutputCount: 0 }).detail, '结果已生成，正在回填画布。')
  assert.equal(botanicAgentRunFeedback('completed', 0).actionLabel, '查看任务')
  assert.equal(botanicAgentRunFeedback('partial', 1).actionLabel, '查看失败分支')
  assert.equal(botanicAgentRunFeedback('partial', 1).detail, '已回填 1 项，有分支失败。')
  assert.equal(botanicAgentRunFeedback('failed', 0, '工作区数据库响应超时').label, '响应超时')
  assert.equal(botanicAgentRunFeedback('cancelled', 1).detail, '已取消，保留 1 项结果。')
  assert.deepEqual([
    botanicAgentBranchStatusLabel('queued'),
    botanicAgentBranchStatusLabel('running'),
    botanicAgentBranchStatusLabel('succeeded'),
    botanicAgentBranchStatusLabel('failed'),
    botanicAgentBranchStatusLabel('cancelled'),
  ], ['排队中', '生成中', '已完成', '失败', '已取消'])
})

test('同一确认消息与计划生成稳定提交键，修改提示词后才产生新键', () => {
  const plan = buildBotanicAgentPlan({
    instruction: '调整动作', intent: 'change_pose', selectedResultNodeId: 'result-v03', rootRecipe,
  })
  const first = botanicAgentSubmissionKey('message-1', plan)
  assert.equal(first, botanicAgentSubmissionKey('message-1', plan))
  assert.notEqual(first, botanicAgentSubmissionKey('message-1', { ...plan, prompt: `${plan.prompt}，更自然。` }))
  assert.match(first, /^agent-plan-message-1-/)
})

test('首次生成计划只需有效图片上下文，不伪造父结果或根配方', () => {
  const plan = buildBotanicAgentPlan({
    instruction: '基于商品图生成一张海边广告图',
    intent: 'initial_generation',
    settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
    contextSnapshot: [
      { nodeId: 'asset-product', label: '商品图', kind: '素材', mediaKind: 'image', role: '商品' },
      { nodeId: 'result-reference', label: '氛围参考', kind: '结果', mediaKind: 'image' },
      { nodeId: 'asset-video', label: '视频参考', kind: '素材', mediaKind: 'video' },
    ],
  })

  assert.equal(plan.selectedResultNodeId, undefined)
  assert.equal(plan.rootRecipe, undefined)
  assert.deepEqual(plan.references, [
    { source: 'context_node', id: 'asset-product', label: '商品图', role: '商品' },
    { source: 'context_node', id: 'result-reference', label: '氛围参考' },
  ])
  assert.equal(plan.settings.model, 'gpt-image-2')
})

test('首次生成拒绝空上下文和仅视频上下文，其他意图仍要求父结果', () => {
  const settings = { model: 'gpt-image-2' as const, aspectRatio: '1:1' as const, resolution: '1K' as const }
  assert.throws(() => buildBotanicAgentPlan({
    instruction: '生成广告图', intent: 'initial_generation', settings, contextSnapshot: [],
  }), /图片素材或图片结果/)
  assert.throws(() => buildBotanicAgentPlan({
    instruction: '生成广告图', intent: 'initial_generation', settings,
    contextSnapshot: [{ nodeId: 'video-1', label: '视频', kind: '素材', mediaKind: 'video' }],
  }), /图片素材或图片结果/)
  assert.throws(() => buildBotanicAgentPlan({
    instruction: '换场景', intent: 'replace_scene', settings,
    contextSnapshot: [{ nodeId: 'asset-1', label: '图片', kind: '素材', mediaKind: 'image' }],
  }), /先选择一张已生成图片/)
})

test('首次生成提交键包含排序后的上下文节点，顺序不影响键但上下文变化会影响键', () => {
  const base = buildBotanicAgentPlan({
    instruction: '生成广告图', intent: 'initial_generation',
    settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
    contextSnapshot: [
      { nodeId: 'asset-b', label: 'B', kind: '素材', mediaKind: 'image' },
      { nodeId: 'asset-a', label: 'A', kind: '素材', mediaKind: 'image' },
    ],
  })
  const reordered = { ...base, contextSnapshot: [...(base.contextSnapshot ?? [])].reverse() }
  const changed = { ...base, contextSnapshot: [{ nodeId: 'asset-c', label: 'C', kind: '素材' as const, mediaKind: 'image' as const }] }

  assert.equal(botanicAgentSubmissionKey('message-initial', base), botanicAgentSubmissionKey('message-initial', reordered))
  assert.notEqual(botanicAgentSubmissionKey('message-initial', base), botanicAgentSubmissionKey('message-initial', changed))
})

test('重复收到同一 Agent 消息 ID 时保持单条时间线', () => {
  const session = createBotanicAgentSession({ id: 'session-1', now: 1 })
  const message = { id: 'message-1', role: 'user' as const, kind: 'text' as const, content: '生成一张图', createdAt: 2 }
  const once = appendBotanicAgentMessage(session, message)
  const twice = appendBotanicAgentMessage(once, message)
  assert.equal(twice, once)
  assert.equal(twice.messages.length, 1)
})

test('Agent 消息保存自身版本时间，后续更新不借用会话时间', () => {
  const session = createBotanicAgentSession({ id: 'session-message-version', now: 1 })
  const appended = appendBotanicAgentMessage(session, {
    id: 'message-version', role: 'assistant', kind: 'text', content: '初始内容', createdAt: 10,
  })

  assert.equal(appended.messages[0].updatedAt, 10)

  const updated = updateBotanicAgentMessage(appended, 'message-version', { content: '设备 B 更新' }, 30)
  assert.equal(updated.messages[0].updatedAt, 30)
  assert.equal(updated.updatedAt, 30)
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

test('刷新恢复首次生成 Run 时不伪造父结果引用', () => {
  const plan = buildBotanicAgentPlan({
    instruction: '基于商品图生成广告图', intent: 'initial_generation',
    settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
    contextSnapshot: [{ nodeId: 'asset-product', label: '商品图', kind: '素材', mediaKind: 'image', role: '商品' }],
  })
  const snapshot = {
    id: 'agent-run-initial', projectId: 'project-a', status: 'running' as const,
    plan: (({ references: _references, rootRecipe: _rootRecipe, actions: _actions, ...safePlan }) => safePlan)(plan),
    completedBranchCount: 0, failedBranchCount: 0,
    branches: [{ id: 'branch-a', label: '广告图', status: 'running' as const, attempt: 0, jobIds: ['job-a'], activeJobId: 'job-a', outputCount: 0, updatedAt: 210 }],
    createdAt: 100, updatedAt: 210,
  }

  const restored = upsertBotanicAgentRunSnapshot([], snapshot)
  assert.equal(restored[0].plan.selectedResultNodeId, undefined)
  assert.equal(restored[0].plan.rootRecipe, undefined)
  assert.deepEqual(restored[0].plan.references, [
    { source: 'context_node', id: 'asset-product', label: '商品图', role: '商品' },
  ])
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

test('Agent 只为落点是画布的 Artifact 执行节点命令', () => {
  assert.deepEqual(resolveBotanicAgentCanvasCommands({
    message: '完成',
    artifacts: [
      { id: 'artifact-text', kind: 'text', label: '检索结果', content: '找到 3 个场景。', provenance: { actionId: 'action-1', toolName: 'mcp_call' } },
      { id: 'artifact-note', kind: 'workflow', label: 'Skill 规则', content: '锁定商品。', placement: 'canvas', provenance: { actionId: 'action-1', toolName: 'skill_apply' } },
      { id: 'artifact-image', kind: 'image', label: '场景图', url: 'https://assets.example.com/scene.webp', provenance: { actionId: 'action-1', toolName: 'mcp_call' } },
      { id: 'artifact-hidden', kind: 'image', label: '仅面板', url: 'https://assets.example.com/panel.webp', placement: 'panel', provenance: { actionId: 'action-1', toolName: 'mcp_call' } },
    ],
    canvasCommands: [
      { id: 'command-text', type: 'create_text_node', artifactId: 'artifact-text' },
      { id: 'command-note', type: 'create_text_node', artifactId: 'artifact-note' },
      { id: 'command-image', type: 'create_media_node', artifactId: 'artifact-image' },
      { id: 'command-hidden', type: 'create_media_node', artifactId: 'artifact-hidden' },
      { id: 'command-unknown', type: 'create_media_node', artifactId: 'missing' },
    ],
    // 文本产物默认留在结果面板；只有显式 placement: 'canvas' 才写节点。
  }).map((item) => item.command.id), ['command-note', 'command-image'])

  assert.deepEqual(resolveBotanicAgentCanvasCommands({
    message: '完成', writeback: { kind: 'text', label: '旧结果', content: '仍可写回。' },
  }), [])
})

test('Artifact 落点默认按媒体进画布、文本留面板', () => {
  assert.equal(botanicAgentArtifactPlacement({ kind: 'image' }), 'canvas')
  assert.equal(botanicAgentArtifactPlacement({ kind: 'video' }), 'canvas')
  assert.equal(botanicAgentArtifactPlacement({ kind: 'workflow' }), 'panel')
  assert.equal(botanicAgentArtifactPlacement({ kind: 'text' }), 'panel')
  assert.equal(botanicAgentArtifactPlacement({ kind: 'file' }), 'panel')
  assert.equal(botanicAgentArtifactPlacement({ kind: 'text', placement: 'canvas' }), 'canvas')
  assert.equal(botanicAgentArtifactPlacement({ kind: 'image', placement: 'panel' }), 'panel')
})

test('运行摘要按本轮路由取词，对话轮次不谎称已回填画布', () => {
  const steps = createBotanicAgentRuntimeSteps({ hasTarget: false, mode: 'conversation' })
  const generation = summarizeBotanicAgentRuntime({ steps, phase: 'completed' })
  assert.equal(generation.label, 'Agent 已完成')
  assert.match(generation.detail, /回填画布/)

  const conversation = summarizeBotanicAgentRuntime({ steps, phase: 'completed', mode: 'conversation' })
  assert.equal(conversation.label, '已回复')
  assert.doesNotMatch(conversation.detail, /回填画布/)

  assert.equal(summarizeBotanicAgentRuntime({ steps, phase: 'completed', mode: 'prompt' }).label, 'Prompt 已生成')
  assert.equal(summarizeBotanicAgentRuntime({ steps, phase: 'completed', mode: 'research' }).label, '检索完成')

  // 进行中与等待阶段的文案与计数不受路由影响。
  assert.equal(
    summarizeBotanicAgentRuntime({ steps, phase: 'waiting_confirmation', mode: 'conversation' }).label,
    summarizeBotanicAgentRuntime({ steps, phase: 'waiting_confirmation' }).label,
  )
})

test('只有仍在进行的 Run 才在面板底部恢复运行轨迹', () => {
  assert.equal(shouldRestoreBotanicAgentRuntimeSteps('queued'), true)
  assert.equal(shouldRestoreBotanicAgentRuntimeSteps('running'), true)
  assert.equal(shouldRestoreBotanicAgentRuntimeSteps('executing'), true)
  assert.equal(shouldRestoreBotanicAgentRuntimeSteps('completed'), false)
  assert.equal(shouldRestoreBotanicAgentRuntimeSteps('partial'), false)
  assert.equal(shouldRestoreBotanicAgentRuntimeSteps('failed'), false)
  assert.equal(shouldRestoreBotanicAgentRuntimeSteps('cancelled'), false)
  assert.equal(shouldRestoreBotanicAgentRuntimeSteps('awaiting_confirmation'), false)

  // 恢复出来的上下文步骤一律是已完成状态，只有终点步骤反映 Run 的真实结果。
  const restored = restoreBotanicAgentRuntimeSteps({ run: { status: 'running' }, hasTarget: true })
  assert.deepEqual(
    restored.filter((step) => step.id !== 'finalize-plan').map((step) => step.status),
    restored.filter((step) => step.id !== 'finalize-plan').map(() => 'succeeded'),
  )
  assert.equal(restored.find((step) => step.id === 'finalize-plan')?.status, 'running')
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
      generationRecipe: {
        references: [], prompt: '海边黄昏，保持商品不变。', batchCount: 1,
        settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' },
      },
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
    placement: 'canvas',
    metadata: {
      source: 'generation', status: 'ready', createdAt: 220, jobId: 'job-agent-1',
      branchId: 'branch-beach', groupId: 'run-scene', savedToLibrary: false,
      settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' },
      // 结果面板要展示“图 + 生成它的 Prompt”，提示词直接来自节点配方。
      prompt: '海边黄昏，保持商品不变。',
    },
    provenance: {
      actionId: 'generation:job-agent-1', toolName: 'image_generation', runId: 'run-scene',
      sourceNodeIds: ['result-agent-1'],
    },
  })
  assert.equal(botanicAgentArtifactPrompt(results[0]), '海边黄昏，保持商品不变。')
  assert.equal(botanicAgentArtifactModel(results[0]), 'gpt-image-2')
  assert.equal(botanicAgentArtifactTimestamp(results[0]), 220)
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

test('Artifact Index 覆盖同 ID 的本地快照，同时合并当前画布可定位节点', () => {
  const indexed = [{
    id: 'artifact-a', kind: 'image' as const, label: '服务端历史结果', url: '/api/media/indexed',
    provenance: { actionId: 'action-a', toolName: 'image_generation', runId: 'run-a', sourceNodeIds: ['deleted-result'] },
    origin: { type: 'generation_output' as const, jobId: 'job-a', outputId: 'output-a' },
    createdAt: 100,
    updatedAt: 200,
  }, {
    id: 'manual-generation', kind: 'image' as const, label: '普通画布生成', url: '/api/media/manual',
    provenance: { actionId: 'generation:manual-job', toolName: 'image_generation' },
    origin: { type: 'generation_output' as const, jobId: 'manual-job', outputId: 'manual-output' },
    createdAt: 90,
    updatedAt: 90,
  }]
  const local = [{
    id: 'artifact-a', kind: 'image' as const, label: '旧本地快照', url: '/api/media/local',
    provenance: { actionId: 'action-a', toolName: 'image_generation', sourceNodeIds: ['result-a'] },
  }, {
    id: 'artifact-b', kind: 'video' as const, label: '刚生成的视频', url: '/api/media/new',
    provenance: { actionId: 'action-b', toolName: 'video_generation', sourceNodeIds: ['result-b'] },
  }]

  const results = mergeBotanicAgentArtifactIndex(indexed, local)

  assert.deepEqual(results.map((item) => item.id), ['artifact-a', 'artifact-b'])
  assert.equal(results[0].label, '服务端历史结果')
  assert.deepEqual(results[0].provenance.sourceNodeIds, ['deleted-result', 'result-a'])
})

test('Artifact Index 不可用或尚未迁移时，结果区完整回退到当前项目读模型', () => {
  const local = [{
    id: 'artifact-local', kind: 'text' as const, label: '本地结果', content: '保留商品',
    provenance: { actionId: 'action-local', toolName: 'skill_apply' },
  }]

  assert.deepEqual(mergeBotanicAgentArtifactIndex([], local), local)
})

test('执行模式是可解释的领域决策，自动模式遇到外部行动会降级并说明原因', () => {
  const auto = { mode: 'auto' as const, settingsComplete: true, pendingActionCount: 0 }
  assert.deepEqual(resolveBotanicAgentExecutionDecision(auto), { action: 'auto_submit' })
  assert.deepEqual(
    resolveBotanicAgentExecutionDecision({ ...auto, pendingActionCount: 2 }),
    { action: 'confirm', reason: 'pending_actions' },
  )
  // 会产生费用的参数缺失时，两种模式都必须先问，不猜。
  assert.deepEqual(
    resolveBotanicAgentExecutionDecision({ ...auto, settingsComplete: false }),
    { action: 'ask_settings' },
  )
  assert.deepEqual(
    resolveBotanicAgentExecutionDecision({ mode: 'manual', settingsComplete: true, pendingActionCount: 0 }),
    { action: 'confirm', reason: 'manual' },
  )
  assert.deepEqual(
    resolveBotanicAgentExecutionDecision({ mode: 'manual', settingsComplete: false, pendingActionCount: 0 }),
    { action: 'ask_settings' },
  )
  assert.equal(botanicAgentExecutionModeLabel('auto'), '自动模式')
  assert.equal(botanicAgentExecutionModeLabel('manual'), '计划模式')
})

test('真实工具调用展开成独立运行步骤，插在规划步骤之后', () => {
  const steps = createBotanicAgentRuntimeSteps({ hasTarget: true, referenceCount: 1 })
  const expanded = insertBotanicAgentToolCallSteps(steps, [
    { id: 'call-1', name: 'canvas_read', label: '读取画布节点', risk: 'read', status: 'succeeded', requiresConfirmation: false },
    { id: 'call-2', name: 'skill_apply', label: '应用 Skill 夏日换景', risk: 'write', status: 'awaiting_confirmation', requiresConfirmation: true },
    { id: 'call-3', name: 'mcp_call', label: '检索素材库', risk: 'external', status: 'failed', requiresConfirmation: true, error: '外部服务超时。' },
  ])

  assert.deepEqual(expanded.map((step) => step.id), [
    'read-canvas', 'read-references', 'call-planner', 'tool:call-1', 'tool:call-2', 'tool:call-3', 'finalize-plan',
  ])
  assert.equal(expanded[3].detail, 'canvas_read · 读取项目数据')
  assert.equal(expanded[3].kind, 'read')
  // 等待确认在运行轨迹里就是“还没跑”，不是一个额外状态。
  assert.equal(expanded[4].status, 'pending')
  assert.equal(expanded[5].kind, 'search')
  assert.equal(expanded[5].status, 'failed')
  assert.equal(expanded[5].error, '外部服务超时。')

  // 重复回传同一批工具调用时就地更新，不会越插越多。
  const again = insertBotanicAgentToolCallSteps(expanded, [
    { id: 'call-1', name: 'canvas_read', label: '读取画布节点', risk: 'read', status: 'succeeded', requiresConfirmation: false },
  ])
  assert.equal(again.filter((step) => step.id === 'tool:call-1').length, 1)
  assert.deepEqual(insertBotanicAgentToolCallSteps(steps, []), steps)
})

test('画布文字节点作为补充描述进入上下文快照与提示词', () => {
  const snapshot = createBotanicAgentContextSnapshot([
    { id: 'asset-product', label: '德国队球衣', kind: '素材', mediaKind: 'image', role: '商品' },
    { id: 'text-brief', label: '留白要求', kind: '文字', content: '  右上角留出文案位置。  ' },
    { id: 'text-empty', label: '空描述', kind: '文字', content: '   ' },
    { id: 'generate-1', label: '生成节点', kind: '节点', content: '这不是文字节点，不应被当成描述' },
  ])

  assert.equal(snapshot[0].note, undefined)
  assert.equal(snapshot[1].note, '右上角留出文案位置。')
  assert.equal(snapshot[2].note, undefined)
  assert.equal(snapshot[3].note, undefined)

  assert.equal(
    botanicAgentPromptWithContextNotes('把背景换成海边', snapshot),
    '把背景换成海边\n\n补充描述：\n- 留白要求：右上角留出文案位置。',
  )
  // 没有文字节点时提示词原样返回，不加空的补充段落。
  assert.equal(botanicAgentPromptWithContextNotes('把背景换成海边', [snapshot[0]]), '把背景换成海边')

  const plan = buildBotanicAgentPlan({
    instruction: '生成一张主图',
    intent: 'initial_generation',
    settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' },
    contextSnapshot: snapshot,
  })
  assert.equal(plan.instruction, '生成一张主图')
  assert.match(plan.prompt, /补充描述：\n- 留白要求：右上角留出文案位置。/)
})

test('上下文补充描述被截断到长度上限', () => {
  const [item] = createBotanicAgentContextSnapshot([
    { id: 'text-long', label: '长描述', kind: '文字', content: 'x'.repeat(900) },
  ])
  assert.equal(item.note?.length, botanicAgentContextNoteLimit)
})

test('工具步骤优先展示模型自述的调用目的', () => {
  const steps = insertBotanicAgentToolCallSteps(createBotanicAgentRuntimeSteps({ hasTarget: true }), [
    { id: 'call-1', name: 'ontology_read', label: '读取项目本体', risk: 'read', status: 'succeeded', requiresConfirmation: false, summary: '先确认画布里有哪些结果' },
    { id: 'call-2', name: 'skill_search', label: '检索已审核 Skill', risk: 'read', status: 'succeeded', requiresConfirmation: false },
  ])
  assert.equal(steps.find((step) => step.id === 'tool:call-1')?.detail, '先确认画布里有哪些结果')
  // 没有自述目的时回落到工具名与风险说明。
  assert.equal(steps.find((step) => step.id === 'tool:call-2')?.detail, 'skill_search · 读取项目数据')
})

test('只有提供方原始推理才补进运行轨迹，摘要片段由工具步骤承载', () => {
  const steps = createBotanicAgentRuntimeSteps({ hasTarget: true })
  const withReasoning = insertBotanicAgentReasoningSteps(steps, [
    { step: 0, source: 'summary', text: '先确认画布里有哪些结果' },
    { step: 0, source: 'raw', text: '先看看上下文，再决定锁定哪些维度。' },
    { step: 1, source: 'raw', text: '   ' },
  ])
  const reasoningSteps = withReasoning.filter((step) => step.id.startsWith('reasoning:'))
  assert.equal(reasoningSteps.length, 1)
  assert.equal(reasoningSteps[0].detail, '先看看上下文，再决定锁定哪些维度。')
  assert.equal(reasoningSteps[0].label, '模型运行说明')
  // 补在规划步骤之后，终点步骤仍在最后。
  assert.equal(withReasoning.at(-1)?.id, 'finalize-plan')
  assert.deepEqual(insertBotanicAgentReasoningSteps(steps, []), steps)
})

test('逐条到达的工具调用按真实执行顺序排列', () => {
  // 流式路径每个事件只带一条工具调用；新步骤必须接在已有工具步骤之后。
  const base = createBotanicAgentRuntimeSteps({ hasTarget: true })
  const first = insertBotanicAgentToolCallSteps(base, [
    { id: 'call-a', name: 'ontology_read', label: '读取项目本体', risk: 'read', status: 'running', requiresConfirmation: false },
  ])
  const second = insertBotanicAgentToolCallSteps(first, [
    { id: 'call-b', name: 'skill_search', label: '检索已审核 Skill', risk: 'read', status: 'running', requiresConfirmation: false },
  ])
  const third = insertBotanicAgentToolCallSteps(second, [
    { id: 'call-c', name: 'asset_group_search', label: '检索素材组', risk: 'read', status: 'succeeded', requiresConfirmation: false },
  ])

  assert.deepEqual(third.map((step) => step.id), [
    'read-canvas', 'call-planner', 'tool:call-a', 'tool:call-b', 'tool:call-c', 'finalize-plan',
  ])

  // 已存在的调用就地更新状态，不改变它在序列里的位置。
  const settled = insertBotanicAgentToolCallSteps(third, [
    { id: 'call-a', name: 'ontology_read', label: '读取项目本体', risk: 'read', status: 'succeeded', requiresConfirmation: false },
  ])
  assert.deepEqual(settled.map((step) => step.id), third.map((step) => step.id))
  assert.equal(settled.find((step) => step.id === 'tool:call-a')?.status, 'succeeded')

  // 整批更新与逐条到达的最终顺序一致。
  const batched = insertBotanicAgentToolCallSteps(base, [
    { id: 'call-a', name: 'ontology_read', label: '读取项目本体', risk: 'read', status: 'succeeded', requiresConfirmation: false },
    { id: 'call-b', name: 'skill_search', label: '检索已审核 Skill', risk: 'read', status: 'succeeded', requiresConfirmation: false },
    { id: 'call-c', name: 'asset_group_search', label: '检索素材组', risk: 'read', status: 'succeeded', requiresConfirmation: false },
  ])
  assert.deepEqual(batched.map((step) => step.id), third.map((step) => step.id))
})
