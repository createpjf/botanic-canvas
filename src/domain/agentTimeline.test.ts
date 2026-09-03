import assert from 'node:assert/strict'
import test from 'node:test'
import {
  agentTimelineOrbState,
  agentTimelineStepToolName,
  agentTimelineToolPresentation,
  applyAgentConversationStreamEvent,
  createAgentTimeline,
  displayWebSourceHostname,
  persistAgentLiveTimeline,
  isAgentPipelineTimelineStep,
  projectBotanicAgentRunOntoTimeline,
  reduceAgentTimeline,
  safeTimelineWebSources,
  timelineRawDisplayItems,
  timelineStepShowsWebSources,
  timelineWebSourceHref,
} from './agentTimeline.ts'
import {
  agentMcpServerIdFromLabel,
  agentToolAccordionElapsedLabel,
  agentToolIconKey,
  conversationTimelineStepTitle,
  presentAgentTimelineConversation,
  presentAgentToolAccordion,
  presentAgentToolAccordionFromCalls,
} from './agentToolAccordion.ts'

const toolCall = (
  id: string,
  name: string,
  label: string,
  status: 'running' | 'succeeded' | 'failed' | 'aborted',
) => ({
  id,
  name,
  label,
  risk: 'read' as const,
  status,
  requiresConfirmation: false,
})

test('实时事件按到达顺序形成思考和语义步骤，同一工具调用只更新一行', () => {
  let timeline = createAgentTimeline(1_000)
  const events = [
    { type: 'reasoning' as const, step: 0, delta: '先核地址', receivedAt: 1_050 },
    {
      type: 'tool' as const,
      step: 0,
      toolCall: toolCall('search-1', 'web_search', '网页搜索', 'running'),
      presentation: { kind: 'search' as const, title: '搜索网站', count: 1 },
      receivedAt: 1_200,
    },
    {
      type: 'tool' as const,
      step: 0,
      toolCall: toolCall('search-1', 'web_search', '网页搜索', 'succeeded'),
      presentation: { kind: 'search' as const, title: '已搜索 25 个网站', count: 25 },
      receivedAt: 1_300,
    },
    {
      type: 'tool' as const,
      step: 1,
      toolCall: toolCall('skill-1', 'skill_read', '读取 Skill', 'running'),
      presentation: { kind: 'read_skill' as const, title: '读取浏览器技能指南' },
      receivedAt: 1_500,
    },
    {
      type: 'tool' as const,
      step: 1,
      toolCall: toolCall('skill-1', 'skill_read', '读取 Skill', 'succeeded'),
      presentation: { kind: 'read_skill' as const, title: '读取浏览器技能指南' },
      receivedAt: 1_600,
    },
    {
      type: 'tool' as const,
      step: 1,
      toolCall: toolCall('runtime-1', 'browser_connect', '连接浏览器', 'running'),
      presentation: { kind: 'connect_runtime' as const, title: '连接浏览器 runtime' },
      receivedAt: 1_700,
    },
    {
      type: 'tool' as const,
      step: 1,
      toolCall: toolCall('runtime-1', 'browser_connect', '连接浏览器', 'succeeded'),
      presentation: { kind: 'connect_runtime' as const, title: '连接浏览器 runtime' },
      receivedAt: 1_800,
    },
    {
      type: 'tool' as const,
      step: 1,
      toolCall: toolCall('search-2', 'web_search', '网页搜索', 'succeeded'),
      presentation: { kind: 'search' as const, title: '已搜索 29 个网站', count: 29 },
      receivedAt: 1_900,
    },
    { type: 'done' as const, receivedAt: 2_000 },
  ]

  for (const event of events) timeline = reduceAgentTimeline(timeline, event)

  const semanticBlocks = timeline.blocks.filter((block) => block.type !== 'raw_group')
  assert.deepEqual(semanticBlocks.map((block) => block.type === 'step'
    ? `${block.type}:${block.kind}:${block.title}`
    : block.type), [
    'thinking',
    'step:search:已搜索 25 个网站',
    'step:read_skill:读取浏览器技能指南',
    'step:connect_runtime:连接浏览器 runtime',
    'step:search:已搜索 29 个网站',
  ])
  assert.deepEqual(semanticBlocks[0], {
    id: 'thinking', type: 'thinking', status: 'done', startedAt: 1_000, endedAt: 1_200, text: '先核地址',
  })
  assert.equal(semanticBlocks.filter((block) => block.type === 'step' && block.sourceToolIds.includes('search-1')).length, 1)
  const rawGroup = timeline.blocks.find((block) => block.type === 'raw_group')
  assert.equal(rawGroup?.items.length, 4)
  assert.equal(rawGroup?.items.find((item) => item.id === 'search-1')?.status, 'succeeded')
})

test('连续搜索折叠并累加结果数；回答增量不打断搜索分组', () => {
  let timeline = createAgentTimeline(1_000)
  timeline = reduceAgentTimeline(timeline, {
    type: 'tool', step: 0, toolCall: toolCall('search-a', 'web_search', '网页搜索', 'succeeded'), receivedAt: 1_100,
  })
  timeline = reduceAgentTimeline(timeline, {
    type: 'tool', step: 0, toolCall: toolCall('search-b', 'search_related', '关联搜索', 'running'), receivedAt: 1_200,
  })
  timeline = reduceAgentTimeline(timeline, {
    type: 'tool', step: 0, toolCall: toolCall('search-b', 'search_related', '关联搜索', 'succeeded'),
    presentation: { kind: 'search', title: '已搜索 9 个网站', count: 9 }, receivedAt: 1_300,
  })
  timeline = reduceAgentTimeline(timeline, { type: 'answer', step: 1, delta: '继续核对。', receivedAt: 1_400 })
  timeline = reduceAgentTimeline(timeline, {
    type: 'tool', step: 1, toolCall: toolCall('search-c', 'web_search', '网页搜索', 'succeeded'),
    presentation: { kind: 'search', title: '已搜索 4 个网站', count: 4 }, receivedAt: 1_500,
  })

  const searches = timeline.blocks.filter((block) => block.type === 'step' && block.kind === 'search')
  assert.deepEqual(searches.map((block) => ({ title: block.title, count: block.count, sourceToolIds: block.sourceToolIds })), [
    { title: '已搜索 14 个网站', count: 14, sourceToolIds: ['search-a', 'search-b', 'search-c'] },
  ])
  const rawGroup = timeline.blocks.at(-1)
  assert.equal(rawGroup?.type, 'raw_group')
  assert.equal(rawGroup?.type === 'raw_group' ? rawGroup.summary : '', '已搜索 14 个网站')
})

test('回答增量写入正文，不进入时间线旁白', () => {
  let state = { content: '', timeline: createAgentTimeline(1_000) }
  state = applyAgentConversationStreamEvent(state, { type: 'reasoning', step: 0, delta: '先核地址', receivedAt: 1_050 })
  state = applyAgentConversationStreamEvent(state, {
    type: 'answer', step: 0, delta: '我查这页和它关联的资金规则。', receivedAt: 1_100,
  })
  state = applyAgentConversationStreamEvent(state, {
    type: 'tool',
    step: 0,
    toolCall: toolCall('search-1', 'web_search', '网页搜索', 'succeeded'),
    presentation: { kind: 'search', title: '已搜索 25 个网站', count: 25 },
    receivedAt: 1_200,
  })
  state = applyAgentConversationStreamEvent(state, { type: 'answer', step: 1, delta: '网页没有直接返回内容。', receivedAt: 1_300 })
  state = applyAgentConversationStreamEvent(state, { type: 'done', receivedAt: 1_400 })

  assert.equal(state.content, '我查这页和它关联的资金规则。网页没有直接返回内容。')
  assert.equal(state.timeline.blocks.some((block) => block.type === 'narration'), false)
  assert.deepEqual(state.timeline.blocks.filter((block) => block.type !== 'raw_group').map((block) => block.type === 'step'
    ? `${block.type}:${block.kind}:${block.title}`
    : block.type), [
    'thinking',
    'step:search:已搜索 25 个网站',
  ])
  const thinking = state.timeline.blocks.find((block) => block.type === 'thinking')
  assert.equal(thinking?.type === 'thinking' ? thinking.text : '', '先核地址')
  assert.equal(thinking?.type === 'thinking' ? thinking.status : '', 'done')
})

test('工具后新的 reasoning 独立成段，工具 why 直接成为安全步骤摘要', () => {
  let timeline = createAgentTimeline(1_000)
  timeline = reduceAgentTimeline(timeline, { type: 'reasoning', step: 0, delta: '先读取画布。', receivedAt: 1_050 })
  timeline = reduceAgentTimeline(timeline, {
    type: 'tool', step: 0,
    toolCall: { ...toolCall('canvas-1', 'canvas_read', '读取画布', 'running'), summary: '确认当前选中节点与参考素材' },
    receivedAt: 1_100,
  })
  timeline = reduceAgentTimeline(timeline, { type: 'reasoning', step: 1, delta: '再整理可执行方案。', receivedAt: 1_200 })
  timeline = reduceAgentTimeline(timeline, { type: 'done', receivedAt: 1_300 })

  const blocks = timeline.blocks.filter((block) => block.type !== 'raw_group')
  assert.deepEqual(blocks.map((block) => block.type), ['thinking', 'step', 'thinking'])
  assert.equal(blocks[0].type === 'thinking' ? blocks[0].text : '', '先读取画布。')
  assert.equal(blocks[1].type === 'step' ? blocks[1].summary : '', '确认当前选中节点与参考素材')
  assert.equal(blocks[2].type === 'thinking' ? blocks[2].text : '', '再整理可执行方案。')
})

test('错误事件收束思考并把当前运行步骤标记为失败', () => {
  let timeline = createAgentTimeline(1_000)
  timeline = reduceAgentTimeline(timeline, {
    type: 'tool', step: 0, toolCall: toolCall('skill-failed', 'skill_read', '读取 Skill', 'running'), receivedAt: 1_100,
  })
  timeline = reduceAgentTimeline(timeline, { type: 'error', message: '读取失败', receivedAt: 1_200 })

  const thinking = timeline.blocks.find((block) => block.type === 'thinking')
  const step = timeline.blocks.find((block) => block.type === 'step')
  const rawGroup = timeline.blocks.find((block) => block.type === 'raw_group')
  assert.deepEqual(thinking, {
    id: 'thinking', type: 'thinking', status: 'done', startedAt: 1_000, endedAt: 1_100, text: '',
  })
  assert.equal(step?.type === 'step' ? step.status : '', 'failed')
  assert.deepEqual(rawGroup?.type === 'raw_group' ? rawGroup.items[0] : undefined, {
    ...toolCall('skill-failed', 'skill_read', '读取 Skill', 'running'),
    status: 'failed',
    error: '读取失败',
  })
})

test('搜索结果数为 0 时不用调用次数冒充站点数', () => {
  let timeline = createAgentTimeline(1_000)
  timeline = reduceAgentTimeline(timeline, {
    type: 'tool',
    step: 0,
    toolCall: toolCall('search-empty', 'web_search', '网页搜索', 'succeeded'),
    presentation: { kind: 'search', title: '已搜索 0 个网站', count: 0 },
    receivedAt: 1_100,
  })

  const step = timeline.blocks.find((block) => block.type === 'step')
  const rawGroup = timeline.blocks.find((block) => block.type === 'raw_group')
  assert.equal(step?.type === 'step' ? step.title : '', '已搜索 0 个网站')
  assert.equal(rawGroup?.type === 'raw_group' ? rawGroup.summary : '', '已搜索 0 个网站')
})

test('web_fetch 展示网页获取主机名和来源 pill，不与搜索步骤合并', () => {
  let timeline = createAgentTimeline(1_000)
  timeline = reduceAgentTimeline(timeline, {
    type: 'tool',
    step: 0,
    toolCall: toolCall('fetch-1', 'web_fetch', '网页获取', 'succeeded'),
    presentation: {
      kind: 'fetch',
      title: '网页获取 www.andlight.cn',
      sources: [{ hostname: 'www.andlight.cn', url: 'https://www.andlight.cn/' }],
    },
    receivedAt: 1_100,
  })
  const step = timeline.blocks.find((block) => block.type === 'step')
  assert.equal(step?.type === 'step' ? step.kind : '', 'fetch')
  assert.equal(step?.type === 'step' ? step.title : '', '网页获取 www.andlight.cn')
  const rawItems = timeline.blocks.find((block) => block.type === 'raw_group')?.items ?? []
  assert.equal(step?.type === 'step' && timelineStepShowsWebSources(step, rawItems), true)
})

test('已知规划工具标题与服务端对齐；Run 投影只反映已持久化状态', () => {
  assert.deepEqual(
    agentTimelineToolPresentation(toolCall('c1', 'canvas_read', '读取画布上下文', 'running')),
    { kind: 'read', title: '读取画布上下文' },
  )
  assert.deepEqual(
    agentTimelineToolPresentation(toolCall('c2', 'generation_create_plan', '生成执行计划', 'succeeded')),
    { kind: 'write', title: '起草生成计划' },
  )
  assert.deepEqual(
    agentTimelineToolPresentation(toolCall('c3', 'project_memory_search', '检索项目记忆', 'running')),
    { kind: 'search', title: '检索项目记忆' },
  )
  assert.deepEqual(
    agentTimelineToolPresentation(toolCall('c4', 'subagent_research', '并行调研', 'running')),
    { kind: 'subagent', title: '并行调研' },
  )

  const previous = {
    blocks: [
      { id: 'thinking:0:0', type: 'thinking' as const, status: 'done' as const, startedAt: 500, endedAt: 900, text: '想清楚了' },
      { id: 'thinking:0:1', type: 'thinking' as const, status: 'done' as const, startedAt: 900, endedAt: 950, text: '' },
      { id: 'raw', type: 'raw_group' as const, summary: '', open: false, items: [toolCall('read-1', 'canvas_read', '读取画布上下文', 'succeeded')] },
      { id: 'exec:submit', type: 'step' as const, status: 'running' as const, kind: 'write' as const, title: '提交生成任务', sourceToolIds: [] },
    ],
  }
  const timeline = projectBotanicAgentRunOntoTimeline({
    id: 'run-1',
    status: 'running',
    branches: [
      { id: 'b1', label: '主图', status: 'succeeded', attempt: 1, jobIds: ['j1'], outputCount: 1, updatedAt: 2 },
      { id: 'b2', label: '变体', status: 'running', attempt: 0, jobIds: [], outputCount: 1, updatedAt: 3 },
    ],
  }, previous, 1_000)
  const steps = timeline.blocks.filter((block) => block.type === 'step')
  assert.deepEqual(steps.map((block) => block.type === 'step' ? [block.title, block.status] : null), [
    ['提交生成任务', 'succeeded'],
    ['生成 · 主图', 'succeeded'],
    ['生成 · 变体', 'running'],
  ])
  // 规划期的 tool-call 明细与有正文的思考随投影保留；空思考与旧 exec 步被重建。
  assert.equal(timeline.blocks.some((block) => block.type === 'raw_group'), true)
  assert.deepEqual(
    timeline.blocks.filter((block) => block.type === 'thinking').map((block) => block.id),
    ['thinking:0:0'],
  )

  const failedWithBranch = projectBotanicAgentRunOntoTimeline({
    id: 'run-2',
    status: 'failed',
    branches: [
      { id: 'b1', label: '首次生成', status: 'failed', attempt: 1, jobIds: ['j1'], outputCount: 1, updatedAt: 2 },
    ],
  }, undefined, 1_000)
  assert.deepEqual(
    failedWithBranch.blocks.filter((block) => block.type === 'step').map((block) => block.type === 'step' ? [block.title, block.status] : null),
    [['提交生成任务', 'succeeded'], ['生成', 'failed']],
  )

  const failedBeforeSubmit = projectBotanicAgentRunOntoTimeline({
    id: 'run-3',
    status: 'failed',
    error: '生成额度不足，请调整候选数、规格或联系工作区所有者。',
    branches: [],
  }, undefined, 1_000)
  const submitOnly = failedBeforeSubmit.blocks.find((block) => block.type === 'step')
  assert.equal(submitOnly?.type === 'step' ? submitOnly.status : '', 'failed')
  assert.equal(submitOnly?.type === 'step' ? submitOnly.error : '', '生成额度不足，请调整候选数、规格或联系工作区所有者。')

  const failedWithJob = projectBotanicAgentRunOntoTimeline({
    id: 'run-4',
    status: 'failed',
    branches: [{
      id: 'b1',
      label: '首次生成',
      status: 'failed',
      attempt: 1,
      jobIds: ['job-1'],
      activeJobId: 'job-1',
      outputCount: 0,
      error: '超过 4096x4096。',
      updatedAt: 2,
    }],
  }, undefined, 1_000, [{ id: 'job-1', error: '超过 4096x4096。', errorCode: 'IMAGE_TOO_LARGE_PIXELS' }])
  const generate = failedWithJob.blocks.find((block) => block.type === 'step' && block.id === 'exec:branch:b1')
  assert.equal(generate?.type === 'step' ? generate.error : '', '超过 4096x4096。')
  assert.equal(generate?.type === 'step' ? generate.errorCode : '', 'IMAGE_TOO_LARGE_PIXELS')
})

test('对话时间线：空思考不出现，步骤按顺序流在主列', () => {
  const running = presentAgentTimelineConversation({
    blocks: [
      { id: 'thinking', type: 'thinking', status: 'done', startedAt: 1_000, endedAt: 1_000, text: '' },
      { id: 'exec:submit', type: 'step', status: 'succeeded', kind: 'write', title: '提交生成任务', sourceToolIds: [] },
      { id: 'exec:branch', type: 'step', status: 'running', kind: 'write', title: '生成 · 首次生成', sourceToolIds: [] },
    ],
  })
  assert.equal(running.live, true)
  assert.deepEqual(running.visible.map((block) => block.id), ['exec:submit', 'exec:branch'])
  assert.deepEqual(running.collapsed, [])

  const settled = presentAgentTimelineConversation({
    blocks: [
      { id: 'thinking', type: 'thinking', status: 'done', startedAt: 1_000, endedAt: 1_000, text: '' },
      { id: 'exec:submit', type: 'step', status: 'succeeded', kind: 'write', title: '提交生成任务', sourceToolIds: [] },
      { id: 'exec:branch', type: 'step', status: 'succeeded', kind: 'write', title: '生成 · 首次生成', sourceToolIds: [] },
    ],
  })
  assert.equal(settled.live, false)
  assert.deepEqual(settled.visible.map((block) => block.id), ['exec:branch'])
  assert.deepEqual(settled.collapsed, [])

  const failed = presentAgentTimelineConversation({
    blocks: [
      { id: 'exec:submit', type: 'step', status: 'failed', kind: 'write', title: '提交生成任务', sourceToolIds: [], error: '生成服务未就绪' },
      { id: 'exec:branch', type: 'step', status: 'failed', kind: 'write', title: '生成 · 首次生成', sourceToolIds: [] },
    ],
  })
  assert.equal(failed.live, false)
  assert.deepEqual(failed.visible.map((block) => block.id), ['exec:branch'])
  assert.equal(failed.visible[0] && failed.visible[0].type === 'step' ? failed.visible[0].error : '', '生成服务未就绪')

  const failedWithCode = presentAgentTimelineConversation({
    blocks: [
      { id: 'exec:submit', type: 'step', status: 'failed', kind: 'write', title: '提交生成任务', sourceToolIds: [], error: '超过 4096x4096。', errorCode: 'IMAGE_TOO_LARGE_PIXELS' },
      { id: 'exec:branch', type: 'step', status: 'failed', kind: 'write', title: '生成 · 首次生成', sourceToolIds: [] },
    ],
  })
  assert.deepEqual(failedWithCode.visible.map((block) => block.id), ['exec:branch'])
  assert.equal(failedWithCode.visible[0] && failedWithCode.visible[0].type === 'step' ? failedWithCode.visible[0].errorCode : '', 'IMAGE_TOO_LARGE_PIXELS')

  const submitOnlyFailed = presentAgentTimelineConversation({
    blocks: [
      { id: 'exec:submit', type: 'step', status: 'failed', kind: 'write', title: '提交生成任务', sourceToolIds: [], error: '生成服务未就绪' },
    ],
  })
  assert.deepEqual(submitOnlyFailed.visible.map((block) => block.id), ['exec:submit'])

  assert.equal(conversationTimelineStepTitle({
    id: 'g', type: 'step', status: 'running', kind: 'write', title: '生成 · 首次生成', sourceToolIds: [],
  }, 'zh-CN'), '正在出图…')
  assert.equal(conversationTimelineStepTitle({
    id: 'v', type: 'step', status: 'running', kind: 'write', title: '生成 · 白皙', sourceToolIds: [],
  }, 'zh-CN'), '正在出图 · 白皙')
  assert.equal(conversationTimelineStepTitle({
    id: 's', type: 'step', status: 'succeeded', kind: 'write', title: '提交生成任务', sourceToolIds: [],
  }, 'zh-CN'), '已提交')
  assert.equal(conversationTimelineStepTitle({
    id: 'o', type: 'step', status: 'running', kind: 'read', title: '读取本体上下文', sourceToolIds: [],
  }, 'zh-CN'), '在看项目…')
  assert.equal(isAgentPipelineTimelineStep({
    id: 'g', type: 'step', status: 'running', kind: 'write', title: '生成 · 首次生成', sourceToolIds: [],
  }), true)
  assert.equal(isAgentPipelineTimelineStep({
    id: 'o', type: 'step', status: 'running', kind: 'read', title: '读取本体上下文', sourceToolIds: [],
  }), false)
})

test('tool-call accordion：按到达顺序追加，进行中展开，耗时与失败留在组内', () => {
  let timeline = createAgentTimeline(1_000)
  timeline = reduceAgentTimeline(timeline, {
    type: 'tool',
    step: 0,
    receivedAt: 1_200,
    toolCall: toolCall('read-1', 'canvas_read', '读取画布上下文', 'running'),
  })
  const live = presentAgentToolAccordion(timeline, 'zh-CN', 1_500)
  assert.ok(live)
  assert.equal(live.groups.length, 1)
  assert.equal(live.groups[0].open, true)
  assert.equal(live.groups[0].status, 'running')
  assert.deepEqual(live.groups[0].rows.map((row) => row.id), ['read-1'])
  assert.equal(live.groups[0].rows[0].verb, '正在读取')
  assert.equal(agentToolAccordionElapsedLabel(live.elapsedMs, 'zh-CN'), '已处理 0秒')

  timeline = reduceAgentTimeline(timeline, {
    type: 'tool',
    step: 0,
    receivedAt: 2_500,
    toolCall: toolCall('read-1', 'canvas_read', '读取画布上下文', 'succeeded'),
  })
  timeline = reduceAgentTimeline(timeline, {
    type: 'tool',
    step: 1,
    receivedAt: 2_600,
    toolCall: toolCall('mcp-1', 'mcp_call', '获取设计上下文', 'succeeded'),
  })
  timeline = reduceAgentTimeline(timeline, {
    type: 'tool',
    step: 2,
    receivedAt: 2_700,
    toolCall: toolCall('mcp-2', 'mcp_call', '获取设计上下文', 'succeeded'),
  })
  timeline = reduceAgentTimeline(timeline, {
    type: 'tool',
    step: 3,
    receivedAt: 2_800,
    toolCall: {
      ...toolCall('skill-1', 'skill_read', '读取技能指南', 'running'),
      status: 'failed',
      error: 'Skill 不可用',
    },
  })

  const settled = presentAgentToolAccordion(timeline, 'zh-CN', 3_000)
  assert.ok(settled)
  assert.equal(settled.groups[0].open, false)
  assert.equal(settled.groups[0].status, 'failed')
  assert.deepEqual(settled.groups[0].rows.map((row) => ({
    id: row.id,
    verb: row.verb,
    callCount: row.callCount,
    status: row.status,
    error: row.error,
  })), [
    { id: 'quiet-reads:read-1', verb: '已读取 1 项', callCount: 1, status: 'succeeded', error: undefined },
    {
      id: 'mcp-1+mcp-2',
      verb: '已获取',
      callCount: 2,
      status: 'succeeded',
      error: undefined,
    },
    { id: 'skill-1', verb: '读取失败', callCount: undefined, status: 'failed', error: 'Skill 不可用' },
  ])
  assert.match(settled.groups[0].rows[1].detail, /2 calls/)

  const conversation = presentAgentTimelineConversation(timeline)
  assert.equal(conversation.visible.some((block) => block.type === 'step' && block.id.startsWith('step:')), false)
  assert.equal(conversation.visible.some((block) => block.type === 'raw_group'), false)

  // 思考先结束、工具继续跑：耗时不能冻在思考区间，要一直走到 now。
  const mixed = presentAgentToolAccordion({
    blocks: [
      { id: 'thinking:0:0', type: 'thinking', status: 'done', startedAt: 1_000, endedAt: 2_000, text: '思考' },
      { id: 'step:read', type: 'step', status: 'running', kind: 'read', title: '读取画布上下文', sourceToolIds: ['read-9'], startedAt: 2_100 },
    ],
  }, 'zh-CN', 9_000)
  assert.equal(mixed?.elapsedMs, 8_000)
})

test('tool accordion 图标按类别固定映射', () => {
  assert.equal(agentToolIconKey({ toolName: 'canvas_read', kind: 'read' }), 'file-text')
  assert.equal(agentToolIconKey({ toolName: 'project_memory_search', kind: 'search' }), 'search-code')
  assert.equal(agentToolIconKey({ toolName: 'asset_search', kind: 'search' }), 'file-search')
  assert.equal(agentToolIconKey({ toolName: 'mcp_call', label: '调用 MCP：figma.get_context' }), 'unplug')
  assert.equal(agentToolIconKey({ toolName: 'shell_exec' }), 'square-terminal')
  assert.equal(agentToolIconKey({ toolName: 'web_fetch', kind: 'fetch' }), 'globe')
  assert.equal(agentToolIconKey({ toolName: 'generate_images', kind: 'write' }), 'image')
  assert.equal(agentToolIconKey({ toolName: 'unknown_tool' }), 'wrench')
  assert.equal(agentMcpServerIdFromLabel('调用 MCP：figma.get_context'), 'figma')
})

test('球体动画态只映射动作，不改工具标题', () => {
  assert.equal(agentTimelineOrbState({ surface: 'thinking' }), 'breathing')
  assert.equal(agentTimelineOrbState({ kind: 'search', toolName: 'web_search' }), 'searching')
  assert.equal(agentTimelineOrbState({ kind: 'search' }), 'searching')
  assert.equal(agentTimelineOrbState({ kind: 'fetch', toolName: 'web_fetch' }), 'connecting')
  assert.equal(agentTimelineOrbState({ kind: 'connect_runtime' }), 'connecting')
  assert.equal(agentTimelineOrbState({ kind: 'read', toolName: 'canvas_read' }), 'working')
  assert.equal(agentTimelineOrbState({ kind: 'read_skill', toolName: 'skill_run' }), 'weaving')
  assert.equal(agentTimelineOrbState({ kind: 'write', toolName: 'generation_create_plan' }), 'composing')
  assert.equal(agentTimelineOrbState({ kind: 'other', toolName: 'decompose_creative_brief' }), 'composing')
  assert.equal(agentTimelineOrbState({ kind: 'write', toolName: 'generation_submit' }), 'shaping')
  assert.equal(agentTimelineOrbState({ kind: 'write', toolName: 'generate_images' }), 'shaping')
  assert.equal(agentTimelineOrbState({ kind: 'other', toolName: 'mcp_call' }), 'connecting')
  assert.equal(agentTimelineOrbState({ kind: 'other', toolName: 'ask_clarification' }), 'listening')
  assert.equal(agentTimelineOrbState({ kind: 'write' }), 'working')

  const step = {
    id: 'step:search-1',
    type: 'step' as const,
    status: 'running' as const,
    kind: 'search' as const,
    title: '正在搜索网站',
    sourceToolIds: ['search-1'],
  }
  assert.equal(
    agentTimelineStepToolName(step, [toolCall('search-1', 'web_search', '网页搜索', 'running')]),
    'web_search',
  )
  assert.equal(agentTimelineStepToolName(step, []), undefined)
  assert.equal(
    agentTimelineOrbState({
      kind: step.kind,
      toolName: agentTimelineStepToolName(step, [toolCall('search-1', 'web_search', '网页搜索', 'running')]),
    }),
    'searching',
  )
})

test('回合收口把 live 时间线落到旁路状态，并把思考标成结束', () => {
  const live = reduceAgentTimeline(createAgentTimeline(1_000), {
    type: 'tool',
    step: 0,
    toolCall: toolCall('search-1', 'web_search', '网页搜索', 'succeeded'),
    presentation: { kind: 'search', title: '已搜索 1 个网站', count: 1 },
    receivedAt: 1_200,
  })
  assert.equal(persistAgentLiveTimeline({}, 'msg-1', { blocks: [] })['msg-1'], undefined)
  const settled = persistAgentLiveTimeline({}, 'msg-1', live, 1_400)
  assert.equal(settled['msg-1']?.blocks.find((block) => block.type === 'thinking')?.status, 'done')
  assert.ok(settled['msg-1']?.blocks.some((block) => block.type === 'step' && block.kind === 'search'))
})


const failingCall = (id: string, name: string, status: 'failed' | 'succeeded', error?: string) => ({
  id, name, label: '提交生成任务', risk: 'costly' as const, status, requiresConfirmation: false,
  ...(error ? { error } : {}),
})

test('失败的步骤必须带上原因，恢复成功后清掉', () => {
  // 线上实测：两个写类工具调用连续失败，界面上只有两个红叉与「Writing project data ·
  // Failed」，测试的人完全不知道发生了什么。原始工具调用列表一直带着 error，
  // 只是这条实时时间线路径把它丢了。
  const failed = reduceAgentTimeline(createAgentTimeline(1_000), {
    type: 'tool',
    step: 0,
    toolCall: failingCall('call-1', 'generation_submit', 'failed', '生成额度不足，请降低输出规格。'),
    receivedAt: 1_100,
  })
  const step = failed.blocks.find((block) => block.type === 'step')
  assert.equal(step?.status, 'failed')
  assert.equal(step?.error, '生成额度不足，请降低输出规格。')

  // 同一个调用后来成功了，旧的失败原因不能继续挂着。
  const recovered = reduceAgentTimeline(failed, {
    type: 'tool',
    step: 0,
    toolCall: failingCall('call-1', 'generation_submit', 'succeeded'),
    receivedAt: 1_200,
  })
  const healed = recovered.blocks.find((block) => block.type === 'step')
  assert.equal(healed?.status, 'succeeded')
  assert.equal(healed?.error, undefined)
})

test('连续搜索按 hostname 去重累加站点；项目检索即使带 hits 也不出 pill', () => {
  let timeline = createAgentTimeline(1_000)
  timeline = reduceAgentTimeline(timeline, {
    type: 'tool',
    step: 0,
    toolCall: toolCall('search-a', 'web_search', '网页搜索', 'succeeded'),
    presentation: {
      kind: 'search',
      title: '已搜索 2 个网站',
      count: 2,
      sources: [
        { hostname: 'www.andlight.cn', url: 'https://www.andlight.cn/', title: '和光' },
        { hostname: 'fcbarcelona.com', url: 'https://fcbarcelona.com/' },
      ],
    },
    receivedAt: 1_100,
  })
  timeline = reduceAgentTimeline(timeline, {
    type: 'tool',
    step: 0,
    toolCall: toolCall('search-b', 'web_search', '网页搜索', 'succeeded'),
    presentation: {
      kind: 'search',
      title: '已搜索 2 个网站',
      count: 2,
      sources: [
        { hostname: 'andlight.cn', url: 'https://andlight.cn/about' },
        { hostname: 'nytimes.com', url: 'https://www.nytimes.com/' },
      ],
    },
    receivedAt: 1_200,
  })

  const search = timeline.blocks.find((block) => block.type === 'step' && block.kind === 'search')
  const rawGroup = timeline.blocks.find((block) => block.type === 'raw_group')
  assert.deepEqual(search?.type === 'step' ? search.sources : undefined, [
    { hostname: 'www.andlight.cn', url: 'https://www.andlight.cn/', title: '和光' },
    { hostname: 'fcbarcelona.com', url: 'https://fcbarcelona.com/' },
    { hostname: 'nytimes.com', url: 'https://www.nytimes.com/' },
  ])
  assert.equal(search?.type === 'step' ? search.count : 0, 4)
  assert.equal(
    timelineStepShowsWebSources(search as Extract<typeof search, { type: 'step' }>, rawGroup?.items ?? []),
    true,
  )
  assert.deepEqual(timelineRawDisplayItems(rawGroup?.items ?? []).map((item) => item.name), [])

  let memory = createAgentTimeline(2_000)
  memory = reduceAgentTimeline(memory, {
    type: 'tool',
    step: 0,
    toolCall: toolCall('mem-1', 'project_memory_search', '检索项目记忆', 'succeeded'),
    presentation: {
      kind: 'search',
      title: '检索项目记忆 · 2 条',
      count: 2,
      sources: [{ hostname: 'www.andlight.cn', url: 'https://www.andlight.cn/' }],
    },
    receivedAt: 2_100,
  })
  const memoryStep = memory.blocks.find((block) => block.type === 'step')
  const memoryItems = memory.blocks.find((block) => block.type === 'raw_group')?.items ?? []
  assert.equal(memoryStep?.type === 'step' ? memoryStep.sources : [], undefined)
  assert.equal(
    memoryStep?.type === 'step' && timelineStepShowsWebSources(memoryStep, memoryItems),
    false,
  )
})

test('raw 只收起网页搜索行，保留 web_fetch；客户端只解析有界 HTTPS 来源形状', () => {
  assert.deepEqual(timelineRawDisplayItems([
    { ...toolCall('s1', 'web_search', '网页搜索', 'succeeded') },
    { ...toolCall('s2', 'search_related', '关联搜索', 'succeeded') },
    { ...toolCall('f1', 'web_fetch', '网页获取', 'succeeded') },
    { ...toolCall('m1', 'project_memory_search', '检索项目记忆', 'succeeded') },
  ]).map((item) => item.name), ['web_fetch', 'project_memory_search'])

  assert.equal(displayWebSourceHostname('www.andlight.cn'), 'andlight.cn')
  assert.equal(timelineWebSourceHref({ hostname: 'andlight.cn', url: 'https://www.andlight.cn/about' }), 'https://www.andlight.cn/about')
  assert.equal(timelineWebSourceHref({ hostname: 'example.com', url: 'http://example.com' }), null)
  assert.equal(timelineWebSourceHref({ hostname: 'example.com', url: 'https://user:pass@example.com/' }), null)
  assert.equal(timelineWebSourceHref({ hostname: 'local', url: 'https://127.0.0.1/' }), 'https://127.0.0.1/')
  assert.equal(timelineWebSourceHref({ hostname: 'oversized', url: `https://example.com/${'a'.repeat(2048)}` }), null)
  assert.deepEqual(safeTimelineWebSources([
    { hostname: 'www.andlight.cn', url: 'https://www.andlight.cn/', title: '和光' },
    { hostname: 'bad-http', url: 'http://example.com/' },
    { hostname: 'oversized', url: `https://example.com/${'a'.repeat(2048)}` },
    { hostname: 'fcbarcelona.com', url: 'https://fcbarcelona.com/', title: 'x'.repeat(161) },
  ]), [
    { hostname: 'www.andlight.cn', url: 'https://www.andlight.cn/', title: '和光' },
    { hostname: 'fcbarcelona.com', url: 'https://fcbarcelona.com/' },
  ])
})

test('没有错误文案时不编造一个', () => {
  // 失败但没带原因是另一回事：如实留空，由界面回落到通用状态文案。
  const state = reduceAgentTimeline(createAgentTimeline(1_000), {
    type: 'tool',
    step: 0,
    toolCall: failingCall('call-2', 'workflow_create', 'failed'),
    receivedAt: 1_100,
  })
  const step = state.blocks.find((block) => block.type === 'step')
  assert.equal(step?.status, 'failed')
  assert.equal(step?.error, undefined)
})

test('aborted 工具是中性未执行终态,时间线与 accordion 都不显示失败或永久 running', () => {
  const timeline = reduceAgentTimeline(createAgentTimeline(1_000), {
    type: 'tool',
    step: 0,
    toolCall: {
      ...toolCall('aborted-1', 'web_fetch', '网页获取', 'aborted'),
      error: '同批 fatal 后未启动',
    },
    presentation: { kind: 'fetch', title: '网页获取' },
    receivedAt: 1_200,
  })
  const step = timeline.blocks.find((block) => block.type === 'step')
  assert.equal(step?.status, 'aborted')
  const accordion = presentAgentToolAccordion(timeline, 'zh-CN', 1_500)
  assert.equal(accordion?.groups[0]?.status, 'aborted')
  assert.equal(accordion?.groups[0]?.rows[0]?.status, 'aborted')
  assert.equal(accordion?.groups[0]?.rows[0]?.verb, '未执行')
})

test('本地 read 延迟300ms显示、可见后稳定600ms,快速成功折叠但外部调用不隐藏', () => {
  let timeline = reduceAgentTimeline(createAgentTimeline(1_000), {
    type: 'tool', step: 0,
    toolCall: toolCall('read-1', 'ontology_read', '读取项目本体', 'running'),
    presentation: { kind: 'read', title: '读取项目本体' }, receivedAt: 1_000,
  })
  const pending = presentAgentToolAccordion(timeline, 'zh-CN', 1_200)
  assert.equal(pending?.groups.length, 0)
  assert.equal(pending?.nextUpdateAt, 1_300)
  assert.equal(presentAgentToolAccordion(timeline, 'zh-CN', 1_301)?.groups[0]?.rows[0]?.status, 'running')

  timeline = reduceAgentTimeline(timeline, {
    type: 'tool', step: 0,
    toolCall: toolCall('read-1', 'ontology_read', '读取项目本体', 'succeeded'),
    presentation: { kind: 'read', title: '读取项目本体' }, receivedAt: 1_400,
  })
  const lingering = presentAgentToolAccordion(timeline, 'zh-CN', 1_500)
  assert.equal(lingering?.groups[0]?.rows[0]?.toolName, 'ontology_read')
  assert.equal(lingering?.nextUpdateAt, 1_900)
  const grouped = presentAgentToolAccordion(timeline, 'zh-CN', 1_901)
  assert.equal(grouped?.groups[0]?.rows[0]?.toolName, 'quiet_reads')
  assert.equal(grouped?.groups[0]?.rows[0]?.verb, '已读取 1 项')
  assert.equal(grouped?.groups[0]?.rows[0]?.calls?.[0]?.toolName, 'ontology_read')

  const external = presentAgentToolAccordionFromCalls([{
    ...toolCall('external-1', 'web_fetch', '网页获取', 'succeeded'), risk: 'external',
  }], 'zh-CN')
  assert.equal(external?.groups[0]?.rows[0]?.toolName, 'web_fetch')
})

test('流式attempt切换清除失败前缀,重复/迟到chunk不污染当前答案', () => {
  let state = { content: '', timeline: createAgentTimeline(1_000) }
  state = applyAgentConversationStreamEvent(state, { type: 'attempt', action: 'start', attemptId: 'vision', receivedAt: 1_000 })
  state = applyAgentConversationStreamEvent(state, { type: 'answer', attemptId: 'vision', step: 0, chunkIndex: 0, delta: '废弃前缀', receivedAt: 1_010 })
  state = applyAgentConversationStreamEvent(state, { type: 'answer', attemptId: 'vision', step: 0, chunkIndex: 0, delta: '重复', receivedAt: 1_011 })
  assert.equal(state.content, '废弃前缀')
  state = applyAgentConversationStreamEvent(state, { type: 'attempt', action: 'start', attemptId: 'text', receivedAt: 1_020 })
  assert.equal(state.content, '')
  state = applyAgentConversationStreamEvent(state, { type: 'answer', attemptId: 'vision', step: 0, chunkIndex: 1, delta: '迟到', receivedAt: 1_021 })
  state = applyAgentConversationStreamEvent(state, { type: 'answer', attemptId: 'text', step: 0, chunkIndex: 0, delta: '最终答案', receivedAt: 1_030 })
  state = applyAgentConversationStreamEvent(state, { type: 'answer_snapshot', attemptId: 'text', revision: 2, step: 0, text: '最终答案完整', receivedAt: 1_040 })
  state = applyAgentConversationStreamEvent(state, { type: 'answer_snapshot', attemptId: 'text', revision: 1, step: 0, text: '旧快照', receivedAt: 1_041 })
  assert.equal(state.content, '最终答案完整')
  assert.equal(state.timeline.stream?.attemptId, 'text')
  assert.equal(state.timeline.stream?.previewRevision, 2)
})

test('awaiting_confirmation 不折叠成 running，MCP 行派生 server 目标', () => {
  const awaiting = presentAgentToolAccordionFromCalls([{
    id: 'confirm-1', name: 'canvas_action_set', label: '执行画布操作', risk: 'write' as const,
    status: 'awaiting_confirmation' as const, requiresConfirmation: true,
  }], 'zh-CN')
  assert.equal(awaiting?.groups[0]?.rows[0]?.status, 'awaiting_confirmation')
  assert.equal(awaiting?.groups[0]?.rows[0]?.verb, '等待确认')
  // 等待确认时组保持展开，让用户看得到要批准什么。
  assert.equal(awaiting?.groups[0]?.open, true)

  const mcp = presentAgentToolAccordionFromCalls([{
    ...toolCall('mcp-1', 'mcp_call', '调用 MCP：figma.get_file', 'succeeded'), risk: 'external' as const,
  }], 'zh-CN')
  assert.equal(mcp?.groups[0]?.rows[0]?.target, 'figma')
})
