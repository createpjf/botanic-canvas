import assert from 'node:assert/strict'
import test from 'node:test'
import { applyAgentConversationStreamEvent, createAgentTimeline, reduceAgentTimeline } from './agentTimeline.ts'

const toolCall = (
  id: string,
  name: string,
  label: string,
  status: 'running' | 'succeeded',
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
    id: 'thinking', type: 'thinking', status: 'done', startedAt: 1_000, endedAt: 2_000, text: '先核地址',
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
    id: 'thinking', type: 'thinking', status: 'done', startedAt: 1_000, endedAt: 1_200, text: '',
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

test('web_fetch 展示网页获取主机名，不与搜索步骤合并', () => {
  let timeline = createAgentTimeline(1_000)
  timeline = reduceAgentTimeline(timeline, {
    type: 'tool',
    step: 0,
    toolCall: toolCall('fetch-1', 'web_fetch', '网页获取', 'succeeded'),
    presentation: { kind: 'fetch', title: '网页获取 www.andlight.cn' },
    receivedAt: 1_100,
  })
  const step = timeline.blocks.find((block) => block.type === 'step')
  assert.equal(step?.type === 'step' ? step.kind : '', 'fetch')
  assert.equal(step?.type === 'step' ? step.title : '', '网页获取 www.andlight.cn')
})
